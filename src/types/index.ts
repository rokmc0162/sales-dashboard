export interface DailySale {
  titleKR: string;
  titleJP: string;
  channel: string;
  date: string;
  sales: number;
}

export interface MonthlySummary {
  month: string;
  totalSales: number;
  platforms: Record<string, number>;
}

export interface TitleSummary {
  titleKR: string;
  titleJP: string;
  seriesName: string;
  totalSales: number;
  platforms: { name: string; sales: number }[];
  dailyAvg: number;
  peakDate: string;
  peakSales: number;
  firstDate: string;
  lastDate: string;
  monthlyTrend: { month: string; sales: number }[];
}

export interface PlatformSummary {
  platform: string;
  totalSales: number;
  titleCount: number;
  monthlyTrend: { month: string; sales: number }[];
  topTitles: { titleKR: string; titleJP: string; sales: number }[];
}

export interface TitleMaster {
  titleKR: string;
  titleJP: string;
  seriesName: string;
  platforms: string[];
}

export type Language = 'ko' | 'ja';
export type Currency = 'JPY' | 'KRW';

export interface AppState {
  language: Language;
  currency: Currency;
  exchangeRate: number;
  dateRange: { start: string; end: string };
  selectedPlatforms: string[];
}
