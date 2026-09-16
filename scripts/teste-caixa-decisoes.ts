// Teste de integracao da Caixa de Decisoes + Radar (sem chamar a Anthropic):
// cria as tabelas minimas que os modulos leem, popula 60 clientes com historico
// de compra, roda os sinais, materializa acoes como o Radar faria, decide por
// WhatsApp, executa (regua com clientes fixos), mede e expira.
// Rodar: DATABASE_URL=postgres://itest@localhost:5499/integra_test npx tsx scripts/teste-caixa-decisoes.ts
import { db } from '../server/db';
import { sql } from 'drizzle-orm';

let falhas = 0, ok = 0;
const check = (cond: any, msg: string) => { if (cond) { ok++; console.log('  ✓ ' + msg); } else { falhas++; console.log('  ✗ ' + msg); } };

async function raw(q: string) { return db.execute(sql.raw(q)); }

async function schemaBase() {
  await raw(`CREATE TABLE IF NOT EXISTS system_settings (key varchar PRIMARY KEY, value text, updated_by varchar, updated_at timestamptz DEFAULT now())`);
  await raw(`CREATE TABLE IF NOT EXISTS users (id varchar PRIMARY KEY, first_name varchar, last_name varchar, phone varchar, role varchar, is_active boolean DEFAULT true, updated_at timestamptz, omie_vendor_codes jsonb)`);
  await raw(`CREATE TABLE IF NOT EXISTS customers (id varchar PRIMARY KEY, name varchar, phone varchar, seller_id varchar, cnpj varchar, cpf varchar, document varchar, is_active boolean DEFAULT true, is_lead boolean DEFAULT false, city varchar)`);
  await raw(`CREATE TABLE IF NOT EXISTS billing_pipeline (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), customer_id varchar, created_at timestamptz DEFAULT now(), stage varchar)`);
  await raw(`CREATE TABLE IF NOT EXISTS billings (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), customer_document varchar, invoice_date date)`);
  await raw(`CREATE TABLE IF NOT EXISTS sales_cards (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), customer_id varchar, seller_id varchar, status varchar DEFAULT 'completed', sale_value numeric(10,2), products jsonb DEFAULT '[]'::jsonb, created_at timestamptz DEFAULT now(), campaign_id varchar, utm jsonb, attribution_kind varchar)`);
  await raw(`CREATE TABLE IF NOT EXISTS receivables (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), customer_id varchar, customer_document varchar, customer_name varchar, amount numeric, amount_paid numeric, status varchar, due_date date, issue_date date, deleted_at timestamptz, import_origin varchar, category varchar, description varchar, fiscal_invoice_id varchar, billing_pipeline_id varchar, sales_card_id varchar, omie_instance_id varchar, title_number varchar, created_at timestamptz DEFAULT now())`);
  await raw(`CREATE TABLE IF NOT EXISTS chat_customers (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), phone varchar, whatsapp_opt_out boolean DEFAULT false)`);
  await raw(`CREATE TABLE IF NOT EXISTS chat_conversations (id varchar PRIMARY KEY DEFAULT gen_random_uuid())`);
  await raw(`CREATE TABLE IF NOT EXISTS whatsapp_templates (label varchar PRIMARY KEY, umbler_id varchar, categoria varchar)`);
  await raw(`CREATE TABLE IF NOT EXISTS products (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), name varchar, price numeric, retail_price numeric, resale_goiania_price numeric, stock int, available_for_sale boolean DEFAULT true, is_active boolean DEFAULT true)`);
  await raw(`INSERT INTO products (name, price, retail_price, resale_goiania_price, stock) VALUES ('Suco de Laranja 300ml', 8, 8, 5.5, 100) ON CONFLICT DO NOTHING`);
  await raw(`DO $$ BEGIN CREATE TYPE dispatch_use_case AS ENUM ('rota_do_dia'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await raw(`CREATE TABLE IF NOT EXISTS config_global (chave text PRIMARY KEY, valor text NOT NULL)`);
  await raw(`CREATE TABLE IF NOT EXISTS agentes_config (id text PRIMARY KEY, nome text NOT NULL, modelo text NOT NULL, system_prompt text NOT NULL, ferramentas jsonb NOT NULL DEFAULT '[]'::jsonb, limites jsonb NOT NULL DEFAULT '{}'::jsonb, ativo boolean NOT NULL DEFAULT true, base_conhecimento text NOT NULL DEFAULT '', updated_at timestamp DEFAULT now())`);
  await raw(`INSERT INTO whatsapp_templates (label, umbler_id, categoria) VALUES ('recompra_reativacao','x','UTILITY'),('recompra_ciclo_furado','x','UTILITY'),('recompra_reposicao','x','MARKETING'),('recompra_mix','x','UTILITY'),('recompra_pos_primeira','x','UTILITY') ON CONFLICT DO NOTHING`);
  await raw(`INSERT INTO users (id, first_name, last_name, phone) VALUES ('v1','Gilmar','Silva','5562911110001'),('v2','Renata','Souza','5562911110002') ON CONFLICT DO NOTHING`);
  await raw(`INSERT INTO system_settings (key, value) VALUES ('telefone_gestor_relatorios','5562999990000') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
}

async function popular() {
  await raw(`DELETE FROM customers; DELETE FROM billing_pipeline; DELETE FROM sales_cards; DELETE FROM receivables; DELETE FROM chat_customers`);
  // 60 clientes: 30 com ciclo de 14 dias e ultima compra ha 50 dias (reativacao), 20 comprando certinho, 10 ciclo furado
  for (let i = 1; i <= 60; i++) {
    const id = 'c' + i, vend = i % 2 ? 'v1' : 'v2';
    await raw(`INSERT INTO customers (id, name, phone, seller_id, cnpj, is_active) VALUES ('${id}','Cliente ${i}','556299${String(100000 + i)}','${vend}','${String(10000000000000 + i)}',true)`);
    const ultimo = i <= 30 ? 50 : (i <= 50 ? 3 : 25);
    for (let k = 0; k < 6; k++) {
      const dias = ultimo + k * 14;
      await raw(`INSERT INTO billing_pipeline (customer_id, created_at) VALUES ('${id}', now() - interval '${dias} days')`);
      await raw(`INSERT INTO sales_cards (customer_id, seller_id, sale_value, products, created_at) VALUES ('${id}','${vend}', ${200 + (i % 7) * 60}, '[{"name":"Laranja"},{"name":"Uva"}]'::jsonb, now() - interval '${dias} days')`);
    }
  }
  // 2 inadimplentes e 1 opt-out entre os de reativacao
  await raw(`INSERT INTO receivables (customer_id, amount, amount_paid, status, due_date, issue_date) VALUES ('c1', 500, 0, 'vencida', current_date - 20, current_date - 50), ('c2', 300, 0, 'vencida', current_date - 10, current_date - 40)`);
  await raw(`INSERT INTO chat_customers (phone, whatsapp_opt_out) VALUES ('556299100003', true)`);
}

async function main() {
  console.log('1) schema');
  await schemaBase();
  const { ensureMktRecompraSchema } = await import('../server/mkt-recompra');
  const { ensureMktRunsSchema } = await import('../server/mkt-agent-runs');
  const { ensureMktEsteiraSchema } = await import('../server/mkt-esteira');
  const { ensureMktAcoesSchema, criarAcao, nivelEfetivo, pendentes, decidir, interpretar, responderWhatsApp, medir, expirar, panorama, listar, salvarPolitica, textoResumo } = await import('../server/mkt-acoes');
  check((await ensureMktRecompraSchema()).ok, 'recompra schema');
  check((await ensureMktRunsSchema()).ok, 'runs schema');
  check((await ensureMktEsteiraSchema()).ok, 'esteira schema');
  const s = await ensureMktAcoesSchema();
  check(s.ok, 'acoes schema ' + JSON.stringify(s.steps.filter(x => !x.ok)));
  const { garantirAgente } = await import('../server/mkt-radar');
  await garantirAgente();
  check(((await raw(`SELECT id FROM agentes_config WHERE id='mkt_radar'`)) as any).rows.length === 1, 'agente mkt_radar em agentes_config');

  console.log('2) sinais');
  await popular();
  const { lerSinais, sinaisParaPrompt, segmentoPorId } = await import('../server/mkt-sinais');
  const sin = await lerSinais();
  check(sin.base.clientes === 60, 'retrato le 60 clientes (' + sin.base.clientes + ')');
  const reat = segmentoPorId(sin, 'regua:reativacao');
  check(!!reat && reat.clientes.length === 30, 'segmento reativacao com 30 (' + reat?.clientes.length + ')');
  check(!!reat && reat.elegiveis === 27, 'elegiveis = 27 (2 inadimplentes + 1 opt-out fora) -> ' + reat?.elegiveis);
  check(reat?.categoria === 'UTILITY' && reat?.custoUnit === 0.04, 'categoria do template aprovado (UTILITY, R$0,04)');
  const furado = segmentoPorId(sin, 'regua:ciclo_furado');
  check(!!furado && furado.clientes.length === 10, 'ciclo furado com 10 (' + furado?.clientes.length + ')');
  check(sin.carteiras.length === 2, 'carteiras por vendedor (' + sin.carteiras.length + ')');
  const prompt = sinaisParaPrompt(sin);
  check(JSON.stringify(prompt).length < 20000 && !JSON.stringify(prompt).includes('"clientes":[{'), 'prompt enxuto sem lista nominal');
  check(((await raw(`SELECT COUNT(*)::int AS n FROM mkt_sinais`)) as any).rows[0].n === 1, 'snapshot gravado em mkt_sinais');

  console.log('3) politica e nivel');
  const base = { tipo: 'regua' as const, agente: 'mkt_radar', titulo: 't', justificativa: 'j', categoria: 'UTILITY' as const, custoEstimado: 1, publico: { regua: 'reativacao', clientes: reat!.clientes.filter(c => !c.optout && !c.inadimplente).slice(0, 10).map(c => ({ id: c.id, nome: c.nome })) } };
  check((await nivelEfetivo(base)).nivel === 2, 'regua nasce em N2 (humano)');
  check((await nivelEfetivo({ tipo: 'alerta', agente: 'x', titulo: 't', justificativa: '' })).nivel === 0, 'alerta e N0');
  await salvarPolitica('regua', { nivel_padrao: 1, amostra_minima: 2, taxa_aprovacao_minima: 0.5 }, 'teste');
  const n1 = await nivelEfetivo(base);
  check(n1.nivel === 2 && /observacao/.test(n1.motivo), 'N1 exige amostra de decisoes humanas: ' + n1.motivo);
  check((await nivelEfetivo({ ...base, modoTeste: true })).nivel === 2, 'modo teste forca N2');
  check((await nivelEfetivo({ ...base, categoria: 'MARKETING' })).nivel === 2, 'MARKETING exige humano');
  await salvarPolitica('regua', { nivel_padrao: 2 }, 'teste');

  console.log('4) criar, resumo, decidir por whatsapp, executar (simulado)');
  const a1 = await criarAcao({ ...base, titulo: 'Reativação — 10 clientes', modoTeste: true, receitaEsperada: 300 });
  const a2 = await criarAcao({ tipo: 'alerta', agente: 'mkt_radar', titulo: 'Carteira Renata caiu 20%', justificativa: 'x', parametros: { vendedor_id: 'v2', texto: 'oi' }, modoTeste: true });
  check(a1.status === 'proposta' && a1.nivel === 2, 'regua entra como proposta #' + a1.numero);
  check(a2.status === 'proposta', 'alerta em modo teste tambem espera (#' + a2.numero + ')');
  const pend = await pendentes();
  check(pend.length === 2, '2 pendentes');
  const texto = textoResumo(pend);
  check(texto.includes('#' + a1.numero) && texto.includes('/marketing/hoje') && texto.includes('OK 12'), 'resumo cita a acao e aponta para o Painel do dia');
  check((await responderWhatsApp('5562911119999', 'OK ' + a1.numero)) === null, 'numero desconhecido e ignorado');
  check((await responderWhatsApp('5562999990000', 'bom dia')) === null, 'conversa normal passa direto');
  check((await responderWhatsApp('5562999990000', 'ok')) === null, '"ok" sem numero passa direto');
  const r1 = await responderWhatsApp('5562999990000', 'OK ' + a1.numero + ' menos 2,5');
  check(!!r1 && /Aprovada/.test(r1), 'aprovou por WhatsApp: ' + (r1 || '').split('\n')[0]);
  const v1: any = ((await raw(`SELECT * FROM mkt_acoes WHERE numero=${a1.numero}`)) as any).rows[0];
  check(v1.status === 'executada' && v1.execucao?.simulado === true, 'modo teste: executada como simulacao');
  check(v1.publico_total === 8 && v1.decidido_via === 'whatsapp', 'tirou 2 clientes da lista (8) e registrou via whatsapp');
  const r2 = await responderWhatsApp('5562999990000', 'nao ' + a2.numero);
  check(!!r2 && /Rejeitada/.test(r2), 'rejeitou por WhatsApp');
  check(((await raw(`SELECT COUNT(*)::int AS n FROM mkt_decisoes_whatsapp`)) as any).rows[0].n === 2, 'decisoes gravadas');

  console.log('5) execucao real de regua (modo on) -> montarLote/liberarLote com clientes fixos');
  // liberarLote chama enqueueOfficialDispatch; sem canal configurado deve registrar erro por item sem lancar
  const a3 = await criarAcao({ ...base, titulo: 'Reativação real', custoEstimado: 0.4, receitaEsperada: 150 });
  const d3 = await decidir({ ids: [String(a3.numero)], decisao: 'aprovar', quem: 'teste', via: 'tela' });
  const v3: any = ((await raw(`SELECT * FROM mkt_acoes WHERE numero=${a3.numero}`)) as any).rows[0];
  check(['executada', 'erro'].includes(v3.status), 'executor de regua rodou (status ' + v3.status + ') ' + JSON.stringify(d3.execucoes[0]).slice(0, 160));
  const lotes: any = (await raw(`SELECT id, acao_id, total FROM mkt_lotes WHERE acao_id = '${v3.id}'`)) as any;
  check(lotes.rows.length === 1 && lotes.rows[0].total === 10, 'lote carimbado com acao_id e restrito aos 10 clientes (' + lotes.rows[0]?.total + ')');
  const toques: any = (await raw(`SELECT COUNT(*)::int AS n FROM mkt_fila_toques WHERE acao_id = '${v3.id}'`)) as any;
  check(toques.rows[0].n === 10, 'toques carimbados (' + toques.rows[0].n + ')');

  console.log('6) medir e expirar');
  await raw(`INSERT INTO sales_cards (customer_id, seller_id, sale_value, created_at) VALUES ('${base.publico.clientes[0].id}','v1', 250, now())`);
  await raw(`UPDATE mkt_acoes SET status='executada', executada_em = now() - interval '1 hour' WHERE numero=${a3.numero}`);
  const m = await medir();
  const v3b: any = ((await raw(`SELECT resultado, medido_em FROM mkt_acoes WHERE numero=${a3.numero}`)) as any).rows[0];
  check(m >= 1 && v3b.resultado?.pedidos === 1 && v3b.resultado?.receita === 250 && !v3b.medido_em, 'medicao parcial: 1 pedido R$250, janela ainda aberta');
  check(((await raw(`SELECT COUNT(*)::int AS n FROM sales_cards WHERE acao_id IS NOT NULL`)) as any).rows[0].n === 1, 'pedido carimbado com acao_id');
  const a4 = await criarAcao({ ...base, titulo: 'vai expirar', prazoHoras: 1 });
  await raw(`UPDATE mkt_acoes SET expira_em = now() - interval '1 minute' WHERE numero=${a4.numero}`);
  check((await expirar()) === 1, 'expirou 1');
  const p = await panorama();
  check(p.ok && p.aprovadores.includes('5562999990000') && p.politicas.length === 8, 'panorama ok');

  console.log('7) radar: materializacao sem chamar o modelo');
  // simula a resposta do modelo e valida via o mesmo caminho interno (funcao privada -> testa por rodar com chave ausente)
  const { rodar } = await import('../server/mkt-radar');
  const semChave = await rodar({ quem: 'teste', forcar: true });
  check(semChave.ok === false && /ANTHROPIC/.test(String(semChave.motivo)), 'sem chave, radar avisa e nao cria acao');
  const { aplicarResposta } = await import('../server/mkt-radar');
  const fake = { acoes: [
    { tipo: 'regua', segmento: 'regua:reativacao', regua: 'reativacao', max_clientes: 12, prioridade: 1, filtro: { ticket_min: 300 }, titulo: 'Reativar padarias de ticket alto', justificativa: '27 elegíveis' },
    { tipo: 'regua', segmento: 'regua:reativacao', regua: 'reativacao', max_clientes: 5, titulo: 'repetida', justificativa: '' },
    { tipo: 'regua', segmento: 'regua:inexistente', regua: 'x', titulo: 'inventada', justificativa: '' },
    { tipo: 'regua', segmento: 'regua:ciclo_furado', regua: 'reativacao', titulo: 'regua errada', justificativa: '' },
    { tipo: 'alerta', titulo: 'Carteira Renata Souza caiu', justificativa: 'j', alerta: { vendedor: 'Renata Souza', texto: 'Renata, 5 clientes cairam.' } },
    { tipo: 'cupom', titulo: 'tipo sem executor', justificativa: '' },
  ], leitura_do_dia: 'ok' };
  const ap = await aplicarResposta(fake, sin, true);
  check(ap.criadas.length === 2 && ap.descartadas.length === 4, 'radar: 2 validas, 4 descartadas (' + ap.descartadas.map(d => d.motivo).join(' | ') + ')');
  // Rodar 2x no mesmo dia (ou com pendencia de ontem) nao pode repetir regua, alerta nem visita.
  const apDup = await aplicarResposta({ acoes: [
    { tipo: 'regua', segmento: 'regua:reativacao', regua: 'reativacao', max_clientes: 12, titulo: 'de novo', justificativa: '' },
    { tipo: 'alerta', titulo: 'de novo', justificativa: 'j', alerta: { vendedor: 'Renata Souza', texto: 'x' } },
    { tipo: 'visita', segmento: 'regua:ciclo_furado', max_clientes: 5, titulo: 'visita 1', justificativa: '' },
    { tipo: 'visita', segmento: 'regua:ciclo_furado', max_clientes: 5, titulo: 'visita repetida', justificativa: '' },
  ] }, sin, true);
  await raw(`UPDATE mkt_acoes SET criado_em = criado_em - interval '1 day' WHERE tipo = 'visita'`);
  const apDup2 = await aplicarResposta({ acoes: [ { tipo: 'visita', segmento: 'regua:ciclo_furado', max_clientes: 5, titulo: 'visita de ontem pendente', justificativa: '' } ] }, sin, true);
  check(apDup.criadas.length === 1 && apDup.criadas[0].tipo === 'visita' && apDup.descartadas.length === 3 && apDup2.criadas.length === 0, 'radar: 2a rodada nao repete regua/alerta/visita, nem visita pendente de ontem (' + apDup.descartadas.map(d => d.motivo).join(' | ') + ')');
  const regua = ap.criadas.find(c => c.tipo === 'regua');
  const vr: any = ((await raw(`SELECT * FROM mkt_acoes WHERE numero=${regua.numero}`)) as any).rows[0];
  check(vr.publico_total <= 12 && vr.publico.clientes.every((c: any) => c.ticket >= 300) && Number(vr.custo_estimado) === Number((vr.publico_total * 0.04).toFixed(2)), 'publico filtrado por ticket, custo = n × 0,04 (' + vr.publico_total + ' clientes, R$ ' + vr.custo_estimado + ')');
  check(Number(vr.receita_esperada) > 0 && vr.evidencia.segmento === 'regua:reativacao' && vr.modo_teste === true, 'receita esperada calculada por codigo; evidencia guarda o segmento; modo teste');
  const al = ap.criadas.find(c => c.tipo === 'alerta');
  const va: any = ((await raw(`SELECT * FROM mkt_acoes WHERE numero=${al.numero}`)) as any).rows[0];
  check(va.parametros.vendedor_id === 'v2' && /Radar de Vendas/.test(va.parametros.texto), 'alerta resolve o vendedor pelo nome da carteira');

  console.log('8) sprint 2: link por peca, revisor, entrega, POSTEI, pauta do radar');
  const { linkDaPeca } = await import('../server/mkt-agente-conteudo');
  const lk = await linkDaPeca('instagram', 'margem', 'b2b');
  check(!!lk && /^IG\d{4}$/.test(lk.codigo) && /^ig-\d{8}-margem-/.test(lk.slug), 'campanha do mes + link por peca: ' + lk?.codigo + ' /r/' + lk?.slug);
  const lk2 = await linkDaPeca('instagram', 'sabor', 'b2c');
  check(!!lk2 && lk2.campanhaId === lk!.campanhaId && lk2.slug !== lk!.slug, 'segunda peca reaproveita a campanha e ganha slug proprio');
  const { TOOL_CONSULTAR_PRODUTO } = await import('../server/mkt-llm');
  const tp = await TOOL_CONSULTAR_PRODUTO.run({ termo: 'laranja' });
  check(/varejo R\$ 8,00/.test(tp) && /revenda R\$ 5,50/.test(tp), 'tool consultar_produto le o cadastro: ' + tp);
  const { criarPeca, enviarParaRevisao, verPeca } = await import('../server/mkt-esteira');
  const pc = await criarPeca({ canal: 'instagram', gancho: 'margem', titulo: '[b2b] teste', copy: 'Suco natural para a sua padaria vender mais. Fale com a gente: https://loja.bebahonest.com.br/r/' + lk!.slug, campanhaId: lk!.campanhaId, ctaTipo: 'link', ctaSlug: lk!.slug, origem: 'agente', agente: 'mkt_conteudo' });
  check(pc.ok && !!pc.id, 'peca criada com campanha');
  const rv = await enviarParaRevisao(pc.id!, 'teste');
  check(rv.ok && rv.estado === 'aguardando_aprovacao', 'revisao: regex passou, revisor IA sem chave nao bloqueia (' + rv.estado + ')');
  const pv: any = await verPeca(pc.id!);
  check(Number(pv.numero) > 0 && Array.isArray(pv.variacoes), 'peca tem numero curto (#' + pv.numero + ') e variacoes');
  const { textoDaPeca, responderPostei, entregarAprovadas, urlFoto, fotoConfere, assinarFoto } = await import('../server/mkt-entrega');
  await raw(`UPDATE mkt_pieces SET estado = 'aprovado' WHERE id = '${pc.id}'`);
  const tx = textoDaPeca({ ...pv, estado: 'aprovado' });
  check(tx.includes('POSTEI ' + pv.numero) && tx.includes(pv.copy), 'texto de entrega traz numero e copy');
  check(fotoConfere(7, assinarFoto(7)) && !fotoConfere(7, assinarFoto(8)) && /\/mkt\/foto\/7\?k=/.test(urlFoto(7)), 'foto assinada por id');
  const en = await entregarAprovadas();
  check(en.entregues + en.falhas === 1, 'entrega tentou 1 peca (sem canal: ' + en.falhas + ' falha)');
  check((await responderPostei('5562911119999', 'POSTEI ' + pv.numero)) === null, 'POSTEI de numero desconhecido e ignorado');
  const rp = await responderPostei('5562999990000', 'postei ' + pv.numero + ' https://www.instagram.com/p/abc123/');
  const pv2: any = await verPeca(pc.id!);
  check(!!rp && /publicada/.test(rp) && pv2.estado === 'publicado' && pv2.permalink === 'https://www.instagram.com/p/abc123/', 'POSTEI marca publicada com permalink');
  // pauta do radar: precisa de foto elegivel
  const { cadastrarAsset } = await import('../server/mkt-assets');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const asset = await cadastrarAsset({ url: png, tipo: 'foto', origem: 'foto_real', titulo: 'prateleira padaria', tags: { gancho: ['margem'], publico: ['b2b'], cenario: ['prateleira'] }, direitosOk: true } as any);
  check(asset.ok && !!asset.id, 'criativo cadastrado #' + asset.id);
  const sin2 = await lerSinais();
  check(sin2.conteudo.ganchosComFoto.some(g => g.gancho === 'margem' && g.publico === 'b2b'), 'sinal de conteudo enxerga gancho com foto');
  const ap2 = await aplicarResposta({ acoes: [
    { tipo: 'peca', titulo: 'Carrossel de margem para padarias', justificativa: 'gancho com foto e cota livre', peca: { gancho: 'margem', publico: 'b2b' } },
    { tipo: 'peca', titulo: 'sem foto', justificativa: '', peca: { gancho: 'giro', publico: 'b2c' } },
  ] }, sin2, false);
  check(ap2.criadas.length === 1 && ap2.descartadas.length === 1 && ap2.criadas[0].nivel === 0, 'pauta valida vira acao N0; pauta sem foto e descartada');
  const { processarAutomaticas } = await import('../server/mkt-acoes');
  await processarAutomaticas();
  const vp: any = ((await raw(`SELECT status, execucao FROM mkt_acoes WHERE numero=${ap2.criadas[0].numero}`)) as any).rows[0];
  check(vp.status === 'erro' && /modelo|chave|ANTHROPIC/i.test(String(vp.execucao?.erro || '')), 'executor de pauta chamou o agente de conteudo (sem chave -> erro registrado: ' + String(vp.execucao?.erro || '').slice(0, 60) + ')');

  const { corrigirGeografiaV2, marcaAtiva } = await import('../server/mkt-marca');
  const g1 = await corrigirGeografiaV2(); const g2 = await corrigirGeografiaV2();
  const ma: any = await marcaAtiva();
  check(g1.criou && g1.versao === 2 && !g2.criou && /Bela Vista/.test(JSON.stringify(ma)) && !/fresco em Goi/.test(JSON.stringify(ma)), 'cartao de marca v2 corrige a geografia uma unica vez');

  console.log('9) sprint 3: sugestao do ultimo pedido, contexto do atendente, analista, otimizador, dHash');
  await raw(`CREATE TABLE IF NOT EXISTS visit_agenda (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), customer_id varchar, scheduled_date date, visit_status varchar)`);
  await raw(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS fantasy_name varchar`);
  await raw(`ALTER TABLE sales_cards ADD COLUMN IF NOT EXISTS operation_type varchar, ADD COLUMN IF NOT EXISTS completed_date timestamptz, ADD COLUMN IF NOT EXISTS updated_at timestamptz`);
  const { ultimosPedidos } = await import('../server/mkt-recompra');
  const up = await ultimosPedidos(['c5', 'c6']);
  check(up.size === 2 && /2x Laranja, 2x Uva|Laranja/.test(up.get('c5') || '') === false ? /Laranja/.test(up.get('c5') || '') : true, 'ultimo pedido em uma linha: ' + up.get('c5'));
  const tq: any = (await raw(`SELECT COUNT(*)::int AS n, MIN(sugestao) AS ex FROM mkt_fila_toques WHERE sugestao IS NOT NULL`)) as any;
  check(Number(tq.rows[0]?.n) >= 10, 'sugestao do ultimo pedido gravada nos toques do lote (' + tq.rows[0]?.n + ', ex.: ' + tq.rows[0]?.ex + ')');
  await raw(`UPDATE mkt_fila_toques SET status = 'enfileirado', liberado_em = now(), sugestao = '28/08: 6x Laranja 300ml' WHERE cliente_id = 'c1' OR cliente_id = (SELECT cliente_id FROM mkt_fila_toques LIMIT 1)`);
  const alvo: any = (await raw(`SELECT cliente_id FROM mkt_fila_toques WHERE status = 'enfileirado' AND sugestao IS NOT NULL LIMIT 1`)) as any;
  const { contextoDoCliente } = await import('../server/contexto-cliente');
  const ctx = await contextoDoCliente(String(alvo.rows[0].cliente_id));
  check(/CONTATO ATIVO RECENTE/.test(ctx) && /6x Laranja 300ml/.test(ctx), 'atendente recebe o contato ativo e a sugestao no contexto');
  const { numerosDoDia, numerosDaSemana, textoSemanal, leituraDoDia } = await import('../server/mkt-analista');
  const nd = await numerosDoDia();
  check(nd.ativos === 60 && nd.vendas7d >= 0 && typeof nd.custoIaMes === 'number', 'numeros do dia (ativos ' + nd.ativos + ', vendas7d ' + nd.vendas7d + ')');
  const ns = await numerosDaSemana();
  const ts = textoSemanal(ns);
  check(/12\. ROI/.test(ts) && /1\. Vendas 7d/.test(ts), 'relatorio semanal com os 12 numeros');
  const ld = await leituraDoDia();
  check(/Leitura do dia/.test(ld) && /Positiva/.test(ld), 'leitura do dia cai nos numeros quando nao ha modelo');
  const { rodar: rodarOtim, listar: listarAprend, registrarHumano } = await import('../server/mkt-otimizador');
  const ro = await rodarOtim({ quem: 'teste' });
  check(ro.ok === false && /ANTHROPIC/.test(String(ro.motivo)), 'otimizador sem chave avisa e nao grava');
  await registrarHumano('nunca propor promoção antes das 10h', 'teste');
  const la = await listarAprend();
  check(la.length === 1 && la[0].origem === 'humano:teste', 'aprendizado humano gravado');
  const sin3 = await lerSinais();
  check(sin3.aprendizados.includes('nunca propor promoção antes das 10h'), 'aprendizado entra nos sinais do Radar');
  const { dHashDeBuffer, hashNoServidor, distancia } = await import('../server/mkt-semelhanca');
  const mod: any = await import('sharp'); const sharp = mod.default || mod;
  const img1 = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 50, b: 50 } } }).composite([{ input: await sharp({ create: { width: 30, height: 64, channels: 3, background: { r: 20, g: 20, b: 20 } } }).png().toBuffer(), left: 0, top: 0 }]).jpeg().toBuffer();
  const img2 = await sharp(img1).resize(48, 48).jpeg({ quality: 60 }).toBuffer();
  const img3 = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 50, b: 50 } } }).composite([{ input: await sharp({ create: { width: 64, height: 30, channels: 3, background: { r: 20, g: 20, b: 20 } } }).png().toBuffer(), left: 0, top: 0 }]).jpeg().toBuffer();
  const h1 = await dHashDeBuffer(img1), h2 = await dHashDeBuffer(img2), h3 = await dHashDeBuffer(img3);
  check(!!h1 && h1.length === 16 && !!h2 && distancia(h1, h2!) <= 10 && distancia(h1, h3!) > 10, 'dHash: recorte/recompressao = mesma familia (' + distancia(h1!, h2!) + ' bits), cena diferente nao (' + distancia(h1!, h3!) + ' bits)');
  const asset2 = await cadastrarAsset({ url: 'data:image/jpeg;base64,' + img1.toString('base64'), tipo: 'foto', origem: 'foto_real', titulo: 'foto jpeg', tags: { gancho: ['sabor'], publico: ['b2c'] }, direitosOk: true } as any);
  await new Promise(r => setTimeout(r, 800));
  const hs: any = (await raw(`SELECT phash FROM mkt_assets WHERE id = ${asset2.id}`)) as any;
  check(hs.rows[0]?.phash === h1, 'cadastro grava o dHash sozinho (' + hs.rows[0]?.phash + ')');

  console.log('10) sprint 4a: executores visita/cupom/sistema, auditor');
  await raw(`ALTER TABLE visit_agenda ADD COLUMN IF NOT EXISTS seller_id varchar, ADD COLUMN IF NOT EXISTS route_day varchar, ADD COLUMN IF NOT EXISTS recurrence_type varchar, ADD COLUMN IF NOT EXISTS is_virtual boolean DEFAULT false, ADD COLUMN IF NOT EXISTS customer_name varchar, ADD COLUMN IF NOT EXISTS customer_latitude numeric, ADD COLUMN IF NOT EXISTS customer_longitude numeric, ADD COLUMN IF NOT EXISTS customer_address text`);
  await raw(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS latitude numeric, ADD COLUMN IF NOT EXISTS longitude numeric, ADD COLUMN IF NOT EXISTS address text`);
  await raw(`CREATE TABLE IF NOT EXISTS coupons (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), code varchar NOT NULL, description text, discount_type varchar NOT NULL DEFAULT 'percent', discount_value numeric(10,2) NOT NULL DEFAULT 0, valid_from timestamp, valid_until timestamp, is_active boolean NOT NULL DEFAULT true, max_uses int, used_count int NOT NULL DEFAULT 0, min_order_value numeric(10,2), created_by_user_id varchar, once_per_customer boolean DEFAULT true, channels varchar DEFAULT 'todos', enabled_2_0 boolean DEFAULT false, created_at timestamp DEFAULT now())`);
  await salvarPolitica('visita', { nivel_padrao: 0 }, 'teste'); await salvarPolitica('cupom', { nivel_padrao: 0 }, 'teste'); await salvarPolitica('sistema', { nivel_padrao: 0 }, 'teste');
  const av = await criarAcao({ tipo: 'visita', agente: 'mkt_radar', titulo: 'Visitar 3 padarias que pararam', justificativa: 'ticket alto', publico: { clientes: [{ id: 'c7', nome: 'Cliente 7' }, { id: 'c9', nome: 'Cliente 9' }, { id: 'c11', nome: 'Cliente 11' }] }, parametros: { dias: 1, motivo: 'pararam de comprar' } });
  const { processarAutomaticas: pa2 } = await import('../server/mkt-acoes');
  await pa2();
  const vv: any = ((await raw(`SELECT status, execucao FROM mkt_acoes WHERE numero=${av.numero}`)) as any).rows[0];
  const nv: any = ((await raw(`SELECT COUNT(*)::int AS n FROM visit_agenda WHERE visit_status = 'pending' AND recurrence_type = 'avulsa'`)) as any).rows[0];
  check(vv.status === 'executada' && vv.execucao.agendadas === 3 && nv.n === 3, 'visita: 3 agendadas na visit_agenda (' + vv.execucao.data + ')');
  await pa2();
  const av2 = await criarAcao({ tipo: 'visita', agente: 'mkt_radar', titulo: 'repete', justificativa: '', publico: { clientes: [{ id: 'c7', nome: 'Cliente 7' }] }, parametros: { dias: 1 } });
  await pa2();
  const vv2: any = ((await raw(`SELECT execucao FROM mkt_acoes WHERE numero=${av2.numero}`)) as any).rows[0];
  check(vv2.execucao.jaTinha === 1 && vv2.execucao.agendadas === 0, 'visita: nao duplica no mesmo dia');
  const ac = await criarAcao({ tipo: 'cupom', agente: 'mkt_radar', titulo: 'Cupom 10% reativacao', justificativa: '', publico: { regua: 'reativacao', clientes: [{ id: 'c13', nome: 'Cliente 13' }, { id: 'c15', nome: 'Cliente 15' }] }, parametros: { percentual: 25, validade_dias: 14, regua: 'reativacao' } });
  await pa2();
  const vc: any = ((await raw(`SELECT status, execucao FROM mkt_acoes WHERE numero=${ac.numero}`)) as any).rows[0];
  const cp: any = ((await raw(`SELECT code, discount_value, enabled_2_0, max_uses FROM coupons ORDER BY created_at DESC LIMIT 1`)) as any).rows[0];
  check(vc.status === 'executada' && Number(cp.discount_value) === 15 && cp.enabled_2_0 === true && cp.max_uses === 2, 'cupom: criado com teto de 15% (pediu 25) e max_uses = publico (' + cp.code + ')');
  const tq2: any = ((await raw(`SELECT sugestao FROM mkt_fila_toques WHERE acao_id = '${vc ? (await raw(`SELECT id FROM mkt_acoes WHERE numero=${ac.numero}`) as any).rows[0].id : ''}' LIMIT 1`)) as any).rows[0];
  check(!!tq2 && /oferecer cupom/.test(tq2.sugestao), 'cupom: lembrete da regua leva o cupom na sugestao (' + (tq2?.sugestao || '').slice(0, 60) + ')');
  const as1 = await criarAcao({ tipo: 'sistema', agente: 'mkt_auditor', titulo: 'Aumentar lote', justificativa: '', parametros: { tipo: 'setting', chave: 'mkt_recompra_lote_max', valor: 120 } });
  const as2 = await criarAcao({ tipo: 'sistema', agente: 'mkt_auditor', titulo: 'Fora do limite', justificativa: '', parametros: { tipo: 'setting', chave: 'mkt_recompra_lote_max', valor: 9999 } });
  const as3 = await criarAcao({ tipo: 'sistema', agente: 'mkt_auditor', titulo: 'Chave proibida', justificativa: '', parametros: { tipo: 'setting', chave: 'oficial_dispatch_mode', valor: 1 } });
  const as4 = await criarAcao({ tipo: 'sistema', agente: 'mkt_auditor', titulo: 'Prompt do radar', justificativa: '', parametros: { tipo: 'prompt', agente: 'mkt_radar', system_prompt: 'Você é o Radar de Vendas. '.repeat(10), motivo: 'teste' } });
  await pa2();
  const st: any = ((await raw(`SELECT numero, status, execucao FROM mkt_acoes WHERE numero IN (${as1.numero},${as2.numero},${as3.numero},${as4.numero}) ORDER BY numero`)) as any).rows;
  const lote: any = ((await raw(`SELECT value FROM system_settings WHERE key = 'mkt_recompra_lote_max'`)) as any).rows[0];
  check(st[0].status === 'executada' && lote.value === '120', 'sistema: parametro dentro do limite aplicado (lote_max=120)');
  check(st[1].status === 'erro' && /limites/.test(st[1].execucao.erro), 'sistema: valor fora do limite recusado');
  check(st[2].status === 'erro' && /permitidos/.test(st[2].execucao.erro), 'sistema: chave fora da lista recusada');
  const pv3: any = ((await raw(`SELECT COUNT(*)::int AS n FROM mkt_prompt_versoes WHERE agente = 'mkt_radar'`)) as any).rows[0];
  const ag3: any = ((await raw(`SELECT system_prompt FROM agentes_config WHERE id = 'mkt_radar'`)) as any).rows[0];
  check(st[3].status === 'executada' && pv3.n === 1 && /Radar de Vendas\. Você/.test(ag3.system_prompt), 'sistema: prompt trocado com versao anterior guardada');
  const { checar, autocorrigir, rodar: rodarAud, textoDiagnostico } = await import('../server/mkt-auditor');
  const ch = await checar();
  const ids = ch.map(c => c.id);
  check(ch.length >= 15 && ids.includes('chave_anthropic') && ids.includes('aprovadores') && ids.includes('templates') && ids.includes('caixa_erros'), 'auditor: ' + ch.length + ' checagens (' + ch.filter(c => c.gravidade === 'alerta').length + ' alertas, ' + ch.filter(c => c.gravidade === 'atencao').length + ' atencoes)');
  check(ch.find(c => c.id === 'chave_anthropic')?.gravidade === 'alerta' && ch.find(c => c.id === 'aprovadores')?.gravidade === 'ok', 'auditor: sem chave = alerta; aprovador cadastrado = ok');
  await raw(`INSERT INTO mkt_lotes (regua, status, criado_em) VALUES ('todas', 'previsto', now() - interval '3 days')`);
  const ch2 = await checar();
  check(ch2.some(c => c.id === 'lotes_orfaos' && c.autofix === 'descartar_lotes'), 'auditor: detecta lote orfao com autofix');
  const fx = await autocorrigir(ch2);
  const lo: any = ((await raw(`SELECT COUNT(*)::int AS n FROM mkt_lotes WHERE status = 'previsto' AND criado_em < now() - interval '2 days'`)) as any).rows[0];
  check(fx.some(f => f.fix === 'descartar_lotes') && lo.n === 0, 'auditor: autocorrecao descartou o lote orfao');
  const ra = await rodarAud({ quem: 'teste' });
  const dg: any = ((await raw(`SELECT nota, checagens FROM mkt_diagnosticos ORDER BY criado_em DESC LIMIT 1`)) as any).rows[0];
  check(ra.ok && typeof ra.nota === 'number' && dg && Array.isArray(dg.checagens) && /Auditor da Central/.test(ra.texto), 'auditor: rodada grava diagnostico (nota ' + ra.nota + ') mesmo sem modelo');

  // ── Sprint 5: Instagram conectado (OAuth) + publicador ──
  const ig = await import('../server/mkt-ig-auth');
  delete process.env.IG_PAGE_TOKEN; delete process.env.IG_APP_ID; delete process.env.IG_APP_SECRET;
  await raw(`DELETE FROM system_settings WHERE key LIKE 'ig_%'`);
  check((await ig.credenciais()).origem === 'nenhuma', 'ig: sem nada = origem nenhuma');
  process.env.IG_PAGE_TOKEN = 'ENVTOKEN'; process.env.IG_BUSINESS_ID = '1784';
  const ce = await ig.credenciais();
  check(ce.origem === 'env' && ce.token === 'ENVTOKEN' && /graph\.facebook\.com/.test(ce.base) && ce.userId === '1784', 'ig: env = IG_PAGE_TOKEN em graph.facebook.com');
  check(!(await ig.urlConectar()).ok, 'ig: sem IG_APP_ID nao monta a URL');
  process.env.IG_APP_ID = '1749965846130240'; process.env.IG_APP_SECRET = 'segredo';
  const uc = await ig.urlConectar();
  const stSalvo: any = ((await raw(`SELECT value FROM system_settings WHERE key = 'ig_oauth_state'`)) as any).rows[0];
  check(uc.ok && /instagram\.com\/oauth\/authorize/.test(uc.url!) && /instagram_business_content_publish/.test(uc.url!) && /redirect_uri=https%3A%2F%2Fintegracode-production\.up\.railway\.app%2Fapi%2Fmkt%2Fig%2Fcallback/.test(uc.url!) && stSalvo && uc.url!.includes('state=' + stSalvo.value), 'ig: URL de autorizacao com escopos, redirect e state guardado');
  check(!(await ig.concluirCallback('code', 'state-errado')).ok, 'ig: callback com state errado e recusado');
  // fetch falso: troca de code, token longo, /me, e depois a Graph do publicador
  const chamadas: string[] = [];
  const fetchReal = globalThis.fetch;
  (globalThis as any).fetch = async (url: any, init?: any) => {
    const u = String(url); chamadas.push((init?.method || 'GET') + ' ' + u.split('?')[0]);
    const json = (o: any, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (u.startsWith('https://api.instagram.com/oauth/access_token')) return json({ access_token: 'CURTO', user_id: 17841400000, permissions: ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights'] });
    if (u.startsWith('https://graph.instagram.com/access_token')) return json({ access_token: 'LONGO', token_type: 'bearer', expires_in: 5184000 });
    if (u.startsWith('https://graph.instagram.com/refresh_access_token')) return json({ access_token: 'LONGO2', expires_in: 5184000 });
    if (/graph\.instagram\.com\/v[\d.]+\/me\?/.test(u)) return json({ user_id: '17841400000', username: 'bebahonest', account_type: 'BUSINESS', id: '17841400000', media_count: 42 });
    if (/\/me\/media_publish$/.test(u)) return json({ id: 'MEDIA777' });
    if (/\/me\/media$/.test(u)) { const b = String(init?.body || ''); return json({ id: /CAROUSEL/.test(b) ? 'CAR9' : 'CONT' + (chamadas.length) }); }
    if (/\/MEDIA777\?/.test(u)) return json({ permalink: 'https://www.instagram.com/p/ABC123xyz/' });
    if (/\/(CONT\d+|CAR9)\?/.test(u)) return json({ status_code: 'FINISHED' });
    return json({ error: { message: 'rota nao simulada: ' + u } }, 400);
  };
  const cb = await ig.concluirCallback('codigo123#_', stSalvo.value);
  const cl = await ig.credenciais();
  check(cb.ok && cb.username === 'bebahonest' && cl.origem === 'instagram_login' && cl.token === 'LONGO' && cl.diasRestantes! >= 59 && /graph\.instagram\.com/.test(cl.base) && cl.permissoes!.includes('instagram_business_content_publish'), 'ig: callback troca code -> token longo, guarda @, permissoes e vencimento');
  check(!(await raw(`SELECT 1 FROM system_settings WHERE key = 'ig_oauth_state'`) as any).rows.length, 'ig: state consumido (nao reutilizavel)');
  const stt = await ig.status();
  check(stt.conectado && stt.podePublicar && stt.podeInsights && !('token' in stt), 'ig: status para a tela sem expor o token');
  const rn0 = await ig.renovar();
  check(rn0.ok && !rn0.renovou, 'ig: com 60 dias nao renova a toa');
  await raw(`UPDATE system_settings SET value = '${new Date(Date.now() + 10 * 86400000).toISOString()}' WHERE key = 'ig_token_expira'`);
  const rn1 = await ig.renovar();
  check(rn1.ok && rn1.renovou && (await ig.credenciais()).token === 'LONGO2' && rn1.diasRestantes! >= 59, 'ig: faltando 10 dias renova e troca o token');
  const te = await ig.testar();
  check(te.ok && te.username === 'bebahonest' && te.mediaCount === 42, 'ig: testar chama /me com o token conectado');
  const { modoColeta } = await import('../server/mkt-posts');
  check((await modoColeta()).pronto, 'insights: modoColeta pronto com o token conectado (sem IG_BUSINESS_ID)');
  const chAud = await checar();
  check(chAud.find(c => c.id === 'instagram_token')?.gravidade === 'ok' && chAud.some(c => c.id === 'publicador_modo'), 'auditor: checa token do Instagram e modo do publicador');

  // publicador
  const pub = await import('../server/mkt-publicador');
  check((await pub.modo()) === 'test', 'publicador: nasce em teste');
  await raw(`DELETE FROM system_settings WHERE key = 'ig_permissoes'`);
  check(!(await pub.definirModo('on')).ok, 'publicador: nao liga sem a permissao de publicar');
  await raw(`INSERT INTO system_settings (key, value, updated_by) VALUES ('ig_permissoes', 'instagram_business_basic,instagram_business_content_publish', 't')`);
  check((await pub.definirModo('on')).ok && (await pub.modo()) === 'on', 'publicador: liga com token + permissao');
  await raw(`INSERT INTO mkt_assets (id, sha256, tipo, url, titulo, formato, ativo, direitos_ok) VALUES (901, 'sha901', 'foto', 'data:image/png;base64,iVBORw0KGgo=', 'foto', 'png', true, true) ON CONFLICT DO NOTHING`);
  const pp: any = ((await raw(`INSERT INTO mkt_pieces (canal, titulo, copy, gancho, estado, asset_ids) VALUES ('instagram', 'Peca IG', 'Legenda de teste #honest', 'sabor', 'aprovado', '[901]'::jsonb) RETURNING id, numero`)) as any).rows[0];
  const semFoto: any = ((await raw(`INSERT INTO mkt_pieces (canal, titulo, copy, estado, asset_ids) VALUES ('instagram', 'Sem foto', 'x', 'aprovado', '[]'::jsonb) RETURNING id`)) as any).rows[0];
  check(/sem criativo/.test((await pub.publicarPeca(semFoto.id)).erro || ''), 'publicador: recusa peca sem foto');
  chamadas.length = 0;
  const sim = await pub.publicarPeca(pp.id, { forcarModo: 'test' });
  const estSim: any = ((await raw(`SELECT estado FROM mkt_pieces WHERE id = '${pp.id}'`)) as any).rows[0];
  check(sim.ok && sim.simulado && sim.containerId && !chamadas.some(c => /media_publish/.test(c)) && estSim.estado === 'aprovado', 'publicador: em teste cria o container e NAO publica');
  chamadas.length = 0;
  const real = await pub.publicarPeca(pp.id, { quem: 'teste' });
  const pRow: any = ((await raw(`SELECT estado, external_media_id, permalink FROM mkt_pieces WHERE id = '${pp.id}'`)) as any).rows[0];
  const sp: any = ((await raw(`SELECT COUNT(*)::int AS n FROM social_posts WHERE external_media_id = 'MEDIA777'`)) as any).rows[0];
  check(real.ok && real.mediaId === 'MEDIA777' && /instagram\.com\/p\//.test(real.permalink!) && pRow.estado === 'publicado' && pRow.external_media_id === 'MEDIA777' && sp.n === 1 && chamadas.some(c => /POST .*\/me\/media$/.test(c)) && chamadas.some(c => /media_publish/.test(c)), 'publicador: em on publica, guarda media_id/permalink e registra o post');
  check(chamadas.some(c => /\/me\/media$/.test(c)) && !chamadas.some(c => /graph\.facebook\.com/.test(c)), 'publicador: usa graph.instagram.com com /me (login do Instagram)');
  const pc2: any = ((await raw(`INSERT INTO mkt_pieces (canal, titulo, copy, estado, asset_ids) VALUES ('instagram', 'Carrossel', 'Duas fotos', 'aprovado', '[901,901]'::jsonb) RETURNING id, numero`)) as any).rows[0];
  chamadas.length = 0;
  const car = await pub.publicarPeca(pc2.id, { forcarModo: 'test' });
  check(car.ok && car.containerId === 'CAR9' && chamadas.filter(c => /POST .*\/me\/media$/.test(c)).length === 3, 'publicador: 2+ fotos viram carrossel (2 filhos + 1 pai)');
  const runsPub: any = ((await raw(`SELECT COUNT(*)::int AS n FROM mkt_agent_runs WHERE agente = 'mkt_publicador'`)) as any).rows[0];
  check(runsPub.n >= 3, 'publicador: cada tentativa vira um run auditavel');
  const pvz = await pub.publicarVencidas({ slotDiario: true, quem: 'teste' });
  check(pvz.modo === "on" && pvz.publicadas + pvz.simuladas + pvz.falhas.length >= 1, 'publicador: varredura do cron pega aprovadas no slot diario');
  (globalThis as any).fetch = fetchReal;
  const { normalizarParaInstagram } = await import('../server/mkt-entrega');
  const sharpI = (await import('sharp')).default;
  const alta = await sharpI({ create: { width: 400, height: 1000, channels: 4, background: '#ff0000' } }).png().toBuffer();
  const norm = await normalizarParaInstagram(alta);
  const nm = norm ? await sharpI(norm).metadata() : null;
  check(!!nm && nm.format === 'jpeg' && Math.abs((nm.width! / nm.height!) - 0.8) < 0.01, 'foto ?ig=1: PNG 2:5 vira JPEG 4:5 com borda branca');
  const larga = await sharpI({ create: { width: 3000, height: 1000, channels: 3, background: '#00ff00' } }).jpeg().toBuffer();
  const nl = await sharpI((await normalizarParaInstagram(larga))!).metadata();
  check(nl.width! <= 1440 && Math.abs((nl.width! / nl.height!) - 1.91) < 0.02, 'foto ?ig=1: 3:1 vira 1.91:1 e cabe em 1440px');

  // ── Painel do dia ──
  const { painelDoDia } = await import('../server/mkt-hoje');
  const pd = await painelDoDia();
  check(Array.isArray(pd.pendentes) && Array.isArray(pd.rodando) && Array.isArray(pd.agentes) && pd.resumoPendentes && typeof pd.resumoPendentes.n === 'number' && pd.pecas && typeof pd.pecas.fila === 'number' && pd.modos && pd.totaisAoVivo, 'painel do dia: ' + pd.pendentes.length + ' pendente(s), ' + pd.rodando.length + ' rodando, ' + pd.agentes.length + ' agente(s), ' + pd.pecas.fila + ' peça(s) na fila');
  const exec = pd.rodando.find((r: any) => r.status === 'executada' && r.aoVivo);
  check(!!exec && typeof exec.aoVivo.pedidos === 'number' && typeof exec.aoVivo.diasCorridos === 'number', 'painel do dia: ação executada traz resultado ao vivo (' + (exec ? exec.aoVivo.pedidos + ' pedido(s), R$ ' + exec.aoVivo.receita : 'nenhuma') + ')');
  check(pd.auditor && typeof pd.auditor.nota === 'number' && pd.pecas.noAr.length >= 1, 'painel do dia: nota do auditor e peças no ar (' + pd.pecas.noAr.length + ')');

  // ── Canal por acao ──
  const { canalDaAcao } = await import('../server/mkt-canal');
  check(canalDaAcao({ tipo: 'regua' }).canal === 'whatsapp' && canalDaAcao({ tipo: 'alerta' }).canal === 'whatsapp' && canalDaAcao({ tipo: 'visita' }).canal === 'presencial' && canalDaAcao({ tipo: 'visita' }).via === 'whatsapp'
    && canalDaAcao({ tipo: 'cupom' }).canal === 'loja' && canalDaAcao({ tipo: 'peca', parametros: {} }).canal === 'instagram' && canalDaAcao({ tipo: 'anuncio', parametros: { canal: 'google' } }).canal === 'google'
    && canalDaAcao({ tipo: 'anuncio', parametros: { canal: 'facebook' } }).canal === 'facebook' && canalDaAcao({ tipo: 'sistema' }).canal === 'integra', 'canal: regra unica por tipo (whatsapp/instagram/facebook/google/loja/presencial/integra)');
  const pendC = await pendentes();
  const pd2 = await painelDoDia();
  check(pendC.every((a: any) => a.canal && a.canal_nome) && pd2.pendentes.every((a: any) => a.canal && a.canalNome), 'canal: presente em pendentes() e no painel do dia');
  const txC = textoResumo(pendC);
  check(/💬|📸|🚗|🛒|⚙️/.test(txC) && /WhatsApp|Instagram|Visita presencial|Loja online/.test(txC), 'canal: resumo do WhatsApp mostra o canal de cada acao');

  // ── Sprint 7: anuncio pago na Meta (Click-to-WhatsApp) ──
  const ads = await import('../server/mkt-meta-ads');
  delete process.env.META_AD_ACCOUNT_ID;
  check(!ads.pronto().ok && ads.pronto().falta.includes('META_AD_ACCOUNT_ID'), 'ads: sem conta = nao pronto');
  process.env.META_AD_ACCOUNT_ID = '123456'; process.env.META_ADS_TOKEN = 'ADSTOKEN'; process.env.META_PAGE_ID = '9999';
  check(ads.pronto().ok && ads.config().conta === 'act_123456', 'ads: config normaliza act_');
  await raw(`UPDATE mkt_politicas SET teto_custo_dia = 25 WHERE tipo = 'anuncio'`);
  const chamadasAds: string[] = [];
  const fetchReal2 = globalThis.fetch;
  (globalThis as any).fetch = async (url: any, init?: any) => {
    const u = String(url); const b = String(init?.body || ''); chamadasAds.push((init?.method || 'GET') + ' ' + u.split('?')[0] + (b ? ' ' + b.slice(0, 400) : ''));
    const json = (o: any, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (/act_123456\?/.test(u)) return json({ name: 'Honest Ads', currency: 'BRL', account_status: 1, amount_spent: '12345' });
    if (/act_123456\/campaigns$/.test(u)) return json({ id: 'CAMP1' });
    if (/act_123456\/adsets$/.test(u)) return b.includes('WHATSAPP') && b.includes('daily_budget=2000') ? json({ id: 'SET1' }) : json({ error: { message: 'adset ruim: ' + b.slice(0, 80) } }, 400);
    if (/act_123456\/adimages$/.test(u)) return json({ images: { 'x.jpg': { hash: 'HASH1' } } });
    if (/act_123456\/adcreatives$/.test(u)) return b.includes('WHATSAPP_MESSAGE') && b.includes('HASH1') ? json({ id: 'CR1' }) : json({ error: { message: 'creative ruim' } }, 400);
    if (/act_123456\/ads$/.test(u)) return json({ id: 'AD1' });
    if (/\/(CAMP1|SET1|AD1)$/.test(u)) return json({ success: true });
    if (/CAMP1\/insights/.test(u)) return json({ data: [{ date_start: '2026-09-15', spend: '18.50', impressions: '4200', clicks: '61', reach: '3100', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '9' }] }] });
    return json({ error: { message: 'rota nao simulada: ' + u } }, 400);
  };
  const stA = await ads.status();
  check(stA.pronto && stA.nome === 'Honest Ads' && stA.moeda === 'BRL', 'ads: status le a conta');
  const sinA = await lerSinais();
  check(sinA.anuncios.pronto && sinA.anuncios.tetoDia === 25 && sinA.anuncios.pecasCandidatas.length >= 1, 'sinais: anuncios pronto, teto 25, ' + sinA.anuncios.pecasCandidatas.length + ' peca(s) candidata(s)');
  const apA = await aplicarResposta({ acoes: [
    { tipo: 'anuncio', titulo: 'Impulsionar a peca que mais rendeu', justificativa: 'alcance organico alto', anuncio: { peca_id: sinA.anuncios.pecasCandidatas[0].id, orcamento_dia: 40, dias: 20 } },
    { tipo: 'anuncio', titulo: 'repetido', justificativa: '', anuncio: { peca_id: sinA.anuncios.pecasCandidatas[0].id, orcamento_dia: 10, dias: 3 } },
  ] }, sinA, false);
  const acA = apA.criadas.find(c => c.tipo === 'anuncio');
  const rowA: any = acA ? ((await raw(`SELECT * FROM mkt_acoes WHERE numero=${acA.numero}`)) as any).rows[0] : null;
  check(!!acA && apA.descartadas.length === 1 && rowA.parametros.orcamento_dia === 25 && rowA.parametros.dias === 7 && Number(rowA.custo_estimado) === 175 && rowA.nivel_efetivo === 2, 'radar: anuncio cortado no teto (R$ 25/dia, 7 dias = R$ 175), N2, repetido descartado');
  // modo teste: aprovar so valida a conta
  chamadasAds.length = 0;
  const decA = await decidir({ ids: [rowA.id], decisao: 'aprovar', quem: 'teste', via: 'tela' });
  const rowA2: any = ((await raw(`SELECT status, execucao FROM mkt_acoes WHERE id='${rowA.id}'`)) as any).rows[0];
  check(decA.aplicadas === 1 && rowA2.status === 'executada' && rowA2.execucao?.simulado === true && !chamadasAds.some(c => /campaigns/.test(c)), 'anuncio em modo teste: aprovado valida a conta e nao cria campanha');
  // modo on: cria tudo pausado e ativa
  await raw(`INSERT INTO system_settings (key, value, updated_by) VALUES ('mkt_ads_modo','on','t') ON CONFLICT (key) DO UPDATE SET value='on'`);
  await raw(`UPDATE mkt_acoes SET status='proposta', executada_em=NULL, execucao=NULL, decidido_em=NULL WHERE id='${rowA.id}'`);
  await raw(`UPDATE mkt_acoes SET parametros = parametros || '{"orcamento_dia":20,"dias":5}'::jsonb WHERE id='${rowA.id}'`);
  chamadasAds.length = 0;
  const decB = await decidir({ ids: [rowA.id], decisao: 'aprovar', quem: 'teste', via: 'tela' });
  const rowB: any = ((await raw(`SELECT status, execucao FROM mkt_acoes WHERE id='${rowA.id}'`)) as any).rows[0];
  const adRow: any = ((await raw(`SELECT * FROM mkt_ads WHERE acao_id='${rowA.id}'`)) as any).rows[0];
  const ordem = chamadasAds.map(c => c.replace(/^POST https:\/\/graph\.facebook\.com\/v[\d.]+\/act_123456\//, '').split(' ')[0]);
  check(decB.aplicadas === 1 && rowB.status === 'executada' && rowB.execucao?.adId && adRow && adRow.status === 'ativo' && adRow.campanha_meta_id === 'CAMP1' && adRow.ad_meta_id === 'AD1' && ordem.slice(0, 5).join(',') === 'campaigns,adsets,adimages,adcreatives,ads', 'anuncio ligado: campanha -> conjunto -> imagem -> criativo -> anuncio, tudo pausado e depois ativado (' + ordem.slice(0, 5).join(' > ') + ')');
  check(chamadasAds.some(c => /adsets .*destination_type=WHATSAPP|adsets .*WHATSAPP/.test(c)) && chamadasAds.filter(c => /\/(CAMP1|SET1|AD1) status=ACTIVE/.test(c)).length === 3, 'anuncio: destino WhatsApp e ativacao nos 3 niveis');
  const col = await ads.coletarInsights();
  const res = await ads.resultadoDoAnuncio(rowA.id);
  check(col.anuncios === 1 && col.linhas === 1 && res && res.gasto === 18.5 && res.conversas === 9 && res.cliques === 61, 'anuncio: insights viram mkt_ads_diario (gasto 18,50, 9 conversas)');
  const pdA = await painelDoDia();
  const rA = pdA.rodando.find((r: any) => r.tipo === 'anuncio');
  check(rA && rA.anuncio && rA.anuncio.conversas === 9 && rA.aoVivo && rA.aoVivo.gasto === 18.5 && rA.canal === 'facebook', 'painel: anuncio rodando com gasto/conversas ao vivo e canal facebook');
  const mA = await medir();
  const rowC: any = ((await raw(`SELECT resultado FROM mkt_acoes WHERE id='${rowA.id}'`)) as any).rows[0];
  check(mA >= 1 && rowC.resultado && rowC.resultado.conversas === 9 && rowC.resultado.gasto === 18.5, 'medir: acao de anuncio recebe resultado dos insights');
  const pz = await ads.pausar(adRow.id);
  check(pz.ok && ((await raw(`SELECT status FROM mkt_ads WHERE id='${adRow.id}'`)) as any).rows[0].status === 'pausado', 'anuncio: pausar');
  (globalThis as any).fetch = fetchReal2;

  console.log('\n' + ok + ' ok, ' + falhas + ' falha(s)');
  process.exit(falhas ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
