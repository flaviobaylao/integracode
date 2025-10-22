import XLSX from 'xlsx';
import { db } from './db';
import { customers } from '../shared/schema';
import { eq, like, or, sql } from 'drizzle-orm';
import { readFileSync } from 'fs';

async function investigateMissingCustomers() {
  console.log('=== INVESTIGAÇÃO DE CLIENTES NÃO ENCONTRADOS ===\n');

  // Ler planilha
  const buffer = readFileSync('attached_assets/importacao dados integra atualizado 21.10_1761160013498.xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet);

  // Carregar todos os clientes do banco
  const allCustomers = await db.select().from(customers);
  const customerMap = new Map(allCustomers.map(c => [c.cnpj, c]));

  // Lista de clientes não encontrados
  const naoEncontrados: any[] = [];

  for (const row of data as any[]) {
    const cnpjCpf = String(row['CNPJ/CPF'] || '').trim().replace(/[.\-/]/g, '');
    
    if (!cnpjCpf) continue;

    const customer = customerMap.get(cnpjCpf);
    if (!customer) {
      naoEncontrados.push({
        cnpjCpf,
        cnpjCpfOriginal: row['CNPJ/CPF'],
        cliente: row['Cliente (Nome Fantasia)'],
        rota: row['ROTA'],
        frequencia: row['FREQUENCIA']
      });
    }
  }

  console.log(`📊 Total de clientes não encontrados: ${naoEncontrados.length}\n`);

  // Investigar os primeiros 20 casos
  console.log('=== INVESTIGANDO OS PRIMEIROS 20 CASOS ===\n');

  for (let i = 0; i < Math.min(20, naoEncontrados.length); i++) {
    const item = naoEncontrados[i];
    console.log(`\n--- CASO ${i + 1} ---`);
    console.log(`Nome: ${item.cliente}`);
    console.log(`CNPJ/CPF na planilha: ${item.cnpjCpfOriginal}`);
    console.log(`CNPJ/CPF normalizado: ${item.cnpjCpf}`);
    
    // Verificar se existe com nome parecido
    const byName = await db.select()
      .from(customers)
      .where(
        or(
          like(customers.fantasyName, `%${item.cliente}%`),
          like(customers.companyName, `%${item.cliente}%`)
        )
      )
      .limit(3);

    if (byName.length > 0) {
      console.log(`\n🔍 Encontrado cliente(s) com nome parecido:`);
      byName.forEach(c => {
        console.log(`   - Nome: ${c.fantasyName || c.companyName}`);
        console.log(`     CNPJ: ${c.cnpj || c.cpf}`);
        console.log(`     ID Omie: ${c.omieClientCode || 'N/A'}`);
      });
    } else {
      console.log(`❌ Não encontrado por nome`);
    }

    // Verificar se tem código Omie
    const hasSyncInfo = item.cliente.includes('(') || item.cliente.includes('[');
    if (hasSyncInfo) {
      console.log(`ℹ️  Nome contém caracteres especiais que podem indicar dados do Omie`);
    }

    // Verificar tamanho do CNPJ/CPF
    const length = item.cnpjCpf.length;
    if (length !== 11 && length !== 14) {
      console.log(`⚠️  CNPJ/CPF com tamanho inválido: ${length} dígitos`);
    }

    // Verificar se é só zeros ou padrão inválido
    if (item.cnpjCpf === '00000000000' || item.cnpjCpf === '00000000000000') {
      console.log(`⚠️  CNPJ/CPF com padrão inválido (todos zeros)`);
    }
  }

  // Estatísticas por tamanho de documento
  console.log('\n\n=== ESTATÍSTICAS POR TIPO DE DOCUMENTO ===\n');
  const porTamanho = naoEncontrados.reduce((acc: any, item) => {
    const length = item.cnpjCpf.length;
    acc[length] = (acc[length] || 0) + 1;
    return acc;
  }, {});

  Object.entries(porTamanho).forEach(([length, count]) => {
    const tipo = length === '11' ? 'CPF' : length === '14' ? 'CNPJ' : 'INVÁLIDO';
    console.log(`${tipo} (${length} dígitos): ${count}`);
  });

  // Verificar se existem no Omie (clientes com omieClientCode)
  console.log('\n\n=== VERIFICANDO SE EXISTEM NO OMIE ===\n');
  
  const clientesComOmie = await db.select()
    .from(customers)
    .where(sql`${customers.omieClientCode} IS NOT NULL`)
    .limit(10);

  console.log(`Total de clientes com código Omie no banco: ${clientesComOmie.length > 0 ? 'SIM' : 'NÃO'}`);
  
  if (clientesComOmie.length > 0) {
    console.log('Exemplos de clientes com código Omie:');
    clientesComOmie.slice(0, 5).forEach(c => {
      console.log(`- ${c.fantasyName || c.companyName} | Código Omie: ${c.omieClientCode} | CNPJ: ${c.cnpj}`);
    });
  }

  // Verificar documentos duplicados na planilha
  console.log('\n\n=== VERIFICANDO DUPLICATAS NA PLANILHA ===\n');
  const documentCounts = naoEncontrados.reduce((acc: any, item) => {
    acc[item.cnpjCpf] = (acc[item.cnpjCpf] || 0) + 1;
    return acc;
  }, {});

  const duplicados = Object.entries(documentCounts).filter(([_, count]) => count > 1);
  if (duplicados.length > 0) {
    console.log(`⚠️  Encontrados ${duplicados.length} documentos duplicados na lista de não encontrados:`);
    duplicados.slice(0, 5).forEach(([doc, count]) => {
      console.log(`   ${doc}: ${count} vezes`);
    });
  } else {
    console.log('✅ Não há duplicatas na lista de não encontrados');
  }
}

investigateMissingCustomers()
  .then(() => {
    console.log('\n✅ Investigação concluída');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Erro na investigação:', err);
    process.exit(1);
  });
