import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  downloadArchiveBuffer,
  MAX_ARCHIVE_DOWNLOAD_BYTES,
} from "../src/features/settlement/lib/storage/archive";

type FakeOptions = {
  info?: { size?: number } | null;
  infoError?: Error | null;
  blob?: Blob | null;
  downloadError?: Error | null;
};

function fakeClient(options: FakeOptions, calls: string[]): SupabaseClient {
  return {
    storage: {
      from(bucket: string) {
        assert.equal(bucket, "upload-debug");
        return {
          async info(path: string) {
            calls.push(`info:${path}`);
            return { data: options.info ?? null, error: options.infoError ?? null };
          },
          async download(path: string) {
            calls.push(`download:${path}`);
            return { data: options.blob ?? null, error: options.downloadError ?? null };
          },
        };
      },
    },
  } as unknown as SupabaseClient;
}

async function run() {
  {
    const calls: string[] = [];
    const bytes = Buffer.from("workbook");
    const result = await downloadArchiveBuffer("ok.xlsx", fakeClient({
      info: { size: bytes.byteLength },
      blob: new Blob([bytes]),
    }, calls));
    assert.deepEqual(result, bytes);
    assert.deepEqual(calls, ["info:ok.xlsx", "download:ok.xlsx"]);
  }

  for (const info of [null, {}, { size: Number.NaN }]) {
    const calls: string[] = [];
    await assert.rejects(
      downloadArchiveBuffer("unknown.xlsx", fakeClient({ info }, calls)),
      /size is unavailable/,
    );
    assert.deepEqual(calls, ["info:unknown.xlsx"]);
  }

  {
    const calls: string[] = [];
    await assert.rejects(
      downloadArchiveBuffer("large.xlsx", fakeClient({
        info: { size: MAX_ARCHIVE_DOWNLOAD_BYTES + 1 },
      }, calls)),
      /exceeds the 6 MiB download limit/,
    );
    assert.deepEqual(calls, ["info:large.xlsx"]);
  }

  console.log("test-archive-download: all assertions passed");
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
