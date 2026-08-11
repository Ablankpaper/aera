// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import { ConversationBoundaryStore } from "./conversation-boundary-store";
import { ConversationRuntimeCoordinator } from "./conversation-runtime-coordinator";
import {
  ConversationThreadStore,
  ConversationThreadStoreError,
  type AdoptConversationSegmentInput,
  type PrepareConversationSegmentInput,
} from "./conversation-thread-store";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import type { FrozenAgentModelRoute } from "./frozen-agent-model-route";
import {
  RuntimeBindingStore,
  type CreateLocalRuntimeBindingInput,
  type LocalRuntimeBinding,
} from "./runtime-binding-store";

const OWNER: AgenteraRuntimeOwner = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  ownerId: "10000000-0000-4000-8000-000000000002",
  deviceInstallationId: "10000000-0000-4000-8000-000000000003",
};
const OTHER_OWNER: AgenteraRuntimeOwner = {
  tenantId: "20000000-0000-4000-8000-000000000001",
  ownerId: "20000000-0000-4000-8000-000000000002",
  deviceInstallationId: "20000000-0000-4000-8000-000000000003",
};
const THREAD_ID = "30000000-0000-4000-8000-000000000001";
const ACTIVE_SEGMENT_ID = "30000000-0000-4000-8000-000000000002";
const CANDIDATE_SEGMENT_ID = "30000000-0000-4000-8000-000000000003";
const THIRD_SEGMENT_ID = "30000000-0000-4000-8000-000000000004";
const RUNTIME_IDS = [
  "40000000-0000-4000-8000-000000000001",
  "41000000-0000-4000-8000-000000000001",
  "40000000-0000-4000-8000-000000000002",
  "41000000-0000-4000-8000-000000000002",
  "40000000-0000-4000-8000-000000000003",
  "41000000-0000-4000-8000-000000000003",
  "40000000-0000-4000-8000-000000000004",
  "41000000-0000-4000-8000-000000000004",
  "40000000-0000-4000-8000-000000000005",
  "41000000-0000-4000-8000-000000000005",
] as const;
const BOUNDARY_IDS = [
  "50000000-0000-4000-8000-000000000001",
  "50000000-0000-4000-8000-000000000002",
  "50000000-0000-4000-8000-000000000003",
  "50000000-0000-4000-8000-000000000004",
  "50000000-0000-4000-8000-000000000005",
] as const;
const NOW = new Date("2026-08-11T10:00:00.000Z");

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function currentRoute(
  overrides: Partial<FrozenAgentModelRoute> = {},
): FrozenAgentModelRoute {
  return {
    provider: "custom:petoi",
    model: "gpt-5.6-sol",
    baseUrl: "https://api.petoi.cn/v1",
    apiMode: "codex_responses",
    sourceProfileId: "account-home",
    modelLibraryId: "petoi-gpt",
    credentialRef: "CUSTOM_PROVIDER_PETOI_KEY",
    legacy: false,
    ...overrides,
  };
}

function bindingInput(
  owner: AgenteraRuntimeOwner,
  conversationKey: string,
  modelRoute: CreateLocalRuntimeBindingInput["modelRoute"],
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
    modelRoute,
    policySnapshotId: "60000000-0000-4000-8000-000000000005",
    officialReleaseRevisionId: null,
    toolPermissionDigest: "a".repeat(64),
    publishedBaseDigest: "b".repeat(64),
  };
}

interface RuntimePair {
  binding: LocalRuntimeBinding;
  boundaryId: string;
}

describe("owner-scoped conversation thread store", () => {
  let root = "";
  let database: AgenteraControlPlaneDatabase;
  let bindingStore: RuntimeBindingStore;
  let coordinator: ConversationRuntimeCoordinator;
  let store: ConversationThreadStore;
  let runtimeIds: string[];
  let boundaryIds: string[];
  let threadIds: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aera-conversation-thread-"));
    database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    runtimeIds = [...RUNTIME_IDS];
    boundaryIds = [...BOUNDARY_IDS];
    threadIds = [
      THREAD_ID,
      ACTIVE_SEGMENT_ID,
      CANDIDATE_SEGMENT_ID,
      THIRD_SEGMENT_ID,
    ];
    bindingStore = new RuntimeBindingStore({
      database,
      owner: OWNER,
      now: () => NOW,
      randomUUID: () => runtimeIds.shift() ?? RUNTIME_IDS[9],
    });
    const boundaryStore = new ConversationBoundaryStore({
      database,
      owner: OWNER,
      now: () => NOW,
      randomUUID: () => boundaryIds.shift() ?? BOUNDARY_IDS[2],
    });
    coordinator = new ConversationRuntimeCoordinator({
      database,
      bindingStore,
      boundaryStore,
    });
    store = new ConversationThreadStore({
      database,
      owner: OWNER,
      now: () => NOW,
      randomUUID: () => threadIds.shift() ?? THIRD_SEGMENT_ID,
    });
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function runtimePair(
    conversationKey: string,
    route: CreateLocalRuntimeBindingInput["modelRoute"],
    sessionId: string | null = null,
  ): RuntimePair {
    const prepared = coordinator.prepare({
      conversationKey,
      resumeSessionId: null,
      context: { scope: "USER" },
      bindingInput: bindingInput(OWNER, conversationKey, route),
    });
    if (prepared.runtimeBinding === null) throw new Error("fixture_binding");
    if (sessionId === null) {
      return {
        binding: prepared.runtimeBinding,
        boundaryId: prepared.boundary.id,
      };
    }
    const attached = coordinator.attachHermesSession({
      runtimeBindingId: prepared.runtimeBinding.id,
      boundaryId: prepared.boundary.id,
      sessionId,
    });
    if (attached.runtimeBinding === null) throw new Error("fixture_binding");
    return {
      binding: attached.runtimeBinding,
      boundaryId: attached.boundary.id,
    };
  }

  function adoption(): AdoptConversationSegmentInput {
    const pair = runtimePair(
      "visible-thread",
      { provider: "openai", model: "gpt-5.6", baseUrl: "" },
      "hermes-old",
    );
    if (pair.binding.modelRoute === null) throw new Error("fixture_route");
    return {
      rootConversationKey: "visible-thread",
      runtimeBindingId: pair.binding.id,
      conversationBoundaryId: pair.boundaryId,
      hermesSessionId: "hermes-old",
      modelRoute: pair.binding.modelRoute,
      historyBoundaryCount: 0,
    };
  }

  function candidateInput(
    threadId: string,
    expectedThreadRevision: number,
    ordinal = 2,
    conversationKey = "aera-segment:candidate-2",
  ): PrepareConversationSegmentInput {
    const pair = runtimePair(conversationKey, currentRoute());
    if (pair.binding.modelRoute === null) throw new Error("fixture_route");
    return {
      threadId,
      expectedThreadRevision,
      ordinal,
      segmentConversationKey: conversationKey,
      runtimeBindingId: pair.binding.id,
      conversationBoundaryId: pair.boundaryId,
      modelRoute: pair.binding.modelRoute,
      historyBoundaryCount: 8,
    };
  }

  // @lat: [[agentera-agent-control-plane#Installation and binding#Model policy and runtime selection#Immutable Agent conversation segments#Candidate lifecycle and CAS activation]]
  it("prepares a candidate without replacing the active segment", () => {
    const active = store.adopt(adoption());
    const candidate = store.prepareCandidate(
      candidateInput(active.thread.id, active.thread.revision),
    );

    expect(candidate.segment.state).toBe("preparing");
    expect(store.getThread(active.thread.id)?.activeSegmentId).toBe(
      active.segment.id,
    );
    expect(candidate.thread.revision).toBe(active.thread.revision);
  });

  it("activates once with CAS and supersedes the old immutable segment", () => {
    const { thread, segment: oldSegment } = store.adopt(adoption());
    const candidate = store.prepareCandidate(
      candidateInput(thread.id, thread.revision),
    );
    coordinator.attachHermesSession({
      runtimeBindingId: candidate.segment.runtimeBindingId,
      boundaryId: candidate.segment.conversationBoundaryId,
      sessionId: "hermes-new",
    });
    store.attachSession(candidate.segment.id, "hermes-new");

    const activated = store.activate({
      threadId: thread.id,
      segmentId: candidate.segment.id,
      expectedThreadRevision: thread.revision,
    });

    expect(activated.segment.state).toBe("active");
    expect(activated.thread.revision).toBe(thread.revision + 1);
    expect(store.getSegment(oldSegment.id)?.state).toBe("superseded");
    expect(() =>
      store.activate({
        threadId: thread.id,
        segmentId: candidate.segment.id,
        expectedThreadRevision: thread.revision,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ConversationThreadStoreError>>({
        code: "model_switch_segment_conflict",
      }),
    );
  });

  // @lat: [[agentera-agent-control-plane#Installation and binding#Model policy and runtime selection#Immutable Agent conversation segments#Owner-scoped thread adoption]]
  it("keeps every read and mutation scoped to the exact owner and device", () => {
    const adopted = store.adopt(adoption());
    const other = new ConversationThreadStore({
      database,
      owner: OTHER_OWNER,
      now: () => NOW,
    });

    expect(other.getThread(adopted.thread.id)).toBeNull();
    expect(other.getSegment(adopted.segment.id)).toBeNull();
    expect(other.getByRootConversationKey("visible-thread")).toBeNull();
    expect(other.getByHermesSessionId("hermes-old")).toBeNull();
    expect(() =>
      other.fail({
        threadId: adopted.thread.id,
        segmentId: adopted.segment.id,
        expectedThreadRevision: adopted.thread.revision,
        code: "provider_unavailable",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ConversationThreadStoreError>>({
        code: "model_switch_segment_conflict",
      }),
    );
  });

  // @lat: [[agentera-agent-control-plane#Installation and binding#Model policy and runtime selection#Immutable Agent conversation segments#Public route projection]]
  it("looks up any Hermes segment while returning only a public route", () => {
    const adopted = store.adopt(adoption());
    const snapshot = store.getByHermesSessionId("hermes-old");

    expect(snapshot).toEqual(adopted);
    expect(snapshot?.segment.route).toEqual({
      provider: "openai",
      model: "gpt-5.6",
      baseUrl: "",
      apiMode: null,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /credentialRef|CUSTOM_PROVIDER|route_json|routeJson/,
    );
  });

  // @lat: [[agentera-agent-control-plane#Installation and binding#Model policy and runtime selection#Immutable Agent conversation segments#Corrupt row fail-closed]]
  it("parses the frozen route on every read and rejects corrupt rows", () => {
    const adopted = store.adopt(adoption());
    database.sqlite
      .prepare("UPDATE conversation_segments SET route_json = ? WHERE id = ?")
      .run(
        JSON.stringify({
          provider: "openai",
          model: "gpt-5.6",
          baseUrl: "https://user:secret@example.test/v1",
        }),
        adopted.segment.id,
      );

    expect(() => store.getSegment(adopted.segment.id)).toThrowError(
      expect.objectContaining<Partial<ConversationThreadStoreError>>({
        code: "model_switch_segment_corrupt",
      }),
    );
  });

  // @lat: [[agentera-agent-control-plane#Installation and binding#Model policy and runtime selection#Immutable Agent conversation segments#Failure retention and owner-safe lookup]]
  it("retains a failed candidate without changing the active segment", () => {
    const active = store.adopt(adoption());
    const candidate = store.prepareCandidate(
      candidateInput(active.thread.id, active.thread.revision),
    );

    const failed = store.fail({
      threadId: active.thread.id,
      segmentId: candidate.segment.id,
      expectedThreadRevision: active.thread.revision,
      code: "provider_unavailable",
    });

    expect(failed.segment).toMatchObject({
      state: "failed",
      failureCode: "provider_unavailable",
      failedAt: NOW.toISOString(),
    });
    expect(failed.thread.activeSegmentId).toBe(active.segment.id);
    expect(
      store.listSegments(active.thread.id).map((row) => row.state),
    ).toEqual(["active", "failed"]);
  });

  it("rejects duplicate ordinals, sessions, and legacy candidate routes", () => {
    const active = store.adopt(adoption());
    const candidate = store.prepareCandidate(
      candidateInput(active.thread.id, active.thread.revision),
    );
    store.fail({
      threadId: active.thread.id,
      segmentId: candidate.segment.id,
      expectedThreadRevision: active.thread.revision,
      code: "provider_unavailable",
    });

    expect(() =>
      store.prepareCandidate(
        candidateInput(
          active.thread.id,
          active.thread.revision,
          2,
          "aera-segment:duplicate-ordinal",
        ),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ConversationThreadStoreError>>({
        code: "model_switch_segment_conflict",
      }),
    );

    const legacyPair = runtimePair("aera-segment:legacy", {
      provider: "openai",
      model: "gpt-5.6",
      baseUrl: "",
    });
    if (legacyPair.binding.modelRoute === null)
      throw new Error("fixture_route");
    const legacyRoute = legacyPair.binding.modelRoute;
    expect(() =>
      store.prepareCandidate({
        threadId: active.thread.id,
        expectedThreadRevision: active.thread.revision,
        ordinal: 3,
        segmentConversationKey: "aera-segment:legacy",
        runtimeBindingId: legacyPair.binding.id,
        conversationBoundaryId: legacyPair.boundaryId,
        modelRoute: legacyRoute,
        historyBoundaryCount: 8,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ConversationThreadStoreError>>({
        code: "model_switch_segment_conflict",
      }),
    );

    const duplicateSession = database.sqlite.prepare(
      `INSERT INTO conversation_segments (
         id, thread_id, ordinal, segment_conversation_key, state,
         route_json, source_profile_id, source_model_id,
         runtime_binding_id, conversation_boundary_id, hermes_session_id,
         history_boundary_count, created_at, activated_at,
         failed_at, failure_code
       )
       SELECT ?, thread_id, 3, ?, 'failed', route_json,
              source_profile_id, source_model_id,
              runtime_binding_id, conversation_boundary_id, hermes_session_id,
              history_boundary_count, created_at, NULL, ?, 'fixture_failure'
       FROM conversation_segments WHERE id = ?`,
    );
    expect(() =>
      duplicateSession.run(
        THIRD_SEGMENT_ID,
        "aera-segment:duplicate-session",
        NOW.toISOString(),
        active.segment.id,
      ),
    ).toThrow();
  });

  it("adopts the same root key idempotently without duplicating rows", () => {
    const input = adoption();
    const first = store.adopt(input);
    const again = store.adopt(input);

    expect(again).toEqual(first);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM conversation_threads")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM conversation_segments")
        .get(),
    ).toEqual({ count: 1 });
  });
});
