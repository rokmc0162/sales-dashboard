import "server-only";

import { NextResponse } from "next/server";

export const AUTH_UPSTREAM_TIMEOUT_MS = 5_000;
export const AUTH_UPSTREAM_BODY_TIMEOUT_MS = 5_000;
export const AUTH_UPSTREAM_BODY_MAX_BYTES = 64 * 1_024;
export const LOGIN_BODY_MAX_BYTES = 4_096;

export type AuthFetchDependencies = {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  bodyTimeoutMs?: number;
  responseMaxBytes?: number;
};

export class AuthUpstreamTimeoutError extends Error {
  constructor() {
    super("Authentication provider timeout");
    this.name = "AuthUpstreamTimeoutError";
  }
}

export class AuthUpstreamBodyError extends Error {
  constructor() {
    super("Invalid authentication provider response");
    this.name = "AuthUpstreamBodyError";
  }
}

export async function fetchAuthUpstream(
  input: string | URL,
  init: RequestInit,
  dependencies: AuthFetchDependencies = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    dependencies.timeoutMs ?? AUTH_UPSTREAM_TIMEOUT_MS,
  );

  try {
    return await (dependencies.fetch ?? globalThis.fetch)(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new AuthUpstreamTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function discardUpstreamBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Never parse or log provider error bodies, which may contain sensitive data.
  }
}

export async function readBoundedUpstreamJson(
  response: Response,
  dependencies: AuthFetchDependencies = {},
): Promise<unknown> {
  const maxBytes =
    dependencies.responseMaxBytes ?? AUTH_UPSTREAM_BODY_MAX_BYTES;
  const timeoutMs =
    dependencies.bodyTimeoutMs ?? AUTH_UPSTREAM_BODY_TIMEOUT_MS;
  const contentLength = response.headers.get("content-length");
  if (
    maxBytes <= 0 ||
    timeoutMs <= 0 ||
    (contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) ||
    !response.body
  ) {
    await discardUpstreamBody(response);
    throw new AuthUpstreamBodyError();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new AuthUpstreamTimeoutError()), timeoutMs);
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timedOut]);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) throw new AuthUpstreamBodyError();
      chunks.push(value);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new AuthUpstreamBodyError();
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function authJson(
  body: unknown,
  init?: ResponseInit,
): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function readBoundedJson(
  request: Request,
  maxBytes: number = LOGIN_BODY_MAX_BYTES,
): Promise<unknown> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") throw new Error("Invalid request");

  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)
  ) {
    throw new Error("Invalid request");
  }

  if (!request.body) throw new Error("Invalid request");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Invalid request");
    }
    chunks.push(value);
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
    throw new Error("Invalid request");
  }
}
