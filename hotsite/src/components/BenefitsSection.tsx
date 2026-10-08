import { Heart, Zap, Smile, Award } from 'lucide-react';

export default function BenefitsSection() {
  const benefits = [
    {
      icon: Heart,
      title: 'Saúde de verdade',
      description: 'Sem açúcar adicionado e sem adição de conservantes. Apenas o que a fruta oferece.'
    },
    {
      icon: Zap,
      title: 'Energia natural',
      description: 'Vitaminas e nutrientes da fruta, para acompanhar o seu dia.'
    },
    {
      icon: Smile,
      title: 'Sabor autêntico',
      description: 'A diferença entre suco e "bebida de suco" está no primeiro gole.'
    },
    {
      icon: Award,
      title: 'Qualidade garantida',
      description: 'Seleção de frutas, produção local e controle de todo o processo.'
    }
  ];

  return (
    <section className="py-16 md:py-24 bg-honest-paper">
      <div className="max-w-6xl mx-auto px-4">
        <div className="max-w-2xl mb-12">
          <h2 className="font-display text-4xl md:text-5xl font-extrabold text-honest-ink">
            Por que Honest?
          </h2>
          <p className="text-lg text-gray-600 mt-3">
            Porque você merece mais do que rótulos enganosos e ingredientes que não consegue pronunciar.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {benefits.map((benefit, index) => (
            <div key={index} className="bg-white rounded-3xl p-6" data-testid={`benefit-${index}`}>
              <benefit.icon className="w-7 h-7 text-honest-green mb-5" aria-hidden="true" />
              <h3 className="font-display text-xl font-bold text-honest-ink mb-2">{benefit.title}</h3>
              <p className="text-gray-600 leading-relaxed">{benefit.description}</p>
            </div>
          ))}
        </div>

        <div className="mt-12">
          <button
            onClick={() => document.getElementById('products')?.scrollIntoView({ behavior: 'smooth' })}
            className="bg-honest-green text-white px-8 py-4 rounded-full text-lg font-bold hover:bg-honest-forest transition-colors"
            data-testid="btn-benefits-cta"
          >
            Escolher sabores
          </button>
        </div>
      </div>
    </section>
  );
}
