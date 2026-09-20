// client/src/pages/PainelComunicacao.tsx
// -----------------------------------------------------------------------------
// PAINEL DE COMUNICAÇÃO
//
// Uma linha por cliente ativo. À esquerda, quem ele é e o que já aconteceu:
// tipo, atendimento, vendedor, última compra, débito vencido, última mensagem
// da Central e se ele respondeu. À direita, uma coluna por TIPO DE MENSAGEM,
// com uma caixinha em cada célula.
//
// O fluxo é: filtra → marca as caixinhas do tipo que quer mandar → clica em
// enviar. Cada tipo vira um lote separado, porque cada tipo tem template,
// custo e agente de atendimento diferentes.
//
// A tela NÃO manda nada sozinha e NÃO tem "enviar para todos do filtro": o que
// sai é exatamente o que está marcado, e a lista marcada vai explícita para o
// servidor. Filtro mal montado não pode virar mil mensagens.
// -----------------------------------------------------------------------------
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import {
  Loader2, RefreshCw, Search, Send, AlertTriangle, CheckCircle2, MessageSquare,
  Clock, X, Users, CircleDollarSign,
} from 'lucide-react';

type Cliente = {
  id: string; nome: string; contato: string | null; telefone: string | null; cidade: string | null;
  tipo: 'consumidor' | 'revendedor'; atendimento: 'virtual' | 'presencial'; ativo: boolean;
  vendedorId: string | null; vendedor: string | null;
  ultimaCompra: string | null; ultimaCompraValor: number | null; diasSemCompra: number | null;
  debitoTotal: number; debitoTitulos: number; debitoVencimento: string | null; debitoDiasAtraso: number;
  ultimaInteracao: string | null; ultimoTemplate: string | null; ultimoTipo: string | null;
  ultimoStatus: string | null; recebida: boolean; respondeu: boolean; totalMensagens: number;
};
type Tipo = {
  id: string; nome: string; descricao: string; templateLabel: string; useCase: string;
  exigeDebito?: boolean; diasSemCompraMinimo?: number;
  templateUsado: string; categoria: string; cadastrado: boolean; aprovado: boolean; ativo: boolean;
  casoLigado: boolean; modo: string; corpoSugerido: string | null;
  custoUnitario: number; pendencia: string | null;
};
type Resposta = {
  itens: Cliente[];
  resumo: {
    clientes: number; deUmTotalDe: number; comDebito: number; debitoTotal: number;
    debitoVivoGeral: number; clientesComDebitoGeral: number; debitoForaDaLista: number;
    nuncaContatados: number; responderam: number; semRespostaNoUltimo: number;
    consumidores: number; revendedores: number;
  };
  opcoes: { vendedores: { id: string; nome: string; clientes: number }[]; cidades: { cidade: string; clientes: number }[] };
  tipos: Tipo[];
};
type Evento = {
  quando: string; especie: 'disparo' | 'cliente' | 'ia' | 'humano';
  titulo: string | null; tipo: string | null; status: string | null;
  recebida: boolean | null; lida: boolean | null; custo: number; erro: string | null;
  modo: string | null; texto: string | null;
};

const fmtBRL = (v: number | null) =>
  v == null ? '—' : (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDia = (v: string | null) => (v ? String(v).slice(0, 10).split('-').reverse().join('/') : '—');
const fmtDataHora = (v: string) => new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** O estado da última mensagem, em palavra que se lê sem manual. */
function selo(c: Cliente) {
  if (!c.ultimaInteracao) return { txt: 'nunca contatado', cor: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300' };
  if (c.respondeu) return { txt: 'respondeu', cor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' };
  if (c.ultimoStatus === 'falha') return { txt: 'falhou', cor: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' };
  if (c.ultimoStatus === 'lida') return { txt: 'leu, não respondeu', cor: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' };
  if (c.recebida) return { txt: 'chegou, sem resposta', cor: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' };
  return { txt: 'enviada', cor: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300' };
}

/** Um tipo de mensagem pode ou não fazer sentido para um cliente. */
function permitido(t: Tipo, c: Cliente): string | null {
  if (!c.telefone) return 'cliente sem telefone cadastrado';
  if (t.exigeDebito && c.debitoTotal <= 0) return 'sem débito vencido';
  if (t.diasSemCompraMinimo && (c.diasSemCompra == null || c.diasSemCompra < t.diasSemCompraMinimo))
    return `comprou há menos de ${t.diasSemCompraMinimo} dias`;
  return null;
}

export default function PainelComunicacao() {
  const [vendedor, setVendedor] = useState('');
  const [tipoCliente, setTipoCliente] = useState('');
  const [atendimento, setAtendimento] = useState('');
  const [debito, setDebito] = useState('');
  const [respondeu, setRespondeu] = useState('');
  const [contatada, setContatada] = useState('');
  const [cidade, setCidade] = useState('');
  const [diasMin, setDiasMin] = useState('');
  const [diasMax, setDiasMax] = useState('');
  const [busca, setBusca] = useState('');
  const [incluirInativos, setIncluirInativos] = useState(false);

  // selecao[tipoId] = conjunto de clientes marcados naquela coluna
  const [selecao, setSelecao] = useState<Record<string, Set<string>>>({});
  const [enviando, setEnviando] = useState('');
  const [recibo, setRecibo] = useState<any>(null);
  const [detalhe, setDetalhe] = useState<Cliente | null>(null);

  const qs = new URLSearchParams({
    vendedor, tipoCliente, atendimento, debito, respondeu, contatada, cidade,
    diasSemCompraMin: diasMin, diasSemCompraMax: diasMax, busca,
    incluirInativos: incluirInativos ? '1' : '',
  }).toString();
  const url = `/api/gestao/comunicacao?${qs}`;
  const { data, isLoading, isFetching, refetch, error } = useQuery<Resposta>({ queryKey: [url] });

  const itens = data?.itens || [];
  const tipos = data?.tipos || [];

  const marcados = useMemo(() => {
    const t: Record<string, number> = {}; let total = 0;
    for (const [k, v] of Object.entries(selecao)) { t[k] = v.size; total += v.size; }
    return { porTipo: t, total };
  }, [selecao]);

  const custoPrevisto = useMemo(
    () => tipos.reduce((a, t) => a + (marcados.porTipo[t.id] || 0) * (t.custoUnitario || 0), 0),
    [tipos, marcados],
  );

  function alternar(tipoId: string, clienteId: string) {
    setSelecao((s) => {
      const atual = new Set(s[tipoId] || []);
      atual.has(clienteId) ? atual.delete(clienteId) : atual.add(clienteId);
      return { ...s, [tipoId]: atual };
    });
  }
  /** Marca/desmarca a coluna inteira, só nas linhas em que aquele tipo cabe. */
  function alternarColuna(t: Tipo) {
    const elegiveis = itens.filter((c) => !permitido(t, c)).map((c) => c.id);
    setSelecao((s) => {
      const atual = s[t.id] || new Set<string>();
      const todosMarcados = elegiveis.length > 0 && elegiveis.every((id) => atual.has(id));
      return { ...s, [t.id]: todosMarcados ? new Set<string>() : new Set(elegiveis) };
    });
  }

  async function enviar(t: Tipo) {
    const ids = Array.from(selecao[t.id] || []);
    if (!ids.length) return;
    const ok = window.confirm(
      `Enviar "${t.nome}" para ${ids.length} cliente(s)?\n\n` +
      `Template: ${t.templateUsado} (${t.categoria})\n` +
      `Custo estimado: ${fmtBRL(ids.length * t.custoUnitario)}\n` +
      (t.modo === 'test'
        ? `\nATENÇÃO: a fila está em MODO TESTE para "${t.useCase}". As mensagens vão para os telefones de ensaio, NÃO para os clientes.\n`
        : '') + `\n` +
      `As mensagens entram na fila do 1841 e ainda passam pelas travas dela ` +
      `(modo, teto diário, horário comercial, opt-out).`,
    );
    if (!ok) return;
    setEnviando(t.id);
    try {
      const r = await apiRequest('POST', '/api/gestao/comunicacao/enviar', { tipo: t.id, clientes: ids });
      setRecibo({ tipo: t, ...r });
      setSelecao((s) => ({ ...s, [t.id]: new Set<string>() }));
      refetch();
    } catch (e: any) {
      setRecibo({ tipo: t, erro: String(e?.message || e) });
    } finally {
      setEnviando('');
    }
  }

  const campo = 'text-sm border rounded-lg px-2 py-1.5 bg-white dark:bg-gray-900 dark:border-gray-700';

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <MessageSquare className="w-6 h-6 text-teal-600" /> Painel de Comunicação
          </h1>
          <p className="text-sm text-gray-500">
            Todo cliente ativo, o que a Central já falou com ele, e de onde sai a próxima mensagem.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} className="px-3 py-1.5 text-sm border rounded-lg flex items-center gap-2 dark:border-gray-700">
            {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Atualizar
          </button>
          <BackToDashboardButton />
        </div>
      </div>

      {/* ---------------------------------------------------------------- KPIs */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          {[
            { t: 'Clientes na lista', v: String(data.resumo.clientes), s: `de ${data.resumo.deUmTotalDe} ativos`, i: <Users className="w-4 h-4" /> },
            { t: 'Débito vencido na lista', v: fmtBRL(data.resumo.debitoTotal),
              s: data.resumo.debitoForaDaLista > 0.5
                ? `${data.resumo.comDebito} clientes · ${fmtBRL(data.resumo.debitoForaDaLista)} fora desta lista`
                : `${data.resumo.comDebito} clientes · lista completa`,
              i: <CircleDollarSign className="w-4 h-4" /> },
            { t: 'Nunca contatados', v: String(data.resumo.nuncaContatados), s: 'sem nenhuma mensagem', i: <Clock className="w-4 h-4" /> },
            { t: 'Responderam', v: String(data.resumo.responderam), s: 'no último contato', i: <CheckCircle2 className="w-4 h-4" /> },
            { t: 'Sem resposta', v: String(data.resumo.semRespostaNoUltimo), s: 'receberam e não voltaram', i: <AlertTriangle className="w-4 h-4" /> },
            { t: 'Revenda / consumo', v: `${data.resumo.revendedores} / ${data.resumo.consumidores}`, s: 'perfil da lista', i: <Users className="w-4 h-4" /> },
          ].map((k) => (
            <div key={k.t} className="border rounded-xl p-3 bg-white dark:bg-gray-900 dark:border-gray-800">
              <div className="text-xs text-gray-500 flex items-center gap-1.5">{k.i} {k.t}</div>
              <div className="text-xl font-bold mt-1">{k.v}</div>
              <div className="text-[11px] text-gray-400">{k.s}</div>
            </div>
          ))}
        </div>
      )}

      {/* ------------------------------------------------------------- Filtros */}
      <div className="border rounded-xl p-3 bg-white dark:bg-gray-900 dark:border-gray-800 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2 top-2.5 text-gray-400" />
          <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Nome, contato ou telefone"
                 className={`${campo} pl-7 w-56`} />
        </div>
        <select value={vendedor} onChange={(e) => setVendedor(e.target.value)} className={campo}>
          <option value="">Todos os vendedores</option>
          {(data?.opcoes.vendedores || []).map((v) => <option key={v.id} value={v.id}>{v.nome} ({v.clientes})</option>)}
        </select>
        <select value={tipoCliente} onChange={(e) => setTipoCliente(e.target.value)} className={campo}>
          <option value="">Revenda e consumo</option>
          <option value="revendedor">Só revendedores</option>
          <option value="consumidor">Só consumidores</option>
        </select>
        <select value={atendimento} onChange={(e) => setAtendimento(e.target.value)} className={campo}>
          <option value="">Virtual e presencial</option>
          <option value="presencial">Só presencial</option>
          <option value="virtual">Só virtual</option>
        </select>
        <select value={debito} onChange={(e) => setDebito(e.target.value)} className={campo}>
          <option value="">Com e sem débito</option>
          <option value="com">Só com débito vencido</option>
          <option value="sem">Só sem débito</option>
        </select>
        <select value={respondeu} onChange={(e) => setRespondeu(e.target.value)} className={campo}>
          <option value="">Respondeu ou não</option>
          <option value="sim">Respondeu o último contato</option>
          <option value="nao">Recebeu e não respondeu</option>
        </select>
        <select value={contatada} onChange={(e) => setContatada(e.target.value)} className={campo}>
          <option value="">Contatados e não</option>
          <option value="nunca">Nunca receberam mensagem</option>
          <option value="sim">Já receberam alguma</option>
        </select>
        <select value={cidade} onChange={(e) => setCidade(e.target.value)} className={campo}>
          <option value="">Todas as cidades</option>
          {(data?.opcoes.cidades || []).map((c) => <option key={c.cidade} value={c.cidade}>{c.cidade} ({c.clientes})</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm cursor-pointer" title="Cliente inativo que ainda deve some da lista de ativos, mas a dívida não some. Marcando, entram os inativos QUE DEVEM — e só eles.">
          <input type="checkbox" checked={incluirInativos} onChange={(e) => setIncluirInativos(e.target.checked)}
                 className="w-4 h-4 accent-teal-600" />
          <span className="text-gray-600 dark:text-gray-300">Inativos que devem</span>
        </label>
        <div className="flex items-center gap-1 text-sm">
          <span className="text-gray-500">Sem comprar há</span>
          <input value={diasMin} onChange={(e) => setDiasMin(e.target.value)} placeholder="min" className={`${campo} w-16`} />
          <span className="text-gray-400">a</span>
          <input value={diasMax} onChange={(e) => setDiasMax(e.target.value)} placeholder="max" className={`${campo} w-16`} />
          <span className="text-gray-500">dias</span>
        </div>
      </div>

      {/* --------------------------------------------- Barra de envio por tipo */}
      <div className="border rounded-xl p-3 bg-white dark:bg-gray-900 dark:border-gray-800">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
          <div className="text-sm font-semibold">Envio por tipo de mensagem</div>
          <div className="text-sm text-gray-500">
            {marcados.total} marcação(ões) · custo estimado <span className="font-semibold">{fmtBRL(custoPrevisto)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {tipos.map((t) => {
            const n = marcados.porTipo[t.id] || 0;
            const travado = !t.aprovado || !t.ativo;
            return (
              <button key={t.id} disabled={!n || travado || enviando === t.id} onClick={() => enviar(t)}
                      title={t.pendencia || t.descricao}
                      className={`px-3 py-2 rounded-lg text-sm flex items-center gap-2 border transition
                        ${!n || travado ? 'opacity-50 cursor-not-allowed border-gray-200 dark:border-gray-700'
                                        : 'bg-teal-600 text-white border-teal-600 hover:bg-teal-700'}`}>
                {enviando === t.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Enviar {t.nome} {n > 0 && `(${n})`}
              </button>
            );
          })}
        </div>
        {tipos.some((t) => t.pendencia) && (
          <div className="mt-2 text-xs text-amber-700 dark:text-amber-300 space-y-0.5">
            {tipos.filter((t) => t.pendencia).map((t) => (
              <div key={t.id} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" /> <b>{t.nome}</b>: {t.pendencia}
                </div>
                {t.corpoSugerido && (
                  <div className="ml-5 p-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                    <div className="text-[11px] text-gray-500 mb-1">
                      Texto para cadastrar no Umbler (rótulo <code>{t.templateLabel}</code>, categoria UTILITY):
                    </div>
                    <div className="text-xs font-mono whitespace-pre-wrap">{t.corpoSugerido}</div>
                    <button onClick={() => navigator.clipboard?.writeText(t.corpoSugerido || '')}
                            className="mt-1 text-[11px] text-teal-600 hover:underline">copiar texto</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* --------------------------------------------------------------- Tabela */}
      <div className="border rounded-xl bg-white dark:bg-gray-900 dark:border-gray-800 overflow-auto">
        {isLoading ? (
          <div className="p-10 text-center text-gray-500"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
        ) : error ? (
          <div className="p-6 text-red-600 text-sm">{String((error as any)?.message || error)}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 sticky top-0 z-10">
              <tr className="text-left">
                <th className="p-2 font-semibold">Cliente</th>
                <th className="p-2 font-semibold">Contato</th>
                <th className="p-2 font-semibold">Perfil</th>
                <th className="p-2 font-semibold">Vendedor</th>
                <th className="p-2 font-semibold text-right">Última compra</th>
                <th className="p-2 font-semibold text-right">Débito vencido</th>
                <th className="p-2 font-semibold">Último contato</th>
                {tipos.map((t) => (
                  <th key={t.id} className="p-2 font-semibold text-center whitespace-nowrap" title={t.descricao}>
                    <div>{t.nome}</div>
                    <button onClick={() => alternarColuna(t)} className="text-[11px] text-teal-600 hover:underline font-normal">
                      marcar todos
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {itens.map((c) => {
                const s = selo(c);
                return (
                  <tr key={c.id} className="border-t dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="p-2">
                      <button onClick={() => setDetalhe(c)} className="font-medium text-left hover:text-teal-600 hover:underline">
                        {c.nome}
                      </button>
                      <div className="text-[11px] text-gray-400">{c.cidade || '—'}</div>
                    </td>
                    <td className="p-2">
                      <div>{c.contato || <span className="text-gray-400">sem contato</span>}</div>
                      <div className="text-[11px] text-gray-400">{c.telefone || 'sem telefone'}</div>
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800">{c.tipo}</span>{' '}
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800">{c.atendimento}</span>
                      {!c.ativo && <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">inativo</span>}
                    </td>
                    <td className="p-2 text-xs">{c.vendedor || '—'}</td>
                    <td className="p-2 text-right whitespace-nowrap">
                      <div>{fmtDia(c.ultimaCompra)}</div>
                      <div className="text-[11px] text-gray-400">
                        {fmtBRL(c.ultimaCompraValor)}{c.diasSemCompra != null && ` · ${c.diasSemCompra}d`}
                      </div>
                    </td>
                    <td className="p-2 text-right whitespace-nowrap">
                      {c.debitoTotal > 0 ? (
                        <>
                          <div className="font-semibold text-red-600 dark:text-red-400">{fmtBRL(c.debitoTotal)}</div>
                          <div className="text-[11px] text-gray-400">
                            {c.debitoTitulos} tít. · {c.debitoDiasAtraso}d de atraso
                          </div>
                        </>
                      ) : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      <span className={`text-[11px] px-1.5 py-0.5 rounded ${s.cor}`}>{s.txt}</span>
                      <div className="text-[11px] text-gray-400">
                        {fmtDia(c.ultimaInteracao)}{c.ultimoTipo && ` · ${c.ultimoTipo}`}
                      </div>
                    </td>
                    {tipos.map((t) => {
                      const motivo = permitido(t, c);
                      return (
                        <td key={t.id} className="p-2 text-center">
                          <input type="checkbox" disabled={!!motivo} title={motivo || t.nome}
                                 checked={!!selecao[t.id]?.has(c.id)}
                                 onChange={() => alternar(t.id, c.id)}
                                 className="w-4 h-4 accent-teal-600 disabled:opacity-25" />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {!itens.length && (
                <tr><td colSpan={7 + tipos.length} className="p-8 text-center text-gray-500">
                  Nenhum cliente com esses filtros.
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {recibo && <Recibo recibo={recibo} aoFechar={() => setRecibo(null)} />}
      {detalhe && <Historico cliente={detalhe} aoFechar={() => setDetalhe(null)} />}
    </div>
  );
}

/** O que aconteceu com o lote que acabou de sair. */
function Recibo({ recibo, aoFechar }: { recibo: any; aoFechar: () => void }) {
  const naoSaiu = (recibo.resultados || []).filter((r: any) => !String(r.resultado).startsWith('enfileirado'));
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={aoFechar}>
      <div className="bg-white dark:bg-gray-900 rounded-xl max-w-2xl w-full max-h-[80vh] overflow-auto p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold">{recibo.tipo?.nome}</h2>
          <button onClick={aoFechar}><X className="w-5 h-5" /></button>
        </div>
        {recibo.erro ? (
          <div className="text-red-600 text-sm">{recibo.erro}</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 text-sm mb-3">
              <div className="border rounded-lg p-2 dark:border-gray-700">
                <div className="text-xs text-gray-500">Entraram na fila</div>
                <div className="text-lg font-bold text-emerald-600">{recibo.enfileirados}</div>
              </div>
              <div className="border rounded-lg p-2 dark:border-gray-700">
                <div className="text-xs text-gray-500">Já tinham recebido hoje</div>
                <div className="text-lg font-bold">{recibo.duplicados}</div>
              </div>
              <div className="border rounded-lg p-2 dark:border-gray-700">
                <div className="text-xs text-gray-500">Não saíram</div>
                <div className="text-lg font-bold text-amber-600">
                  {recibo.desligado + recibo.optout + recibo.invalidos + recibo.outros}
                </div>
              </div>
            </div>
            <div className="text-xs text-gray-500 mb-2">
              Template <code>{recibo.template}</code> ({recibo.categoria}).
              As mensagens ainda passam pelas travas da fila antes de sair.
            </div>
            {naoSaiu.length > 0 && (
              <table className="w-full text-xs">
                <tbody>
                  {naoSaiu.map((r: any) => (
                    <tr key={r.id} className="border-t dark:border-gray-800">
                      <td className="py-1">{r.nome}</td>
                      <td className="py-1 text-right text-gray-500">{r.resultado}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Todo o histórico de comunicação com um cliente, dos dois lados. */
function Historico({ cliente, aoFechar }: { cliente: Cliente; aoFechar: () => void }) {
  const { data, isLoading } = useQuery<{ cliente: any; linha: Evento[] }>({
    queryKey: [`/api/gestao/comunicacao/cliente/${cliente.id}`],
  });
  const cor: Record<string, string> = {
    disparo: 'border-l-teal-500', cliente: 'border-l-emerald-500',
    ia: 'border-l-violet-500', humano: 'border-l-gray-400',
  };
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={aoFechar}>
      <div className="bg-white dark:bg-gray-900 rounded-xl max-w-3xl w-full max-h-[85vh] overflow-auto p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-bold">{cliente.nome}</h2>
          <button onClick={aoFechar}><X className="w-5 h-5" /></button>
        </div>
        <div className="text-xs text-gray-500 mb-3">
          {cliente.contato || 'sem contato'} · {cliente.telefone || 'sem telefone'} · {cliente.tipo} · {cliente.atendimento}
          {cliente.debitoTotal > 0 && ` · ${fmtBRL(cliente.debitoTotal)} vencido em ${cliente.debitoTitulos} título(s)`}
        </div>
        {isLoading ? (
          <div className="p-8 text-center"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
        ) : !data?.linha?.length ? (
          <div className="p-8 text-center text-gray-500 text-sm">Nenhuma comunicação registrada com este cliente.</div>
        ) : (
          <div className="space-y-1.5">
            {data.linha.map((e, i) => (
              <div key={i} className={`border-l-4 ${cor[e.especie] || 'border-l-gray-300'} pl-3 py-1.5 bg-gray-50 dark:bg-gray-800/50 rounded-r`}>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium">
                    {e.especie === 'disparo' ? `Central → ${e.titulo}` :
                     e.especie === 'cliente' ? 'Cliente escreveu' :
                     e.especie === 'ia' ? `IA (${e.tipo}) respondeu` : 'Atendente respondeu'}
                  </span>
                  <span className="text-gray-400">{fmtDataHora(e.quando)}</span>
                </div>
                {e.texto && <div className="text-xs text-gray-600 dark:text-gray-300 mt-0.5">{e.texto}</div>}
                {e.especie === 'disparo' && (
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    {e.tipo} · {e.status}
                    {e.recebida && ' · chegou no aparelho'}
                    {e.lida && ' · lida'}
                    {e.modo === 'test' && ' · modo teste'}
                    {e.custo > 0 && ` · ${fmtBRL(e.custo)}`}
                    {e.erro && <span className="text-red-600"> · {e.erro}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
