// ═══════════════════════════════════════════════════════════════════════════
// SELETOR DE MÊS — atalho para o período, usado nas abas Fiscal e Contábil.
//
// Os campos "De" e "Até" continuam lá e valendo: este seletor só PREENCHE os
// dois de uma vez (1º ao último dia do mês, ou 1º de janeiro a 31 de dezembro
// quando o mês é "Ano todo"). Mexer no calendário na mão continua funcionando —
// nesse caso o seletor mostra "Personalizado", porque as datas deixaram de
// coincidir com um mês fechado.
// ═══════════════════════════════════════════════════════════════════════════

const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const p2 = (n: number) => String(n).padStart(2, "0");
const ultimoDia = (ano: number, mes1a12: number) => new Date(Date.UTC(ano, mes1a12, 0)).getUTCDate();

export default function SeletorMes({
  inicio,
  fim,
  aoMudar,
  anoMinimo = 2025,
}: {
  inicio: string;
  fim: string;
  aoMudar: (inicio: string, fim: string) => void;
  anoMinimo?: number;
}) {
  const anoAtual = new Date().getFullYear();
  const anos: number[] = [];
  for (let a = anoAtual; a >= anoMinimo; a--) anos.push(a);

  // Descobre se o período atual é exatamente um mês fechado ou um ano fechado.
  const [ai, mi, di] = inicio.split("-").map(Number);
  const [af, mf, df] = fim.split("-").map(Number);
  const mesFechado = ai === af && mi === mf && di === 1 && df === ultimoDia(af, mf);
  const anoFechado = ai === af && mi === 1 && di === 1 && mf === 12 && df === 31;

  const ano = ai || anoAtual;
  const valorMes = anoFechado ? "ano" : mesFechado ? String(mi) : "";

  const aplicar = (novoAno: number, mes: string) => {
    if (mes === "ano") {
      aoMudar(`${novoAno}-01-01`, `${novoAno}-12-31`);
      return;
    }
    const m = Number(mes);
    aoMudar(`${novoAno}-${p2(m)}-01`, `${novoAno}-${p2(m)}-${p2(ultimoDia(novoAno, m))}`);
  };

  const mesAnterior = (passo: number) => {
    // Anda de mês em mês a partir do mês do início, mesmo que o período esteja
    // personalizado — o usuário vê o resultado nas datas.
    const base = new Date(Date.UTC(ano, (mi || 1) - 1 + passo, 1));
    aplicar(base.getUTCFullYear(), String(base.getUTCMonth() + 1));
  };

  const classeSelect =
    "h-10 rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-slate-400";

  return (
    <div className="flex items-end gap-2" data-testid="seletor-mes">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Mês</label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => mesAnterior(-1)}
            title="Mês anterior"
            className="h-10 w-8 rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
            data-testid="seletor-mes-anterior"
          >
            ‹
          </button>
          <select
            value={valorMes}
            onChange={(e) => e.target.value && aplicar(ano, e.target.value)}
            className={classeSelect}
            data-testid="seletor-mes-select"
          >
            {!valorMes && <option value="">Personalizado</option>}
            <option value="ano">Ano todo</option>
            {MESES.map((nome, k) => (
              <option key={nome} value={String(k + 1)}>{nome}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => mesAnterior(1)}
            title="Mês seguinte"
            className="h-10 w-8 rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
            data-testid="seletor-mes-seguinte"
          >
            ›
          </button>
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Ano</label>
        <select
          value={ano}
          onChange={(e) => aplicar(Number(e.target.value), valorMes || String(mi || 1))}
          className={classeSelect}
          data-testid="seletor-ano-select"
        >
          {anos.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
    </div>
  );
}
