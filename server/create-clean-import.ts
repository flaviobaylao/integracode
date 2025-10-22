import XLSX from 'xlsx';
import { db } from './db';
import { customers, salesCards } from '../shared/schema';

async function createCleanImport() {
  console.log('🧹 Criando planilha limpa para importação...\n');
  
  // Ler planilha original
  const workbook = XLSX.readFile('attached_assets/importacao dados integra atualizado 21.10_1761134117882.xlsx');
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(worksheet);
  
  // Buscar todos os clientes e cards do banco
  const allCustomers = await db.select().from(customers);
  const allCards = await db.select().from(salesCards);
  
  const customersByCnpj = new Map();
  const customersByCpf = new Map();
  
  allCustomers.forEach(c => {
    if (c.cnpj) customersByCnpj.set(c.cnpj.replace(/\D/g, ''), c);
    if (c.cpf) customersByCpf.set(c.cpf.replace(/\D/g, ''), c);
  });
  
  const validRows: any[] = [];
  const invalidRows: any[] = [];
  
  // Processar cada linha
  for (let i = 0; i < data.length; i++) {
    const row = data[i] as any;
    const errors: string[] = [];
    
    // Validar CNPJ/CPF
    const cnpjRaw = row.CNPJ || row['CNPJ/CPF'] || row.cnpj || row['cnpj/cpf'];
    if (!cnpjRaw) {
      errors.push('CNPJ/CPF ausente');
      invalidRows.push({ ...row, MOTIVO_ERRO: errors.join('; ') });
      continue;
    }
    
    const cnpj = cnpjRaw.toString().replace(/\D/g, '');
    let customer = customersByCnpj.get(cnpj) || customersByCpf.get(cnpj);
    
    if (!customer) {
      errors.push('Cliente não encontrado no banco');
      invalidRows.push({ ...row, MOTIVO_ERRO: errors.join('; ') });
      continue;
    }
    
    // Verificar se tem card ativo
    const ACTIVE_STATUSES = ['pending', 'telemarketing'];
    const hasActiveCard = allCards.some(
      card => card.customerId === customer.id && ACTIVE_STATUSES.includes(card.status)
    );
    
    if (hasActiveCard) {
      errors.push('Cliente já possui card ativo');
      invalidRows.push({ ...row, MOTIVO_ERRO: errors.join('; ') });
      continue;
    }
    
    // Validar LATITUDE
    const latitudeCol = row['LATITUDE'] || row['Latitude'] || row['latitude'];
    if (!latitudeCol || latitudeCol.toString().trim() === '') {
      errors.push('LATITUDE ausente');
    } else {
      const latValue = parseFloat(latitudeCol.toString().replace(',', '.'));
      if (isNaN(latValue)) {
        errors.push('LATITUDE inválida');
      }
    }
    
    // Validar LONGITUDE
    const longitudeCol = row['LONGITUDE'] || row['Longitude'] || row['longitude'];
    if (!longitudeCol || longitudeCol.toString().trim() === '') {
      errors.push('LONGITUDE ausente');
    } else {
      const lonValue = parseFloat(longitudeCol.toString().replace(',', '.'));
      if (isNaN(lonValue)) {
        errors.push('LONGITUDE inválida');
      }
    }
    
    // Validar DATA INICIO
    const dataInicioCol = row['DATA INICIO'] || row['Data Inicio'] || row['data inicio'] || 
                          row['DATA INÍCIO'] || row['Data Início'] || row['data início'] ||
                          row['DATAINICIO'] || row['DataInicio'] || row['datainicio'];
    
    if (!dataInicioCol || dataInicioCol.toString().trim() === '') {
      errors.push('DATA INICIO ausente');
    }
    
    // Validar TIPO DE ATENDIMENTO
    const tipoAtendimentoCol = row['TIPO DE ATENDIMENTO'] || row['Tipo de Atendimento'] || row['tipo de atendimento'] ||
                               row['TIPO DE ATENDIMENTO '] || row['Tipo de Atendimento '] || row['tipo de atendimento '] ||
                               row['TIPOATENDIMENTO'] || row['TipoAtendimento'] || row['tipoatendimento'];
    
    if (!tipoAtendimentoCol || tipoAtendimentoCol.toString().trim() === '') {
      errors.push('TIPO DE ATENDIMENTO ausente');
    } else {
      const tipoStr = tipoAtendimentoCol.toString().toUpperCase().trim();
      if (tipoStr !== 'VIRTUAL' && tipoStr !== 'PRESENCIAL') {
        errors.push('TIPO DE ATENDIMENTO inválido (use PRESENCIAL ou VIRTUAL)');
      }
    }
    
    if (errors.length > 0) {
      invalidRows.push({ ...row, MOTIVO_ERRO: errors.join('; ') });
    } else {
      validRows.push(row);
    }
  }
  
  console.log(`✅ Linhas válidas: ${validRows.length}`);
  console.log(`❌ Linhas inválidas: ${invalidRows.length}\n`);
  
  // Criar planilha com linhas válidas
  if (validRows.length > 0) {
    const wbValid = XLSX.utils.book_new();
    const wsValid = XLSX.utils.json_to_sheet(validRows);
    XLSX.utils.book_append_sheet(wbValid, wsValid, 'Cards Válidos');
    XLSX.writeFile(wbValid, 'attached_assets/importacao_VALIDOS_APENAS.xlsx');
    console.log(`📄 Planilha com ${validRows.length} linhas válidas salva em: attached_assets/importacao_VALIDOS_APENAS.xlsx`);
  }
  
  // Criar planilha com linhas inválidas e motivos
  if (invalidRows.length > 0) {
    const wbInvalid = XLSX.utils.book_new();
    const wsInvalid = XLSX.utils.json_to_sheet(invalidRows);
    XLSX.utils.book_append_sheet(wbInvalid, wsInvalid, 'Cards com Erros');
    XLSX.writeFile(wbInvalid, 'attached_assets/importacao_ERROS.xlsx');
    console.log(`📄 Planilha com ${invalidRows.length} linhas com erros salva em: attached_assets/importacao_ERROS.xlsx\n`);
  }
  
  console.log('✅ Processo concluído!');
}

createCleanImport().catch(console.error).finally(() => process.exit(0));
