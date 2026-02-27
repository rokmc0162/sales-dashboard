// ---------------------------------------------------------------------------
// Platform Brand Configuration
// Each platform has brand colors, icon abbreviation, and display names
// ---------------------------------------------------------------------------

export interface PlatformBrand {
  color: string;       // primary brand color
  bgColor: string;     // light background for cards/badges
  borderColor: string; // subtle border
  icon: string;        // short abbreviation for icon
  nameKR: string;
  nameJP: string;
}

export const PLATFORM_BRANDS: Record<string, PlatformBrand> = {
  piccoma: {
    color: '#6B3FA0',
    bgColor: '#F3ECFC',
    borderColor: '#D8C4F0',
    icon: 'P',
    nameKR: '피코마',
    nameJP: 'ピッコマ',
  },
  Mechacomic: {
    color: '#E91E8C',
    bgColor: '#FDE7F5',
    borderColor: '#F5B0DC',
    icon: 'MC',
    nameKR: '메차코믹',
    nameJP: 'メチャコミ',
  },
  cmoa: {
    color: '#0068B7',
    bgColor: '#E6F0FA',
    borderColor: '#B0D4F1',
    icon: 'C',
    nameKR: 'CMOA',
    nameJP: 'CMOA',
  },
  'LINEマンガ': {
    color: '#06C755',
    bgColor: '#E6F9ED',
    borderColor: '#A3E4BB',
    icon: 'L',
    nameKR: 'LINE만화',
    nameJP: 'LINEマンガ',
  },
  ebookjapan: {
    color: '#E8546D',
    bgColor: '#FDECEF',
    borderColor: '#F5B3BF',
    icon: 'eB',
    nameKR: 'ebookjapan',
    nameJP: 'ebookjapan',
  },
  'DMM（FANZA）': {
    color: '#D4272E',
    bgColor: '#FDE8E9',
    borderColor: '#F5AAAD',
    icon: 'FZ',
    nameKR: 'FANZA',
    nameJP: 'FANZA',
  },
  Renta: {
    color: '#FF6633',
    bgColor: '#FFF0EB',
    borderColor: '#FFBFA8',
    icon: 'R',
    nameKR: 'Renta',
    nameJP: 'Renta!',
  },
  'U-NEXT': {
    color: '#00BED6',
    bgColor: '#E6F9FB',
    borderColor: '#A3E5ED',
    icon: 'U',
    nameKR: 'U-NEXT',
    nameJP: 'U-NEXT',
  },
  DMM: {
    color: '#232323',
    bgColor: '#F0F0F0',
    borderColor: '#C0C0C0',
    icon: 'D',
    nameKR: 'DMM',
    nameJP: 'DMMブックス',
  },
  'まんが王国': {
    color: '#F5921B',
    bgColor: '#FFF4E5',
    borderColor: '#FDD19B',
    icon: '王',
    nameKR: '만화왕국',
    nameJP: 'まんが王国',
  },
};

const DEFAULT_BRAND: PlatformBrand = {
  color: '#94A3B8',
  bgColor: '#F1F5F9',
  borderColor: '#CBD5E1',
  icon: '?',
  nameKR: '',
  nameJP: '',
};

export function getPlatformBrand(name: string): PlatformBrand {
  return PLATFORM_BRANDS[name] ?? { ...DEFAULT_BRAND, icon: name.charAt(0).toUpperCase(), nameKR: name, nameJP: name };
}

export function getPlatformColor(name: string): string {
  return PLATFORM_BRANDS[name]?.color ?? '#94A3B8';
}

/** Build a Record<string, string> color map for a set of platform names */
export function buildPlatformColorMap(platformNames: Iterable<string>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const name of platformNames) {
    map[name] = getPlatformColor(name);
  }
  return map;
}

/** Ordered array of brand colors for chart use (sorted by sales descending) */
export function getPlatformChartColors(platformNames: string[]): string[] {
  return platformNames.map(getPlatformColor);
}
