// ═══════════════════════════════════════════════════════════════════════════
// CONTABILIDADE (set/2026) — relatórios gravados no Integra para o contador.
// Cada relatório é um ARQUIVO congelado (snapshot): gerado uma vez, guardado em
// contabilidade_relatorios e baixado quantas vezes precisar.
// Primeiro relatório: "Números de NF a inutilizar" (planilha por empresa).
// ═══════════════════════════════════════════════════════════════════════════
import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { db } from "./db";
import { sql } from "drizzle-orm";
import XLSX from "xlsx";

type AbaExcel = { nome: string; linhas: Record<string, any>[]; opcoes?: any };
// xlsx em ESM: o pacote é CJS, então o import default é o objeto com utils/write.
function planilhaAbas(abas: AbaExcel[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const a of abas) {
    const ws = XLSX.utils.json_to_sheet(a.linhas);
    const cols = Object.keys(a.linhas[0] || {});
    ws["!cols"] = cols.map((c) => ({ wch: Math.min(60, Math.max(c.length, ...a.linhas.map((l) => String(l[c] ?? "").length)) + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, a.nome.slice(0, 31));
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
import { levantarLacunas } from "./nfe-inutilizacao";

let _ok = false;
async function ensure() {
  if (_ok) return;
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS contabilidade_relatorios (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      titulo varchar NOT NULL,
      categoria varchar NOT NULL DEFAULT 'fiscal',
      descricao text,
      nome_arquivo varchar NOT NULL,
      mime varchar NOT NULL,
      conteudo_base64 text NOT NULL,
      tamanho integer NOT NULL DEFAULT 0,
      resumo jsonb,
      created_by varchar,
      created_at timestamp NOT NULL DEFAULT now()
    )`));
  _ok = true;
}

const fmtCnpj = (c: string) => String(c || "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const dataBR = (s: string | null) => (s ? new Date(s).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "");
function prazoLegal(dataDepois: string | null) {
  if (!dataDepois) return { prazo: "", vencido: "" };
  const d = new Date(dataDepois);
  const lim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 10, 23, 59));
  return { prazo: lim.toLocaleDateString("pt-BR", { timeZone: "UTC" }), vencido: Date.now() > lim.getTime() ? "Sim" : "Não" };
}

export async function gerarRelatorioLacunasNF(quem: string | null) {
  await ensure();
  const lev = await levantarLacunas({ desde: "2006-01-01" });
  const hist: any = await db.execute(sql`
    SELECT cnpj, uf, modelo, serie, ano, numero_inicial, numero_final, ambiente, status, c_stat, x_motivo, protocolo, created_at
    FROM fiscal_inutilizacoes WHERE ambiente = 'producao' ORDER BY created_at`);
  const histRows: any[] = hist.rows || hist;

  const resumo = lev.grupos.map((g: any) => ({
    "Empresa": g.nome,
    "CNPJ": fmtCnpj(g.cnpj),
    "UF": g.uf,
    "Modelo": g.modelo,
    "Série": g.serie,
    "Notas emitidas (Integra)": g.notas || 0,
    "Primeiro nº": g.primeiro || "",
    "Último nº": g.ultimo || "",
    "Faixas a inutilizar": g.totalFaixas,
    "Números a inutilizar": g.totalNumeros,
    "Faixas de 2026": g.faixas.filter((f: any) => f.ano === 2026).length,
    "Faixas fora do prazo": g.faixas.filter((f: any) => prazoLegal(f.dataDepois).vencido === "Sim").length,
  }));

  const abas: AbaExcel[] = [{ nome: "Resumo", linhas: resumo }];
  for (const g of lev.grupos as any[]) {
    if (!g.totalFaixas) continue;
    const sigla = String(g.nome).split(" ")[0];
    abas.push({
      nome: `${sigla} mod${g.modelo} s${g.serie}`.slice(0, 31),
      linhas: g.faixas.map((f: any) => {
        const p = prazoLegal(f.dataDepois);
        return {
          "CNPJ": fmtCnpj(g.cnpj),
          "Modelo": g.modelo,
          "Série": g.serie,
          "Nº inicial": f.ini,
          "Nº final": f.fim,
          "Quantidade": f.qtd,
          "Ano do pedido": f.ano,
          "Nota anterior (data)": dataBR(f.dataAntes),
          "Nota seguinte (data)": dataBR(f.dataDepois),
          "Prazo legal": p.prazo,
          "Fora do prazo": p.vencido,
          "Situação no Integra": (f.statusIntegra || []).join(", "),
        };
      }),
      opcoes: { formatos: { "CNPJ": "texto" as any } },
    });
  }
  abas.push({
    nome: "Pedidos enviados",
    linhas: histRows.length ? histRows.map((h) => ({
      "Data": new Date(h.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
      "CNPJ": fmtCnpj(h.cnpj), "UF": h.uf, "Modelo": h.modelo, "Série": h.serie, "Ano": h.ano,
      "Nº inicial": h.numero_inicial, "Nº final": h.numero_final, "Situação": h.status,
      "cStat": h.c_stat || "", "Retorno SEFAZ": h.x_motivo || "", "Protocolo": h.protocolo || "",
    })) : [{ "Data": "Nenhum pedido em produção até a geração deste relatório" }],
  });
  abas.push({
    nome: "Notas",
    linhas: [
      { "Observação": "Base legal: Ajuste SINIEF 07/05, cláusula 14ª — inutilizar até o 10º dia do mês seguinte à quebra da sequência." },
      { "Observação": "Fonte: chaves de acesso das NF-e/NFC-e de produção autorizadas, canceladas ou denegadas registradas no Integra 2.0." },
      { "Observação": "Faixas anteriores à entrada do Integra 2.0 (abr/2026) podem conter notas emitidas pelo Omie/1.0 não importadas; a SEFAZ recusa a faixa se houver número já usado." },
      { "Observação": "Números reservados por notas dos últimos 15 dias ainda sem desfecho (rascunho/pendente/rejeitada) ficam de fora." },
      { "Observação": `Gerado em ${new Date(lev.geradoEm).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.` },
    ],
  });

  const buf = planilhaAbas(abas);
  const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const nome = `NF_a_inutilizar_por_empresa_${hoje}.xlsx`;
  const totais = { faixas: resumo.reduce((a, r) => a + r["Faixas a inutilizar"], 0), numeros: resumo.reduce((a, r) => a + r["Números a inutilizar"], 0) };
  const ins: any = await db.execute(sql`
    INSERT INTO contabilidade_relatorios (titulo, categoria, descricao, nome_arquivo, mime, conteudo_base64, tamanho, resumo, created_by)
    VALUES (${"Números de NF a inutilizar — por empresa"}, 'fiscal',
            ${`${totais.faixas} faixas / ${totais.numeros} números em ${resumo.length} empresa-modelo-série`},
            ${nome}, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ${buf.toString("base64")}, ${buf.length}, ${JSON.stringify({ totais, resumo })}::jsonb, ${quem})
    RETURNING id, titulo, nome_arquivo, tamanho, created_at`);
  return (ins.rows || ins)[0];
}

export function registerContabilidadeRoutes(app: Express) {
  const ver = requireRole(["admin", "administrative", "coordinator"]);

  app.get("/api/contabilidade/relatorios", authenticateUser, ver, async (_req, res) => {
    try {
      await ensure();
      const r: any = await db.execute(sql`
        SELECT id, titulo, categoria, descricao, nome_arquivo, tamanho, resumo->'totais' totais, created_by, created_at
        FROM contabilidade_relatorios ORDER BY created_at DESC LIMIT 200`);
      res.json(r.rows || r);
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.get("/api/contabilidade/relatorios/:id/arquivo", authenticateUser, ver, async (req, res) => {
    try {
      await ensure();
      const r: any = await db.execute(sql`SELECT nome_arquivo, mime, conteudo_base64 FROM contabilidade_relatorios WHERE id = ${req.params.id}`);
      const row = (r.rows || r)[0];
      if (!row) return res.status(404).json({ error: "não encontrado" });
      res.setHeader("Content-Type", row.mime);
      res.setHeader("Content-Disposition", `attachment; filename=${row.nome_arquivo}`);
      res.send(Buffer.from(row.conteudo_base64, "base64"));
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post("/api/contabilidade/relatorios/nf-a-inutilizar", authenticateUser, requireRole(["admin", "administrative"]), async (req: any, res) => {
    try {
      const quem = req.currentUser?.email || req.currentUser?.id || req.user?.email || null;
      res.json(await gerarRelatorioLacunasNF(quem));
    } catch (e: any) {
      console.error("[CONTABILIDADE] relatório NF a inutilizar:", e?.message);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
}
