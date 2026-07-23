import {
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID as nodeRandomUUID,
} from "node:crypto";
import {
  chmodSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { constants as zlibConstants, createBrotliCompress } from "node:zlib";
import type { EncryptedBackupSnapshotProvenance } from "./manifest";
import type { EncryptedBackupSnapshot } from "./snapshot";
import {
  AGENTERA_BACKUP_CIPHER_SUITE,
  AGENTERA_BACKUP_FORMAT_VERSION,
  base64urlDecode,
  base64urlEncode,
  decryptBackupAesGcm,
  deriveBackupSubkey,
  encryptBackupAesGcm,
  type DeviceRootKeyEnvelopeV1,
  type RecoveryRootKeyEnvelopeV1,
  type WrappedBackupDataKeyEnvelopeV1,
} from "./crypto";

export const AGENTERA_ENCRYPTED_BACKUP_CHUNK_BYTES = 8 * 1024 * 1024;

const AES_NONCE_BYTES = 12;
const AES_TAG_BYTES = 16;
const OBJECT_OVERHEAD_BYTES = AES_NONCE_BYTES + AES_TAG_BYTES;
const MAXIMUM_MANIFEST_CIPHERTEXT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_BACKUP_CIPHERTEXT_BYTES = 1024 * 1024 * 1024;
const MAXIMUM_CHUNKS = 131_072;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;
const PUBLIC_ENVELOPE_DOMAIN =
  "agentera-encrypted-profile-backup-public-envelope.v1\0";

export interface EncryptedBackupObjectSpec {
  object_id: string;
  ciphertext_digest: string;
  ciphertext_size: number;
}

export interface EncryptedBackupChunkSpec extends EncryptedBackupObjectSpec {
  index: number;
}

export interface EncryptedBackupPublicEnvelope {
  format_version: 1;
  cipher_suite: typeof AGENTERA_BACKUP_CIPHER_SUITE;
  backup_id: string;
  profile_lineage_id: string;
  parent_backup_id: string | null;
  source_device_id: string;
  source_installation_id: string;
  source_definition_id: string;
  source_version_id: string;
  base_owner_scope: "USER";
  key_epoch: number;
  created_at: string;
  manifest: EncryptedBackupObjectSpec;
  chunks: EncryptedBackupChunkSpec[];
  total_ciphertext_size: number;
  recovery_envelope_digest: string;
  wrapped_data_key_digest: string;
  source_device_envelope_digest: string;
}

export interface EncryptedBackupInitiateRequest {
  envelope: EncryptedBackupPublicEnvelope;
  signature: string;
  recovery: {
    salt: string;
    memory_kib: 65536;
    iterations: 3;
    parallelism: 1;
  };
  recovery_root_key_envelope: string;
  wrapped_data_key: string;
  source_device_root_key_envelope: string;
}

export interface EncryptedBackupArchiveObject {
  path: string;
  object: EncryptedBackupObjectSpec;
  plaintextSize: number;
}

export interface EncryptedBackupArchiveChunk {
  index: number;
  path: string;
  object: EncryptedBackupChunkSpec;
  plaintextSize: number;
}

export interface EncryptedBackupArchive {
  backupId: string;
  ciphertextPath: string;
  manifest: EncryptedBackupArchiveObject;
  chunks: EncryptedBackupArchiveChunk[];
  initiateRequest: EncryptedBackupInitiateRequest;
}

export interface CreateEncryptedBackupArchiveInput {
  snapshot: EncryptedBackupSnapshot;
  sourceDeviceId: string;
  keyEpoch: number;
  parentBackupId: string | null;
  recoveryRootKeyEnvelope: RecoveryRootKeyEnvelopeV1;
  sourceDeviceRootKeyEnvelope: DeviceRootKeyEnvelopeV1;
  wrapDataKey: (input: {
    backupId: string;
    dataKey: Uint8Array;
  }) =>
    | WrappedBackupDataKeyEnvelopeV1
    | Promise<WrappedBackupDataKeyEnvelopeV1>;
  signDigest: (digest: Uint8Array) => string;
  signal?: AbortSignal;
  randomUUID?: () => string;
  randomBytes?: (size: number) => Uint8Array;
  now?: () => Date;
}

function invalidArchive(): never {
  throw new Error("Invalid AgentEra encrypted backup archive.");
}

function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    invalidArchive();
  }
  return value;
}

function uuidBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(uuid(value).replaceAll("-", ""), "hex"));
}

function randomExact(
  generator: (size: number) => Uint8Array,
  size: number,
): Uint8Array {
  const value = generator(size);
  if (!(value instanceof Uint8Array) || value.byteLength !== size) {
    invalidArchive();
  }
  return new Uint8Array(value);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("AgentEra encrypted backup archive was cancelled.");
  }
}

function sha256(value: Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function canonicalOpaqueEnvelope(value: object): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function envelopeDigest(value: Buffer): string {
  if (value.byteLength < 1) invalidArchive();
  return sha256(value).toString("base64url");
}

function manifestAad(backupId: string, ciphertextSize: number): Uint8Array {
  return new TextEncoder().encode(
    `agentera-backup-v1/manifest\0format=${AGENTERA_BACKUP_FORMAT_VERSION}\0backup=${uuid(backupId)}\0ciphertext-size=${ciphertextSize}`,
  );
}

function chunkAad(input: {
  backupId: string;
  manifestCiphertextDigest: string;
  index: number;
  ciphertextSize: number;
}): Uint8Array {
  if (
    !DIGEST_PATTERN.test(input.manifestCiphertextDigest) ||
    !Number.isSafeInteger(input.index) ||
    input.index < 0 ||
    !Number.isSafeInteger(input.ciphertextSize) ||
    input.ciphertextSize < OBJECT_OVERHEAD_BYTES
  ) {
    invalidArchive();
  }
  return new TextEncoder().encode(
    `agentera-backup-v1/chunk\0format=${AGENTERA_BACKUP_FORMAT_VERSION}\0backup=${uuid(input.backupId)}\0manifest=${input.manifestCiphertextDigest}\0index=${input.index}\0ciphertext-size=${input.ciphertextSize}`,
  );
}

function persistCiphertextObject(input: {
  ciphertextPath: string;
  plaintext: Uint8Array;
  dataKey: Uint8Array;
  backupSalt: Uint8Array;
  scope: "manifest" | `chunk/${number}`;
  aad: Uint8Array;
  nonce: Uint8Array;
  index?: number;
}): EncryptedBackupArchiveObject | EncryptedBackupArchiveChunk {
  const key = deriveBackupSubkey(input.dataKey, input.backupSalt, input.scope);
  const nonce = new Uint8Array(input.nonce);
  const plaintext = new Uint8Array(input.plaintext);
  const aad = new Uint8Array(input.aad);
  try {
    const body = encryptBackupAesGcm(key, nonce, plaintext, aad);
    const ciphertext = Buffer.concat([Buffer.from(nonce), Buffer.from(body)]);
    body.fill(0);
    const digest = sha256(ciphertext);
    const object: EncryptedBackupObjectSpec = {
      object_id: digest.toString("hex"),
      ciphertext_digest: digest.toString("base64url"),
      ciphertext_size: ciphertext.byteLength,
    };
    const suffix =
      input.index === undefined
        ? "manifest"
        : `chunk-${input.index.toString().padStart(6, "0")}`;
    const path = join(
      input.ciphertextPath,
      `${suffix}-${object.object_id}.bin`,
    );
    writeFileSync(path, ciphertext, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
    ciphertext.fill(0);
    digest.fill(0);
    if (input.index === undefined) {
      return { path, object, plaintextSize: input.plaintext.byteLength };
    }
    return {
      index: input.index,
      path,
      object: { index: input.index, ...object },
      plaintextSize: input.plaintext.byteLength,
    };
  } finally {
    key.fill(0);
    nonce.fill(0);
    plaintext.fill(0);
    aad.fill(0);
  }
}

async function* canonicalFileBytes(
  snapshot: EncryptedBackupSnapshot,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  for (const file of snapshot.manifest.files) {
    throwIfCancelled(signal);
    const path = join(snapshot.filesPath, ...file.path.split("/"));
    const digest = createHash("sha256");
    let size = 0;
    const stream = createReadStream(path, {
      flags: "r",
      highWaterMark: 1024 * 1024,
    });
    try {
      for await (const value of stream) {
        throwIfCancelled(signal);
        const chunk = Buffer.from(value as Buffer);
        size += chunk.byteLength;
        digest.update(chunk);
        yield chunk;
      }
    } finally {
      stream.destroy();
    }
    if (size !== file.size || digest.digest("hex") !== file.sha256) {
      throw new Error("Encrypted backup snapshot changed before encryption.");
    }
  }
}

function goCanonicalTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    invalidArchive();
  }
  return value.replace(/\.(\d{3})Z$/, ".$1000000Z");
}

export function encryptedBackupPublicEnvelopeSigningDigest(
  envelope: EncryptedBackupPublicEnvelope,
): Uint8Array {
  const canonical = {
    format_version: envelope.format_version,
    cipher_suite: envelope.cipher_suite,
    backup_id: envelope.backup_id,
    profile_lineage_id: envelope.profile_lineage_id,
    parent_backup_id: envelope.parent_backup_id,
    source_device_id: envelope.source_device_id,
    source_installation_id: envelope.source_installation_id,
    source_definition_id: envelope.source_definition_id,
    source_version_id: envelope.source_version_id,
    base_owner_scope: envelope.base_owner_scope,
    key_epoch: envelope.key_epoch,
    created_at: goCanonicalTimestamp(envelope.created_at),
    manifest: {
      object_id: envelope.manifest.object_id,
      ciphertext_digest: envelope.manifest.ciphertext_digest,
      ciphertext_size: envelope.manifest.ciphertext_size,
    },
    chunks: envelope.chunks.map((chunk) => ({
      index: chunk.index,
      object_id: chunk.object_id,
      ciphertext_digest: chunk.ciphertext_digest,
      ciphertext_size: chunk.ciphertext_size,
    })),
    total_ciphertext_size: envelope.total_ciphertext_size,
    recovery_envelope_digest: envelope.recovery_envelope_digest,
    wrapped_data_key_digest: envelope.wrapped_data_key_digest,
    source_device_envelope_digest: envelope.source_device_envelope_digest,
  };
  return new Uint8Array(
    createHash("sha256")
      .update(PUBLIC_ENVELOPE_DOMAIN)
      .update(JSON.stringify(canonical))
      .digest(),
  );
}

function validateProvenance(
  value: EncryptedBackupSnapshotProvenance,
): EncryptedBackupSnapshotProvenance {
  if (value.baseOwnerScope !== "USER") invalidArchive();
  return {
    sourceInstallationId: uuid(value.sourceInstallationId),
    sourceDefinitionId: uuid(value.sourceDefinitionId),
    sourceVersionId: uuid(value.sourceVersionId),
    baseOwnerScope: "USER",
  };
}

export async function createEncryptedBackupArchive(
  input: CreateEncryptedBackupArchiveInput,
): Promise<EncryptedBackupArchive> {
  const backupId = uuid((input.randomUUID ?? nodeRandomUUID)());
  const sourceDeviceId = uuid(input.sourceDeviceId);
  const profileLineageId = uuid(input.snapshot.manifest.profileLineageId);
  const parentBackupId =
    input.parentBackupId === null ? null : uuid(input.parentBackupId);
  const provenance = validateProvenance(input.snapshot.manifest.provenance);
  if (
    !Number.isSafeInteger(input.keyEpoch) ||
    input.keyEpoch < 1 ||
    parentBackupId === backupId
  ) {
    invalidArchive();
  }
  const createdAt = (
    input.now?.() ?? new Date(input.snapshot.manifest.createdAt)
  ).toISOString();
  const random = input.randomBytes ?? nodeRandomBytes;
  const dataKey = randomExact(random, 32);
  const backupSalt = uuidBytes(backupId);
  const ciphertextPath = join(input.snapshot.transactionPath, "ciphertext");
  mkdirSync(ciphertextPath, { mode: 0o700 });
  chmodSync(ciphertextPath, 0o700);
  try {
    throwIfCancelled(input.signal);
    const manifestNonce = randomExact(random, AES_NONCE_BYTES);
    const manifestCiphertextSize =
      input.snapshot.manifestBytes.byteLength + OBJECT_OVERHEAD_BYTES;
    if (manifestCiphertextSize > MAXIMUM_MANIFEST_CIPHERTEXT_BYTES) {
      invalidArchive();
    }
    const manifest = persistCiphertextObject({
      ciphertextPath,
      plaintext: input.snapshot.manifestBytes,
      dataKey,
      backupSalt,
      scope: "manifest",
      aad: manifestAad(backupId, manifestCiphertextSize),
      nonce: manifestNonce,
    }) as EncryptedBackupArchiveObject;
    manifestNonce.fill(0);

    const chunks: EncryptedBackupArchiveChunk[] = [];
    const compressed = Readable.from(
      canonicalFileBytes(input.snapshot, input.signal),
    ).pipe(
      createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
          [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
        },
      }),
    );
    let pending = Buffer.alloc(AGENTERA_ENCRYPTED_BACKUP_CHUNK_BYTES);
    let pendingSize = 0;
    const flush = (): void => {
      if (pendingSize === 0) return;
      if (chunks.length >= MAXIMUM_CHUNKS) invalidArchive();
      const plaintext = Buffer.from(pending.subarray(0, pendingSize));
      pending.fill(0, 0, pendingSize);
      const index = chunks.length;
      const ciphertextSize = plaintext.byteLength + OBJECT_OVERHEAD_BYTES;
      const nonce = randomExact(random, AES_NONCE_BYTES);
      try {
        chunks.push(
          persistCiphertextObject({
            ciphertextPath,
            plaintext,
            dataKey,
            backupSalt,
            scope: `chunk/${index}`,
            aad: chunkAad({
              backupId,
              manifestCiphertextDigest: manifest.object.ciphertext_digest,
              index,
              ciphertextSize,
            }),
            nonce,
            index,
          }) as EncryptedBackupArchiveChunk,
        );
      } finally {
        plaintext.fill(0);
        nonce.fill(0);
      }
      pendingSize = 0;
    };
    try {
      for await (const value of compressed) {
        throwIfCancelled(input.signal);
        const output = Buffer.from(value as Buffer);
        let offset = 0;
        while (offset < output.byteLength) {
          const copied = Math.min(
            pending.byteLength - pendingSize,
            output.byteLength - offset,
          );
          output.copy(pending, pendingSize, offset, offset + copied);
          pendingSize += copied;
          offset += copied;
          if (pendingSize === pending.byteLength) flush();
        }
        output.fill(0);
      }
      flush();
    } finally {
      compressed.destroy();
      pending.fill(0);
      pending = Buffer.alloc(0);
    }
    if (chunks.length < 1) invalidArchive();
    const totalCiphertextSize = chunks.reduce(
      (sum, chunk) => sum + chunk.object.ciphertext_size,
      0,
    );
    if (
      !Number.isSafeInteger(totalCiphertextSize) ||
      totalCiphertextSize > MAXIMUM_BACKUP_CIPHERTEXT_BYTES
    ) {
      invalidArchive();
    }

    const wrappedDataKey = await input.wrapDataKey({
      backupId,
      dataKey,
    });
    const recoveryBytes = canonicalOpaqueEnvelope(
      input.recoveryRootKeyEnvelope,
    );
    const wrappedDataKeyBytes = canonicalOpaqueEnvelope(wrappedDataKey);
    const sourceDeviceBytes = canonicalOpaqueEnvelope(
      input.sourceDeviceRootKeyEnvelope,
    );
    const envelope: EncryptedBackupPublicEnvelope = {
      format_version: AGENTERA_BACKUP_FORMAT_VERSION,
      cipher_suite: AGENTERA_BACKUP_CIPHER_SUITE,
      backup_id: backupId,
      profile_lineage_id: profileLineageId,
      parent_backup_id: parentBackupId,
      source_device_id: sourceDeviceId,
      source_installation_id: provenance.sourceInstallationId,
      source_definition_id: provenance.sourceDefinitionId,
      source_version_id: provenance.sourceVersionId,
      base_owner_scope: "USER",
      key_epoch: input.keyEpoch,
      created_at: createdAt,
      manifest: manifest.object,
      chunks: chunks.map((chunk) => chunk.object),
      total_ciphertext_size: totalCiphertextSize,
      recovery_envelope_digest: envelopeDigest(recoveryBytes),
      wrapped_data_key_digest: envelopeDigest(wrappedDataKeyBytes),
      source_device_envelope_digest: envelopeDigest(sourceDeviceBytes),
    };
    const signingDigest = encryptedBackupPublicEnvelopeSigningDigest(envelope);
    let signature: string;
    try {
      signature = input.signDigest(signingDigest);
      base64urlDecode(signature, 64);
    } catch {
      invalidArchive();
    } finally {
      signingDigest.fill(0);
    }
    const initiateRequest: EncryptedBackupInitiateRequest = {
      envelope,
      signature,
      recovery: {
        salt: input.recoveryRootKeyEnvelope.salt,
        memory_kib: 65536,
        iterations: 3,
        parallelism: 1,
      },
      recovery_root_key_envelope: base64urlEncode(recoveryBytes),
      wrapped_data_key: base64urlEncode(wrappedDataKeyBytes),
      source_device_root_key_envelope: base64urlEncode(sourceDeviceBytes),
    };
    recoveryBytes.fill(0);
    wrappedDataKeyBytes.fill(0);
    sourceDeviceBytes.fill(0);

    rmSync(input.snapshot.filesPath, { recursive: true, force: true });
    rmSync(input.snapshot.manifestPath, { force: true });
    return {
      backupId,
      ciphertextPath,
      manifest,
      chunks,
      initiateRequest,
    };
  } catch (error) {
    rmSync(ciphertextPath, { recursive: true, force: true });
    throw error;
  } finally {
    dataKey.fill(0);
    backupSalt.fill(0);
  }
}

function readAndValidateCiphertext(
  path: string,
  object: EncryptedBackupObjectSpec,
): Buffer {
  if (
    !OBJECT_ID_PATTERN.test(object.object_id) ||
    !DIGEST_PATTERN.test(object.ciphertext_digest) ||
    !Number.isSafeInteger(object.ciphertext_size) ||
    object.ciphertext_size < OBJECT_OVERHEAD_BYTES
  ) {
    invalidArchive();
  }
  const ciphertext = readFileSync(path);
  const digest = sha256(ciphertext);
  if (
    ciphertext.byteLength !== object.ciphertext_size ||
    digest.toString("hex") !== object.object_id ||
    digest.toString("base64url") !== object.ciphertext_digest
  ) {
    ciphertext.fill(0);
    digest.fill(0);
    throw new Error("Encrypted backup ciphertext verification failed.");
  }
  digest.fill(0);
  return ciphertext;
}

export function decryptEncryptedBackupManifest(input: {
  dataKey: Uint8Array;
  backupId: string;
  object: EncryptedBackupArchiveObject;
}): Uint8Array {
  const ciphertext = readAndValidateCiphertext(
    input.object.path,
    input.object.object,
  );
  const nonce = new Uint8Array(ciphertext.subarray(0, AES_NONCE_BYTES));
  const body = new Uint8Array(ciphertext.subarray(AES_NONCE_BYTES));
  const salt = uuidBytes(input.backupId);
  const key = deriveBackupSubkey(input.dataKey, salt, "manifest");
  const aad = manifestAad(input.backupId, input.object.object.ciphertext_size);
  try {
    const plaintext = decryptBackupAesGcm(key, nonce, body, aad);
    if (plaintext.byteLength !== input.object.plaintextSize) {
      plaintext.fill(0);
      throw new Error("Encrypted backup plaintext size mismatch.");
    }
    return plaintext;
  } finally {
    ciphertext.fill(0);
    nonce.fill(0);
    body.fill(0);
    salt.fill(0);
    key.fill(0);
    aad.fill(0);
  }
}

export function decryptEncryptedBackupChunk(input: {
  dataKey: Uint8Array;
  backupId: string;
  manifestCiphertextDigest: string;
  chunk: EncryptedBackupArchiveChunk;
}): Uint8Array {
  if (
    input.chunk.index !== input.chunk.object.index ||
    input.chunk.index < 0 ||
    input.chunk.plaintextSize !==
      input.chunk.object.ciphertext_size - OBJECT_OVERHEAD_BYTES
  ) {
    invalidArchive();
  }
  const ciphertext = readAndValidateCiphertext(
    input.chunk.path,
    input.chunk.object,
  );
  const nonce = new Uint8Array(ciphertext.subarray(0, AES_NONCE_BYTES));
  const body = new Uint8Array(ciphertext.subarray(AES_NONCE_BYTES));
  const salt = uuidBytes(input.backupId);
  const key = deriveBackupSubkey(
    input.dataKey,
    salt,
    `chunk/${input.chunk.index}`,
  );
  const aad = chunkAad({
    backupId: input.backupId,
    manifestCiphertextDigest: input.manifestCiphertextDigest,
    index: input.chunk.index,
    ciphertextSize: input.chunk.object.ciphertext_size,
  });
  try {
    const plaintext = decryptBackupAesGcm(key, nonce, body, aad);
    if (plaintext.byteLength !== input.chunk.plaintextSize) {
      plaintext.fill(0);
      throw new Error("Encrypted backup plaintext size mismatch.");
    }
    return plaintext;
  } finally {
    ciphertext.fill(0);
    nonce.fill(0);
    body.fill(0);
    salt.fill(0);
    key.fill(0);
    aad.fill(0);
  }
}
