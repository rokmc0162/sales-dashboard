/** Static structural regression checks for the standalone settlement workbook review. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const routePath = join(root, "app/settlement-sheet/[id]/page.tsx");
const protectedRoutePath = join(root, "app/(protected)/settlement-sheet/[id]/page.tsx");
const componentPath = join(
  root,
  "src/features/settlement/components/SettlementSpreadsheetReview.tsx",
);
const comparePath = join(
  root,
  "src/features/settlement/components/SettlementCompareClient.tsx",
);
const middlewarePath = join(root, "middleware.ts");

const route = readFileSync(routePath, "utf8");
const component = readFileSync(componentPath, "utf8");
const compare = readFileSync(comparePath, "utf8");
const middleware = readFileSync(middlewarePath, "utf8");

assert.throws(
  () => readFileSync(protectedRoutePath, "utf8"),
  "standalone route must stay outside the protected layout group so ClientLayout/sidebar is absent",
);
assert.match(route, /UUID_PATTERN\.test\(id\).*notFound\(\)/s);
assert.match(route, /<AppProvider>[\s\S]*<SettlementSpreadsheetReview runId=\{id\}/);
assert.doesNotMatch(route, /ClientLayout|Sidebar/);
assert.match(middleware, /if \(!hasRefreshCookie\)[\s\S]*new URL\("\/login"/);
assert.doesNotMatch(middleware, /settlement-sheet[\s\S]*NextResponse\.next\(\)/);

assert.match(compare, /href=\{`\/settlement-sheet\/\$\{run\.id\}`\}/);
assert.match(compare, /target="_blank"/);
assert.match(compare, /rel="noopener noreferrer"/);
assert.match(compare, /<ExternalLink\b/);
assert.doesNotMatch(compare, /import AnswerWorkbookReview/);

assert.match(component, /fixed inset-0[^"]*h-dvh[^"]*w-screen/);
assert.match(component, /sticky left-0 top-0/);
assert.match(component, /sticky top-7/);
assert.match(component, /sticky left-0 z-30/);
assert.match(component, /whitespace-nowrap/);
assert.match(component, /overflow-auto/);
assert.match(component, /ring-2 ring-inset ring-emerald-600/);
assert.match(component, /w-\[380px\]/);
assert.match(component, /<InvestigationThread\b/);
assert.match(component, /flattenWorkbookOverlays/);
assert.match(component, /visibleWorkbookRows/);
assert.match(component, /workbookRowHasDifference/);

console.log("test-settlement-spreadsheet-review: all assertions passed");
