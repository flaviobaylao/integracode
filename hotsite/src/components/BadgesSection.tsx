import { Apple, CandyOff, FlaskConicalOff, Truck } from 'lucide-react';

const STATS = [
  { value: '5.000+', label: 'clientes em Goiânia' },
  { value: '6 anos', label: 'no mercado' },
  { value: 'Diária', label: 'produção fresca' },
  { value: '4.9', label: 'avaliação média' },
];

const TRUST = [
  { icon: Apple, title: '100% suco', desc: 'Sem concentrado, sem água adicionada. Só fruta mesmo.' },
  { icon: CandyOff, title: 'Zero adição de açúcares', desc: 'O doce vem da fruta. Nenhum grama de açúcar refinado.' },
  { icon: FlaskConicalOff, title: 'Sem adição de conservantes', desc: 'Validade curta, porque o produto é de verdade.' },
  { icon: Truck, title: 'Entrega em Goiânia', desc: 'Direto da nossa produção para a sua porta, sempre fresco.' },
];

export default function BadgesSection() {
  return (
    <section className="py-16 md:py-20 bg-white">
      <div className="max-w-6xl mx-auto px-4">
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-y-8 mb-14 border-y border-black/10 py-8">
          {STATS.map((s) => (
            <div key={s.label} className="px-2">
              <dt className="sr-only">{s.label}</dt>
              <dd className="font-display text-4xl md:text-5xl font-extrabold text-honest-forest">{s.value}</dd>
              <dd className="text-sm text-gray-600 mt-1">{s.label}</dd>
            </div>
          ))}
        </dl>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 mb-14">
          {TRUST.map((t) => (
            <div key={t.title}>
              <div className="w-12 h-12 rounded-full bg-honest-light text-honest-forest flex items-center justify-center mb-4">
                <t.icon className="w-6 h-6" aria-hidden="true" />
              </div>
              <h3 className="font-display text-xl font-bold text-honest-ink mb-1">{t.title}</h3>
              <p className="text-gray-600 leading-relaxed">{t.desc}</p>
            </div>
          ))}
        </div>

        <div className="bg-honest-leaf rounded-[28px] p-7 md:p-10 md:flex md:items-center md:justify-between gap-6">
          <div>
            <p className="font-display text-2xl md:text-3xl font-extrabold text-honest-ink">
              Prefere pedir conversando?
            </p>
            <p className="text-honest-ink/80 mt-1">
              A gente monta o pedido com você pelo WhatsApp.
            </p>
          </div>
          <a
            href="https://wa.me/5562995782812?text=Olá! Quero conhecer os sucos Honest"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 md:mt-0 inline-flex items-center justify-center bg-honest-forest text-white font-bold px-8 py-4 rounded-full hover:bg-honest-ink transition-colors shrink-0"
          >
            Pedir pelo WhatsApp
          </a>
        </div>
      </div>
    </section>
  );
}
