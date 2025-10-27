import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Detecta se o usuário está em um dispositivo móvel
 */
export function isMobileDevice(): boolean {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

/**
 * Abre o WhatsApp de forma otimizada para mobile e desktop
 * Em mobile: usa window.location.href para abrir o app diretamente
 * Em desktop: usa window.open para nova aba
 */
export function openWhatsApp(url: string): void {
  if (isMobileDevice()) {
    // Em mobile, usar location.href abre o app diretamente
    window.location.href = url;
  } else {
    // Em desktop, abrir em nova aba
    window.open(url, '_blank');
  }
}
