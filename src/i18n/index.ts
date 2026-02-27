import ko from './ko.json';
import ja from './ja.json';
import type { Language } from '../types';

const translations: Record<Language, typeof ko> = { ko, ja };

export function t(lang: Language, key: string): string {
  const keys = key.split('.');
  let value: any = translations[lang];
  for (const k of keys) {
    value = value?.[k];
  }
  return value ?? key;
}

export { ko, ja };
