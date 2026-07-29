import {
  createHash,
  createPublicKey,
  randomUUID as nodeRandomUUID,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBrotliDecompress } from "node:zlib";
import {
  decryptEncryptedBackupChunk,
  decryptEncryptedBackupManifest,
  encryptedBackupPublicEnvelopeSigningDigest,
  type EncryptedBackupArchiveChunk,
  type EncryptedBackupArchiveObject,
  type EncryptedBackupObjectSpec,
} from "./archive";
import {
  AgenteraEncryptedBackupClientError,
  type EncryptedBackupDetail,
  type EncryptedBackupRestoreCloudClient,
} from "./client";
import {
  unwrapBackupDataKey,
  type DeviceRootKeyEnvelopeV1,
  type RecoveryRootKeyEnvelopeV1,
  type WrappedBackupDataKeyEnvelopeV1,
} from "./crypto";
import type {
  AdoptRestoredEncryptedBackupAccountInput,
  AgenteraEncryptedBackupKeyStore,
} from "./key-store";
import {
  parseEncryptedBackupSnapshotManifest,
  type EncryptedBackupSnapshotFile,
  type EncryptedBackupSnapshotManifest,
} from "./manifest";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;
const PROFILE_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PREPARATION_TTL_MILLISECONDS = 10 * 60 * 1000;
const MAXIMUM_OPAQUE_ENVELOPE_BYTES = 16 * 1024;

export type EncryptedBackupRestoreErrorCode =
  | "authentication_required"
  | "backup_unavailable"
  | "device_authorization_required"
  | "recovery_failed"
  | "metadata_invalid"
  | "ciphertext_invalid"
  | "base_unavailable"
  | "path_invalid"
  | "disk_full"
  | "destination_exists"
  | "cancelled"
  | "activation_failed";

export class EncryptedBackupRestoreError extends Error {
  readonly code: EncryptedBackupRestoreErrorCode;

  constructor(code: EncryptedBackupRestoreErrorCode) {
    super(`Aera encrypted backup restore failed: ${code}.`);
    this.name = "EncryptedBackupRestoreError";
    this.code = code;
  }
}

export interface EncryptedBackupRestorePrincipal {
  accountId: string;
  deviceId: string;
}

export interface EncryptedBackupRestoreAgentControl {
  verifyImmutableUserBase(input: {
    definitionId: string;
    versionId: string;
    ownerScope: "USER";
  }): Promise<void>;
  activateVerifiedRestore(input: {
    backupId: string;
    sourceInstallationId: string;
    definitionId: string;
    versionId: string;
    profileLineageId: string;
    name: string;
    stagedProfilePath: string;
    encryptedRuntimeBindingProvenancePath: string;
  }): Promise<{
    agentInstallationId: string;
    profileId: string;
    runtimeProfileId: string;
    sourceScope: "USER";
  }>;
}

export interface AgenteraEncryptedBackupRestoreServiceOptions {
  client: EncryptedBackupRestoreCloudClient;
  keyStore: Pick<
    AgenteraEncryptedBackupKeyStore,
    "unwrapRootKeyForCurrentDevice" | "recoverRestoreRootKeyFromPhrase"
  > & {
    adoptRestoredAccount?: (
      input: AdoptRestoredEncryptedBackupAccountInput,
    ) => Promise<unknown>;
  };
  getPrincipal: () => EncryptedBackupRestorePrincipal | null;
  agentControl: EncryptedBackupRestoreAgentControl;
  transactionsRoot: string;
  randomUUID?: () => string;
  now?: () => Date;
  fileHooks?: {
    beforeFileWrite?: (relativePath: string) => void;
  };
}

export interface PreparedEncryptedBackupRestore {
  preparationId: string;
  backupId: string;
  sourceInstallationId: string;
  sourceDefinitionId: string;
  sourceVersionId: string;
  createdAt: string;
  fileCount: number;
  totalPlaintextSize: number;
}

export interface ConfirmedEncryptedBackupRestore {
  backupId: string;
  agentInstallationId: string;
  profileId: string;
  runtimeProfileId: string;
}

interface PreparedRestoreState {
  public: PreparedEncryptedBackupRestore;
  transactionPath: string;
  stagedProfilePath: string;
  provenancePath: string;
  profileLineageId: string;
  expiresAt: number;
}

interface MaterializationResult {
  provenancePath: string;
}

interface OpenedEncryptedBackupRootKey {
  rootKey: Uint8Array;
  recoveryEnvelope: RecoveryRootKeyEnvelopeV1;
}

function fail(code: EncryptedBackupRestoreErrorCode): never {
  throw new EncryptedBackupRestoreError(code);
}

function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    fail("metadata_invalid");
  }
  return value;
}

function profileIdentifier(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    fail("activation_failed");
  }
  return value;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail("cancelled");
}

function isInside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) fail("path_invalid");
  chmodSync(path, 0o700);
}

function decodeBase64url(
  value: unknown,
  minimum: number,
  maximum: number,
): Buffer {
  if (
    typeof value !== "string" ||
    !BASE64URL_PATTERN.test(value) ||
    minimum < 1 ||
    maximum < minimum
  ) {
    fail("metadata_invalid");
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.byteLength < minimum ||
    bytes.byteLength > maximum ||
    bytes.toString("base64url") !== value
  ) {
    bytes.fill(0);
    fail("metadata_invalid");
  }
  return bytes;
}

function parseOpaqueEnvelope<T>(value: string): T {
  const bytes = decodeBase64url(value, 17, MAXIMUM_OPAQUE_ENVELOPE_BYTES);
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
      fail("metadata_invalid");
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof EncryptedBackupRestoreError) throw error;
    fail("metadata_invalid");
  } finally {
    bytes.fill(0);
  }
}

function digestOpaqueEnvelope(value: string): Buffer {
  const bytes = decodeBase64url(value, 17, MAXIMUM_OPAQUE_ENVELOPE_BYTES);
  try {
    return createHash("sha256").update(bytes).digest();
  } finally {
    bytes.fill(0);
  }
}

function verifyDetail(detail: EncryptedBackupDetail, backupId: string): void {
  if (
    detail.envelope.backup_id !== backupId ||
    detail.envelope.base_owner_scope !== "USER" ||
    !DIGEST_PATTERN.test(detail.publicEnvelopeDigest) ||
    typeof detail.publicSignature !== "string" ||
    typeof detail.sourceDevicePublicKey !== "string"
  ) {
    fail("metadata_invalid");
  }
  const recoveryDigest = digestOpaqueEnvelope(detail.recoveryRootKeyEnvelope);
  const wrappedDigest = digestOpaqueEnvelope(detail.wrappedDataKey);
  const expectedRecoveryDigest = decodeBase64url(
    detail.envelope.recovery_envelope_digest,
    32,
    32,
  );
  const expectedWrappedDigest = decodeBase64url(
    detail.envelope.wrapped_data_key_digest,
    32,
    32,
  );
  const expectedDigest = encryptedBackupPublicEnvelopeSigningDigest(
    detail.envelope,
  );
  const publicEnvelopeDigest = decodeBase64url(
    detail.publicEnvelopeDigest,
    32,
    32,
  );
  const signature = decodeBase64url(detail.publicSignature, 64, 64);
  const publicKey = decodeBase64url(detail.sourceDevicePublicKey, 32, 32);
  try {
    if (
      !timingSafeEqual(recoveryDigest, expectedRecoveryDigest) ||
      !timingSafeEqual(wrappedDigest, expectedWrappedDigest) ||
      !timingSafeEqual(expectedDigest, publicEnvelopeDigest)
    ) {
      fail("metadata_invalid");
    }
    const verificationKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
      format: "der",
      type: "spki",
    });
    if (
      !verifySignature(
        null,
        Buffer.from(expectedDigest),
        verificationKey,
        signature,
      )
    ) {
      fail("metadata_invalid");
    }
  } catch (error) {
    if (error instanceof EncryptedBackupRestoreError) throw error;
    fail("metadata_invalid");
  } finally {
    recoveryDigest.fill(0);
    wrappedDigest.fill(0);
    expectedRecoveryDigest.fill(0);
    expectedWrappedDigest.fill(0);
    expectedDigest.fill(0);
    publicEnvelopeDigest.fill(0);
    signature.fill(0);
    publicKey.fill(0);
  }
}

function verifyObjectSpec(object: EncryptedBackupObjectSpec): void {
  if (
    !OBJECT_ID_PATTERN.test(object.object_id) ||
    !DIGEST_PATTERN.test(object.ciphertext_digest) ||
    !Number.isSafeInteger(object.ciphertext_size) ||
    object.ciphertext_size < 28 ||
    object.ciphertext_size > 16 * 1024 * 1024
  ) {
    fail("metadata_invalid");
  }
}

function writeDownloadedObject(
  path: string,
  bytes: Uint8Array,
  object: EncryptedBackupObjectSpec,
): void {
  verifyObjectSpec(object);
  const content = Buffer.from(bytes);
  const digest = createHash("sha256").update(content).digest();
  try {
    if (
      content.byteLength !== object.ciphertext_size ||
      digest.toString("hex") !== object.object_id ||
      digest.toString("base64url") !== object.ciphertext_digest
    ) {
      fail("ciphertext_invalid");
    }
    writeFileSync(path, content, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    if (
      error instanceof EncryptedBackupRestoreError ||
      (error as { code?: unknown })?.code !== "ENOSPC"
    ) {
      throw error;
    }
    fail("disk_full");
  } finally {
    content.fill(0);
    digest.fill(0);
  }
}

function validateManifestBinding(
  manifest: EncryptedBackupSnapshotManifest,
  detail: EncryptedBackupDetail,
): void {
  if (
    manifest.profileLineageId !== detail.envelope.profile_lineage_id ||
    manifest.provenance.sourceInstallationId !==
      detail.envelope.source_installation_id ||
    manifest.provenance.sourceDefinitionId !==
      detail.envelope.source_definition_id ||
    manifest.provenance.sourceVersionId !== detail.envelope.source_version_id ||
    manifest.provenance.baseOwnerScope !== "USER"
  ) {
    fail("metadata_invalid");
  }
}

function safeMaterializedPath(root: string, relativePath: string): string {
  const path = join(root, ...relativePath.split("/"));
  if (!isInside(root, path)) fail("path_invalid");
  return path;
}

function verifyRestoredSqlite(
  profilePath: string,
  files: readonly EncryptedBackupSnapshotFile[],
): void {
  const state = files.find((file) => file.kind === "session_database");
  if (!state) return;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(safeMaterializedPath(profilePath, state.path), {
      readOnly: true,
    });
    const integrity = database.prepare("PRAGMA quick_check").get() as
      | { quick_check?: unknown }
      | undefined;
    if (integrity?.quick_check !== "ok") {
      fail("metadata_invalid");
    }
  } catch (error) {
    if (error instanceof EncryptedBackupRestoreError) throw error;
    fail("metadata_invalid");
  } finally {
    database?.close();
  }
}

function finalizeFile(input: {
  descriptor: number;
  digest: ReturnType<typeof createHash>;
  file: EncryptedBackupSnapshotFile;
  size: number;
}): void {
  let closed = false;
  try {
    fsyncSync(input.descriptor);
    closeSync(input.descriptor);
    closed = true;
  } finally {
    if (!closed) {
      try {
        closeSync(input.descriptor);
      } catch {
        // Preserve the original fsync/close failure.
      }
    }
  }
  const digest = input.digest.digest("hex");
  if (input.size !== input.file.size || digest !== input.file.sha256) {
    fail("ciphertext_invalid");
  }
}

async function materializeDecompressed(input: {
  stream: ReturnType<typeof createBrotliDecompress>;
  manifest: EncryptedBackupSnapshotManifest;
  profilePath: string;
  provenanceRoot: string;
  signal?: AbortSignal;
  beforeFileWrite?: (relativePath: string) => void;
}): Promise<MaterializationResult> {
  let fileIndex = 0;
  let descriptor: number | null = null;
  let digest: ReturnType<typeof createHash> | null = null;
  let fileSize = 0;
  let provenancePath: string | null = null;
  const openCurrent = (): void => {
    while (descriptor === null && fileIndex < input.manifest.files.length) {
      const file = input.manifest.files[fileIndex];
      input.beforeFileWrite?.(file.path);
      const destinationRoot =
        file.kind === "runtime_binding_provenance"
          ? input.provenanceRoot
          : input.profilePath;
      const destination = safeMaterializedPath(destinationRoot, file.path);
      privateDirectory(resolve(destination, ".."));
      try {
        descriptor = openSync(destination, "wx", 0o600);
      } catch (error) {
        if ((error as { code?: unknown })?.code === "ENOSPC") {
          fail("disk_full");
        }
        throw error;
      }
      chmodSync(destination, 0o600);
      if (file.kind === "runtime_binding_provenance") {
        if (provenancePath !== null) fail("metadata_invalid");
        provenancePath = destination;
      }
      digest = createHash("sha256");
      fileSize = 0;
      if (file.size === 0) {
        const completedDescriptor = descriptor;
        const completedDigest = digest;
        descriptor = null;
        digest = null;
        fileIndex += 1;
        finalizeFile({
          descriptor: completedDescriptor,
          digest: completedDigest,
          file,
          size: fileSize,
        });
      }
    }
  };
  try {
    openCurrent();
    for await (const value of input.stream) {
      throwIfCancelled(input.signal);
      const output = Buffer.from(value as Buffer);
      let offset = 0;
      try {
        while (offset < output.byteLength) {
          openCurrent();
          if (fileIndex >= input.manifest.files.length) {
            fail("ciphertext_invalid");
          }
          const file = input.manifest.files[fileIndex];
          const remaining = file.size - fileSize;
          const length = Math.min(remaining, output.byteLength - offset);
          const activeDescriptor = descriptor as number | null;
          const activeDigest = digest as ReturnType<typeof createHash> | null;
          if (
            activeDescriptor === null ||
            activeDigest === null ||
            length < 1
          ) {
            fail("ciphertext_invalid");
          }
          const part = output.subarray(offset, offset + length);
          try {
            writeSync(activeDescriptor, part);
          } catch (error) {
            if ((error as { code?: unknown })?.code === "ENOSPC") {
              fail("disk_full");
            }
            throw error;
          }
          activeDigest.update(part);
          fileSize += length;
          offset += length;
          if (fileSize === file.size) {
            descriptor = null;
            digest = null;
            fileIndex += 1;
            finalizeFile({
              descriptor: activeDescriptor,
              digest: activeDigest,
              file,
              size: fileSize,
            });
          }
        }
      } finally {
        output.fill(0);
      }
    }
    openCurrent();
    if (
      descriptor !== null ||
      fileIndex !== input.manifest.files.length ||
      provenancePath === null
    ) {
      fail("ciphertext_invalid");
    }
    verifyRestoredSqlite(input.profilePath, input.manifest.files);
    return { provenancePath };
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    throw error;
  }
}

function mapClientError(error: unknown): never {
  if (error instanceof EncryptedBackupRestoreError) throw error;
  if (error instanceof AgenteraEncryptedBackupClientError) {
    if (
      error.code === "authentication_required" ||
      error.code === "session_revoked"
    ) {
      fail("authentication_required");
    }
    if (error.code === "cancelled") fail("cancelled");
    fail("backup_unavailable");
  }
  if ((error as { code?: unknown })?.code === "ENOSPC") fail("disk_full");
  throw error;
}

export class AgenteraEncryptedBackupRestoreService {
  private readonly client: EncryptedBackupRestoreCloudClient;
  private readonly keyStore: AgenteraEncryptedBackupRestoreServiceOptions["keyStore"];
  private readonly getPrincipal: AgenteraEncryptedBackupRestoreServiceOptions["getPrincipal"];
  private readonly agentControl: EncryptedBackupRestoreAgentControl;
  private readonly transactionsRoot: string;
  private readonly randomUUID: () => string;
  private readonly now: () => Date;
  private readonly beforeFileWrite:
    | ((relativePath: string) => void)
    | undefined;
  private readonly prepared = new Map<string, PreparedRestoreState>();
  private closed = false;

  constructor(options: AgenteraEncryptedBackupRestoreServiceOptions) {
    if (
      typeof options.transactionsRoot !== "string" ||
      !isAbsolute(options.transactionsRoot)
    ) {
      throw new Error(
        "Encrypted backup restore transactions root must be absolute.",
      );
    }
    this.client = options.client;
    this.keyStore = options.keyStore;
    this.getPrincipal = options.getPrincipal;
    this.agentControl = options.agentControl;
    this.transactionsRoot = resolve(options.transactionsRoot);
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.now = options.now ?? (() => new Date());
    this.beforeFileWrite = options.fileHooks?.beforeFileWrite;
    privateDirectory(this.transactionsRoot);
  }

  async prepareRestore(input: {
    backupId: string;
    recoveryPhrase?: string;
    signal?: AbortSignal;
  }): Promise<PreparedEncryptedBackupRestore> {
    if (this.closed) throw new Error("Encrypted backup restore is closed.");
    this.cleanupExpired();
    const backupId = identifier(input.backupId);
    const principal = this.getPrincipal();
    if (!principal) fail("authentication_required");
    const accountId = identifier(principal.accountId);
    const deviceId = identifier(principal.deviceId);
    throwIfCancelled(input.signal);
    const preparationId = identifier(this.randomUUID());
    if (this.prepared.has(preparationId)) fail("metadata_invalid");
    const transactionPath = join(this.transactionsRoot, preparationId);
    const ciphertextPath = join(transactionPath, "ciphertext");
    const stagedProfilePath = join(transactionPath, "profile");
    const provenanceRoot = join(transactionPath, "restore-metadata");
    try {
      mkdirSync(transactionPath, { mode: 0o700 });
      privateDirectory(ciphertextPath);
      privateDirectory(stagedProfilePath);
      privateDirectory(provenanceRoot);
      const detail = await this.client.getBackup(backupId, input.signal);
      verifyDetail(detail, backupId);
      const openedRoot = await this.openRootKey({
        detail,
        accountId,
        deviceId,
        recoveryPhrase: input.recoveryPhrase,
      });
      const rootKey = openedRoot.rootKey;
      let dataKey: Uint8Array | null = null;
      try {
        const wrappedDataKey =
          parseOpaqueEnvelope<WrappedBackupDataKeyEnvelopeV1>(
            detail.wrappedDataKey,
          );
        try {
          dataKey = unwrapBackupDataKey(rootKey, wrappedDataKey, backupId);
        } catch {
          fail("metadata_invalid");
        }
        throwIfCancelled(input.signal);
        const manifestPath = join(
          ciphertextPath,
          `${detail.envelope.manifest.object_id}.bin`,
        );
        const manifestDownload = await this.client.downloadObject(
          backupId,
          detail.envelope.manifest,
          input.signal,
        );
        writeDownloadedObject(
          manifestPath,
          manifestDownload,
          detail.envelope.manifest,
        );
        manifestDownload.fill(0);
        const manifestObject: EncryptedBackupArchiveObject = {
          path: manifestPath,
          object: detail.envelope.manifest,
          plaintextSize: detail.envelope.manifest.ciphertext_size - 28,
        };
        let manifestPlaintext: Uint8Array;
        try {
          manifestPlaintext = decryptEncryptedBackupManifest({
            dataKey,
            backupId,
            object: manifestObject,
          });
        } catch {
          fail("ciphertext_invalid");
        }
        unlinkSync(manifestPath);
        let manifest: EncryptedBackupSnapshotManifest;
        try {
          manifest = parseEncryptedBackupSnapshotManifest(manifestPlaintext);
          validateManifestBinding(manifest, detail);
        } catch (error) {
          if (error instanceof EncryptedBackupRestoreError) throw error;
          fail("metadata_invalid");
        } finally {
          manifestPlaintext.fill(0);
        }
        try {
          await this.agentControl.verifyImmutableUserBase({
            definitionId: manifest.provenance.sourceDefinitionId,
            versionId: manifest.provenance.sourceVersionId,
            ownerScope: "USER",
          });
        } catch {
          fail("base_unavailable");
        }
        const decompressor = createBrotliDecompress();
        const materialization = materializeDecompressed({
          stream: decompressor,
          manifest,
          profilePath: stagedProfilePath,
          provenanceRoot,
          signal: input.signal,
          beforeFileWrite: this.beforeFileWrite,
        });
        const producer = (async (): Promise<void> => {
          for (const chunkSpec of detail.envelope.chunks) {
            throwIfCancelled(input.signal);
            const chunkPath = join(
              ciphertextPath,
              `${chunkSpec.object_id}.bin`,
            );
            const downloaded = await this.client.downloadObject(
              backupId,
              chunkSpec,
              input.signal,
            );
            writeDownloadedObject(chunkPath, downloaded, chunkSpec);
            downloaded.fill(0);
            const chunk: EncryptedBackupArchiveChunk = {
              index: chunkSpec.index,
              path: chunkPath,
              object: chunkSpec,
              plaintextSize: chunkSpec.ciphertext_size - 28,
            };
            let compressed: Uint8Array;
            try {
              compressed = decryptEncryptedBackupChunk({
                dataKey,
                backupId,
                manifestCiphertextDigest:
                  detail.envelope.manifest.ciphertext_digest,
                chunk,
              });
            } catch {
              fail("ciphertext_invalid");
            }
            unlinkSync(chunkPath);
            try {
              const compressedBuffer = Buffer.from(compressed);
              try {
                await new Promise<void>((resolveWrite, rejectWrite) => {
                  decompressor.write(compressedBuffer, (error) => {
                    if (error) rejectWrite(error);
                    else resolveWrite();
                  });
                });
              } finally {
                compressedBuffer.fill(0);
              }
            } finally {
              compressed.fill(0);
            }
          }
          decompressor.end();
        })();
        let materialized: MaterializationResult;
        try {
          [, materialized] = await Promise.all([producer, materialization]);
        } catch (error) {
          decompressor.destroy();
          await Promise.allSettled([producer, materialization]);
          if (error instanceof EncryptedBackupRestoreError) throw error;
          if (error instanceof AgenteraEncryptedBackupClientError) {
            throw error;
          }
          if ((error as { code?: unknown })?.code === "ENOSPC") {
            fail("disk_full");
          }
          fail("ciphertext_invalid");
        }
        rmSync(ciphertextPath, { recursive: true, force: true });
        await this.keyStore.adoptRestoredAccount?.({
          accountId,
          deviceId,
          keyEpoch: detail.envelope.key_epoch,
          profileLineageId: manifest.profileLineageId,
          rootKey,
          recoveryEnvelope: openedRoot.recoveryEnvelope,
          now: this.now(),
        });
        const prepared: PreparedEncryptedBackupRestore = {
          preparationId,
          backupId,
          sourceInstallationId: manifest.provenance.sourceInstallationId,
          sourceDefinitionId: manifest.provenance.sourceDefinitionId,
          sourceVersionId: manifest.provenance.sourceVersionId,
          createdAt: manifest.createdAt,
          fileCount: manifest.files.length,
          totalPlaintextSize: manifest.totalPlaintextSize,
        };
        this.prepared.set(preparationId, {
          public: prepared,
          transactionPath,
          stagedProfilePath,
          provenancePath: materialized.provenancePath,
          profileLineageId: manifest.profileLineageId,
          expiresAt: this.now().getTime() + PREPARATION_TTL_MILLISECONDS,
        });
        return { ...prepared };
      } finally {
        rootKey.fill(0);
        dataKey?.fill(0);
      }
    } catch (error) {
      rmSync(transactionPath, { recursive: true, force: true });
      return mapClientError(error);
    }
  }

  async confirmRestore(input: {
    preparationId: string;
    name: string;
  }): Promise<ConfirmedEncryptedBackupRestore> {
    if (this.closed) throw new Error("Encrypted backup restore is closed.");
    this.cleanupExpired();
    const preparationId = identifier(input.preparationId);
    const prepared = this.prepared.get(preparationId);
    if (!prepared) fail("backup_unavailable");
    if (
      typeof input.name !== "string" ||
      input.name.trim() !== input.name ||
      input.name.length < 1 ||
      input.name.length > 80 ||
      /[\0\r\n]/.test(input.name)
    ) {
      fail("metadata_invalid");
    }
    this.prepared.delete(preparationId);
    try {
      await this.agentControl.verifyImmutableUserBase({
        definitionId: prepared.public.sourceDefinitionId,
        versionId: prepared.public.sourceVersionId,
        ownerScope: "USER",
      });
      const activated = await this.agentControl.activateVerifiedRestore({
        backupId: prepared.public.backupId,
        sourceInstallationId: prepared.public.sourceInstallationId,
        definitionId: prepared.public.sourceDefinitionId,
        versionId: prepared.public.sourceVersionId,
        profileLineageId: prepared.profileLineageId,
        name: input.name,
        stagedProfilePath: prepared.stagedProfilePath,
        encryptedRuntimeBindingProvenancePath: prepared.provenancePath,
      });
      const agentInstallationId = identifier(activated.agentInstallationId);
      const profileId = profileIdentifier(activated.profileId);
      const runtimeProfileId = identifier(activated.runtimeProfileId);
      if (
        activated.sourceScope !== "USER" ||
        agentInstallationId === prepared.public.sourceInstallationId
      ) {
        fail("activation_failed");
      }
      return {
        backupId: prepared.public.backupId,
        agentInstallationId,
        profileId,
        runtimeProfileId,
      };
    } catch (error) {
      if (
        error instanceof EncryptedBackupRestoreError ||
        (error as { code?: unknown })?.code === "destination_exists"
      ) {
        if ((error as { code?: unknown })?.code === "destination_exists") {
          fail("destination_exists");
        }
        throw error;
      }
      if ((error as { code?: unknown })?.code === "ENOSPC") {
        fail("disk_full");
      }
      fail("activation_failed");
    } finally {
      rmSync(prepared.transactionPath, {
        recursive: true,
        force: true,
      });
    }
  }

  cancelPreparedRestore(preparationIdValue: string): boolean {
    const preparationId = identifier(preparationIdValue);
    const prepared = this.prepared.get(preparationId);
    if (!prepared) return false;
    this.prepared.delete(preparationId);
    rmSync(prepared.transactionPath, { recursive: true, force: true });
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const prepared of this.prepared.values()) {
      rmSync(prepared.transactionPath, { recursive: true, force: true });
    }
    this.prepared.clear();
  }

  private async openRootKey(input: {
    detail: EncryptedBackupDetail;
    accountId: string;
    deviceId: string;
    recoveryPhrase?: string;
  }): Promise<OpenedEncryptedBackupRootKey> {
    const recoveryEnvelope = parseOpaqueEnvelope<RecoveryRootKeyEnvelopeV1>(
      input.detail.recoveryRootKeyEnvelope,
    );
    if (
      recoveryEnvelope.salt !== input.detail.recovery.salt ||
      recoveryEnvelope.memoryKiB !== 65536 ||
      recoveryEnvelope.iterations !== 3 ||
      recoveryEnvelope.parallelism !== 1
    ) {
      fail("metadata_invalid");
    }
    const current = input.detail.currentDeviceEnvelope;
    if (
      current &&
      current.deviceId === input.deviceId &&
      current.keyEpoch === input.detail.envelope.key_epoch
    ) {
      try {
        return {
          rootKey: await this.keyStore.unwrapRootKeyForCurrentDevice({
            accountId: input.accountId,
            deviceId: input.deviceId,
            keyEpoch: current.keyEpoch,
            envelope: parseOpaqueEnvelope<DeviceRootKeyEnvelopeV1>(
              current.rootKeyEnvelope,
            ),
          }),
          recoveryEnvelope,
        };
      } catch {
        // A valid phrase may recover after a lost or stale local device key.
      }
    }
    if (input.recoveryPhrase === undefined) {
      fail("device_authorization_required");
    }
    try {
      return {
        rootKey: await this.keyStore.recoverRestoreRootKeyFromPhrase({
          accountId: input.accountId,
          phrase: input.recoveryPhrase,
          envelope: recoveryEnvelope,
          profileLineageId: input.detail.envelope.profile_lineage_id,
        }),
        recoveryEnvelope,
      };
    } catch {
      fail("recovery_failed");
    }
  }

  private cleanupExpired(): void {
    const now = this.now().getTime();
    for (const [id, prepared] of this.prepared) {
      if (prepared.expiresAt > now) continue;
      this.prepared.delete(id);
      rmSync(prepared.transactionPath, {
        recursive: true,
        force: true,
      });
    }
  }
}
