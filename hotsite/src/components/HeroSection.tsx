import { useState, useEffect } from 'react';

const SOCIAL_PROOF = [
  { value: '5.000+', label: 'clientes satisfeitos' },
  { value: '4.9★', label: 'avaliação média' },
  { value: '100%', label: 'fruta natural' },
  { value: '2×', label: 'produção por semana' },
];

export default function HeroSection() {
  const [urgency, setUrgency] = useState('');

  useEffect(() => {
    const day = new Date().getDay(); // 0=Sun … 6=Sat
    if (day === 1 || day === 2) {
      setUrgency('🔥 Novo lote disponível esta semana — quantidade limitada!');
    } else if (day === 3 || day === 4) {
      setUrgency('⚡ Últimas unidades do lote desta semana!');
    } else {
      setUrgency('🌱 Próximo lote fresco chega na segunda-feira!');
    }
  }, []);

  const scrollToProducts = () => {
    document.getElementById('products')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <section className="relative min-h-[95vh] flex flex-col items-center justify-center overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 z-0">
        <img
          src="/shop/images/hero-linha-produtos.jpg"
          alt="Linha Honest de Sucos Naturais"
          className="w-full h-full object-cover object-center"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/30 to-black/60" />
      </div>

      {/* Urgency bar */}
      {urgency && (
        <div className="relative z-10 w-full bg-honest-orange/90 backdrop-blur-sm text-white text-center text-sm font-semibold py-2.5 px-4">
          {urgency}
        </div>
      )}

      {/* Hero content */}
      <div className="relative z-10 text-center text-white px-4 max-w-4xl mx-auto flex-1 flex flex-col items-center justify-center py-12">
        {/* Social proof stars */}
        <div className="flex items-center gap-1 mb-6 bg-white/15 backdrop-blur-sm rounded-full px-4 py-2">
          <span className="text-yellow-400 text-lg">★★★★★</span>
          <span className="text-sm font-medium ml-1">+5.000 clientes felizes em Goiânia e região</span>
        </div>

        <h1 className="text-5xl md:text-7xl font-extrabold mb-5 drop-shadow-2xl leading-tight tracking-tight">
          100% Fruta.
          <br />
          <span className="text-honest-orange">Zero Mentira.</span>
        </h1>

        <p className="text-lg md:text-xl mb-8 drop-shadow-lg max-w-xl mx-auto leading-relaxed opacity-95">
          Sem açúcar adicionado. Sem conservantes. Direto da fazenda para sua mesa em até 48h. 🍓
        </p>

        {/* Dual CTA */}
        <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm mx-auto mb-10">
          <button
            onClick={scrollToProducts}
            className="flex-1 bg-honest-green hover:bg-green-700 text-white px-8 py-4 rounded-full text-lg font-bold transform hover:scale-105 transition-all shadow-2xl"
            data-testid="btn-hero-cta"
          >
            Comprar Agora 🛒
          </button>
          <a
            href="https://wa.me/5562995782812?text=Olá! Quero conhecer os sucos Honest"
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 bg-white/20 backdrop-blur-sm hover:bg-white/30 border-2 border-white text-white px-8 py-4 rounded-full text-lg font-bold transform hover:scale-105 transition-all text-center"
          >
            💬 WhatsApp
          </a>
        </div>

        {/* Social proof numbers */}
        <div className="grid grid-cols-4 gap-3 w-full max-w-2xl">
          {SOCIAL_PROOF.map((item, i) => (
            <div key={i} className="bg-white/15 backdrop-blur-sm rounded-2xl p-3 text-center">
              <div className="text-2xl md:text-3xl font-extrabold text-white">{item.value}</div>
              <div className="text-xs text-white/80 leading-tight mt-0.5">{item.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 animate-bounce">
        <svg className="w-7 h-7 text-white/70 drop-shadow-lg" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
        </svg>
      </div>
    </section>
  );
}
