import { toZonedTime, fromZonedTime } from 'date-fns-tz';

export const BRAZIL_TZ = 'America/Sao_Paulo';

export function nowBrazil(): Date {
  return toZonedTime(new Date(), BRAZIL_TZ);
}

export function toBrazilTime(date: Date): Date {
  return toZonedTime(date, BRAZIL_TZ);
}

export function fromBrazilTime(date: Date): Date {
  return fromZonedTime(date, BRAZIL_TZ);
}

export function todayBrazilMidnight(): Date {
  const now = nowBrazil();
  now.setHours(0, 0, 0, 0);
  return fromZonedTime(now, BRAZIL_TZ);
}

export function formatBrazilDateTime(date: Date): string {
  const brt = toZonedTime(date, BRAZIL_TZ);
  const d = String(brt.getDate()).padStart(2, '0');
  const m = String(brt.getMonth() + 1).padStart(2, '0');
  const y = brt.getFullYear();
  const h = String(brt.getHours()).padStart(2, '0');
  const min = String(brt.getMinutes()).padStart(2, '0');
  return `${d}/${m}/${y} ${h}:${min}`;
}

export function formatBrazilDate(date: Date): string {
  const brt = toZonedTime(date, BRAZIL_TZ);
  const d = String(brt.getDate()).padStart(2, '0');
  const m = String(brt.getMonth() + 1).padStart(2, '0');
  const y = brt.getFullYear();
  return `${d}/${m}/${y}`;
}

export function getBrazilDateString(date?: Date): string {
  const brt = date ? toZonedTime(date, BRAZIL_TZ) : nowBrazil();
  const y = brt.getFullYear();
  const m = String(brt.getMonth() + 1).padStart(2, '0');
  const d = String(brt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

export function getBrazilDayOfWeek(): number {
  return nowBrazil().getDay();
}
