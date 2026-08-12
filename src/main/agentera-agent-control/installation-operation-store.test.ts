// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import {
  InstallationOperationStore,
  InstallationOperationStoreError,
  parseBeta26PersistedRuntimeModelSelection,
  type InstallationOperationRecord,
} from "./installation-operation-store";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_OPERATION_ID = "12121212-1212-4212-8212-121212121212";
const INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_INSTALLATION_ID = "23232323-2323-4232-8232-232323232323";
const RUNTIME_PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-03T08:00:00.000Z");

const owner: AgenteraRuntimeOwner = {
  tenantId: "44444444-4444-4444-8444-444444444444",
  ownerId: "55555555-5555-4555-8555-555555555555",
  deviceInstallationId: "66666666-6666-4666-8666-666666666666",
};
const otherOwner: AgenteraRuntimeOwner = {
  tenantId: "77777777-7777-4777-8777-777777777777",
  ownerId: "88888888-8888-4888-8888-888888888888",
  deviceInstallationId: owner.deviceInstallationId,
};

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

describe("durable Agent Installation operation journal", () => {
  let root = "";
  let userDataPath = "";
  let database: AgenteraControlPlaneDatabase;
  let store: InstallationOperationStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-install-operation-"));
    userDataPath = join(root, "user-data");
    database = openAgenteraControlPlaneDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    store = new InstallationOperationStore({
      database,
      owner,
      now: () => NOW,
    });
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  // @lat: [[provider-setup#Owner-scoped model route catalog]]
  it("parses Beta.26 persisted model handles only for recovery migration", () => {
    expect(
      parseBeta26PersistedRuntimeModelSelection(
        "model-source",
        "custom:model-one",
      ),
    ).toEqual({
      sourceProfileId: "model-source",
      modelLibraryId: "custom:model-one",
    });
    expect(() =>
      parseBeta26PersistedRuntimeModelSelection("../foreign", "model-one"),
    ).toThrow(
      expect.objectContaining<Partial<InstallationOperationStoreError>>({
        code: "operation_corrupt",
      }),
    );
  });

  function beginFresh(): InstallationOperationRecord {
    return store.begin({
      operationId: OPERATION_ID,
      agentInstallationId: INSTALLATION_ID,
      target: {
        kind: "fresh" as const,
        profileId: "fresh-agent",
        displayName: "Fresh Agent",
        modelSourceProfileId: "model-source",
        modelSourceModelId: "custom:model-one",
      },
    });
  }

  it("restores a legacy fresh target that selects a source Profile without a model handle", () => {
    const prepared = store.begin({
      operationId: OTHER_OPERATION_ID,
      agentInstallationId: OTHER_INSTALLATION_ID,
      target: {
        kind: "fresh",
        profileId: "legacy-agent",
        displayName: "Legacy Agent",
        modelSourceProfileId: "model-source",
      },
    });

    expect(prepared).toMatchObject({
      operationId: OTHER_OPERATION_ID,
      modelSourceProfileId: "model-source",
      modelSourceModelId: null,
      phase: "prepared",
    });
    expect(store.get(OTHER_OPERATION_ID)).toEqual(prepared);
  });

  it("begins idempotently and rejects immutable operation or target drift", () => {
    const first = beginFresh();
    expect(first).toEqual({
      operationId: OPERATION_ID,
      tenantId: owner.tenantId,
      ownerId: owner.ownerId,
      deviceInstallationId: owner.deviceInstallationId,
      agentInstallationId: INSTALLATION_ID,
      targetKind: "fresh",
      profileId: "fresh-agent",
      displayName: "Fresh Agent",
      modelSourceProfileId: "model-source",
      modelSourceModelId: "custom:model-one",
      runtimeProfileId: null,
      phase: "prepared",
      retryCode: null,
      revision: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(beginFresh()).toEqual(first);

    expect(() =>
      store.begin({
        operationId: OPERATION_ID,
        agentInstallationId: INSTALLATION_ID,
        target: {
          kind: "fresh",
          profileId: "different-profile",
          displayName: "Fresh Agent",
          modelSourceProfileId: "model-source",
          modelSourceModelId: "custom:model-one",
        },
      }),
    ).toThrow(
      expect.objectContaining<Partial<InstallationOperationStoreError>>({
        code: "operation_conflict",
      }),
    );
    expect(() =>
      store.begin({
        operationId: OTHER_OPERATION_ID,
        agentInstallationId: INSTALLATION_ID,
        target: {
          kind: "claim",
          profileId: "claimed-profile",
        },
      }),
    ).toThrow(
      expect.objectContaining<Partial<InstallationOperationStoreError>>({
        code: "operation_conflict",
      }),
    );
  });

  it("partitions lookup and unique Installation ownership by exact owner and device", () => {
    const first = beginFresh();
    const foreign = new InstallationOperationStore({
      database,
      owner: otherOwner,
      now: () => NOW,
    });

    expect(store.get(OPERATION_ID)).toEqual(first);
    expect(foreign.get(OPERATION_ID)).toBeNull();
    expect(foreign.listIncomplete()).toEqual([]);
    expect(() =>
      foreign.begin({
        operationId: OPERATION_ID,
        agentInstallationId: INSTALLATION_ID,
        target: { kind: "claim", profileId: "foreign-profile" },
      }),
    ).toThrow(
      expect.objectContaining<Partial<InstallationOperationStoreError>>({
        code: "operation_conflict",
      }),
    );
  });

  it("uses revision CAS and restores the same operation after reopening SQLite", () => {
    const prepared = beginFresh();
    const bound = store.advance({
      operationId: OPERATION_ID,
      expectedRevision: prepared.revision,
      phase: "profile_bound",
      runtimeProfileId: RUNTIME_PROFILE_ID,
    });
    expect(bound).toMatchObject({
      phase: "profile_bound",
      runtimeProfileId: RUNTIME_PROFILE_ID,
      revision: 2,
    });
    expect(() =>
      store.advance({
        operationId: OPERATION_ID,
        expectedRevision: prepared.revision,
        phase: "profile_bound",
        runtimeProfileId: RUNTIME_PROFILE_ID,
      }),
    ).toThrow(
      expect.objectContaining<Partial<InstallationOperationStoreError>>({
        code: "revision_conflict",
      }),
    );

    database.close();
    database = openAgenteraControlPlaneDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    store = new InstallationOperationStore({
      database,
      owner,
      now: () => NOW,
    });
    expect(store.get(OPERATION_ID)).toEqual(bound);
    expect(store.listIncomplete()).toEqual([bound]);
  });

  it("advances in order and keeps committed operations terminal", () => {
    let operation = beginFresh();
    operation = store.advance({
      operationId: OPERATION_ID,
      expectedRevision: operation.revision,
      phase: "profile_bound",
      runtimeProfileId: RUNTIME_PROFILE_ID,
    });
    for (const phase of [
      "profile_attached",
      "projection_active",
      "cloud_activated",
    ] as const) {
      operation = store.advance({
        operationId: OPERATION_ID,
        expectedRevision: operation.revision,
        phase,
        runtimeProfileId: RUNTIME_PROFILE_ID,
      });
    }
    const committed = store.commit({
      operationId: OPERATION_ID,
      expectedRevision: operation.revision,
    });

    expect(committed).toMatchObject({
      phase: "committed",
      runtimeProfileId: RUNTIME_PROFILE_ID,
      revision: 6,
      retryCode: null,
    });
    expect(
      store.commit({
        operationId: OPERATION_ID,
        expectedRevision: operation.revision,
      }),
    ).toEqual(committed);
    expect(store.listIncomplete()).toEqual([]);
    expect(() =>
      store.advance({
        operationId: OPERATION_ID,
        expectedRevision: committed.revision,
        phase: "cloud_activated",
        runtimeProfileId: RUNTIME_PROFILE_ID,
      }),
    ).toThrow(
      expect.objectContaining<Partial<InstallationOperationStoreError>>({
        code: "operation_conflict",
      }),
    );
  });

  it("marks a failed phase for bounded repair without losing owner state", () => {
    const prepared = beginFresh();
    const repair = store.markRepairRequired({
      operationId: OPERATION_ID,
      expectedRevision: prepared.revision,
      retryCode: "profile_binding_conflict",
    });

    expect(repair).toMatchObject({
      phase: "repair_required",
      retryCode: "profile_binding_conflict",
      revision: 2,
      runtimeProfileId: null,
    });
    expect(store.listIncomplete()).toEqual([repair]);
    expect(() =>
      store.advance({
        operationId: OPERATION_ID,
        expectedRevision: repair.revision,
        phase: "profile_bound",
        runtimeProfileId: RUNTIME_PROFILE_ID,
      }),
    ).toThrow(
      expect.objectContaining<Partial<InstallationOperationStoreError>>({
        code: "operation_conflict",
      }),
    );
  });

  it("stores only bounded identifiers and rejects invalid raw target or phase state", () => {
    store.begin({
      operationId: OPERATION_ID,
      agentInstallationId: INSTALLATION_ID,
      target: { kind: "claim", profileId: "claimed-profile" },
    });
    const columns = database.sqlite
      .prepare("PRAGMA table_info(installation_operations)")
      .all()
      .map((column) => (column as { name: string }).name);
    expect(columns).toEqual([
      "operation_id",
      "tenant_id",
      "owner_id",
      "device_installation_id",
      "agent_installation_id",
      "target_kind",
      "target_profile_id",
      "display_name",
      "model_source_profile_id",
      "model_source_model_id",
      "runtime_profile_id",
      "phase",
      "retry_code",
      "revision",
      "created_at",
      "updated_at",
    ]);
    expect(columns.join(" ")).not.toMatch(/path|credential|token|secret|json/i);
    expect(() =>
      database.sqlite
        .prepare(
          `INSERT INTO installation_operations (
             operation_id, tenant_id, owner_id, device_installation_id,
             agent_installation_id, target_kind, target_profile_id,
             phase, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'fresh', 'invalid-fresh',
             'prepared', 1, ?, ?)`,
        )
        .run(
          OTHER_OPERATION_ID,
          owner.tenantId,
          owner.ownerId,
          owner.deviceInstallationId,
          OTHER_INSTALLATION_ID,
          NOW.toISOString(),
          NOW.toISOString(),
        ),
    ).toThrow();
    expect(() =>
      database.sqlite
        .prepare(
          `UPDATE installation_operations
           SET phase = 'unknown_phase'
           WHERE operation_id = ?`,
        )
        .run(OPERATION_ID),
    ).toThrow();
  });
});
