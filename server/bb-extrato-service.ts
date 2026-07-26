// ---------------------------------------------------------------------------
// BB — API de EXTRATOS (v1). Traz o extrato da conta corrente direto do banco,
// com MAIS informacao do que o arquivo OFX:
//   textoDescricaoHistorico      -> rotulo do lancamento ("Pix - Enviado")
//   textoInformacaoComplementar  -> o DETALHE (contraparte, data/hora, CPF/CNPJ)
//   numeroCpfCnpjContrapartida / codigoBancoContrapartida / agencia / conta
// Mapeamos para o MESMO formato do parser de OFX (description = detalhe,
// name = rotulo) para que a ingestao, o dedup e a tela funcionem identicos.
//
// Credenciais (por conta financeira, com fallback p/ env):
//   bb_extrato_client_id / bb_extrato_client_secret  (app assinante da API Extratos)
//   -> fallback: BB_EXTRATO_CLIENT_ID / BB_EXTRATO_CLIENT_SECRET
//   -> fallback: bb_client_id / bb_client_secret (se o MESMO app assinar Extratos)
//   dev app key: BB_EXTRATO_DEV_APP_KEY -> bb_dev_app_key
// Scope OAuth: "extrato-info".
// ---------------------------------------------------------------------------
import axios from "axios";
import https from "https";

const OAUTH_URL_PROD = "https://oauth.bb.com.br/oauth/token";
const OAUTH_URL_SANDBOX = "https://oauth.sandbox.bb.com.br/oauth/token";
const API_URL_PROD = "https://api.bb.com.br/extratos/v1";
const API_URL_SANDBOX = "https://api.sandbox.bb.com.br/extratos/v1";
const SCOPE = "extrato-info";

// Producao por padrao (a API de Extratos so tem valor com dados reais).
export const isExtratoSandbox = (): boolean => process.env.BB_EXTRATO_SANDBOX === "true";
const getOAuthUrl = () => (isExtratoSandbox() ? OAUTH_URL_SANDBOX : OAUTH_URL_PROD);
const getApiUrl = () => (isExtratoSandbox() ? API_URL_SANDBOX : API_URL_PROD);

export type ExtratoAccount = {
  id: string;
  name?: string | null;
  agency?: string | null;
  account_number?: string | null;
  bb_extrato_client_id?: string | null;
  bb_extrato_client_secret?: string | null;
  bb_client_id?: string | null;
  bb_client_secret?: string | null;
  bb_dev_app_key?: string | null;
};

export type ExtratoCreds = {
  clientId: string;
  clientSecret: string;
  devAppKey: string;
  origem: string; // de onde vieram (p/ diagnostico, sem expor segredo)
};

const digits = (v: any): string => String(v ?? "").replace(/\D/g, "");

// Agencia/conta do BB vem cadastrada com digito verificador ("4148-3", "23816-3").
// A API recebe o numero SEM o DV.
export function splitAgencia(v: any): { numero: number; dv: string } {
  const raw = String(v ?? "").trim();
  const m = raw.match(/^(\d+)\s*[-.,/]?\s*(\w)?$/);
  if (m) return { numero: parseInt(m[1], 10) || 0, dv: (m[2] || "").toUpperCase() };
  const d = digits(raw);
  return { numero: parseInt(d.slice(0, -1) || d, 10) || 0, dv: d.slice(-1) };
}

export function resolveCreds(acc: ExtratoAccount): ExtratoCreds {
  const cid = (acc.bb_extrato_client_id || "").trim() || (process.env.BB_EXTRATO_CLIENT_ID || "").trim() || (acc.bb_client_id || "").trim();
  const sec = (acc.bb_extrato_client_secret || "").trim() || (process.env.BB_EXTRATO_CLIENT_SECRET || "").trim() || (acc.bb_client_secret || "").trim();
  const key = (process.env.BB_EXTRATO_DEV_APP_KEY || "").trim() || (acc.bb_dev_app_key || "").trim();
  const origem = (acc.bb_extrato_client_id || "").trim()
    ? "conta (bb_extrato_client_id)"
    : (process.env.BB_EXTRATO_CLIENT_ID || "").trim()
      ? "env BB_EXTRATO_CLIENT_ID"
      : (acc.bb_client_id || "").trim()
        ? "fallback: credencial de Cobrancas da conta (bb_client_id)"
        : "nenhuma";
  return { clientId: cid, clientSecret: sec, devAppKey: key, origem };
}

// mTLS opcional: algumas habilitacoes da API de Extratos exigem certificado A1.
function agentOrUndefined(): https.Agent | undefined {
  const pfxB64 = process.env.BB_EXTRATO_CERT_PFX_BASE64;
  const pass = process.env.BB_EXTRATO_CERT_PASSWORD || "";
  if (pfxB64) {
    try { return new https.Agent({ pfx: Buffer.from(pfxB64, "base64"), passphrase: pass }); } catch { /* ignora */ }
  }
  return undefined;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getExtratoToken(acc: ExtratoAccount): Promise<string> {
  const c = resolveCreds(acc);
  if (!c.clientId || !c.clientSecret) {
    throw new Error("Credenciais da API de Extratos do BB nao configuradas (Financeiro > conta > BB Extrato: Client ID/Secret)");
  }
  const cacheKey = `bbExtrato_${acc.id}_${isExtratoSandbox() ? "sbx" : "prd"}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now() + 60000) return hit.token;

  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials", scope: SCOPE });
  const r = await axios.post(getOAuthUrl(), body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    timeout: 20000,
    httpsAgent: agentOrUndefined(),
  });
  const token = String((r.data as any)?.access_token || "");
  const exp = Number((r.data as any)?.expires_in || 600);
  if (!token) throw new Error("BB nao retornou access_token para o scope " + SCOPE);
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + exp * 1000 });
  return token;
}

// A API recebe/devolve datas como DDMMAAAA (numero). Aceitamos ISO na entrada.
export const toBBDate = (iso: string): string => {
  const s = String(iso || "").slice(0, 10);
  const p = s.split("-");
  if (p.length === 3) return `${p[2]}${p[1]}${p[0]}`;
  return digits(s).slice(0, 8);
};
export const fromBBDate = (v: any): string => {
  const d = digits(v).padStart(8, "0");
  if (d.length !== 8) return "";
  const dd = d.slice(0, 2), mm = d.slice(2, 4), yyyy = d.slice(4, 8);
  if (!yyyy || yyyy === "0000") return "";
  return `${yyyy}-${mm}-${dd}`;
};

const pickNum = (o: any, ...keys: string[]): any => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return null;
};

export type ExtratoTxn = {
  date: string; amount: number; type: "C" | "D";
  description: string; name: string; document: string; fitid: string;
  originDocument: string | null; raw: any;
};

// Converte um lancamento da API para o formato do parser de OFX.
export function mapLancamento(l: any, agencia: number, conta: number): ExtratoTxn | null {
  const valor = Number(String(pickNum(l, "valorLancamento", "valor", "valorMovimento") ?? "0").toString().replace(",", "."));
  if (!isFinite(valor)) return null;
  const sinal = String(pickNum(l, "indicadorSinalLancamento", "sinalLancamento", "indicadorSinal") ?? "").toUpperCase();
  const type: "C" | "D" = sinal === "D" ? "D" : sinal === "C" ? "C" : valor < 0 ? "D" : "C";
  const date = fromBBDate(pickNum(l, "dataLancamento", "dataMovimento", "dataBalancete"));
  const historico = String(pickNum(l, "textoDescricaoHistorico", "descricaoHistorico", "textoHistorico") ?? "").trim();
  const complemento = String(pickNum(l, "textoInformacaoComplementar", "informacaoComplementar", "textoComplemento") ?? "").trim();
  const numeroDoc = String(pickNum(l, "numeroDocumento", "numeroDocumentoTransacao") ?? "").trim();
  const cpfCnpj = digits(pickNum(l, "numeroCpfCnpjContrapartida", "numeroCpfCnpjTerceiro", "cpfCnpjContrapartida"));
  // MESMA convencao do OFX: description = DETALHE, name = rotulo do historico.
  const description = (complemento || historico || "").slice(0, 300);
  const name = historico.slice(0, 200);
  // A API nao devolve FITID. Chave estavel = conta+data+valor+sinal+doc+historico.
  const fitid = `BBAPI-${agencia}-${conta}-${digits(date)}-${Math.abs(valor).toFixed(2)}-${type}-${numeroDoc || "0"}`.slice(0, 120);
  return {
    date, amount: Math.abs(valor), type,
    description, name,
    document: (numeroDoc && numeroDoc !== "0" ? numeroDoc : "").slice(0, 60),
    fitid,
    originDocument: cpfCnpj && (cpfCnpj.length === 11 || cpfCnpj.length === 14) ? cpfCnpj : null,
    raw: l,
  };
}

export type ExtratoResult = {
  transactions: ExtratoTxn[];
  paginas: number;
  totalRegistros: number;
  agencia: number;
  conta: number;
  sandbox: boolean;
  amostraBruta: any;
};

// Busca o extrato paginado. dataInicio/dataFim em ISO (YYYY-MM-DD).
export async function fetchExtrato(acc: ExtratoAccount, dataInicioISO: string, dataFimISO: string, maxPaginas = 30): Promise<ExtratoResult> {
  const c = resolveCreds(acc);
  if (!c.devAppKey) throw new Error("Developer Application Key do BB nao configurada na conta financeira (bb_dev_app_key)");
  const ag = splitAgencia(acc.agency).numero;
  const cc = splitAgencia(acc.account_number).numero;
  if (!ag || !cc) throw new Error(`Agencia/conta invalidas na conta financeira (agencia="${acc.agency}", conta="${acc.account_number}")`);

  const token = await getExtratoToken(acc);
  const url = `${getApiUrl()}/conta-corrente/agencia/${ag}/conta/${cc}`;
  const transactions: ExtratoTxn[] = [];
  let paginas = 0, totalRegistros = 0, amostraBruta: any = null;

  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const r = await axios.get(url, {
      params: {
        "gw-dev-app-key": c.devAppKey,
        numeroPaginaSolicitacao: pagina,
        dataInicioSolicitacao: toBBDate(dataInicioISO),
        dataFimSolicitacao: toBBDate(dataFimISO),
      },
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 60000,
      httpsAgent: agentOrUndefined(),
    });
    const d: any = r.data || {};
    if (!amostraBruta) amostraBruta = JSON.parse(JSON.stringify(d).slice(0, 4000));
    const lista: any[] = d.listaLancamento || d.lancamentos || d.listaLancamentos || [];
    for (const l of lista) {
      const t = mapLancamento(l, ag, cc);
      if (t && t.date) transactions.push(t);
    }
    paginas = pagina;
    totalRegistros = Number(d.quantidadeTotalRegistro || d.quantidadeTotalRegistros || totalRegistros || transactions.length);
    const totalPag = Number(d.quantidadeTotalPagina || d.quantidadeTotalPaginas || 1);
    if (!lista.length || pagina >= totalPag) break;
  }
  return { transactions, paginas, totalRegistros, agencia: ag, conta: cc, sandbox: isExtratoSandbox(), amostraBruta };
}

// Diagnostico: nunca devolve segredo, so o que esta configurado e o que o BB respondeu.
export async function diagnosticarExtrato(acc: ExtratoAccount, dataInicioISO: string, dataFimISO: string): Promise<any> {
  const c = resolveCreds(acc);
  const ag = splitAgencia(acc.agency).numero;
  const cc = splitAgencia(acc.account_number).numero;
  const base: any = {
    conta: acc.name, agencia: ag, contaCorrente: cc,
    ambiente: isExtratoSandbox() ? "sandbox" : "producao",
    credenciais: { clientId: !!c.clientId, clientSecret: !!c.clientSecret, devAppKey: !!c.devAppKey, origem: c.origem },
    scope: SCOPE, url: `${getApiUrl()}/conta-corrente/agencia/${ag}/conta/${cc}`,
    mtls: !!process.env.BB_EXTRATO_CERT_PFX_BASE64,
  };
  if (!c.clientId || !c.clientSecret) {
    return { ...base, ok: false, etapa: "credenciais", erro: "Client ID/Secret da API de Extratos nao configurados. Cadastre em Financeiro > contas > BB Extrato." };
  }
  try { await getExtratoToken(acc); } catch (e: any) {
    return { ...base, ok: false, etapa: "oauth", status: e?.response?.status || null, erro: String(e?.response?.data ? JSON.stringify(e.response.data).slice(0, 600) : (e?.message || e)) };
  }
  try {
    const r = await fetchExtrato(acc, dataInicioISO, dataFimISO, 1);
    return { ...base, ok: true, etapa: "extrato", lancamentos: r.transactions.length, totalRegistros: r.totalRegistros, amostra: r.transactions.slice(0, 5), amostraBruta: r.amostraBruta };
  } catch (e: any) {
    return { ...base, ok: false, etapa: "extrato", status: e?.response?.status || null, erro: String(e?.response?.data ? JSON.stringify(e.response.data).slice(0, 600) : (e?.message || e)) };
  }
}
