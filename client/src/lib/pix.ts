// Chave PIX: só aceita os caracteres do tipo e valida o formato. Usado por Reembolsos e Viagens.
export const PIX_TIPOS = ["CPF", "CNPJ", "Celular", "E-mail", "Aleatória"];
// Chave PIX conforme o tipo: só aceita os caracteres do tipo e valida o formato.
const so = (v: string) => v.replace(/\D/g, "");
export const cpfOk = (d: string) => {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n: number) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
};
export const cnpjOk = (d: string) => {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (n: number) => { const p = n === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2]; let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * p[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
};
export const PIX_REGRA: Record<string, { limpar: (v: string) => string; valido: (v: string) => boolean; dica: string; placeholder: string; max: number; modo: "numeric" | "email" | "text" }> = {
  "CPF": { limpar: (v) => so(v).slice(0, 11), valido: cpfOk, dica: "11 números, sem pontos e traço", placeholder: "12345678909", max: 11, modo: "numeric" },
  "CNPJ": { limpar: (v) => so(v).slice(0, 14), valido: cnpjOk, dica: "14 números, sem pontos, barra e traço", placeholder: "12345678000190", max: 14, modo: "numeric" },
  "Celular": { limpar: (v) => so(v).slice(0, 11), valido: (v) => /^\d{2}9\d{8}$/.test(v), dica: "DDD + número: 11 números, sem espaço ou traço", placeholder: "62999998888", max: 11, modo: "numeric" },
  "E-mail": { limpar: (v) => v.replace(/\s/g, "").toLowerCase().slice(0, 77), valido: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), dica: "Precisa ter @ (ex.: nome@empresa.com.br)", placeholder: "nome@empresa.com.br", max: 77, modo: "email" },
  "Aleatória": { limpar: (v) => v.replace(/[^0-9a-fA-F-]/g, "").toLowerCase().slice(0, 36), valido: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v), dica: "Chave de 32 letras/números com traços (como aparece no app do banco)", placeholder: "123e4567-e89b-12d3-a456-426614174000", max: 36, modo: "text" },
};
