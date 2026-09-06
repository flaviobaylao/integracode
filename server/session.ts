// Sessao HTTP do Integra 2.0 (E6, set/2026).
//
// Substitui o modulo de autenticacao da hospedagem antiga, que carregava um login OIDC
// (openid-client + estrategia passport por dominio) ao lado da sessao. O Integra 2.0 roda no
// Railway e a autenticacao e SEMPRE a local (email + senha, `server/localAuth.ts`, sessao em
// `req.session.user`). O que sobrou dali e o que continua em uso: o store de sessao no
// Postgres e o guarda de rota.
import session from "express-session";
import connectPg from "connect-pg-simple";
import type { Express, RequestHandler } from "express";

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

  const isHttps = process.env.NODE_ENV === "production";

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

// Instala a sessao. O fluxo OIDC (`/api/callback`, estrategia por dominio) saiu junto com a
// hospedagem antiga; o login e feito por POST /api/auth/login (localAuth). `/api/login` e
// `/api/logout` continuam existindo porque o front antigo (e atalhos salvos) ainda batem neles.
export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());

  // `/api/login` existia no modulo antigo (redirecionava para a tela de login). Mantido como
  // redirect para nao devolver o HTML do SPA (e um 404 dentro dele) a quem tem link/atalho antigo.
  app.get("/api/login", (_req, res) => res.redirect("/login"));

  app.get("/api/logout", (req, res) => {
    (req.session as any).user = null;
    req.session.destroy(() => res.redirect("/"));
  });
}

// Guarda de rota: exige sessao local valida.
export const isAuthenticated: RequestHandler = (req, res, next) => {
  const user = (req.session as any)?.user;
  if (!user) return res.status(401).json({ message: "Unauthorized" });
  if (user.expires_at) {
    const now = Math.floor(Date.now() / 1000);
    if (now > user.expires_at) return res.status(401).json({ message: "Unauthorized" });
  }
  return next();
};
