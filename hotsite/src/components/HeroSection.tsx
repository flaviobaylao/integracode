import { useState, useEffect } from 'react';
import { garrafaUrl, type Tamanho } from '../utils/garrafas';

// 🍾 Garrafas do topo: poucas e espaçadas, alternando 900 ml e 350 ml.
const PRATELEIRA: { sabor: string; nome: string; tamanho: Tamanho }[] = [
  { sabor: 'acerola', nome: 'Acerola', tamanho: '900' },
  { sabor: 'pink-lemonade', nome: 'Pink lemonade', tamanho: '350' },
  { sabor: 'uva', nome: 'Uva', tamanho: '900' },
  { sabor: 'maracuja', nome: 'Maracujá', tamanho: '350' },
];

export default function HeroSection() {
  const [urgency, setUrgency] = useState('');

  useEffect(() => {
    const day = new Date().getDay(); // 0=Sun … 6=Sat
    if (day === 1 || day === 2) {
      setUrgency('Produção fresca todo dia. Peça agora e receba em até 48h.');
    } else if (day === 3 || day === 4) {
      setUrgency('Sucos produzidos hoje. A quantidade do dia é limitada.');
    } else {
      setUrgency('Produção diária, sempre fresco, direto da fábrica para você.');
    }
  }, []);

  const scrollToProducts = () => {
    document.getElementById('products')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <section className="relative bg-honest-forest text-white overflow-hidden">
      {urgency && (
        <div className="bg-honest-leaf text-honest-ink text-center text-sm font-semibold py-2 px-4">
          {urgency}
        </div>
      )}

      {/* folha da marca, enorme, como textura de fundo */}
      <svg
        viewBox="0 0 100 120"
        className="absolute -right-24 -top-10 w-[520px] md:w-[760px] opacity-[0.07] pointer-events-none"
        aria-hidden="true"
      >
        <path d="M50 0 C80 30 100 55 100 78 A50 42 0 0 1 0 78 C0 55 20 30 50 0Z" fill="#76B742" />
        {[30, 45, 60, 75, 90].map(y => (
          <g key={y} stroke="#174328" strokeWidth="2.5">
            <line x1="50" y1={y} x2="20" y2={y + 14} />
            <line x1="50" y1={y} x2="80" y2={y + 14} />
          </g>
        ))}
        <line x1="50" y1="8" x2="50" y2="118" stroke="#174328" strokeWidth="2.5" />
      </svg>

      <div className="relative max-w-6xl mx-auto px-4 lg:grid lg:grid-cols-2 lg:gap-10 lg:items-end">
        <div className="pt-12 md:pt-20 lg:pb-20">
        <p className="text-sm text-white/80 mb-5">
          <span className="text-[#F6C51E] tracking-wider mr-2" aria-hidden="true">★★★★★</span>
          +1.200 clientes em Goiânia e região
        </p>

        <h1 className="font-display font-extrabold text-[44px] leading-[0.95] sm:text-6xl md:text-[84px] lg:text-[76px] xl:text-[84px] max-w-3xl">
          100% fruta.
          <br />
          Zero mentira.
        </h1>

        <p className="mt-6 text-lg md:text-xl text-white/85 max-w-xl lg:max-w-md leading-relaxed">
          Oito sabores de suco misto, sem adição de açúcares e sem adição de conservantes.
          Feitos em Bela Vista de Goiás, em garrafas de 350 ml e 900 ml.
        </p>

        <div className="mt-8 flex flex-col sm:flex-row gap-3 max-w-md">
          <button
            onClick={scrollToProducts}
            className="flex-1 bg-honest-leaf hover:bg-[#8BCB55] text-honest-ink px-7 py-4 rounded-full text-lg font-bold transition-colors"
            data-testid="btn-hero-cta"
          >
            Escolher sabores
          </button>
          <a
            href="https://wa.me/5562995782812?text=Olá! Quero conhecer os sucos Honest"
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 border-2 border-white/40 hover:border-white text-white px-7 py-4 rounded-full text-lg font-semibold transition-colors text-center"
          >
            Falar no WhatsApp
          </a>
        </div>
      </div>

        {/* Prateleira */}
        <div className="mt-10 lg:mt-0 flex items-end justify-center gap-[5vw] sm:gap-10 lg:gap-8 xl:gap-12">
          {PRATELEIRA.map((g, i) => (
            <img
              key={g.sabor}
              src={garrafaUrl(g.sabor, g.tamanho, true)}
              alt={`${g.nome} ${g.tamanho} ml`}
              className={`garrafa-sobe garrafa-sombra relative w-auto shrink-0 ${g.tamanho === '900' ? 'garrafa-900' : 'garrafa-350'}`}
              style={{ animationDelay: `${120 + i * 110}ms`, zIndex: i }}
            />
          ))}
        </div>
      </div>

      <div className="relative">
        {/* tampo da prateleira */}
        <div className="relative z-10 h-6 md:h-8 bg-[#0F2E1B] border-t-4 border-honest-leaf/40" />
      </div>
    </section>
  );
}
