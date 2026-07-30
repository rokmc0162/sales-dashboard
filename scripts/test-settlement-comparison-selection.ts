import assert from "node:assert/strict";

import { latestCompletedRunIdFromResponse } from "../src/features/settlement/components/SettlementCompareClient";

{
  assert.equal(
    latestCompletedRunIdFromResponse("run-3"),
    "run-3",
    "the server-provided latest completed run should be selected",
  );
}

{
  assert.equal(
    latestCompletedRunIdFromResponse(null),
    "",
    "no completed run should leave the selection empty",
  );
}

{
  assert.equal(
    latestCompletedRunIdFromResponse(undefined),
    "",
    "a missing API field should leave the selection empty",
  );
}

{
  assert.equal(
    latestCompletedRunIdFromResponse(123),
    "",
    "a malformed API field should leave the selection empty",
  );
}

console.log("settlement comparison selection assertions passed");
