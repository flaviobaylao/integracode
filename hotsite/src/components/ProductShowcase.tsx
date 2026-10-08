export default function ProductShowcase() {
  const showcaseItems = [
    {
      image: '/shop/images/cenas/acerola-pomar.webp',
      title: 'Começa no pé',
      description: 'Fruta escolhida, espremida e envasada. Sem concentrado e sem água adicionada.'
    },
    {
      image: '/shop/images/cenas/morango-maracuja-cozinha.webp',
      title: 'Na mesa de casa',
      description: 'No café da manhã, no almoço ou no lanche da tarde.'
    },
    {
      image: '/shop/images/cenas/pink-lemonade-splash-2.webp',
      title: 'Gelado é melhor',
      description: 'Mantenha refrigerado e sirva bem gelado.'
    }
  ];

  return (
    <section className="py-16 md:py-24 bg-white">
      <div className="max-w-6xl mx-auto px-4">
        <div className="max-w-2xl mb-12">
          <h2 className="font-display text-4xl md:text-5xl font-extrabold text-honest-ink">
            Pega a fruta, espreme, envasa.
          </h2>
          <p className="text-lg text-gray-600 mt-3">
            Não tem segredo. Simples assim, como deveria ser.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {showcaseItems.map((item, index) => (
            <figure key={index} data-testid={`showcase-${index}`}>
              <div className="aspect-[4/5] rounded-3xl overflow-hidden mb-5 bg-honest-light">
                <img src={item.image} alt={item.title} className="w-full h-full object-cover" loading="lazy" />
              </div>
              <figcaption>
                <h3 className="font-display text-2xl font-bold text-honest-ink mb-2">{item.title}</h3>
                <p className="text-gray-600 leading-relaxed">{item.description}</p>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
