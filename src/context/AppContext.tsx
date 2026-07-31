'use client';

import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

type Language = 'ko' | 'ja';
type Currency = 'JPY' | 'KRW';
type Theme = 'dark' | 'light';

interface AppContextType {
  lang: Language;
  setLang: (l: Language) => void;
  currency: Currency;
  setCurrency: (c: Currency) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  t: (ko: string, ja: string) => string;
  formatCurrency: (amountJPY: number) => string;
}

const JPY_TO_KRW = 9.2;

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Language>('ko');
  const [currency, setCurrency] = useState<Currency>('JPY');
  const [theme, setTheme] = useState<Theme>('light');

  const t = (ko: string, ja: string) => (lang === 'ko' ? ko : ja);

  const formatCurrency = (amountJPY: number) => {
    if (currency === 'KRW') {
      const krw = Math.round(amountJPY * JPY_TO_KRW);
      return `\u20A9${krw.toLocaleString()}`;
    }
    return `\u00A5${Math.round(amountJPY).toLocaleString()}`;
  };

  return (
    <AppContext.Provider
      value={{ lang, setLang, currency, setCurrency, theme, setTheme, t, formatCurrency }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be inside AppProvider');
  return ctx;
}
