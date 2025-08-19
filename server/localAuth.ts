import bcrypt from 'bcrypt';
import { storage } from './storage';
import type { User } from '@shared/schema';

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

export async function validateLocalAdmin(username: string, password: string): Promise<User | null> {
  if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
    // Garantir que o usuário admin existe no banco de dados
    try {
      let adminUser = await storage.getUser(ADMIN_CREDENTIALS.id);
      
      if (!adminUser) {
        // Criar usuário admin se não existir
        adminUser = await storage.upsertUser({
          id: ADMIN_CREDENTIALS.id,
          email: ADMIN_CREDENTIALS.email,
          firstName: ADMIN_CREDENTIALS.firstName,
          lastName: ADMIN_CREDENTIALS.lastName,
          role: ADMIN_CREDENTIALS.role,
          route: ADMIN_CREDENTIALS.route,
          profileImageUrl: ADMIN_CREDENTIALS.profileImageUrl,
          isActive: ADMIN_CREDENTIALS.isActive
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