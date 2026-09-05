// Harness CHECKLIST DE PRODUCAO + MANUTENCAO (Flavio, 05/set/2026).
//   DATABASE_URL=postgresql://... npx tsx server/__tests__/harness-fabrica.ts
import express from 'express';
import http from 'http';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { registerFabricaRoutes } from '../fabrica-routes';
import { authenticateUser, requireRole } from '../authMiddleware';

let ok = 0, fail = 0;
const t = (nome: string, cond: boolean, extra?: any) => { if (cond) { ok++; console.log('  ✓', nome); } else { fail++; console.log('  ✗', nome, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } };
// PNG 1x1 valido
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function main() {
  for (const tb of ['production_checklist_items', 'production_checklists', 'machine_photos', 'machine_maintenances', 'machine_notes', 'machines']) await db.execute(sql.raw(`DROP TABLE IF EXISTS ${tb}`));
  await db.execute(sql`DELETE FROM users WHERE id = 'h-admin'`);
  await db.execute(sql`INSERT INTO users (id, email, first_name, last_name, role, is_active) VALUES ('h-admin', 'harness@honest.test', 'Harness', 'Admin', 'admin', true)`);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { userId: 'h-admin', userEmail: 'harness@honest.test' }; next(); });
  app.use('/api/industria', authenticateUser, requireRole(['admin']));
  registerFabricaRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (method: string, path: string, body?: any) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body instanceof FormData ? undefined : { 'content-type': 'application/json' }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    let json: any = null; let buf: Buffer | null = null;
    if (ct.includes('json')) json = await res.json().catch(() => null); else buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, json, buf, ct };
  };
  const fd = (campos: Record<string, string> = {}) => { const f = new FormData(); f.append('arquivo', new Blob([PNG], { type: 'image/png' }), 'foto.png'); for (const [k, v] of Object.entries(campos)) f.append(k, v); return f; };
  await new Promise((r) => setTimeout(r, 500));

  try {
    console.log('\n1) Checklist do dia');
    let r = await call('GET', '/api/industria/checklist/2026-09-05');
    t('dia sem checklist -> null', r.status === 200 && r.json?.checklist === null, r.json);
    r = await call('POST', '/api/industria/checklist/2026-09-05/itens', { descriptions: ['Higienização da envasadora', 'Temperatura da câmara fria', 'EPIs da equipe'] });
    t('3 itens criados (checklist criado junto)', r.status === 201 && r.json?.items?.length === 3, r.json);
    const [i1, i2] = r.json.items;
    t('item tem criado por/quando', !!i1.createdAt && i1.createdBy === 'Harness Admin', i1);
    r = await call('GET', '/api/industria/checklist/2026-09-05');
    t('GET traz checklist + 3 itens em ordem', r.json?.checklist?.date === '2026-09-05' && r.json.items.length === 3 && r.json.items[0].position === 1);
    r = await call('POST', '/api/industria/checklist/2026-09-05/itens', { description: '' });
    t('item vazio -> 400', r.status === 400);
    r = await call('GET', '/api/industria/checklist/05-09-2026');
    t('data invalida -> 400', r.status === 400);

    console.log('\n2) Registro da verificacao: hora + usuario');
    r = await call('PATCH', `/api/industria/checklist/itens/${i1.id}`, { status: 'ok' });
    t('status ok grava checkedAt/checkedBy', r.json?.item?.status === 'ok' && !!r.json.item.checkedAt && r.json.item.checkedBy === 'Harness Admin', r.json);
    r = await call('PATCH', `/api/industria/checklist/itens/${i2.id}`, { status: 'nao_conforme', notes: 'Câmara a 9°C' });
    t('nao conforme + observacao', r.json?.item?.status === 'nao_conforme' && r.json.item.notes === 'Câmara a 9°C');
    r = await call('PATCH', `/api/industria/checklist/itens/${i1.id}`, { status: 'pendente' });
    t('voltar a pendente limpa registro', r.json?.item?.checkedAt === null && r.json.item.checkedBy === null, r.json);
    r = await call('PATCH', `/api/industria/checklist/itens/${i1.id}`, { status: 'xpto' });
    t('status invalido -> 400', r.status === 400);

    console.log('\n3) Foto do item com timestamp');
    r = await call('POST', `/api/industria/checklist/itens/${i2.id}/foto`, fd());
    t('upload 200 + photoTakenAt + photoBy', r.status === 200 && r.json?.item?.hasPhoto && !!r.json.item.photoTakenAt && r.json.item.photoBy === 'Harness Admin', r.json);
    r = await call('GET', `/api/industria/checklist/itens/${i2.id}/foto`);
    t('GET foto devolve o binario', r.status === 200 && r.ct.startsWith('image/png') && r.buf!.equals(PNG), r.ct);
    r = await call('GET', '/api/industria/checklist/2026-09-05');
    t('listagem nao vaza o base64', !('photoData' in r.json.items[1]) && !('photo_data' in r.json.items[1]));
    const f2 = new FormData(); f2.append('arquivo', new Blob([Buffer.from('nao e imagem')], { type: 'text/plain' }), 'x.txt');
    r = await call('POST', `/api/industria/checklist/itens/${i2.id}/foto`, f2);
    t('arquivo nao-imagem -> 400', r.status === 400);
    r = await call('DELETE', `/api/industria/checklist/itens/${i2.id}/foto`);
    t('remover foto', r.status === 200 && (await call('GET', `/api/industria/checklist/itens/${i2.id}/foto`)).status === 404);

    console.log('\n4) Dias + copiar do dia anterior');
    r = await call('POST', '/api/industria/checklist/2026-09-06/copiar-anterior', {});
    t('copiou 3 itens de 05/09', r.status === 200 && r.json?.copiados === 3 && r.json.de === '2026-09-05', r.json);
    r = await call('POST', '/api/industria/checklist/2026-09-06/copiar-anterior', {});
    t('copiar de novo nao duplica', r.json?.copiados === 0, r.json);
    r = await call('POST', '/api/industria/checklist/2026-09-01/copiar-anterior', {});
    t('sem anterior -> 404', r.status === 404);
    r = await call('GET', '/api/industria/checklist/dias?de=2026-09-01&ate=2026-09-30');
    t('dias: 2 checklists com contagens', r.json?.dias?.length === 2 && r.json.dias.find((d: any) => d.date === '2026-09-05')?.naoConforme === 1 && r.json.dias.find((d: any) => d.date === '2026-09-05')?.total === 3, r.json);
    r = await call('PATCH', '/api/industria/checklist/2026-09-06', { notes: 'Produção de maracujá' });
    t('observacao do dia', r.status === 200 && (await call('GET', '/api/industria/checklist/2026-09-06')).json.checklist.notes === 'Produção de maracujá');
    r = await call('DELETE', `/api/industria/checklist/itens/${i1.id}`);
    t('remover item', r.status === 200 && (await call('GET', '/api/industria/checklist/2026-09-05')).json.items.length === 2);

    console.log('\n5) Maquinas');
    r = await call('POST', '/api/industria/maquinas', { name: 'Envasadora linha 1', code: 'ENV-01', sector: 'Envase', brand: 'Tetra', preventiveIntervalDays: 90, technicalData: '380V, 15kW' });
    t('criar maquina 201', r.status === 201 && r.json?.maquina?.name === 'Envasadora linha 1' && r.json.maquina.status === 'ativa', r.json);
    const maq = r.json.maquina;
    r = await call('POST', '/api/industria/maquinas', { name: '' });
    t('sem nome -> 400', r.status === 400);
    r = await call('PATCH', `/api/industria/maquinas/${maq.id}`, { status: 'manutencao', model: 'TX-200' });
    t('editar maquina', r.json?.maquina?.status === 'manutencao' && r.json.maquina.model === 'TX-200', r.json);
    r = await call('PATCH', `/api/industria/maquinas/${maq.id}`, { status: 'quebrada' });
    t('status invalido -> 400', r.status === 400);

    console.log('\n6) Manutencoes preventiva/corretiva + proxima');
    r = await call('POST', `/api/industria/maquinas/${maq.id}/manutencoes`, { type: 'preventiva', status: 'realizada', doneDate: '2026-08-01', description: 'Troca de correias', cost: '350,50' });
    t('preventiva realizada 201', r.status === 201, r.json);
    const m1 = r.json.id;
    r = await call('POST', `/api/industria/maquinas/${maq.id}/manutencoes`, { type: 'corretiva', status: 'realizada', doneDate: '2026-08-20', description: 'Sensor de nível', downtimeHours: 4 });
    t('corretiva realizada 201', r.status === 201);
    r = await call('POST', `/api/industria/maquinas/${maq.id}/manutencoes`, { type: 'preventiva', scheduledDate: '2026-11-01' });
    t('preventiva agendada 201', r.status === 201);
    const m3 = r.json.id;
    r = await call('POST', `/api/industria/maquinas/${maq.id}/manutencoes`, { type: 'corretiva' });
    t('sem data -> 400', r.status === 400);
    r = await call('GET', '/api/industria/maquinas');
    const lm = r.json.maquinas[0];
    t('lista: ultimaPreventiva 2026-08-01, ultimaCorretiva 2026-08-20', lm.ultimaPreventiva === '2026-08-01' && lm.ultimaCorretiva === '2026-08-20', lm);
    t('proximaAgendada 2026-11-01, sugerida 2026-10-30 (01/08 + 90d)', lm.proximaAgendada === '2026-11-01' && lm.proximaPreventivaSugerida === '2026-10-30', lm);
    t('contadores', lm.manutencoes === 3, lm);
    r = await call('PATCH', `/api/industria/maquinas/manutencoes/${m3}`, { status: 'realizada' });
    t('concluir agendada preenche doneDate hoje', r.status === 200);
    r = await call('GET', `/api/industria/maquinas/${maq.id}`);
    const det = r.json;
    t('detalhe: 3 manutencoes, a concluida tem doneDate', det.manutencoes.length === 3 && det.manutencoes.find((x: any) => x.id === m3).doneDate != null, det.manutencoes);
    t('custo numerico 350.5', det.manutencoes.find((x: any) => x.id === m1).cost === 350.5);

    console.log('\n7) Observacoes tecnicas + fotos (maquina e manutencao)');
    r = await call('POST', `/api/industria/maquinas/${maq.id}/observacoes`, { title: 'Inversor', content: 'Parâmetro P03 = 45Hz' });
    t('observacao 201 com autor', r.status === 201 && r.json?.observacao?.createdBy === 'Harness Admin', r.json);
    const obsId = r.json.observacao.id;
    r = await call('POST', `/api/industria/maquinas/${maq.id}/observacoes`, { content: '' });
    t('observacao vazia -> 400', r.status === 400);
    r = await call('POST', `/api/industria/maquinas/${maq.id}/fotos`, fd({ caption: 'Painel elétrico' }));
    t('foto da maquina 201 com takenAt', r.status === 201 && r.json?.foto?.caption === 'Painel elétrico' && !!r.json.foto.takenAt, r.json);
    const fotoMaq = r.json.foto.id;
    r = await call('POST', `/api/industria/maquinas/${maq.id}/fotos`, fd({ maintenanceId: m1 }));
    t('foto da manutencao 201 vinculada', r.status === 201 && r.json?.foto?.maintenanceId === m1, r.json);
    const fotoMan = r.json.foto.id;
    r = await call('GET', `/api/industria/maquinas/fotos/${fotoMaq}/arquivo`);
    t('GET foto binario', r.status === 200 && r.buf!.equals(PNG));
    r = await call('GET', `/api/industria/maquinas/${maq.id}`);
    t('detalhe: 1 obs, 2 fotos (sem base64), 1 ligada a manutencao', r.json.observacoes.length === 1 && r.json.fotos.length === 2 && !('data' in r.json.fotos[0]) && r.json.fotos.filter((f: any) => f.maintenanceId === m1).length === 1, r.json.fotos);
    r = await call('DELETE', `/api/industria/maquinas/manutencoes/${m1}`);
    t('excluir manutencao solta a foto (nao apaga)', r.status === 200 && (await call('GET', `/api/industria/maquinas/${maq.id}`)).json.fotos.find((f: any) => f.id === fotoMan)?.maintenanceId === null);
    r = await call('DELETE', `/api/industria/maquinas/observacoes/${obsId}`);
    t('excluir observacao', r.status === 200);
    r = await call('DELETE', `/api/industria/maquinas/fotos/${fotoMan}`);
    t('excluir foto', r.status === 200 && (await call('GET', `/api/industria/maquinas/fotos/${fotoMan}/arquivo`)).status === 404);
    r = await call('DELETE', `/api/industria/maquinas/${maq.id}`);
    t('excluir maquina limpa tudo', r.status === 200 && (await call('GET', '/api/industria/maquinas')).json.maquinas.length === 0);
    const cnt: any = await db.execute(sql`SELECT (SELECT COUNT(*) FROM machine_photos)::int f, (SELECT COUNT(*) FROM machine_maintenances)::int m, (SELECT COUNT(*) FROM machine_notes)::int n`);
    t('sem orfaos', cnt.rows[0].f === 0 && cnt.rows[0].m === 0 && cnt.rows[0].n === 0, cnt.rows[0]);
  } finally { server.close(); }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
