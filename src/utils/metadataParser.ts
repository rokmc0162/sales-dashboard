import type { ContentType } from '@/types';

/**
 * Map 形式 column values from File 2 (統合コンテンツリスト) to ContentType codes.
 */
export function parseContentType(format: string | undefined | null): ContentType {
  if (!format) return 'UNKNOWN';
  const trimmed = format.trim().toUpperCase();

  if (trimmed === 'WEBTOON' || trimmed.includes('WEBTOON')) return 'WT';
  if (trimmed.includes('話別') || trimmed === '版面(話別)') return 'EP';
  if (trimmed.includes('巻別') || trimmed === '版面(巻別)') return 'EB';

  return 'UNKNOWN';
}

/**
 * Parse metadata from File 2 (統合コンテンツリスト) rows.
 * Returns a map of titleJP -> metadata including contentType, author info, etc.
 */
export interface TitleMetadata {
  titleJP: string;
  contentType: ContentType;
  artist?: string;
  screenwriter?: string;
  originalAuthor?: string;
  productionCompany?: string;
  distributionCompany?: string;
  exclusivity?: string;
  genre?: string;
}

export function parseMetadataRows(
  rows: Record<string, unknown>[],
): Map<string, TitleMetadata> {
  const map = new Map<string, TitleMetadata>();

  for (const row of rows) {
    const titleJP = String(row['作品名'] ?? row['作品名（日本語）'] ?? '').trim();
    if (!titleJP) continue;

    const format = String(row['形式'] ?? '');
    const metadata: TitleMetadata = {
      titleJP,
      contentType: parseContentType(format),
      artist: String(row['作画'] ?? '').trim() || undefined,
      screenwriter: String(row['脚色'] ?? '').trim() || undefined,
      originalAuthor: String(row['原作'] ?? '').trim() || undefined,
      productionCompany: String(row['制作会社'] ?? '').trim() || undefined,
      distributionCompany: String(row['流通会社'] ?? '').trim() || undefined,
      exclusivity: String(row['配信範囲'] ?? '').trim() || undefined,
      genre: String(row['ジャンル'] ?? row['장르'] ?? '').trim() || undefined,
    };

    map.set(titleJP, metadata);
  }

  return map;
}
