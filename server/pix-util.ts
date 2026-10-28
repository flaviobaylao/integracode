// Chave PIX / favorecido — validação compartilhada por Reembolsos e Viagens (28/out/2026).
// Chave PIX conforme o tipo (CPF/CNPJ com dígito verificador, celular com DDD, e-mail com @, aleatória UUID)
export const soDig = (v: string) => String(v || "").replace(/\D/g, "");
export function cpfValido(d: string) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n: number) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}
export function cnpjValido(d: string) {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (n: number) => { const p = n === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2]; let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * p[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}
export function normalizarPix(tipo: string, chave: string) {
  if (["CPF", "CNPJ", "Celular"].includes(tipo)) return soDig(chave);
  return String(chave || "").trim().toLowerCase();
}
export function validarPix(tipo: string, chave: string): string | null {
  const k = normalizarPix(tipo, chave);
  switch (tipo) {
    case "CPF": return cpfValido(k) ? null : "Chave PIX CPF inválida: informe os 11 números do CPF";
    case "CNPJ": return cnpjValido(k) ? null : "Chave PIX CNPJ inválida: informe os 14 números do CNPJ";
    case "Celular": return /^\d{2}9\d{8}$/.test(k) ? null : "Chave PIX celular inválida: DDD + número, 11 números";
    case "E-mail": return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(k) ? null : "Chave PIX e-mail inválida: precisa ter @";
    case "Aleatória": return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(k) ? null : "Chave PIX aleatória inválida";
    default: return "Escolha o tipo de chave PIX";
  }
}
