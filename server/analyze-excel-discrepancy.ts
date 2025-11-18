import * as XLSX from 'xlsx';
import { readFileSync } from 'fs';
import { db } from './db';
import { billings } from '../shared/schema';
import { eq } from 'drizzle-orm';

async function analyzeDiscrepancy() {
  try {
    console.log('📊 Analisando discrepância entre Sistema e Omie...\n');

    // Ler arquivo do Omie
    const omieBuffer = readFileSync('../attached_assets/dados-omie-2025-11-18_1763501175324.xlsx');
    const omieWorkbook = XLSX.read(omieBuffer, { type: 'buffer' });
    const omieSheet = omieWorkbook.Sheets[omieWorkbook.SheetNames[0]];
    const omieDataRaw = XLSX.utils.sheet_to_json(omieSheet);
    
    // Filtrar apenas pedidos "Aguardando Rota"
    const omieData = omieDataRaw.filter((row: any) => row['Etapa'] === 'Aguardando Rota');
    
    console.log(`📦 Omie Total: ${omieDataRaw.length} registros`);
    console.log(`📦 Omie Aguardando Rota: ${omieData.length} registros`);
    console.log('Primeiras 3 linhas do Omie (Aguardando Rota):', omieData.slice(0, 3));

    // Ler arquivo do Sistema
    const sistemaBuffer = readFileSync('../attached_assets/vendas_e_nf-e_660911026976802_1763501175324.xlsx');
    const sistemaWorkbook = XLSX.read(sistemaBuffer, { type: 'buffer' });
    const sistemaSheet = sistemaWorkbook.Sheets[sistemaWorkbook.SheetNames[0]];
    // Pular as duas primeiras linhas (cabeçalho malformado)
    const sistemaDataRaw = XLSX.utils.sheet_to_json(sistemaSheet, { range: 2 });
    
    // Filtrar registros válidos
    const sistemaData = sistemaDataRaw.filter((row: any) => row['__EMPTY_1']);
    
    console.log(`\n📦 Sistema: ${sistemaData.length} registros válidos`);
    console.log('Primeiras 3 linhas do Sistema:', sistemaData.slice(0, 3));

    // Identificar chaves de identificação
    console.log('\n🔍 Estrutura dos dados:');
    console.log('Colunas Omie:', Object.keys(omieData[0] || {}));
    console.log('Colunas Sistema:', Object.keys(sistemaData[0] || {}));

    // Buscar dados reais do banco
    console.log('\n📊 Consultando banco de dados...');
    const billingsData = await db.select().from(billings).where(eq(billings.invoiceStage, 'Aguardando Rota'));
    
    console.log(`\n💾 Banco de dados: ${billingsData.length} pedidos com status "Aguardando Rota"`);
    
    // Extrair números de NF únicos
    const omieNumbers = omieData.map((row: any) => {
      // Coluna "Número NF" do arquivo do Omie
      return row['Número NF'] || row['ID NF Omie'];
    }).filter(Boolean);

    const sistemaNumbers = sistemaData.map((row: any) => {
      // Coluna __EMPTY_2 que contém o "Nota Fiscal" (número da NF)
      const nf = row['FILIAL GYN - Vendas e NF-e - Pedido de Venda'];
      // Verificar se é um número de NF (começa com zeros)
      if (typeof nf === 'string' && nf.match(/^\d{8}$/)) {
        return nf;
      }
      if (typeof nf === 'number') {
        return String(nf).padStart(8, '0');
      }
      return null;
    }).filter(Boolean);

    const dbNumbers = billingsData.map(b => b.invoiceNumber).filter(Boolean);

    console.log('\n📋 Números encontrados:');
    console.log(`Omie: ${omieNumbers.length} números`);
    console.log(`Sistema: ${sistemaNumbers.length} números`);
    console.log(`Banco: ${dbNumbers.length} números`);

    // Encontrar diferenças
    const omieSet = new Set(omieNumbers.map(String));
    const sistemaSet = new Set(sistemaNumbers.map(String));
    const dbSet = new Set(dbNumbers.map(String));

    const apenasNoOmie = [...omieSet].filter(n => !sistemaSet.has(n));
    const apenasNoSistema = [...sistemaSet].filter(n => !omieSet.has(n));
    const apenasNoBanco = [...dbSet].filter(n => !omieSet.has(n));
    const noOmieMasNaoBanco = [...omieSet].filter(n => !dbSet.has(n));

    console.log('\n🔍 DISCREPÂNCIAS ENCONTRADAS:');
    console.log(`\n❌ Apenas no Omie (${apenasNoOmie.length}):`, apenasNoOmie);
    console.log(`\n❌ Apenas no Sistema exportado (${apenasNoSistema.length}):`, apenasNoSistema);
    console.log(`\n❌ Apenas no Banco de dados (${apenasNoBanco.length}):`, apenasNoBanco);
    console.log(`\n⚠️ No Omie mas não no Banco (${noOmieMasNaoBanco.length}):`, noOmieMasNaoBanco);

    // Analisar os 3 pedidos faltantes
    if (noOmieMasNaoBanco.length > 0) {
      console.log('\n🔍 ANÁLISE DETALHADA DOS PEDIDOS FALTANTES:');
      for (const nf of noOmieMasNaoBanco.slice(0, 10)) {
        const omieRecord = omieData.find((row: any) => 
          String(row['Número'] || row['numero'] || row['NF'] || row['nf'] || row['Pedido'] || row['pedido']) === nf
        );
        
        console.log(`\n📄 NF ${nf}:`);
        console.log('  Dados do Omie:', omieRecord);
        
        // Verificar se existe no banco com outro status
        const billInDb = await db.select().from(billings).where(eq(billings.invoiceNumber, nf));
        if (billInDb.length > 0) {
          console.log(`  ⚠️ ENCONTRADO NO BANCO com status diferente:`, {
            invoiceNumber: billInDb[0].invoiceNumber,
            invoiceStage: billInDb[0].invoiceStage,
            customerId: billInDb[0].customerId,
            orderDate: billInDb[0].orderDate
          });
        } else {
          console.log(`  ❌ NÃO EXISTE NO BANCO`);
        }
      }
    }

    console.log('\n✅ Análise concluída!');

  } catch (error: any) {
    console.error('❌ Erro na análise:', error);
    console.error(error.stack);
  } finally {
    process.exit(0);
  }
}

analyzeDiscrepancy();
