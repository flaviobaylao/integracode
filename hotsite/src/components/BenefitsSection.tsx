import { Heart, Zap, Smile, Award } from 'lucide-react';

export default function BenefitsSection() {
  const benefits = [
    {
      icon: Heart,
      title: 'Saúde de Verdade',
      description: 'Sem açúcar adicionado, sem conservantes químicos. Apenas o que a natureza oferece de melhor para seu corpo.'
    },
    {
      icon: Zap,
      title: 'Energia Natural',
      description: 'Vitaminas e nutrientes preservados pelo processo artesanal. Combustível limpo para seu dia.'
    },
    {
      icon: Smile,
      title: 'Sabor Autêntico',
      description: 'A diferença entre suco e "bebida de suco" está no primeiro gole. Prove você mesmo.'
    },
    {
      icon: Award,
      title: 'Qualidade Garantida',
      description: 'Seleção rigorosa de frutas, produção local e controle total do processo. Nada de industrialização em massa.'
    }
  ];

  return (
    <section className="py-20 bg-gradient-to-br from-honest-green to-green-700 text-white relative overflow-hidden">
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-0 left-0 w-96 h-96 bg-white rounded-full blur-3xl"></div>
        <div className="absolute bottom-0 right-0 w-96 h-96 bg-white rounded-full blur-3xl"></div>
      </div>

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4">
            Por Que Escolher Honest?
          </h2>
          <p className="text-xl opacity-90 max-w-2xl mx-auto">
            Porque você merece mais do que rótulos enganosos e ingredientes que você não consegue pronunciar.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 max-w-7xl mx-auto">
          {benefits.map((benefit, index) => (
            <div
              key={index}
              className="bg-white/10 backdrop-blur-sm rounded-2xl p-8 hover:bg-white/20 transition-all"
              data-testid={`benefit-${index}`}
            >
              <div className="bg-white/20 w-16 h-16 rounded-full flex items-center justify-center mb-6">
                <benefit.icon className="w-8 h-8" />
              </div>
              <h3 className="text-2xl font-bold mb-4">
                {benefit.title}
              </h3>
              <p className="opacity-90 leading-relaxed">
                {benefit.description}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-16 text-center">
          <button
            onClick={() => {
              const productsSection = document.getElementById('products');
              productsSection?.scrollIntoView({ behavior: 'smooth' });
            }}
            className="bg-white text-honest-green px-10 py-5 rounded-full text-lg font-bold hover:bg-gray-100 transform hover:scale-105 transition-all shadow-xl"
            data-testid="btn-benefits-cta"
          >
            Quero Experimentar 🍓
          </button>
        </div>
      </div>
    </section>
  );
}
