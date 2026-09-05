// INTEGRA 2.0 — Relatorio semanal de entregas por vendedor, enviado por WhatsApp.
//
// Regra da transportadora:
//   Cleber   : pedidos que entraram na raia "Pedidos" de QUINTA a TERCA  -> entrega QUARTA  -> envia QUARTA  18h
//   Radilton : pedidos que entraram na raia "Pedidos" de TERCA  a SEXTA  -> entrega SEGUNDA -> envia SEGUNDA 18h
//
// Colunas: Cliente, data de entrada do pedido (raia Pedidos), data de entrega (raia Entregue) e
// dias entre as duas datas. Desconsidera pedidos excluidos (raia Lixeira).
// Envia pelo canal 7169 (reserva) para os destinos configurados por vendedor.

import type { Express } from "express";
import cron from "node-cron";
import { storage } from "./storage";
import { sendUmblerTalkText } from "./chat-routes";

const CANAL_ENVIO = "5562993227169"; // HONEST 7169 (reserva)

type VendKey = "cleber" | "radilton";
interface VendCfg { id: string; nome: string; janela: "cleber" | "radilton"; destinos: string[]; }

const VENDEDORES: Record<VendKey, VendCfg> = {
  cleber:   { id: "883af1f5-0400-40b5-8add-091a29bbbe1e", nome: "Cleber",   janela: "cleber",   destinos: ["5561999875248", "5562994511997"] },
  radilton: { id: "e9149282-adfc-448e-8d0e-a07765a06637", nome: "Radilton", janela: "radilton", destinos: ["5561998201773", "5562994511997"] },
};

// "hoje" em America/Sao_Paulo como YYYY-MM-DD
function hojeBR(base?: Date): string {
  return (base || new Date()).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}
function addDias(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
// baseISO = data do envio (quarta p/ Cleber, segunda p/ Radilton)
function janela(tipo: "cleber" | "radilton", baseISO: string): { from: string; to: string } {
  if (tipo === "cleber") return { from: addDias(baseISO, -6), to: addDias(baseISO, -1) }; // qui -> ter
  return { from: addDias(baseISO, -6), to: addDias(baseISO, -3) };                        // ter -> sex
}
function fmtBR(iso?: string | null): string {
  if (!iso) return "—";
  const p = String(iso).slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : String(iso);
}
function diasEntre(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null;
  const t1 = Date.parse(String(a).slice(0, 10));
  const t2 = Date.parse(String(b).slice(0, 10));
  if (isNaN(t1) || isNaN(t2)) return null;
  return Math.round((t2 - t1) / 86400000);
}

async function gerarRows(v: VendCfg, jan: { from: string; to: string }) {
  const items: any[] = await storage.getBillingPipelineItems();
  const nomeRe = new RegExp(v.nome, "i");
  const rows: any[] = [];
  for (const p of items) {
    if (String(p.sellerId) !== v.id && !nomeRe.test(String(p.sellerName || ""))) continue;
    if (String(p.stage) === "lixeira") continue; // desconsidera excluidos
    const sh: any[] = Array.isArray(p.stageHistory) ? p.stageHistory : [];
    const peds = sh
      .filter((e) => String(e && e.stage) === "pedido" && e.changedAt)
      .map((e) => String(e.changedAt))
      .filter((dt) => dt.slice(0, 10) >= jan.from && dt.slice(0, 10) <= jan.to)
      .sort();
    if (!peds.length) continue;
    const ents = sh
      .filter((e) => String(e && e.stage) === "entregue" && e.changedAt)
      .map((e) => String(e.changedAt))
      .sort();
    rows.push({ cliente: p.customerName || p.customerId, dataPedido: peds[0], dataEntrega: ents[0] || null, valor: p.saleValue });
  }
  rows.sort((a, b) => (a.dataPedido < b.dataPedido ? -1 : 1));
  return rows;
}

function montarTexto(v: VendCfg, jan: { from: string; to: string }, rows: any[]): string {
  // Cabecalho em negrito (fonte normal) FORA do bloco; a lista vai dentro de um bloco
  // monospace (```), que o WhatsApp renderiza numa fonte menor e mais compacta no mobile.
  const L: string[] = [];
  L.push(`📦 *Entregas — ${v.nome}*  ·  ${fmtBR(jan.from)} a ${fmtBR(jan.to)}`);
  if (!rows.length) {
    L.push("");
    L.push("_Nenhum pedido na janela._");
    return L.join("\n");
  }
  let total = 0;
  const body: string[] = [];
  rows.forEach((r, i) => {
    const dd = diasEntre(r.dataPedido, r.dataEntrega);
    total += parseFloat(String(r.valor || 0)) || 0;
    body.push(`${i + 1}. ${r.cliente}`);
    body.push(`   ${fmtBR(r.dataPedido)} → ${fmtBR(r.dataEntrega)}  (${dd == null ? "—" : dd + "d"})`);
  });
  body.push("");
  body.push(`Total: ${rows.length} ped · R$ ${total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);
  L.push("```");
  L.push(body.join("\n"));
  L.push("```");
  return L.join("\n");
}

export async function gerarRelatorio(vk: VendKey, baseISO?: string) {
  const v = VENDEDORES[vk];
  const jan = janela(v.janela, baseISO || hojeBR());
  const rows = await gerarRows(v, jan);
  return { vend: v, jan, rows, texto: montarTexto(v, jan, rows) };
}

export async function enviarRelatorio(vk: VendKey, opts?: { baseISO?: string; toOverride?: string[] }) {
  const { vend, texto } = await gerarRelatorio(vk, opts?.baseISO);
  const destinos = opts?.toOverride && opts.toOverride.length ? opts.toOverride : vend.destinos;
  const res: any[] = [];
  for (const to of destinos) {
    try {
      const r = await sendUmblerTalkText(to, texto, CANAL_ENVIO);
      res.push({ to, ...r });
    } catch (e: any) {
      res.push({ to, success: false, error: e?.message || String(e) });
    }
  }
  return { vend: vend.nome, enviados: res };
}

export function registerRelatorioEntregas(app: Express): void {
  // Crons (America/Sao_Paulo): Radilton segunda 18h; Cleber quarta 18h.
  try {
    cron.schedule("0 18 * * 1", () => {
      enviarRelatorio("radilton")
        .then((r) => console.log("[REL-ENTREGAS] radilton:", JSON.stringify(r)))
        .catch((e) => console.error("[REL-ENTREGAS] radilton:", e?.message));
    }, { timezone: "America/Sao_Paulo" });
    cron.schedule("0 18 * * 3", () => {
      enviarRelatorio("cleber")
        .then((r) => console.log("[REL-ENTREGAS] cleber:", JSON.stringify(r)))
        .catch((e) => console.error("[REL-ENTREGAS] cleber:", e?.message));
    }, { timezone: "America/Sao_Paulo" });
    console.log("[REL-ENTREGAS] crons registrados (radilton seg 18h, cleber qua 18h)");
  } catch (e: any) {
    console.error("[REL-ENTREGAS] cron setup:", e?.message);
  }

  // Gatilho manual protegido por token.
  //   /api/admin/relatorio-entregas/run?token=rel-6931&vendedor=cleber          -> previa (nao envia)
  //   ...&send=1                                                                -> envia aos destinos reais
  //   ...&to=5562994511997                                                      -> envia so a este numero (teste)
  //   ...&data=2026-09-09                                                       -> forca a data-base (teste de janela)
  app.all("/api/admin/relatorio-entregas/run", async (req: any, res: any) => {
    try {
      const token = String((req.query && req.query.token) || "");
      if (token !== "rel-6931") return res.status(403).json({ error: "forbidden" });
      const vk = String(req.query.vendedor || "").toLowerCase() as VendKey;
      if (!VENDEDORES[vk]) return res.status(400).json({ error: "vendedor invalido (use cleber|radilton)" });
      const baseISO = req.query.data ? String(req.query.data) : undefined;
      const doSend = /^(1|true|sim)$/i.test(String(req.query.send || ""));
      const toOverride = req.query.to ? [String(req.query.to).replace(/\D/g, "")] : undefined;
      const g = await gerarRelatorio(vk, baseISO);
      if (!doSend && !toOverride) {
        return res.json({ preview: true, vendedor: vk, janela: g.jan, total: g.rows.length, texto: g.texto });
      }
      const envio = await enviarRelatorio(vk, { baseISO, toOverride });
      return res.json({ enviado: true, vendedor: vk, janela: g.jan, total: g.rows.length, texto: g.texto, resultado: envio.enviados });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
  console.log("[REL-ENTREGAS] rota manual: /api/admin/relatorio-entregas/run");
}
