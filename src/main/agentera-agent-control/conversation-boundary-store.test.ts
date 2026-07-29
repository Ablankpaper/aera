// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import {
  ConversationBoundaryStore,
  ConversationBoundaryStoreError,
} from "./conversation-boundary-store";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import { RuntimeBindingStore } from "./runtime-binding-store";

const OWNER: AgenteraRuntimeOwner = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  ownerId: "10000000-0000-4000-8000-000000000002",
  deviceInstallationId: "10000000-0000-4000-8000-000000000003",
};
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";

describe("ConversationBoundaryStore", () => {
  const roots: string[] = [];
  const databases: AgenteraControlPlaneDatabase[] = [];

  function open(): AgenteraControlPlaneDatabase {
    const root = mkdtempSync(join(tmpdir(), "agentera-conversation-boundary-"));
    roots.push(root);
    const database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: (path) =>
        new DatabaseSync(path) as unknown as AgenteraSqliteDatabase,
    });
    databases.push(database);
    return database;
  }

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins Organization execution scope independently from private visibility and resource scopes", () => {
    const database = open();
    const store = new ConversationBoundaryStore({
      database,
      owner: OWNER,
      now: () => new Date("2026-07-30T08:00:00.000Z"),
    });

    const first = store.prepare({
      conversationKey: "run-organization",
      resumeSessionId: null,
      context: {
        scope: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
        role: "member",
      },
      runtimeBinding: null,
    });
    expect(first).toMatchObject({
      tenantId: OWNER.tenantId,
      actorUserId: OWNER.ownerId,
      scopeType: "ORGANIZATION",
      scopeId: ORGANIZATION_ID,
      visibility: "PRIVATE",
      memoryScope: "ACTOR_PRIVATE",
      filesScope: "CONVERSATION_PRIVATE",
      artifactScope: "CONVERSATION_PRIVATE",
      agentRunScope: "CONVERSATION_BOUNDARY",
      runtimeBindingId: null,
      toolPermissionSnapshot: { kind: "PROFILE_DEFAULT" },
      origin: "NEW_CONVERSATION",
    });

    const afterTopLevelSwitch = store.prepare({
      conversationKey: "run-organization",
      resumeSessionId: null,
      context: {
        scope: "WORKSPACE",
        workspaceId: WORKSPACE_ID,
        role: "admin",
      },
      runtimeBinding: null,
    });
    expect(afterTopLevelSwitch).toEqual(first);
  });

  it("keeps the original boundary when a bound session resumes under another selected space", () => {
    const database = open();
    const store = new ConversationBoundaryStore({ database, owner: OWNER });
    const created = store.prepare({
      conversationKey: "run-workspace",
      resumeSessionId: null,
      context: {
        scope: "WORKSPACE",
        workspaceId: WORKSPACE_ID,
        role: "member",
      },
      runtimeBinding: null,
    });
    const attached = store.attachHermesSession(created.id, "hermes-session-1");

    const resumed = store.prepare({
      conversationKey: "run-workspace-resume",
      resumeSessionId: "hermes-session-1",
      context: {
        scope: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
        role: "owner",
      },
      runtimeBinding: null,
    });
    expect(resumed).toEqual(attached);
    expect(resumed).toMatchObject({
      scopeType: "WORKSPACE",
      scopeId: WORKSPACE_ID,
      visibility: "PRIVATE",
    });
  });

  it("defaults an unbound legacy session to USER instead of silently adopting the current enterprise space", () => {
    const database = open();
    const store = new ConversationBoundaryStore({ database, owner: OWNER });

    const boundary = store.prepare({
      conversationKey: "legacy-run",
      resumeSessionId: "legacy-session",
      context: {
        scope: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
        role: "admin",
      },
      runtimeBinding: null,
    });
    expect(boundary).toMatchObject({
      hermesSessionId: "legacy-session",
      scopeType: "USER",
      scopeId: OWNER.tenantId,
      visibility: "PRIVATE",
      origin: "LEGACY_DEFAULT",
    });
  });

  it("pins the installed Agent RuntimeBinding snapshot and rejects later drift", () => {
    const database = open();
    const runtimeBinding = new RuntimeBindingStore({
      database,
      owner: OWNER,
    }).getOrCreateForConversation({
      conversationKey: "installed-run",
      tenantId: OWNER.tenantId,
      ownerScope: "USER",
      ownerId: OWNER.ownerId,
      deviceId: OWNER.deviceInstallationId,
      agentDefinitionId: "40000000-0000-4000-8000-000000000001",
      agentVersionId: "40000000-0000-4000-8000-000000000002",
      agentInstallationId: "40000000-0000-4000-8000-000000000003",
      runtimeProfileId: "40000000-0000-4000-8000-000000000004",
      runtimeVersion: "v0.18.2-agentera.1",
      policySnapshotId: "40000000-0000-4000-8000-000000000005",
      officialReleaseRevisionId: null,
      toolPermissionDigest: "a".repeat(64),
      publishedBaseDigest: "b".repeat(64),
    });
    const store = new ConversationBoundaryStore({ database, owner: OWNER });
    const boundary = store.prepare({
      conversationKey: "installed-run",
      resumeSessionId: null,
      context: { scope: "USER" },
      runtimeBinding,
    });
    expect(boundary).toMatchObject({
      runtimeBindingId: runtimeBinding.id,
      agentInstallationId: runtimeBinding.agentInstallationId,
      agentDefinitionId: runtimeBinding.agentDefinitionId,
      agentVersionId: runtimeBinding.agentVersionId,
      policySnapshotId: runtimeBinding.policySnapshotId,
      toolPermissionSnapshot: {
        kind: "AGENT_DIGEST",
        digest: runtimeBinding.toolPermissionDigest,
      },
    });

    expect(() =>
      store.prepare({
        conversationKey: "installed-run",
        resumeSessionId: null,
        context: { scope: "USER" },
        runtimeBinding: {
          ...runtimeBinding,
          agentVersionId: "40000000-0000-4000-8000-000000000006",
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ConversationBoundaryStoreError>>({
        code: "boundary_conflict",
      }),
    );
  });

  it("isolates identical conversation and session identifiers by actor and deletes only the current actor boundary", () => {
    const database = open();
    const first = new ConversationBoundaryStore({ database, owner: OWNER });
    const otherOwner: AgenteraRuntimeOwner = {
      ...OWNER,
      ownerId: "50000000-0000-4000-8000-000000000001",
    };
    const second = new ConversationBoundaryStore({
      database,
      owner: otherOwner,
    });
    const firstBoundary = first.prepare({
      conversationKey: "same-run",
      resumeSessionId: "same-session",
      context: { scope: "USER" },
      runtimeBinding: null,
    });
    const secondBoundary = second.prepare({
      conversationKey: "same-run",
      resumeSessionId: "same-session",
      context: { scope: "USER" },
      runtimeBinding: null,
    });
    expect(firstBoundary.id).not.toBe(secondBoundary.id);

    expect(first.deleteForHermesSessions(["same-session"])).toBe(1);
    expect(first.getByHermesSessionId("same-session")).toBeNull();
    expect(second.getByHermesSessionId("same-session")).toEqual(secondBoundary);
  });
});
