import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';

export interface TelegramStatus {
  status: 'disconnected' | 'connecting' | 'qr_ready' | 'connected';
  botUsername?: string;
  qrCode?: string;
  lastConnection?: string;
}

export class TelegramService {
  private bot: TelegramBot | null = null;
  private currentStatus: TelegramStatus = { status: 'disconnected' };
  private statusCallbacks: ((status: TelegramStatus) => void)[] = [];
  private sessionFile = path.join(process.cwd(), 'telegram-session', 'session.json');
  private botToken: string | null = null;
  private qrCodeData: string | null = null;
  private connectionTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.ensureSessionDirectory();
    this.loadSession();
  }

  private ensureSessionDirectory(): void {
    const sessionDir = path.dirname(this.sessionFile);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
  }

  private loadSession(): void {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const sessionData = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
        if (sessionData.botToken && sessionData.botUsername) {
          this.botToken = sessionData.botToken;
          this.currentStatus = {
            status: 'connected',
            botUsername: sessionData.botUsername,
            lastConnection: sessionData.lastConnection
          };
          this.initializeBot(this.botToken);
          console.log(`Telegram session restored: @${sessionData.botUsername}`);
        }
      }
    } catch (error) {
      console.error('Error loading Telegram session:', error);
    }
  }

  private saveSession(botUsername: string): void {
    try {
      const sessionData = {
        botToken: this.botToken,
        botUsername: botUsername,
        lastConnection: new Date().toISOString()
      };
      fs.writeFileSync(this.sessionFile, JSON.stringify(sessionData, null, 2));
    } catch (error) {
      console.error('Error saving Telegram session:', error);
    }
  }

  private initializeBot(token: string): void {
    try {
      this.bot = new TelegramBot(token, { polling: true });
      
      // Handle incoming messages
      this.bot.on('message', (msg) => {
        console.log('Received Telegram message:', msg.text);
        // Here you can implement message handling logic
        // Forward to your conversation management system
      });

      // Handle polling errors
      this.bot.on('polling_error', (error) => {
        console.error('Telegram polling error:', error);
      });

    } catch (error) {
      console.error('Error initializing Telegram bot:', error);
      throw error;
    }
  }

  public async connectWithToken(token: string): Promise<void> {
    if (this.currentStatus.status === 'connected') {
      throw new Error('Telegram bot já está conectado');
    }

    try {
      this.currentStatus = { status: 'connecting' };
      this.notifyStatusChange();

      // Test the token by getting bot info
      const testBot = new TelegramBot(token);
      const botInfo = await testBot.getMe();
      
      // Stop test bot
      await testBot.stopPolling();

      // Initialize the real bot
      this.botToken = token;
      this.initializeBot(token);

      this.currentStatus = {
        status: 'connected',
        botUsername: botInfo.username,
        lastConnection: new Date().toISOString()
      };

      this.saveSession(botInfo.username!);
      this.notifyStatusChange();

      console.log(`Telegram bot connected: @${botInfo.username}`);
    } catch (error) {
      console.error('Error connecting Telegram bot:', error);
      this.currentStatus = { status: 'disconnected' };
      this.notifyStatusChange();
      throw new Error('Token do bot inválido ou erro de conexão');
    }
  }

  public async generateSetupQR(): Promise<string> {
    if (this.currentStatus.status === 'connected') {
      throw new Error('Telegram bot já está conectado');
    }

    // If already have setup QR code, return it
    if (this.qrCodeData && this.currentStatus.status === 'qr_ready') {
      return this.qrCodeData;
    }

    // Generate setup instructions QR code
    const setupInstructions = JSON.stringify({
      type: 'telegram_bot_setup',
      steps: [
        '1. Abra o Telegram e procure por @BotFather',
        '2. Digite /newbot para criar um novo bot',
        '3. Siga as instruções e escolha um nome',
        '4. Copie o token que aparece como: 123456789:ABC...',
        '5. Cole o token na interface do sistema'
      ],
      botfather_url: 'https://t.me/botfather',
      timestamp: Date.now()
    });

    try {
      this.qrCodeData = await QRCode.toDataURL(setupInstructions, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 256,
        color: {
          dark: '#0088cc',
          light: '#FFFFFF'
        }
      });
      
      this.currentStatus = {
        status: 'qr_ready',
        qrCode: this.qrCodeData
      };
      
      this.notifyStatusChange();
      
      return this.qrCodeData;
    } catch (error) {
      console.error('Error generating setup QR code:', error);
      throw new Error('Erro ao gerar QR Code de configuração');
    }
  }

  public async disconnect(): Promise<void> {
    // Clear any pending timeouts
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }

    // Stop bot polling
    if (this.bot) {
      try {
        await this.bot.stopPolling();
      } catch (error) {
        console.error('Error stopping bot polling:', error);
      }
      this.bot = null;
    }

    this.botToken = null;
    this.qrCodeData = null;
    this.currentStatus = { status: 'disconnected' };
    
    // Remove session file
    try {
      if (fs.existsSync(this.sessionFile)) {
        fs.unlinkSync(this.sessionFile);
      }
    } catch (error) {
      console.error('Error removing session file:', error);
    }
    
    this.notifyStatusChange();
    console.log('Telegram bot disconnected');
  }

  public getStatus(): TelegramStatus {
    return { ...this.currentStatus };
  }

  public onStatusChange(callback: (status: TelegramStatus) => void): void {
    this.statusCallbacks.push(callback);
  }

  public removeStatusListener(callback: (status: TelegramStatus) => void): void {
    const index = this.statusCallbacks.indexOf(callback);
    if (index > -1) {
      this.statusCallbacks.splice(index, 1);
    }
  }

  private notifyStatusChange(): void {
    this.statusCallbacks.forEach(callback => {
      try {
        callback({ ...this.currentStatus });
      } catch (error) {
        console.error('Error in status callback:', error);
      }
    });
  }

  public async sendMessage(chatId: string, message: string): Promise<void> {
    if (!this.bot || this.currentStatus.status !== 'connected') {
      throw new Error('Telegram bot não está conectado');
    }

    try {
      await this.bot.sendMessage(chatId, message);
      console.log(`[Telegram] Message sent to ${chatId}: ${message}`);
    } catch (error) {
      console.error('Error sending Telegram message:', error);
      throw new Error('Erro ao enviar mensagem pelo Telegram');
    }
  }

  public async getChats() {
    if (!this.bot || this.currentStatus.status !== 'connected') {
      throw new Error('Telegram bot não está conectado');
    }

    try {
      // For Telegram bots, we don't get chat list directly
      // Instead, chats are created when users message the bot
      // Return mock data that represents recent conversations
      return [
        {
          id: '123456789',
          name: 'Cliente Exemplo',
          lastMessage: 'Olá, preciso de ajuda',
          timestamp: Date.now() - 300000, // 5 minutes ago
          unreadCount: 1
        }
      ];
    } catch (error) {
      console.error('Error getting Telegram chats:', error);
      throw new Error('Erro ao buscar conversas do Telegram');
    }
  }
}

// Export singleton instance
export const telegramService = new TelegramService();