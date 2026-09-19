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
  // Mesmos clientes, outro tipo/outro titulo (o caso "#18 alerta gestor" x "#26 alerta vendedor" x "#17 visita"):
  // um alerta/cupom sobre os clientes da visita pendente e repeticao por publico, mesmo com chave diferente.
  const apPub = await aplicarResposta({ acoes: [
    { tipo: 'alerta', segmento: 'regua:ciclo_furado', max_clientes: 5, titulo: 'Alerta: 5 clientes parados — contato imediato', justificativa: 'j', alerta: { texto: 'gestor, olha isso' } },
    { tipo: 'cupom', segmento: 'regua:ciclo_furado', max_clientes: 5, titulo: 'Cupom para os mesmos 5', justificativa: '', cupom: { percentual: 10 } },
  ] }, sin, true);
  check(apPub.criadas.length === 0 && apPub.descartadas.length === 2 && apPub.descartadas.every(d => /publico repetido/.test(String(d.motivo))), 'radar: alerta/cupom sobre os mesmos clientes da visita pendente = publico repetido (' + apPub.descartadas.map(d => d.motivo).join(' | ') + ')');
  const { assuntoSistema } = await import('../server/mkt-auditor');
  check(assuntoSistema({ tipo: 'setting', chave: 'mkt_conteudo_cadencia_semana', valor: 3 }) === assuntoSistema({ tipo: 'setting', chave: 'mkt_conteudo_cadencia_semana', valor: 2 })
    && assuntoSistema({ tipo: 'politica', tipo_acao: 'regua', campos: { nivel_padrao: 1 } }) === 'politica:regua:nivel_padrao' && assuntoSistema({ tipo: 'prompt', agente: 'mkt_radar' }) === 'prompt:mkt_radar' && assuntoSistema({}) === null,
    'auditor: assunto da acao sistema independe do valor/titulo (cadencia 3 = cadencia 2)');
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

  // =========================================================================
  console.log('10) pos-venda da entrega: app do entregador -> WhatsApp do cliente');
  // =========================================================================
  await raw(`DO $$ BEGIN CREATE TYPE dispatch_status AS ENUM ('fila','enviada','entregue','lida','resposta','falha'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await raw(`ALTER TYPE dispatch_use_case ADD VALUE IF NOT EXISTS 'entrega'`);
  await raw(`CREATE TABLE IF NOT EXISTS official_dispatches (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), customer_id varchar, customer_phone varchar,
    template_label varchar, category varchar, use_case dispatch_use_case, params jsonb, campaign varchar, estimated_cost numeric,
    status dispatch_status DEFAULT 'fila', mode varchar, error text, sent_at timestamptz, chat_id varchar, umbler_message_id varchar,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
  await raw(`CREATE TABLE IF NOT EXISTS delivery_routes (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), route_date date, status varchar, driver_email varchar, start_time timestamptz)`);
  await raw(`CREATE TABLE IF NOT EXISTS delivery_route_stops (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), route_id varchar, sales_card_id varchar,
    customer_id varchar, order_number varchar, stop_order int, status varchar DEFAULT 'pendente')`);
  await raw(`ALTER TABLE sales_cards ADD COLUMN IF NOT EXISTS operation_type varchar DEFAULT 'venda'`);
  await raw(`ALTER TABLE sales_cards ADD COLUMN IF NOT EXISTS delivery_failure_reason varchar`);
  await raw(`ALTER TABLE billing_pipeline ADD COLUMN IF NOT EXISTS order_number varchar`);
  await raw(`ALTER TABLE billing_pipeline ADD COLUMN IF NOT EXISTS operation_type varchar`);
  await raw(`ALTER TABLE billing_pipeline ADD COLUMN IF NOT EXISTS sales_card_id varchar`);
  await raw(`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true`);
  await raw(`ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS corpo text`);
  await raw(`INSERT INTO whatsapp_templates (label, umbler_id, categoria, corpo) VALUES
      ('pedido_saiu_entrega','u1','UTILITY','Ola {{1}}, seu pedido {{2}} saiu para entrega.'),
      ('pedido_entregue','u2','UTILITY','Ola {{1}}, seu pedido {{2}} foi entregue.'),
      ('entrega_nao_realizada','u3','UTILITY','Ola {{1}}, a entrega do pedido {{2}} nao saiu. Motivo: {{3}}.'),
      ('pos_entrega_2d','u4','UTILITY','Oi, {{1}}! Seu pedido {{2}} chegou ha dois dias — deu tudo certo?')
    ON CONFLICT (label) DO NOTHING`);
  await raw(`INSERT INTO system_settings (key, value) VALUES ('oficial_dispatch_mode','on'),('oficial_entrega','on'),('oficial_templates_on','on')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const ec = await import('../server/entrega-cliente');
  await ec.ensureEntregaClienteSchema();

  // Dois clientes na rota: um com telefone (avisa) e um sem (pula, sem derrubar o resto).
  await raw(`INSERT INTO customers (id, name, phone) VALUES ('cliE1','Padaria do Ze','5562911119001'),('cliE2','Mercado Sem Fone', NULL) ON CONFLICT (id) DO UPDATE SET phone = EXCLUDED.phone`);
  await raw(`INSERT INTO sales_cards (id, customer_id, operation_type) VALUES ('scE1','cliE1','venda'),('scE2','cliE2','venda') ON CONFLICT (id) DO NOTHING`);
  await raw(`INSERT INTO billing_pipeline (id, customer_id, sales_card_id, order_number, operation_type) VALUES ('bpE1','cliE1','scE1','98765','venda') ON CONFLICT (id) DO NOTHING`);
  await raw(`INSERT INTO delivery_routes (id, route_date, status, driver_email) VALUES ('rotE1', current_date, 'rota_enviada','motorista@honest.com') ON CONFLICT (id) DO NOTHING`);
  await raw(`INSERT INTO delivery_route_stops (id, route_id, sales_card_id, customer_id, stop_order, status) VALUES
      ('stE1','rotE1','scE1','cliE1',1,'pendente'), ('stE2','rotE1','scE2','cliE2',2,'pendente') ON CONFLICT (id) DO NOTHING`);

  const ini = await ec.avisarRotaIniciada('rotE1');
  const dSaiu: any = ((await raw(`SELECT * FROM official_dispatches WHERE campaign LIKE 'card:scE1:saiu%'`)) as any).rows[0];
  check(ini.enviados === 1 && dSaiu && dSaiu.template_label === 'pedido_saiu_entrega' && dSaiu.params[0] === 'Padaria' && dSaiu.params[1] === '98765'
    && dSaiu.use_case === 'entrega' && ini.detalhes.some((d: string) => /sem telefone/.test(d)),
    'entrega: iniciar rota avisa cada cliente (nome curto + nº do pedido) e pula quem não tem telefone');

  const iniDeNovo = await ec.avisarRotaIniciada('rotE1');
  check(iniDeNovo.enviados === 0, 'entrega: iniciar a rota duas vezes não duplica o aviso');

  // Entrega efetuada: aviso agora + follow-up agendado para dois dias depois, às 10h BRT.
  await raw(`UPDATE delivery_route_stops SET status='efetuada' WHERE id='stE1'`);
  const efe = await ec.avisarEntregaEfetuada('stE1', new Date('2026-09-19T14:00:00Z'));
  const dEnt: any = ((await raw(`SELECT * FROM official_dispatches WHERE campaign='card:scE1:entregue'`)) as any).rows[0];
  const dPos: any = ((await raw(`SELECT * FROM official_dispatches WHERE campaign='card:scE1:pos2d'`)) as any).rows[0];
  const quando = dPos && new Date(dPos.scheduled_at).toISOString();
  check(efe.agora.startsWith('enfileirado') && dEnt.template_label === 'pedido_entregue'
    && dPos && dPos.status === 'fila' && quando === '2026-09-21T13:00:00.000Z',
    'entrega: efetuada avisa na hora e agenda o "deu tudo certo?" para 2 dias depois, 10h de Brasília (' + quando + ')');

  // A fila só pega o que já venceu: o follow-up não pode sair antes da hora.
  const naFila: any = await raw(`SELECT count(*)::int n FROM official_dispatches WHERE status='fila'
    AND (scheduled_at IS NULL OR scheduled_at <= now())`);
  const agendados: any = await raw(`SELECT count(*)::int n FROM official_dispatches WHERE status='fila' AND scheduled_at > now()`);
  check(agendados.rows[0].n === 1 && naFila.rows[0].n >= 1, 'entrega: follow-up fica esperando a data; o resto da fila continua saindo');

  // Devolução: avisa e cancela o follow-up que estava agendado para aquele pedido.
  await raw(`UPDATE delivery_route_stops SET status='devolvida' WHERE id='stE1'`);
  await raw(`UPDATE sales_cards SET delivery_failure_reason='customer_absent' WHERE id='scE1'`);
  const dev = await ec.avisarEntregaDevolvida('stE1', 'ninguem no local');
  const dDev: any = ((await raw(`SELECT * FROM official_dispatches WHERE campaign LIKE 'card:scE1:devolvida%'`)) as any).rows[0];
  const posDepois: any = ((await raw(`SELECT status, error FROM official_dispatches WHERE campaign='card:scE1:pos2d'`)) as any).rows[0];
  check(dev.startsWith('enfileirado') && dDev.template_label === 'entrega_nao_realizada' && dDev.params.length === 3 && dDev.params[2] === 'ninguem no local'
    && posDepois.status === 'falha' && /devolvido/.test(String(posDepois.error)),
    'entrega: devolução avisa com o motivo e cancela o follow-up daquele pedido');

  // Template novo (tom leve) assume assim que a Meta aprova, sem mexer em código.
  await raw(`INSERT INTO whatsapp_templates (label, umbler_id, categoria, corpo) VALUES ('entrega_saiu','u9','UTILITY','Oi, {{1}}! Seu pedido {{2}} saiu para entrega.') ON CONFLICT (label) DO UPDATE SET umbler_id='u9'`);
  const esc = await ec.escolherTemplate('saiu');
  await raw(`UPDATE whatsapp_templates SET is_active = false WHERE label='entrega_saiu'`);
  const escOff = await ec.escolherTemplate('saiu');
  check(esc?.label === 'entrega_saiu' && esc.novo === true && escOff?.label === 'pedido_saiu_entrega' && escOff.novo === false,
    'entrega: usa o template novo quando aprovado e cai no antigo enquanto não está');

  // Variante '_u': só assume se a Meta classificou como UTILITY. Reclassificada
  // como MARKETING, é ignorada — o sistema nunca "força" categoria.
  await raw(`UPDATE whatsapp_templates SET is_active = true WHERE label='entrega_saiu'`);
  await raw(`INSERT INTO whatsapp_templates (label, umbler_id, categoria, corpo) VALUES ('entrega_saiu_u','u10','MARKETING','Oi, {{1}}! O pedido {{2}} saiu.') ON CONFLICT (label) DO UPDATE SET categoria='MARKETING'`);
  const escMkt = await ec.escolherTemplate('saiu');
  await raw(`UPDATE whatsapp_templates SET categoria='UTILITY' WHERE label='entrega_saiu_u'`);
  const escUtil = await ec.escolherTemplate('saiu');
  check(escMkt?.label === 'entrega_saiu' && escUtil?.label === 'entrega_saiu_u',
    'entrega: variante _u só entra se a Meta aprovar como UTILITY (se vier MARKETING, é ignorada)');

  const rec = await import('../server/mkt-recompra');
  await raw(`UPDATE whatsapp_templates SET categoria='MARKETING' WHERE label='recompra_reativacao'`);
  const rOrig = await rec.rotuloEfetivo('recompra_reativacao');
  await raw(`INSERT INTO whatsapp_templates (label, umbler_id, categoria) VALUES ('recompra_reativacao_u','u11','UTILITY') ON CONFLICT (label) DO NOTHING`);
  const rU = await rec.rotuloEfetivo('recompra_reativacao');
  check(rOrig.label === 'recompra_reativacao' && rOrig.categoria === 'MARKETING'
    && rU.label === 'recompra_reativacao_u' && rU.categoria === 'UTILITY',
    'régua: troca para a variante UTILITY quando ela existe (R$ 0,04 em vez de R$ 0,34)');

  // =========================================================================
  console.log('11) painel de atendimento digital: tudo que trocamos com cliente');
  // =========================================================================
  await raw(`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS customer_id varchar`);
  await raw(`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS customer_phone varchar`);
  await raw(`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS last_inbound_channel varchar`);
  await raw(`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS window_open_until timestamptz`);
  await raw(`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT (now() AT TIME ZONE 'UTC')`);
  await raw(`CREATE TABLE IF NOT EXISTS chat_messages (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id varchar,
    sender_id varchar, sender_type varchar, content text, created_at timestamp DEFAULT (now() AT TIME ZONE 'UTC'))`);
  await raw(`CREATE TABLE IF NOT EXISTS social_metrics (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), post_id varchar, data date,
    alcance int, impressoes int, curtidas int, comentarios int, salvos int, compartilhamentos int, cliques_link int, novos_seguidores int)`);

  const hojeBRt = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  // Duas conversas: uma do WhatsApp oficial e uma do Instagram Direct.
  await raw(`INSERT INTO chat_conversations (id, customer_id, customer_phone, last_inbound_channel, window_open_until)
      VALUES ('cvW','cliE1','5562911119001','oficial_1841', now() + interval '10 hours'),
             ('cvI','cliE1','ig:17841400000','instagram', NULL)
      ON CONFLICT (id) DO NOTHING`);
  // Cliente escreve 3x; a IA responde 2x (uma 4 min depois), o humano 1x, o sistema 1x.
  const T = (min: number) => `(now() AT TIME ZONE 'UTC') - interval '${min} minutes'`;
  await raw(`INSERT INTO chat_messages (conversation_id, sender_id, sender_type, content, created_at) VALUES
      ('cvW','cli','customer','oi',              ${T(60)}),
      ('cvW','agent:sdr','system','ola!',        ${T(56)}),
      ('cvW','cli','customer','quero repor',     ${T(40)}),
      ('cvW','u1','agent','ja te mando',         ${T(30)}),
      ('cvW','system','system','aviso',          ${T(20)}),
      ('cvI','cli','customer','oi pelo direct',  ${T(50)}),
      ('cvI','agent:instagram','system','oi!',   ${T(48)})`);
  await raw(`INSERT INTO mkt_agent_runs (agente, gatilho, canal, modelo, custo_brl, duracao_ms, sucesso)
      VALUES ('sdr','chat','whatsapp','x',0.12,900,true), ('sdr','chat','whatsapp','x',0.08,1100,false)`);
  await raw(`INSERT INTO social_metrics (post_id, data, alcance, curtidas, comentarios) VALUES
      ('p1','${hojeBRt}'::date, 900, 40, 5), ('p1','${hojeBRt}'::date - 1, 500, 20, 2), ('p2','${hojeBRt}'::date, 300, 10, 1)`);
  await raw(`INSERT INTO mkt_ads_diario (ad_id, data, gasto, impressoes, cliques, conversas, alcance)
      VALUES ('${adRow.id}','${hojeBRt}'::date, 20, 1000, 50, 4, 800) ON CONFLICT (ad_id, data) DO NOTHING`);

  const { resumoDigital } = await import('../server/painel-atendimento-digital');
  const dig = await resumoDigital(hojeBRt, hojeBRt);

  check(dig.mensagens.recebidas === 3 && dig.mensagens.enviadas === 4 && dig.mensagens.ia === 2
    && dig.mensagens.humano === 1 && dig.mensagens.sistema === 1 && dig.mensagens.conversas === 2,
    'digital: separa recebidas de enviadas e quem enviou (IA/humano/sistema)');

  const cW = dig.porCanal.find(c => c.canal === 'whatsapp_1841');
  const cI = dig.porCanal.find(c => c.canal === 'instagram');
  check(cW?.recebidas === 2 && cW?.enviadas === 3 && cI?.recebidas === 1 && cI?.enviadas === 1,
    'digital: canal vem da conversa — WhatsApp oficial e Instagram Direct separados');

  // 3 respostas a mensagem do cliente: IA 4 min, humano 10 min, IA 2 min => média 16/3
  check(dig.mensagens.respostas === 3 && dig.mensagens.respostasIa === 2 && dig.mensagens.pctIa === 66.7
    && dig.mensagens.tempoRespostaIaMin === 3 && dig.mensagens.tempoRespostaHumanoMin === 10,
    'digital: tempo de resposta separa IA de humano (IA ' + dig.mensagens.tempoRespostaIaMin + ' min, humano ' + dig.mensagens.tempoRespostaHumanoMin + ' min)');

  check(dig.janela24h.abertas === 1 && dig.janela24h.conversasOficiais === 1,
    'digital: conta a janela de 24 h aberta (mensagem grátis)');

  // Instagram é cumulativo por post: vale a ÚLTIMA leitura, não a soma dos dias.
  check(dig.instagram.alcance === 1200 && dig.instagram.curtidas === 50 && dig.instagram.posts === 2,
    'digital: Instagram usa a última leitura de cada post (900+300), não a soma dos dias (' + dig.instagram.alcance + ')');

  check(dig.ads.gasto === 20 && dig.ads.conversas === 4 && dig.ads.custoPorConversa === 5,
    'digital: anúncios somam por dia e calculam o custo por conversa (R$ 5,00)');

  const sdr = dig.ia.porAgente.find(a => a.agente === 'sdr');
  check(sdr?.execucoes === 2 && sdr?.erros === 1 && sdr?.custo === 0.2 && dig.ia.erros >= 1,
    'digital: execuções, erros e custo dos agentes de IA, por agente');

  // Um disparo sai de verdade: só aí ele entra em "enviados" e no bloco de entrega.
  await raw(`UPDATE official_dispatches SET status='enviada'::dispatch_status, sent_at = (now() AT TIME ZONE 'UTC')
      WHERE template_label = 'pedido_saiu_entrega'`);
  const dig2 = await resumoDigital(hojeBRt, hojeBRt);
  const tplSaiu = dig2.disparos.porTemplate.find(t => t.template === 'pedido_saiu_entrega');
  check(dig2.disparos.enviados === 1 && dig2.disparos.fila === 2 && tplSaiu?.enviados === 1
    && dig2.entregas.saiu === 1 && dig2.entregas.agendados >= 2 && dig2.disparos.custo === 0.04,
    'digital: disparo enviado entra no total e no bloco de entrega; o que está na fila não conta como enviado');

  const hojeSerie = dig.serie.find(s => s.dia === hojeBRt);
  check(dig.serie.length === 1 && hojeSerie?.recebidas === 3 && hojeSerie?.enviadas === 4,
    'digital: série por dia fecha com os totais');

  // Custo e retorno por ação: uma régua medida (voltou 3×) e uma ainda medindo.
  await raw(`INSERT INTO mkt_acoes (numero, tipo, agente, titulo, status, custo_estimado, receita_esperada,
        executada_em, resultado, medido_em, publico_total, modo_teste)
      VALUES (901,'regua','mkt_radar','Régua medida','executada', 4.00, 500,
              now() - interval '10 days', '{"clientes":6,"pedidos":8,"receita":900,"custo":3.20}'::jsonb,
              now() - interval '1 day', 80, false),
             (902,'visita','mkt_radar','Visita ainda medindo','executada', 0, 1200,
              now() - interval '2 days', NULL, NULL, 5, false)`);
  await raw(`INSERT INTO mkt_fila_toques (lote_id, regua, cliente_id, telefone, template_label, custo_estimado, status, acao_id)
      SELECT 'lx','reativacao','cliE1','5562911119001','recompra_reativacao', 0.04,
             CASE WHEN g <= 80 THEN 'enfileirado' ELSE 'bloqueado' END,
             (SELECT id FROM mkt_acoes WHERE numero = 901)
        FROM generate_series(1, 90) g`);
  const digA = await resumoDigital(hojeBRt, hojeBRt);
  const a901 = digA.acoes.lista.find(a => a.numero === 901);
  const a902 = digA.acoes.lista.find(a => a.numero === 902);
  check(a901 && a901.custo === 3.2 && a901.receita === 900 && a901.retorno === 281.3 && a901.enviados === 80 && a901.fechado === true,
    'ações: custo real (só os toques que saíram), receita medida e retorno por ação (' + a901?.retorno + '×)');
  check(a902 && a902.receita === null && a902.retorno === null && a902.receitaEsperada === 1200 && a902.fechado === false,
    'ações: a que ainda mede aparece sem receita, mostrando só o esperado');
  // Os totais somam TODAS as ações da janela (o teste já criou outras antes), então
  // o que se verifica aqui é a invariante da conta, não um número absoluto.
  const medidas = digA.acoes.lista.filter(a => a.receita != null);
  const custoDasMedidas = medidas.reduce((t, a) => t + a.custo, 0);
  const receitaTot = medidas.reduce((t, a) => t + (a.receita || 0), 0);
  check(digA.acoes.medidas === medidas.length && digA.acoes.medidas + digA.acoes.medindo === digA.acoes.total
    && Math.abs(digA.acoes.receita - receitaTot) < 0.01
    && digA.acoes.retorno === Math.round((receitaTot / custoDasMedidas) * 10) / 10
    && custoDasMedidas < digA.acoes.custo,
    'ações: o retorno divide a receita medida pelo custo DAS MEDIDAS, não pelo custo total (' + digA.acoes.retorno + '×)');
  const tipoRegua = digA.acoes.porTipo.find(t => t.tipo === 'regua');
  const tipoVisita = digA.acoes.porTipo.find(t => t.tipo === 'visita');
  check(!!tipoRegua && tipoRegua.receita >= 900 && tipoRegua.retorno != null
    && !!tipoVisita && tipoVisita.retorno === null
    && digA.acoes.porTipo.reduce((t, x) => t + x.acoes, 0) === digA.acoes.total,
    'ações: quebra por tipo soma o total; tipo sem custo (visita) fica sem múltiplo de retorno');

  const vazio = await resumoDigital('2020-01-01', '2020-01-02');
  check(vazio.mensagens.total === 0 && vazio.disparos.enviados === 0 && vazio.serie.length === 2
    && vazio.mensagens.tempoRespostaMin === null,
    'digital: período sem movimento devolve zeros, não quebra');

  // =========================================================================
  console.log('12) ensaio geral: roda todas as rotinas e relata passo a passo');
  // =========================================================================
  const { rodarEnsaio } = await import('../server/mkt-ensaio');
  const ens = await rodarEnsaio({ enviar: false, quem: 'teste' });

  check(ens.resumo.total >= 20 && ens.passos.every(p => ['ok', 'falhou', 'pulado'].includes(p.estado))
    && ens.passos.every(p => p.detalhe.length > 0),
    'ensaio: percorre as rotinas e cada passo diz o que aconteceu (' + ens.resumo.total + ' passos: '
      + ens.resumo.ok + ' ok, ' + ens.resumo.pulado + ' pulados, ' + ens.resumo.falhou + ' falhas)');

  const grupos = Array.from(new Set(ens.passos.map(p => p.grupo)));
  check(['Infra', 'Agentes', 'Caixa', 'Régua', 'Conteúdo', 'Entrega', 'Atendimento', 'Painéis', 'Fechamento'].every(g => grupos.includes(g)),
    'ensaio: cobre infraestrutura, agentes, caixa, régua, conteúdo, entrega, atendimento, painéis e fechamento');

  check(ens.modo.startsWith('seco'), 'ensaio: modo seco por padrão — não dispara mensagem sem pedido explícito');

  // O passo da Caixa tem que ter exercitado o ciclo inteiro de verdade.
  const pAlerta = ens.passos.find(p => /Alerta ao vendedor/.test(p.passo));
  check(pAlerta?.estado === 'ok' && /proposta → aprovada →/.test(pAlerta.detalhe),
    'ensaio: alerta percorre proposta → aprovada → executada (' + pAlerta?.detalhe?.slice(0, 70) + ')');
  const pExpira = ens.passos.find(p => /expira sozinha/.test(p.passo));
  const pRejeita = ens.passos.find(p => /Rejeitar uma proposta/.test(p.passo));
  check(pExpira?.estado === 'ok' && pRejeita?.estado === 'ok',
    'ensaio: prova a rejeição e a expiração automática');

  // O rastro TEM que ficar: é olhando o painel encher que se vê a Central funcionando.
  const rastro: any = ((await raw(`SELECT count(*)::int AS n FROM mkt_acoes WHERE titulo LIKE '[ensaio]%'`)) as any).rows[0];
  const idRodada = (ens.passos.find(p => /Rastro preservado/.test(p.passo))?.detalhe || '').match(/ens-\d+/)?.[0];
  check(rastro.n > 0 && !!idRodada && ens.passos.some(p => /Rastro preservado/.test(p.passo)),
    'ensaio: o rastro fica no banco e aparece no painel (' + rastro.n + " ação(ões), rodada " + idRodada + ')');

  // E a marca da rodada permite apagar tudo depois, de uma vez.
  const { limparEnsaio } = await import('../server/mkt-ensaio');
  const lp = await limparEnsaio(String(idRodada));
  const depoisLimpeza: any = ((await raw(`SELECT count(*)::int AS n FROM mkt_acoes WHERE titulo LIKE '%${idRodada}%'`)) as any).rows[0];
  check(lp.removidos > 0 && depoisLimpeza.n === 0,
    'ensaio: limpar por id apaga só aquela rodada (' + lp.removidos + ' registro(s))');

  // Rastreamento de entrega: o estado que o Umbler devolve vira nosso status.
  const { traduzirEstado } = await import('../server/official-entrega');
  check(traduzirEstado('Read') === 'lida' && traduzirEstado('Delivered') === 'entregue'
    && traduzirEstado('Sent') === 'enviada' && traduzirEstado('Failed') === 'falha'
    && traduzirEstado('Sending') === null && traduzirEstado('') === null,
    'entrega: MessageState do Umbler vira status (lida/entregue/enviada/falha; "enviando" não mexe)');

  const { ensureEntregaSchema, panoramaEntrega } = await import('../server/official-entrega');
  await ensureEntregaSchema();
  await raw(`UPDATE official_dispatches SET status='entregue'::dispatch_status, delivered_at = now(), sent_at = now() - interval '40 seconds'
             WHERE template_label = 'pedido_saiu_entrega'`);
  const pe = await panoramaEntrega(7);
  check(pe.entregues >= 1 && pe.pctEntrega !== null && pe.segundosAteEntrega !== null,
    'entrega: painel mostra quantas chegaram, a taxa e o tempo até a entrega (' + pe.pctEntrega + '%, ' + pe.segundosAteEntrega + 's)');

  console.log('\n' + ok + ' ok, ' + falhas + ' falha(s)');
  process.exit(falhas ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
