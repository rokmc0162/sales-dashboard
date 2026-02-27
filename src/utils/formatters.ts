import type { Currency, Language } from '../types';

export function formatSales(value: number, currency: Currency, exchangeRate: number, lang: Language): string {
  const converted = currency === 'KRW' ? value * exchangeRate : value;
  const symbol = currency === 'JPY' ? '¥' : '₩';
  const okuLabel = lang === 'ko' ? '억' : '億';
  const manLabel = lang === 'ko' ? '만' : '万';

  if (converted >= 100_000_000) {
    return `${symbol}${(converted / 100_000_000).toFixed(2)}${okuLabel}`;
  }
  if (converted >= 10_000) {
    return `${symbol}${(converted / 10_000).toFixed(1)}${manLabel}`;
  }
  return `${symbol}${converted.toLocaleString()}`;
}

export function formatSalesShort(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}億`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(0)}万`;
  return value.toLocaleString();
}

export function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

export function formatDate(dateStr: string, lang: Language): string {
  const d = new Date(dateStr);
  if (lang === 'ja') {
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  }
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

export function formatMonth(monthStr: string, lang: Language): string {
  const [y, m] = monthStr.split('-');
  if (lang === 'ja') return `${y}年${parseInt(m)}月`;
  return `${y}년 ${parseInt(m)}월`;
}

export function getChangeColor(value: number): string {
  if (value > 0) return '#22c55e';
  if (value < 0) return '#ef4444';
  return '#94a3b8';
}
