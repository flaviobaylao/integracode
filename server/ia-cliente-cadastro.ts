// ============================================================================
// INTEGRA 2.0 — Atendente IA: cliente ATIVO nao preenche cadastro de novo (nov/2026)
//
// Caso: Carolina Lopes, cliente ativa com compras rotineiras, falou com o robo pelo
// WhatsApp e ouviu que precisava mandar os dados de cadastro. Tres furos juntos:
//   1) o bloco "ESTE CLIENTE" do prompt so trazia nome e compras — nada de CPF/CNPJ,
//      endereco, cidade. Para registrar o pedido a IA pedia tudo de novo;
//   2) a identificacao era so pelo customers.phone (8 finais do campo inteiro). Telefone
//      confirmado em phone_verifications, campo com dois numeros ("62 9999-1111 / 62
//      98888-2222") ou WhatsApp diferente do telefone do cadastro => cliente "nao achado";
//   3) a IA nao tinha como CONSULTAR o sistema quando o telefone nao batia.
//
// Este modulo resolve os tres:
//   - blocoCadastroCliente(): dados do cadastro no prompt + regra "nao peca de novo";
//   - clientePorTelefone(): identificacao ampliada pelo telefone;
//   - ferramentas buscar_cliente (consulta, dados mascarados) e vincular_cliente
//     (liga a conversa ao cadastro, so com prova: CPF/CNPJ, CEP ou telefone do cadastro);
//   - dadosParaPedido(): completa o registrar_pedido com o cadastro.
//
// Privacidade: a busca por nome devolve so dados mascarados (bairro, cidade, 4 finais do
// documento). Dado completo so entra no prompt DEPOIS que a conversa esta vinculada.
// Vinculo da conversa fica em system_settings 'ia_conv_cliente:<conversationId>'.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const onlyDigits = (s: any) => String(s || '').replace(/\D/g, '');
const norm = (x: any) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ---------------------------------------------------------------- vinculo da conversa
const chaveVinculo = (conversationId: string) => 'ia_conv_cliente:' + conversationId;

export async function clienteVinculadoDaConversa(conversationId?: string | null): Promise<string | null> {
  if (!conversationId) return null;
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${chaveVinculo(conversationId)} LIMIT 1`);
    const v = String(r.rows?.[0]?.value || '').replace(/^"|"$/g, '').trim();
    if (!v) return null;
    const c: any = await db.execute(sql`SELECT id FROM customers WHERE id = ${v} LIMIT 1`);
    return c.rows?.[0]?.id ? String(c.rows[0].id) : null;
  } catch { return null; }
}

async function gravarVinculo(conversationId: string, customerId: string): Promise<void> {
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by)
    VALUES (${chaveVinculo(conversationId)}, ${customerId}, ${'agent-runtime'})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
}

// ---------------------------------------------------------------- identificacao por telefone
// Complementa o resolveCustomerId (que ja tenta disparo oficial e customers.phone exato).
// Ordem: telefone CONFIRMADO pelo cliente (phone_verifications) -> customers.phone que
// CONTEM o numero (campo com mais de um telefone). Sempre so clientes ativos e, havendo
// mais de um, o que comprou por ultimo.
export async function clientePorTelefone(phone: any): Promise<string | null> {
  const d = onlyDigits(phone);
  if (d.length < 10) return null; // exige DDD: 8 digitos soltos casam com gente demais
  const fim8 = d.slice(-8);
  const ddd = d.length >= 12 && d.startsWith('55') ? d.slice(2, 4) : d.slice(0, 2);
  try {
    const r: any = await db.execute(sql`
      SELECT pv.customer_id AS id
        FROM phone_verifications pv JOIN customers c ON c.id = pv.customer_id
       WHERE pv.status = 'confirmed' AND right(pv.phone_digits, 8) = ${fim8}
         AND COALESCE(c.is_active, true) = true
       ORDER BY pv.confirmed_at DESC NULLS LAST LIMIT 1`);
    if (r.rows?.[0]?.id) return String(r.rows[0].id);
  } catch { /* tabela pode nao existir em banco novo */ }
  try {
    // Campo com varios numeros: procura DDD + 8 finais (com ou sem o 9) dentro dos digitos.
    const r: any = await db.execute(sql`
      SELECT c.id FROM customers c
       WHERE COALESCE(c.is_active, true) = true
         AND (regexp_replace(COALESCE(c.phone,''),'[^0-9]','','g') LIKE ${'%' + ddd + '9' + fim8 + '%'}
           OR regexp_replace(COALESCE(c.phone,''),'[^0-9]','','g') LIKE ${'%' + ddd + fim8 + '%'})
       ORDER BY c.last_sale_date DESC NULLS LAST, c.updated_at DESC NULLS LAST
       LIMIT 1`);
    if (r.rows?.[0]?.id) return String(r.rows[0].id);
  } catch {}
  return null;
}

// ---------------------------------------------------------------- leitura do cadastro
async function lerCadastro(customerId: string): Promise<any | null> {
  try {
    const r: any = await db.execute(sql`
      SELECT c.id, c.name, c.company_name, c.fantasy_name, c.customer_type, c.cpf, c.cnpj,
             c.phone, c.contact, c.email, c.address, c.neighborhood, c.city, c.state, c.zip_code,
             c.is_active, c.is_consumer_client, c.payment_method, c.weekdays,
             TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS vendedor
        FROM customers c LEFT JOIN users u ON u.id = c.seller_id
       WHERE c.id = ${customerId} LIMIT 1`);
    return r.rows?.[0] || null;
  } catch { return null; }
}

const docDe = (c: any) => onlyDigits(c?.cnpj) || onlyDigits(c?.cpf);
const nomeDe = (c: any) => String(c?.fantasy_name || c?.name || c?.company_name || '').trim();
const fmtDoc = (d: string) => d.length === 14
  ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
  : (d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : d);
const mascaraDoc = (d: string) => d ? ('final ' + d.slice(-4)) : 'sem documento';

// Regiao da tabela de revenda a partir do cadastro (mesmos nomes do registrar_pedido).
function regiaoDe(c: any): string {
  const uf = String(c?.state || '').toUpperCase().trim();
  const cidade = norm(c?.city);
  if (uf === 'DF' || cidade.includes('brasilia')) return 'brasilia';
  if (cidade === 'goiania') return 'goiania';
  return 'interior';
}

// ---------------------------------------------------------------- bloco do prompt
export async function blocoCadastroCliente(customerId?: string | null): Promise<string> {
  if (!customerId) return '';
  const c = await lerCadastro(customerId);
  if (!c) return '';
  const doc = docDe(c);
  const tipo = c.is_consumer_client ? 'consumidor' : 'revenda';
  const linhas = [
    '# CADASTRO DESTE CLIENTE NO SISTEMA (ja identificado pelo numero desta conversa)',
    `Nome/Fantasia: ${nomeDe(c)}` + (c.company_name && c.company_name !== nomeDe(c) ? ` | Razao social: ${c.company_name}` : ''),
    `${doc.length === 14 ? 'CNPJ' : 'CPF'}: ${doc ? fmtDoc(doc) : '(nao cadastrado)'}`,
    `Endereco: ${String(c.address || '').trim() || '(sem endereco)'}${c.neighborhood ? ', ' + c.neighborhood : ''}${c.city ? ', ' + c.city : ''}${c.state ? '/' + c.state : ''}${c.zip_code ? ' - CEP ' + c.zip_code : ''}`,
    c.contact ? `Contato: ${c.contact}` : '',
    c.email ? `E-mail: ${c.email}` : '',
    c.vendedor ? `Vendedor da carteira: ${c.vendedor}` : '',
    `Situacao: ${c.is_active === false ? 'INATIVO' : 'ATIVO'} | Perfil de preco: ${tipo}${tipo === 'revenda' ? ' (regiao ' + regiaoDe(c) + ')' : ''}`,
    'REGRAS PARA CLIENTE JA CADASTRADO (nao negociaveis):',
    '- NUNCA peca nome, CPF/CNPJ, endereco, bairro, cidade ou CEP: o sistema ja tem. Pedir de novo irrita quem ja compra conosco.',
    '- Se precisar confirmar algo, confirme o que ja temos ("Entrego no endereco de sempre, ' + (c.neighborhood || c.city || 'no cadastro') + '?"), nunca peca para digitar.',
    '- No registrar_pedido, envie so itens, forma de pagamento e dia de entrega (e observacoes). Nome, documento, endereco, tipo de cliente e regiao o sistema completa sozinho com este cadastro.',
    '- So use outro endereco se o CLIENTE disser que mudou; nesse caso coloque o novo endereco em observacoes e avise que a equipe vai atualizar o cadastro.',
  ].filter(Boolean);
  return linhas.join('\n');
}

// Dados do cadastro para completar o registrar_pedido (so o que o modelo nao mandou).
export async function dadosParaPedido(customerId: string): Promise<null | {
  id: string; nome: string; documento: string; endereco: string; bairro: string; cidade: string; cep: string;
  telefone: string; tipo: 'consumidor' | 'revenda'; regiao: string;
}> {
  const c = await lerCadastro(customerId);
  if (!c) return null;
  return {
    id: String(c.id),
    nome: nomeDe(c),
    documento: docDe(c),
    endereco: String(c.address || '').trim(),
    bairro: String(c.neighborhood || '').trim(),
    cidade: String(c.city || '').trim(),
    cep: onlyDigits(c.zip_code),
    telefone: onlyDigits(c.phone),
    tipo: c.is_consumer_client ? 'consumidor' : 'revenda',
    regiao: regiaoDe(c),
  };
}

// ---------------------------------------------------------------- ferramentas
export const TOOL_BUSCAR_CLIENTE: any = {
  name: 'buscar_cliente',
  description: 'CONSULTA o cadastro de clientes do sistema. Use quando o bloco "CADASTRO DESTE CLIENTE" NAO aparecer no prompt e o cliente disser que ja compra conosco, ou citar o nome da empresa/loja, CNPJ/CPF ou outro telefone. Busca por CPF/CNPJ, telefone ou nome (razao social, fantasia ou contato). Devolve no maximo 5 cadastros com dados MASCARADOS (nome, bairro, cidade, 4 finais do documento) — use para perguntar "e a <nome> do bairro <bairro>?" e depois chame vincular_cliente. NUNCA leia para o cliente dados de um cadastro que ele nao confirmou.',
  input_schema: { type: 'object', properties: { termo: { type: 'string', description: 'CPF/CNPJ, telefone com DDD ou nome da empresa/cliente' } }, required: ['termo'] },
};

export const TOOL_VINCULAR_CLIENTE: any = {
  name: 'vincular_cliente',
  description: 'Liga ESTA conversa a um cadastro existente (depois do buscar_cliente), para usar os dados do sistema sem pedir nada de novo. Precisa de UMA prova dita pelo cliente: o CPF/CNPJ completo, OU o CEP, OU o telefone que esta no cadastro. Basta pedir UMA dessas ("pra confirmar, qual o CEP da loja?"). Se a prova nao bater, nao vincula.',
  input_schema: { type: 'object', properties: {
    cliente_id: { type: 'string', description: 'id devolvido pelo buscar_cliente' },
    prova: { type: 'string', description: 'CPF/CNPJ, CEP ou telefone informado pelo cliente' },
  }, required: ['cliente_id', 'prova'] },
};

export async function buscarCliente(input: any): Promise<string> {
  const termo = String(input?.termo || '').trim();
  if (termo.length < 3) return 'Informe pelo menos 3 letras do nome, ou o CPF/CNPJ, ou o telefone com DDD.';
  const d = onlyDigits(termo);
  let rows: any[] = [];
  try {
    if (d.length === 11 || d.length === 14) {
      const r: any = await db.execute(sql`SELECT id, name, fantasy_name, company_name, cpf, cnpj, neighborhood, city, state, is_active, last_sale_date
        FROM customers WHERE regexp_replace(COALESCE(cnpj,''),'[^0-9]','','g') = ${d} OR regexp_replace(COALESCE(cpf,''),'[^0-9]','','g') = ${d} LIMIT 5`);
      rows = r.rows || [];
    }
    if (!rows.length && d.length >= 10 && d.length <= 13) {
      const id = await clientePorTelefone(d);
      const exato: any = await db.execute(sql`SELECT id FROM customers
        WHERE right(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'), 8) = ${d.slice(-8)} LIMIT 5`);
      const ids = Array.from(new Set([id, ...(exato.rows || []).map((x: any) => x.id)].filter(Boolean)));
      if (ids.length) {
        const r: any = await db.execute(sql`SELECT id, name, fantasy_name, company_name, cpf, cnpj, neighborhood, city, state, is_active, last_sale_date
          FROM customers WHERE id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) LIMIT 5`);
        rows = r.rows || [];
      }
    }
    if (!rows.length && d.length < 8) {
      const toks = norm(termo).split(/[^0-9a-z]+/).filter((t) => t.length >= 2);
      if (!toks.length) return 'Nao entendi o termo da busca.';
      const conds = toks.map((t) => sql`(
        translate(lower(COALESCE(name,'') || ' ' || COALESCE(fantasy_name,'') || ' ' || COALESCE(company_name,'') || ' ' || COALESCE(contact,'')),
          'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc') LIKE ${'%' + t + '%'})`);
      const r: any = await db.execute(sql`SELECT id, name, fantasy_name, company_name, cpf, cnpj, neighborhood, city, state, is_active, last_sale_date
        FROM customers WHERE ${sql.join(conds, sql` AND `)}
        ORDER BY COALESCE(is_active, true) DESC, last_sale_date DESC NULLS LAST LIMIT 6`);
      rows = r.rows || [];
    }
  } catch (e: any) {
    return 'Nao consegui consultar o cadastro agora (' + String(e?.message || e).slice(0, 80) + '). Siga o atendimento e, se precisar, transfira para um atendente.';
  }
  if (!rows.length) return 'Nenhum cadastro encontrado para "' + termo + '". Pergunte se o cadastro esta em outro nome (razao social, nome da loja) ou CNPJ; se for cliente novo, siga o fluxo normal.';
  const mais = rows.length > 5 ? '\n(ha mais resultados — peca um detalhe a mais, como o bairro ou o nome da loja)' : '';
  const lista = rows.slice(0, 5).map((c: any) => {
    const doc = docDe(c);
    const ult = c.last_sale_date ? new Date(c.last_sale_date).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'sem compra';
    return `- id=${c.id} | ${nomeDe(c)} | ${c.neighborhood || '-'}, ${c.city || '-'}${c.state ? '/' + c.state : ''} | doc ${mascaraDoc(doc)} | ${c.is_active === false ? 'INATIVO' : 'ativo'} | ultima compra ${ult}`;
  }).join('\n');
  return 'Cadastros encontrados (dados mascarados — confirme com o cliente qual e o dele e depois chame vincular_cliente com UMA prova: CPF/CNPJ, CEP ou telefone do cadastro):\n' + lista + mais;
}

export async function vincularCliente(input: any, ctx: any): Promise<string> {
  const id = String(input?.cliente_id || '').trim();
  const prova = onlyDigits(input?.prova);
  if (!ctx?.conversationId) return 'Sem conversa para vincular.';
  if (!id) return 'Informe o cliente_id devolvido pelo buscar_cliente.';
  if (prova.length < 8) return 'Peca ao cliente UMA prova: CPF/CNPJ completo, CEP ou o telefone que esta no cadastro.';
  const c = await lerCadastro(id);
  if (!c) return 'Cadastro nao encontrado. Rode o buscar_cliente de novo.';
  const doc = docDe(c);
  const cep = onlyDigits(c.zip_code);
  const tel = onlyDigits(c.phone);
  const confere = (doc && prova === doc)
    || (cep.length === 8 && prova === cep)
    || (prova.length >= 10 && tel.includes(prova.slice(-8)));
  if (!confere) return 'A prova informada NAO confere com esse cadastro. Nao vinculei. Pergunte de novo com gentileza (CPF/CNPJ, CEP ou telefone do cadastro) ou transfira para um atendente.';
  try { await gravarVinculo(String(ctx.conversationId), id); }
  catch (e: any) { return 'Nao consegui gravar o vinculo (' + String(e?.message || e).slice(0, 80) + ').'; }
  ctx.erpCustomerId = id;
  const bloco = await blocoCadastroCliente(id);
  return 'Conversa vinculada ao cadastro de ' + nomeDe(c) + '. A partir de agora use estes dados e NAO peca mais nada de cadastro:\n' + bloco;
}
