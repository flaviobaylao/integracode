// Criar script para analisar os primeiros débitos retornados pela API
import { readFileSync } from 'fs';

// Simular busca dos logs
const logsPath = '/tmp/logs/Start_application_20251010_002840_846.log';
const logs = readFileSync(logsPath, 'utf-8');

// Extrair informações sobre status encontrados
const statusMatches = logs.match(/Status: [A-Z_\s]+/g) || [];
const statusCounts = new Map();

statusMatches.slice(0, 50).forEach(match => {
  const status = match.replace('Status: ', '').trim();
  statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
});

console.log('=== STATUS ENCONTRADOS NOS LOGS (primeiras 50 contas) ===');
for (const [status, count] of statusCounts) {
  console.log(`${status}: ${count} vezes`);
}

// Verificar se há menção a filtros aplicados
const filterLines = logs.split('\n').filter(line => 
  line.includes('INCLUÍDO') || line.includes('EXCLUÍDO') || line.includes('pulando')
).slice(0, 30);

console.log('\n=== LINHAS DE FILTRO (primeiras 30) ===');
filterLines.forEach(line => console.log(line.trim()));
