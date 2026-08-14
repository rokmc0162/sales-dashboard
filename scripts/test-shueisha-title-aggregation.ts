import assert from "node:assert/strict";

import { aggregateShueishaDetailRows } from "../src/features/settlement/lib/parsers/shueisha";

const short = aggregateShueishaDetailRows([
  { title: "短編A", kind: "話配信", payment_taxincl: 100 },
  { title: "短編B", kind: "話配信", payment_taxincl: 200 },
]);
assert.equal(short.length, 2, "different short works must never fuzzy-merge");
assert.deepEqual(short.map((row) => row.payment_taxincl).sort((a, b) => a - b), [100, 200]);

const longNoise = aggregateShueishaDetailRows([
  { title: "SyntheticLongTitleAlpha", kind: "単行本", payment_taxincl: 100 },
  { title: "SyntheticLongTitleAlpba", kind: "単行本", payment_taxincl: 200 },
]);
assert.equal(longNoise.length, 1, "one-character OCR noise in a long title may merge");
assert.equal(longNoise[0].payment_taxincl, 300);

const longDifferent = aggregateShueishaDetailRows([
  { title: "SyntheticLongTitleAlpha", kind: "単行本", payment_taxincl: 100 },
  { title: "SyntheticLongTitleOmega", kind: "単行本", payment_taxincl: 200 },
]);
assert.equal(longDifferent.length, 2, "semantically different long titles stay separate");
console.log("test-shueisha-title-aggregation: all assertions passed");
