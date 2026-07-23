// @vitest-environment node

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeActivityCoordinator } from "../runtime-activity";
import {
  AgenteraEncryptedBackupController,
  type AgenteraEncryptedBackupAgentControl,
  type AgenteraEncryptedBackupPrincipal,
} from "./controller";
import type {
  AgenteraEncryptedBackupClient,
  EncryptedBackupSummary,
} from "./client";
import {
  openAgenteraEncryptedBackupDatabase,
  type AgenteraEncryptedBackupDatabase,
  type AgenteraEncryptedBackupSqliteDatabase,
} from "./db";
import { AgenteraEncryptedBackupKeyStore } from "./key-store";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "10000000-0000-4000-8000-000000000002";
const DEVICE_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_DEVICE_ID = "20000000-0000-4000-8000-000000000002";
const INSTALLATION_ID = "40000000-0000-4000-8000-000000000001";
const BACKUP_ID = "70000000-0000-4000-8000-000000000001";
const roots: string[] = [];
const controllers: AgenteraEncryptedBackupController[] = [];

class TestSecureStorage {
  private readonly values = new Map<string, string>();

  isEncryptionAvailable(): boolean {
    return true;
  }

  getSelectedStorageBackend(): "unknown" {
    return "unknown";
  }

  encryptString(value: string): Buffer {
    const id = randomBytes(24).toString("hex");
    this.values.set(id, value);
    return Buffer.from(id);
  }

  decryptString(value: Buffer): string {
    const found = this.values.get(value.toString());
    if (found === undefined) throw new Error("missing secure value");
    return found;
  }
}

function summary(keyEpoch = 1): EncryptedBackupSummary {
  return {
    backupId: BACKUP_ID,
    profileLineageId: "30000000-0000-4000-8000-000000000001",
    parentBackupId: null,
    sourceDeviceId: OTHER_DEVICE_ID,
    sourceInstallationId: "40000000-0000-4000-8000-000000000001",
    sourceDefinitionId: "50000000-0000-4000-8000-000000000001",
    sourceVersionId: "60000000-0000-4000-8000-000000000001",
    state: "sealed" as const,
    keyEpoch,
    chunkCount: 1,
    totalCiphertextSize: 64,
    createdAt: "2026-07-23T12:00:00.000Z",
    sealedAt: "2026-07-23T12:01:00.000Z",
  };
}

function controllerFixture(
  input: {
    listBackups?: ReturnType<typeof vi.fn>;
    listDevices?: ReturnType<typeof vi.fn>;
    agentControl?: AgenteraEncryptedBackupAgentControl;
  } = {},
): {
  controller: AgenteraEncryptedBackupController;
  databases: AgenteraEncryptedBackupDatabase[];
  listBackups: ReturnType<typeof vi.fn>;
  listDevices: ReturnType<typeof vi.fn>;
  registerCurrentDevice: ReturnType<typeof vi.fn>;
  setPrincipal: (value: AgenteraEncryptedBackupPrincipal | null) => void;
} {
  const root = mkdtempSync(join(tmpdir(), "agentera-backup-controller-"));
  roots.push(root);
  let principal: AgenteraEncryptedBackupPrincipal | null = {
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    online: true,
    signDigest: () => Buffer.alloc(64, 0x51).toString("base64url"),
  };
  const databases: AgenteraEncryptedBackupDatabase[] = [];
  const listBackups = input.listBackups ?? vi.fn(async () => []);
  const listDevices = input.listDevices ?? vi.fn(async () => []);
  const registerCurrentDevice = vi.fn(async (registration) => ({
    deviceId: principal!.deviceId,
    keyEpoch: registration.key_epoch,
    revision: registration.revision,
    status: "active" as const,
    replayed: false,
  }));
  const client = {
    listBackups,
    listDevices,
    registerCurrentDevice,
  } as unknown as AgenteraEncryptedBackupClient;
  const controller = new AgenteraEncryptedBackupController({
    userDataPath: join(root, "user-data"),
    secureStorage: new TestSecureStorage(),
    activity: new RuntimeActivityCoordinator(),
    client,
    agentControl:
      input.agentControl ??
      ({
        resolveEncryptedBackupUserSource: vi.fn(),
        verifyImmutableUserBase: vi.fn(),
        activateVerifiedRestore: vi.fn(),
      } as never),
    getPrincipal: () => principal,
    databaseFactory: (userDataPath) => {
      const database = openAgenteraEncryptedBackupDatabase(userDataPath, {
        databaseFactory: (path) =>
          new DatabaseSync(
            path,
          ) as unknown as AgenteraEncryptedBackupSqliteDatabase,
      });
      databases.push(database);
      return database;
    },
  });
  controllers.push(controller);
  return {
    controller,
    databases,
    listBackups,
    listDevices,
    registerCurrentDevice,
    setPrincipal(value: AgenteraEncryptedBackupPrincipal | null) {
      principal = value;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const controller of controllers.splice(0)) controller.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgenteraEncryptedBackupController", () => {
  it("returns the phrase once, emits no phrase event, and closes owner DB state on account switch", async () => {
    const fixture = controllerFixture();
    const progress = vi.fn();
    fixture.controller.subscribe(progress);
    expect(fixture.controller.getState()).toMatchObject({
      available: true,
      initialized: false,
      currentDeviceId: DEVICE_ID,
    });

    const enrollment = await fixture.controller.initializeRecovery();
    expect(enrollment.recoveryPhrase?.split(" ")).toHaveLength(24);
    expect(progress).not.toHaveBeenCalled();
    expect(fixture.controller.confirmRecoverySaved()).toMatchObject({
      initialized: true,
      recoveryConfirmed: true,
    });
    const firstDatabase = fixture.databases[0];

    fixture.setPrincipal({
      accountId: OTHER_ACCOUNT_ID,
      deviceId: OTHER_DEVICE_ID,
      online: true,
      signDigest: () => Buffer.alloc(64, 0x52).toString("base64url"),
    });
    fixture.controller.notifyPrincipalChanged();
    expect(() => firstDatabase.sqlite.prepare("SELECT 1")).toThrow();
    expect(fixture.controller.getState()).toMatchObject({
      initialized: false,
      currentDeviceId: OTHER_DEVICE_ID,
    });
  }, 20_000);

  it("refuses to create an unrelated recovery root when the account already has backup state", async () => {
    const fixture = controllerFixture({
      listBackups: vi.fn(async () => [summary()]),
    });
    await expect(fixture.controller.initializeRecovery()).rejects.toMatchObject(
      {
        code: "existing_backup_recovery_required",
      },
    );
    expect(fixture.controller.getState().initialized).toBe(false);
  });

  it("registers a pending target-device X25519 key without exposing or inventing a local root", async () => {
    const fixture = controllerFixture({
      listBackups: vi.fn(async () => [summary(3)]),
      listDevices: vi.fn(async () => [
        {
          deviceId: DEVICE_ID,
          keyEpoch: 3,
          revision: 1,
          status: "active" as const,
          publicKey: Buffer.alloc(32, 0x53).toString("base64url"),
          registeredAt: "2026-07-23T12:00:00.000Z",
          updatedAt: "2026-07-23T12:00:00.000Z",
          revokedAt: null,
        },
      ]),
    });
    await expect(fixture.controller.registerCurrentDevice()).resolves.toEqual([
      expect.objectContaining({
        deviceId: DEVICE_ID,
        keyEpoch: 3,
        isCurrent: true,
      }),
    ]);
    expect(fixture.controller.getState()).toMatchObject({
      initialized: false,
      keyEpoch: null,
    });
    expect(fixture.registerCurrentDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        key_epoch: 3,
        public_key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        signature: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/),
      }),
    );
    expect(
      JSON.stringify(fixture.registerCurrentDevice.mock.calls),
    ).not.toMatch(/private|root_key|phrase/i);
  });

  it("zeros plaintext and encrypted RuntimeBinding provenance if parent lookup fails", async () => {
    const plaintext = Buffer.from("sensitive-runtime-binding-provenance");
    const encrypted = Buffer.alloc(64, 0x5a);
    vi.spyOn(
      AgenteraEncryptedBackupKeyStore.prototype,
      "encryptRuntimeBindingProvenance",
    ).mockReturnValue(encrypted);
    const cloudFailure = Object.assign(new Error("cloud unavailable"), {
      code: "cloud_unavailable",
    });
    const fixture = controllerFixture({
      listBackups: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(cloudFailure),
      agentControl: {
        resolveEncryptedBackupUserSource: vi.fn(async () => ({
          installationId: INSTALLATION_ID,
          profilePath: "/unused/profile",
          provenance: {
            sourceInstallationId: INSTALLATION_ID,
            sourceDefinitionId: "50000000-0000-4000-8000-000000000001",
            sourceVersionId: "60000000-0000-4000-8000-000000000001",
            baseOwnerScope: "USER" as const,
          },
          runtimeBindingProvenance: plaintext,
        })),
        verifyImmutableUserBase: vi.fn(),
        activateVerifiedRestore: vi.fn(),
      } as never,
    });
    await fixture.controller.initializeRecovery();
    fixture.controller.confirmRecoverySaved();

    await expect(fixture.controller.createBackup(INSTALLATION_ID)).rejects.toBe(
      cloudFailure,
    );
    expect(plaintext.every((value) => value === 0)).toBe(true);
    expect(encrypted.every((value) => value === 0)).toBe(true);
  });
});
