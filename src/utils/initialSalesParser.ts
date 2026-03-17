// ---------------------------------------------------------------------------
// Parser for 초동매출 (Initial Sales) Excel files
// ---------------------------------------------------------------------------
import * as XLSX from 'xlsx';
import type { InitialSaleDaily, InitialSaleWeekly, InitialSalesData } from '@/types/initialSales';

/* ------------------------------------------------------------------ */
/*  Excel date handling                                                */
/* ------------------------------------------------------------------ */

/** Convert Excel serial number or string date to YYYY-MM-DD */
function parseExcelDate(value: unknown): string {
  if (value == null || value === '') return '';

  // Excel serial number
  if (typeof value === 'number' && value > 10000) {
    const date = new Date(Math.round((value - 25569) * 86400 * 1000));
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // String dates: "22.09.08", "2025.02.01", "24.10.25", etc.
  const s = String(value).trim();

  // YY.MM.DD
  const m2 = s.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (m2) {
    const yr = Number(m2[1]) >= 50 ? 1900 + Number(m2[1]) : 2000 + Number(m2[1]);
    return `${yr}-${m2[2]}-${m2[3]}`;
  }

  // YYYY.MM.DD
  const m4 = s.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (m4) return `${m4[1]}-${m4[2]}-${m4[3]}`;

  // YYYY-MM-DD (already correct)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  return s;
}

/** Safely parse a numeric cell */
function toNum(value: unknown): number {
  if (value == null || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/* ------------------------------------------------------------------ */
/*  Sheet parsers                                                      */
/* ------------------------------------------------------------------ */

function parseDailySheet(rows: unknown[][]): InitialSaleDaily[] {
  // Row 0: title row (일본PF 초동매출 일별 추이...)
  // Row 1: header row (작품명(KR), PF, 장르, PF장르, 런칭일, ...)
  // Row 2+: data rows
  const results: InitialSaleDaily[] = [];

  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const titleKR = String(row[0] ?? '').trim();
    if (!titleKR) continue; // skip empty rows

    const days: number[] = [];
    for (let d = 7; d <= 14; d++) {
      days.push(toNum(row[d]));
    }

    results.push({
      titleKR,
      platform: String(row[1] ?? '').trim(),
      genre: String(row[2] ?? '').trim(),
      pfGenre: String(row[3] ?? '').trim(),
      launchDate: parseExcelDate(row[4]),
      launchType: String(row[5] ?? '').trim(),
      launchEpisodes: toNum(row[6]),
      days,
      total: toNum(row[15]),
    });
  }

  return results;
}

function parseWeeklySheet(rows: unknown[][]): InitialSaleWeekly[] {
  // Same header pattern as daily but with Week1-Week12 (cols 7-18), total (col 19)
  const results: InitialSaleWeekly[] = [];

  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const titleKR = String(row[0] ?? '').trim();
    if (!titleKR) continue;

    const weeks: number[] = [];
    for (let w = 7; w <= 18; w++) {
      weeks.push(toNum(row[w]));
    }

    results.push({
      titleKR,
      platform: String(row[1] ?? '').trim(),
      genre: String(row[2] ?? '').trim(),
      pfGenre: String(row[3] ?? '').trim(),
      launchDate: parseExcelDate(row[4]),
      launchType: String(row[5] ?? '').trim(),
      launchEpisodes: toNum(row[6]),
      weeks,
      total: toNum(row[19]),
    });
  }

  return results;
}

/* ------------------------------------------------------------------ */
/*  Main parser                                                        */
/* ------------------------------------------------------------------ */

/** Parse 초동매출 Excel file (File input) → InitialSalesData */
export async function parseInitialSalesExcel(file: File): Promise<InitialSalesData> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });

  let daily: InitialSaleDaily[] = [];
  let weekly: InitialSaleWeekly[] = [];

  // Find daily sheet
  const dailySheet = wb.SheetNames.find(n => n.includes('일별'));
  if (dailySheet) {
    const ws = wb.Sheets[dailySheet];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];
    daily = parseDailySheet(rows);
  }

  // Find weekly sheet
  const weeklySheet = wb.SheetNames.find(n => n.includes('주간'));
  if (weeklySheet) {
    const ws = wb.Sheets[weeklySheet];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];
    weekly = parseWeeklySheet(rows);
  }

  return { daily, weekly };
}

/** Parse from XLSX workbook buffer (for Node script) */
export function parseInitialSalesBuffer(buffer: ArrayBuffer): InitialSalesData {
  const wb = XLSX.read(buffer, { type: 'array' });

  let daily: InitialSaleDaily[] = [];
  let weekly: InitialSaleWeekly[] = [];

  const dailySheet = wb.SheetNames.find(n => n.includes('일별'));
  if (dailySheet) {
    const ws = wb.Sheets[dailySheet];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];
    daily = parseDailySheet(rows);
  }

  const weeklySheet = wb.SheetNames.find(n => n.includes('주간'));
  if (weeklySheet) {
    const ws = wb.Sheets[weeklySheet];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];
    weekly = parseWeeklySheet(rows);
  }

  return { daily, weekly };
}
