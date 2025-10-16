import { db } from '../db';
import { systemSettings } from '@shared/schema';
import { eq } from 'drizzle-orm';

async function testHistorySave() {
  try {
    console.log('🧪 Testando salvamento de histórico...\n');
    
    const historyKey = 'future_agenda_history';
    
    // Tentar inserir
    console.log('1. Inserindo novo registro...');
    await db.insert(systemSettings).values({
      key: historyKey,
      value: JSON.stringify([{
        timestamp: new Date().toISOString(),
        test: true
      }]),
      description: 'Teste de histórico',
      updatedBy: 'system'
    });
    
    console.log('✅ Inserção concluída');
    
    // Verificar
    console.log('\n2. Verificando registro...');
    const results = await db.select()
      .from(systemSettings)
      .where(eq(systemSettings.key, historyKey));
    
    console.log('Resultados:', JSON.stringify(results, null, 2));
    
    // Limpar
    console.log('\n3. Limpando registro de teste...');
    await db.delete(systemSettings)
      .where(eq(systemSettings.key, historyKey));
    
    console.log('✅ Teste concluído com sucesso!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Erro no teste:', error);
    process.exit(1);
  }
}

testHistorySave();
