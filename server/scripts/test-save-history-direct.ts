import { db } from '../db';
import { systemSettings } from '@shared/schema';
import { eq } from 'drizzle-orm';

async function testSaveHistory() {
  try {
    const historyKey = 'future_agenda_history';
    
    console.log('💾 Salvando histórico de execução...');
    
    const existingSettings = await db.select()
      .from(systemSettings)
      .where(eq(systemSettings.key, historyKey))
      .limit(1);
    
    const newEntry = {
      timestamp: new Date().toISOString(),
      monthsAhead: 2,
      processed: 100,
      generated: 50,
      skipped: 30,
      errors: 0,
      durationSeconds: 45.5
    };
    
    if (existingSettings.length > 0) {
      console.log('📝 Atualizando histórico existente...');
      const history = JSON.parse(existingSettings[0].value || '[]');
      history.unshift(newEntry);
      
      const trimmedHistory = history.slice(0, 30);
      
      await db.update(systemSettings)
        .set({ 
          value: JSON.stringify(trimmedHistory),
          updatedAt: new Date()
        })
        .where(eq(systemSettings.key, historyKey));
      
      console.log('✅ Histórico atualizado');
    } else {
      console.log('📝 Criando novo registro de histórico...');
      await db.insert(systemSettings).values({
        key: historyKey,
        value: JSON.stringify([newEntry]),
        description: 'Histórico de execuções automáticas de geração de agenda futura',
        updatedBy: 'system'
      });
      
      console.log('✅ Histórico criado');
    }
    
    // Verificar
    const result = await db.select()
      .from(systemSettings)
      .where(eq(systemSettings.key, historyKey));
    
    console.log('\n📊 Histórico salvo:');
    console.log(JSON.stringify(JSON.parse(result[0].value), null, 2));
    
    process.exit(0);
  } catch (error: any) {
    console.error('❌ Erro:', error.message);
    process.exit(1);
  }
}

testSaveHistory();
