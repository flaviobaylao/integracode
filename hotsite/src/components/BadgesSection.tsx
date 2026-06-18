const STATS = [
  { value: '5.000+', label: 'clientes em Goiânia', icon: '👥' },
  { value: '4 anos', label: 'no mercado', icon: '🏆' },
  { value: '2×/semana', label: 'produção fresca', icon: '🌿' },
  { value: '4.9★', label: 'avaliação média', icon: '⭐' },
];

const TRUST = [
  {
    icon: '🍓',
    title: '100% Fruta Natural',
    desc: 'Sem concentrado, sem água adicionada. Só fruta mesmo.',
    highlight: 'bg-green-50 border-green-200',
    titleColor: 'text-green-800',
  },
  {
    icon: '🚫🍬',
    title: 'Zero Açúcar Adicionado',
    desc: 'O doce vem da fruta. Nenhum grama de açúcar refinado.',
    highlight: 'bg-orange-50 border-orange-200',
    titleColor: 'text-orange-800',
  },
  {
    icon: '🧪',
    title: 'Sem Conservantes',
    desc: 'Sem química, sem mistério. Validade curta = produto real.',
    highlight: 'bg-blue-50 border-blue-200',
    titleColor: 'text-blue-800',
  },
  {
    icon: '🚚',
    title: 'Entrega em Goiânia',
    desc: 'Direto da nossa produção para a sua porta, sempre fresco.',
    highlight: 'bg-purple-50 border-purple-200',
    titleColor: 'text-purple-800',
  },
];

export default function BadgesSection() {
  return (
    <section className="py-16 bg-white">
      <div className="container mx-auto px-4 max-w-5xl">

        {/* Stats strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-14">
          {STATS.map((s) => (
            <div key={s.value} className="text-center p-4 rounded-2xl bg-gray-50 border border-gray-100">
              <div className="text-2xl mb-1">{s.icon}</div>
              <div className="text-2xl font-extrabold text-gray-900">{s.value}</div>
              <div className="text-sm text-gray-500 leading-tight mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Trust cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-12">
          {TRUST.map((t) => (
            <div
              key={t.title}
              className={`flex items-start gap-4 p-6 rounded-2xl border-2 ${t.highlight} transition-transform hover:scale-[1.02]`}
            >
              <span className="text-4xl leading-none">{t.icon}</span>
              <div>
                <h3 className={`text-lg font-bold mb-1 ${t.titleColor}`}>{t.title}</h3>
                <p className="text-gray-700 text-sm leading-relaxed">{t.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Bottom CTA strip */}
        <div className="bg-gradient-to-r from-honest-green to-green-700 rounded-2xl p-6 md:p-8 text-white text-center">
          <p className="text-xl md:text-2xl font-bold mb-2">
            Pronto para tomar algo de verdade?
          </p>
          <p className="text-green-100 mb-5 text-sm md:text-base">
            Junte-se a mais de 5.000 famílias que já trocaram o suco artificial pelo Honest.
          </p>
          <a
            href="https://wa.me/556299578281?text=Olá! Quero conhecer os sucos Honest"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-white text-honest-green font-bold px-8 py-3 rounded-full hover:bg-green-50 transition-colors shadow-md"
          >
            💬 Pedir pelo WhatsApp
          </a>
        </div>

      </div>
    </section>
  );
}
