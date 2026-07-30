import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request as requestHttp } from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { dirname } from "node:path";

import { nodeRuntimeFetch, type RuntimeFetch } from "./fetch";

export interface RuntimeDownloadRequest {
  url: URL;
  destination: string;
  expectedSize: number;
  expectedSha256: string;
  signal: AbortSignal;
  onProgress: (received: number, total: number) => void;
  maxRedirects?: number;
  partialMaxAgeMs?: number;
  now?: () => Date;
  timeouts?: Partial<RuntimeDownloadTimeouts>;
  transport?: RuntimeDownloadTransport;
}

export interface RuntimeDownloadTimeouts {
  connectMs: number;
  readMs: number;
  overallMs: number;
}

export interface RuntimePartialPaths {
  data: string;
  metadata: string;
}

export interface RuntimeDownloadResponse {
  statusCode: number;
  getHeader(name: string): string | null;
  body: AsyncIterable<Uint8Array>;
  discard(): void;
  cancel(error?: Error): void;
}

export interface RuntimeDownloadTransport {
  get(
    url: URL,
    headers: Record<string, string>,
    signal: AbortSignal,
    timeouts: RuntimeDownloadTimeouts,
    maxRedirects: number,
  ): Promise<RuntimeDownloadResponse>;
}

export type RuntimeDownloadUrlResolver = (
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  timeouts: RuntimeDownloadTimeouts,
  maxRedirects: number,
) => Promise<URL>;

interface RuntimePartialMetadata {
  schemaVersion: 1;
  url: string;
  expectedSize: number;
  expectedSha256: string;
  received: number;
  etag: string | null;
  lastModified: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ResumeState {
  received: number;
  etag: string | null;
  lastModified: string | null;
  createdAt: string;
}

const DEFAULT_TIMEOUTS: RuntimeDownloadTimeouts = {
  connectMs: 15_000,
  readMs: 30_000,
  overallMs: 30 * 60_000,
};
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_PARTIAL_MAX_AGE_MS = 24 * 60 * 60_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const METADATA_FIELDS = new Set([
  "schemaVersion",
  "url",
  "expectedSize",
  "expectedSha256",
  "received",
  "etag",
  "lastModified",
  "createdAt",
  "updatedAt",
]);

export class RuntimeDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeDownloadError";
  }
}

export class RuntimeDownloadTimeoutError extends RuntimeDownloadError {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeDownloadTimeoutError";
  }
}

export class RuntimeDownloadCancelledError extends RuntimeDownloadError {
  constructor() {
    super("Runtime download was cancelled");
    this.name = "RuntimeDownloadCancelledError";
  }
}

export class RuntimeDownloadIntegrityError extends RuntimeDownloadError {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeDownloadIntegrityError";
  }
}

export function runtimePartialPaths(destination: string): RuntimePartialPaths {
  return {
    data: `${destination}.part`,
    metadata: `${destination}.part.json`,
  };
}

function validateRequest(request: RuntimeDownloadRequest): void {
  if (request.url.protocol !== "http:" && request.url.protocol !== "https:") {
    throw new RuntimeDownloadError("Runtime download URL must use HTTP(S)");
  }
  if (
    request.url.username.length > 0 ||
    request.url.password.length > 0 ||
    request.url.hash.length > 0
  ) {
    throw new RuntimeDownloadError(
      "Runtime download URL must not contain credentials or a fragment",
    );
  }
  if (
    !Number.isSafeInteger(request.expectedSize) ||
    request.expectedSize <= 0
  ) {
    throw new RuntimeDownloadError(
      "Runtime download expectedSize must be a positive safe integer",
    );
  }
  if (!SHA256_PATTERN.test(request.expectedSha256)) {
    throw new RuntimeDownloadError(
      "Runtime download expectedSha256 must be lowercase SHA-256",
    );
  }
  if (request.destination.length === 0) {
    throw new RuntimeDownloadError(
      "Runtime download destination must not be empty",
    );
  }
}

function resolveTimeouts(
  values: Partial<RuntimeDownloadTimeouts> | undefined,
): RuntimeDownloadTimeouts {
  const result = { ...DEFAULT_TIMEOUTS, ...values };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RuntimeDownloadError(
        `Runtime download ${name} timeout must be a positive integer`,
      );
    }
  }
  return result;
}

async function inspectRegularFile(
  path: string,
): Promise<{ exists: false } | { exists: true; size: number }> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new RuntimeDownloadError(
        `Runtime partial path must be a regular file: ${path}`,
      );
    }
    return { exists: true, size: metadata.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

async function clearPartial(paths: RuntimePartialPaths): Promise<void> {
  await Promise.all([
    rm(paths.data, { force: true }),
    rm(paths.metadata, { force: true }),
  ]);
}

function parseMetadata(raw: string): RuntimePartialMetadata | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (
    keys.length !== METADATA_FIELDS.size ||
    keys.some((key) => !METADATA_FIELDS.has(key))
  ) {
    return null;
  }
  if (
    object.schemaVersion !== 1 ||
    typeof object.url !== "string" ||
    !Number.isSafeInteger(object.expectedSize) ||
    typeof object.expectedSha256 !== "string" ||
    !Number.isSafeInteger(object.received) ||
    (object.etag !== null && typeof object.etag !== "string") ||
    (object.lastModified !== null && typeof object.lastModified !== "string") ||
    typeof object.createdAt !== "string" ||
    typeof object.updatedAt !== "string"
  ) {
    return null;
  }
  return object as unknown as RuntimePartialMetadata;
}

async function writeMetadata(
  path: string,
  metadata: RuntimePartialMetadata,
): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(metadata), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
        await rm(path, { force: true });
        await rename(temporary, path);
      },
    );
  } finally {
    await rm(temporary, { force: true });
  }
}

async function hashFile(path: string): Promise<{
  size: number;
  sha256: string;
}> {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    digest.update(bytes);
  }
  return { size, sha256: digest.digest("hex") };
}

async function finalizeVerifiedPartial(
  request: RuntimeDownloadRequest,
  paths: RuntimePartialPaths,
): Promise<boolean> {
  const metadata = await stat(paths.data).catch(() => null);
  if (metadata === null || metadata.size !== request.expectedSize) return false;
  const actual = await hashFile(paths.data);
  if (
    actual.size !== request.expectedSize ||
    actual.sha256 !== request.expectedSha256
  ) {
    await clearPartial(paths);
    return false;
  }
  await rm(request.destination, { force: true });
  await rename(paths.data, request.destination);
  await rm(paths.metadata, { force: true });
  request.onProgress(request.expectedSize, request.expectedSize);
  return true;
}

async function loadResumeState(
  request: RuntimeDownloadRequest,
  paths: RuntimePartialPaths,
  now: Date,
  maxAgeMs: number,
): Promise<ResumeState | null> {
  const [data, metadataFile] = await Promise.all([
    inspectRegularFile(paths.data),
    inspectRegularFile(paths.metadata),
  ]);
  if (!data.exists || !metadataFile.exists) {
    if (data.exists || metadataFile.exists) await clearPartial(paths);
    return null;
  }
  const metadata = parseMetadata(await readFile(paths.metadata, "utf8"));
  const updatedAt = metadata ? new Date(metadata.updatedAt) : null;
  const age = updatedAt ? now.valueOf() - updatedAt.valueOf() : Number.NaN;
  if (
    metadata === null ||
    metadata.url !== request.url.href ||
    metadata.expectedSize !== request.expectedSize ||
    metadata.expectedSha256 !== request.expectedSha256 ||
    metadata.received !== data.size ||
    metadata.received < 0 ||
    metadata.received > request.expectedSize ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > maxAgeMs ||
    Number.isNaN(new Date(metadata.createdAt).valueOf())
  ) {
    await clearPartial(paths);
    return null;
  }
  return {
    received: metadata.received,
    etag: metadata.etag,
    lastModified: metadata.lastModified,
    createdAt: metadata.createdAt,
  };
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value ?? null;
}

function contentLength(response: RuntimeDownloadResponse): number | null {
  const raw = response.getHeader("content-length");
  if (raw === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new RuntimeDownloadIntegrityError(
      "Runtime download Content-Length is invalid",
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new RuntimeDownloadIntegrityError(
      "Runtime download Content-Length is too large",
    );
  }
  return value;
}

function validateContentRange(
  response: RuntimeDownloadResponse,
  start: number,
  expectedSize: number,
): void {
  const raw = response.getHeader("content-range");
  const match = raw ? /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(raw) : null;
  if (!match) {
    throw new RuntimeDownloadIntegrityError(
      "Runtime download Content-Range is missing or invalid",
    );
  }
  const responseStart = Number(match[1]);
  const responseEnd = Number(match[2]);
  const total = Number(match[3]);
  if (
    responseStart !== start ||
    responseEnd < responseStart ||
    responseEnd !== expectedSize - 1 ||
    total !== expectedSize
  ) {
    throw new RuntimeDownloadIntegrityError(
      "Runtime download Content-Range does not match the requested partial",
    );
  }
  const length = contentLength(response);
  if (length !== null && length !== responseEnd - responseStart + 1) {
    throw new RuntimeDownloadIntegrityError(
      "Runtime download partial Content-Length does not match Content-Range",
    );
  }
}

function validatorsMatch(
  state: ResumeState,
  response: RuntimeDownloadResponse,
): boolean {
  const etag = response.getHeader("etag");
  const lastModified = response.getHeader("last-modified");
  return !(
    (state.etag !== null && etag !== state.etag) ||
    (state.lastModified !== null && lastModified !== state.lastModified)
  );
}

function createOperationSignal(
  userSignal: AbortSignal,
  overallMs: number,
): {
  signal: AbortSignal;
  dispose: () => void;
  didOverallTimeout: () => boolean;
} {
  const controller = new AbortController();
  let overallTimedOut = false;
  const onAbort = (): void => controller.abort(userSignal.reason);
  userSignal.addEventListener("abort", onAbort, { once: true });
  if (userSignal.aborted) controller.abort(userSignal.reason);
  const timer = setTimeout(() => {
    overallTimedOut = true;
    controller.abort();
  }, overallMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      userSignal.removeEventListener("abort", onAbort);
    },
    didOverallTimeout: () => overallTimedOut,
  };
}

function openRequest(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  timeouts: RuntimeDownloadTimeouts,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? requestHttps : requestHttp;
    let settled = false;
    let connectTimer: NodeJS.Timeout | null = null;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (connectTimer !== null) clearTimeout(connectTimer);
      callback();
    };
    const request: ClientRequest = transport(
      url,
      { method: "GET", headers, signal },
      (response) => finish(() => resolve(response)),
    );
    request.once("socket", (socket) => {
      const clearConnectTimeout = (): void => {
        if (connectTimer !== null) clearTimeout(connectTimer);
        connectTimer = null;
      };
      connectTimer = setTimeout(() => {
        request.destroy(
          new RuntimeDownloadTimeoutError(
            "Runtime download connection timeout",
          ),
        );
      }, timeouts.connectMs);
      connectTimer.unref?.();
      if (!socket.connecting) {
        clearConnectTimeout();
      } else {
        socket.once(
          url.protocol === "https:" ? "secureConnect" : "connect",
          clearConnectTimeout,
        );
      }
    });
    request.setTimeout(timeouts.readMs, () => {
      request.destroy(
        new RuntimeDownloadTimeoutError("Runtime download read timeout"),
      );
    });
    request.once("error", (error) => finish(() => reject(error)));
    request.end();
  });
}

async function responseWithRedirects(
  initialUrl: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  timeouts: RuntimeDownloadTimeouts,
  maxRedirects: number,
): Promise<IncomingMessage> {
  let url = new URL(initialUrl);
  for (let redirects = 0; ; redirects += 1) {
    const response = await openRequest(url, headers, signal, timeouts);
    if (!REDIRECT_STATUSES.has(response.statusCode ?? 0)) return response;
    const location = headerValue(response.headers.location);
    response.resume();
    if (location === null) {
      throw new RuntimeDownloadError(
        "Runtime download redirect is missing Location",
      );
    }
    if (redirects >= maxRedirects) {
      throw new RuntimeDownloadError(
        "Runtime download exceeded the redirect limit",
      );
    }
    const next = new URL(location, url);
    if (
      (next.protocol !== "http:" && next.protocol !== "https:") ||
      next.username.length > 0 ||
      next.password.length > 0 ||
      next.hash.length > 0 ||
      (url.protocol === "https:" && next.protocol !== "https:")
    ) {
      throw new RuntimeDownloadError(
        "Runtime download redirect target is not allowed",
      );
    }
    url = next;
  }
}

function nodeDownloadResponse(
  response: IncomingMessage,
): RuntimeDownloadResponse {
  return {
    statusCode: response.statusCode ?? 0,
    getHeader: (name) => headerValue(response.headers[name.toLowerCase()]),
    body: response as unknown as AsyncIterable<Uint8Array>,
    discard: () => response.resume(),
    cancel: (error) => response.destroy(error),
  };
}

class NodeRuntimeDownloadTransport implements RuntimeDownloadTransport {
  async get(
    url: URL,
    headers: Record<string, string>,
    signal: AbortSignal,
    timeouts: RuntimeDownloadTimeouts,
    maxRedirects: number,
  ): Promise<RuntimeDownloadResponse> {
    return nodeDownloadResponse(
      await responseWithRedirects(url, headers, signal, timeouts, maxRedirects),
    );
  }
}

export function resolveRuntimeDownloadRedirect(
  current: URL,
  location: string | null,
  redirects: number,
  maxRedirects: number,
): URL {
  if (location === null) {
    throw new RuntimeDownloadError(
      "Runtime download redirect is missing Location",
    );
  }
  if (redirects >= maxRedirects) {
    throw new RuntimeDownloadError(
      "Runtime download exceeded the redirect limit",
    );
  }
  const next = new URL(location, current);
  if (
    (next.protocol !== "http:" && next.protocol !== "https:") ||
    next.username.length > 0 ||
    next.password.length > 0 ||
    next.hash.length > 0 ||
    (current.protocol === "https:" && next.protocol !== "https:")
  ) {
    throw new RuntimeDownloadError(
      "Runtime download redirect target is not allowed",
    );
  }
  return next;
}

function fetchResponseBody(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  readMs: number,
  dispose: () => void,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const iterator = (body as unknown as AsyncIterable<Uint8Array>)[
        Symbol.asyncIterator
      ]();
      let readTimer: NodeJS.Timeout | null = null;
      try {
        for (;;) {
          const next = await Promise.race([
            iterator.next(),
            new Promise<never>((_resolve, reject) => {
              readTimer = setTimeout(() => {
                const error = new RuntimeDownloadTimeoutError(
                  "Runtime download read timeout",
                );
                controller.abort(error);
                reject(error);
              }, readMs);
              readTimer.unref?.();
            }),
          ]);
          if (readTimer !== null) {
            clearTimeout(readTimer);
            readTimer = null;
          }
          if (next.done) return;
          yield next.value;
        }
      } finally {
        if (readTimer !== null) clearTimeout(readTimer);
        void iterator.return?.().catch(() => undefined);
        dispose();
      }
    },
  };
}

export class FetchRuntimeDownloadTransport implements RuntimeDownloadTransport {
  constructor(
    private readonly fetcher: RuntimeFetch = nodeRuntimeFetch,
    private readonly resolveUrl?: RuntimeDownloadUrlResolver,
  ) {}

  async get(
    url: URL,
    headers: Record<string, string>,
    signal: AbortSignal,
    timeouts: RuntimeDownloadTimeouts,
    maxRedirects: number,
  ): Promise<RuntimeDownloadResponse> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) controller.abort(signal.reason);
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", onAbort);
    };
    try {
      const resolvedUrl = this.resolveUrl
        ? await this.resolveUrl(
            url,
            headers,
            controller.signal,
            timeouts,
            maxRedirects,
          )
        : url;
      if (
        (resolvedUrl.protocol !== "http:" &&
          resolvedUrl.protocol !== "https:") ||
        resolvedUrl.username.length > 0 ||
        resolvedUrl.password.length > 0 ||
        resolvedUrl.hash.length > 0 ||
        (url.protocol === "https:" && resolvedUrl.protocol !== "https:")
      ) {
        throw new RuntimeDownloadError(
          "Runtime download resolved URL is not allowed",
        );
      }
      let connectionTimedOut = false;
      const connectTimer = setTimeout(() => {
        connectionTimedOut = true;
        controller.abort(
          new RuntimeDownloadTimeoutError(
            "Runtime download connection timeout",
          ),
        );
      }, timeouts.connectMs);
      connectTimer.unref?.();
      let response: Response;
      try {
        response = await this.fetcher(resolvedUrl.href, {
          method: "GET",
          redirect: this.resolveUrl ? "error" : "follow",
          signal: controller.signal,
          headers,
        });
      } catch (error) {
        if (connectionTimedOut) {
          throw new RuntimeDownloadTimeoutError(
            "Runtime download connection timeout",
          );
        }
        throw error;
      } finally {
        clearTimeout(connectTimer);
      }
      if (response.body === null) {
        throw new RuntimeDownloadError("Runtime download response has no body");
      }
      const body = response.body;
      const discard = (): void => {
        void body.cancel().catch(() => undefined);
        dispose();
      };
      return {
        statusCode: response.status,
        getHeader: (name) => response.headers.get(name),
        body: fetchResponseBody(body, controller, timeouts.readMs, dispose),
        discard,
        cancel: (error) => {
          controller.abort(error);
          void body.cancel(error).catch(() => undefined);
          dispose();
        },
      };
    } catch (error) {
      dispose();
      throw error;
    }
  }
}

const NODE_RUNTIME_DOWNLOAD_TRANSPORT = new NodeRuntimeDownloadTransport();

async function persistPartialAfterFailure(
  paths: RuntimePartialPaths,
  metadata: RuntimePartialMetadata,
): Promise<void> {
  const partial = await inspectRegularFile(paths.data);
  if (!partial.exists) return;
  await writeMetadata(paths.metadata, {
    ...metadata,
    received: partial.size,
    updatedAt: new Date().toISOString(),
  });
}

async function consumeResponse(
  request: RuntimeDownloadRequest,
  paths: RuntimePartialPaths,
  response: RuntimeDownloadResponse,
  state: ResumeState | null,
  now: () => Date,
): Promise<void> {
  let start = state?.received ?? 0;
  if (start > 0 && response.statusCode === 206) {
    validateContentRange(response, start, request.expectedSize);
  } else if (response.statusCode === 200) {
    const length = contentLength(response);
    if (length !== null && length !== request.expectedSize) {
      response.discard();
      await clearPartial(paths);
      throw new RuntimeDownloadIntegrityError(
        "Runtime download Content-Length differs from the expected size",
      );
    }
    start = 0;
    state = null;
  } else {
    response.discard();
    throw new RuntimeDownloadError(
      `Runtime download returned HTTP ${response.statusCode ?? 0}`,
    );
  }

  const timestamp = now().toISOString();
  const metadata: RuntimePartialMetadata = {
    schemaVersion: 1,
    url: request.url.href,
    expectedSize: request.expectedSize,
    expectedSha256: request.expectedSha256,
    received: start,
    etag: response.getHeader("etag"),
    lastModified: response.getHeader("last-modified"),
    createdAt: state?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  const handle = await open(paths.data, start === 0 ? "w" : "r+", 0o600);
  let received = start;
  await writeMetadata(paths.metadata, metadata);
  request.onProgress(received, request.expectedSize);
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (received + bytes.length > request.expectedSize) {
        response.cancel();
        throw new RuntimeDownloadIntegrityError(
          "Runtime download exceeded the expected size",
        );
      }
      await handle.write(bytes, 0, bytes.length, received);
      received += bytes.length;
      request.onProgress(received, request.expectedSize);
    }
    await handle.sync();
  } catch (error) {
    await handle.sync().catch(() => undefined);
    await handle.close().catch(() => undefined);
    metadata.received = received;
    metadata.updatedAt = now().toISOString();
    await writeMetadata(paths.metadata, metadata).catch(() => undefined);
    throw error;
  }
  await handle.close();

  if (received !== request.expectedSize) {
    await clearPartial(paths);
    throw new RuntimeDownloadIntegrityError(
      "Runtime download size differs from the expected size",
    );
  }
  const actual = await hashFile(paths.data);
  if (actual.sha256 !== request.expectedSha256) {
    await clearPartial(paths);
    throw new RuntimeDownloadIntegrityError(
      "Runtime download hash differs from the expected SHA-256",
    );
  }
  await rm(request.destination, { force: true });
  await rename(paths.data, request.destination);
  await rm(paths.metadata, { force: true });
}

function normalizeDownloadError(
  error: unknown,
  request: RuntimeDownloadRequest,
  overallTimedOut: boolean,
): Error {
  if (request.signal.aborted) return new RuntimeDownloadCancelledError();
  if (overallTimedOut) {
    return new RuntimeDownloadTimeoutError("Runtime download overall timeout");
  }
  if (error instanceof RuntimeDownloadError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RuntimeDownloadError(
    `Runtime download transport failed: ${message}`,
    error instanceof Error ? { cause: error } : undefined,
  );
}

export async function downloadWithResume(
  request: RuntimeDownloadRequest,
): Promise<void> {
  validateRequest(request);
  if (request.signal.aborted) throw new RuntimeDownloadCancelledError();
  const timeouts = resolveTimeouts(request.timeouts);
  const maxRedirects = request.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const partialMaxAgeMs = request.partialMaxAgeMs ?? DEFAULT_PARTIAL_MAX_AGE_MS;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new RuntimeDownloadError(
      "Runtime download maxRedirects must be a non-negative integer",
    );
  }
  if (!Number.isSafeInteger(partialMaxAgeMs) || partialMaxAgeMs < 0) {
    throw new RuntimeDownloadError(
      "Runtime partial max age must be a non-negative integer",
    );
  }
  const now = request.now ?? (() => new Date());
  const paths = runtimePartialPaths(request.destination);
  await mkdir(dirname(request.destination), { recursive: true, mode: 0o700 });
  let state = await loadResumeState(request, paths, now(), partialMaxAgeMs);
  if (state?.received === request.expectedSize) {
    if (await finalizeVerifiedPartial(request, paths)) return;
    state = null;
  }

  const operation = createOperationSignal(request.signal, timeouts.overallMs);
  const transport = request.transport ?? NODE_RUNTIME_DOWNLOAD_TRANSPORT;
  try {
    for (let restart = 0; restart < 2; restart += 1) {
      const headers: Record<string, string> = {
        Accept: "application/octet-stream",
        "User-Agent": "Aera-Studio-Runtime-Updater",
      };
      if (state && state.received > 0) {
        headers.Range = `bytes=${state.received}-`;
        const validator = state.etag ?? state.lastModified;
        if (validator) headers["If-Range"] = validator;
      }
      const response = await transport.get(
        request.url,
        headers,
        operation.signal,
        timeouts,
        maxRedirects,
      );
      if (
        state &&
        state.received > 0 &&
        response.statusCode === 206 &&
        !validatorsMatch(state, response)
      ) {
        response.discard();
        await clearPartial(paths);
        state = null;
        continue;
      }
      await consumeResponse(request, paths, response, state, now);
      return;
    }
    throw new RuntimeDownloadError(
      "Runtime download resume validators changed repeatedly",
    );
  } catch (error) {
    const partial = await inspectRegularFile(paths.data).catch(() => null);
    if (partial?.exists) {
      const existing = await readFile(paths.metadata, "utf8")
        .then(parseMetadata)
        .catch(() => null);
      if (existing) await persistPartialAfterFailure(paths, existing);
    }
    throw normalizeDownloadError(error, request, operation.didOverallTimeout());
  } finally {
    operation.dispose();
  }
}
