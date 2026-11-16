// server/responsavel-telefone.ts
// -----------------------------------------------------------------------------
// RESPONSÁVEL PELO TELEFONE (nov/2026 — regra do Flávio)
// "Onde existir telefone do cliente deve ter, ao lado, o NOME DO RESPONSÁVEL, com
//  preenchimento obrigatório. O disparo da IA para confirmar o número no WhatsApp
//  deve usar este nome."
//
// O nome mora em customers.contact (coluna já existente: "Nome do contato principal").
// validarResponsavel(): usada pelas rotas de tela (criar/editar cliente, editar
// telefone, finalizar venda). Quando o payload grava um TELEFONE, o cliente precisa
// ficar com um responsável (o enviado agora ou o que já estava no cadastro).
// -----------------------------------------------------------------------------
import { db } from "./db";
import { sql } from "drizzle-orm";
import { analisarTelefoneBR } from "../shared/telefone";

/**
 * 📞 nov/2026 — trava de telefone no CADASTRO: número de preenchimento ou fora do formato
 * não é salvo. Quando o payload traz telefone:
 *   • vazio → passa (o pedido é que exige telefone);
 *   • válido mas escrito fora do padrão (+55, sem o 9) → corrige no próprio payload;
 *   • inválido → devolve a mensagem de erro (a rota responde 400 TELEFONE_INVALIDO).
 */
export function validarTelefoneCadastro(body: any, key: string = "phone"): string | null {
  try {
    if (!body || !Object.prototype.hasOwnProperty.call(body, key)) return null;
    const v = body[key];
    if (v == null || !String(v).replace(/\D/g, "")) return null;
    const a = analisarTelefoneBR(v);
    if (a.situacao === "corrigir") { body[key] = a.novo; return null; }
    if (a.valido) return null;
    return `Telefone inválido (${a.motivo}). Use celular (DDD) 9XXXX-XXXX ou fixo (DDD) XXXX-XXXX — números de preenchimento como 99999-9999 não são aceitos.`;
  } catch {
    return null;
  }
}

export const MSG_RESPONSAVEL_OBRIGATORIO =
  "Informe o nome do responsável pelo telefone (campo obrigatório ao lado do telefone).";

const dig = (v: any) => String(v ?? "").replace(/\D/g, "");

/** Nome "limpo" do responsável (ou '' quando não serve). */
export function limparResponsavel(v: any): string {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length >= 2 && /[A-Za-zÀ-ÿ]/.test(s) ? s.slice(0, 120) : "";
}

/**
 * Retorna mensagem de erro (string) quando o payload grava telefone sem responsável;
 * null quando está tudo certo. `contactKey` permite outro nome de campo no payload.
 */
export async function validarResponsavel(
  body: any,
  customerId?: string | null,
  opts: { phoneKey?: string; contactKey?: string } = {},
): Promise<string | null> {
  try {
    const pk = opts.phoneKey || "phone";
    const ck = opts.contactKey || "contact";
    if (!body || !Object.prototype.hasOwnProperty.call(body, pk)) return null;
    if (!dig(body[pk])) return null; // sem telefone no payload: nada a exigir
    if (Object.prototype.hasOwnProperty.call(body, ck)) {
      return limparResponsavel(body[ck]) ? null : MSG_RESPONSAVEL_OBRIGATORIO;
    }
    if (customerId) {
      const r: any = await db.execute(sql`SELECT contact FROM customers WHERE id = ${customerId} LIMIT 1`);
      const atual = (r?.rows || [])[0]?.contact;
      if (limparResponsavel(atual)) return null;
    }
    return MSG_RESPONSAVEL_OBRIGATORIO;
  } catch {
    return null; // nunca derruba o fluxo por falha de leitura
  }
}

/** Primeiro nome em "Título" para saudação ("MARIA DAS DORES" -> "Maria"). */
export function primeiroNome(v: any): string {
  const s = limparResponsavel(v);
  if (!s) return "";
  const p = s.split(" ")[0];
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

/** Responsável cadastrado do cliente ('' quando não há). */
export async function responsavelDoCliente(customerId: string | null | undefined): Promise<string> {
  if (!customerId) return "";
  try {
    const r: any = await db.execute(sql`SELECT contact FROM customers WHERE id = ${customerId} LIMIT 1`);
    return limparResponsavel((r?.rows || [])[0]?.contact);
  } catch {
    return "";
  }
}
