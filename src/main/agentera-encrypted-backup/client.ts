import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { parseAgenteraCloudOrigin } from "../agentera-auth/origin";
import type { AgenteraEncryptedBackupDeviceRegistration } from "../../shared/agentera-encrypted-backup";
import type { DeviceRootKeyEnvelopeV1 } from "./crypto";
import type {
  EncryptedBackupArchive,
  EncryptedBackupArchiveObject,
  EncryptedBackupInitiateRequest,
  EncryptedBackupObjectSpec,
  EncryptedBackupPublicEnvelope,
} from "./archive";
import { encryptedBackupPublicEnvelopeSigningDigest } from "./archive";

const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const MAXIMUM_JSON_RESPONSE_BYTES = 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAXIMUM_OPAQUE_ENVELOPE_BYTES = 16 * 1024;
const MAXIMUM_BACKUP_COUNT = 10_000;
const MAXIMUM_DEVICE_COUNT = 1_000;
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

export interface EncryptedBackupCloudDevice {
  deviceId: string;
  keyEpoch: number;
  revision: number;
  status: "active" | "revoked";
  publicKey: string;
  registeredAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface EncryptedBackupDeviceEnvelopeReceipt {
  backupId: string;
  deviceId: string;
  keyEpoch: number;
  replayed: boolean;
}

export interface EncryptedBackupSummary {
  backupId: string;
  profileLineageId: string;
  parentBackupId: string | null;
  sourceDeviceId: string;
  sourceInstallationId: string;
  sourceDefinitionId: string;
  sourceVersionId: string;
  state: "sealed";
  keyEpoch: number;
  chunkCount: number;
  totalCiphertextSize: number;
  createdAt: string;
  sealedAt: string;
}

export interface EncryptedBackupCurrentDeviceEnvelope {
  deviceId: string;
  keyEpoch: number;
  rootKeyEnvelope: string;
  rootKeyEnvelopeDigest: string;
}

export interface EncryptedBackupDetail {
  envelope: EncryptedBackupPublicEnvelope;
  publicEnvelopeDigest: string;
  publicSignature: string;
  sourceDevicePublicKey: string;
  recovery: EncryptedBackupInitiateRequest["recovery"];
  recoveryRootKeyEnvelope: string;
  wrappedDataKey: string;
  currentDeviceEnvelope: EncryptedBackupCurrentDeviceEnvelope | null;
  sealedAt: string;
}

export interface EncryptedBackupRestoreCloudClient {
  listBackups(signal?: AbortSignal): Promise<EncryptedBackupSummary[]>;
  getBackup(
    backupId: string,
    signal?: AbortSignal,
  ): Promise<EncryptedBackupDetail>;
  downloadObject(
    backupId: string,
    object: EncryptedBackupObjectSpec,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  deleteBackup(backupId: string, signal?: AbortSignal): Promise<void>;
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
    super(`Aera encrypted backup request failed: ${code}.`);
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
  const bytes = await boundedResponseBytes(
    response,
    MAXIMUM_JSON_RESPONSE_BYTES,
  );
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(body);
  } catch {
    throw new AgenteraEncryptedBackupClientError(
      response.status,
      "invalid_response",
      false,
    );
  } finally {
    bytes.fill(0);
  }
}

async function boundedResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    response.body === null
  ) {
    invalidResponse();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > maximumBytes) {
        await reader.cancel();
        invalidResponse();
      }
      chunks.push(chunk);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
      chunk.fill(0);
    }
    chunks.length = 0;
    return result;
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    if (error instanceof AgenteraEncryptedBackupClientError) throw error;
    invalidResponse();
  } finally {
    reader.releaseLock();
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

const SUMMARY_FIELDS = [
  "backup_id",
  "profile_lineage_id",
  "parent_backup_id",
  "source_device_id",
  "source_installation_id",
  "source_definition_id",
  "source_version_id",
  "format_version",
  "cipher_suite",
  "state",
  "key_epoch",
  "chunk_count",
  "total_ciphertext_size",
  "created_at",
  "sealed_at",
] as const;

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1
    ? Number(value)
    : null;
}

function invalidResponse(): never {
  throw new AgenteraEncryptedBackupClientError(200, "invalid_response", false);
}

function canonicalBase64url(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
): Buffer {
  if (
    typeof value !== "string" ||
    !BASE64URL_PATTERN.test(value) ||
    minimumBytes < 1 ||
    maximumBytes < minimumBytes
  ) {
    invalidResponse();
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.byteLength < minimumBytes ||
    bytes.byteLength > maximumBytes ||
    bytes.toString("base64url") !== value
  ) {
    bytes.fill(0);
    invalidResponse();
  }
  return bytes;
}

function fixedBase64url(value: unknown, length: number): string {
  const bytes = canonicalBase64url(value, length, length);
  try {
    return bytes.toString("base64url");
  } finally {
    bytes.fill(0);
  }
}

function parseObjectSpec(
  value: unknown,
  maximumSize: number,
): EncryptedBackupObjectSpec {
  if (
    !isObject(value) ||
    !exactKeys(value, ["object_id", "ciphertext_digest", "ciphertext_size"]) ||
    typeof value.object_id !== "string" ||
    !OBJECT_ID_PATTERN.test(value.object_id) ||
    typeof value.ciphertext_digest !== "string" ||
    !DIGEST_PATTERN.test(value.ciphertext_digest) ||
    !Number.isSafeInteger(value.ciphertext_size) ||
    Number(value.ciphertext_size) < 17 ||
    Number(value.ciphertext_size) > maximumSize
  ) {
    invalidResponse();
  }
  return {
    object_id: value.object_id,
    ciphertext_digest: value.ciphertext_digest,
    ciphertext_size: Number(value.ciphertext_size),
  };
}

function parseSummary(
  value: unknown,
  requireExact = true,
): EncryptedBackupSummary {
  if (
    !isObject(value) ||
    (requireExact && !exactKeys(value, SUMMARY_FIELDS)) ||
    value.format_version !== 1 ||
    value.cipher_suite !==
      "HPKE-X25519-HKDF-SHA256-AES256GCM+ARGON2ID+AES256GCM" ||
    value.state !== "sealed" ||
    typeof value.backup_id !== "string" ||
    !UUID_PATTERN.test(value.backup_id) ||
    typeof value.profile_lineage_id !== "string" ||
    !UUID_PATTERN.test(value.profile_lineage_id) ||
    (value.parent_backup_id !== null &&
      (typeof value.parent_backup_id !== "string" ||
        !UUID_PATTERN.test(value.parent_backup_id))) ||
    typeof value.source_device_id !== "string" ||
    !UUID_PATTERN.test(value.source_device_id) ||
    typeof value.source_installation_id !== "string" ||
    !UUID_PATTERN.test(value.source_installation_id) ||
    typeof value.source_definition_id !== "string" ||
    !UUID_PATTERN.test(value.source_definition_id) ||
    typeof value.source_version_id !== "string" ||
    !UUID_PATTERN.test(value.source_version_id) ||
    positiveInteger(value.key_epoch) === null ||
    positiveInteger(value.chunk_count) === null ||
    Number(value.chunk_count) > 131_072 ||
    positiveInteger(value.total_ciphertext_size) === null ||
    Number(value.total_ciphertext_size) > 1024 * 1024 * 1024 ||
    canonicalTimestamp(value.created_at) === null ||
    canonicalTimestamp(value.sealed_at) === null
  ) {
    invalidResponse();
  }
  return {
    backupId: value.backup_id,
    profileLineageId: value.profile_lineage_id,
    parentBackupId: value.parent_backup_id as string | null,
    sourceDeviceId: value.source_device_id,
    sourceInstallationId: value.source_installation_id,
    sourceDefinitionId: value.source_definition_id,
    sourceVersionId: value.source_version_id,
    state: "sealed",
    keyEpoch: Number(value.key_epoch),
    chunkCount: Number(value.chunk_count),
    totalCiphertextSize: Number(value.total_ciphertext_size),
    createdAt: canonicalTimestamp(value.created_at)!,
    sealedAt: canonicalTimestamp(value.sealed_at)!,
  };
}

function envelopeDigest(value: string): string {
  const bytes = canonicalBase64url(value, 17, MAXIMUM_OPAQUE_ENVELOPE_BYTES);
  try {
    return createHash("sha256").update(bytes).digest("base64url");
  } finally {
    bytes.fill(0);
  }
}

function serializedDeviceRootKeyEnvelope(
  value: DeviceRootKeyEnvelopeV1,
): string {
  if (
    !isObject(value) ||
    !exactKeys(value, ["formatVersion", "cipherSuite", "enc", "ciphertext"]) ||
    value.formatVersion !== 1 ||
    value.cipherSuite !== "HPKE-X25519-HKDF-SHA256-AES256GCM+ARGON2ID+AES256GCM"
  ) {
    throw new AgenteraEncryptedBackupClientError(0, "invalid_request", false);
  }
  const enc = fixedBase64url(value.enc, 32);
  const ciphertext = fixedBase64url(value.ciphertext, 48);
  const bytes = Buffer.from(
    JSON.stringify({
      formatVersion: 1,
      cipherSuite: "HPKE-X25519-HKDF-SHA256-AES256GCM+ARGON2ID+AES256GCM",
      enc,
      ciphertext,
    }),
    "utf8",
  );
  try {
    if (
      bytes.byteLength < 48 ||
      bytes.byteLength > MAXIMUM_OPAQUE_ENVELOPE_BYTES
    ) {
      throw new AgenteraEncryptedBackupClientError(0, "invalid_request", false);
    }
    return bytes.toString("base64url");
  } finally {
    bytes.fill(0);
  }
}

function parseBackupDetail(
  value: unknown,
  expectedBackupId: string,
): EncryptedBackupDetail {
  const detailFields = [
    ...SUMMARY_FIELDS,
    "manifest",
    "chunks",
    "public_envelope_digest",
    "public_signature",
    "source_device_public_key",
    "source_device_envelope_digest",
    "recovery",
    "recovery_root_key_envelope",
    "wrapped_data_key",
    "current_device_envelope",
  ] as const;
  if (!isObject(value) || !exactKeys(value, detailFields)) {
    invalidResponse();
  }
  const summary = parseSummary(value, false);
  if (
    summary.backupId !== expectedBackupId ||
    !Array.isArray(value.chunks) ||
    value.chunks.length !== summary.chunkCount
  ) {
    invalidResponse();
  }
  const manifest = parseObjectSpec(value.manifest, 16 * 1024 * 1024);
  const chunks = value.chunks.map((entry, index) => {
    if (
      !isObject(entry) ||
      !exactKeys(entry, [
        "index",
        "object_id",
        "ciphertext_digest",
        "ciphertext_size",
      ]) ||
      entry.index !== index
    ) {
      invalidResponse();
    }
    return {
      index,
      ...parseObjectSpec(
        {
          object_id: entry.object_id,
          ciphertext_digest: entry.ciphertext_digest,
          ciphertext_size: entry.ciphertext_size,
        },
        9_437_200,
      ),
    };
  });
  const total = chunks.reduce((sum, chunk) => sum + chunk.ciphertext_size, 0);
  if (total !== summary.totalCiphertextSize) invalidResponse();
  if (
    !isObject(value.recovery) ||
    !exactKeys(value.recovery, [
      "salt",
      "memory_kib",
      "iterations",
      "parallelism",
    ]) ||
    value.recovery.memory_kib !== 65536 ||
    value.recovery.iterations !== 3 ||
    value.recovery.parallelism !== 1
  ) {
    invalidResponse();
  }
  fixedBase64url(value.recovery.salt, 16);
  const recoveryRootKeyEnvelope =
    typeof value.recovery_root_key_envelope === "string"
      ? value.recovery_root_key_envelope
      : "";
  const wrappedDataKey =
    typeof value.wrapped_data_key === "string" ? value.wrapped_data_key : "";
  const sourceDeviceEnvelopeDigest = fixedBase64url(
    value.source_device_envelope_digest,
    32,
  );
  const envelope: EncryptedBackupPublicEnvelope = {
    format_version: 1,
    cipher_suite: "HPKE-X25519-HKDF-SHA256-AES256GCM+ARGON2ID+AES256GCM",
    backup_id: summary.backupId,
    profile_lineage_id: summary.profileLineageId,
    parent_backup_id: summary.parentBackupId,
    source_device_id: summary.sourceDeviceId,
    source_installation_id: summary.sourceInstallationId,
    source_definition_id: summary.sourceDefinitionId,
    source_version_id: summary.sourceVersionId,
    base_owner_scope: "USER",
    key_epoch: summary.keyEpoch,
    created_at: summary.createdAt,
    manifest,
    chunks,
    total_ciphertext_size: summary.totalCiphertextSize,
    recovery_envelope_digest: envelopeDigest(recoveryRootKeyEnvelope),
    wrapped_data_key_digest: envelopeDigest(wrappedDataKey),
    source_device_envelope_digest: sourceDeviceEnvelopeDigest,
  };
  const expectedDigest = encryptedBackupPublicEnvelopeSigningDigest(envelope);
  const receivedDigest = canonicalBase64url(
    value.public_envelope_digest,
    32,
    32,
  );
  const signature = canonicalBase64url(value.public_signature, 64, 64);
  const publicKey = canonicalBase64url(value.source_device_public_key, 32, 32);
  try {
    const verificationKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
      format: "der",
      type: "spki",
    });
    if (
      !timingSafeEqual(Buffer.from(expectedDigest), receivedDigest) ||
      !verifySignature(
        null,
        Buffer.from(expectedDigest),
        verificationKey,
        signature,
      )
    ) {
      invalidResponse();
    }
  } catch (error) {
    if (error instanceof AgenteraEncryptedBackupClientError) throw error;
    invalidResponse();
  } finally {
    expectedDigest.fill(0);
    receivedDigest.fill(0);
    signature.fill(0);
    publicKey.fill(0);
  }
  let currentDeviceEnvelope: EncryptedBackupCurrentDeviceEnvelope | null = null;
  if (value.current_device_envelope !== null) {
    if (
      !isObject(value.current_device_envelope) ||
      !exactKeys(value.current_device_envelope, [
        "device_id",
        "key_epoch",
        "root_key_envelope",
        "root_key_envelope_digest",
      ]) ||
      typeof value.current_device_envelope.device_id !== "string" ||
      !UUID_PATTERN.test(value.current_device_envelope.device_id) ||
      positiveInteger(value.current_device_envelope.key_epoch) === null ||
      typeof value.current_device_envelope.root_key_envelope !== "string"
    ) {
      invalidResponse();
    }
    const rootKeyEnvelope = value.current_device_envelope.root_key_envelope;
    const rootKeyEnvelopeDigest = fixedBase64url(
      value.current_device_envelope.root_key_envelope_digest,
      32,
    );
    if (envelopeDigest(rootKeyEnvelope) !== rootKeyEnvelopeDigest) {
      invalidResponse();
    }
    currentDeviceEnvelope = {
      deviceId: value.current_device_envelope.device_id,
      keyEpoch: Number(value.current_device_envelope.key_epoch),
      rootKeyEnvelope,
      rootKeyEnvelopeDigest,
    };
  }
  return {
    envelope,
    publicEnvelopeDigest: String(value.public_envelope_digest),
    publicSignature: String(value.public_signature),
    sourceDevicePublicKey: String(value.source_device_public_key),
    recovery: {
      salt: String(value.recovery.salt),
      memory_kib: 65536,
      iterations: 3,
      parallelism: 1,
    },
    recoveryRootKeyEnvelope,
    wrappedDataKey,
    currentDeviceEnvelope,
    sealedAt: summary.sealedAt,
  };
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
        "Invalid Aera encrypted backup client configuration.",
      );
    }
  }

  async listBackups(signal?: AbortSignal): Promise<EncryptedBackupSummary[]> {
    const token = this.requireToken();
    const response = await this.requestJson(
      "/api/v1/encrypted-profile-backups",
      { method: "GET" },
      [200],
      token,
      signal,
    );
    if (
      !isObject(response) ||
      !exactKeys(response, ["backups"]) ||
      !Array.isArray(response.backups) ||
      response.backups.length > MAXIMUM_BACKUP_COUNT
    ) {
      invalidResponse();
    }
    return response.backups.map((backup) => parseSummary(backup));
  }

  async listDevices(
    signal?: AbortSignal,
  ): Promise<EncryptedBackupCloudDevice[]> {
    const token = this.requireToken();
    const response = await this.requestJson(
      "/api/v1/encrypted-profile-backups/devices",
      { method: "GET" },
      [200],
      token,
      signal,
    );
    if (
      !isObject(response) ||
      !exactKeys(response, ["devices"]) ||
      !Array.isArray(response.devices) ||
      response.devices.length > MAXIMUM_DEVICE_COUNT
    ) {
      invalidResponse();
    }
    const identities = new Set<string>();
    return response.devices.map((value) => {
      if (
        !isObject(value) ||
        !exactKeys(value, [
          "device_id",
          "key_epoch",
          "revision",
          "status",
          "public_key",
          "registered_at",
          "updated_at",
          "revoked_at",
        ]) ||
        typeof value.device_id !== "string" ||
        !UUID_PATTERN.test(value.device_id) ||
        positiveInteger(value.key_epoch) === null ||
        positiveInteger(value.revision) === null ||
        (value.status !== "active" && value.status !== "revoked") ||
        canonicalTimestamp(value.registered_at) === null ||
        canonicalTimestamp(value.updated_at) === null ||
        (value.revoked_at !== null &&
          canonicalTimestamp(value.revoked_at) === null) ||
        (value.status === "active" && value.revoked_at !== null) ||
        (value.status === "revoked" && value.revoked_at === null)
      ) {
        invalidResponse();
      }
      const identity = `${value.device_id}\0${value.key_epoch}`;
      if (identities.has(identity)) invalidResponse();
      identities.add(identity);
      return {
        deviceId: value.device_id,
        keyEpoch: Number(value.key_epoch),
        revision: Number(value.revision),
        status: value.status,
        publicKey: fixedBase64url(value.public_key, 32),
        registeredAt: canonicalTimestamp(value.registered_at)!,
        updatedAt: canonicalTimestamp(value.updated_at)!,
        revokedAt:
          value.revoked_at === null
            ? null
            : canonicalTimestamp(value.revoked_at)!,
      };
    });
  }

  async revokeDevice(deviceId: string, signal?: AbortSignal): Promise<void> {
    if (!UUID_PATTERN.test(deviceId)) {
      throw new AgenteraEncryptedBackupClientError(0, "invalid_request", false);
    }
    const token = this.requireToken();
    await this.request(
      `/api/v1/encrypted-profile-backups/devices/${deviceId}`,
      { method: "DELETE" },
      [204],
      token,
      signal,
    );
  }

  async addDeviceEnvelope(
    backupId: string,
    input: {
      deviceId: string;
      keyEpoch: number;
      rootKeyEnvelope: DeviceRootKeyEnvelopeV1;
    },
    signal?: AbortSignal,
  ): Promise<EncryptedBackupDeviceEnvelopeReceipt> {
    if (
      !UUID_PATTERN.test(backupId) ||
      !UUID_PATTERN.test(input.deviceId) ||
      !Number.isSafeInteger(input.keyEpoch) ||
      input.keyEpoch < 1
    ) {
      throw new AgenteraEncryptedBackupClientError(0, "invalid_request", false);
    }
    const rootKeyEnvelope = serializedDeviceRootKeyEnvelope(
      input.rootKeyEnvelope,
    );
    const token = this.requireToken();
    const response = await this.requestJson(
      `/api/v1/encrypted-profile-backups/${backupId}/device-envelopes`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_id: input.deviceId,
          key_epoch: input.keyEpoch,
          root_key_envelope: rootKeyEnvelope,
          root_key_envelope_digest: envelopeDigest(rootKeyEnvelope),
        }),
      },
      [200],
      token,
      signal,
    );
    if (
      !isObject(response) ||
      !exactKeys(response, [
        "backup_id",
        "device_id",
        "key_epoch",
        "replayed",
      ]) ||
      response.backup_id !== backupId ||
      response.device_id !== input.deviceId ||
      response.key_epoch !== input.keyEpoch ||
      typeof response.replayed !== "boolean"
    ) {
      invalidResponse();
    }
    return {
      backupId,
      deviceId: input.deviceId,
      keyEpoch: input.keyEpoch,
      replayed: response.replayed,
    };
  }

  async getBackup(
    backupId: string,
    signal?: AbortSignal,
  ): Promise<EncryptedBackupDetail> {
    if (!UUID_PATTERN.test(backupId)) {
      throw new AgenteraEncryptedBackupClientError(0, "invalid_request", false);
    }
    const token = this.requireToken();
    const response = await this.requestJson(
      `/api/v1/encrypted-profile-backups/${backupId}`,
      { method: "GET" },
      [200],
      token,
      signal,
    );
    return parseBackupDetail(response, backupId);
  }

  async downloadObject(
    backupId: string,
    object: EncryptedBackupObjectSpec,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (
      !UUID_PATTERN.test(backupId) ||
      !OBJECT_ID_PATTERN.test(object.object_id) ||
      !DIGEST_PATTERN.test(object.ciphertext_digest) ||
      !Number.isSafeInteger(object.ciphertext_size) ||
      object.ciphertext_size < 17 ||
      object.ciphertext_size > 16 * 1024 * 1024
    ) {
      throw new AgenteraEncryptedBackupClientError(0, "invalid_request", false);
    }
    const token = this.requireToken();
    const response = await this.request(
      `/api/v1/encrypted-profile-backups/${backupId}/objects/${object.object_id}`,
      { method: "GET" },
      [200],
      token,
      signal,
    );
    if (
      response.headers.get("content-type") !== "application/octet-stream" ||
      response.headers.get("content-length") !==
        object.ciphertext_size.toString() ||
      response.headers.get("x-agentera-ciphertext-sha256") !==
        object.ciphertext_digest
    ) {
      invalidResponse();
    }
    const bytes = await boundedResponseBytes(response, object.ciphertext_size);
    const digest = createHash("sha256").update(bytes).digest();
    if (
      bytes.byteLength !== object.ciphertext_size ||
      digest.toString("hex") !== object.object_id ||
      digest.toString("base64url") !== object.ciphertext_digest
    ) {
      bytes.fill(0);
      digest.fill(0);
      invalidResponse();
    }
    digest.fill(0);
    return bytes;
  }

  async deleteBackup(backupId: string, signal?: AbortSignal): Promise<void> {
    if (!UUID_PATTERN.test(backupId)) {
      throw new AgenteraEncryptedBackupClientError(0, "invalid_request", false);
    }
    const token = this.requireToken();
    await this.request(
      `/api/v1/encrypted-profile-backups/${backupId}`,
      { method: "DELETE" },
      [204],
      token,
      signal,
    );
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
      this.requireToken(token);
    } catch (error) {
      if (error instanceof AgenteraEncryptedBackupClientError) throw error;
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
