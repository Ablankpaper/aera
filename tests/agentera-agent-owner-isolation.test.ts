// @vitest-environment node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentDraftInput } from "../src/shared/agentera-agent-control";
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
const OWNER_B_INSTALLATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROFILE_A_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROFILE_B_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEFINITION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VERSION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function draftInput(displayName: string): CreateAgentDraftInput {
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
      context: { scope: "USER" },
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
      context: {
        scope: "WORKSPACE",
        workspaceId: WORKSPACE_ID,
        role: "admin",
      },
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

  // @lat: [[agentera-self-evolution#Candidate promotion loop#Candidate failure isolation]]
  it("invalidates ExperienceCandidate access across context, logout, account, and device partitions", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentera-candidate-isolation-"));
    roots.push(root);
    const userDataPath = join(root, "user-data");
    const profileA = join(root, "profile-a");
    const profileB = join(root, "profile-b");
    for (const [profile, skill] of [
      [profileA, "account-a-skill"],
      [profileB, "account-b-skill"],
    ] as const) {
      mkdirSync(join(profile, "skills", skill), { recursive: true });
      writeFileSync(
        join(profile, "skills", skill, "SKILL.md"),
        `---\nname: ${skill}\ndescription: Learned locally\n---\n\n# ${skill}\n`,
      );
      writeFileSync(
        join(profile, "skills", ".usage.json"),
        JSON.stringify({ [skill]: { created_by: "agent", state: "active" } }),
      );
    }
    const sourceA = readFileSync(
      join(profileA, "skills", "account-a-skill", "SKILL.md"),
    );
    const database = openAgenteraControlPlaneDatabase(userDataPath, {
      databaseFactory: nodeSqliteFactory,
    });
    for (const [owner, installationId, profileId] of [
      [OWNER_A, WORKSPACE_INSTALLATION_ID, PROFILE_A_ID],
      [OWNER_B, OWNER_B_INSTALLATION_ID, PROFILE_B_ID],
    ] as const) {
      database.sqlite
        .prepare(
          `INSERT INTO local_agent_installations (
             agent_installation_id, tenant_id, owner_id, device_installation_id,
             source_scope, source_workspace_id, definition_id,
             selected_version_id, runtime_profile_id, status,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'WORKSPACE', ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          installationId,
          owner.tenantId,
          owner.ownerId,
          owner.deviceInstallationId,
          WORKSPACE_ID,
          DEFINITION_ID,
          VERSION_ID,
          profileId,
          "2026-07-20T00:00:00.000Z",
          "2026-07-20T00:00:00.000Z",
        );
    }
    let owner = OWNER_A;
    let signedIn = true;
    let context: AgentAssetContext = {
      scope: "WORKSPACE",
      workspaceId: WORKSPACE_ID,
      role: "member",
    };
    const listOwnExperienceCandidates = vi.fn(async () => {
      throw new Error("offline candidate list must remain local");
    });
    const resolveProfilePath = vi.fn((profileId: string) => {
      if (profileId === PROFILE_A_ID) return profileA;
      if (profileId === PROFILE_B_ID) return profileB;
      throw new Error("unknown profile");
    });
    const manager = new AgenteraAgentControlManager({
      database,
      client: {
        origin: "https://cloud.agentera.test",
        listOwnExperienceCandidates,
      } as unknown as AgenteraAgentControlClient,
      profileBindings: {} as never,
      profiles: {
        resolveProfilePath,
      } as never,
      userDataPath,
      getOwner: () => owner,
      getAgentContext: () => context,
      getAuthState: () =>
        signedIn
          ? {
              status: "offline" as const,
              userId: owner.ownerId,
              personalSpaceId: owner.tenantId,
              deviceId: owner.deviceInstallationId,
              offlineExpiresAt: "2026-07-26T00:00:00.000Z",
              cloudAvailable: false,
            }
          : { status: "unauthenticated" as const },
      getRuntimeVersion: () => "v0.18.2-agentera.1",
      getConnectionMode: () => "local",
      assertEntitled: () => undefined,
    });

    await expect(
      manager.listEligibleExperienceSkills(WORKSPACE_INSTALLATION_ID),
    ).resolves.toEqual([
      { skillName: "account-a-skill", description: "Learned locally" },
    ]);
    const prepared = await manager.prepareExperienceCandidate({
      installationId: WORKSPACE_INSTALLATION_ID,
      skillName: "account-a-skill",
    });
    expect(prepared.localCandidateId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(await manager.listMyExperienceCandidates()).toEqual([
      expect.objectContaining({
        localCandidateId: prepared.localCandidateId,
        skillName: "account-a-skill",
      }),
    ]);

    context = {
      scope: "WORKSPACE",
      workspaceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      role: "member",
    };
    manager.notifyAgentContextChanged();
    expect(await manager.listMyExperienceCandidates()).toEqual([]);

    context = {
      scope: "WORKSPACE",
      workspaceId: WORKSPACE_ID,
      role: "member",
    };
    owner = OWNER_B;
    manager.notifyAccessStateChanged();
    expect(await manager.listMyExperienceCandidates()).toEqual([]);
    await expect(
      manager.prepareExperienceCandidate({
        installationId: WORKSPACE_INSTALLATION_ID,
        skillName: "account-a-skill",
      }),
    ).rejects.toMatchObject({ code: "candidate_source_ineligible" });

    signedIn = false;
    manager.notifyAccessStateChanged();
    await expect(manager.listMyExperienceCandidates()).rejects.toMatchObject({
      code: "sign_in_required",
    });
    signedIn = true;
    owner = OWNER_A;
    manager.notifyAccessStateChanged();
    expect(await manager.listMyExperienceCandidates()).toEqual([
      expect.objectContaining({
        localCandidateId: prepared.localCandidateId,
        skillName: "account-a-skill",
      }),
    ]);
    expect(listOwnExperienceCandidates).not.toHaveBeenCalled();
    expect(
      readFileSync(join(profileA, "skills", "account-a-skill", "SKILL.md")),
    ).toEqual(sourceA);
    database.close();
  });
});
