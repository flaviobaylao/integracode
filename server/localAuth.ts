import bcrypt from 'bcrypt';
import { storage } from './storage';
import type { User } from '@shared/schema';

const SALT_ROUNDS = 10;

// Administrador local padrão
const ADMIN_CREDENTIALS = {
  username: 'Flavio',
  password: 'M@riafe1',
  id: 'admin-flavio',
  email: 'flavio@honestsucos.com.br',
  firstName: 'Flavio',
  lastName: 'Administrador',
  role: 'admin' as const,
  route: null,
  profileImageUrl: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date()
};

// Hash de senha
export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

// Validar senha
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return await bcrypt.compare(password, hash);
}

// Validar usuário com email e senha
export async function validateUser(email: string, password: string): Promise<User | null> {
  try {
    const user = await storage.getUserByEmail(email);
    
    if (!user || !user.isActive) {
      return null;
    }
    
    // Se o usuário não tem senha definida, não pode fazer login
    if (!user.password) {
      return null;
    }
    
    // Validar senha
    const isValid = await comparePassword(password, user.password);
    if (!isValid) {
      return null;
    }
    
    return user;
  } catch (error) {
    console.error('Erro ao validar usuário:', error);
    return null;
  }
}

// Validar admin local (mantém compatibilidade com código existente)
export async function validateLocalAdmin(username: string, password: string): Promise<User | null> {
  if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
    // Garantir que o usuário admin existe no banco de dados
    try {
      let adminUser = await storage.getUser(ADMIN_CREDENTIALS.id);
      
      if (!adminUser) {
        // Criar usuário admin se não existir
        const hashedPassword = await hashPassword(ADMIN_CREDENTIALS.password);
        adminUser = await storage.upsertUser({
          id: ADMIN_CREDENTIALS.id,
          email: ADMIN_CREDENTIALS.email,
          password: hashedPassword,
          firstName: ADMIN_CREDENTIALS.firstName,
          lastName: ADMIN_CREDENTIALS.lastName,
          role: ADMIN_CREDENTIALS.role,
          route: ADMIN_CREDENTIALS.route,
          profileImageUrl: ADMIN_CREDENTIALS.profileImageUrl,
          isActive: ADMIN_CREDENTIALS.isActive
        });
      } else if (!adminUser.password) {
        // Se o admin existe mas não tem senha, adicionar
        const hashedPassword = await hashPassword(ADMIN_CREDENTIALS.password);
        adminUser = await storage.updateUser(ADMIN_CREDENTIALS.id, {
          password: hashedPassword
        });
      }
      
      return adminUser;
    } catch (error) {
      console.error('Erro ao criar/buscar usuário admin:', error);
      return null;
    }
  }
  
  return null;
}

// Definir senha para usuário
export async function setUserPassword(userId: string, newPassword: string): Promise<User | null> {
  try {
    const hashedPassword = await hashPassword(newPassword);
    const updatedUser = await storage.updateUser(userId, {
      password: hashedPassword
    });
    return updatedUser;
  } catch (error) {
    console.error('Erro ao definir senha do usuário:', error);
    return null;
  }
}

export function createLocalSession(user: User) {
  return {
    claims: {
      sub: user.id,
      email: user.email,
      first_name: user.firstName,
      last_name: user.lastName,
      profile_image_url: user.profileImageUrl,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60), // 7 dias
    },
    access_token: 'local-admin-token',
    refresh_token: 'local-admin-refresh',
    expires_at: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60),
  };
}