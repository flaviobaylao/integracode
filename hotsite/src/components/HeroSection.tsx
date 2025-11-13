export default function HeroSection() {
  return (
    <section className="relative min-h-[90vh] flex items-center justify-center overflow-hidden">
      <div className="absolute inset-0 z-0">
        <img
          src="/shop/images/hero-linha-produtos.jpg"
          alt="Linha Honest de Sucos Naturais"
          className="w-full h-full object-cover object-center"
        />
        <div className="absolute inset-0 bg-black/20" />
      </div>

      <div className="relative z-10 text-center text-white px-4 max-w-4xl mx-auto">
        <h1 className="text-5xl md:text-7xl font-bold mb-6 drop-shadow-2xl leading-tight">
          100% Fruta.
          <br />
          <span className="text-6xl md:text-8xl">Zero Mentira.</span>
        </h1>
        
        <p className="text-xl md:text-2xl mb-8 drop-shadow-lg max-w-2xl mx-auto leading-relaxed">
          Sem açúcar adicionado. Sem conservantes. Sem enrolação.<br />
          <strong>Apenas frutas selecionadas direto da fazenda.</strong>
        </p>
        
        <button
          onClick={() => {
            const productsSection = document.getElementById('products');
            productsSection?.scrollIntoView({ behavior: 'smooth' });
          }}
          className="bg-white text-honest-green px-10 py-5 rounded-full text-lg font-bold hover:bg-green-50 transform hover:scale-105 transition-all shadow-2xl"
          data-testid="btn-hero-cta"
        >
          Experimentar Agora 🍓
        </button>
      </div>

      <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 z-10 animate-bounce">
        <svg className="w-8 h-8 text-white drop-shadow-lg" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
        </svg>
      </div>
    </section>
  );
}
