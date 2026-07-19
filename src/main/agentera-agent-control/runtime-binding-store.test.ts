// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import {
  RuntimeBindingStore,
  RuntimeBindingStoreError,
  type CreateLocalRuntimeBindingInput,
  type RuntimeBindingRecordClient,
} from "./runtime-binding-store";

const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const ADAPTIVE_REVISION = "22222222-2222-4222-8222-222222222222";
const TENANT_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";
const DEVICE_ID = "55555555-5555-4555-8555-555555555555";
const DEFINITION_ID = "66666666-6666-4666-8666-666666666666";
const VERSION_ID = "77777777-7777-4777-8777-777777777777";
const INSTALLATION_ID = "88888888-8888-4888-8888-888888888888";
const RUNTIME_PROFILE_ID = "99999999-9999-4999-8999-999999999999";
const POLICY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOOL_DIGEST = "ab".repeat(32);
const BASE_DIGEST = "cd".repeat(32);
const NOW = new Date("2026-07-19T20:30:00.000Z");

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function bindingInput(
  overrides: Partial<CreateLocalRuntimeBindingInput> = {},
): CreateLocalRuntimeBindingInput {
  return {
    conversationKey: "run-conversation-1",
    tenantId: TENANT_ID,
    ownerScope: "USER",
    ownerId: OWNER_ID,
    deviceId: DEVICE_ID,
    agentDefinitionId: DEFINITION_ID,
    agentVersionId: VERSION_ID,
    agentInstallationId: INSTALLATION_ID,
    runtimeProfileId: RUNTIME_PROFILE_ID,
    runtimeVersion: "v0.18.2-agentera.1",
    policySnapshotId: POLICY_ID,
    toolPermissionDigest: TOOL_DIGEST,
    publishedBaseDigest: BASE_DIGEST,
    ...overrides,
  };
}

describe("immutable local RuntimeBinding store", () => {
  let root = "";
  let database: AgenteraControlPlaneDatabase;
  let store: RuntimeBindingStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-runtime-binding-"));
    database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    const generated = [BINDING_ID, ADAPTIVE_REVISION];
    store = new RuntimeBindingStore({
      database,
      now: () => NOW,
      randomUUID: () => generated.shift() ?? ADAPTIVE_REVISION,
    });
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates one complete immutable binding offline and queues only a sanitized cloud record", () => {
    const binding = store.getOrCreateForConversation(bindingInput());

    expect(binding).toEqual({
      id: BINDING_ID,
      conversationKey: "run-conversation-1",
      hermesSessionId: null,
      tenantId: TENANT_ID,
      ownerScope: "USER",
      ownerId: OWNER_ID,
      deviceId: DEVICE_ID,
      agentDefinitionId: DEFINITION_ID,
      agentVersionId: VERSION_ID,
      agentInstallationId: INSTALLATION_ID,
      runtimeProfileId: RUNTIME_PROFILE_ID,
      runtimeVersion: "v0.18.2-agentera.1",
      policySnapshotId: POLICY_ID,
      toolPermissionDigest: TOOL_DIGEST,
      publishedBaseDigest: BASE_DIGEST,
      localAdaptiveStateRevision: ADAPTIVE_REVISION,
      createdAt: NOW.toISOString(),
    });
    expect(binding.localAdaptiveStateRevision).toMatch(/^[0-9a-f-]{36}$/);
    expect(binding.localAdaptiveStateRevision).not.toBe(BASE_DIGEST);

    const pending = store.listPendingCloudRecords();
    expect(pending).toEqual([
      {
        id: BINDING_ID,
        body: {
          binding_id: BINDING_ID,
          agent_installation_id: INSTALLATION_ID,
          agent_version_id: VERSION_ID,
          runtime_profile_id: RUNTIME_PROFILE_ID,
          runtime_version: "v0.18.2-agentera.1",
          policy_snapshot_id: POLICY_ID,
          tool_permission_digest: TOOL_DIGEST,
        },
        attemptCount: 0,
        nextAttemptAt: null,
      },
    ]);
    const serialized = JSON.stringify(pending);
    for (const forbidden of [
      TENANT_ID,
      OWNER_ID,
      DEVICE_ID,
      ADAPTIVE_REVISION,
      BASE_DIGEST,
      "conversationKey",
      "hermesSessionId",
      "profilePath",
      "instructions",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("is idempotent by renderer runId and rejects any immutable-field drift", () => {
    const first = store.getOrCreateForConversation(bindingInput());
    const again = store.getOrCreateForConversation(bindingInput());
    expect(again).toEqual(first);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM runtime_bindings")
        .get(),
    ).toEqual({ count: 1 });

    expect(() =>
      store.getOrCreateForConversation(
        bindingInput({ runtimeVersion: "v0.18.3-agentera.1" }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeBindingStoreError>>({
        code: "binding_conflict",
      }),
    );
  });

  it("attaches the real Hermes session once and resolves both new turns and resumes", () => {
    const created = store.getOrCreateForConversation(bindingInput());
    const attached = store.attachHermesSession(
      created.id,
      "desk-session-original",
    );
    expect(attached.hermesSessionId).toBe("desk-session-original");
    expect(
      store.attachHermesSession(created.id, "desk-session-original"),
    ).toEqual(attached);
    expect(store.getByConversationKey("run-conversation-1")).toEqual(attached);
    expect(store.getByHermesSessionId("desk-session-original")).toEqual(
      attached,
    );
    expect(
      store.resolveInstalledResume(
        "run-conversation-1",
        "desk-session-original",
      ),
    ).toEqual(attached);

    expect(() =>
      store.attachHermesSession(created.id, "desk-session-replacement"),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeBindingStoreError>>({
        code: "binding_conflict",
      }),
    );
  });

  it("rejects an installed-Agent resume when the original binding is absent", () => {
    expect(() =>
      store.resolveInstalledResume(
        "run-conversation-unknown",
        "desk-session-unknown",
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeBindingStoreError>>({
        code: "binding_required",
      }),
    );
  });

  it("keeps failed cloud delivery retryable without throwing and deletes only acknowledged records", async () => {
    store.getOrCreateForConversation(bindingInput());
    const recordRuntimeBinding = vi
      .fn<RuntimeBindingRecordClient["recordRuntimeBinding"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({});
    const client: RuntimeBindingRecordClient = { recordRuntimeBinding };

    await expect(store.retryPendingCloudRecords(client)).resolves.toEqual({
      delivered: 0,
      failed: 1,
    });
    expect(store.listPendingCloudRecords()[0]).toMatchObject({
      attemptCount: 1,
    });
    expect(recordRuntimeBinding).toHaveBeenLastCalledWith(
      store.listPendingCloudRecords()[0].body,
      BINDING_ID,
    );

    await expect(store.retryPendingCloudRecords(client)).resolves.toEqual({
      delivered: 1,
      failed: 0,
    });
    expect(store.listPendingCloudRecords()).toEqual([]);
  });
});
