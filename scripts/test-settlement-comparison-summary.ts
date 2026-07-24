import assert from "node:assert/strict";

import { displayedFieldMismatchTotal } from "../src/features/settlement/components/SettlementCompareClient";

{
  assert.equal(
    displayedFieldMismatchTotal({
      diff_total: 9,
      missing_rows: 2,
      extra_rows: 1,
      field_mismatches: { total_amount_jpy: 3, tax_jpy: 2 },
    }),
    5,
    "field_mismatches should take precedence when persisted",
  );
}

{
  assert.equal(
    displayedFieldMismatchTotal({
      diff_total: 9,
      missing_rows: 2,
      extra_rows: 1,
    }),
    6,
    "older summaries should derive differing-cell count from diff_total minus whole-row diffs",
  );
}

{
  assert.equal(
    displayedFieldMismatchTotal({
      diff_total: 1,
      missing_rows: 2,
      extra_rows: 3,
    }),
    0,
    "fallback count must never go negative",
  );
}

console.log("settlement comparison summary assertions passed");
