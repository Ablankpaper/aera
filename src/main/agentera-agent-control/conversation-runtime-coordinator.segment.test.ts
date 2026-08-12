// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import { ConversationBoundaryStore } from "./conversation-boundary-store";
import { ConversationRuntimeCoordinator } from "./conversation-runtime-coordinator";
import { ConversationThreadStore } from "./conversation-thread-store";
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
const RUNTIME_IDS = [
  "40000000-0000-4000-8000-000000000001",
  "41000000-0000-4000-8000-000000000001",
  "40000000-0000-4000-8000-000000000002",
  "41000000-0000-4000-8000-000000000002",
];
const BOUNDARY_IDS = [
  "50000000-0000-4000-8000-000000000001",
  "50000000-0000-4000-8000-000000000002",
];
const THREAD_IDS = [
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
];
const NOW = new Date("2026-08-11T11:00:00.000Z");

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function bindingInput(
  conversationKey: string,
  overrides: Partial<CreateLocalRuntimeBindingInput> = {},
): CreateLocalRuntimeBindingInput {
  return {
    conversationKey,
    tenantId: OWNER.tenantId,
    ownerScope: "USER",
    ownerId: OWNER.ownerId,
    deviceId: OWNER.deviceInstallationId,
    agentDefinitionId: "60000000-0000-4000-8000-000000000001",
    agentVersionId: "60000000-0000-4000-8000-000000000002",
    agentInstallationId: "60000000-0000-4000-8000-000000000003",
    runtimeProfileId: "60000000-0000-4000-8000-000000000004",
    runtimeVersion: "v0.18.2-agentera.3",
    modelRoute: {
      provider: "custom:petoi",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.petoi.cn/v1",
      apiMode: "codex_responses",
      sourceProfileId: "account-home",
      modelLibraryId: "petoi-gpt",
      credentialRef: "CUSTOM_PROVIDER_PETOI_KEY",
      legacy: false,
    },
    policySnapshotId: "60000000-0000-4000-8000-000000000005",
    officialReleaseRevisionId: null,
    toolPermissionDigest: "a".repeat(64),
    publishedBaseDigest: "b".repeat(64),
    ...overrides,
  };
}

describe("ConversationRuntimeCoordinator segment lifecycle", () => {
  let root = "";
  let database: AgenteraControlPlaneDatabase;
  let bindingStore: RuntimeBindingStore;
  let boundaryStore: ConversationBoundaryStore;
  let threadStore: ConversationThreadStore;
  let coordinator: ConversationRuntimeCoordinator;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aera-runtime-segment-coordinator-"));
    database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    const runtimeIds = [...RUNTIME_IDS];
    const boundaryIds = [...BOUNDARY_IDS];
    const threadIds = [...THREAD_IDS];
    bindingStore = new RuntimeBindingStore({
      database,
      owner: OWNER,
      now: () => NOW,
      randomUUID: () => runtimeIds.shift() ?? RUNTIME_IDS[3],
    });
    boundaryStore = new ConversationBoundaryStore({
      database,
      owner: OWNER,
      now: () => NOW,
      randomUUID: () => boundaryIds.shift() ?? BOUNDARY_IDS[1],
    });
    threadStore = new ConversationThreadStore({
      database,
      owner: OWNER,
      now: () => NOW,
      randomUUID: () => threadIds.shift() ?? THREAD_IDS[1],
    });
    coordinator = new ConversationRuntimeCoordinator({
      database,
      bindingStore,
      boundaryStore,
      threadStore,
    });
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function seedThread(): {
    threadId: string;
    revision: number;
  } {
    const prepared = coordinator.prepare({
      conversationKey: "visible-root",
      resumeSessionId: null,
      context: { scope: "USER" },
      bindingInput: bindingInput("visible-root", {
        modelRoute: {
          provider: "openai",
          model: "gpt-5.6",
          baseUrl: "",
        },
      }),
    });
    if (prepared.runtimeBinding === null) throw new Error("fixture_binding");
    const adopted = threadStore.adopt({
      rootConversationKey: "visible-root",
      runtimeBindingId: prepared.runtimeBinding.id,
      conversationBoundaryId: prepared.boundary.id,
      hermesSessionId: null,
      modelRoute: prepared.runtimeBinding.modelRoute!,
      historyBoundaryCount: 0,
    });
    return { threadId: adopted.thread.id, revision: adopted.thread.revision };
  }

  function candidateInput(): {
    rootConversationKey: string;
    context: { scope: "USER" };
    bindingInput: CreateLocalRuntimeBindingInput;
    historyBoundaryCount: number;
  } {
    return {
      rootConversationKey: "visible-root",
      context: { scope: "USER" as const },
      bindingInput: bindingInput("renderer-root\0Petoi:gpt-5.6-sol"),
      historyBoundaryCount: 8,
    };
  }

  // @lat: [[agentera-agent-control-plane#Installation and binding#Model policy and runtime selection#Immutable Agent conversation segments#Atomic binding-boundary-segment preparation]]
  it("rolls back thread, segment, binding, and boundary together on candidate failure", () => {
    seedThread();
    const before = {
      threads: database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM conversation_threads")
        .get(),
      segments: database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM conversation_segments")
        .get(),
      bindings: database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM runtime_bindings")
        .get(),
      boundaries: database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM conversation_boundaries")
        .get(),
    };
    database.sqlite.exec(`
      CREATE TRIGGER injected_segment_boundary_failure
      BEFORE INSERT ON conversation_boundaries
      BEGIN
        SELECT RAISE(ABORT, 'injected boundary failure');
      END;
    `);

    expect(() => coordinator.prepareSegment(candidateInput())).toThrow(
      expect.objectContaining({ code: "boundary_conflict" }),
    );
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM conversation_threads")
        .get(),
    ).toEqual(before.threads);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM conversation_segments")
        .get(),
    ).toEqual(before.segments);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM runtime_bindings")
        .get(),
    ).toEqual(before.bindings);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM conversation_boundaries")
        .get(),
    ).toEqual(before.boundaries);
  });

  // @lat: [[agentera-agent-control-plane#Installation and binding#Model policy and runtime selection#Immutable Agent conversation segments#Derived segment key and session attachment]]
  it("derives a safe segment key and attaches one session to all records atomically", () => {
    const seeded = seedThread();
    const prepared = coordinator.prepareSegment(candidateInput());

    expect(prepared.segment.segmentConversationKey).toBe(
      `aera-segment:${seeded.threadId}:${prepared.segment.id}`,
    );
    expect(prepared.segment.segmentConversationKey).not.toContain("renderer");
    expect(prepared.segment.segmentConversationKey).not.toContain("Petoi");
    expect(prepared.segment.segmentConversationKey).not.toContain("\0");
    expect(prepared.runtimeBinding?.conversationKey).toBe(
      prepared.segment.segmentConversationKey,
    );
    expect(prepared.boundary.conversationKey).toBe(
      prepared.segment.segmentConversationKey,
    );

    const attached = coordinator.attachSegmentSession({
      segmentId: prepared.segment.id,
      runtimeBindingId: prepared.runtimeBinding!.id,
      boundaryId: prepared.boundary.id,
      sessionId: "hermes-segment-2",
    });
    expect(attached.segment.hermesSessionId).toBe("hermes-segment-2");
    expect(attached.runtimeBinding?.hermesSessionId).toBe("hermes-segment-2");
    expect(attached.boundary.hermesSessionId).toBe("hermes-segment-2");
  });

  it("leaves every record unattached when boundary session attachment fails", () => {
    seedThread();
    const prepared = coordinator.prepareSegment(candidateInput());
    database.sqlite.exec(`
      CREATE TRIGGER injected_segment_session_failure
      BEFORE UPDATE OF hermes_session_id ON conversation_boundaries
      BEGIN
        SELECT RAISE(ABORT, 'injected boundary session failure');
      END;
    `);

    expect(() =>
      coordinator.attachSegmentSession({
        segmentId: prepared.segment.id,
        runtimeBindingId: prepared.runtimeBinding!.id,
        boundaryId: prepared.boundary.id,
        sessionId: "hermes-segment-2",
      }),
    ).toThrow(expect.objectContaining({ code: "boundary_conflict" }));
    expect(
      bindingStore.getById(prepared.runtimeBinding!.id)?.hermesSessionId,
    ).toBeNull();
    expect(
      boundaryStore.getById(prepared.boundary.id)?.hermesSessionId,
    ).toBeNull();
    expect(
      threadStore.getSegment(prepared.segment.id)?.hermesSessionId,
    ).toBeNull();
  });

  it("activates an attached candidate through the coordinator transaction", () => {
    const seeded = seedThread();
    const prepared = coordinator.prepareSegment(candidateInput());
    coordinator.attachSegmentSession({
      segmentId: prepared.segment.id,
      runtimeBindingId: prepared.runtimeBinding.id,
      boundaryId: prepared.boundary.id,
      sessionId: "hermes-segment-2",
    });

    const activated = coordinator.activateSegment({
      threadId: seeded.threadId,
      segmentId: prepared.segment.id,
      expectedThreadRevision: seeded.revision,
    });

    expect(activated.segment.state).toBe("active");
    expect(activated.thread.activeSegmentId).toBe(prepared.segment.id);
  });

  it("fails a preparing candidate without changing the active segment", () => {
    const seeded = seedThread();
    const prepared = coordinator.prepareSegment(candidateInput());

    const failed = coordinator.failSegment({
      threadId: seeded.threadId,
      segmentId: prepared.segment.id,
      expectedThreadRevision: seeded.revision,
      code: "provider_unavailable",
    });

    expect(failed.segment.state).toBe("failed");
    expect(failed.thread.activeSegmentId).not.toBe(prepared.segment.id);
  });
});
