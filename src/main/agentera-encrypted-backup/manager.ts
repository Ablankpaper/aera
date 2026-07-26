import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { RuntimeActivityCoordinator } from "../runtime-activity";
import {
  createEncryptedBackupArchive,
  type CreateEncryptedBackupArchiveInput,
  type EncryptedBackupArchive,
  type EncryptedBackupArchiveChunk,
  type EncryptedBackupArchiveObject,
  type EncryptedBackupInitiateRequest,
} from "./archive";
import {
  AgenteraEncryptedBackupClientError,
  type EncryptedBackupCloudClient,
} from "./client";
import type { AgenteraEncryptedBackupKeyStore } from "./key-store";
import type { EncryptedBackupSnapshotProvenance } from "./manifest";
import {
  withEncryptedBackupSnapshot,
  type EncryptedBackupSnapshot,
} from "./snapshot";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STATE_FILE = "upload-state.json";
const STATE_TEMPORARY_FILE = ".upload-state.tmp";
const MAXIMUM_STATE_BYTES = 8 * 1024 * 1024;

export interface EncryptedBackupPrincipal {
  accountId: string;
  deviceId: string;
  signDigest: (digest: Uint8Array) => string;
}

export interface EncryptedBackupSource {
  installationId: string;
  profilePath: string;
  parentBackupId: string | null;
  provenance: EncryptedBackupSnapshotProvenance;
  encryptedRuntimeBindingProvenance: Uint8Array;
}

export interface PersistedEncryptedBackupUpload {
  version: 1;
  accountId: string;
  deviceId: string;
  profileLineageId: string;
  archive: EncryptedBackupArchive;
  manifestUploaded: boolean;
  uploadedChunkIndexes: number[];
  uploadExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedBackupUploadStoreLike {
  persistArchive(input: {
    archive: EncryptedBackupArchive;
    accountId: string;
    deviceId: string;
    profileLineageId: string;
    createdAt: Date;
  }): PersistedEncryptedBackupUpload;
  load(
    accountId: string,
    profileLineageId: string,
  ): PersistedEncryptedBackupUpload | null;
  update(
    backupId: string,
    patch: {
      manifestUploaded?: boolean;
      uploadedChunkIndexes?: readonly number[];
      uploadExpiresAt?: string;
      updatedAt: Date;
    },
  ): PersistedEncryptedBackupUpload;
  remove(backupId: string): void;
}

interface SerializedArchiveObject {
  file: string;
  object: EncryptedBackupArchiveObject["object"];
  plaintextSize: number;
}

interface SerializedArchiveChunk extends SerializedArchiveObject {
  index: number;
  object: EncryptedBackupArchiveChunk["object"];
}

interface SerializedUploadState {
  version: 1;
  accountId: string;
  deviceId: string;
  profileLineageId: string;
  archive: {
    backupId: string;
    manifest: SerializedArchiveObject;
    chunks: SerializedArchiveChunk[];
    initiateRequest: EncryptedBackupInitiateRequest;
  };
  manifestUploaded: boolean;
  uploadedChunkIndexes: number[];
  uploadExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgenteraEncryptedBackupManagerOptions {
  transactionsRoot: string;
  activity: RuntimeActivityCoordinator;
  uploadStore: EncryptedBackupUploadStoreLike;
  client: EncryptedBackupCloudClient;
  keyStore: Pick<
    AgenteraEncryptedBackupKeyStore,
    | "getState"
    | "getDevicePublicRegistration"
    | "getArchivePublicMaterial"
    | "wrapRootKeyForDevice"
    | "wrapBackupDataKey"
  >;
  getPrincipal: () => EncryptedBackupPrincipal | null;
  resolveSource: (
    installationId: string,
  ) => Promise<EncryptedBackupSource | null>;
  snapshot?: typeof withEncryptedBackupSnapshot;
  archive?: typeof createEncryptedBackupArchive;
  now?: () => Date;
}

export interface CreateEncryptedBackupOptions {
  signal?: AbortSignal;
  onProgress?: (progress: {
    uploadedObjects: number;
    totalObjects: number;
  }) => void;
}

export interface CreateEncryptedBackupResult {
  backupId: string;
  sealedAt: string;
  resumed: boolean;
}

interface ActiveBackup {
  controller: AbortController;
  explicitlyCancelled: boolean;
  backupId: string | null;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    throw new Error(`Invalid encrypted backup ${label}.`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Encrypted backup ${label} is invalid.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`Encrypted backup ${label} is invalid.`);
  }
  return value;
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`Encrypted backup ${label} is invalid.`);
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  const expected = [...fields].sort();
  if (
    keys.length !== expected.length ||
    keys.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`Encrypted backup ${label} is invalid.`);
  }
  return object;
}

function inside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Encrypted backup upload directory is unsafe.");
  }
  chmodSync(path, 0o700);
}

function objectFile(directory: string, file: unknown, label: string): string {
  if (
    typeof file !== "string" ||
    file.length < 1 ||
    file !== basename(file) ||
    file.includes("\0")
  ) {
    throw new Error(`Encrypted backup ${label} path is invalid.`);
  }
  const path = join(directory, file);
  if (!inside(directory, path)) {
    throw new Error(`Encrypted backup ${label} path is invalid.`);
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error(`Encrypted backup ${label} file is unsafe.`);
  }
  return path;
}

function parseObject(
  value: unknown,
  label: string,
): EncryptedBackupArchiveObject["object"] {
  const object = exactObject(
    value,
    ["object_id", "ciphertext_digest", "ciphertext_size"],
    label,
  );
  if (
    typeof object.object_id !== "string" ||
    !OBJECT_ID_PATTERN.test(object.object_id) ||
    typeof object.ciphertext_digest !== "string" ||
    !DIGEST_PATTERN.test(object.ciphertext_digest) ||
    !Number.isSafeInteger(object.ciphertext_size) ||
    Number(object.ciphertext_size) < 17
  ) {
    throw new Error(`Encrypted backup ${label} is invalid.`);
  }
  return {
    object_id: object.object_id,
    ciphertext_digest: object.ciphertext_digest,
    ciphertext_size: Number(object.ciphertext_size),
  };
}

function parsePositiveSize(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Encrypted backup ${label} is invalid.`);
  }
  return Number(value);
}

function serializeUpload(
  state: PersistedEncryptedBackupUpload,
): SerializedUploadState {
  return {
    version: 1,
    accountId: state.accountId,
    deviceId: state.deviceId,
    profileLineageId: state.profileLineageId,
    archive: {
      backupId: state.archive.backupId,
      manifest: {
        file: basename(state.archive.manifest.path),
        object: state.archive.manifest.object,
        plaintextSize: state.archive.manifest.plaintextSize,
      },
      chunks: state.archive.chunks.map((chunk) => ({
        index: chunk.index,
        file: basename(chunk.path),
        object: chunk.object,
        plaintextSize: chunk.plaintextSize,
      })),
      initiateRequest: state.archive.initiateRequest,
    },
    manifestUploaded: state.manifestUploaded,
    uploadedChunkIndexes: [...state.uploadedChunkIndexes],
    uploadExpiresAt: state.uploadExpiresAt,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

function parseUpload(
  value: unknown,
  directory: string,
): PersistedEncryptedBackupUpload {
  const state = exactObject(
    value,
    [
      "version",
      "accountId",
      "deviceId",
      "profileLineageId",
      "archive",
      "manifestUploaded",
      "uploadedChunkIndexes",
      "uploadExpiresAt",
      "createdAt",
      "updatedAt",
    ],
    "upload state",
  );
  if (
    state.version !== 1 ||
    typeof state.manifestUploaded !== "boolean" ||
    !Array.isArray(state.uploadedChunkIndexes)
  ) {
    throw new Error("Encrypted backup upload state is invalid.");
  }
  const accountId = identifier(state.accountId, "account ID");
  const deviceId = identifier(state.deviceId, "device ID");
  const profileLineageId = identifier(
    state.profileLineageId,
    "Profile lineage ID",
  );
  const archiveValue = exactObject(
    state.archive,
    ["backupId", "manifest", "chunks", "initiateRequest"],
    "archive state",
  );
  const backupId = identifier(archiveValue.backupId, "backup ID");
  if (basename(directory) !== backupId || !Array.isArray(archiveValue.chunks)) {
    throw new Error("Encrypted backup archive state is invalid.");
  }
  const manifestValue = exactObject(
    archiveValue.manifest,
    ["file", "object", "plaintextSize"],
    "manifest state",
  );
  const manifestObject = parseObject(manifestValue.object, "manifest object");
  const manifest: EncryptedBackupArchiveObject = {
    path: objectFile(directory, manifestValue.file, "manifest"),
    object: manifestObject,
    plaintextSize: parsePositiveSize(
      manifestValue.plaintextSize,
      "manifest plaintext size",
    ),
  };
  const chunks = archiveValue.chunks.map((entry, expectedIndex) => {
    const chunk = exactObject(
      entry,
      ["index", "file", "object", "plaintextSize"],
      "chunk state",
    );
    if (chunk.index !== expectedIndex) {
      throw new Error("Encrypted backup chunk order is invalid.");
    }
    const parsedObject = exactObject(
      chunk.object,
      ["index", "object_id", "ciphertext_digest", "ciphertext_size"],
      "chunk object",
    );
    if (parsedObject.index !== expectedIndex) {
      throw new Error("Encrypted backup chunk index is invalid.");
    }
    const object = parseObject(
      {
        object_id: parsedObject.object_id,
        ciphertext_digest: parsedObject.ciphertext_digest,
        ciphertext_size: parsedObject.ciphertext_size,
      },
      "chunk object",
    );
    return {
      index: expectedIndex,
      path: objectFile(directory, chunk.file, "chunk"),
      object: { index: expectedIndex, ...object },
      plaintextSize: parsePositiveSize(
        chunk.plaintextSize,
        "chunk plaintext size",
      ),
    };
  });
  if (chunks.length < 1) {
    throw new Error("Encrypted backup archive has no chunks.");
  }
  const initiateRequest = archiveValue.initiateRequest as
    | EncryptedBackupInitiateRequest
    | undefined;
  if (
    initiateRequest?.envelope?.backup_id !== backupId ||
    initiateRequest.envelope.profile_lineage_id !== profileLineageId ||
    initiateRequest.envelope.source_device_id !== deviceId ||
    initiateRequest.envelope.manifest.object_id !== manifest.object.object_id ||
    initiateRequest.envelope.chunks.length !== chunks.length ||
    initiateRequest.envelope.chunks.some(
      (chunk, index) =>
        chunk.index !== index ||
        chunk.object_id !== chunks[index].object.object_id,
    )
  ) {
    throw new Error("Encrypted backup signed archive state is invalid.");
  }
  const uploadedChunkIndexes = state.uploadedChunkIndexes.map(
    (value, index, all) => {
      if (
        !Number.isSafeInteger(value) ||
        Number(value) < 0 ||
        Number(value) >= chunks.length ||
        all.indexOf(value) !== index
      ) {
        throw new Error("Encrypted backup upload progress is invalid.");
      }
      return Number(value);
    },
  );
  const uploadExpiresAt =
    state.uploadExpiresAt === null
      ? null
      : canonicalTimestamp(state.uploadExpiresAt, "upload expiry");
  return {
    version: 1,
    accountId,
    deviceId,
    profileLineageId,
    archive: {
      backupId,
      ciphertextPath: directory,
      manifest,
      chunks,
      initiateRequest,
    },
    manifestUploaded: state.manifestUploaded,
    uploadedChunkIndexes,
    uploadExpiresAt,
    createdAt: canonicalTimestamp(state.createdAt, "creation time"),
    updatedAt: canonicalTimestamp(state.updatedAt, "update time"),
  };
}

export class EncryptedBackupUploadStore implements EncryptedBackupUploadStoreLike {
  readonly rootPath: string;

  constructor(rootPath: string) {
    if (typeof rootPath !== "string" || !isAbsolute(rootPath)) {
      throw new Error("Encrypted backup upload root must be absolute.");
    }
    this.rootPath = resolve(rootPath);
    privateDirectory(this.rootPath);
  }

  persistArchive(input: {
    archive: EncryptedBackupArchive;
    accountId: string;
    deviceId: string;
    profileLineageId: string;
    createdAt: Date;
  }): PersistedEncryptedBackupUpload {
    const accountId = identifier(input.accountId, "account ID");
    const deviceId = identifier(input.deviceId, "device ID");
    const profileLineageId = identifier(
      input.profileLineageId,
      "Profile lineage ID",
    );
    const backupId = identifier(input.archive.backupId, "backup ID");
    if (
      input.archive.initiateRequest.envelope.backup_id !== backupId ||
      input.archive.initiateRequest.envelope.profile_lineage_id !==
        profileLineageId ||
      input.archive.initiateRequest.envelope.source_device_id !== deviceId
    ) {
      throw new Error("Encrypted backup archive identity is invalid.");
    }
    const source = resolve(input.archive.ciphertextPath);
    const destination = join(this.rootPath, backupId);
    if (
      !isAbsolute(source) ||
      !lstatSync(source).isDirectory() ||
      existsSync(destination)
    ) {
      throw new Error("Encrypted backup ciphertext lifecycle is invalid.");
    }
    const createdAt = input.createdAt.toISOString();
    let moved = false;
    try {
      renameSync(source, destination);
      moved = true;
      chmodSync(destination, 0o700);
      const rebaseObject = (
        value: EncryptedBackupArchiveObject,
      ): EncryptedBackupArchiveObject => {
        if (dirname(resolve(value.path)) !== source) {
          throw new Error("Encrypted backup object path is invalid.");
        }
        return { ...value, path: join(destination, basename(value.path)) };
      };
      const archive: EncryptedBackupArchive = {
        ...input.archive,
        ciphertextPath: destination,
        manifest: rebaseObject(input.archive.manifest),
        chunks: input.archive.chunks.map((chunk) => ({
          ...rebaseObject(chunk),
          index: chunk.index,
          object: chunk.object,
        })),
      };
      const state: PersistedEncryptedBackupUpload = {
        version: 1,
        accountId,
        deviceId,
        profileLineageId,
        archive,
        manifestUploaded: false,
        uploadedChunkIndexes: [],
        uploadExpiresAt: null,
        createdAt,
        updatedAt: createdAt,
      };
      this.write(state);
      return parseUpload(serializeUpload(state), destination);
    } catch (error) {
      if (moved) rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  }

  load(
    accountIdValue: string,
    profileLineageIdValue: string,
  ): PersistedEncryptedBackupUpload | null {
    const accountId = identifier(accountIdValue, "account ID");
    const profileLineageId = identifier(
      profileLineageIdValue,
      "Profile lineage ID",
    );
    const matches: PersistedEncryptedBackupUpload[] = [];
    for (const name of readdirSync(this.rootPath).sort()) {
      if (!UUID_PATTERN.test(name)) continue;
      const directory = join(this.rootPath, name);
      const statePath = join(directory, STATE_FILE);
      if (!existsSync(statePath)) continue;
      const state = this.read(directory);
      if (
        state.accountId === accountId &&
        state.profileLineageId === profileLineageId
      ) {
        matches.push(state);
      }
    }
    if (matches.length > 1) {
      throw new Error(
        "Multiple encrypted backup uploads exist for one Profile lineage.",
      );
    }
    return matches[0] ?? null;
  }

  update(
    backupIdValue: string,
    patch: {
      manifestUploaded?: boolean;
      uploadedChunkIndexes?: readonly number[];
      uploadExpiresAt?: string;
      updatedAt: Date;
    },
  ): PersistedEncryptedBackupUpload {
    const backupId = identifier(backupIdValue, "backup ID");
    const directory = join(this.rootPath, backupId);
    const current = this.read(directory);
    const uploadedChunkIndexes =
      patch.uploadedChunkIndexes === undefined
        ? current.uploadedChunkIndexes
        : [...patch.uploadedChunkIndexes];
    const next: PersistedEncryptedBackupUpload = {
      ...current,
      manifestUploaded: patch.manifestUploaded ?? current.manifestUploaded,
      uploadedChunkIndexes,
      uploadExpiresAt: patch.uploadExpiresAt ?? current.uploadExpiresAt,
      updatedAt: patch.updatedAt.toISOString(),
    };
    const validated = parseUpload(serializeUpload(next), directory);
    this.write(validated);
    return validated;
  }

  remove(backupIdValue: string): void {
    const backupId = identifier(backupIdValue, "backup ID");
    const directory = join(this.rootPath, backupId);
    if (!inside(this.rootPath, directory)) {
      throw new Error("Encrypted backup upload path is invalid.");
    }
    rmSync(directory, { recursive: true, force: true });
  }

  private read(directory: string): PersistedEncryptedBackupUpload {
    if (!inside(this.rootPath, directory)) {
      throw new Error("Encrypted backup upload path is invalid.");
    }
    const statePath = join(directory, STATE_FILE);
    const stats = lstatSync(statePath);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.size < 2 ||
      stats.size > MAXIMUM_STATE_BYTES
    ) {
      throw new Error("Encrypted backup upload state is unsafe.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      throw new Error("Encrypted backup upload state is invalid.");
    }
    return parseUpload(parsed, directory);
  }

  private write(state: PersistedEncryptedBackupUpload): void {
    const directory = state.archive.ciphertextPath;
    if (!inside(this.rootPath, directory)) {
      throw new Error("Encrypted backup upload path is invalid.");
    }
    const payload = Buffer.from(
      `${JSON.stringify(serializeUpload(state))}\n`,
      "utf8",
    );
    if (payload.byteLength > MAXIMUM_STATE_BYTES) {
      payload.fill(0);
      throw new Error("Encrypted backup upload state is too large.");
    }
    const temporaryPath = join(directory, STATE_TEMPORARY_FILE);
    const statePath = join(directory, STATE_FILE);
    rmSync(temporaryPath, { force: true });
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, payload);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporaryPath, statePath);
      chmodSync(statePath, 0o600);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      payload.fill(0);
      rmSync(temporaryPath, { force: true });
    }
  }
}

export class AgenteraEncryptedBackupManager {
  private readonly transactionsRoot: string;
  private readonly activity: RuntimeActivityCoordinator;
  private readonly uploadStore: EncryptedBackupUploadStoreLike;
  private readonly client: EncryptedBackupCloudClient;
  private readonly keyStore: AgenteraEncryptedBackupManagerOptions["keyStore"];
  private readonly getPrincipal: AgenteraEncryptedBackupManagerOptions["getPrincipal"];
  private readonly resolveSource: AgenteraEncryptedBackupManagerOptions["resolveSource"];
  private readonly snapshot: typeof withEncryptedBackupSnapshot;
  private readonly archive: typeof createEncryptedBackupArchive;
  private readonly now: () => Date;
  private readonly active = new Map<string, ActiveBackup>();
  private closed = false;

  constructor(options: AgenteraEncryptedBackupManagerOptions) {
    if (
      typeof options.transactionsRoot !== "string" ||
      !isAbsolute(options.transactionsRoot)
    ) {
      throw new Error("Encrypted backup transactions root must be absolute.");
    }
    this.transactionsRoot = resolve(options.transactionsRoot);
    this.activity = options.activity;
    this.uploadStore = options.uploadStore;
    this.client = options.client;
    this.keyStore = options.keyStore;
    this.getPrincipal = options.getPrincipal;
    this.resolveSource = options.resolveSource;
    this.snapshot = options.snapshot ?? withEncryptedBackupSnapshot;
    this.archive = options.archive ?? createEncryptedBackupArchive;
    this.now = options.now ?? (() => new Date());
  }

  async createBackup(
    installationIdValue: string,
    options: CreateEncryptedBackupOptions = {},
  ): Promise<CreateEncryptedBackupResult> {
    if (this.closed) {
      throw new Error("Encrypted backup manager is closed.");
    }
    const installationId = identifier(installationIdValue, "Installation ID");
    if (this.active.has(installationId)) {
      throw new Error(
        "An encrypted backup is already active for this Installation.",
      );
    }
    const active: ActiveBackup = {
      controller: new AbortController(),
      explicitlyCancelled: false,
      backupId: null,
    };
    this.active.set(installationId, active);
    const abort = (): void => active.controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.runCreateBackup(
        installationId,
        active,
        options.onProgress,
      );
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.active.delete(installationId);
    }
  }

  async cancelBackup(installationIdValue: string): Promise<boolean> {
    const installationId = identifier(installationIdValue, "Installation ID");
    const active = this.active.get(installationId);
    if (active) {
      active.explicitlyCancelled = true;
      active.controller.abort();
      return true;
    }
    const principal = this.getPrincipal();
    if (!principal) return false;
    const state = this.keyStore.getState({
      accountId: principal.accountId,
      deviceId: principal.deviceId,
    });
    if (!state.profileLineageId) return false;
    const pending = this.uploadStore.load(
      principal.accountId,
      state.profileLineageId,
    );
    if (!pending) return false;
    this.uploadStore.remove(pending.archive.backupId);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const active of this.active.values()) {
      active.explicitlyCancelled = true;
      active.controller.abort();
    }
  }

  private async runCreateBackup(
    installationId: string,
    active: ActiveBackup,
    onProgress?: CreateEncryptedBackupOptions["onProgress"],
  ): Promise<CreateEncryptedBackupResult> {
    const principal = this.requirePrincipal();
    const source = await this.resolveSource(installationId);
    if (
      !source ||
      source.installationId !== installationId ||
      source.provenance.sourceInstallationId !== installationId
    ) {
      throw new Error("Encrypted backup source is unavailable.");
    }
    const state = this.keyStore.getState({
      accountId: principal.accountId,
      deviceId: principal.deviceId,
    });
    if (
      !state.initialized ||
      !state.recoveryConfirmed ||
      !state.profileLineageId ||
      state.keyEpoch === null
    ) {
      throw new Error(
        "Encrypted backup recovery setup must be confirmed first.",
      );
    }
    const material = this.keyStore.getArchivePublicMaterial({
      accountId: principal.accountId,
      deviceId: principal.deviceId,
    });
    if (
      material.profileLineageId !== state.profileLineageId ||
      material.keyEpoch !== state.keyEpoch
    ) {
      throw new Error("Encrypted backup key state changed.");
    }
    const registration = await this.keyStore.getDevicePublicRegistration({
      accountId: principal.accountId,
      deviceId: principal.deviceId,
      signDigest: principal.signDigest,
    });
    const registered = await this.client.registerCurrentDevice(
      registration,
      active.controller.signal,
    );
    if (
      registered.deviceId !== principal.deviceId ||
      registered.keyEpoch !== material.keyEpoch ||
      registered.revision !== registration.revision ||
      registered.status !== "active"
    ) {
      throw new Error("Encrypted backup device registration was rejected.");
    }

    let pending = this.uploadStore.load(
      principal.accountId,
      material.profileLineageId,
    );
    let resumed = pending !== null;
    for (
      let expirationAttempt = 0;
      expirationAttempt < 2;
      expirationAttempt += 1
    ) {
      if (!pending) {
        pending = await this.createPersistedArchive({
          principal,
          source,
          profileLineageId: material.profileLineageId,
          keyEpoch: material.keyEpoch,
          recoveryRootKeyEnvelope: material.recoveryRootKeyEnvelope,
          devicePublicKey: material.devicePublicKey,
          signal: active.controller.signal,
        });
        resumed = false;
      }
      active.backupId = pending.archive.backupId;
      try {
        return await this.uploadAndSeal(
          pending,
          active.controller.signal,
          resumed,
          onProgress,
        );
      } catch (error) {
        if (
          error instanceof AgenteraEncryptedBackupClientError &&
          error.restartRequired &&
          expirationAttempt === 0
        ) {
          this.uploadStore.remove(pending.archive.backupId);
          pending = null;
          continue;
        }
        if (
          active.explicitlyCancelled ||
          (error instanceof AgenteraEncryptedBackupClientError &&
            [
              "ciphertext_changed",
              "quota_exceeded",
              "invalid_request",
              "invalid_signature",
              "backup_conflict",
              "not_authorized",
              "feature_unavailable",
            ].includes(error.code))
        ) {
          this.uploadStore.remove(pending.archive.backupId);
        }
        throw error;
      }
    }
    throw new Error("Encrypted backup upload could not be restarted.");
  }

  private async createPersistedArchive(input: {
    principal: EncryptedBackupPrincipal;
    source: EncryptedBackupSource;
    profileLineageId: string;
    keyEpoch: number;
    recoveryRootKeyEnvelope: ReturnType<
      AgenteraEncryptedBackupKeyStore["getArchivePublicMaterial"]
    >["recoveryRootKeyEnvelope"];
    devicePublicKey: string;
    signal: AbortSignal;
  }): Promise<PersistedEncryptedBackupUpload> {
    const sourceDeviceRootKeyEnvelope =
      await this.keyStore.wrapRootKeyForDevice({
        accountId: input.principal.accountId,
        sourceDeviceId: input.principal.deviceId,
        deviceId: input.principal.deviceId,
        publicKey: input.devicePublicKey,
      });
    const provenance = Buffer.from(
      input.source.encryptedRuntimeBindingProvenance,
    );
    try {
      return await this.snapshot(
        {
          profilePath: input.source.profilePath,
          transactionsRoot: this.transactionsRoot,
          profileLineageId: input.profileLineageId,
          provenance: input.source.provenance,
          encryptedRuntimeBindingProvenance: provenance,
          activity: this.activity,
          signal: input.signal,
          now: this.now,
        },
        async (snapshot: EncryptedBackupSnapshot) => {
          const archiveInput: CreateEncryptedBackupArchiveInput = {
            snapshot,
            sourceDeviceId: input.principal.deviceId,
            keyEpoch: input.keyEpoch,
            parentBackupId: input.source.parentBackupId,
            recoveryRootKeyEnvelope: input.recoveryRootKeyEnvelope,
            sourceDeviceRootKeyEnvelope,
            wrapDataKey: ({ backupId, dataKey }) =>
              this.keyStore.wrapBackupDataKey({
                accountId: input.principal.accountId,
                deviceId: input.principal.deviceId,
                backupId,
                dataKey,
              }),
            signDigest: input.principal.signDigest,
            signal: input.signal,
            now: this.now,
          };
          const archive = await this.archive(archiveInput);
          return this.uploadStore.persistArchive({
            archive,
            accountId: input.principal.accountId,
            deviceId: input.principal.deviceId,
            profileLineageId: input.profileLineageId,
            createdAt: this.now(),
          });
        },
      );
    } finally {
      provenance.fill(0);
    }
  }

  private async uploadAndSeal(
    initial: PersistedEncryptedBackupUpload,
    signal: AbortSignal,
    resumed: boolean,
    onProgress?: CreateEncryptedBackupOptions["onProgress"],
  ): Promise<CreateEncryptedBackupResult> {
    let state = initial;
    const initiated = await this.client.initiate(
      state.archive.initiateRequest,
      signal,
    );
    if (initiated.backupId !== state.archive.backupId) {
      throw new Error("Encrypted backup initiation identity changed.");
    }
    state = this.uploadStore.update(state.archive.backupId, {
      uploadExpiresAt: initiated.uploadExpiresAt,
      updatedAt: this.now(),
    });
    const uploaded = new Set(state.uploadedChunkIndexes);
    const remaining: Array<
      { kind: "manifest" } | { kind: "chunk"; index: number }
    > = [];
    if (!state.manifestUploaded) remaining.push({ kind: "manifest" });
    for (const chunk of state.archive.chunks) {
      if (!uploaded.has(chunk.index)) {
        remaining.push({ kind: "chunk", index: chunk.index });
      }
    }
    let completed = 0;
    await this.client.uploadArchive(state.archive, {
      manifestUploaded: state.manifestUploaded,
      uploadedChunkIndexes: state.uploadedChunkIndexes,
      signal,
      onProgress: (progress) => {
        const item = remaining[completed];
        if (!item) {
          throw new Error("Encrypted backup upload progress is invalid.");
        }
        completed += 1;
        if (item.kind === "manifest") {
          state = this.uploadStore.update(state.archive.backupId, {
            manifestUploaded: true,
            updatedAt: this.now(),
          });
        } else {
          uploaded.add(item.index);
          state = this.uploadStore.update(state.archive.backupId, {
            uploadedChunkIndexes: [...uploaded].sort(
              (left, right) => left - right,
            ),
            updatedAt: this.now(),
          });
        }
        onProgress?.(progress);
      },
    });
    const sealed = await this.client.seal(state.archive.backupId, signal);
    this.uploadStore.remove(state.archive.backupId);
    return {
      backupId: sealed.backupId,
      sealedAt: sealed.sealedAt,
      resumed,
    };
  }

  private requirePrincipal(): EncryptedBackupPrincipal {
    const principal = this.getPrincipal();
    if (!principal) {
      throw new AgenteraEncryptedBackupClientError(
        0,
        "authentication_required",
        false,
      );
    }
    return {
      accountId: identifier(principal.accountId, "account ID"),
      deviceId: identifier(principal.deviceId, "device ID"),
      signDigest: principal.signDigest,
    };
  }
}
