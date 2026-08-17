import type { Request, Response, NextFunction } from 'express';
import { storage } from './storage';

// Middleware que funciona tanto com Replit Auth quanto com autenticação local
export const authenticateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Bypass para endpoints públicos
    if (req.path === '/api/customers/map-data') {
      return next();
    }
    
    let userId: string | null = null;
    let userEmail: string | null = null;
    
    if (req.path.includes('check-in')) {
      console.log(`\n🔍 [AUTH-CHECK-IN] Verificando autenticação para: ${req.method} ${req.path}`);
      console.log(`🔍 [AUTH-CHECK-IN] Session cookie: ${req.get('cookie')}`);
      console.log(`🔍 [AUTH-CHECK-IN] Session exists: ${!!req.session}`);
      if (req.session) {
        console.log(`🔍 [AUTH-CHECK-IN] Session ID: ${(req.session as any).id}`);
        console.log(`🔍 [AUTH-CHECK-IN] Session userId: ${(req.session as any)?.userId}`);
        console.log(`🔍 [AUTH-CHECK-IN] Session user: ${JSON.stringify((req.session as any)?.user)}`);
      }
      console.log(`🔍 [AUTH-CHECK-IN] isAuthenticated: ${req.isAuthenticated?.()}`);
      console.log(`🔍 [AUTH-CHECK-IN] req.user: ${JSON.stringify((req as any).user)}\n`);
    }
    
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
      console.log(`❌ [AUTH] No userId found for ${req.path}`);
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
    
    // 🏭 Perfil "Indústria": acesso total — tratado como ADMIN em todas as rotinas do sistema.
    if (user.role === 'industria') {
      (req as any).perfilIndustria = true;
      user = { ...user, role: 'admin' } as any;
    }

    // 🔁 "Entrar como" (impersonação de ADMIN): permite ao admin ver o sistema com a visão de
    // outra função. Só se aplica quando a função REAL é admin (impede escalonamento de privilégio).
    const _impRole = (req.session as any)?.impersonateRole;
    if (_impRole && user.role === 'admin') {
      (req as any).realUser = user;
      user = { ...user, role: _impRole } as any;
      (req as any).impersonating = true;
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
    let userEmail: string | null = null;
    
    // Verificar userId armazenado diretamente na sessão (forma mais comum - login local)
    if ((req.session as any)?.userId) {
      userId = (req.session as any).userId;
      userEmail = (req.session as any)?.userEmail;
    }
    // Verificar sessão local com claims (para admin Flavio)
    else if ((req.session as any)?.user?.claims?.sub) {
      userId = (req.session as any).user.claims.sub;
      userEmail = (req.session as any).user.claims.email;
    }
    // Verificar autenticação Replit com Passport
    else if (req.isAuthenticated && req.isAuthenticated() && (req.user as any)?.claims?.sub) {
      userId = (req.user as any).claims.sub;
      userEmail = (req.user as any).claims.email;
    }
    
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    
    // Verificar se o usuário existe no banco - primeiro por ID
    let user = await storage.getUser(userId);
    
    // Se não encontrou por ID e temos email, buscar por email
    if (!user && userEmail) {
      user = await storage.getUserByEmail(userEmail);
    }
    
    // 🏭 Perfil "Indústria": acesso total — tratado como ADMIN também nas rotas administrativas.
    if (user && user.role === 'industria') {
      user = { ...user, role: 'admin' } as any;
    }

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
