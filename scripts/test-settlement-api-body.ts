import assert from "node:assert/strict";

import { readBoundedJsonBody } from "../src/features/settlement/lib/api-body";

const encoder = new TextEncoder();

function source(text: string, contentLength: string | null = null, chunkSize = 3) {
  const bytes = encoder.encode(text);
  let offset = 0;
  return {
    headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? contentLength : null) },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const next = bytes.slice(offset, Math.min(offset + chunkSize, bytes.length));
        offset += next.length;
        controller.enqueue(next);
      },
    }),
  };
}

async function main() {
  assert.deepEqual(await readBoundedJsonBody(source('{"body":"ok"}'), 64), {
    ok: true,
    body: { body: "ok" },
  });

  const declaredTooLarge = await readBoundedJsonBody(source('{}', '100'), 16);
  assert.equal(declaredTooLarge.ok, false);
  if (!declaredTooLarge.ok) assert.equal(declaredTooLarge.status, 413);

  const streamedTooLarge = await readBoundedJsonBody(source('{"padding":"1234567890"}', null, 2), 12);
  assert.equal(streamedTooLarge.ok, false);
  if (!streamedTooLarge.ok) assert.equal(streamedTooLarge.status, 413);

  const invalid = await readBoundedJsonBody(source('{bad json}'), 64);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.status, 400);

  const empty = await readBoundedJsonBody({ headers: { get: () => null }, body: null }, 64);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.status, 400);

  console.log("test-settlement-api-body: all assertions passed");
}

void main();
