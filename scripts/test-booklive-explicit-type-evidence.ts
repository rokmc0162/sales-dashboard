/** Privacy-safe regression: BookLive WT/版面 is explicit source evidence. */
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import { parseBooklive } from "../src/features/settlement/lib/parsers/booklive";

async function main() {
  const rows = [
    {
      配信月: "2026/07",
      タイトル名: "synthetic vertical title",
      書店名称: "ブックライブ",
      "WT/版面": "WT",
      BookLive売上: 100,
      "権利元取分(税抜)": 30,
      消費税額: 3,
      "権利元取分(税込)": 33,
      支払額: 33,
    },
    {
      配信月: "2026/07",
      タイトル名: "synthetic page title",
      書店名称: "ブッコミ",
      "WT/版面": "版面",
      BookLive売上: 200,
      "権利元取分(税抜)": 60,
      消費税額: 6,
      "権利元取分(税込)": 66,
      支払額: 66,
    },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "detail");
  const buffer = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  const parsed = await parseBooklive({ filename: "synthetic.xlsx", buffer });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.records.length, 2);
  type ParsedRecord = { data: Record<string, unknown> };
  assert.deepEqual(parsed.records.map((record: ParsedRecord) => record.data.type), ["WT", "EP"]);
  assert.deepEqual(parsed.records.map((record: ParsedRecord) => record.data.raw_wt), ["WT", "版面"]);
  for (const record of parsed.records) {
    assert.ok(!String(record.data.note2 ?? "").includes("TYPE_HEURISTIC"));
  }
  console.log("test-booklive-explicit-type-evidence: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
