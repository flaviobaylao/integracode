import * as client from "openid-client";
import { Strategy, type VerifyFunction } from "openid-client/passport";

import passport from "passport";
import session from "express-session";
import type { Express, RequestHandler } from "express";
import memoize from "memoizee";
import connectPg from "connect-pg-simple";
import { storage } from "./storage";

// REPLIT_DOMAINS é fornecida automaticamente pelo Replit em produção
// Em desenvolvimento local, pode não estar presente
if (!process.env.REPLIT_DOMAINS) {
  console.warn('⚠️ AVISO: REPLIT_DOMAINS não configurada');
  console.warn('   Isso é normal em desenvolvimento local');
  console.warn('   Em produção, o Replit fornece essa variável automaticamente');
  
  // Em desenvolvimento, usar o domínio atual ou um padrão
  if (process.env.NODE_ENV === 'development') {
    console.log('🔧 Modo desenvolvimento: autenticação pode não funcionar corretamente');
  } else {
    console.error('❌ ERRO: REPLIT_DOMAINS não encontrada em produção!');
    console.error('   Isso não deveria acontecer. O Replit fornece essa variável automaticamente.');
    throw new Error("REPLIT_DOMAINS not provided in production");
  }
} else {
  console.log('✅ REPLIT_DOMAINS configurada:', process.env.REPLIT_DOMAINS);
  console.log('🌐 Domínios aceitos:', process.env.REPLIT_DOMAINS.split(',').map(d => d.trim()));
}

const getOidcConfig = memoize(
  async () => {
    return await client.discovery(
      new URL(process.env.ISSUER_URL ?? "https://replit.com/oidc"),
      process.env.REPL_ID!
    );
  },
  { maxAge: 3600 * 1000 }
);

export function getSession() {
  if (!process.env.SESSION_SECRET) {
    console.error('❌ ERRO CRÍTICO: SESSION_SECRET não configurada!');
    console.error('📝 Configure SESSION_SECRET nos Secrets do Replit');
    throw new Error("SESSION_SECRET must be provided");
  }
  
  if (!process.env.DATABASE_URL) {
    console.error('❌ ERRO CRÍTICO: DATABASE_URL não configurada!');
    console.error('📝 Provisione um banco de dados PostgreSQL na aba Database');
    throw new Error("DATABASE_URL must be provided");
  }

  console.log('✅ SESSION_SECRET configurada');
  console.log('✅ DATABASE_URL configurada');

  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });
  return session({
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      maxAge: sessionTtl,
    },
  });
}

function updateUserSession(
  user: any,
  tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers
) {
  user.claims = tokens.claims();
  user.access_token = tokens.access_token;
  user.refresh_token = tokens.refresh_token;
  user.expires_at = user.claims?.exp;
}

async function upsertUser(
  claims: any,
) {
  console.log('🔍 Claims recebidos no upsertUser:', claims);
  await storage.upsertUser({
    id: claims["sub"],
    email: claims["email"],
    firstName: claims["first_name"],
    lastName: claims["last_name"],
    profileImageUrl: claims["profile_image_url"],
    role: claims["role"], // Incluindo role dos claims OIDC
  });
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  const config = await getOidcConfig();

  const verify: VerifyFunction = async (
    tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers,
    verified: passport.AuthenticateCallback
  ) => {
    const user = {};
    updateUserSession(user, tokens);
    await upsertUser(tokens.claims());
    verified(null, user);
  };

  console.log('🔐 Configurando estratégias de autenticação Replit...');
  for (const domain of process.env
    .REPLIT_DOMAINS!.split(",")) {
    const trimmedDomain = domain.trim();
    console.log(`   ✓ Estratégia configurada para: ${trimmedDomain}`);
    const strategy = new Strategy(
      {
        name: `replitauth:${trimmedDomain}`,
        config,
        scope: "openid email profile offline_access",
        callbackURL: `https://${trimmedDomain}/api/callback`,
      },
      verify,
    );
    passport.use(strategy);
  }
  console.log('✅ Autenticação Replit configurada com sucesso!');

  passport.serializeUser((user: Express.User, cb) => cb(null, user));
  passport.deserializeUser((user: Express.User, cb) => cb(null, user));

  app.get("/api/login", (req, res, next) => {
    console.log(`🔑 Tentativa de login no domínio: ${req.hostname}`);
    const strategyName = `replitauth:${req.hostname}`;
    
    // Verificar se a estratégia existe
    const hasStrategy = (passport as any)._strategies[strategyName];
    if (!hasStrategy) {
      console.error(`❌ ERRO: Estratégia não encontrada para domínio "${req.hostname}"`);
      console.error(`   Domínios configurados: ${process.env.REPLIT_DOMAINS}`);
      console.error(`   Estratégia procurada: ${strategyName}`);
      return res.status(500).send(`
        <h1>Erro de Configuração</h1>
        <p>O domínio <strong>${req.hostname}</strong> não está configurado para autenticação.</p>
        <p>Domínios aceitos: <code>${process.env.REPLIT_DOMAINS}</code></p>
        <p>Por favor, adicione este domínio à variável REPLIT_DOMAINS nos Secrets do Replit.</p>
      `);
    }
    
    passport.authenticate(strategyName, {
      prompt: "login consent",
      scope: ["openid", "email", "profile", "offline_access"],
    })(req, res, next);
  });

  app.get("/api/callback", (req, res, next) => {
    passport.authenticate(`replitauth:${req.hostname}`, {
      successReturnToOrRedirect: "/",
      failureRedirect: "/api/login",
    })(req, res, next);
  });

  app.get("/api/logout", (req, res) => {
    req.logout(() => {
      res.redirect(
        client.buildEndSessionUrl(config, {
          client_id: process.env.REPL_ID!,
          post_logout_redirect_uri: `${req.protocol}://${req.hostname}`,
        }).href
      );
    });
  });
}

export const isAuthenticated: RequestHandler = async (req, res, next) => {
  // Verificar tanto req.user (Replit Auth) quanto req.session.user (login com senha)
  const user = (req.user as any) || (req.session as any)?.user;

  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Verificar autenticação Passport (Replit Auth) ou sessão local (login com senha)
  const isPassportAuth = req.isAuthenticated();
  const isLocalAuth = !!(req.session as any)?.user;

  if (!isPassportAuth && !isLocalAuth) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Se é autenticação local (login com senha), permitir
  if (isLocalAuth && !isPassportAuth) {
    // Verificar expiração se houver expires_at
    if (user.expires_at) {
      const now = Math.floor(Date.now() / 1000);
      if (now > user.expires_at) {
        return res.status(401).json({ message: "Unauthorized" });
      }
    }
    return next();
  }

  // Se é Replit Auth (Passport), fazer verificação completa com refresh token
  if (!user.expires_at) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const now = Math.floor(Date.now() / 1000);
  if (now <= user.expires_at) {
    return next();
  }

  const refreshToken = user.refresh_token;
  if (!refreshToken) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  try {
    const config = await getOidcConfig();
    const tokenResponse = await client.refreshTokenGrant(config, refreshToken);
    updateUserSession(user, tokenResponse);
    return next();
  } catch (error) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
};
