import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Language, Currency, AppState } from '../types';

interface AppContextType extends AppState {
  setLanguage: (lang: Language) => void;
  setCurrency: (cur: Currency) => void;
  setExchangeRate: (rate: number) => void;
  setDateRange: (range: { start: string; end: string }) => void;
  setSelectedPlatforms: (platforms: string[]) => void;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>({
    language: 'ko',
    currency: 'JPY',
    exchangeRate: 9.2,
    dateRange: { start: '2025-03-01', end: '2026-02-22' },
    selectedPlatforms: [],
  });

  const ctx: AppContextType = {
    ...state,
    setLanguage: (language) => setState(s => ({ ...s, language })),
    setCurrency: (currency) => setState(s => ({ ...s, currency })),
    setExchangeRate: (exchangeRate) => setState(s => ({ ...s, exchangeRate })),
    setDateRange: (dateRange) => setState(s => ({ ...s, dateRange })),
    setSelectedPlatforms: (selectedPlatforms) => setState(s => ({ ...s, selectedPlatforms })),
  };

  return <AppContext value={ctx}>{children}</AppContext>;
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppProvider');
  return ctx;
}
