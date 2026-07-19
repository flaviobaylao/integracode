export default function IngredientsSection() {
  const ingredients = [
    {
      name: 'Acerola',
      description: 'Rica em vitamina C e antioxidantes naturais',
      emoji: '🍒',
      color: 'from-red-400 to-orange-400'
    },
    {
      name: 'Maracujá',
      description: 'Sabor tropical e relaxante natural',
      emoji: '🥭',
      color: 'from-yellow-400 to-orange-400'
    },
    {
      name: 'Framboesa',
      description: 'Doçura natural e textura aveludada',
      emoji: '🍇',
      color: 'from-pink-400 to-rose-400'
    },
    {
      name: 'Limão',
      description: 'Refrescante e revigorante',
      emoji: '🍋',
      color: 'from-lime-400 to-green-400'
    },
    {
      name: 'Mirtilo',
      description: 'Antioxidantes poderosos para sua saúde',
      image: '/shop/images/mirtilo.jpg',
      color: 'from-blue-400 to-indigo-400'
    },
    {
      name: 'Morango',
      description: 'Sabor doce e vibrante',
      emoji: '🍓',
      color: 'from-red-400 to-pink-400'
    },
    {
      name: 'Maçã',
      description: 'Base suave e equilibrada',
      emoji: '🍎',
      color: 'from-red-500 to-yellow-400'
    },
    {
      name: 'Pera',
      description: 'Doçura delicada e refrescante',
      emoji: '🍐',
      color: 'from-green-300 to-yellow-300'
    }
  ];

  return (
    <section className="py-20 bg-gradient-to-b from-gray-50 to-white">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold text-gray-900 mb-4">
            Nossos Ingredientes
          </h2>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            Apenas 8 frutas selecionadas. Nenhum ingrediente artificial.
            <br />
            <strong>É assim que deveria ser.</strong>
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 max-w-6xl mx-auto">
          {ingredients.map((ingredient, index) => (
            <div
              key={index}
              className="group bg-white rounded-2xl p-6 shadow-sm hover:shadow-xl transition-all transform hover:-translate-y-2"
              data-testid={`ingredient-${index}`}
            >
              <div className={`aspect-square rounded-xl bg-gradient-to-br ${ingredient.color} flex items-center justify-center mb-4 overflow-hidden`}>
                {ingredient.image ? (
                  <img
                    src={ingredient.image}
                    alt={ingredient.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-6xl group-hover:scale-110 transition-transform">
                    {ingredient.emoji}
                  </span>
                )}
              </div>
              <h3 className="text-lg font-bold text-gray-900 mb-1">
                {ingredient.name}
              </h3>
              <p className="text-sm text-gray-600">
                {ingredient.description}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-16 text-center">
          <div className="inline-block bg-honest-green text-white px-8 py-4 rounded-full text-lg font-semibold">
            ✓ Frutas Frescas &nbsp;&nbsp; ✓ Sem Adição de Açúcar &nbsp;&nbsp; ✓ Sem Adição de Conservantes
          </div>
        </div>
      </div>
    </section>
  );
}
