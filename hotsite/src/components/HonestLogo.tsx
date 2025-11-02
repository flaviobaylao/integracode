interface HonestLogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

export function HonestLogo({ className = '', size = 'md' }: HonestLogoProps) {
  const sizes = {
    sm: 'h-10',
    md: 'h-14',
    lg: 'h-20',
    xl: 'h-28',
  };

  const currentSize = sizes[size];

  return (
    <div className={`flex items-center ${className}`}>
      <img
        src="/shop/honest-logo.png"
        alt="Honest Sucos - Sucos e Bebidas Naturais"
        className={`${currentSize} w-auto object-contain`}
      />
    </div>
  );
}
