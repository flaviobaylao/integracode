import { Leaf, Droplet, Shield } from 'lucide-react';

export default function BadgesSection() {
  const badges = [
    {
      icon: Leaf,
      title: '100% FRUTA',
      description: 'Feito com frutas naturais',
      color: 'text-green-600'
    },
    {
      icon: Droplet,
      title: 'SEM AÇÚCAR ADICIONADO',
      description: 'Adoçado naturalmente',
      color: 'text-blue-600'
    },
    {
      icon: Shield,
      title: 'SEM ADIÇÃO DE CONSERVANTES',
      description: 'Puro e natural',
      color: 'text-rose-600'
    }
  ];

  return (
    <section className="py-16 bg-white">
      <div className="container mx-auto px-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {badges.map((badge, index) => (
            <div
              key={index}
              className="text-center p-8 rounded-2xl hover:bg-gray-50 transition-all group"
              data-testid={`badge-${index}`}
            >
              <div className={`inline-flex items-center justify-center w-20 h-20 rounded-full bg-gray-100 mb-6 group-hover:scale-110 transition-transform ${badge.color}`}>
                <badge.icon className="w-10 h-10" />
              </div>
              <h3 className="text-2xl font-bold text-gray-900 mb-2">
                {badge.title}
              </h3>
              <p className="text-gray-600 text-lg">
                {badge.description}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center max-w-3xl mx-auto">
          <div className="bg-gradient-to-r from-rose-50 to-pink-50 border-2 border-rose-200 rounded-2xl p-8">
            <p className="text-2xl font-bold text-gray-900 mb-3">
              Direto da Fazenda para Você
            </p>
            <p className="text-lg text-gray-700 leading-relaxed">
              Cada garrafa leva <strong>frutas frescas</strong> selecionadas.
              Nada mais, nada menos. É como espremer as frutas na hora,
              mas com a praticidade de ter sempre à mão.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
