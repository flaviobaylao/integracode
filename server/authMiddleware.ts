import type { Request, Response, NextFunction } from 'express';
import { storage } from './storage';

// Middleware de autenticação por sessão local (email + senha)
export const authenticateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // (E1, 05/set/2026) Removido o bypass de /api/customers/map-data: a tela do Mapa roda dentro
    // do app autenticado (ClientsMap.tsx) e a rota devolvia nome/telefone/endereço de toda a base.

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

    // Perfil "Contador": VE tudo, NAO altera nada. Tratado como ADMIN aqui (para passar em
    // todos os requireRole de leitura) -- a trava de escrita e o middleware
    // somenteLeituraContador, montado logo apos a sessao em server/routes.ts.
    if (user.role === 'contador') {
      (req as any).perfilContador = true;
      user = { ...user, role: 'admin' } as any;
    }

    // 🔁 "Entrar como" (impersonação de ADMIN): permite ao admin ver o sistema com a visão de
    // outra função. Só se aplica quando a função REAL é admin (impede escalonamento de privilégio).
    const _impUserId = (req.session as any)?.impersonateUserId;
    if (_impUserId && user.role === 'admin') {
      const _tgt = await storage.getUser(String(_impUserId));
      if (_tgt && _tgt.isActive) { (req as any).realUser = user; user = _tgt as any; (req as any).impersonating = true; }
    }
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

    // Perfil "Contador": leitura tambem nas rotas administrativas (escrita ja foi barrada
    // antes, pelo somenteLeituraContador).
    if (user && user.role === 'contador') {
      (req as any).perfilContador = true;
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

// ==========================================================================
// PERFIL CONTADOR -- somente leitura em TODO o sistema (set/2026)
//
// O contador enxerga o sistema inteiro (o authMiddleware o trata como admin nas leituras),
// mas nao pode alterar NADA. Esta e a trava unica e central: em vez de tocar nas centenas
// de requireRole([...]) espalhados, barramos por METODO HTTP antes das rotas.
//
// Regra: qualquer POST/PUT/PATCH/DELETE em /api/* de um usuario com role='contador'
// responde 403. Excecoes (LISTA_LEITURA_POST) sao rotas que usam POST mas so LEEM,
// alem das rotas da propria conta (login/senha).
// ==========================================================================
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

const LISTA_LEITURA_POST = [
  '/api/auth/login',
  '/api/auth/local-login',
  '/api/auth/change-password',
  '/api/reports/execute',
  '/api/fiscal-invoices/batch',
  '/api/billing-pipeline/charges',
];

const _cacheContador = new Map<string, { role: string; at: number }>();
const _CACHE_MS = 60000;

export const somenteLeituraContador = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (METODOS_SEGUROS.has(req.method)) return next();
    if (!req.path.startsWith('/api/')) return next();
    if (LISTA_LEITURA_POST.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();

    const sess: any = req.session as any;
    const userId: string | null = sess?.userId || sess?.user?.claims?.sub || null;
    if (!userId) return next();

    let role: string | null = null;
    const cached = _cacheContador.get(userId);
    if (cached && Date.now() - cached.at < _CACHE_MS) {
      role = cached.role;
    } else {
      let u = await storage.getUser(userId);
      if (!u && sess?.userEmail) u = await storage.getUserByEmail(sess.userEmail);
      role = (u?.role as string) || '';
      _cacheContador.set(userId, { role, at: Date.now() });
    }

    if (role !== 'contador') return next();

    console.log('[CONTADOR] Escrita bloqueada: ' + req.method + ' ' + req.path + ' (usuario ' + userId + ')');
    return res.status(403).json({
      message: 'Perfil Contador e somente leitura. Esta acao nao e permitida.',
      perfilContador: true,
    });
  } catch (error) {
    console.error('[CONTADOR] Erro no middleware somente-leitura:', error);
    return next();
  }
};

// ==========================================================================
// 410 Gone — desligamento de rotas de migração/reconciliação do Omie e do
// Integra 1.0 (plano de 05/set/2026, etapas E1/E3). A rota continua
// registrada (o código sai nas etapas E5/E6), mas responde 410 antes de
// executar qualquer coisa. Reversível: basta remover o middleware.
// ==========================================================================
export const gone = (motivo: string) => {
  return (_req: Request, res: Response) => {
    res.status(410).json({
      message: `Rota desativada (${motivo}). O Integra 2.0 não tem mais vínculo com o Omie/Integra 1.0.`,
      desativadaEm: '2026-09-05',
    });
  };
};

// ==========================================================================
// Rate limit simples em memória por IP (E1, 05/set/2026) — para rotas públicas
// do hotsite que consultam cadastro por CPF/CNPJ. Não muda o comportamento
// de uso normal (limite alto); só barra enumeração em massa.
// ==========================================================================
const _rl = new Map<string, { n: number; t: number }>();
export const rateLimitPorIp = (maxPorMinuto: number) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const ip = String((req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.socket?.remoteAddress || 'ip?').trim();
      const now = Date.now();
      const k = `${req.path}|${ip}`;
      const cur = _rl.get(k);
      if (!cur || now - cur.t > 60_000) { _rl.set(k, { n: 1, t: now }); return next(); }
      cur.n++;
      if (cur.n > maxPorMinuto) return res.status(429).json({ message: 'Muitas consultas. Tente novamente em 1 minuto.' });
      return next();
    } catch { return next(); }
  };
};
setInterval(() => { const now = Date.now(); Array.from(_rl.entries()).forEach(([k, v]) => { if (now - v.t > 120_000) _rl.delete(k); }); }, 60_000).unref?.();
