export default function ProductShowcase() {
  const showcaseItems = [
    {
      image: '/shop/images/lifestyle-basket.jpg',
      title: 'Feito para Você',
      description: 'Cada garrafa é uma explosão de frutas frescas, pensada para quem não abre mão de qualidade.'
    },
    {
      image: '/shop/images/lifestyle-hand.jpg',
      title: 'Leve Onde Quiser',
      description: 'Praticidade sem abrir mão do frescor. Seus sucos 100% naturais sempre à mão.'
    },
    {
      image: '/shop/images/lifestyle-serving.jpg',
      title: 'Sabor Incomparável',
      description: 'A diferença entre suco de verdade e "suco" industrial está no primeiro gole.'
    }
  ];

  return (
    <section className="py-20 bg-white">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4">
            Pureza que Você Pode Ver
          </h2>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            Não tem segredo: pega a fruta, espreme, envasa.
            <br />
            Simples assim. Como deveria ser.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {showcaseItems.map((item, index) => (
            <div
              key={index}
              className="group"
              data-testid={`showcase-${index}`}
            >
              <div className="aspect-square rounded-2xl overflow-hidden mb-6 shadow-lg">
                <img
                  src={item.image}
                  alt={item.title}
                  className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                />
              </div>
              <h3 className="text-2xl font-bold text-gray-900 mb-3">
                {item.title}
              </h3>
              <p className="text-gray-600 text-lg leading-relaxed">
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
