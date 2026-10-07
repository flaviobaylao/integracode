export default function ProductShowcase() {
  const showcaseItems = [
    {
      image: '/shop/images/lifestyle-basket.jpg',
      title: 'Feito para você',
      description: 'Cada garrafa é fruta fresca, pensada para quem não abre mão de qualidade.'
    },
    {
      image: '/shop/images/lifestyle-hand.jpg',
      title: 'Leve aonde quiser',
      description: 'A garrafa de 350 ml vai na bolsa, na lancheira e na mesa do trabalho.'
    },
    {
      image: '/shop/images/lifestyle-serving.jpg',
      title: 'Para a família',
      description: 'A de 900 ml rende o café da manhã da casa toda.'
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
