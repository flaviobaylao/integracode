interface HonestLogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showText?: boolean;
}

export function HonestLogo({ className = '', size = 'md', showText = true }: HonestLogoProps) {
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
        src="/honest-logo.png"
        alt="Honest Sucos - Sucos e Bebidas Naturais"
        className={`${currentSize} w-auto object-contain`}
      />
    </div>
  );
}
