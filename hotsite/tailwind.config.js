/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Paleta tirada do logo e das garrafas (out/2026)
        'honest-green': '#2C7A3F',   // verde de ação (botões, preços)
        'honest-forest': '#174328',  // verde escuro do logo / tampa
        'honest-leaf': '#76B742',    // verde da folha
        'honest-paper': '#F4F6EE',   // fundo claro levemente esverdeado
        'honest-ink': '#14261A',     // texto
        'honest-orange': '#E8691E',
        'honest-light': '#E6F0DC',
      },
      fontFamily: {
        sans: ['Figtree', 'system-ui', 'sans-serif'],
        display: ['"Bricolage Grotesque"', 'Figtree', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
