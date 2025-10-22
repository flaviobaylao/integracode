import XLSX from 'xlsx';
import { db } from './db';
import { customers, salesCards } from '../shared/schema';
import { eq, and } from 'drizzle-orm';

async function analyzeImport() {
  console.log('🔍 Analisando planilha de importação...\n');
  
  // Ler planilha
  const workbook = XLSX.readFile('attached_assets/importacao dados integra atualizado 21.10_1761134117882.xlsx');
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(worksheet);
  
  console.log(`📄 Total de linhas na planilha: ${data.length}\n`);
  
  const analysis = {
    totalRows: data.length,
    validRows: 0,
    invalidRows: 0,
    missingCnpj: 0,
    invalidLatitude: 0,
    invalidLongitude: 0,
    missingDataInicio: 0,
    invalidDataInicio: 0,
    invalidTipoAtendimento: 0,
    customerNotFoundInDb: 0,
    customerHasActiveCard: 0,
    otherErrors: 0,
    errors: [] as any[]
  };
  
  // Buscar todos os clientes e cards do banco
  const allCustomers = await db.select().from(customers);
  const allCards = await db.select().from(salesCards);
  
  console.log(`📊 Dados do banco:`);
  console.log(`   Clientes: ${allCustomers.length}`);
  console.log(`   Sales Cards: ${allCards.length}\n`);
  
  const customersByCnpj = new Map();
  const customersByCpf = new Map();
  
  allCustomers.forEach(c => {
    if (c.cnpj) customersByCnpj.set(c.cnpj.replace(/\D/g, ''), c);
    if (c.cpf) customersByCpf.set(c.cpf.replace(/\D/g, ''), c);
  });
  
  // Processar cada linha
  for (let i = 0; i < data.length; i++) {
    const row = data[i] as any;
    const rowNumber = i + 2; // Excel row (1-indexed + header)
    const errors: string[] = [];
    
    // 1. Validar CNPJ/CPF
    const cnpjRaw = row.CNPJ || row['CNPJ/CPF'] || row.cnpj || row['cnpj/cpf'];
    if (!cnpjRaw) {
      analysis.missingCnpj++;
      errors.push('CNPJ/CPF ausente');
    } else {
      const cnpj = cnpjRaw.toString().replace(/\D/g, '');
      
      // Verificar se cliente existe
      let customer = customersByCnpj.get(cnpj) || customersByCpf.get(cnpj);
      
      if (!customer) {
        analysis.customerNotFoundInDb++;
        errors.push(`Cliente não encontrado no banco (CNPJ: ${cnpj})`);
      } else {
        // Verificar se tem card ativo
        const ACTIVE_STATUSES = ['pending', 'telemarketing'];
        const hasActiveCard = allCards.some(
          card => card.customerId === customer.id && ACTIVE_STATUSES.includes(card.status)
        );
        
        if (hasActiveCard) {
          analysis.customerHasActiveCard++;
          errors.push(`Cliente já possui card ativo (${customer.fantasyName || customer.name})`);
        }
      }
      
      // 2. Validar LATITUDE
      const latitudeCol = row['LATITUDE'] || row['Latitude'] || row['latitude'];
      if (!latitudeCol || latitudeCol.toString().trim() === '') {
        analysis.invalidLatitude++;
        errors.push('LATITUDE ausente');
      } else {
        const latValue = parseFloat(latitudeCol.toString().replace(',', '.'));
        if (isNaN(latValue)) {
          analysis.invalidLatitude++;
          errors.push(`LATITUDE inválida: "${latitudeCol}"`);
        }
      }
      
      // 3. Validar LONGITUDE
      const longitudeCol = row['LONGITUDE'] || row['Longitude'] || row['longitude'];
      if (!longitudeCol || longitudeCol.toString().trim() === '') {
        analysis.invalidLongitude++;
        errors.push('LONGITUDE ausente');
      } else {
        const lonValue = parseFloat(longitudeCol.toString().replace(',', '.'));
        if (isNaN(lonValue)) {
          analysis.invalidLongitude++;
          errors.push(`LONGITUDE inválida: "${longitudeCol}"`);
        }
      }
      
      // 4. Validar DATA INICIO
      const dataInicioCol = row['DATA INICIO'] || row['Data Inicio'] || row['data inicio'] || 
                            row['DATA INÍCIO'] || row['Data Início'] || row['data início'] ||
                            row['DATAINICIO'] || row['DataInicio'] || row['datainicio'];
      
      if (!dataInicioCol || dataInicioCol.toString().trim() === '') {
        analysis.missingDataInicio++;
        errors.push('DATA INICIO ausente');
      } else {
        try {
          const dataStr = dataInicioCol.toString().trim();
          let dataInicio: Date;
          
          if (!isNaN(Number(dataStr))) {
            const excelEpoch = new Date(1900, 0, 1);
            const days = parseInt(dataStr) - 2;
            dataInicio = new Date(excelEpoch.getTime() + days * 24 * 60 * 60 * 1000);
          } else if (dataStr.includes('/')) {
            const parts = dataStr.split('/');
            if (parts.length === 3) {
              const day = parseInt(parts[0]);
              const month = parseInt(parts[1]) - 1;
              let year = parseInt(parts[2]);
              if (year < 100) year += 2000;
              dataInicio = new Date(year, month, day);
            } else {
              throw new Error('Formato inválido');
            }
          } else if (dataStr.includes('-')) {
            dataInicio = new Date(dataStr);
          } else {
            throw new Error('Formato inválido');
          }
          
          if (isNaN(dataInicio.getTime())) {
            throw new Error('Data inválida');
          }
        } catch (dateError) {
          analysis.invalidDataInicio++;
          errors.push(`DATA INICIO inválida: "${dataInicioCol}"`);
        }
      }
      
      // 5. Validar TIPO DE ATENDIMENTO
      const tipoAtendimentoCol = row['TIPO DE ATENDIMENTO'] || row['Tipo de Atendimento'] || row['tipo de atendimento'] ||
                                 row['TIPO DE ATENDIMENTO '] || row['Tipo de Atendimento '] || row['tipo de atendimento '] ||
                                 row['TIPOATENDIMENTO'] || row['TipoAtendimento'] || row['tipoatendimento'];
      
      if (!tipoAtendimentoCol || tipoAtendimentoCol.toString().trim() === '') {
        analysis.invalidTipoAtendimento++;
        errors.push('TIPO DE ATENDIMENTO ausente');
      } else {
        const tipoStr = tipoAtendimentoCol.toString().toUpperCase().trim();
        if (tipoStr !== 'VIRTUAL' && tipoStr !== 'PRESENCIAL') {
          analysis.invalidTipoAtendimento++;
          errors.push(`TIPO DE ATENDIMENTO inválido: "${tipoAtendimentoCol}" (use PRESENCIAL ou VIRTUAL)`);
        }
      }
    }
    
    if (errors.length > 0) {
      analysis.invalidRows++;
      analysis.errors.push({
        row: rowNumber,
        cliente: row['Cliente (Nome Fantasia)'] || 'N/A',
        cnpj: cnpjRaw?.toString() || 'N/A',
        errors: errors.join('; ')
      });
    } else {
      analysis.validRows++;
    }
  }
  
  // Relatório final
  console.log('\n' + '='.repeat(80));
  console.log('📊 RESUMO DA ANÁLISE');
  console.log('='.repeat(80));
  console.log(`\n✅ Linhas válidas: ${analysis.validRows}/${analysis.totalRows} (${(analysis.validRows/analysis.totalRows*100).toFixed(1)}%)`);
  console.log(`❌ Linhas inválidas: ${analysis.invalidRows}/${analysis.totalRows} (${(analysis.invalidRows/analysis.totalRows*100).toFixed(1)}%)\n`);
  
  console.log('📋 Erros por categoria:');
  console.log(`   • CNPJ/CPF ausente: ${analysis.missingCnpj}`);
  console.log(`   • Cliente não encontrado no banco: ${analysis.customerNotFoundInDb}`);
  console.log(`   • Cliente já possui card ativo: ${analysis.customerHasActiveCard}`);
  console.log(`   • LATITUDE inválida/ausente: ${analysis.invalidLatitude}`);
  console.log(`   • LONGITUDE inválida/ausente: ${analysis.invalidLongitude}`);
  console.log(`   • DATA INICIO ausente: ${analysis.missingDataInicio}`);
  console.log(`   • DATA INICIO inválida: ${analysis.invalidDataInicio}`);
  console.log(`   • TIPO DE ATENDIMENTO inválido/ausente: ${analysis.invalidTipoAtendimento}\n`);
  
  if (analysis.errors.length > 0) {
    console.log('='.repeat(80));
    console.log('❌ DETALHES DOS ERROS (primeiros 50)');
    console.log('='.repeat(80));
    analysis.errors.slice(0, 50).forEach(err => {
      console.log(`\nLinha ${err.row}:`);
      console.log(`   Cliente: ${err.cliente}`);
      console.log(`   CNPJ: ${err.cnpj}`);
      console.log(`   Erros: ${err.errors}`);
    });
    
    if (analysis.errors.length > 50) {
      console.log(`\n... e mais ${analysis.errors.length - 50} erros`);
    }
  }
  
  console.log('\n' + '='.repeat(80));
  console.log('💡 CONCLUSÃO');
  console.log('='.repeat(80));
  console.log(`\nDos ${analysis.totalRows} registros na planilha:`);
  console.log(`   • ${analysis.validRows} podem ser importados`);
  console.log(`   • ${analysis.invalidRows} têm problemas que impedem a importação`);
  console.log(`   • ${allCards.length} cards já existem no banco\n`);
  
  // Salvar relatório em arquivo
  const fs = await import('fs');
  const reportPath = 'attached_assets/analise-importacao.txt';
  const report = `
ANÁLISE DE IMPORTAÇÃO DE SALES CARDS
=====================================
Data: ${new Date().toISOString()}

RESUMO
------
Total de linhas na planilha: ${analysis.totalRows}
Linhas válidas: ${analysis.validRows} (${(analysis.validRows/analysis.totalRows*100).toFixed(1)}%)
Linhas inválidas: ${analysis.invalidRows} (${(analysis.invalidRows/analysis.totalRows*100).toFixed(1)}%)

ERROS POR CATEGORIA
--------------------
CNPJ/CPF ausente: ${analysis.missingCnpj}
Cliente não encontrado no banco: ${analysis.customerNotFoundInDb}
Cliente já possui card ativo: ${analysis.customerHasActiveCard}
LATITUDE inválida/ausente: ${analysis.invalidLatitude}
LONGITUDE inválida/ausente: ${analysis.invalidLongitude}
DATA INICIO ausente: ${analysis.missingDataInicio}
DATA INICIO inválida: ${analysis.invalidDataInicio}
TIPO DE ATENDIMENTO inválido/ausente: ${analysis.invalidTipoAtendimento}

DETALHES DOS ERROS
------------------
${analysis.errors.map(err => `
Linha ${err.row}:
   Cliente: ${err.cliente}
   CNPJ: ${err.cnpj}
   Erros: ${err.errors}
`).join('\n')}

CONCLUSÃO
---------
Dos ${analysis.totalRows} registros na planilha:
   • ${analysis.validRows} podem ser importados
   • ${analysis.invalidRows} têm problemas que impedem a importação
   • ${allCards.length} cards já existem no banco
`;
  
  fs.writeFileSync(reportPath, report, 'utf-8');
  console.log(`\n📄 Relatório completo salvo em: ${reportPath}\n`);
}

analyzeImport().catch(console.error).finally(() => process.exit(0));
