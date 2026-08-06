import "server-only";

import type { SettlementDriveConfig } from "./config.server";

type EnabledSettlementDriveConfig = Extract<
  SettlementDriveConfig,
  { enabled: true }
>;

export type SettlementDriveClientConfig = Pick<
  EnabledSettlementDriveConfig,
  "sharedDriveId"
>;

export type SettlementDriveClientLimits = {
  maxListPages?: number;
  maxListFiles?: number;
};

export type SettlementDriveOperation =
  | "createFolder"
  | "getFileMetadata"
  | "listAllChildren"
  | "startResumableUpload";

export class SettlementDriveError extends Error {
  override readonly name = "SettlementDriveError";

  constructor(
    public readonly operation: SettlementDriveOperation,
    public readonly status: number | undefined,
  ) {
    super(
      status === undefined
        ? `Google Drive ${operation} failed`
        : `Google Drive ${operation} failed (HTTP ${status})`,
    );
  }
}

export type SettlementDriveFileMetadata = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  size?: string;
  md5Checksum?: string;
  sha1Checksum?: string;
  sha256Checksum?: string;
  version?: string;
  headRevisionId?: string;
  modifiedTime?: string;
  trashed?: boolean;
  driveId?: string;
  webViewLink?: string;
};

type ResumableUploadInput = {
  parentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

const API_ORIGIN = "https://www.googleapis.com";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const METADATA_FIELDS =
  "id,name,mimeType,parents,size,md5Checksum,sha1Checksum,sha256Checksum,version,headRevisionId,modifiedTime,trashed,driveId,webViewLink";
const WRITE_FIELDS = "id,name,mimeType,parents,driveId,webViewLink";
const LIST_FIELDS = `nextPageToken,files(${METADATA_FIELDS})`;
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const MIME_TYPE_PATTERN =
  /^[A-Za-z0-9!#$&^_.+-]{1,127}\/[A-Za-z0-9!#$&^_.+-]{1,127}$/;
const ACCESS_TOKEN_PATTERN = /^[\x21-\x7E]{1,8192}$/;
const UPLOAD_ID_PATTERN = /^[\x21-\x7E]{1,2048}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const MD5_PATTERN = /^[a-f0-9]{32}$/;
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_REQUEST_NAME_CODE_POINTS = 255;
const MAX_REQUEST_NAME_UTF8_BYTES = 1_024;
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_LIST_PAGE_FILES = 1_000;
const DEFAULT_MAX_LIST_PAGES = 1_000;
const DEFAULT_MAX_LIST_FILES = 500_000;

function failure(
  operation: SettlementDriveOperation,
  status?: number,
): SettlementDriveError {
  return new SettlementDriveError(operation, status);
}

function validateDriveId(
  value: string,
  operation: SettlementDriveOperation,
): void {
  if (!DRIVE_ID_PATTERN.test(value)) throw failure(operation);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isValidRequestName(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value === "." ||
    value === ".." ||
    value.length > MAX_REQUEST_NAME_CODE_POINTS * 2 ||
    !isWellFormedUnicode(value)
  ) {
    return false;
  }

  let codePoints = 0;
  for (const character of value) {
    codePoints += 1;
    if (codePoints > MAX_REQUEST_NAME_CODE_POINTS) return false;
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      character === "/" ||
      character === "\\"
    ) {
      return false;
    }
  }

  return (
    new TextEncoder().encode(value).byteLength <= MAX_REQUEST_NAME_UTF8_BYTES
  );
}

function validateRequestName(
  value: string,
  operation: SettlementDriveOperation,
): void {
  if (!isValidRequestName(value)) throw failure(operation);
}

function validateMimeType(
  value: string,
  operation: SettlementDriveOperation,
): void {
  if (value.length > 255 || !MIME_TYPE_PATTERN.test(value)) {
    throw failure(operation);
  }
}

function validateSize(
  value: number,
  operation: SettlementDriveOperation,
): void {
  if (!Number.isSafeInteger(value) || value < 0) throw failure(operation);
}

function isValidOpaqueResponseString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_JSON_RESPONSE_BYTES &&
    isWellFormedUnicode(value)
  );
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The privacy-safe operation error is authoritative.
  }
}

async function parseJson(
  response: Response,
  operation: SettlementDriveOperation,
): Promise<unknown> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (
      !/^(?:0|[1-9][0-9]*)$/.test(contentLength) ||
      !Number.isSafeInteger(parsedLength) ||
      parsedLength > MAX_JSON_RESPONSE_BYTES
    ) {
      await cancelResponseBody(response);
      throw failure(operation, response.status);
    }
  }

  if (!response.body) throw failure(operation, response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JSON_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The privacy-safe operation error below is authoritative.
        }
        throw failure(operation, response.status);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SettlementDriveError) throw error;
    throw failure(operation, response.status);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw failure(operation, response.status);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMetadata(
  value: unknown,
  operation: SettlementDriveOperation,
  status: number,
): SettlementDriveFileMetadata {
  if (
    !isRecord(value) ||
    !isValidOpaqueResponseString(value.id) ||
    !isValidOpaqueResponseString(value.name) ||
    !isValidOpaqueResponseString(value.mimeType)
  ) {
    throw failure(operation, status);
  }

  const result: SettlementDriveFileMetadata = {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
  };

  if (value.parents !== undefined) {
    if (
      !Array.isArray(value.parents) ||
      !value.parents.every(isValidOpaqueResponseString)
    ) {
      throw failure(operation, status);
    }
    result.parents = [...value.parents];
  }
  if (value.size !== undefined) {
    if (typeof value.size !== "string" || !DECIMAL_PATTERN.test(value.size)) {
      throw failure(operation, status);
    }
    result.size = value.size;
  }
  if (value.md5Checksum !== undefined) {
    if (
      typeof value.md5Checksum !== "string" ||
      !MD5_PATTERN.test(value.md5Checksum)
    ) {
      throw failure(operation, status);
    }
    result.md5Checksum = value.md5Checksum;
  }
  if (value.sha1Checksum !== undefined) {
    if (
      typeof value.sha1Checksum !== "string" ||
      !SHA1_PATTERN.test(value.sha1Checksum)
    ) {
      throw failure(operation, status);
    }
    result.sha1Checksum = value.sha1Checksum;
  }
  if (value.sha256Checksum !== undefined) {
    if (
      typeof value.sha256Checksum !== "string" ||
      !SHA256_PATTERN.test(value.sha256Checksum)
    ) {
      throw failure(operation, status);
    }
    result.sha256Checksum = value.sha256Checksum;
  }
  if (value.version !== undefined) {
    if (
      typeof value.version !== "string" ||
      !DECIMAL_PATTERN.test(value.version)
    ) {
      throw failure(operation, status);
    }
    result.version = value.version;
  }
  if (value.headRevisionId !== undefined) {
    if (!isValidOpaqueResponseString(value.headRevisionId)) {
      throw failure(operation, status);
    }
    result.headRevisionId = value.headRevisionId;
  }
  if (value.modifiedTime !== undefined) {
    if (
      typeof value.modifiedTime !== "string" ||
      value.modifiedTime.length > 35 ||
      !RFC3339_PATTERN.test(value.modifiedTime) ||
      !Number.isFinite(Date.parse(value.modifiedTime))
    ) {
      throw failure(operation, status);
    }
    result.modifiedTime = value.modifiedTime;
  }
  if (value.trashed !== undefined) {
    if (typeof value.trashed !== "boolean") throw failure(operation, status);
    result.trashed = value.trashed;
  }
  if (value.driveId !== undefined) {
    if (!isValidOpaqueResponseString(value.driveId)) {
      throw failure(operation, status);
    }
    result.driveId = value.driveId;
  }
  if (value.webViewLink !== undefined) {
    if (!isValidOpaqueResponseString(value.webViewLink)) {
      throw failure(operation, status);
    }
    result.webViewLink = value.webViewLink;
  }

  return result;
}

function compareCodePoints(left: string, right: string): number {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();

  while (true) {
    const leftNext = leftIterator.next();
    const rightNext = rightIterator.next();
    if (leftNext.done || rightNext.done) {
      if (leftNext.done && rightNext.done) return 0;
      return leftNext.done ? -1 : 1;
    }
    const difference =
      leftNext.value.codePointAt(0)! - rightNext.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
}

function sortEqualNameRuns(
  files: SettlementDriveFileMetadata[],
): SettlementDriveFileMetadata[] {
  let start = 0;
  while (start < files.length) {
    let end = start + 1;
    while (end < files.length && files[end].name === files[start].name) {
      end += 1;
    }
    if (end - start > 1) {
      const sortedRun = files
        .slice(start, end)
        .sort((left, right) => compareCodePoints(left.id, right.id));
      files.splice(start, sortedRun.length, ...sortedRun);
    }
    start = end;
  }
  return files;
}

function validateListLimit(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw failure("listAllChildren");
  }
}

function validateSessionUrl(
  value: string | null,
  operation: SettlementDriveOperation,
  status: number,
): string {
  if (!value || value.length > 8_192 || !/^[\x21-\x7E]+$/.test(value)) {
    throw failure(operation, status);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw failure(operation, status);
  }

  const uploadIds = url.searchParams.getAll("upload_id");
  const uploadTypes = url.searchParams.getAll("uploadType");
  if (
    !value.startsWith("https://www.googleapis.com/") ||
    url.protocol !== "https:" ||
    url.hostname !== "www.googleapis.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/upload/drive/v3/files" ||
    url.hash !== "" ||
    uploadTypes.length !== 1 ||
    uploadTypes[0] !== "resumable" ||
    uploadIds.length !== 1 ||
    !UPLOAD_ID_PATTERN.test(uploadIds[0])
  ) {
    throw failure(operation, status);
  }

  return value;
}

export class SettlementDriveClient {
  private readonly sharedDriveId: string;
  private readonly maxListPages: number;
  private readonly maxListFiles: number;

  constructor(
    config: SettlementDriveClientConfig,
    private readonly getAccessToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    limits: SettlementDriveClientLimits = {},
  ) {
    const maxListPages = limits.maxListPages ?? DEFAULT_MAX_LIST_PAGES;
    const maxListFiles = limits.maxListFiles ?? DEFAULT_MAX_LIST_FILES;
    validateListLimit(maxListPages, DEFAULT_MAX_LIST_PAGES);
    validateListLimit(maxListFiles, DEFAULT_MAX_LIST_FILES);

    this.sharedDriveId = config.sharedDriveId;
    this.maxListPages = maxListPages;
    this.maxListFiles = maxListFiles;
  }

  async createFolder(
    parentId: string,
    name: string,
  ): Promise<SettlementDriveFileMetadata> {
    const operation = "createFolder";
    validateDriveId(parentId, operation);
    validateRequestName(name, operation);

    const url = new URL("/drive/v3/files", API_ORIGIN);
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", WRITE_FIELDS);
    const response = await this.request(operation, url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME_TYPE,
        parents: [parentId],
      }),
    });
    return validateMetadata(
      await parseJson(response, operation),
      operation,
      response.status,
    );
  }

  async getFileMetadata(
    fileId: string,
  ): Promise<SettlementDriveFileMetadata> {
    const operation = "getFileMetadata";
    validateDriveId(fileId, operation);

    const url = new URL(`/drive/v3/files/${encodeURIComponent(fileId)}`, API_ORIGIN);
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", METADATA_FIELDS);
    const response = await this.request(operation, url, { method: "GET" });
    return validateMetadata(
      await parseJson(response, operation),
      operation,
      response.status,
    );
  }

  async listAllChildren(
    parentId: string,
  ): Promise<SettlementDriveFileMetadata[]> {
    const operation = "listAllChildren";
    validateDriveId(parentId, operation);
    validateDriveId(this.sharedDriveId, operation);

    const files: SettlementDriveFileMetadata[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    let lastStatus: number | undefined;

    for (let page = 1; page <= this.maxListPages; page += 1) {
      const url = new URL("/drive/v3/files", API_ORIGIN);
      url.searchParams.set("q", `'${parentId}' in parents and trashed = false`);
      url.searchParams.set("corpora", "drive");
      url.searchParams.set("driveId", this.sharedDriveId);
      url.searchParams.set("includeItemsFromAllDrives", "true");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("spaces", "drive");
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("orderBy", "name_natural");
      url.searchParams.set("fields", LIST_FIELDS);
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const response = await this.request(operation, url, { method: "GET" });
      lastStatus = response.status;
      const result = await parseJson(response, operation);
      if (!isRecord(result)) {
        throw failure(operation, response.status);
      }
      const rawFiles = result.files;
      if (
        rawFiles !== undefined &&
        rawFiles !== null &&
        !Array.isArray(rawFiles)
      ) {
        throw failure(operation, response.status);
      }
      const resultFiles = rawFiles ?? [];

      if (resultFiles.length > MAX_LIST_PAGE_FILES) {
        throw failure(operation, response.status);
      }
      const pageFiles = resultFiles.map((file) =>
        validateMetadata(file, operation, response.status),
      );
      if (files.length + pageFiles.length > this.maxListFiles) {
        throw failure(operation, response.status);
      }
      files.push(...pageFiles);

      if (result.nextPageToken === undefined) return sortEqualNameRuns(files);
      if (!isValidOpaqueResponseString(result.nextPageToken)) {
        throw failure(operation, response.status);
      }
      if (seenPageTokens.has(result.nextPageToken)) {
        throw failure(operation, response.status);
      }
      seenPageTokens.add(result.nextPageToken);
      pageToken = result.nextPageToken;
    }

    throw failure(operation, lastStatus);
  }

  async startResumableUpload({
    parentId,
    name,
    mimeType,
    sizeBytes,
  }: ResumableUploadInput): Promise<string> {
    const operation = "startResumableUpload";
    validateDriveId(parentId, operation);
    validateRequestName(name, operation);
    validateMimeType(mimeType, operation);
    validateSize(sizeBytes, operation);

    const url = new URL("/upload/drive/v3/files", API_ORIGIN);
    url.searchParams.set("uploadType", "resumable");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", WRITE_FIELDS);
    const response = await this.request(operation, url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(sizeBytes),
      },
      body: JSON.stringify({ name, mimeType, parents: [parentId] }),
    });

    const location = response.headers.get("Location");
    try {
      return validateSessionUrl(location, operation, response.status);
    } finally {
      await cancelResponseBody(response);
    }
  }

  private async request(
    operation: SettlementDriveOperation,
    url: URL,
    init: RequestInit,
  ): Promise<Response> {
    let token: string;
    try {
      token = await this.getAccessToken();
    } catch {
      throw failure(operation);
    }
    if (typeof token !== "string" || !ACCESS_TOKEN_PATTERN.test(token)) {
      throw failure(operation);
    }

    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${token}`);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers,
        redirect: "error",
      });
    } catch {
      throw failure(operation);
    }

    if (!response.ok) {
      await cancelResponseBody(response);
      throw failure(operation, response.status);
    }
    return response;
  }
}
