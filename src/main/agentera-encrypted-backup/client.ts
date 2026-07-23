import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseAgenteraCloudOrigin } from "../agentera-auth/origin";
import type { AgenteraEncryptedBackupDeviceRegistration } from "../../shared/agentera-encrypted-backup";
import type {
  EncryptedBackupArchive,
  EncryptedBackupArchiveObject,
  EncryptedBackupInitiateRequest,
} from "./archive";

const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const MAXIMUM_JSON_RESPONSE_BYTES = 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALLOWED_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_signature",
  "session_revoked",
  "not_authorized",
  "backup_not_found",
  "backup_conflict",
  "upload_expired",
  "quota_exceeded",
  "feature_unavailable",
  "service_unavailable",
]);

export interface EncryptedBackupInitiateReceipt {
  backupId: string;
  state: "initiated" | "uploading";
  uploadExpiresAt: string;
  replayed: boolean;
}

export interface EncryptedBackupSealReceipt {
  backupId: string;
  state: "sealed";
  sealedAt: string;
  replayed: boolean;
}

export interface EncryptedBackupDeviceRegistrationReceipt {
  deviceId: string;
  keyEpoch: number;
  revision: number;
  status: "active" | "revoked";
  replayed: boolean;
}

export interface EncryptedBackupUploadResume {
  uploadedChunkIndexes?: readonly number[];
  manifestUploaded?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: {
    uploadedObjects: number;
    totalObjects: number;
  }) => void;
}

export interface EncryptedBackupCloudClient {
  registerCurrentDevice(
    registration: AgenteraEncryptedBackupDeviceRegistration,
    signal?: AbortSignal,
  ): Promise<EncryptedBackupDeviceRegistrationReceipt>;
  initiate(
    request: EncryptedBackupInitiateRequest,
    signal?: AbortSignal,
  ): Promise<EncryptedBackupInitiateReceipt>;
  uploadArchive(
    archive: EncryptedBackupArchive,
    resume?: EncryptedBackupUploadResume,
  ): Promise<void>;
  seal(
    backupId: string,
    signal?: AbortSignal,
  ): Promise<EncryptedBackupSealReceipt>;
}

export interface AgenteraEncryptedBackupClientOptions {
  origin: string;
  getAccessToken: () => string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class AgenteraEncryptedBackupClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly restartRequired: boolean;

  constructor(
    status: number,
    code: string,
    retryable: boolean,
    restartRequired = false,
  ) {
    super(`AgentEra encrypted backup request failed: ${code}.`);
    this.name = "AgenteraEncryptedBackupClientError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.restartRequired = restartRequired;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) ||
      Number(declared) > MAXIMUM_JSON_RESPONSE_BYTES)
  ) {
    throw new AgenteraEncryptedBackupClientError(
      response.status,
      "invalid_response",
      false,
    );
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAXIMUM_JSON_RESPONSE_BYTES) {
    throw new AgenteraEncryptedBackupClientError(
      response.status,
      "invalid_response",
      false,
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new AgenteraEncryptedBackupClientError(
      response.status,
      "invalid_response",
      false,
    );
  }
}

function mappedServerError(status: number, payload: unknown): never {
  const code =
    isObject(payload) &&
    typeof payload.error === "string" &&
    ALLOWED_ERROR_CODES.has(payload.error)
      ? payload.error
      : status === 401
        ? "session_revoked"
        : status >= 500
          ? "service_unavailable"
          : "request_rejected";
  throw new AgenteraEncryptedBackupClientError(
    status,
    code,
    status === 408 || status === 429 || status >= 500,
    code === "upload_expired",
  );
}

function exactKeys(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    keys.length === expected.length &&
    keys.every((field, index) => field === expected[index])
  );
}

function verifiedCiphertext(object: EncryptedBackupArchiveObject): Uint8Array {
  const bytes = readFileSync(object.path);
  const digest = createHash("sha256").update(bytes).digest();
  if (
    bytes.byteLength !== object.object.ciphertext_size ||
    digest.toString("hex") !== object.object.object_id ||
    digest.toString("base64url") !== object.object.ciphertext_digest
  ) {
    bytes.fill(0);
    digest.fill(0);
    throw new AgenteraEncryptedBackupClientError(
      0,
      "ciphertext_changed",
      false,
    );
  }
  digest.fill(0);
  return Uint8Array.from(bytes);
}

export class AgenteraEncryptedBackupClient implements EncryptedBackupCloudClient {
  readonly origin: string;
  private readonly getAccessToken: () => string | null;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AgenteraEncryptedBackupClientOptions) {
    this.origin = parseAgenteraCloudOrigin(options.origin);
    this.getAccessToken = options.getAccessToken;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MILLISECONDS;
    if (
      typeof this.getAccessToken !== "function" ||
      typeof this.fetcher !== "function" ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000
    ) {
      throw new Error(
        "Invalid AgentEra encrypted backup client configuration.",
      );
    }
  }

  async registerCurrentDevice(
    registration: AgenteraEncryptedBackupDeviceRegistration,
    signal?: AbortSignal,
  ): Promise<EncryptedBackupDeviceRegistrationReceipt> {
    const token = this.requireToken();
    const response = await this.requestJson(
      "/api/v1/encrypted-profile-backups/devices/current",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registration),
      },
      [200],
      token,
      signal,
    );
    if (
      !isObject(response) ||
      !exactKeys(response, [
        "device_id",
        "key_epoch",
        "revision",
        "status",
        "replayed",
      ]) ||
      typeof response.device_id !== "string" ||
      !UUID_PATTERN.test(response.device_id) ||
      !Number.isSafeInteger(response.key_epoch) ||
      Number(response.key_epoch) < 1 ||
      !Number.isSafeInteger(response.revision) ||
      Number(response.revision) < 1 ||
      (response.status !== "active" && response.status !== "revoked") ||
      typeof response.replayed !== "boolean"
    ) {
      throw new AgenteraEncryptedBackupClientError(
        200,
        "invalid_response",
        false,
      );
    }
    return {
      deviceId: response.device_id,
      keyEpoch: Number(response.key_epoch),
      revision: Number(response.revision),
      status: response.status,
      replayed: response.replayed,
    };
  }

  async initiate(
    request: EncryptedBackupInitiateRequest,
    signal?: AbortSignal,
  ): Promise<EncryptedBackupInitiateReceipt> {
    const token = this.requireToken();
    const response = await this.requestJson(
      "/api/v1/encrypted-profile-backups",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
      [200, 201],
      token,
      signal,
    );
    if (
      !isObject(response) ||
      !exactKeys(response, [
        "backup_id",
        "state",
        "upload_expires_at",
        "replayed",
      ]) ||
      response.backup_id !== request.envelope.backup_id ||
      !UUID_PATTERN.test(String(response.backup_id)) ||
      (response.state !== "initiated" && response.state !== "uploading") ||
      canonicalTimestamp(response.upload_expires_at) === null ||
      typeof response.replayed !== "boolean"
    ) {
      throw new AgenteraEncryptedBackupClientError(
        0,
        "invalid_response",
        false,
      );
    }
    return {
      backupId: response.backup_id as string,
      state: response.state,
      uploadExpiresAt: canonicalTimestamp(response.upload_expires_at)!,
      replayed: response.replayed,
    };
  }

  async uploadArchive(
    archive: EncryptedBackupArchive,
    resume: EncryptedBackupUploadResume = {},
  ): Promise<void> {
    const token = this.requireToken();
    if (
      !UUID_PATTERN.test(archive.backupId) ||
      archive.initiateRequest.envelope.backup_id !== archive.backupId
    ) {
      throw new AgenteraEncryptedBackupClientError(0, "invalid_request", false);
    }
    const uploaded = new Set(resume.uploadedChunkIndexes ?? []);
    if (
      uploaded.size !== (resume.uploadedChunkIndexes?.length ?? 0) ||
      [...uploaded].some(
        (index) =>
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= archive.chunks.length,
      )
    ) {
      throw new AgenteraEncryptedBackupClientError(0, "invalid_request", false);
    }
    const totalObjects = archive.chunks.length + 1;
    let uploadedObjects =
      uploaded.size + (resume.manifestUploaded === true ? 1 : 0);
    if (!resume.manifestUploaded) {
      await this.uploadObject(
        archive.backupId,
        "manifest",
        archive.manifest,
        token,
        resume.signal,
      );
      uploadedObjects += 1;
      resume.onProgress?.({ uploadedObjects, totalObjects });
    }
    for (const chunk of archive.chunks) {
      if (uploaded.has(chunk.index)) continue;
      await this.uploadObject(
        archive.backupId,
        `chunks/${chunk.index}`,
        chunk,
        token,
        resume.signal,
      );
      uploadedObjects += 1;
      resume.onProgress?.({ uploadedObjects, totalObjects });
    }
  }

  async seal(
    backupId: string,
    signal?: AbortSignal,
  ): Promise<EncryptedBackupSealReceipt> {
    if (!UUID_PATTERN.test(backupId)) {
      throw new AgenteraEncryptedBackupClientError(0, "invalid_request", false);
    }
    const token = this.requireToken();
    const response = await this.requestJson(
      `/api/v1/encrypted-profile-backups/${backupId}/seal`,
      { method: "POST" },
      [200],
      token,
      signal,
    );
    if (
      !isObject(response) ||
      !exactKeys(response, ["backup_id", "state", "sealed_at", "replayed"]) ||
      response.backup_id !== backupId ||
      response.state !== "sealed" ||
      canonicalTimestamp(response.sealed_at) === null ||
      typeof response.replayed !== "boolean"
    ) {
      throw new AgenteraEncryptedBackupClientError(
        200,
        "invalid_response",
        false,
      );
    }
    return {
      backupId,
      state: "sealed",
      sealedAt: canonicalTimestamp(response.sealed_at)!,
      replayed: response.replayed,
    };
  }

  private async uploadObject(
    backupId: string,
    suffix: string,
    object: EncryptedBackupArchiveObject,
    token: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = verifiedCiphertext(object);
    const requestBody = new ArrayBuffer(body.byteLength);
    new Uint8Array(requestBody).set(body);
    try {
      await this.request(
        `/api/v1/encrypted-profile-backups/${backupId}/${suffix}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "x-agentera-ciphertext-size":
              object.object.ciphertext_size.toString(),
            "x-agentera-ciphertext-sha256": object.object.ciphertext_digest,
          },
          body: requestBody,
        },
        [204],
        token,
        signal,
      );
    } finally {
      body.fill(0);
      new Uint8Array(requestBody).fill(0);
    }
  }

  private requireToken(expected?: string): string {
    const token = this.getAccessToken();
    if (
      typeof token !== "string" ||
      token.length < 1 ||
      token.trim() !== token ||
      /[\s\0]/.test(token) ||
      (expected !== undefined && token !== expected)
    ) {
      throw new AgenteraEncryptedBackupClientError(
        0,
        "authentication_required",
        false,
      );
    }
    return token;
  }

  private async requestJson(
    path: string,
    init: RequestInit,
    expectedStatuses: readonly number[],
    token: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.request(
      path,
      init,
      expectedStatuses,
      token,
      signal,
    );
    return boundedJson(response);
  }

  private async request(
    path: string,
    init: RequestInit,
    expectedStatuses: readonly number[],
    token: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    this.requireToken(token);
    if (signal?.aborted) {
      throw new AgenteraEncryptedBackupClientError(0, "cancelled", false);
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, this.timeoutMs);
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      response = await this.fetcher(new URL(path, `${this.origin}/`), {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch {
      throw new AgenteraEncryptedBackupClientError(
        0,
        signal?.aborted ? "cancelled" : "service_unavailable",
        !signal?.aborted,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
    if (!expectedStatuses.includes(response.status)) {
      let payload: unknown = null;
      try {
        payload = await boundedJson(response);
      } catch {
        // Preserve status-based mapping for malformed error responses.
      }
      return mappedServerError(response.status, payload);
    }
    return response;
  }
}
