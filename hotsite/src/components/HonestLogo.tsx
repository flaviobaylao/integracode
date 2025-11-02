interface HonestLogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showText?: boolean;
}

export function HonestLogo({ className = '', size = 'md', showText = true }: HonestLogoProps) {
  const sizes = {
    sm: { logo: 'h-8 w-8', text: 'text-lg' },
    md: { logo: 'h-12 w-12', text: 'text-2xl' },
    lg: { logo: 'h-16 w-16', text: 'text-3xl' },
    xl: { logo: 'h-24 w-24', text: 'text-4xl' },
  };

  const currentSize = sizes[size];

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {/* Logo Icon - Folha com gota de suco */}
      <svg
        className={currentSize.logo}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Folha */}
        <path
          d="M50 10 C 70 10, 85 25, 85 45 C 85 65, 70 80, 50 90 C 30 80, 15 65, 15 45 C 15 25, 30 10, 50 10 Z"
          fill="#22c55e"
          className="drop-shadow-md"
        />
        {/* Nervura central */}
        <path
          d="M50 15 L50 85"
          stroke="#16a34a"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {/* Nervuras laterais */}
        <path
          d="M50 30 Q 60 35, 68 42"
          stroke="#16a34a"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M50 30 Q 40 35, 32 42"
          stroke="#16a34a"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M50 50 Q 58 52, 65 56"
          stroke="#16a34a"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M50 50 Q 42 52, 35 56"
          stroke="#16a34a"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        {/* Gota de suco laranja */}
        <ellipse
          cx="50"
          cy="55"
          rx="8"
          ry="10"
          fill="#f97316"
          className="drop-shadow-lg"
        />
        {/* Brilho na gota */}
        <ellipse
          cx="48"
          cy="52"
          rx="2"
          ry="3"
          fill="#fbbf24"
          opacity="0.7"
        />
      </svg>

      {/* Texto */}
      {showText && (
        <div className="flex flex-col leading-tight">
          <span className={`font-bold ${currentSize.text}`}>
            Honest
          </span>
          <span className="text-xs font-medium tracking-wider opacity-90">
            SUCOS NATURAIS
          </span>
        </div>
      )}
    </div>
  );
}
