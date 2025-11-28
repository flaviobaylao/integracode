import type { Request, Response, NextFunction } from 'express';
import { storage } from './storage';

// Middleware que funciona tanto com Replit Auth quanto com autenticação local
export const authenticateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let userId: string | null = null;
    let userEmail: string | null = null;
    
    console.log(`🔐 [AUTH] ${req.method} ${req.path}`);
    console.log(`🔐 [AUTH] Session exists: ${!!req.session}`);
    console.log(`🔐 [AUTH] Session userId: ${(req.session as any)?.userId}`);
    console.log(`🔐 [AUTH] Session user: ${!!(req.session as any)?.user}`);
    console.log(`🔐 [AUTH] isAuthenticated: ${req.isAuthenticated?.()}`);
    
    // Verificar userId armazenado diretamente na sessão (forma mais comum)
    if ((req.session as any)?.userId) {
      userId = (req.session as any).userId;
      userEmail = (req.session as any)?.userEmail;
      console.log(`✅ [AUTH] Session userId: ${userEmail}`);
    }
    // Verificar sessão local com claims (para admin Flavio)
    else if ((req.session as any)?.user?.claims?.sub) {
      userId = (req.session as any).user.claims.sub;
      userEmail = (req.session as any).user.claims.email;
      console.log(`✅ [AUTH] Local session with claims: ${userEmail}`);
    }
    // Verificar autenticação Replit com Passport
    else if (req.isAuthenticated && req.isAuthenticated() && (req.user as any)?.claims?.sub) {
      userId = (req.user as any).claims.sub;
      userEmail = (req.user as any).claims.email;
      console.log(`✅ [AUTH] Replit auth: ${userEmail}`);
    }
    
    if (!userId) {
      console.log(`❌ [AUTH] No userId found`);
      return res.status(401).json({ message: "Unauthorized" });
    }
    
    // Verificar se o usuário existe no banco - primeiro por ID
    let user = await storage.getUser(userId);
    
    // Se não encontrou por ID e temos email, buscar por email (para vendedores com email do Omie)
    if (!user && userEmail) {
      user = await storage.getUserByEmail(userEmail);
    }
    
    if (!user || !user.isActive) {
      return res.status(401).json({ 
        message: "User not found or inactive"
      });
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
    // Usar o ID do usuário que corresponde ao email cadastrado no Omie
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