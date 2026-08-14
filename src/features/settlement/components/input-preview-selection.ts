import type { PreviewSheet } from './InputPreviewTable';

const FIRST_DETAIL_ROW_INDEX = 5;

function hasVisibleCell(cell: PreviewSheet['rows'][number][number]): boolean {
  return Boolean(cell.formula)
    || (cell.value !== null && cell.value !== undefined && cell.value !== '');
}

/** True when an INPUT sheet contains at least one material value/formula at row 6+. */
export function hasPreviewDetailRows(sheet: PreviewSheet): boolean {
  return sheet.rows
    .slice(FIRST_DETAIL_ROW_INDEX)
    .some((row) => row.some(hasVisibleCell));
}

/**
 * Nakatani review workbooks use a 13-sheet template but only the routed
 * electronic month and (optionally) publication sheet contain detail rows.
 * Hide empty template tabs. If generation unexpectedly yields no populated
 * INPUT sheet, keep all sheets so the existing diagnostic fallback remains.
 */
export function reviewPreviewSheets(sheets: PreviewSheet[]): PreviewSheet[] {
  const populatedInputSheets = sheets.filter(
    (sheet) => sheet.name.startsWith('input_') && hasPreviewDetailRows(sheet),
  );
  return populatedInputSheets.length > 0 ? populatedInputSheets : sheets;
}
