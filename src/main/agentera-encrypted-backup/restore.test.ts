// @vitest-environment node

import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEncryptedBackupArchive,
  encryptedBackupPublicEnvelopeSigningDigest,
  type EncryptedBackupArchive,
  type EncryptedBackupObjectSpec,
} from "./archive";
import type {
  EncryptedBackupDetail,
  EncryptedBackupRestoreCloudClient,
} from "./client";
import {
  generateBackupDeviceKeyPair,
  recoveryPhraseFromEntropy,
  unwrapRootKeyForDevice,
  unwrapRootKeyFromRecovery,
  wrapBackupDataKey,
  wrapRootKeyForDevice,
  wrapRootKeyForRecovery,
} from "./crypto";
import {
  backupDeviceRootKeyAad,
  type AdoptRestoredEncryptedBackupAccountInput,
} from "./key-store";
import {
  createEncryptedBackupSnapshotManifest,
  serializeEncryptedBackupSnapshotManifest,
  type EncryptedBackupSnapshotFile,
} from "./manifest";
import {
  AgenteraEncryptedBackupRestoreService,
  EncryptedBackupRestoreError,
  type EncryptedBackupRestoreAgentControl,
} from "./restore";
import type { EncryptedBackupSnapshot } from "./snapshot";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "10000000-0000-4000-8000-000000000002";
const DEVICE_ID = "20000000-0000-4000-8000-000000000001";
const LINEAGE_ID = "30000000-0000-4000-8000-000000000001";
const SOURCE_INSTALLATION_ID = "40000000-0000-4000-8000-000000000001";
const DEFINITION_ID = "50000000-0000-4000-8000-000000000001";
const VERSION_ID = "60000000-0000-4000-8000-000000000001";
const BACKUP_ID = "70000000-0000-4000-8000-000000000001";
const PREPARATION_ID = "71000000-0000-4000-8000-000000000001";
const RESTORE_INSTALLATION_ID = "80000000-0000-4000-8000-000000000001";
const RESTORE_PROFILE_ID = "90000000-0000-4000-8000-000000000001";
const RESTORE_RUNTIME_PROFILE_ID = "a0000000-0000-4000-8000-000000000001";
const roots: string[] = [];

interface RestoreFixture {
  root: string;
  archive: EncryptedBackupArchive;
  detail: EncryptedBackupDetail;
  phrase: string;
  devicePrivateKey: string;
  recoveryEnvelope: Awaited<ReturnType<typeof wrapRootKeyForRecovery>>;
  client: EncryptedBackupRestoreCloudClient;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeSqlite(path: string): void {
  const database = new DatabaseSync(path);
  database.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sessions VALUES ('historical', 'read-only-if-runtime-missing')",
  );
  database.close();
}

async function restoreFixture(
  input: {
    duplicatePath?: boolean;
    omitCurrentEnvelope?: boolean;
    tamperObjectId?: string;
  } = {},
): Promise<RestoreFixture> {
  const root = mkdtempSync(join(tmpdir(), "agentera-restore-"));
  roots.push(root);
  const transactionPath = join(root, "source-transaction");
  const filesPath = join(transactionPath, "plaintext");
  mkdirSync(join(filesPath, "memories"), { recursive: true, mode: 0o700 });
  mkdirSync(join(filesPath, "skills", "private"), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(join(filesPath, "provenance"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    join(filesPath, "memories", "MEMORY.md"),
    "restored private memory\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(filesPath, "skills", "private", "SKILL.md"),
    "restored private skill\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(filesPath, "provenance", "runtime-bindings.enc"),
    "encrypted historical runtime bindings",
    { mode: 0o600 },
  );
  writeSqlite(join(filesPath, "state.db"));

  const descriptors: EncryptedBackupSnapshotFile[] = [
    {
      path: "memories/MEMORY.md",
      kind: "memory",
      modeClass: "owner-read-write",
      size: readFileSync(join(filesPath, "memories", "MEMORY.md")).byteLength,
      sha256: sha256(readFileSync(join(filesPath, "memories", "MEMORY.md"))),
    },
    {
      path: "skills/private/SKILL.md",
      kind: "private_skill",
      modeClass: "owner-read-write",
      size: readFileSync(join(filesPath, "skills", "private", "SKILL.md"))
        .byteLength,
      sha256: sha256(
        readFileSync(join(filesPath, "skills", "private", "SKILL.md")),
      ),
    },
    {
      path: "state.db",
      kind: "session_database",
      modeClass: "owner-read-write",
      size: readFileSync(join(filesPath, "state.db")).byteLength,
      sha256: sha256(readFileSync(join(filesPath, "state.db"))),
    },
    {
      path: "provenance/runtime-bindings.enc",
      kind: "runtime_binding_provenance",
      modeClass: "owner-read-write",
      size: readFileSync(join(filesPath, "provenance", "runtime-bindings.enc"))
        .byteLength,
      sha256: sha256(
        readFileSync(join(filesPath, "provenance", "runtime-bindings.enc")),
      ),
    },
  ];
  if (input.duplicatePath) descriptors.push({ ...descriptors[0] });
  const manifest = createEncryptedBackupSnapshotManifest({
    profileLineageId: LINEAGE_ID,
    createdAt: new Date("2026-07-23T12:00:00.000Z"),
    provenance: {
      sourceInstallationId: SOURCE_INSTALLATION_ID,
      sourceDefinitionId: DEFINITION_ID,
      sourceVersionId: VERSION_ID,
      baseOwnerScope: "USER",
    },
    files: descriptors,
  });
  const manifestBytes = serializeEncryptedBackupSnapshotManifest(manifest);
  const manifestPath = join(transactionPath, "manifest.json");
  writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
  const snapshot: EncryptedBackupSnapshot = {
    transactionId: "72000000-0000-4000-8000-000000000001",
    transactionPath,
    filesPath,
    manifestPath,
    manifest,
    manifestBytes,
  };
  const rootKey = Buffer.alloc(32, 0x51);
  const phrase = recoveryPhraseFromEntropy(Buffer.alloc(32, 0x52));
  const recoveryEnvelope = await wrapRootKeyForRecovery({
    rootKey,
    phrase,
    salt: Buffer.alloc(16, 0x53),
    lineageId: LINEAGE_ID,
  });
  const device = await generateBackupDeviceKeyPair();
  const deviceAad = backupDeviceRootKeyAad({
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    keyEpoch: 1,
  });
  const deviceEnvelope = await wrapRootKeyForDevice(
    device.publicKey,
    rootKey,
    deviceAad,
  );
  deviceAad.fill(0);
  const signing = generateKeyPairSync("ed25519");
  const archive = await createEncryptedBackupArchive({
    snapshot,
    sourceDeviceId: DEVICE_ID,
    keyEpoch: 1,
    parentBackupId: null,
    recoveryRootKeyEnvelope: recoveryEnvelope,
    sourceDeviceRootKeyEnvelope: deviceEnvelope,
    wrapDataKey: ({ backupId, dataKey }) =>
      wrapBackupDataKey(rootKey, dataKey, backupId),
    signDigest: (digest) =>
      signBytes(null, Buffer.from(digest), signing.privateKey).toString(
        "base64url",
      ),
    randomUUID: () => BACKUP_ID,
    now: () => new Date("2026-07-23T12:00:00.000Z"),
  });
  rootKey.fill(0);
  const sourcePublicKey = signing.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64url");
  const sourceDeviceEnvelopeBytes = Buffer.from(
    archive.initiateRequest.source_device_root_key_envelope,
    "base64url",
  );
  const currentDeviceEnvelope = input.omitCurrentEnvelope
    ? null
    : {
        deviceId: DEVICE_ID,
        keyEpoch: 1,
        rootKeyEnvelope:
          archive.initiateRequest.source_device_root_key_envelope,
        rootKeyEnvelopeDigest: createHash("sha256")
          .update(sourceDeviceEnvelopeBytes)
          .digest("base64url"),
      };
  sourceDeviceEnvelopeBytes.fill(0);
  const detail: EncryptedBackupDetail = {
    envelope: archive.initiateRequest.envelope,
    publicEnvelopeDigest: Buffer.from(
      encryptedBackupPublicEnvelopeSigningDigest(
        archive.initiateRequest.envelope,
      ),
    ).toString("base64url"),
    publicSignature: archive.initiateRequest.signature,
    sourceDevicePublicKey: sourcePublicKey,
    recovery: archive.initiateRequest.recovery,
    recoveryRootKeyEnvelope: archive.initiateRequest.recovery_root_key_envelope,
    wrappedDataKey: archive.initiateRequest.wrapped_data_key,
    currentDeviceEnvelope,
    sealedAt: "2026-07-23T12:01:00.000Z",
  };
  const paths = new Map<string, string>([
    [archive.manifest.object.object_id, archive.manifest.path],
    ...archive.chunks.map((chunk): [string, string] => [
      chunk.object.object_id,
      chunk.path,
    ]),
  ]);
  const client: EncryptedBackupRestoreCloudClient = {
    listBackups: async () => [],
    getBackup: async () => structuredClone(detail),
    downloadObject: async (
      _backupId: string,
      object: EncryptedBackupObjectSpec,
    ) => {
      const path = paths.get(object.object_id);
      if (!path) throw new Error("missing object");
      const bytes = Buffer.from(readFileSync(path));
      if (input.tamperObjectId === object.object_id) bytes[20] ^= 1;
      return bytes;
    },
    deleteBackup: async () => undefined,
  };
  return {
    root,
    archive,
    detail,
    phrase,
    devicePrivateKey: device.privateKey,
    recoveryEnvelope,
    client,
  };
}

function agentControlFixture(
  input: {
    baseUnavailable?: boolean;
    activationError?: Error;
  } = {},
): {
  adapter: EncryptedBackupRestoreAgentControl;
  verified: ReturnType<typeof vi.fn>;
  activated: ReturnType<typeof vi.fn>;
  restoredFiles: Map<string, Buffer>;
} {
  const restoredFiles = new Map<string, Buffer>();
  const verified = vi.fn(async () => {
    if (input.baseUnavailable) throw new Error("immutable base unavailable");
  });
  const activated = vi.fn(async (request) => {
    if (input.activationError) throw input.activationError;
    const capture = (relativePath: string): void => {
      restoredFiles.set(
        relativePath,
        readFileSync(
          join(request.stagedProfilePath, ...relativePath.split("/")),
        ),
      );
    };
    capture("memories/MEMORY.md");
    capture("skills/private/SKILL.md");
    capture("state.db");
    restoredFiles.set(
      "provenance",
      readFileSync(request.encryptedRuntimeBindingProvenancePath),
    );
    return {
      agentInstallationId: RESTORE_INSTALLATION_ID,
      profileId: RESTORE_PROFILE_ID,
      runtimeProfileId: RESTORE_RUNTIME_PROFILE_ID,
      sourceScope: "USER" as const,
    };
  });
  return {
    adapter: {
      verifyImmutableUserBase: verified,
      activateVerifiedRestore: activated,
    },
    verified,
    activated,
    restoredFiles,
  };
}

function serviceFor(
  fixture: RestoreFixture,
  agentControl: EncryptedBackupRestoreAgentControl,
  input: {
    accountId?: string;
    beforeFileWrite?: (relativePath: string) => void;
    adoptRestoredAccount?: (
      input: AdoptRestoredEncryptedBackupAccountInput,
    ) => Promise<unknown>;
  } = {},
): AgenteraEncryptedBackupRestoreService {
  const transactionsRoot = join(fixture.root, "restore-transactions");
  return new AgenteraEncryptedBackupRestoreService({
    client: fixture.client,
    keyStore: {
      unwrapRootKeyForCurrentDevice: async ({
        accountId,
        deviceId,
        keyEpoch,
        envelope,
      }) =>
        unwrapRootKeyForDevice(
          fixture.devicePrivateKey,
          envelope,
          backupDeviceRootKeyAad({ accountId, deviceId, keyEpoch }),
        ),
      recoverRestoreRootKeyFromPhrase: ({ phrase }) =>
        unwrapRootKeyFromRecovery({
          envelope: fixture.recoveryEnvelope,
          phrase,
          lineageId: LINEAGE_ID,
        }),
      ...(input.adoptRestoredAccount
        ? { adoptRestoredAccount: input.adoptRestoredAccount }
        : {}),
    },
    getPrincipal: () => ({
      accountId: input.accountId ?? ACCOUNT_ID,
      deviceId: DEVICE_ID,
    }),
    agentControl,
    transactionsRoot,
    randomUUID: () => PREPARATION_ID,
    now: () => new Date("2026-07-23T12:02:00.000Z"),
    fileHooks: { beforeFileWrite: input.beforeFileWrite },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgenteraEncryptedBackupRestoreService", () => {
  it("uses the authorized device envelope, verifies all bytes, and activates only a fresh USER branch", async () => {
    const fixture = await restoreFixture();
    const control = agentControlFixture();
    const adoptRestoredAccount = vi.fn(async () => undefined);
    const service = serviceFor(fixture, control.adapter, {
      adoptRestoredAccount,
    });
    const prepared = await service.prepareRestore({
      backupId: BACKUP_ID,
    });
    expect(prepared).toEqual({
      preparationId: PREPARATION_ID,
      backupId: BACKUP_ID,
      sourceInstallationId: SOURCE_INSTALLATION_ID,
      sourceDefinitionId: DEFINITION_ID,
      sourceVersionId: VERSION_ID,
      createdAt: "2026-07-23T12:00:00.000Z",
      fileCount: 4,
      totalPlaintextSize: expect.any(Number),
    });
    expect(control.activated).not.toHaveBeenCalled();
    expect(adoptRestoredAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        keyEpoch: 1,
        profileLineageId: LINEAGE_ID,
        recoveryEnvelope: fixture.recoveryEnvelope,
        rootKey: expect.any(Uint8Array),
      }),
    );

    const restored = await service.confirmRestore({
      preparationId: PREPARATION_ID,
      name: "Restored private branch",
    });
    expect(restored).toEqual({
      backupId: BACKUP_ID,
      agentInstallationId: RESTORE_INSTALLATION_ID,
      profileId: RESTORE_PROFILE_ID,
      runtimeProfileId: RESTORE_RUNTIME_PROFILE_ID,
    });
    expect(control.verified).toHaveBeenCalledWith({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      ownerScope: "USER",
    });
    expect(control.activated).toHaveBeenCalledWith(
      expect.objectContaining({
        backupId: BACKUP_ID,
        sourceInstallationId: SOURCE_INSTALLATION_ID,
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profileLineageId: LINEAGE_ID,
        name: "Restored private branch",
      }),
    );
    expect(control.restoredFiles.get("memories/MEMORY.md")?.toString()).toBe(
      "restored private memory\n",
    );
    expect(control.restoredFiles.get("provenance")?.toString()).toBe(
      "encrypted historical runtime bindings",
    );
    expect(RESTORE_INSTALLATION_ID).not.toBe(SOURCE_INSTALLATION_ID);
    expect(readdirSync(join(fixture.root, "restore-transactions"))).toEqual([]);
  });

  it("supports phrase recovery and rejects a wrong phrase without retaining plaintext", async () => {
    const fixture = await restoreFixture({ omitCurrentEnvelope: true });
    const control = agentControlFixture();
    const service = serviceFor(fixture, control.adapter);
    await expect(
      service.prepareRestore({
        backupId: BACKUP_ID,
        recoveryPhrase:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      }),
    ).rejects.toBeInstanceOf(EncryptedBackupRestoreError);
    expect(readdirSync(join(fixture.root, "restore-transactions"))).toEqual([]);

    await expect(
      service.prepareRestore({
        backupId: BACKUP_ID,
        recoveryPhrase: fixture.phrase,
      }),
    ).resolves.toMatchObject({ backupId: BACKUP_ID });
  }, 30_000);

  it("fails closed for wrong-account AAD, revoked or missing device envelope, and tampered ciphertext", async () => {
    const deviceFixture = await restoreFixture();
    await expect(
      serviceFor(deviceFixture, agentControlFixture().adapter, {
        accountId: OTHER_ACCOUNT_ID,
      }).prepareRestore({ backupId: BACKUP_ID }),
    ).rejects.toMatchObject({ code: "device_authorization_required" });

    const revoked = await restoreFixture({ omitCurrentEnvelope: true });
    await expect(
      serviceFor(revoked, agentControlFixture().adapter).prepareRestore({
        backupId: BACKUP_ID,
      }),
    ).rejects.toMatchObject({ code: "device_authorization_required" });

    const tampered = await restoreFixture();
    const adoptRestoredAccount = vi.fn(async () => undefined);
    tampered.client.downloadObject = async (_backupId, object) => {
      const source =
        object.object_id === tampered.archive.manifest.object.object_id
          ? tampered.archive.manifest.path
          : tampered.archive.chunks[0].path;
      const bytes = Buffer.from(readFileSync(source));
      bytes[20] ^= 1;
      return bytes;
    };
    await expect(
      serviceFor(tampered, agentControlFixture().adapter, {
        adoptRestoredAccount,
      }).prepareRestore({ backupId: BACKUP_ID }),
    ).rejects.toMatchObject({ code: "ciphertext_invalid" });
    expect(adoptRestoredAccount).not.toHaveBeenCalled();
  }, 30_000);

  it("rejects duplicate paths and an unavailable immutable base before activation", async () => {
    const collision = await restoreFixture({ duplicatePath: true });
    const collisionControl = agentControlFixture();
    await expect(
      serviceFor(collision, collisionControl.adapter).prepareRestore({
        backupId: BACKUP_ID,
      }),
    ).rejects.toMatchObject({ code: "metadata_invalid" });
    expect(collisionControl.activated).not.toHaveBeenCalled();

    const unavailable = await restoreFixture();
    const unavailableControl = agentControlFixture({
      baseUnavailable: true,
    });
    await expect(
      serviceFor(unavailable, unavailableControl.adapter).prepareRestore({
        backupId: BACKUP_ID,
      }),
    ).rejects.toMatchObject({ code: "base_unavailable" });
    expect(unavailableControl.activated).not.toHaveBeenCalled();
  });

  it("cleans staging on disk-full and existing-destination refusal without touching prior state", async () => {
    const diskFull = await restoreFixture();
    const diskControl = agentControlFixture();
    const diskService = serviceFor(diskFull, diskControl.adapter, {
      beforeFileWrite: () => {
        const error = Object.assign(new Error("disk full"), {
          code: "ENOSPC",
        });
        throw error;
      },
    });
    await expect(
      diskService.prepareRestore({ backupId: BACKUP_ID }),
    ).rejects.toMatchObject({ code: "disk_full" });
    expect(diskControl.activated).not.toHaveBeenCalled();
    expect(readdirSync(join(diskFull.root, "restore-transactions"))).toEqual(
      [],
    );

    const existing = await restoreFixture();
    const priorState = join(existing.root, "prior-profile");
    mkdirSync(priorState);
    writeFileSync(join(priorState, "MEMORY.md"), "unchanged");
    const existingControl = agentControlFixture({
      activationError: Object.assign(new Error("destination exists"), {
        code: "destination_exists",
      }),
    });
    const service = serviceFor(existing, existingControl.adapter);
    const prepared = await service.prepareRestore({ backupId: BACKUP_ID });
    await expect(
      service.confirmRestore({
        preparationId: prepared.preparationId,
        name: "Existing",
      }),
    ).rejects.toMatchObject({ code: "destination_exists" });
    expect(readFileSync(join(priorState, "MEMORY.md"), "utf8")).toBe(
      "unchanged",
    );
    expect(readdirSync(join(existing.root, "restore-transactions"))).toEqual(
      [],
    );
    expect(existsSync(priorState)).toBe(true);
  });
});
