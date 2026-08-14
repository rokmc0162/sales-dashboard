import assert from "node:assert/strict";

import {
  buildLookupMaps,
  emptyLookupMaps,
  resolveMasterTitle,
  toSalesRecords,
} from "../src/features/settlement/lib/aggregation/to-sales-records";
import type { TitleAliasRow, TitleRow } from "../src/features/settlement/lib/supabase/types";

const title = (id: string, jp: string, kr: string | null = null, channel: string | null = null) => ({
  id,
  title_jp: jp,
  title_kr: kr,
  channel_title_jp: channel,
  type: "WT",
  distribution_strategy: "non-ex",
  launch_date: null,
  notes: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
}) as unknown as TitleRow;
const alias = (id: string, titleId: string, value: string): TitleAliasRow => ({
  id,
  title_id: titleId,
  alias: value,
  source: "synthetic",
});
const base = { clients: [], channels: [] };
const one = buildLookupMaps({
  ...base,
  titles: [title("title-a", "Ｓｙｎｔｈｅｔｉｃ　Ａ", "합성 A")],
  titleAliases: [alias("alias-a", "title-a", "Alias A")],
});
assert.deepEqual(resolveMasterTitle({ channel_title_jp: "Synthetic A", title_jp: null, title_kr: null }, one), {
  status: "resolved", titleId: "title-a",
});
assert.deepEqual(resolveMasterTitle({ channel_title_jp: "Alias   A", title_jp: null, title_kr: null }, one), {
  status: "resolved", titleId: "title-a",
});

const collision = buildLookupMaps({
  ...base,
  titles: [title("title-a", "Synthetic A"), title("title-b", "Synthetic B")],
  titleAliases: [alias("alias-a", "title-a", "Shared Alias"), alias("alias-b", "title-b", "Shared Alias")],
});
assert.deepEqual(resolveMasterTitle({ channel_title_jp: "Shared Alias", title_jp: null, title_kr: null }, collision), {
  status: "ambiguous", titleId: null,
});
assert.deepEqual(resolveMasterTitle({ channel_title_jp: "Synthetic A", title_jp: "Synthetic B", title_kr: null }, collision), {
  status: "ambiguous", titleId: null,
});

const sourceRow = [{
  clients: "synthetic-client",
  channel: "synthetic-channel",
  channel_title_jp: "Unresolved Work",
  title_jp: "Unresolved Work",
  type: "WT",
  total_amount_jpy: 1,
}];
const strict = toSalesRecords(sourceRow, {
  settlement_month: "2026-07-01",
  platform_code: "synthetic",
  lookups: one,
  requireTitleResolution: true,
});
assert.equal(strict.inserts.length, 1);
assert.equal(strict.inserts[0].title_id, null);
assert.deepEqual(strict.errors.map((error) => [error.field, error.message]), [
  ["title_id", "master title unresolved"],
]);
const shadow = toSalesRecords(sourceRow, {
  settlement_month: "2026-07-01",
  platform_code: "synthetic",
  lookups: emptyLookupMaps(),
});
assert.equal(shadow.errors.length, 0);
assert.equal(shadow.inserts[0].title_id, null);

const summary = toSalesRecords([{ ...sourceRow[0], note2: "SUMMARY_NON_AGGREGATED" }], {
  settlement_month: "2026-07-01",
  platform_code: "synthetic",
  lookups: one,
  requireTitleResolution: true,
});
assert.equal(summary.errors.length, 0);
console.log("test-settlement-master-title-resolver: all assertions passed");
