export const BRAZIL_TZ = 'America/Sao_Paulo';

export function nowBrazil(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: BRAZIL_TZ }));
}

export function formatDateBR(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('pt-BR', { timeZone: BRAZIL_TZ });
}

export function formatDateTimeBR(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('pt-BR', { timeZone: BRAZIL_TZ });
}

export function formatTimeBR(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString('pt-BR', {
    timeZone: BRAZIL_TZ,
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateLongBR(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('pt-BR', {
    timeZone: BRAZIL_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getBrazilMonth(): number {
  return nowBrazil().getMonth() + 1;
}

export function getBrazilYear(): number {
  return nowBrazil().getFullYear();
}

export function getBrazilDay(): number {
  return nowBrazil().getDate();
}

export function getBrazilDateISO(): string {
  const d = nowBrazil();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
