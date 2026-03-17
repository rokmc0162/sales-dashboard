import * as XLSX from 'xlsx';
import type { TitleSummary, Language } from '@/types';
import { CONTENT_TYPE_LABELS } from '@/types';

export function exportTitlesToXlsx(
  titles: TitleSummary[],
  language: Language,
  filename = 'title_management.xlsx',
) {
  const headers =
    language === 'ko'
      ? ['작품명(KR)', '작품명(JP)', '콘텐츠유형', '플랫폼수', '총매출(¥)', '독점여부', '일평균(¥)', '첫매출일', '최종매출일']
      : ['作品名(KR)', '作品名(JP)', 'コンテンツ形式', 'PF数', '総売上(¥)', '独占', '日平均(¥)', '初売上日', '最終売上日'];

  const rows = titles.map((t) => [
    t.titleKR,
    t.titleJP,
    t.contentType
      ? CONTENT_TYPE_LABELS[t.contentType]?.[language] || t.contentType
      : '',
    t.platforms.length,
    t.totalSales,
    t.platforms.length === 1
      ? language === 'ko' ? '독점' : '独占'
      : language === 'ko' ? '비독점' : '非独占',
    Math.round(t.dailyAvg),
    t.firstDate,
    t.lastDate,
  ]);

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

  // Column widths
  ws['!cols'] = [
    { wch: 30 }, { wch: 30 }, { wch: 12 }, { wch: 8 },
    { wch: 15 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Titles');
  XLSX.writeFile(wb, filename);
}
