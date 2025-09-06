// Utilitário para cores consistentes de vendedores em toda a aplicação

export const VENDOR_COLORS = [
  'bg-blue-500 text-white',
  'bg-green-500 text-white', 
  'bg-purple-500 text-white',
  'bg-orange-500 text-white',
  'bg-red-500 text-white',
  'bg-pink-500 text-white',
  'bg-indigo-500 text-white',
  'bg-teal-500 text-white',
  'bg-yellow-500 text-white',
  'bg-cyan-500 text-white'
];

// Gerar cores consistentes para vendedores baseado no ID
export const getVendorColor = (sellerId: string): string => {
  // Usar hash do ID para gerar índice consistente
  let hash = 0;
  for (let i = 0; i < sellerId.length; i++) {
    const char = sellerId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  return VENDOR_COLORS[Math.abs(hash) % VENDOR_COLORS.length];
};

// Obter iniciais do nome do vendedor
export const getVendorInitials = (sellerName: string): string => {
  const names = sellerName.trim().split(' ');
  if (names.length === 1) {
    return names[0].substring(0, 2).toUpperCase();
  }
  return (names[0][0] + names[names.length - 1][0]).toUpperCase();
};

// Obter versão mais clara da cor para backgrounds
export const getVendorColorLight = (sellerId: string): string => {
  const colorIndex = Math.abs(sellerId.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) & 0, 0)) % VENDOR_COLORS.length;
  
  const lightColors = [
    'bg-blue-100 text-blue-800',
    'bg-green-100 text-green-800', 
    'bg-purple-100 text-purple-800',
    'bg-orange-100 text-orange-800',
    'bg-red-100 text-red-800',
    'bg-pink-100 text-pink-800',
    'bg-indigo-100 text-indigo-800',
    'bg-teal-100 text-teal-800',
    'bg-yellow-100 text-yellow-800',
    'bg-cyan-100 text-cyan-800'
  ];
  
  return lightColors[colorIndex];
};