import session from "express-session";
import connectPg from "connect-pg-simple";
import { storage } from "./storage";
import type { Request, Response, NextFunction } from "express";
import type { User } from "@shared/schema";

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });

  return session({
    secret: process.env.SESSION_SECRET || "whatsapp-system-secret-key",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false, // Set to true in production with HTTPS
      maxAge: sessionTtl,
    },
  });
}

// Middleware to check if user is authenticated
export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req.session as any)?.userId;
  
  if (!userId) {
    return res.status(401).json({ error: "Não autenticado" });
  }

  try {
    const user = await storage.getUserById(userId);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: "Usuário inválido" });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
};

// Middleware to check if user is admin
export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: "Não autenticado" });
  }

  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Acesso negado. Apenas administradores." });
  }

  next();
};

// Middleware to check if user is agent or admin
export const requireAgent = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: "Não autenticado" });
  }

  if (req.user.role !== "agent" && req.user.role !== "admin") {
    return res.status(403).json({ error: "Acesso negado. Apenas agentes." });
  }

  next();
};

// Initialize default admin user
export async function initializeDefaultUsers() {
  try {
    // Create default admin
    const admin = await storage.createDefaultAdmin();
    console.log("✅ Admin padrão criado/verificado:", admin.username);

    // Create ChatGPT bot agent if it doesn't exist
    const existingBot = await storage.getBotAgent();
    if (!existingBot) {
      await storage.createAgent({
        name: "ChatGPT",
        email: "chatgpt@assistant.ai",
        type: "bot",
        status: "online",
      });
      console.log("✅ Agente ChatGPT criado");
    }
  } catch (error) {
    console.error("❌ Erro ao inicializar usuários padrão:", error);
  }
}