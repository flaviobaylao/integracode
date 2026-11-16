// ============================================================================
// WhatsApp dos clientes que chegam pelo Instagram Direct (out/2026).
//
// Regra do Flavio: quem chega pelo Instagram nao tem telefone (a conversa e
// identificada por "ig:<IGSID>"). Sem WhatsApp o cliente fica fora da repescagem,
// dos disparos, dos avisos de entrega e de cobranca, e o vendedor nao consegue
// falar com ele. Entao:
//   1) a IA pede o WhatsApp (com DDD) logo no comeco da conversa no Direct e grava
//      pela ferramenta `salvar_whatsapp`;
//   2) `registrar_pedido` no canal Instagram so registra com WhatsApp valido;
//   3) o numero vai para chat_customers.whatsapp (contato da conversa) e para o
//      telefone do cadastro do ERP quando ele estiver vazio ou com o id do Instagram.
// ============================================================================
import { db } from "./db";
import { sql } from "drizzle-orm";

let _colunaOk = false;
export async function garantirColunaWhatsapp(): Promise<void> {
  if (_colunaOk) return;
  try {
    await db.execute(sql`ALTER TABLE chat_customers ADD COLUMN IF NOT EXISTS whatsapp varchar`);
    _colunaOk = true;
  } catch (e: any) {
    console.error("[IG-WA] coluna whatsapp:", e?.message || e);
  }
}

/**
 * Normaliza um celular/telefone brasileiro para 55 + DDD + numero.
 * Aceita com ou sem 55, com ou sem mascara. Devolve null se nao for um numero valido
 * (DDD invalido, tamanho errado, celular de 11 digitos sem o 9).
 */
export function normalizarWhatsappBR(raw: any): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.startsWith("0")) d = d.replace(/^0+/, "");
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = d.slice(0, 2);
  if (ddd[0] === "0" || ddd[1] === "0") return null;
  if (d.length === 11 && d[2] !== "9") return null;
  if (d.length === 10 && !/[2-9]/.test(d[2])) return null;
  return "55" + d;
}

/** Telefone do cadastro que nao serve para contato (vazio, id do Instagram, lixo). */
export function telefoneInutil(phone: any, igsid?: string | null): boolean {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (!d) return true;
  if (igsid && d === String(igsid).replace(/\D/g, "")) return true;
  return normalizarWhatsappBR(d) === null;
}

/** WhatsApp ja informado pelo cliente nesta conversa do Instagram (ou null). */
export async function whatsappDaConversa(conversationId: any): Promise<string | null> {
  if (!conversationId) return null;
  await garantirColunaWhatsapp();
  try {
    const r: any = await db.execute(sql`SELECT cc.whatsapp FROM chat_conversations c
      JOIN chat_customers cc ON cc.id = c.customer_id
      WHERE c.id = ${String(conversationId)} LIMIT 1`);
    const w = r.rows?.[0]?.whatsapp;
    return w ? String(w) : null;
  } catch {
    return null;
  }
}

/**
 * Grava o WhatsApp no contato da conversa e, se houver cadastro no ERP com telefone
 * vazio/inutil, no cadastro tambem. Nunca troca um telefone bom que ja exista no ERP.
 * `nome`: o nome que o cliente informou. So substitui o nome do contato quando o que
 * esta la ainda e o automatico do Instagram ("@usuario" ou "Instagram 123456") — assim
 * nao apaga um nome que alguem da equipe tenha corrigido na mao.
 */
export async function salvarWhatsappDaConversa(opts: {
  conversationId: any;
  numero: string;
  nome?: string | null;
  erpCustomerId?: string | null;
  igsid?: string | null;
}): Promise<{ ok: boolean; numero?: string; erro?: string; erpAtualizado?: boolean; nomeSalvo?: string }> {
  const numero = normalizarWhatsappBR(opts.numero);
  if (!numero) return { ok: false, erro: "numero invalido" };
  await garantirColunaWhatsapp();
  let nomeSalvo: string | undefined;
  try {
    if (opts.conversationId) {
      await db.execute(sql`UPDATE chat_customers SET whatsapp = ${numero}
        WHERE id = (SELECT customer_id FROM chat_conversations WHERE id = ${String(opts.conversationId)} LIMIT 1)`);
      const nome = String(opts.nome || "").trim().replace(/\s+/g, " ").slice(0, 80);
      if (nome.length >= 2) {
        const r: any = await db.execute(sql`UPDATE chat_customers SET name = ${nome}
          WHERE id = (SELECT customer_id FROM chat_conversations WHERE id = ${String(opts.conversationId)} LIMIT 1)
            AND (name IS NULL OR name = '' OR name LIKE '@%' OR name LIKE 'Instagram %')
          RETURNING name`);
        if ((r.rows || []).length) {
          nomeSalvo = nome;
          try {
            await db.execute(sql`UPDATE chat_conversations SET customer_name = ${nome} WHERE id = ${String(opts.conversationId)}`);
          } catch { /* nome na conversa e cosmetico */ }
        }
      }
    }
  } catch (e: any) {
    console.error("[IG-WA] gravar no contato:", e?.message || e);
  }
  let erpAtualizado = false;
  if (opts.erpCustomerId) {
    try {
      const r: any = await db.execute(sql`SELECT phone FROM customers WHERE id = ${String(opts.erpCustomerId)} LIMIT 1`);
      const atual = r.rows?.[0]?.phone;
      if (r.rows?.length && telefoneInutil(atual, opts.igsid)) {
        const { analisarTelefoneBR } = await import('../shared/telefone');
        const __pad = analisarTelefoneBR(numero);
        if (__pad.valido) {
          await db.execute(sql`UPDATE customers SET phone = ${__pad.novo}, updated_at = now() WHERE id = ${String(opts.erpCustomerId)}`);
          erpAtualizado = true;
        }
      }
    } catch (e: any) {
      console.error("[IG-WA] gravar no cadastro:", e?.message || e);
    }
  }
  return { ok: true, numero, erpAtualizado, nomeSalvo };
}

/** Formata 5562993227169 como (62) 99322-7169. Devolve o cru se nao reconhecer. */
export function formatarFoneBR(raw: any): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(raw ?? "");
}

/**
 * WhatsApp da equipe para o cliente procurar quando ele NAO quiser dar o numero dele.
 * Usa o canal de saida configurado em Canais (`canal_saida_padrao`), que e o numero
 * ligado a Central — mandar o cliente para outro numero seria mandar para o vazio.
 */
export async function foneDaEquipeFormatado(): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'canal_saida_padrao' LIMIT 1`);
    const v = r.rows?.[0]?.value;
    if (v && String(v).replace(/\D/g, "").length >= 10) return formatarFoneBR(v);
  } catch { /* sem configuracao, cai no numero publicado na loja */ }
  return "(62) 99578-2812";
}

/** Bloco do prompt para o canal Instagram. */
export function blocoPromptWhatsappIG(whatsapp: string | null): string {
  if (whatsapp) {
    return [
      "# WHATSAPP DO CLIENTE (canal Instagram)",
      `O cliente ja informou o WhatsApp: ${whatsapp}. Use esse numero no campo telefone do registrar_pedido. Nao peca de novo.`,
      "- Se ele pedir para falar com um atendente, pode chamar transferir_humano direto: ja temos como a equipe chamar ele.",
    ].join("\n");
  }
  return [
    "# WHATSAPP DO CLIENTE (canal Instagram) — OBRIGATORIO",
    "Esta conversa veio pelo Direct do Instagram e ainda NAO temos o WhatsApp do cliente.",
    "- Logo no comeco (na primeira ou segunda resposta, depois de cumprimentar e entender o que ele quer), peca o WhatsApp com DDD, de forma simpatica e curta.",
    "- Explique o motivo em uma frase: e por onde enviamos a confirmacao do pedido, o PIX/boleto, a nota fiscal e o aviso de entrega.",
    "- Quando o cliente informar, chame a ferramenta salvar_whatsapp com o numero (e com o nome, se ele tiver dito). Se ela disser que o numero e invalido, peca de novo com DDD.",
    "- Se o cliente nao quiser informar, continue ajudando normalmente (tire duvidas, mostre produtos e precos), mas NAO registre pedido sem o WhatsApp: explique com gentileza que ele e necessario para confirmar e entregar.",
    "- Nunca use o id do Instagram como telefone.",
    "",
    "# FALAR COM UMA PESSOA (canal Instagram)",
    "NINGUEM da equipe consegue responder aqui pelo Direct. O atendimento humano acontece pelo WhatsApp.",
    "- Se o cliente pedir para falar com um atendente, chame transferir_humano assim mesmo: a ferramenta devolve o que fazer.",
    "- Enquanto nao houver WhatsApp salvo, ela NAO transfere e pede que voce colha nome e numero. Faca isso com naturalidade, dizendo que o atendimento continua pelo WhatsApp.",
    "- NUNCA diga que um atendente vai responder por aqui, nem que alguem vai assumir esta conversa. Isso nao acontece.",
  ].join("\n");
}
