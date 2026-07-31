/**
 * Bounded JSON body reading for settlement API routes. request.json() would
 * buffer an arbitrarily large body before parsing, so the body stream is read
 * incrementally and rejected with 413 the moment the accumulated bytes exceed
 * the cap — with a cheap content-length precheck first. Structurally typed
 * (headers.get + body stream) so it is testable without a real Request.
 */

export const JSON_BODY_MAX_BYTES = 64 * 1024;

export type BoundedJsonBodySource = {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
};

export type BoundedJsonBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; status: 400 | 413; error: string };

export async function readBoundedJsonBody(
  request: BoundedJsonBodySource,
  maxBytes: number = JSON_BODY_MAX_BYTES,
): Promise<BoundedJsonBodyResult> {
  const tooLarge: BoundedJsonBodyResult = {
    ok: false,
    status: 413,
    error: `body must be at most ${maxBytes} bytes`,
  };

  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return tooLarge;
  }
  if (!request.body) {
    return { ok: false, status: 400, error: "body must be JSON" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, status: 400, error: "body must be JSON" };
  }
}
