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
  return (
    <section className="py-16 md:py-20 bg-honest-forest text-white overflow-hidden">
      <div className="max-w-6xl mx-auto px-4">
        <h2 className="font-display text-4xl md:text-5xl font-extrabold max-w-2xl">
          Cada sabor tem a sua fruta.
        </h2>
        <p className="text-lg text-white/80 mt-3 max-w-xl">
          Arraste para ver e toque para escolher.
        </p>
      </div>

      <div className="mt-10 max-w-6xl mx-auto px-4">
        <div className="-mx-4 px-4 flex gap-4 overflow-x-auto no-scrollbar snap-x snap-mandatory pb-2">
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
