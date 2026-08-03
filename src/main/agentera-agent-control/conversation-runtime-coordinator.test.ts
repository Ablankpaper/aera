// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import {
  ConversationBoundaryStore,
  ConversationBoundaryStoreError,
} from "./conversation-boundary-store";
import { ConversationRuntimeCoordinator } from "./conversation-runtime-coordinator";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import {
  RuntimeBindingStore,
  type CreateLocalRuntimeBindingInput,
} from "./runtime-binding-store";

const OWNER: AgenteraRuntimeOwner = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  ownerId: "10000000-0000-4000-8000-000000000002",
  deviceInstallationId: "10000000-0000-4000-8000-000000000003",
};
const OTHER_OWNER: AgenteraRuntimeOwner = {
  tenantId: "20000000-0000-4000-8000-000000000001",
  ownerId: "20000000-0000-4000-8000-000000000002",
  deviceInstallationId: OWNER.deviceInstallationId,
};
const ORGANIZATION_ID = "30000000-0000-4000-8000-000000000001";
const BINDING_ID = "40000000-0000-4000-8000-000000000001";
const REVISION_ID = "40000000-0000-4000-8000-000000000002";
const BOUNDARY_ID = "40000000-0000-4000-8000-000000000003";
const OTHER_BINDING_ID = "50000000-0000-4000-8000-000000000001";
const OTHER_REVISION_ID = "50000000-0000-4000-8000-000000000002";
const OTHER_BOUNDARY_ID = "50000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-08-03T08:00:00.000Z");

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function bindingInput(
  owner = OWNER,
  conversationKey = "installed-conversation",
): CreateLocalRuntimeBindingInput {
  return {
    conversationKey,
    tenantId: owner.tenantId,
    ownerScope: "USER",
    ownerId: owner.ownerId,
    deviceId: owner.deviceInstallationId,
    agentDefinitionId: "60000000-0000-4000-8000-000000000001",
    agentVersionId: "60000000-0000-4000-8000-000000000002",
    agentInstallationId: "60000000-0000-4000-8000-000000000003",
    runtimeProfileId: "60000000-0000-4000-8000-000000000004",
    runtimeVersion: "v0.18.2-agentera.3",
    modelRoute: {
      provider: "openai",
      model: "gpt-5.6",
      baseUrl: "https://models.example.test/v1",
    },
    policySnapshotId: "60000000-0000-4000-8000-000000000005",
    officialReleaseRevisionId: null,
    toolPermissionDigest: "a".repeat(64),
    publishedBaseDigest: "b".repeat(64),
  };
}

describe("ConversationRuntimeCoordinator", () => {
  let root = "";
  let database: AgenteraControlPlaneDatabase;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aera-conversation-runtime-"));
    database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function stores(
    owner = OWNER,
    ids = [BINDING_ID, REVISION_ID, BOUNDARY_ID],
  ): {
    bindingStore: RuntimeBindingStore;
    boundaryStore: ConversationBoundaryStore;
    coordinator: ConversationRuntimeCoordinator;
  } {
    const runtimeIds = ids.slice(0, 2);
    const bindingStore = new RuntimeBindingStore({
      database,
      owner,
      now: () => NOW,
      randomUUID: () => runtimeIds.shift() ?? ids[1],
    });
    const boundaryStore = new ConversationBoundaryStore({
      database,
      owner,
      now: () => NOW,
      randomUUID: () => ids[2],
    });
    return {
      bindingStore,
      boundaryStore,
      coordinator: new ConversationRuntimeCoordinator({
        database,
        bindingStore,
        boundaryStore,
      }),
    };
  }

  function prepare(
    coordinator: ConversationRuntimeCoordinator,
  ): ReturnType<ConversationRuntimeCoordinator["prepare"]> {
    return coordinator.prepare({
      conversationKey: "installed-conversation",
      resumeSessionId: null,
      context: {
        scope: "ORGANIZATION" as const,
        organizationId: ORGANIZATION_ID,
        role: "member" as const,
      },
      bindingInput: bindingInput(),
    });
  }

  it("rolls back a new RuntimeBinding and its Cloud record when boundary creation fails", () => {
    database.sqlite.exec(`
      CREATE TRIGGER injected_boundary_insert_failure
      BEFORE INSERT ON conversation_boundaries
      BEGIN
        SELECT RAISE(ABORT, 'injected boundary failure');
      END;
    `);
    const { coordinator } = stores();

    expect(() => prepare(coordinator)).toThrow(
      expect.objectContaining<Partial<ConversationBoundaryStoreError>>({
        code: "boundary_conflict",
      }),
    );
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM runtime_bindings")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM pending_sanitized_records WHERE record_type = 'runtime_binding'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("repairs a binding-only interrupted conversation after cold restart", () => {
    const first = stores();
    const binding =
      first.bindingStore.getOrCreateForConversation(bindingInput());
    expect(
      first.boundaryStore.getByConversationKey(binding.conversationKey),
    ).toBeNull();

    database.close();
    database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    const restarted = stores();
    const repaired = prepare(restarted.coordinator);

    expect(repaired.runtimeBinding).toEqual(binding);
    expect(repaired.boundary).toMatchObject({
      runtimeBindingId: binding.id,
      agentInstallationId: binding.agentInstallationId,
      agentVersionId: binding.agentVersionId,
      runtimeProfileId: binding.runtimeProfileId,
      toolPermissionSnapshot: {
        kind: "AGENT_DIGEST",
        digest: binding.toolPermissionDigest,
      },
    });
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM runtime_bindings")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM conversation_boundaries")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("converges concurrent prepares on one matching binding and boundary", async () => {
    const first = stores();
    const second = stores();
    const [left, right] = await Promise.all([
      Promise.resolve().then(() => prepare(first.coordinator)),
      Promise.resolve().then(() => prepare(second.coordinator)),
    ]);

    expect(right).toEqual(left);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM runtime_bindings")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM conversation_boundaries")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("attaches the Hermes session to both records or neither", () => {
    const current = stores();
    const prepared = prepare(current.coordinator);
    database.sqlite.exec(`
      CREATE TRIGGER injected_boundary_session_failure
      BEFORE UPDATE OF hermes_session_id ON conversation_boundaries
      BEGIN
        SELECT RAISE(ABORT, 'injected boundary session failure');
      END;
    `);

    expect(() =>
      current.coordinator.attachHermesSession({
        runtimeBindingId: prepared.runtimeBinding?.id ?? null,
        boundaryId: prepared.boundary.id,
        sessionId: "hermes-session-1",
      }),
    ).toThrow(
      expect.objectContaining<Partial<ConversationBoundaryStoreError>>({
        code: "boundary_conflict",
      }),
    );
    expect(
      current.bindingStore.getById(BINDING_ID)?.hermesSessionId,
    ).toBeNull();
    expect(
      current.boundaryStore.getById(BOUNDARY_ID)?.hermesSessionId,
    ).toBeNull();

    database.sqlite.exec("DROP TRIGGER injected_boundary_session_failure");
    const attached = current.coordinator.attachHermesSession({
      runtimeBindingId: prepared.runtimeBinding?.id ?? null,
      boundaryId: prepared.boundary.id,
      sessionId: "hermes-session-1",
    });
    expect(attached.runtimeBinding?.hermesSessionId).toBe("hermes-session-1");
    expect(attached.boundary.hermesSessionId).toBe("hermes-session-1");
  });

  it("keeps bindings and boundaries partitioned across owners", () => {
    const first = stores();
    const firstPair = prepare(first.coordinator);
    const other = stores(OTHER_OWNER, [
      OTHER_BINDING_ID,
      OTHER_REVISION_ID,
      OTHER_BOUNDARY_ID,
    ]);
    const otherPair = other.coordinator.prepare({
      conversationKey: "other-conversation",
      resumeSessionId: null,
      context: { scope: "USER" },
      bindingInput: bindingInput(OTHER_OWNER, "other-conversation"),
    });

    expect(
      other.bindingStore.getById(firstPair.runtimeBinding?.id ?? BINDING_ID),
    ).toBeNull();
    expect(other.boundaryStore.getById(firstPair.boundary.id)).toBeNull();
    expect(
      first.bindingStore.getById(
        otherPair.runtimeBinding?.id ?? OTHER_BINDING_ID,
      ),
    ).toBeNull();
    expect(first.boundaryStore.getById(otherPair.boundary.id)).toBeNull();
  });
});
