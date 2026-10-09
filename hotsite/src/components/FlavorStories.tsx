import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { FOTOS, SABORES } from '../utils/garrafas';

// 📸 Sabores em cena — fotos de produto em faixa horizontal; tocar leva ao cartão do sabor.
const CENAS: { sabor: string; foto: string }[] = [
  { sabor: 'acerola', foto: FOTOS['acerola'][0] },
  { sabor: 'pink-lemonade', foto: FOTOS['pink-lemonade'][0] },
  { sabor: 'uva', foto: FOTOS['uva'][0] },
  { sabor: 'morango-maracuja', foto: FOTOS['morango-maracuja'][0] },
  { sabor: 'limonada', foto: FOTOS['limonada'][0] },
];

export default function FlavorStories() {
  // Setas (computador): passam um cartão por vez. No celular continua o arrastar.
  const trilho = useRef<HTMLDivElement>(null);
  const [podeVoltar, setPodeVoltar] = useState(false);
  const [podeAvancar, setPodeAvancar] = useState(true);
  const atualizar = () => {
    const el = trilho.current;
    if (!el) return;
    setPodeVoltar(el.scrollLeft > 4);
    setPodeAvancar(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };
  useEffect(() => {
    atualizar();
    window.addEventListener('resize', atualizar);
    return () => window.removeEventListener('resize', atualizar);
  }, []);
  const mover = (dir: 1 | -1) => {
    const el = trilho.current;
    if (!el) return;
    const card = el.querySelector('a') as HTMLElement | null;
    const passo = card ? card.offsetWidth + 16 : el.clientWidth * 0.8;
    el.scrollBy({ left: dir * passo, behavior: 'smooth' });
  };
  const seta = 'hidden md:flex w-12 h-12 rounded-full items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-default';

  return (
    <section className="py-16 md:py-20 bg-honest-forest text-white overflow-hidden">
      <div className="max-w-6xl mx-auto px-4 flex items-end justify-between gap-6">
        <div>
        <h2 className="font-display text-4xl md:text-5xl font-extrabold max-w-2xl">
          Cada sabor tem a sua fruta.
        </h2>
        <p className="text-lg text-white/80 mt-3 max-w-xl">
          <span className="md:hidden">Arraste para ver e toque para escolher.</span>
          <span className="hidden md:inline">Use as setas para ver e clique para escolher.</span>
        </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button type="button" onClick={() => mover(-1)} disabled={!podeVoltar} aria-label="Sabor anterior"
            className={`${seta} border-2 border-white/40 text-white hover:border-white`}>
            <ChevronLeft className="w-6 h-6" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => mover(1)} disabled={!podeAvancar} aria-label="Próximo sabor"
            className={`${seta} bg-honest-leaf text-honest-ink hover:bg-[#8BCB55]`}>
            <ChevronRight className="w-6 h-6" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="mt-10 max-w-6xl mx-auto px-4">
        <div ref={trilho} onScroll={atualizar} className="-mx-4 px-4 flex gap-4 overflow-x-auto no-scrollbar snap-x snap-mandatory pb-2 scroll-px-4">
          {CENAS.map(({ sabor, foto }) => {
            const s = SABORES.find(x => x.key === sabor)!;
            return (
              <a
                key={sabor}
                href={`#sabor-${sabor}`}
                className="group relative shrink-0 snap-start w-[72vw] sm:w-[300px] aspect-[4/5] rounded-[28px] overflow-hidden"
                style={{ backgroundColor: s.cor }}
              >
                <img
                  src={foto}
                  alt={`Honest ${s.nome}`}
                  className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                  loading="lazy"
                />
                <div className="absolute inset-x-0 bottom-0 p-5 bg-gradient-to-t from-black/60 to-transparent">
                  <span className="font-display text-2xl font-bold">{s.nome}</span>
                </div>
              </a>
            );
          })}
        </div>
      </div>
    </section>
  );
}
