// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAgentControlClient } from "../src/main/agentera-agent-control/client";
import {
  openAgenteraControlPlaneDatabase,
  type AgentAssetContext,
  type AgenteraSqliteDatabase,
} from "../src/main/agentera-agent-control/db";
import { AgenteraAgentControlManager } from "../src/main/agentera-agent-control/manager";
import type { AgenteraRuntimeOwner } from "../src/main/agentera-profile-binding";

const OWNER_A: AgenteraRuntimeOwner = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  deviceInstallationId: "33333333-3333-4333-8333-333333333333",
};
const OWNER_B: AgenteraRuntimeOwner = {
  tenantId: "44444444-4444-4444-8444-444444444444",
  ownerId: "55555555-5555-4555-8555-555555555555",
  deviceInstallationId: "66666666-6666-4666-8666-666666666666",
};
const WORKSPACE_ID = "77777777-7777-4777-8777-777777777777";
const USER_INSTALLATION_ID = "88888888-8888-4888-8888-888888888888";
const WORKSPACE_INSTALLATION_ID = "99999999-9999-4999-8999-999999999999";

function draftInput(displayName: string) {
  return {
    sourceAgentDefinitionId: null,
    baseAgentVersionId: null,
    displayName,
    icon: null,
    manifest: {
      schemaVersion: 1 as const,
      identity: { systemPrompt: `Stay inside ${displayName}.` },
      assets: [],
      modelConstraints: {
        allowedProviders: ["openai"],
        allowedModels: ["gpt-5.6"],
      },
      tools: { allowed: [], denied: [] },
      dependencies: [],
      runtimeCompatibility: {
        minimumVersion: "v0.18.2-agentera.1",
        maximumVersionExclusive: null,
      },
    },
    assets: [],
  };
}

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

describe("Agent control local USER ownership", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[agentera-agent-control-plane#Local account isolation]]
  it("switches one long-lived manager without exposing the previous account", () => {
    const root = mkdtempSync(join(tmpdir(), "agentera-owner-isolation-"));
    roots.push(root);
    const database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    let owner = OWNER_A;
    const manager = new AgenteraAgentControlManager({
      database,
      client: {
        origin: "https://cloud.agentera.test",
      } as AgenteraAgentControlClient,
      profileBindings: {} as never,
      profiles: {} as never,
      userDataPath: join(root, "user-data"),
      getOwner: () => owner,
      getAuthState: () => ({
        status: "authenticated",
        userId: owner.ownerId,
        personalSpaceId: owner.tenantId,
        deviceId: owner.deviceInstallationId,
        offlineExpiresAt: "2026-07-26T00:00:00.000Z",
        cloudAvailable: false,
      }),
      getRuntimeVersion: () => "v0.18.2-agentera.1",
      getConnectionMode: () => "local",
      assertEntitled: () => undefined,
    });

    const created = manager.createDraft({
      sourceAgentDefinitionId: null,
      baseAgentVersionId: null,
      displayName: "Account A draft",
      icon: null,
      manifest: {
        schemaVersion: 1,
        identity: { systemPrompt: "Stay in the owning personal space." },
        assets: [],
        modelConstraints: {
          allowedProviders: ["openai"],
          allowedModels: ["gpt-5.6"],
        },
        tools: { allowed: [], denied: [] },
        dependencies: [],
        runtimeCompatibility: {
          minimumVersion: "v0.18.2-agentera.1",
          maximumVersionExclusive: null,
        },
      },
      assets: [],
    });
    expect(manager.getState().draftCount).toBe(1);

    owner = OWNER_B;
    expect(manager.getState().draftCount).toBe(0);
    expect(manager.listDrafts()).toEqual([]);
    expect(() => manager.getDraft(created.id)).toThrow(
      expect.objectContaining({ code: "draft_not_found" }),
    );

    owner = OWNER_A;
    expect(manager.listDrafts().map(({ id }) => id)).toEqual([created.id]);
    database.close();
  });

  // @lat: [[agentera-agent-control-plane#Trusted Workspace Agent context#Local context partitions]]
  it("partitions drafts, discovery, and installation lists by trusted selected context", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentera-context-isolation-"));
    roots.push(root);
    const userDataPath = join(root, "user-data");
    const database = openAgenteraControlPlaneDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    let context: AgentAssetContext = { scope: "USER" };
    const listDefinitions = vi.fn(async () => []);
    const listWorkspaceDefinitions = vi.fn(async () => []);
    const getSigningKeys = vi.fn(async () => {
      throw new Error("must not fetch keys for discovery or context changes");
    });
    const profileBindings = {
      verifyProfileBinding: vi.fn(() => {
        throw new Error("context changes must not inspect a Profile");
      }),
    };
    const manager = new AgenteraAgentControlManager({
      database,
      client: {
        origin: "https://cloud.agentera.test",
        listDefinitions,
        listWorkspaceDefinitions,
        getSigningKeys,
      } as unknown as AgenteraAgentControlClient,
      profileBindings: profileBindings as never,
      profiles: {} as never,
      userDataPath,
      getOwner: () => OWNER_A,
      getAgentContext: () => context,
      getAuthState: () => ({
        status: "authenticated",
        userId: OWNER_A.ownerId,
        personalSpaceId: OWNER_A.tenantId,
        deviceId: OWNER_A.deviceInstallationId,
        offlineExpiresAt: "2026-07-26T00:00:00.000Z",
        cloudAvailable: true,
      }),
      getRuntimeVersion: () => "v0.18.2-agentera.1",
      getConnectionMode: () => "local",
      assertEntitled: () => undefined,
    });
    const userDraft = manager.createDraft(draftInput("Personal draft"));
    database.sqlite
      .prepare(
        `INSERT INTO local_agent_installations (
           agent_installation_id, tenant_id, owner_id, device_installation_id,
           source_scope, source_workspace_id, definition_id,
           selected_version_id, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        USER_INSTALLATION_ID,
        OWNER_A.tenantId,
        OWNER_A.ownerId,
        OWNER_A.deviceInstallationId,
        "USER",
        null,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "2026-07-20T00:00:00.000Z",
        "2026-07-20T00:00:00.000Z",
      );
    database.sqlite
      .prepare(
        `INSERT INTO local_agent_installations (
           agent_installation_id, tenant_id, owner_id, device_installation_id,
           source_scope, source_workspace_id, definition_id,
           selected_version_id, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        WORKSPACE_INSTALLATION_ID,
        OWNER_A.tenantId,
        OWNER_A.ownerId,
        OWNER_A.deviceInstallationId,
        "WORKSPACE",
        WORKSPACE_ID,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "2026-07-20T00:00:00.000Z",
        "2026-07-20T00:00:00.000Z",
      );

    expect(manager.getState()).toMatchObject({
      draftCount: 1,
      installationCount: 1,
    });
    expect((await manager.listInstallations()).map(({ id }) => id)).toEqual([
      USER_INSTALLATION_ID,
    ]);
    await manager.listDefinitions();
    expect(listDefinitions).toHaveBeenCalledOnce();

    context = {
      scope: "WORKSPACE",
      workspaceId: WORKSPACE_ID,
      role: "admin",
    };
    const listener = vi.fn();
    manager.subscribe(listener);
    manager.notifyAgentContextChanged();
    expect(listener).toHaveBeenCalledOnce();
    expect(manager.getState()).toMatchObject({
      draftCount: 0,
      installationCount: 1,
    });
    expect(manager.listDrafts()).toEqual([]);
    const workspaceDraft = manager.createDraft(draftInput("Workspace draft"));
    expect(workspaceDraft.id).not.toBe(userDraft.id);
    expect((await manager.listInstallations()).map(({ id }) => id)).toEqual([
      WORKSPACE_INSTALLATION_ID,
    ]);
    await manager.listDefinitions();
    expect(listWorkspaceDefinitions).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(getSigningKeys).not.toHaveBeenCalled();
    expect(profileBindings.verifyProfileBinding).not.toHaveBeenCalled();

    context = { scope: "USER" };
    manager.notifyAgentContextChanged();
    expect(manager.listDrafts().map(({ id }) => id)).toEqual([userDraft.id]);
    database.close();
  });

  it("rejects Workspace Member authoring before any cloud request", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentera-member-authoring-"));
    roots.push(root);
    const userDataPath = join(root, "user-data");
    const database = openAgenteraControlPlaneDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    const getSigningKeys = vi.fn(async () => {
      throw new Error("must not be called for denied publication");
    });
    const manager = new AgenteraAgentControlManager({
      database,
      client: {
        origin: "https://cloud.agentera.test",
        getSigningKeys,
      } as unknown as AgenteraAgentControlClient,
      profileBindings: {} as never,
      profiles: {} as never,
      userDataPath,
      getOwner: () => OWNER_A,
      getAgentContext: () => ({
        scope: "WORKSPACE",
        workspaceId: WORKSPACE_ID,
        role: "member",
      }),
      getAuthState: () => ({
        status: "authenticated",
        userId: OWNER_A.ownerId,
        personalSpaceId: OWNER_A.tenantId,
        deviceId: OWNER_A.deviceInstallationId,
        offlineExpiresAt: "2026-07-26T00:00:00.000Z",
        cloudAvailable: true,
      }),
      getRuntimeVersion: () => "v0.18.2-agentera.1",
      getConnectionMode: () => "local",
      assertEntitled: () => undefined,
    });

    expect(() => manager.createDraft(draftInput("Denied draft"))).toThrow(
      expect.objectContaining({ code: "workspace_forbidden" }),
    );
    await expect(
      manager.preparePublication("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ).rejects.toMatchObject({ code: "workspace_forbidden" });
    expect(getSigningKeys).not.toHaveBeenCalled();
    database.close();
  });
});
