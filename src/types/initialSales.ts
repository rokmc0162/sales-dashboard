// ---------------------------------------------------------------------------
// Initial Sales (초동매출) data types
// ---------------------------------------------------------------------------

export interface InitialSaleDaily {
  titleKR: string;
  platform: string;
  genre: string;
  pfGenre: string;
  launchDate: string; // YYYY-MM-DD
  launchType: string; // 독점 | 선행 | 비독점 | 2차선행 | 듀얼 | 선행 듀얼
  launchEpisodes: number;
  days: number[]; // [day1, day2, ..., day8]
  total: number;
}

export interface InitialSaleWeekly {
  titleKR: string;
  platform: string;
  genre: string;
  pfGenre: string;
  launchDate: string;
  launchType: string;
  launchEpisodes: number;
  weeks: number[]; // [week1, ..., week12]
  total: number;
}

export interface InitialSalesData {
  daily: InitialSaleDaily[];
  weekly: InitialSaleWeekly[];
}
