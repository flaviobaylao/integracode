import XLSX from 'xlsx';
import { db } from './db';
import { customers, salesCards } from '../shared/schema';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'fs';

async function analyzeImport() {
  console.log('=== ANÁLISE DA IMPORTAÇÃO ===\n');

  // Ler planilha
  const buffer = readFileSync('attached_assets/importacao dados integra atualizado 21.10_1761160013498.xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet);

  console.log(`📊 Total de linhas na planilha: ${data.length}\n`);

  // Carregar todos os clientes do banco de uma vez
  console.log('🔍 Carregando clientes do banco...');
  const allCustomers = await db.select().from(customers);
  const customerMap = new Map(allCustomers.map(c => [c.cnpj, c]));
  console.log(`✅ ${allCustomers.length} clientes carregados\n`);

  // Carregar todos os sales cards
  console.log('🔍 Carregando sales cards...');
  const allCards = await db.select().from(salesCards);
  const cardsMap = new Map(allCards.map(c => [c.customerId, c]));
  console.log(`✅ ${allCards.length} cards carregados\n`);

  // Análise detalhada
  const analysis = {
    total: data.length,
    comCoordenadas: 0,
    semCoordenadas: 0,
    clientesEncontrados: 0,
    clientesNaoEncontrados: 0,
    comCardAtivo: 0,
    semDataInicio: 0,
    semCnpj: 0,
    detalhes: [] as any[]
  };

  for (const row of data as any[]) {
    const cnpjCpf = String(row['CNPJ/CPF'] || '').trim().replace(/[.\-/]/g, '');
    
    if (!cnpjCpf) {
      analysis.semCnpj++;
      continue;
    }

    // Verificar coordenadas
    const latitude = row['LATITUDE'];
    const longitude = row['LONGITUDE'];
    const temCoordenadas = latitude && longitude && !isNaN(parseFloat(String(latitude))) && !isNaN(parseFloat(String(longitude)));
    
    if (temCoordenadas) {
      analysis.comCoordenadas++;
    } else {
      analysis.semCoordenadas++;
    }

    // Verificar DATA INICIO
    const dataInicio = row['DATA INICIO'];
    if (!dataInicio) {
      analysis.semDataInicio++;
    }

    // Buscar cliente no mapa
    const customer = customerMap.get(cnpjCpf);

    if (!customer) {
      analysis.clientesNaoEncontrados++;
      analysis.detalhes.push({
        cnpjCpf,
        cliente: row['Cliente (Nome Fantasia)'],
        status: 'CLIENTE_NAO_ENCONTRADO',
        temCoordenadas,
        temDataInicio: !!dataInicio
      });
      continue;
    }

    analysis.clientesEncontrados++;

    // Verificar se já tem card ativo
    const activeCard = cardsMap.get(customer.id);

    if (activeCard) {
      analysis.comCardAtivo++;
      analysis.detalhes.push({
        cnpjCpf,
        cliente: row['Cliente (Nome Fantasia)'],
        status: 'JA_TEM_CARD_ATIVO',
        temCoordenadas,
        temDataInicio: !!dataInicio
      });
    } else {
      analysis.detalhes.push({
        cnpjCpf,
        cliente: row['Cliente (Nome Fantasia)'],
        status: 'OK_PODE_CRIAR',
        temCoordenadas,
        temDataInicio: !!dataInicio
      });
    }
  }

  // Resultados
  console.log('\n=== RESUMO DA ANÁLISE ===\n');
  console.log(`📋 Total de linhas: ${analysis.total}`);
  console.log(`❌ Linhas sem CNPJ/CPF: ${analysis.semCnpj}`);
  console.log(`🌍 Com coordenadas: ${analysis.comCoordenadas}`);
  console.log(`⚠️  Sem coordenadas: ${analysis.semCoordenadas}`);
  console.log(`📅 Sem DATA INICIO: ${analysis.semDataInicio}`);
  console.log(`✅ Clientes encontrados no banco: ${analysis.clientesEncontrados}`);
  console.log(`❌ Clientes NÃO encontrados no banco: ${analysis.clientesNaoEncontrados}`);
  console.log(`🔒 Clientes que JÁ têm card ativo: ${analysis.comCardAtivo}`);
  console.log(`✨ Clientes que PODEM receber novo card: ${analysis.clientesEncontrados - analysis.comCardAtivo}\n`);

  // Agrupar por status
  const porStatus = analysis.detalhes.reduce((acc: any, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});

  console.log('=== DISTRIBUIÇÃO POR STATUS ===');
  Object.entries(porStatus).forEach(([status, count]) => {
    console.log(`${status}: ${count}`);
  });

  // Mostrar alguns exemplos de cada categoria
  console.log('\n=== EXEMPLOS DE CLIENTES NÃO ENCONTRADOS (primeiros 10) ===');
  const naoEncontrados = analysis.detalhes.filter(d => d.status === 'CLIENTE_NAO_ENCONTRADO').slice(0, 10);
  naoEncontrados.forEach(item => {
    console.log(`- CNPJ/CPF: ${item.cnpjCpf} | Cliente: ${item.cliente}`);
  });

  console.log('\n=== EXEMPLOS DE CLIENTES COM CARD ATIVO (primeiros 10) ===');
  const comCard = analysis.detalhes.filter(d => d.status === 'JA_TEM_CARD_ATIVO').slice(0, 10);
  comCard.forEach(item => {
    console.log(`- CNPJ/CPF: ${item.cnpjCpf} | Cliente: ${item.cliente}`);
  });

  console.log(`\n=== CARDS NO BANCO DE DADOS ===`);
  console.log(`Total de cards existentes: ${allCards.length}`);
}

analyzeImport()
  .then(() => {
    console.log('\n✅ Análise concluída');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Erro na análise:', err);
    process.exit(1);
  });
