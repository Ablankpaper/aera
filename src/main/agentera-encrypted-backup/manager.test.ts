// @vitest-environment node

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EncryptedBackupArchive,
  EncryptedBackupInitiateRequest,
  EncryptedBackupObjectSpec,
} from "./archive";
import {
  AgenteraEncryptedBackupClientError,
  type EncryptedBackupCloudClient,
} from "./client";
import {
  AgenteraEncryptedBackupManager,
  EncryptedBackupUploadStore,
  type EncryptedBackupUploadStoreLike,
  type PersistedEncryptedBackupUpload,
} from "./manager";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const DEVICE_ID = "20000000-0000-4000-8000-000000000001";
const LINEAGE_ID = "30000000-0000-4000-8000-000000000001";
const INSTALLATION_ID = "40000000-0000-4000-8000-000000000001";
const DEFINITION_ID = "50000000-0000-4000-8000-000000000001";
const VERSION_ID = "60000000-0000-4000-8000-000000000001";
const BACKUP_ID = "70000000-0000-4000-8000-000000000001";
const roots: string[] = [];

function object(bytes: Buffer): EncryptedBackupObjectSpec {
  const digest = createHash("sha256").update(bytes).digest();
  return {
    object_id: digest.toString("hex"),
    ciphertext_digest: digest.toString("base64url"),
    ciphertext_size: bytes.byteLength,
  };
}

function requestFixture(backupId = BACKUP_ID): EncryptedBackupInitiateRequest {
  const manifest = object(Buffer.alloc(64, 0x31));
  const chunks = [object(Buffer.alloc(64, 0x32))].map((value, index) => ({
    index,
    ...value,
  }));
  return {
    envelope: {
      format_version: 1,
      cipher_suite: "HPKE-X25519-HKDF-SHA256-AES256GCM+ARGON2ID+AES256GCM",
      backup_id: backupId,
      profile_lineage_id: LINEAGE_ID,
      parent_backup_id: null,
      source_device_id: DEVICE_ID,
      source_installation_id: INSTALLATION_ID,
      source_definition_id: DEFINITION_ID,
      source_version_id: VERSION_ID,
      base_owner_scope: "USER",
      key_epoch: 1,
      created_at: "2026-07-23T12:00:00.000Z",
      manifest,
      chunks,
      total_ciphertext_size: chunks[0].ciphertext_size,
      recovery_envelope_digest: Buffer.alloc(32, 0x33).toString("base64url"),
      wrapped_data_key_digest: Buffer.alloc(32, 0x34).toString("base64url"),
      source_device_envelope_digest: Buffer.alloc(32, 0x35).toString(
        "base64url",
      ),
    },
    signature: Buffer.alloc(64, 0x36).toString("base64url"),
    recovery: {
      salt: Buffer.alloc(16, 0x37).toString("base64url"),
      memory_kib: 65536,
      iterations: 3,
      parallelism: 1,
    },
    recovery_root_key_envelope: Buffer.alloc(96, 0x38).toString("base64url"),
    wrapped_data_key: Buffer.alloc(96, 0x39).toString("base64url"),
    source_device_root_key_envelope: Buffer.alloc(96, 0x3a).toString(
      "base64url",
    ),
  };
}

function archiveFixture(
  root: string,
  backupId = BACKUP_ID,
): EncryptedBackupArchive {
  const ciphertextPath = join(root, "transaction", "ciphertext");
  mkdirSync(ciphertextPath, { recursive: true, mode: 0o700 });
  const manifestBytes = Buffer.alloc(64, 0x31);
  const chunkBytes = Buffer.alloc(64, 0x32);
  const request = requestFixture(backupId);
  const manifestPath = join(
    ciphertextPath,
    `manifest-${request.envelope.manifest.object_id}.bin`,
  );
  const chunkPath = join(
    ciphertextPath,
    `chunk-000000-${request.envelope.chunks[0].object_id}.bin`,
  );
  writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
  writeFileSync(chunkPath, chunkBytes, { mode: 0o600 });
  return {
    backupId,
    ciphertextPath,
    manifest: {
      path: manifestPath,
      object: request.envelope.manifest,
      plaintextSize: 36,
    },
    chunks: [
      {
        index: 0,
        path: chunkPath,
        object: request.envelope.chunks[0],
        plaintextSize: 36,
      },
    ],
    initiateRequest: request,
  };
}

class MemoryUploadStore implements EncryptedBackupUploadStoreLike {
  current: PersistedEncryptedBackupUpload | null = null;
  removed: string[] = [];

  persistArchive(input: {
    archive: EncryptedBackupArchive;
    accountId: string;
    deviceId: string;
    profileLineageId: string;
    createdAt: Date;
  }): PersistedEncryptedBackupUpload {
    this.current = {
      version: 1,
      accountId: input.accountId,
      deviceId: input.deviceId,
      profileLineageId: input.profileLineageId,
      archive: input.archive,
      manifestUploaded: false,
      uploadedChunkIndexes: [],
      uploadExpiresAt: null,
      createdAt: input.createdAt.toISOString(),
      updatedAt: input.createdAt.toISOString(),
    };
    return this.current;
  }

  load(
    accountId: string,
    profileLineageId: string,
  ): PersistedEncryptedBackupUpload | null {
    return this.current?.accountId === accountId &&
      this.current.profileLineageId === profileLineageId
      ? structuredClone(this.current)
      : null;
  }

  update(
    backupId: string,
    patch: {
      manifestUploaded?: boolean;
      uploadedChunkIndexes?: readonly number[];
      uploadExpiresAt?: string;
      updatedAt: Date;
    },
  ): PersistedEncryptedBackupUpload {
    if (!this.current || this.current.archive.backupId !== backupId) {
      throw new Error("missing upload");
    }
    this.current = {
      ...this.current,
      manifestUploaded: patch.manifestUploaded ?? this.current.manifestUploaded,
      uploadedChunkIndexes: patch.uploadedChunkIndexes
        ? [...patch.uploadedChunkIndexes]
        : this.current.uploadedChunkIndexes,
      uploadExpiresAt: patch.uploadExpiresAt ?? this.current.uploadExpiresAt,
      updatedAt: patch.updatedAt.toISOString(),
    };
    return this.current;
  }

  remove(backupId: string): void {
    this.removed.push(backupId);
    if (this.current?.archive.backupId === backupId) this.current = null;
  }
}

function managerFixture(input: {
  store: MemoryUploadStore;
  client: EncryptedBackupCloudClient;
  archive: EncryptedBackupArchive;
}): {
  manager: AgenteraEncryptedBackupManager;
  snapshot: ReturnType<typeof vi.fn>;
  archive: ReturnType<typeof vi.fn>;
} {
  const snapshot = vi.fn(async (_input, operation) =>
    operation({
      transactionId: "71000000-0000-4000-8000-000000000001",
      transactionPath: join(input.archive.ciphertextPath, ".."),
      filesPath: join(input.archive.ciphertextPath, "..", "plaintext"),
      manifestPath: join(input.archive.ciphertextPath, "..", "manifest.json"),
      manifest: {
        formatVersion: 1,
        profileLineageId: LINEAGE_ID,
        createdAt: "2026-07-23T12:00:00.000Z",
        provenance: {
          sourceInstallationId: INSTALLATION_ID,
          sourceDefinitionId: DEFINITION_ID,
          sourceVersionId: VERSION_ID,
          baseOwnerScope: "USER" as const,
        },
        files: [],
      },
      manifestBytes: Buffer.from("{}"),
    }),
  );
  const archive = vi.fn(async () => input.archive);
  const manager = new AgenteraEncryptedBackupManager({
    transactionsRoot: join(input.archive.ciphertextPath, "..", ".."),
    activity: {} as never,
    uploadStore: input.store,
    client: input.client,
    keyStore: {
      getState: () => ({
        initialized: true,
        accountId: ACCOUNT_ID,
        currentDeviceId: DEVICE_ID,
        keyEpoch: 1,
        profileLineageId: LINEAGE_ID,
        recoveryConfirmed: true,
        devices: [],
      }),
      getDevicePublicRegistration: async ({ signDigest }) => ({
        key_epoch: 1,
        revision: 1,
        public_key: Buffer.alloc(32, 0x41).toString("base64url"),
        signature: signDigest(Buffer.alloc(32)),
      }),
      getArchivePublicMaterial: () => ({
        profileLineageId: LINEAGE_ID,
        keyEpoch: 1,
        recoveryRootKeyEnvelope: {
          formatVersion: 1,
          kdf: "argon2id" as const,
          memoryKiB: 65536 as const,
          iterations: 3 as const,
          parallelism: 1 as const,
          salt: Buffer.alloc(16, 0x42).toString("base64url"),
          nonce: Buffer.alloc(12, 0x43).toString("base64url"),
          ciphertext: Buffer.alloc(48, 0x44).toString("base64url"),
        },
        devicePublicKey: Buffer.alloc(32, 0x41).toString("base64url"),
      }),
      wrapRootKeyForDevice: async () => ({
        formatVersion: 1,
        cipherSuite:
          "HPKE-X25519-HKDF-SHA256-AES256GCM+ARGON2ID+AES256GCM" as const,
        enc: Buffer.alloc(32, 0x45).toString("base64url"),
        ciphertext: Buffer.alloc(48, 0x46).toString("base64url"),
      }),
      wrapBackupDataKey: () => ({
        formatVersion: 1,
        cipher: "AES-256-GCM" as const,
        nonce: Buffer.alloc(12, 0x47).toString("base64url"),
        ciphertext: Buffer.alloc(48, 0x48).toString("base64url"),
      }),
    },
    getPrincipal: () => ({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      signDigest: () => Buffer.alloc(64, 0x49).toString("base64url"),
    }),
    resolveSource: async (installationId) => ({
      installationId,
      profilePath: join(input.archive.ciphertextPath, "..", "profile"),
      parentBackupId: null,
      provenance: {
        sourceInstallationId: INSTALLATION_ID,
        sourceDefinitionId: DEFINITION_ID,
        sourceVersionId: VERSION_ID,
        baseOwnerScope: "USER",
      },
      encryptedRuntimeBindingProvenance: Buffer.from("opaque"),
    }),
    snapshot,
    archive,
    now: () => new Date("2026-07-23T12:00:00.000Z"),
  });
  return { manager, snapshot, archive };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("EncryptedBackupUploadStore", () => {
  it("persists resumable ciphertext metadata but no plaintext", () => {
    const root = mkdtempSync(join(tmpdir(), "agentera-upload-store-"));
    roots.push(root);
    const archive = archiveFixture(root);
    const store = new EncryptedBackupUploadStore(join(root, "uploads"));
    const persisted = store.persistArchive({
      archive,
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      profileLineageId: LINEAGE_ID,
      createdAt: new Date("2026-07-23T12:00:00.000Z"),
    });
    store.update(BACKUP_ID, {
      manifestUploaded: true,
      uploadedChunkIndexes: [0],
      uploadExpiresAt: "2026-07-24T12:00:00.000Z",
      updatedAt: new Date("2026-07-23T12:01:00.000Z"),
    });

    expect(persisted.archive.ciphertextPath).toContain(
      join("uploads", BACKUP_ID),
    );
    const loaded = store.load(ACCOUNT_ID, LINEAGE_ID);
    expect(loaded).toMatchObject({
      manifestUploaded: true,
      uploadedChunkIndexes: [0],
      uploadExpiresAt: "2026-07-24T12:00:00.000Z",
    });
    const metadata = readFileSync(
      join(persisted.archive.ciphertextPath, "upload-state.json"),
      "utf8",
    );
    expect(metadata).not.toContain("transaction");
    expect(metadata).not.toContain('"profilePath"');
    expect(metadata).not.toContain("private-canary");
    store.remove(BACKUP_ID);
    expect(store.load(ACCOUNT_ID, LINEAGE_ID)).toBeNull();
  });
});

describe("AgenteraEncryptedBackupManager", () => {
  it("preserves ciphertext after interruption, resumes only missing objects, then cleans after seal", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentera-manager-"));
    roots.push(root);
    const archive = archiveFixture(root);
    const store = new MemoryUploadStore();
    let interrupted = true;
    const resumes: Array<{
      manifestUploaded?: boolean;
      uploadedChunkIndexes?: readonly number[];
    }> = [];
    const client: EncryptedBackupCloudClient = {
      registerCurrentDevice: vi.fn(async () => ({
        deviceId: DEVICE_ID,
        keyEpoch: 1,
        revision: 1,
        status: "active" as const,
        replayed: false,
      })),
      initiate: vi.fn(async () => ({
        backupId: BACKUP_ID,
        state: "initiated" as const,
        uploadExpiresAt: "2026-07-24T12:00:00.000Z",
        replayed: false,
      })),
      uploadArchive: vi.fn(async (_archive, resume = {}) => {
        resumes.push(resume);
        if (interrupted) {
          interrupted = false;
          resume.onProgress?.({ uploadedObjects: 1, totalObjects: 2 });
          throw new AgenteraEncryptedBackupClientError(
            0,
            "service_unavailable",
            true,
          );
        }
        resume.onProgress?.({ uploadedObjects: 2, totalObjects: 2 });
      }),
      seal: vi.fn(async () => ({
        backupId: BACKUP_ID,
        state: "sealed" as const,
        sealedAt: "2026-07-23T12:02:00.000Z",
        replayed: false,
      })),
    };
    const fixture = managerFixture({ store, client, archive });

    await expect(
      fixture.manager.createBackup(INSTALLATION_ID),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    expect(store.current).toMatchObject({
      manifestUploaded: true,
      uploadedChunkIndexes: [],
    });
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);

    await expect(
      fixture.manager.createBackup(INSTALLATION_ID),
    ).resolves.toMatchObject({
      backupId: BACKUP_ID,
      resumed: true,
      sealedAt: "2026-07-23T12:02:00.000Z",
    });
    expect(fixture.snapshot).toHaveBeenCalledTimes(1);
    expect(resumes[1]).toMatchObject({
      manifestUploaded: true,
      uploadedChunkIndexes: [],
    });
    expect(store.current).toBeNull();
    expect(store.removed).toContain(BACKUP_ID);
  });

  it("allows only one active operation for an Installation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentera-manager-active-"));
    roots.push(root);
    const archive = archiveFixture(root);
    const store = new MemoryUploadStore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: EncryptedBackupCloudClient = {
      registerCurrentDevice: async () => ({
        deviceId: DEVICE_ID,
        keyEpoch: 1,
        revision: 1,
        status: "active",
        replayed: false,
      }),
      initiate: async () => ({
        backupId: BACKUP_ID,
        state: "initiated",
        uploadExpiresAt: "2026-07-24T12:00:00.000Z",
        replayed: false,
      }),
      uploadArchive: async () => held,
      seal: async () => ({
        backupId: BACKUP_ID,
        state: "sealed",
        sealedAt: "2026-07-23T12:02:00.000Z",
        replayed: false,
      }),
    };
    const { manager } = managerFixture({ store, client, archive });
    const first = manager.createBackup(INSTALLATION_ID);
    await vi.waitFor(() => expect(store.current).not.toBeNull());
    await expect(manager.createBackup(INSTALLATION_ID)).rejects.toThrow(
      "already active",
    );
    release();
    await first;
  });
});
