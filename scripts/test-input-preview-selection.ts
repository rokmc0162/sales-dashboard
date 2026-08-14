import assert from 'node:assert/strict';

import type { PreviewSheet } from '../src/features/settlement/components/InputPreviewTable';
import {
  hasPreviewDetailRows,
  reviewPreviewSheets,
} from '../src/features/settlement/components/input-preview-selection';

function sheet(name: string, detail: 'empty' | 'value' | 'formula'): PreviewSheet {
  const rows: PreviewSheet['rows'] = Array.from({ length: 6 }, () => [{ value: null }]);
  rows[4] = [{ value: 'COL_1' }];
  if (detail === 'value') rows[5] = [{ value: '作品A' }];
  if (detail === 'formula') rows[5] = [{ value: null, formula: 'AB6+AC6' }];
  return { name, rowCount: rows.length, columnCount: 1, rows };
}

const emptyJuly = sheet('input_電子_7月', 'empty');
const populatedAugust = sheet('input_電子_8月', 'value');
const populatedPublication = sheet('input_出版', 'formula');

assert.equal(hasPreviewDetailRows(emptyJuly), false, 'row-5 template headers are not detail data');
assert.equal(hasPreviewDetailRows(populatedAugust), true, 'row-6 values count as detail data');
assert.equal(hasPreviewDetailRows(populatedPublication), true, 'row-6 formulas count as detail data');
assert.deepEqual(
  reviewPreviewSheets([emptyJuly, populatedAugust, populatedPublication]).map((item) => item.name),
  ['input_電子_8月', 'input_出版'],
  'review preview hides empty month tabs and selects the routed electronic sheet first',
);
assert.deepEqual(
  reviewPreviewSheets([emptyJuly]).map((item) => item.name),
  ['input_電子_7月'],
  'no-data output preserves all sheets for diagnostics',
);

console.log('test-input-preview-selection: all assertions passed');
