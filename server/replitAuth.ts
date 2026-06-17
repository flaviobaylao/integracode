import * as client from "openid-client";
import { Strategy, type VerifyFunction } from "openid-client/passport";

import passport from "passport";
import session from "express-session";
import type { Express, RequestHandler } from "express";
import memoize from "memoizee";
import connectPg from "connect-pg-simple";
import { storage } from "./storage";

// Verificar se estamos rodando no Replit
const IS_REPLIT = !!process.env.REPLIT_DOMAINS;

if (!IS_REPLIT) {
  console.log("INFO: REPLIT_DOMAINS nao configurada - modo Railway/standalone ativo");
  console.log("   Autenticacao local (email + senha) sera usada.");
} else {
  console.log("OK: REPLIT_DOMAINS configurada:", process.env.REPLIT_DOMAINS);
}

const getOidcConfig = memoize(
  async () => {
    return await client.discovery(
      new URL(process.env.ISSUER_URL ?? "https://replit.com/oidc"),
      process.env.REPL_ID
    );
  },
  { maxAge: 3600 * 1000 }
);

export function getSession() {
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET must be provided");
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be provided");
  }

  const sessionTtl = 7 * 24 * 60 * 60 * 1000;
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });

  const isHttps = process.env.NODE_ENV === "production" ||
                  !!process.env.REPLIT_DOMAINS ||
                  !!process.env.REPL_SLUG;

  return session({
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      secure: isHttps,
      sameSite: isHttps ? "none" : "lax",
      maxAge: sessionTtl,
    },
    proxy: true,
  });
}

function updateUserSession(user: any, tokens: any) {
  user.claims = tokens.claims();
  user.access_token = tokens.access_token;
  user.refresh_token = tokens.refresh_token;
  user.expires_at = user.claims?.exp;
}

async function upsertUser(claims: any) {
  const existingUser = await storage.getUserByEmail(claims["email"]);
  if (existingUser) {
    if (existingUser.id !== claims["sub"]) return;
  }
  await storage.upsertUser({
    id: claims["sub"],
    email: claims["email"],
    firstName: claims["first_name"],
    lastName: claims["last_name"],
    profileImageUrl: claims["profile_image_url"],
    role: claims["role"],
  });
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  passport.serializeUser((user: any, cb) => cb(null, user));
  passport.deserializeUser((user: any, cb) => cb(null, user));

  if (!IS_REPLIT) {
    console.log("Replit OIDC desabilitado - apenas autenticacao local ativa");
    app.get("/api/login", (req, res) => res.redirect("/?login=true"));
    app.get("/api/callback", (req, res) => res.redirect("/"));
    app.get("/api/logout", (req, res) => {
      req.logout(() => {
        (req.session as any).user = null;
        req.session.destroy(() => res.redirect("/"));
      });
    });
    return;
  }

  const config = await getOidcConfig();

  const verify: VerifyFunction = async (tokens, verified) => {
    const user: any = {};
    updateUserSession(user, tokens);
    await upsertUser(tokens.claims());
    verified(null, user);
  };

  for (const domain of process.env.REPLIT_DOMAINS!.split(",")) {
    const trimmedDomain = domain.trim();
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

  app.get("/api/login", (req, res, next) => {
    passport.authenticate(`replitauth:${req.hostname}`, {
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
  const user = (req.user as any) || (req.session as any)?.user;
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const isPassportAuth = req.isAuthenticated();
  const isLocalAuth = !!(req.session as any)?.user;

  if (!isPassportAuth && !isLocalAuth) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (isLocalAuth && !isPassportAuth) {
    if (user.expires_at) {
      const now = Math.floor(Date.now() / 1000);
      if (now > user.expires_at) {
        return res.status(401).json({ message: "Unauthorized" });
      }
    }
    return next();
  }

  if (!user.expires_at) return res.status(401).json({ message: "Unauthorized" });

  const now = Math.floor(Date.now() / 1000);
  if (now <= user.expires_at) return next();

  const refreshToken = user.refresh_token;
  if (!refreshToken) return res.status(401).json({ message: "Unauthorized" });

  try {
    const config = await getOidcConfig();
    const tokenResponse = await client.refreshTokenGrant(config, refreshToken);
    updateUserSession(user, tokenResponse);
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Unauthorized" });
  }
};
