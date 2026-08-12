import assert from "node:assert/strict";

import {
  SettlementDriveClient,
  SettlementDriveError,
} from "../src/features/settlement/lib/google-drive/client.server";
import type { SettlementDriveConfig } from "../src/features/settlement/lib/google-drive/config.server";

const TOKEN = "token-secret-value";
const SECRET_BODY = "google-secret-error-body";
const SECRET_LOCATION =
  "https://evil.example/upload/drive/v3/files?upload_id=location-secret";
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const TEST_LIST_LIMITS = { maxListPages: 3, maxListFiles: 4 };

const config = {
  enabled: true,
  clientEmail: "drive-uploader@example.iam.gserviceaccount.com",
  privateKey: "private-key-secret",
  sharedDriveId: "shared-drive_123",
  intakeRootFolderId: "intake-root_456",
  intakeRootUrl: "https://drive.google.com/drive/folders/intake-root_456",
} satisfies SettlementDriveConfig;

type FetchCall = { input: URL | RequestInfo; init?: RequestInit };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function metadata(
  overrides: Partial<{
    id: string;
    name: string;
    mimeType: string;
    parents: string[];
    size: string;
    md5Checksum: string;
    sha1Checksum: string;
    sha256Checksum: string;
    version: string;
    headRevisionId: string;
    modifiedTime: string;
    trashed: boolean;
    driveId: string;
    webViewLink: string;
    appProperties: Record<string, string>;
  }> = {},
) {
  return {
    id: "file_123",
    name: "result.xlsx",
    mimeType: "application/octet-stream",
    ...overrides,
  };
}

function paddedMetadataResponse(
  byteLength: number,
  contentLength?: string,
  prefix = "",
): Response {
  const base = JSON.stringify({ ...metadata(), ignored: "" });
  assert.ok(Buffer.byteLength(base) + Buffer.byteLength(prefix) <= byteLength);
  const body = JSON.stringify({
    ...metadata(),
    ignored:
      prefix +
      "a".repeat(
        byteLength - Buffer.byteLength(base) - Buffer.byteLength(prefix),
      ),
  });
  assert.equal(Buffer.byteLength(body), byteLength);
  return new Response(body, {
    headers:
      contentLength === undefined
        ? undefined
        : { "Content-Length": contentLength },
  });
}

function cancellableResponse(
  status: number,
  headers?: HeadersInit,
): { response: Response; wasCanceled: () => boolean } {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(SECRET_BODY));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(body, { status, headers }),
    wasCanceled: () => canceled,
  };
}

function createMockFetch(responses: Response[]) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    const response = responses.shift();
    assert.ok(response, "Unexpected fetch call");
    return response;
  };
  return { calls, fetchImpl };
}

function getHeaders(call: FetchCall): Headers {
  return new Headers(call.init?.headers);
}

function getUrl(call: FetchCall): URL {
  return new URL(String(call.input));
}

async function getAsyncError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("Expected operation to fail");
}

function assertSafeError(
  error: Error,
  operation: string,
  status: number | undefined,
  secrets: string[],
) {
  assert.ok(error instanceof SettlementDriveError);
  assert.equal(error.operation, operation);
  assert.equal(error.status, status);
  const exposedError = [
    String(error),
    error.stack ?? "",
    JSON.stringify(error),
  ].join("\n");
  for (const secret of [
    TOKEN,
    config.privateKey,
    SECRET_BODY,
    SECRET_LOCATION,
    "location-secret",
    ...secrets,
  ]) {
    if (!secret) continue;
    assert.equal(exposedError.includes(secret), false);
  }
}

function assertCommonRequest(call: FetchCall, method: string) {
  assert.equal(call.init?.method, method);
  assert.equal(call.init?.redirect, "error");
  const headers = getHeaders(call);
  assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(headers.get("accept"), "application/json");
}

async function testCreateFolder() {
  const response = {
    id: "folder-result",
    name: "Settlement 2026",
    mimeType: "application/vnd.google-apps.folder",
    parents: ["parent_123"],
    driveId: config.sharedDriveId,
    webViewLink: "https://drive.google.com/drive/folders/folder-result",
  };
  const mock = createMockFetch([jsonResponse(response)]);
  const client = new SettlementDriveClient(
    config,
    async () => TOKEN,
    mock.fetchImpl,
  );

  assert.deepEqual(
    await client.createFolder("parent_123", "Settlement 2026"),
    response,
  );
  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assertCommonRequest(call, "POST");
  const url = getUrl(call);
  assert.equal(url.origin, "https://www.googleapis.com");
  assert.equal(url.pathname, "/drive/v3/files");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    supportsAllDrives: "true",
    fields: "id,name,mimeType,parents,size,md5Checksum,sha1Checksum,sha256Checksum,version,headRevisionId,modifiedTime,trashed,driveId,webViewLink,appProperties",
  });
  assert.deepEqual(Object.fromEntries(getHeaders(call)), {
    accept: "application/json",
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    name: "Settlement 2026",
    mimeType: "application/vnd.google-apps.folder",
    parents: ["parent_123"],
  });
}

async function testUnicodeNamesArePreserved() {
  const folderName = "精".repeat(255);
  const fileName = `${"売".repeat(86)}.xlsx`;
  const responseName = "名".repeat(255);
  const folderResponse = metadata({
    id: "folder-result",
    name: responseName,
    mimeType: "application/vnd.google-apps.folder",
  });
  const sessionUrl =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=unicode-session";
  const mock = createMockFetch([
    jsonResponse(folderResponse),
    new Response(null, { status: 200, headers: { Location: sessionUrl } }),
  ]);
  const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);

  const createdFolder = await client.createFolder("parent_123", folderName);
  assert.deepEqual(createdFolder, folderResponse);
  assert.equal(createdFolder.name, responseName);
  assert.equal(JSON.parse(String(mock.calls[0].init?.body)).name, folderName);
  assert.equal(
    await client.startResumableUpload({
      parentId: "parent_123",
      name: fileName,
      mimeType: "application/octet-stream",
      sizeBytes: 1,
    }),
    sessionUrl,
  );
  assert.equal(JSON.parse(String(mock.calls[1].init?.body)).name, fileName);
}

async function testGetFileMetadata() {
  const metadata = {
    id: "file_123",
    name: "result.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    parents: ["parent_123"],
    size: "42",
    md5Checksum: "0123456789abcdef0123456789abcdef",
    sha1Checksum: "0123456789abcdef0123456789abcdef01234567",
    sha256Checksum:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    version: "7",
    headRevisionId: "revision",
    modifiedTime: "2026-08-06T00:00:00.000Z",
    trashed: false,
    driveId: config.sharedDriveId,
    webViewLink: "https://drive.google.com/file/d/file_123/view",
  };
  const mock = createMockFetch([jsonResponse(metadata)]);
  const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);

  assert.deepEqual(await client.getFileMetadata("file_123"), metadata);
  const call = mock.calls[0];
  assertCommonRequest(call, "GET");
  const url = getUrl(call);
  assert.equal(url.origin, "https://www.googleapis.com");
  assert.equal(url.pathname, "/drive/v3/files/file_123");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    supportsAllDrives: "true",
    fields:
      "id,name,mimeType,parents,size,md5Checksum,sha1Checksum,sha256Checksum,version,headRevisionId,modifiedTime,trashed,driveId,webViewLink,appProperties",
  });
  assert.deepEqual(Object.fromEntries(getHeaders(call)), {
    accept: "application/json",
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(call.init?.body, undefined);
}

async function testListAllChildrenPagination() {
  const firstFile = metadata({ id: "a", name: "A" });
  const secondFile = metadata({ id: "b", name: "B" });
  const mock = createMockFetch([
    jsonResponse({ files: [firstFile], nextPageToken: "next_token-1" }),
    jsonResponse({ files: [secondFile] }),
  ]);
  const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);

  assert.deepEqual(await client.listAllChildren("parent_123"), [firstFile, secondFile]);
  assert.equal(mock.calls.length, 2);
  for (const call of mock.calls) {
    assertCommonRequest(call, "GET");
    const url = getUrl(call);
    assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(url.pathname, "/drive/v3/files");
    assert.equal(url.searchParams.get("q"), "'parent_123' in parents and trashed = false");
    assert.equal(url.searchParams.get("corpora"), "drive");
    assert.equal(url.searchParams.get("driveId"), config.sharedDriveId);
    assert.equal(url.searchParams.get("includeItemsFromAllDrives"), "true");
    assert.equal(url.searchParams.get("supportsAllDrives"), "true");
    assert.equal(url.searchParams.get("spaces"), "drive");
    assert.equal(url.searchParams.get("pageSize"), "1000");
    assert.equal(url.searchParams.get("orderBy"), "name_natural");
    assert.equal(
      url.searchParams.get("fields"),
      "nextPageToken,files(id,name,mimeType,parents,size,md5Checksum,sha1Checksum,sha256Checksum,version,headRevisionId,modifiedTime,trashed,driveId,webViewLink,appProperties)",
    );
  }
  assert.equal(getUrl(mock.calls[0]).searchParams.has("pageToken"), false);
  assert.equal(getUrl(mock.calls[1]).searchParams.get("pageToken"), "next_token-1");
}

async function testListPreservesNaturalOrderAndSortsExactNameTiesById() {
  const file1 = metadata({ id: "file-1", name: "file1" });
  const file2B = metadata({ id: "b", name: "file2" });
  const file2A = metadata({ id: "a", name: "file2" });
  const file12 = metadata({ id: "file-12", name: "file12" });
  const mock = createMockFetch([
    jsonResponse({
      files: [file1, file2B],
      nextPageToken: "next",
    }),
    jsonResponse({ files: [file2A, file12] }),
  ]);
  const client = new SettlementDriveClient(
    config,
    async () => TOKEN,
    mock.fetchImpl,
  );
  assert.deepEqual(await client.listAllChildren("parent_123"), [
    file1,
    file2A,
    file2B,
    file12,
  ]);
  assert.equal(mock.calls.length, 2);
}

async function testRuntimeResponseValidation() {
  const invalidMetadata: unknown[] = [
    null,
    [],
    "not-an-object",
    {},
    { name: "valid", mimeType: "application/octet-stream" },
    { id: "file", mimeType: "application/octet-stream" },
    { id: "file", name: "valid" },
    { ...metadata(), id: 1 },
    { ...metadata(), name: null },
    { ...metadata(), mimeType: false },
    metadata({ id: "" }),
    metadata({ name: "" }),
    metadata({ mimeType: "" }),
    metadata({ name: "bad\ud800name" }),
    { ...metadata(), parents: "parent" },
    { ...metadata(), parents: [""] },
    { ...metadata(), parents: ["bad\ud800parent"] },
    { ...metadata(), size: -1 },
    { ...metadata(), size: "01" },
    { ...metadata(), size: "1".repeat(21) },
    { ...metadata(), md5Checksum: "md5" },
    { ...metadata(), sha1Checksum: "sha1" },
    { ...metadata(), sha256Checksum: "sha256" },
    { ...metadata(), version: "version-seven" },
    { ...metadata(), headRevisionId: "" },
    { ...metadata(), headRevisionId: 1 },
    { ...metadata(), modifiedTime: "yesterday" },
    { ...metadata(), trashed: "false" },
    { ...metadata(), driveId: "" },
    { ...metadata(), driveId: null },
    { ...metadata(), webViewLink: "" },
    { ...metadata(), webViewLink: false },
  ];

  for (const payload of invalidMetadata) {
    const mock = createMockFetch([jsonResponse(payload)]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    const error = await getAsyncError(() => client.getFileMetadata("file_123"));
    assertSafeError(error, "getFileMetadata", 200, ["yesterday", "version-seven"]);
  }

  for (const operation of ["createFolder", "getFileMetadata", "listAllChildren"] as const) {
    const payload = operation === "listAllChildren" ? { files: [null] } : [];
    const mock = createMockFetch([jsonResponse(payload)]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    const error = await getAsyncError(() =>
      operation === "createFolder"
        ? client.createFolder("parent_123", "folder")
        : operation === "getFileMetadata"
          ? client.getFileMetadata("file_123")
          : client.listAllChildren("parent_123"),
    );
    assertSafeError(error, operation, 200, []);
  }

  for (const payload of [{}, { files: null }]) {
    const mock = createMockFetch([jsonResponse(payload)]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    assert.deepEqual(await client.listAllChildren("parent_123"), []);
  }

  for (const files of [{}, "files", 1, false]) {
    const mock = createMockFetch([jsonResponse({ files })]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    const error = await getAsyncError(() => client.listAllChildren("parent_123"));
    assertSafeError(error, "listAllChildren", 200, []);
  }

  const valid = {
    ...metadata({
      id: "opaque/id\n😀",
      name: `${"応".repeat(255)}/exact\\name\u0085`,
      mimeType: "opaque mime/type\n😀",
      parents: ["parent/id", "親\n😀"],
      size: "0",
      md5Checksum: "0123456789abcdef0123456789abcdef",
      sha1Checksum: "0123456789abcdef0123456789abcdef01234567",
      sha256Checksum:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      version: "7",
      headRevisionId: "revision/id\n😀",
      modifiedTime: "2026-08-06T00:00:00.123456789Z",
      trashed: false,
      driveId: "drive/id\n😀",
      webViewLink: "not a URL\n😀",
    }),
    ignoredSecret: "ignored-response-secret",
  };
  const mock = createMockFetch([jsonResponse(valid)]);
  const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
  const result = await client.getFileMetadata("file_123");
  assert.equal("ignoredSecret" in result, false);
  const { ignoredSecret, ...expected } = valid;
  assert.equal(ignoredSecret, "ignored-response-secret");
  assert.deepEqual(result, expected);
}

async function testListBounds() {
  const thousandFiles = Array.from({ length: 1_000 }, (_, index) =>
    metadata({ id: `file-${String(index).padStart(4, "0")}` }),
  );
  {
    const mock = createMockFetch([jsonResponse({ files: thousandFiles })]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    assert.equal((await client.listAllChildren("parent_123")).length, 1_000);
  }
  {
    const mock = createMockFetch([
      jsonResponse({ files: [...thousandFiles, metadata({ id: "overflow" })] }),
    ]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    const error = await getAsyncError(() => client.listAllChildren("parent_123"));
    assertSafeError(error, "listAllChildren", 200, []);
  }

  const totalBoundaryResponses = Array.from(
    { length: 2 },
    (_, page) =>
      jsonResponse({
        files: [
          metadata({ id: `p${page}-0` }),
          metadata({ id: `p${page}-1` }),
        ],
        ...(page + 1 < 2
          ? { nextPageToken: `total-${page + 1}` }
          : {}),
      }),
  );
  {
    const mock = createMockFetch(totalBoundaryResponses);
    const client = new SettlementDriveClient(
      config,
      async () => TOKEN,
      mock.fetchImpl,
      TEST_LIST_LIMITS,
    );
    assert.equal((await client.listAllChildren("parent_123")).length, 4);
  }
  {
    const mock = createMockFetch([
      ...Array.from({ length: 2 }, (_, page) =>
        jsonResponse({
          files: [
            metadata({ id: `p${page}-0` }),
            metadata({ id: `p${page}-1` }),
          ],
          nextPageToken: `overflow-${page + 1}`,
        }),
      ),
      jsonResponse({ files: [metadata({ id: "one-too-many" })] }),
    ]);
    const client = new SettlementDriveClient(
      config,
      async () => TOKEN,
      mock.fetchImpl,
      TEST_LIST_LIMITS,
    );
    const error = await getAsyncError(() => client.listAllChildren("parent_123"));
    assertSafeError(error, "listAllChildren", 200, []);
  }

  {
    const responses = Array.from({ length: 3 }, (_, page) =>
      jsonResponse({
        files: [],
        ...(page + 1 < 3 ? { nextPageToken: `page-${page + 1}` } : {}),
      }),
    );
    const mock = createMockFetch(responses);
    const client = new SettlementDriveClient(
      config,
      async () => TOKEN,
      mock.fetchImpl,
      TEST_LIST_LIMITS,
    );
    assert.deepEqual(await client.listAllChildren("parent_123"), []);
    assert.equal(mock.calls.length, 3);
  }
  {
    const responses = Array.from({ length: 3 }, (_, page) =>
      jsonResponse({ files: [], nextPageToken: `too-many-${page + 1}` }),
    );
    const mock = createMockFetch(responses);
    const client = new SettlementDriveClient(
      config,
      async () => TOKEN,
      mock.fetchImpl,
      TEST_LIST_LIMITS,
    );
    const error = await getAsyncError(() => client.listAllChildren("parent_123"));
    assertSafeError(error, "listAllChildren", 200, []);
    assert.equal(mock.calls.length, 3);
  }
}

function testInjectedListLimitsAreValidated() {
  const invalidLimits = [
    { maxListPages: 0 },
    { maxListPages: -1 },
    { maxListPages: 1.5 },
    { maxListPages: Number.NaN },
    { maxListPages: Number.POSITIVE_INFINITY },
    { maxListPages: 1_001 },
    { maxListFiles: 0 },
    { maxListFiles: -1 },
    { maxListFiles: 1.5 },
    { maxListFiles: Number.NaN },
    { maxListFiles: Number.POSITIVE_INFINITY },
    { maxListFiles: 500_001 },
  ];

  for (const limits of invalidLimits) {
    const mock = createMockFetch([]);
    assert.throws(
      () =>
        new SettlementDriveClient(
          config,
          async () => TOKEN,
          mock.fetchImpl,
          limits,
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assertSafeError(error, "listAllChildren", undefined, []);
        return true;
      },
    );
    assert.equal(mock.calls.length, 0);
  }

  for (const limits of [
    { maxListPages: 1, maxListFiles: 1 },
    { maxListPages: 1_000, maxListFiles: 500_000 },
  ]) {
    assert.doesNotThrow(
      () =>
        new SettlementDriveClient(
          config,
          async () => TOKEN,
          createMockFetch([]).fetchImpl,
          limits,
        ),
    );
  }
}

async function testJsonBodyByteLimitAndInvalidJson() {
  {
    const mock = createMockFetch([paddedMetadataResponse(MAX_JSON_RESPONSE_BYTES)]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    assert.deepEqual(await client.getFileMetadata("file_123"), metadata());
  }
  {
    const mock = createMockFetch([
      paddedMetadataResponse(
        MAX_JSON_RESPONSE_BYTES + 1,
        "1",
        "oversized-response-secret",
      ),
    ]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    const error = await getAsyncError(() => client.getFileMetadata("file_123"));
    assertSafeError(error, "getFileMetadata", 200, [
      "ignored",
      "oversized-response-secret",
    ]);
  }
  {
    const mock = createMockFetch([
      new Response(`{"secret":"${SECRET_BODY}"`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    const error = await getAsyncError(() => client.getFileMetadata("file_123"));
    assertSafeError(error, "getFileMetadata", 200, []);
  }
  {
    const invalidUtf8 = new Uint8Array([
      ...new TextEncoder().encode('{"id":"file","name":"'),
      0xc3,
      0x28,
      ...new TextEncoder().encode('","mimeType":"opaque"}'),
    ]);
    const mock = createMockFetch([new Response(invalidUtf8)]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    const error = await getAsyncError(() => client.getFileMetadata("file_123"));
    assertSafeError(error, "getFileMetadata", 200, []);
  }
}

async function testRejectedBodiesAreCanceled() {
  {
    const rejected = cancellableResponse(200, {
      "Content-Length": String(MAX_JSON_RESPONSE_BYTES + 1),
    });
    const mock = createMockFetch([rejected.response]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    const error = await getAsyncError(() => client.getFileMetadata("file_123"));
    assertSafeError(error, "getFileMetadata", 200, []);
    assert.equal(rejected.wasCanceled(), true);
  }
  {
    const rejected = cancellableResponse(403);
    const mock = createMockFetch([rejected.response]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    const error = await getAsyncError(() => client.getFileMetadata("file_123"));
    assertSafeError(error, "getFileMetadata", 403, []);
    assert.equal(rejected.wasCanceled(), true);
  }
}

async function testRepeatedPageTokenFails() {
  const mock = createMockFetch([
    jsonResponse({ files: [], nextPageToken: "same-token" }),
    jsonResponse({ files: [], nextPageToken: "same-token" }),
  ]);
  const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
  const error = await getAsyncError(() => client.listAllChildren("parent_123"));

  assertSafeError(error, "listAllChildren", 200, ["same-token", "parent_123"]);
  assert.equal(mock.calls.length, 2);
}

async function testOpaquePageTokenIsEncodedAndPreserved() {
  const pageToken = "次/頁\\\n😀";
  const mock = createMockFetch([
    jsonResponse({ files: [], nextPageToken: pageToken }),
    jsonResponse({ files: null }),
  ]);
  const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);

  assert.deepEqual(await client.listAllChildren("parent_123"), []);
  assert.equal(mock.calls.length, 2);
  const secondUrl = getUrl(mock.calls[1]);
  assert.equal(secondUrl.searchParams.get("pageToken"), pageToken);
  assert.match(secondUrl.search, /pageToken=%E6%AC%A1%2F%E9%A0%81%5C%0A%F0%9F%98%80/);
}

async function testInvalidPageTokenFailsBeforeNextFetch() {
  for (const nextPageToken of [null, 1, "", "bad\ud800token"]) {
    const mock = createMockFetch([
      jsonResponse({ files: [], nextPageToken }),
    ]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    const error = await getAsyncError(() => client.listAllChildren("parent_123"));

    assertSafeError(error, "listAllChildren", 200, ["parent_123"]);
    assert.equal(mock.calls.length, 1);
  }
}

async function testStartResumableUpload() {
  const sessionUrl =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=valid_session-123";
  const uploadResponse = cancellableResponse(200, { Location: sessionUrl });
  const mock = createMockFetch([uploadResponse.response]);
  const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);

  assert.equal(
    await client.startResumableUpload({
      parentId: "parent_123",
      name: "settlement.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 12345,
    }),
    sessionUrl,
  );
  assert.equal(uploadResponse.wasCanceled(), true);
  const call = mock.calls[0];
  assertCommonRequest(call, "POST");
  const url = getUrl(call);
  assert.equal(url.origin, "https://www.googleapis.com");
  assert.equal(url.pathname, "/upload/drive/v3/files");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    uploadType: "resumable",
    supportsAllDrives: "true",
    fields: "id,name,mimeType,parents,size,md5Checksum,sha1Checksum,sha256Checksum,version,headRevisionId,modifiedTime,trashed,driveId,webViewLink,appProperties",
  });
  const headers = getHeaders(call);
  assert.deepEqual(Object.fromEntries(headers), {
    accept: "application/json",
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    "x-upload-content-length": "12345",
    "x-upload-content-type":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    name: "settlement.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    parents: ["parent_123"],
  });
}

async function testHttpErrorsArePrivacySafe() {
  const operations = [
    {
      name: "createFolder",
      run: (client: SettlementDriveClient) =>
        client.createFolder("secret_parent", "secret-folder-name"),
      secrets: ["secret_parent", "secret-folder-name"],
    },
    {
      name: "getFileMetadata",
      run: (client: SettlementDriveClient) => client.getFileMetadata("secret_file"),
      secrets: ["secret_file"],
    },
    {
      name: "listAllChildren",
      run: (client: SettlementDriveClient) => client.listAllChildren("secret_parent"),
      secrets: ["secret_parent"],
    },
    {
      name: "startResumableUpload",
      run: (client: SettlementDriveClient) =>
        client.startResumableUpload({
          parentId: "secret_parent",
          name: "secret-name.xlsx",
          mimeType: "application/octet-stream",
          sizeBytes: 12,
        }),
      secrets: ["secret_parent", "secret-name.xlsx"],
    },
  ];

  for (const operation of operations) {
    const mock = createMockFetch([
      new Response(SECRET_BODY, {
        status: 403,
        headers: { Location: SECRET_LOCATION, "X-Google-Secret": "header-secret" },
      }),
    ]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    const error = await getAsyncError(() => operation.run(client));
    assertSafeError(error, operation.name, 403, ["header-secret", ...operation.secrets]);
  }
}

async function testLocationFailuresArePrivacySafe() {
  for (const location of [
    undefined,
    SECRET_LOCATION,
    "http://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=location-secret",
    "https://www.googleapis.com/drive/v3/files?uploadType=resumable&upload_id=location-secret",
    "https://www.googleapis.com/upload/drive/v3/files?upload_id=location-secret",
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=media&upload_id=location-secret",
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&uploadType=resumable&upload_id=location-secret",
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=location-secret&upload_id=second-secret",
    "https://user:password@www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=location-secret",
    "https://www.googleapis.com:443/upload/drive/v3/files?uploadType=resumable&upload_id=location-secret",
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=location-secret#fragment",
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=",
  ]) {
    const headers = location ? { Location: location } : undefined;
    const uploadResponse = cancellableResponse(200, headers);
    const mock = createMockFetch([uploadResponse.response]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    const error = await getAsyncError(() =>
      client.startResumableUpload({
        parentId: "parent_123",
        name: "secret-name.xlsx",
        mimeType: "application/octet-stream",
        sizeBytes: 12,
      }),
    );
    assertSafeError(error, "startResumableUpload", 200, [location ?? "", "secret-name.xlsx"]);
    assert.equal(uploadResponse.wasCanceled(), true);
  }
}

async function testTokenProviderFailureIsPrivacySafe() {
  const mock = createMockFetch([]);
  const client = new SettlementDriveClient(
    config,
    async () => {
      throw new Error(`provider failed with ${TOKEN}`);
    },
    mock.fetchImpl,
  );
  const error = await getAsyncError(() => client.getFileMetadata("file_123"));

  assertSafeError(error, "getFileMetadata", undefined, ["provider failed", "file_123"]);
  assert.equal(mock.calls.length, 0);
}

async function testValidationDoesNotFetch() {
  const invalidRuns: Array<(client: SettlementDriveClient) => Promise<unknown>> = [
    (client) => client.createFolder("bad/id", "valid-name"),
    (client) => client.createFolder("valid_id", "bad/name"),
    (client) => client.createFolder("valid_id", "bad\\name"),
    (client) => client.createFolder("valid_id", "bad\nname"),
    (client) => client.createFolder("valid_id", "bad\u0085name"),
    (client) => client.createFolder("valid_id", "."),
    (client) => client.createFolder("valid_id", ".."),
    (client) => client.createFolder("valid_id", ""),
    (client) => client.createFolder("valid_id", "a".repeat(256)),
    (client) => client.createFolder("valid_id", "あ".repeat(256)),
    (client) => client.getFileMetadata("bad\u0000id"),
    (client) => client.startResumableUpload({ parentId: "valid_id", name: "valid.bin", mimeType: "bad\nmime", sizeBytes: 1 }),
    (client) => client.startResumableUpload({ parentId: "valid_id", name: "valid.bin", mimeType: "application/octet-stream", sizeBytes: -1 }),
    (client) => client.startResumableUpload({ parentId: "valid_id", name: "valid.bin", mimeType: "application/octet-stream", sizeBytes: Number.MAX_SAFE_INTEGER + 1 }),
  ];

  for (const run of invalidRuns) {
    const mock = createMockFetch([]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    const error = await getAsyncError(() => run(client));
    assert.ok(error instanceof SettlementDriveError);
    assert.equal(error.status, undefined);
    assert.equal(mock.calls.length, 0);
  }


  for (const validName of ["a".repeat(255), "あ".repeat(255)]) {
    const response = metadata({
      id: "folder-result",
      name: validName,
      mimeType: "application/vnd.google-apps.folder",
    });
    const mock = createMockFetch([jsonResponse(response)]);
    const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);
    assert.equal((await client.createFolder("valid_id", validName)).name, validName);
    assert.equal(mock.calls.length, 1);
  }
}

async function testBackupIdentityAndUploadPrimitives() {
  const appProperties = {
    backup_identity: "source_file:version-1:object-1",
    content_sha256: "a".repeat(64),
  };
  const found = metadata({
    id: "existing_file",
    parents: ["backup_root"],
    size: "3",
    sha256Checksum: "a".repeat(64),
    appProperties,
  });
  const sessionUrl =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=backup-session";
  const uploaded = metadata({
    id: "uploaded_file",
    parents: ["backup_root"],
    size: "3",
    sha256Checksum: "a".repeat(64),
    appProperties,
  });
  const mock = createMockFetch([
    jsonResponse({ files: [found] }),
    new Response(null, { status: 200, headers: { Location: sessionUrl } }),
    jsonResponse(uploaded, { status: 201 }),
  ]);
  const client = new SettlementDriveClient(config, async () => TOKEN, mock.fetchImpl);

  const reconciled = await client.findUniqueByAppProperties("backup_root", appProperties);
  assert.equal(reconciled?.id, "existing_file");
  assert.deepEqual({ ...reconciled?.appProperties }, appProperties);
  const query = getUrl(mock.calls[0]).searchParams.get("q") ?? "";
  assert.equal(
    query,
    "'backup_root' in parents and trashed = false and appProperties has { key='backup_identity' and value='source_file:version-1:object-1' } and appProperties has { key='content_sha256' and value='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }",
  );
  assert.equal(getUrl(mock.calls[0]).searchParams.get("pageSize"), "2");

  const issued = await client.startResumableUpload({
    parentId: "backup_root",
    name: "source.bin",
    mimeType: "application/octet-stream",
    sizeBytes: 3,
    appProperties,
  });
  assert.equal(issued, sessionUrl);
  assert.deepEqual(JSON.parse(String(mock.calls[1].init?.body)).appProperties, appProperties);

  assert.deepEqual(
    await client.uploadResumableBytes({
      sessionUrl: issued,
      bytes: Buffer.from("abc"),
      mimeType: "application/octet-stream",
      expectedSizeBytes: 3,
      expectedParentId: "backup_root",
      expectedAppProperties: appProperties,
    }),
    uploaded,
  );
  const uploadHeaders = getHeaders(mock.calls[2]);
  assert.equal(mock.calls[2].init?.method, "PUT");
  assert.equal(uploadHeaders.get("content-length"), "3");
  assert.equal(uploadHeaders.get("content-range"), "bytes 0-2/3");
  assert.equal(Buffer.from(mock.calls[2].init?.body as Uint8Array).toString(), "abc");

  const reconciliationCases: Array<{
    body: { files: ReturnType<typeof metadata>[]; nextPageToken?: string };
    expectNull: boolean;
  }> = [
    { body: { files: [] }, expectNull: true },
    { body: { files: [found, metadata({ id: "duplicate" })] }, expectNull: false },
    { body: { files: [found], nextPageToken: "more" }, expectNull: false },
  ];
  for (const testCase of reconciliationCases) {
    const one = createMockFetch([jsonResponse(testCase.body)]);
    const candidate = new SettlementDriveClient(config, async () => TOKEN, one.fetchImpl);
    if (testCase.expectNull) {
      assert.equal(await candidate.findUniqueByAppProperties("backup_root", appProperties), null);
    } else {
      const error = await getAsyncError(() =>
        candidate.findUniqueByAppProperties("backup_root", appProperties),
      );
      assertSafeError(error, "findUniqueByAppProperties", 200, []);
    }
  }

  const invalidProperties: Array<Record<string, string>> = [
    { bad: "quote'value" },
    { bad: "slash/value" },
    { "bad-key": "value" },
    {},
  ];
  for (const invalid of invalidProperties) {
    const noFetch = createMockFetch([]);
    const candidate = new SettlementDriveClient(config, async () => TOKEN, noFetch.fetchImpl);
    await getAsyncError(() => candidate.findUniqueByAppProperties("backup_root", invalid));
    assert.equal(noFetch.calls.length, 0);
  }

  const invalidRuntimeProperties: unknown[] = [
    { bad: 123 },
    { bad: { toString() { throw new Error("secret-toString"); } } },
  ];
  for (const invalid of invalidRuntimeProperties) {
    const noFetch = createMockFetch([]);
    const candidate = new SettlementDriveClient(config, async () => TOKEN, noFetch.fetchImpl);
    const error = await getAsyncError(() =>
      candidate.findUniqueByAppProperties(
        "backup_root",
        invalid as Record<string, string>,
      ),
    );
    assertSafeError(error, "findUniqueByAppProperties", undefined, ["secret-toString"]);
    assert.equal(noFetch.calls.length, 0);
  }

  for (const mismatched of [
    metadata({ id: "wrong-parent", parents: ["other"], appProperties }),
    metadata({ id: "missing-properties", parents: ["backup_root"] }),
    metadata({
      id: "extra-properties",
      parents: ["backup_root"],
      appProperties: { ...appProperties, extra: "value" },
    }),
  ]) {
    const one = createMockFetch([jsonResponse({ files: [mismatched] })]);
    const candidate = new SettlementDriveClient(config, async () => TOKEN, one.fetchImpl);
    await getAsyncError(() =>
      candidate.findUniqueByAppProperties("backup_root", appProperties),
    );
  }

  const wrongLength = createMockFetch([]);
  const candidate = new SettlementDriveClient(config, async () => TOKEN, wrongLength.fetchImpl);
  await getAsyncError(() => candidate.uploadResumableBytes({
    sessionUrl,
    bytes: Buffer.from("ab"),
    mimeType: "application/octet-stream",
    expectedSizeBytes: 3,
    expectedParentId: "backup_root",
    expectedAppProperties: appProperties,
  }));
  assert.equal(wrongLength.calls.length, 0);

  const incomplete = createMockFetch([
    new Response(null, { status: 308, headers: { Range: "bytes=0-1" } }),
  ]);
  const incompleteClient = new SettlementDriveClient(
    config,
    async () => TOKEN,
    incomplete.fetchImpl,
  );
  const incompleteError = await getAsyncError(() =>
    incompleteClient.uploadResumableBytes({
      sessionUrl,
      bytes: Buffer.from("abc"),
      mimeType: "application/octet-stream",
      expectedSizeBytes: 3,
      expectedParentId: "backup_root",
      expectedAppProperties: appProperties,
    }),
  );
  assertSafeError(incompleteError, "uploadResumableBytes", 308, [sessionUrl]);

  const unsafeSession = createMockFetch([]);
  const unsafeClient = new SettlementDriveClient(config, async () => TOKEN, unsafeSession.fetchImpl);
  const unsafeError = await getAsyncError(() => unsafeClient.uploadResumableBytes({
    sessionUrl: "https://evil.example/upload/drive/v3/files?uploadType=resumable&upload_id=secret",
    bytes: Buffer.from("abc"),
    mimeType: "application/octet-stream",
    expectedSizeBytes: 3,
    expectedParentId: "backup_root",
    expectedAppProperties: appProperties,
  }));
  assertSafeError(unsafeError, "uploadResumableBytes", 0, ["evil.example", "secret"]);
  assert.equal(unsafeSession.calls.length, 0);

  const metadataMismatches = [
    metadata({ ...uploaded, size: "4" }),
    metadata({ ...uploaded, mimeType: "text/plain" }),
    metadata({ ...uploaded, parents: ["other"] }),
    metadata({ ...uploaded, appProperties: { ...appProperties, extra: "value" } }),
  ];
  for (const mismatched of metadataMismatches) {
    const one = createMockFetch([jsonResponse(mismatched, { status: 201 })]);
    const candidate = new SettlementDriveClient(config, async () => TOKEN, one.fetchImpl);
    await getAsyncError(() => candidate.uploadResumableBytes({
      sessionUrl,
      bytes: Buffer.from("abc"),
      mimeType: "application/octet-stream",
      expectedSizeBytes: 3,
      expectedParentId: "backup_root",
      expectedAppProperties: appProperties,
    }));
  }

  const zeroMetadata = metadata({
    id: "empty_file",
    parents: ["backup_root"],
    size: "0",
    appProperties,
  });
  const zero = createMockFetch([jsonResponse(zeroMetadata, { status: 201 })]);
  const zeroClient = new SettlementDriveClient(config, async () => TOKEN, zero.fetchImpl);
  assert.deepEqual(await zeroClient.uploadResumableBytes({
    sessionUrl,
    bytes: Buffer.alloc(0),
    mimeType: "application/octet-stream",
    expectedSizeBytes: 0,
    expectedParentId: "backup_root",
    expectedAppProperties: appProperties,
  }), zeroMetadata);
  assert.equal(zero.calls.length, 1);
  const zeroHeaders = getHeaders(zero.calls[0]);
  assert.equal(zeroHeaders.get("content-length"), "0");
  assert.equal(zeroHeaders.get("content-range"), "bytes */0");
}

async function main() {
  await testCreateFolder();
  await testUnicodeNamesArePreserved();
  await testGetFileMetadata();
  await testListAllChildrenPagination();
  await testListPreservesNaturalOrderAndSortsExactNameTiesById();
  await testRuntimeResponseValidation();
  await testListBounds();
  testInjectedListLimitsAreValidated();
  await testJsonBodyByteLimitAndInvalidJson();
  await testRejectedBodiesAreCanceled();
  await testRepeatedPageTokenFails();
  await testOpaquePageTokenIsEncodedAndPreserved();
  await testInvalidPageTokenFailsBeforeNextFetch();
  await testStartResumableUpload();
  await testHttpErrorsArePrivacySafe();
  await testLocationFailuresArePrivacySafe();
  await testTokenProviderFailureIsPrivacySafe();
  await testValidationDoesNotFetch();
  await testBackupIdentityAndUploadPrimitives();
  console.log("test-settlement-drive-client: all assertions passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
