import type { Request, Response, NextFunction } from 'express';
import { storage } from './storage';

// Middleware que funciona tanto com Replit Auth quanto com autenticação local
export const authenticateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let userId: string | null = null;
    
    // Verificar sessão local primeiro (para admin Flavio)
    if ((req.session as any)?.user?.claims?.sub) {
      userId = (req.session as any).user.claims.sub;
    }
    // Verificar autenticação Replit
    else if (req.isAuthenticated && req.isAuthenticated() && (req.user as any)?.claims?.sub) {
      userId = (req.user as any).claims.sub;
    }
    
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    
    // Verificar se o usuário existe no banco
    const user = await storage.getUser(userId);
    if (!user || !user.isActive) {
      return res.status(401).json({ message: "User not found or inactive" });
    }
    
    // Adicionar usuário ao objeto request
    (req as any).currentUser = user;
    next();
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(500).json({ message: "Authentication error" });
  }
};

// Middleware para verificar roles específicos
export const requireRole = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).currentUser;
    
    if (!user || !allowedRoles.includes(user.role)) {
      return res.status(403).json({ message: "Access denied" });
    }
    
    next();
  };
};

// Middleware para vendedores acessarem apenas seus próprios dados
export const checkSellerAccess = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).currentUser;
  
  if (user.role === 'vendedor') {
    // Adicionar filtro de vendedor às queries
    (req as any).sellerId = user.id;
  }
  
  next();
};

// Middleware específico para autenticação de admin
export const authenticateAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let userId: string | null = null;
    
    // Verificar sessão local primeiro (para admin Flavio)
    if ((req.session as any)?.user?.claims?.sub) {
      userId = (req.session as any).user.claims.sub;
    }
    // Verificar autenticação Replit
    else if (req.isAuthenticated && req.isAuthenticated() && (req.user as any)?.claims?.sub) {
      userId = (req.user as any).claims.sub;
    }
    
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    
    // Verificar se o usuário existe no banco e é admin
    const user = await storage.getUser(userId);
    if (!user || !user.isActive || user.role !== 'admin') {
      return res.status(403).json({ message: "Admin access required" });
    }
    
    // Adicionar usuário ao objeto request
    (req as any).currentUser = user;
    next();
  } catch (error) {
    console.error("Admin authentication error:", error);
    res.status(500).json({ message: "Authentication error" });
  }
};