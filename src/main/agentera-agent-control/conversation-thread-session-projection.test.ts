// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type { SessionSummary } from "../sessions";
import type { PublicModelRouteIdentity } from "../../shared/model-configuration";
import { ConversationBoundaryStore } from "./conversation-boundary-store";
import { ConversationRuntimeCoordinator } from "./conversation-runtime-coordinator";
import { ConversationThreadStore } from "./conversation-thread-store";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import type { FrozenAgentModelRoute } from "./frozen-agent-model-route";
import {
  RuntimeBindingStore,
  type CreateLocalRuntimeBindingInput,
} from "./runtime-binding-store";
import {
  ConversationThreadSessionProjection,
  projectSessionSummaries,
  type ConversationThreadProjectionRecord,
} from "./conversation-thread-session-projection";

const THREAD_ID = "10000000-0000-4000-8000-000000000001";
const OWNER: AgenteraRuntimeOwner = {
  tenantId: "20000000-0000-4000-8000-000000000001",
  ownerId: "20000000-0000-4000-8000-000000000002",
  deviceInstallationId: "20000000-0000-4000-8000-000000000003",
};

function route(provider: string, model: string): PublicModelRouteIdentity {
  return {
    provider,
    model,
    baseUrl: `https://${provider.replace(/[^a-z0-9]/gi, "-")}.example/v1`,
    apiMode: "responses",
  };
}

function threadWithSegments(): ConversationThreadProjectionRecord {
  return {
    threadId: THREAD_ID,
    activeSegmentId: "segment-3",
    segments: [
      {
        segmentId: "segment-1",
        ordinal: 1,
        state: "superseded",
        hermesSessionId: "s1",
        route: route("openai", "gpt-5.6"),
        historyBoundaryCount: 0,
      },
      {
        segmentId: "segment-2",
        ordinal: 2,
        state: "superseded",
        hermesSessionId: "s2",
        route: route("custom:petoi", "gpt-5.6-sol"),
        historyBoundaryCount: 2,
      },
      {
        segmentId: "segment-3",
        ordinal: 3,
        state: "active",
        hermesSessionId: "s3",
        route: route("anthropic", "claude-sonnet-4-5"),
        historyBoundaryCount: 4,
      },
      {
        segmentId: "segment-failed",
        ordinal: 4,
        state: "failed",
        hermesSessionId: "s-failed",
        route: route("custom:offline", "offline-model"),
        historyBoundaryCount: 6,
      },
    ],
  };
}

function session(
  id: string,
  startedAt: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    source: "api",
    startedAt,
    endedAt: null,
    messageCount: startedAt,
    model: `model-${id}`,
    title: `title-${id}`,
    preview: `preview-${id}`,
    ...overrides,
  };
}

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function frozenRoute(
  provider: string,
  model: string,
  sourceModelId: string,
): FrozenAgentModelRoute {
  return {
    ...route(provider, model),
    sourceProfileId: "account-home",
    modelLibraryId: sourceModelId,
    credentialRef: "MODEL_API_KEY",
    legacy: false,
  };
}

function bindingInput(
  conversationKey: string,
  modelRoute: FrozenAgentModelRoute,
): CreateLocalRuntimeBindingInput {
  return {
    conversationKey,
    tenantId: OWNER.tenantId,
    ownerScope: "USER",
    ownerId: OWNER.ownerId,
    deviceId: OWNER.deviceInstallationId,
    agentDefinitionId: "30000000-0000-4000-8000-000000000001",
    agentVersionId: "30000000-0000-4000-8000-000000000002",
    agentInstallationId: "30000000-0000-4000-8000-000000000003",
    runtimeProfileId: "30000000-0000-4000-8000-000000000004",
    runtimeVersion: "v0.18.2-agentera.3",
    modelRoute,
    policySnapshotId: "30000000-0000-4000-8000-000000000005",
    officialReleaseRevisionId: null,
    toolPermissionDigest: "a".repeat(64),
    publishedBaseDigest: "b".repeat(64),
  };
}

describe("conversation thread session projection", () => {
  it("collapses Hermes segments into the active visible thread and hides failed candidates", () => {
    const projected = projectSessionSummaries({
      sessions: [
        session("ordinary", 50),
        session("s1", 10),
        session("s2", 20),
        session("s3", 30, { title: "Latest thread title" }),
        session("s-failed", 40),
      ],
      threads: [threadWithSegments()],
    });

    expect(projected.map((item) => item.id)).toEqual(["ordinary", "s3"]);
    expect(projected[1]).toMatchObject({
      id: "s3",
      threadId: THREAD_ID,
      segmentCount: 3,
      title: "Latest thread title",
      model: "claude-sonnet-4-5",
    });
  });

  it("resolves any segment to the active session and all activated markers", () => {
    const projection = new ConversationThreadSessionProjection([
      threadWithSegments(),
    ]);

    expect(projection.resolveResume("s1")).toEqual({
      activeSessionId: "s3",
      threadId: THREAD_ID,
      markers: [
        {
          threadId: THREAD_ID,
          segmentId: "segment-2",
          from: route("openai", "gpt-5.6"),
          to: route("custom:petoi", "gpt-5.6-sol"),
          historyBoundaryCount: 2,
        },
        {
          threadId: THREAD_ID,
          segmentId: "segment-3",
          from: route("custom:petoi", "gpt-5.6-sol"),
          to: route("anthropic", "claude-sonnet-4-5"),
          historyBoundaryCount: 4,
        },
      ],
    });
    expect(projection.resolveResume("s-failed")?.activeSessionId).toBe("s3");
    expect(projection.resolveResume("ordinary")).toBeNull();
  });

  it("expands one visible delete into every attached segment session", () => {
    const projection = new ConversationThreadSessionProjection([
      threadWithSegments(),
    ]);

    expect(projection.expandDelete("s3")).toEqual([
      "s1",
      "s2",
      "s3",
      "s-failed",
    ]);
    expect(projection.expandDeletes(["s1", "ordinary", "s3"])).toEqual([
      "s1",
      "s2",
      "s3",
      "s-failed",
      "ordinary",
    ]);
  });

  it("leaves segment summaries visible when active session metadata is missing", () => {
    const projected = projectSessionSummaries({
      sessions: [session("s1", 10), session("s2", 20)],
      threads: [threadWithSegments()],
    });

    expect(projected.map((item) => item.id)).toEqual(["s2", "s1"]);
  });

  it("reconstructs an owner-scoped active projection after closing and reopening the control database", () => {
    const root = mkdtempSync(join(tmpdir(), "aera-thread-projection-"));
    const userData = join(root, "user-data");
    let database: AgenteraControlPlaneDatabase | null = null;
    try {
      database = openAgenteraControlPlaneDatabase(userData, {
        databaseFactory: nodeSqliteFactory,
      });
      const bindingIds = [
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
        "40000000-0000-4000-8000-000000000003",
      ];
      const outboxIds = [
        "41000000-0000-4000-8000-000000000001",
        "41000000-0000-4000-8000-000000000002",
        "41000000-0000-4000-8000-000000000003",
      ];
      const boundaryIds = [
        "50000000-0000-4000-8000-000000000001",
        "50000000-0000-4000-8000-000000000002",
        "50000000-0000-4000-8000-000000000003",
      ];
      const segmentIds = [
        "60000000-0000-4000-8000-000000000001",
        "60000000-0000-4000-8000-000000000002",
        "60000000-0000-4000-8000-000000000003",
        "60000000-0000-4000-8000-000000000004",
      ];
      const bindingStore = new RuntimeBindingStore({
        database,
        owner: OWNER,
        randomUUID: () => bindingIds.shift() ?? outboxIds.shift()!,
      });
      const boundaryStore = new ConversationBoundaryStore({
        database,
        owner: OWNER,
        randomUUID: () => boundaryIds.shift()!,
      });
      const threadStore = new ConversationThreadStore({
        database,
        owner: OWNER,
        randomUUID: () => segmentIds.shift()!,
      });
      const coordinator = new ConversationRuntimeCoordinator({
        database,
        bindingStore,
        boundaryStore,
        threadStore,
        randomUUID: () => segmentIds.shift()!,
      });

      const firstRoute = frozenRoute("openai", "gpt-5.6", "openai-gpt");
      const firstPrepared = coordinator.prepare({
        conversationKey: "visible-thread",
        resumeSessionId: null,
        context: { scope: "USER" },
        bindingInput: bindingInput("visible-thread", firstRoute),
      });
      if (!firstPrepared.runtimeBinding) throw new Error("fixture_binding");
      const firstAttached = coordinator.attachHermesSession({
        runtimeBindingId: firstPrepared.runtimeBinding.id,
        boundaryId: firstPrepared.boundary.id,
        sessionId: "s1",
      });
      const adopted = threadStore.adopt({
        rootConversationKey: "visible-thread",
        runtimeBindingId: firstAttached.runtimeBinding!.id,
        conversationBoundaryId: firstAttached.boundary.id,
        hermesSessionId: "s1",
        modelRoute: firstRoute,
        historyBoundaryCount: 0,
      });

      const addSegment = (
        sessionId: string,
        historyBoundaryCount: number,
        modelRoute: FrozenAgentModelRoute,
      ): ReturnType<ConversationRuntimeCoordinator["activateSegment"]> => {
        const prepared = coordinator.prepareSegment({
          rootConversationKey: "visible-thread",
          context: { scope: "USER" },
          bindingInput: bindingInput("placeholder", modelRoute),
          historyBoundaryCount,
        });
        const attached = coordinator.attachSegmentSession({
          segmentId: prepared.segment.id,
          runtimeBindingId: prepared.runtimeBinding.id,
          boundaryId: prepared.boundary.id,
          sessionId,
        });
        return coordinator.activateSegment({
          threadId: attached.thread.id,
          segmentId: attached.segment.id,
          expectedThreadRevision: attached.thread.revision,
        });
      };
      const second = addSegment(
        "s2",
        2,
        frozenRoute("custom:petoi", "gpt-5.6-sol", "petoi-gpt"),
      );
      const third = addSegment(
        "s3",
        4,
        frozenRoute("anthropic", "claude-sonnet-4-5", "anthropic-sonnet"),
      );
      expect(adopted.thread.id).toBe(second.thread.id);
      expect(third.segment.hermesSessionId).toBe("s3");

      database.close();
      database = openAgenteraControlPlaneDatabase(userData, {
        databaseFactory: nodeSqliteFactory,
      });
      const reloadedStore = new ConversationThreadStore({
        database,
        owner: OWNER,
      });
      const reloadedProjection = new ConversationThreadSessionProjection(
        reloadedStore.listSessionProjectionRecords(),
      );

      const resumed = reloadedProjection.resolveResume("s1");
      expect(resumed).toMatchObject({
        activeSessionId: "s3",
        threadId: adopted.thread.id,
      });
      expect(resumed?.markers).toHaveLength(2);
      expect(JSON.stringify(resumed)).not.toMatch(
        /credential|MODEL_API_KEY|ownerId|account-home/i,
      );
    } finally {
      database?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
