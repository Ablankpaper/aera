// @vitest-environment node

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentDraftAssetInput,
  AgentEditableManifest,
} from "../src/shared/agentera-agent-control";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "../src/main/agentera-agent-control/db";
import {
  AgentDraftStore,
  AgentDraftStoreError,
} from "../src/main/agentera-agent-control/draft-store";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const DEFINITION_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-07-19T17:00:00.000Z");
const OWNER = { tenantId: DEFINITION_ID, ownerId: VERSION_ID } as const;
const OTHER_OWNER = {
  tenantId: "44444444-4444-4444-8444-444444444444",
  ownerId: "55555555-5555-4555-8555-555555555555",
} as const;
const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_WORKSPACE_ID = "77777777-7777-4777-8777-777777777777";
const WORKSPACE_DRAFT_ID = "88888888-8888-4888-8888-888888888888";

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function manifest(systemPrompt = "Research with care"): AgentEditableManifest {
  return {
    schemaVersion: 1,
    identity: { systemPrompt },
    assets: [
      {
        path: "knowledge/notes.md",
        kind: "knowledge",
        mediaType: "text/markdown",
      },
    ],
    modelConstraints: {
      allowedProviders: ["openai"],
      allowedModels: ["gpt-5.6"],
    },
    tools: { allowed: ["files.read"], denied: [] },
    dependencies: [],
    runtimeCompatibility: {
      minimumVersion: "v0.18.2-agentera.1",
      maximumVersionExclusive: null,
    },
  };
}

function assets(content = "# Notes\n"): AgentDraftAssetInput[] {
  return [{ path: "knowledge/notes.md", content }];
}

describe("AgentEra desktop-local Agent drafts", () => {
  let root = "";
  let userDataPath = "";
  let database: AgenteraControlPlaneDatabase;
  let store: AgentDraftStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-drafts-"));
    userDataPath = join(root, "user-data");
    database = openAgenteraControlPlaneDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    store = new AgentDraftStore({
      database,
      owner: OWNER,
      now: () => NOW,
      randomUUID: () => DRAFT_ID,
    });
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("survives restart while returning only renderer-safe allowlisted fields", () => {
    const created = store.createDraft({
      sourceAgentDefinitionId: DEFINITION_ID,
      baseAgentVersionId: VERSION_ID,
      displayName: "Research Agent",
      icon: null,
      manifest: manifest(),
      assets: assets(),
    });
    expect(created.revision).toBe(1);
    expect(store.readAsset(DRAFT_ID, "knowledge/notes.md").toString()).toBe(
      "# Notes\n",
    );
    database.close();

    database = openAgenteraControlPlaneDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    store = new AgentDraftStore({ database, owner: OWNER });
    const reloaded = store.getDraft(DRAFT_ID);
    expect(reloaded).toEqual(created);
    expect(store.listDrafts()).toEqual([created]);
    expect(store.getDraftDetail(DRAFT_ID).editableAssets).toEqual(assets());

    const serialized = JSON.stringify(reloaded);
    for (const forbidden of [
      "ownerId",
      "tenantId",
      "deviceId",
      "profilePath",
      "physicalPath",
      "accessToken",
      "refreshToken",
      "signature",
      "publicKey",
      userDataPath,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("increments revisions monotonically and rejects stale compare-and-swap edits", () => {
    store.createDraft({
      sourceAgentDefinitionId: null,
      baseAgentVersionId: null,
      displayName: "Research Agent",
      icon: null,
      manifest: manifest(),
      assets: assets(),
    });
    const revisionTwo = store.updateDraft({
      id: DRAFT_ID,
      expectedRevision: 1,
      displayName: "Research Agent 2",
      icon: null,
      manifest: manifest("Second revision"),
      assets: assets("second"),
    });
    expect(revisionTwo.revision).toBe(2);

    expect(() =>
      store.updateDraft({
        id: DRAFT_ID,
        expectedRevision: 1,
        displayName: "Stale edit",
        icon: null,
        manifest: manifest("stale"),
        assets: assets("stale"),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AgentDraftStoreError>>({
        code: "draft_conflict",
      }),
    );
    expect(store.getDraft(DRAFT_ID)).toEqual(revisionTwo);
    expect(store.readAsset(DRAFT_ID, "knowledge/notes.md").toString()).toBe(
      "second",
    );

    const revisionThree = store.updateDraft({
      id: DRAFT_ID,
      expectedRevision: 2,
      displayName: "Research Agent 3",
      icon: null,
      manifest: manifest("Third revision"),
      assets: assets("third"),
    });
    expect(revisionThree.revision).toBe(3);
  });

  it("keeps the last good revision when an asset write fails", () => {
    const created = store.createDraft({
      sourceAgentDefinitionId: null,
      baseAgentVersionId: null,
      displayName: "Stable draft",
      icon: null,
      manifest: manifest(),
      assets: assets("stable"),
    });
    const failingStore = new AgentDraftStore({
      database,
      owner: OWNER,
      writeFile: () => {
        throw new Error("simulated disk failure");
      },
    });
    expect(() =>
      failingStore.updateDraft({
        id: DRAFT_ID,
        expectedRevision: 1,
        displayName: "Broken draft",
        icon: null,
        manifest: manifest("broken"),
        assets: assets("broken"),
      }),
    ).toThrow(/disk failure/i);
    expect(store.getDraft(DRAFT_ID)).toEqual(created);
    expect(store.readAsset(DRAFT_ID, "knowledge/notes.md").toString()).toBe(
      "stable",
    );
  });

  it("keeps drafts hidden across product-account switches", () => {
    store.createDraft({
      sourceAgentDefinitionId: null,
      baseAgentVersionId: null,
      displayName: "Owner-only draft",
      icon: null,
      manifest: manifest(),
      assets: assets(),
    });
    const other = new AgentDraftStore({ database, owner: OTHER_OWNER });
    expect(other.listDrafts()).toEqual([]);
    expect(() => other.getDraft(DRAFT_ID)).toThrow(
      new AgentDraftStoreError("draft_not_found"),
    );
    expect(store.listDrafts()).toHaveLength(1);
  });

  it("partitions one account's drafts by exact USER or Workspace target", () => {
    const workspace = new AgentDraftStore({
      database,
      owner: OWNER,
      context: { scope: "WORKSPACE", workspaceId: WORKSPACE_ID, role: "admin" },
      now: () => NOW,
      randomUUID: () => WORKSPACE_DRAFT_ID,
    });
    const created = workspace.createDraft({
      sourceAgentDefinitionId: null,
      baseAgentVersionId: null,
      displayName: "Workspace Research Agent",
      icon: null,
      manifest: manifest(),
      assets: assets(),
    });
    const otherWorkspace = new AgentDraftStore({
      database,
      owner: OWNER,
      context: {
        scope: "WORKSPACE",
        workspaceId: OTHER_WORKSPACE_ID,
        role: "owner",
      },
    });

    expect(workspace.listDrafts()).toEqual([created]);
    expect(store.listDrafts()).toEqual([]);
    expect(otherWorkspace.listDrafts()).toEqual([]);
    expect(() => store.getDraft(WORKSPACE_DRAFT_ID)).toThrow(
      new AgentDraftStoreError("draft_not_found"),
    );
    expect(
      database.sqlite
        .prepare(
          "SELECT target_scope, workspace_id FROM agent_drafts WHERE id = ?",
        )
        .get(WORKSPACE_DRAFT_ID),
    ).toEqual({ target_scope: "WORKSPACE", workspace_id: WORKSPACE_ID });
  });

  it("rejects symlink substitution when reading a stored draft asset", () => {
    store.createDraft({
      sourceAgentDefinitionId: null,
      baseAgentVersionId: null,
      displayName: "Research Agent",
      icon: null,
      manifest: manifest(),
      assets: assets(),
    });
    const assetPath = join(
      database.paths.draftsPath,
      DRAFT_ID,
      "revisions",
      "1",
      "knowledge",
      "notes.md",
    );
    const outside = join(root, "outside-secret.txt");
    expect(readFileSync(assetPath, "utf8")).toBe("# Notes\n");
    unlinkSync(assetPath);
    symlinkSync(outside, assetPath);
    expect(() => store.readAsset(DRAFT_ID, "knowledge/notes.md")).toThrow(
      /invalid_agent_content/i,
    );
  });

  it("reuses one bounded UUID idempotency key per exact publication revision", () => {
    store.createDraft({
      sourceAgentDefinitionId: null,
      baseAgentVersionId: null,
      displayName: "Research Agent",
      icon: null,
      manifest: manifest(),
      assets: assets(),
    });
    const first = store.beginPublicationAttempt(DRAFT_ID, 1);
    const second = store.beginPublicationAttempt(DRAFT_ID, 1);
    expect(second).toEqual(first);
    expect(first.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    store.recordPublicationFailure(
      DRAFT_ID,
      1,
      "network_unavailable",
      "Network unavailable",
    );
    expect(store.getDraft(DRAFT_ID).lastPublicationAttempt).toEqual({
      revision: 1,
      attemptedAt: NOW.toISOString(),
      errorCode: "network_unavailable",
      errorSummary: "Network unavailable",
    });
    expect(() =>
      store.recordPublicationFailure(
        DRAFT_ID,
        1,
        "network_unavailable",
        "secret response body ".repeat(40),
      ),
    ).toThrow(/summary|bounded/i);
  });
});
