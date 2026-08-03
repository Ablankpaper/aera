// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  AgenteraAgentControlContext,
  CreateAgentDraftInput,
  OfficialAgentSummary,
} from "../../shared/agentera-agent-control";
import type { AgenteraAgentControlClient } from "./client";
import type { AgenteraHermesAdapter } from "./hermes-adapter";
import { AgentInstallationManager } from "./installation-manager";
import { RuntimeBindingStore } from "./runtime-binding-store";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import { AgenteraAgentControlManager, runtimeComponentKey } from "./manager";

const OWNER = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  ownerId: "10000000-0000-4000-8000-000000000002",
  deviceInstallationId: "10000000-0000-4000-8000-000000000003",
};
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "20000000-0000-4000-8000-000000000002";
const OFFICIAL_DEFINITION_ID = "30000000-0000-4000-8000-000000000001";
const PERSONAL_INSTALLATION_ID = "40000000-0000-4000-8000-000000000001";
const PERSONAL_VERSION_ID = "40000000-0000-4000-8000-000000000002";
const PERSONAL_PROFILE_ID = "40000000-0000-4000-8000-000000000003";
const PERSONAL_POLICY_ID = "40000000-0000-4000-8000-000000000004";
const PERSONAL_BINDING_ID = "40000000-0000-4000-8000-000000000005";

function officialSummary(): OfficialAgentSummary {
  return {
    definitionId: OFFICIAL_DEFINITION_ID,
    displayName: "Official Research Agent",
    iconMediaType: null,
    iconDataBase64Url: null,
    versionId: "30000000-0000-4000-8000-000000000002",
    versionNumber: 1,
    releaseId: "30000000-0000-4000-8000-000000000003",
    releaseRevisionId: "30000000-0000-4000-8000-000000000004",
    channel: "internal",
    runtimeMinimumVersion: "v0.18.2-agentera.1",
    runtimeMaximumVersionExclusive: null,
    installationState: "not_installed",
    updateState: "current",
  };
}

function draftInput(): CreateAgentDraftInput {
  return {
    sourceAgentDefinitionId: null,
    baseAgentVersionId: null,
    displayName: "Organization Research Agent",
    icon: null,
    manifest: {
      schemaVersion: 1,
      identity: { systemPrompt: "Research safely." },
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
    },
    assets: [{ path: "knowledge/notes.md", content: "# Notes\n" }],
  };
}

describe("Agent control Organization Foundation context", () => {
  const roots: string[] = [];
  const databases: AgenteraControlPlaneDatabase[] = [];

  function fullManager(
    getContext: () => AgenteraAgentControlContext,
    clientOverrides: Record<string, unknown> = {},
    runtimeOverrides: Partial<{
      getOwner: () => typeof OWNER;
      getAuthState: () => AgenteraAuthPublicState;
      getRuntimeVersion: () => string | Promise<string>;
      getConnectionMode: () => "local" | "remote" | "ssh";
      hermesAdapter: AgenteraHermesAdapter;
      verifyProfileBinding: () => { agentInstallationId: string | null };
    }> = {},
  ): {
    manager: AgenteraAgentControlManager;
    database: AgenteraControlPlaneDatabase;
  } {
    const root = mkdtempSync(join(tmpdir(), "agentera-organization-agent-"));
    roots.push(root);
    const userDataPath = join(root, "user-data");
    const database = openAgenteraControlPlaneDatabase(userDataPath, {
      databaseFactory: (path) =>
        new DatabaseSync(path) as unknown as AgenteraSqliteDatabase,
    });
    databases.push(database);
    return {
      database,
      manager: new AgenteraAgentControlManager({
        database,
        client: {
          origin: "https://cloud.agentera.test",
          getOfficialAgentChannel: () => "internal",
          listOrganizationDefinitions: vi.fn(async () => []),
          listOrganizationVersions: vi.fn(async () => []),
          ...clientOverrides,
        } as unknown as AgenteraAgentControlClient,
        profileBindings: {
          verifyProfileBinding:
            runtimeOverrides.verifyProfileBinding ?? vi.fn(),
          bindFreshProfile: vi.fn(),
          claimProfile: vi.fn(),
        } as never,
        profiles: {
          profileIdForAgentName: vi.fn(() => "fresh-agent"),
          createProfile: vi.fn(),
          deleteProfile: vi.fn(() => ({ success: true })),
          resolveProfilePath: vi.fn(),
          activateProfile: vi.fn(),
        },
        userDataPath,
        getOwner: runtimeOverrides.getOwner ?? (() => OWNER),
        getAgentContext: getContext,
        getAuthState:
          runtimeOverrides.getAuthState ??
          (() => ({
            status: "authenticated",
            userId: OWNER.ownerId,
            personalSpaceId: OWNER.tenantId,
            deviceId: OWNER.deviceInstallationId,
            offlineExpiresAt: "2026-07-28T00:00:00.000Z",
            cloudAvailable: true,
          })),
        getRuntimeVersion:
          runtimeOverrides.getRuntimeVersion ?? (() => "v0.18.2-agentera.1"),
        getConnectionMode:
          runtimeOverrides.getConnectionMode ?? (() => "local"),
        assertEntitled: () => undefined,
        hermesAdapter: runtimeOverrides.hermesAdapter,
      }),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of databases.splice(0)) database.close();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives Organization catalog access from the trusted coordinator only", async () => {
    const listOrganizationDefinitions = vi.fn(async () => []);
    const listDefinitions = vi.fn(async () => []);
    const listWorkspaceDefinitions = vi.fn(async () => []);
    const { manager } = fullManager(
      () => ({
        scope: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
        role: "admin",
      }),
      {
        listOrganizationDefinitions,
        listDefinitions,
        listWorkspaceDefinitions,
      },
    );

    expect(manager.getState()).toMatchObject({
      context: {
        scope: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
        role: "admin",
      },
    });
    await expect(manager.listDefinitions()).resolves.toEqual([]);
    expect(listOrganizationDefinitions).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(listDefinitions).not.toHaveBeenCalled();
    expect(listWorkspaceDefinitions).not.toHaveBeenCalled();
  });

  it("allows explicit USER Agent operations without changing the trusted Organization context", async () => {
    const listDefinitions = vi.fn(async () => []);
    const listOrganizationDefinitions = vi.fn(async () => []);
    const { manager } = fullManager(
      () => ({
        scope: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
        role: "member",
      }),
      { listDefinitions, listOrganizationDefinitions },
    );

    const created = manager.createDraft(draftInput(), "USER");
    expect(manager.listDrafts("USER")).toEqual([
      expect.objectContaining({
        id: created.id,
        displayName: created.displayName,
      }),
    ]);
    await expect(manager.listDefinitions("USER")).resolves.toEqual([]);
    expect(listDefinitions).toHaveBeenCalledOnce();
    expect(listOrganizationDefinitions).not.toHaveBeenCalled();
    expect(manager.getState().context).toEqual({
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "member",
    });
  });

  it("keeps an installed personal Agent conversation in the selected Organization run scope", () => {
    const { manager, database } = fullManager(() => ({
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "owner",
    }));
    const now = "2026-07-30T00:00:00.000Z";
    database.sqlite
      .prepare(
        `INSERT INTO local_agent_installations (
           agent_installation_id, tenant_id, owner_id, device_installation_id,
           source_scope, source_workspace_id, source_organization_id,
           official_release_id, selected_release_revision_id, update_policy,
           definition_id, selected_version_id, runtime_profile_id,
           policy_snapshot_id, status, retry_code, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'USER', NULL, NULL, NULL, NULL, 'manual',
                   ?, ?, ?, ?, 'active', NULL, ?, ?)`,
      )
      .run(
        PERSONAL_INSTALLATION_ID,
        OWNER.tenantId,
        OWNER.ownerId,
        OWNER.deviceInstallationId,
        OFFICIAL_DEFINITION_ID,
        PERSONAL_VERSION_ID,
        PERSONAL_PROFILE_ID,
        PERSONAL_POLICY_ID,
        now,
        now,
      );
    const binding = new RuntimeBindingStore({
      database,
      owner: OWNER,
      now: () => new Date(now),
      randomUUID: () => PERSONAL_BINDING_ID,
    }).getOrCreateForConversation({
      conversationKey: "personal-agent-from-organization-shell",
      tenantId: OWNER.tenantId,
      ownerScope: "USER",
      ownerId: OWNER.ownerId,
      deviceId: OWNER.deviceInstallationId,
      agentDefinitionId: OFFICIAL_DEFINITION_ID,
      agentVersionId: PERSONAL_VERSION_ID,
      agentInstallationId: PERSONAL_INSTALLATION_ID,
      runtimeProfileId: PERSONAL_PROFILE_ID,
      runtimeVersion: "v0.18.2-agentera.1",
      modelRoute: { provider: "openai", model: "gpt-5.6", baseUrl: "" },
      policySnapshotId: PERSONAL_POLICY_ID,
      officialReleaseRevisionId: null,
      toolPermissionDigest: "1".repeat(64),
      publishedBaseDigest: "2".repeat(64),
    });

    expect(
      manager.prepareConversationBoundary({
        conversationKey: binding.conversationKey,
        owner: OWNER,
        resumeSessionId: null,
        runtimeBinding: binding,
      }),
    ).toMatchObject({
      scopeType: "ORGANIZATION",
      scopeId: ORGANIZATION_ID,
      visibility: "PRIVATE",
      runtimeBindingId: PERSONAL_BINDING_ID,
    });
    expect(manager.getState().context).toEqual({
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "owner",
    });
  });

  it("prepares one installed turn and ConversationBoundary through the durable coordinator", async () => {
    const bindingInput = {
      conversationKey: "durable-installed-conversation",
      tenantId: OWNER.tenantId,
      ownerScope: "USER" as const,
      ownerId: OWNER.ownerId,
      deviceId: OWNER.deviceInstallationId,
      agentDefinitionId: OFFICIAL_DEFINITION_ID,
      agentVersionId: PERSONAL_VERSION_ID,
      agentInstallationId: PERSONAL_INSTALLATION_ID,
      runtimeProfileId: PERSONAL_PROFILE_ID,
      runtimeVersion: "v0.18.2-agentera.1",
      modelRoute: { provider: "openai", model: "gpt-5.6", baseUrl: "" },
      policySnapshotId: PERSONAL_POLICY_ID,
      officialReleaseRevisionId: null,
      toolPermissionDigest: "1".repeat(64),
      publishedBaseDigest: "2".repeat(64),
    };
    const plan = { bindingInput };
    const prepareInstalledTurnPlan = vi.fn(async () => plan);
    const finalizeInstalledTurn = vi.fn(
      (_plan: typeof plan, binding: { id: string }) => ({
        binding,
        profilePath: "/isolated/profile",
        resumeSessionId: undefined,
        envelope: {
          instructions: "fixed",
          requireBoundApiTransport: true,
        },
        modelOverride: bindingInput.modelRoute,
      }),
    );
    const { manager, database } = fullManager(
      () => ({
        scope: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
        role: "member",
      }),
      {},
      {
        verifyProfileBinding: () => ({
          agentInstallationId: PERSONAL_INSTALLATION_ID,
        }),
        hermesAdapter: {
          prepareInstalledTurnPlan,
          finalizeInstalledTurn,
        } as unknown as AgenteraHermesAdapter,
      },
    );
    const input = {
      conversationKey: bindingInput.conversationKey,
      profilePath: "/isolated/profile",
      owner: OWNER,
      resumeSessionId: null,
    };

    const prepared = await manager.prepareConversationRuntime(input);

    expect(prepareInstalledTurnPlan).toHaveBeenCalledWith(input);
    expect(finalizeInstalledTurn).toHaveBeenCalledOnce();
    expect(prepared.preparedAgentTurn?.binding.id).toBe(
      prepared.conversationBoundary.runtimeBindingId,
    );
    expect(prepared.conversationBoundary).toMatchObject({
      conversationKey: bindingInput.conversationKey,
      scopeType: "ORGANIZATION",
      scopeId: ORGANIZATION_ID,
      agentInstallationId: PERSONAL_INSTALLATION_ID,
      runtimeProfileId: PERSONAL_PROFILE_ID,
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

    const attached = manager.attachConversationRuntimeSession({
      runtimeBindingId: prepared.preparedAgentTurn?.binding.id ?? null,
      boundaryId: prepared.conversationBoundary.id,
      sessionId: "hermes-durable-session",
      owner: OWNER,
    });
    expect(attached.runtimeBinding?.hermesSessionId).toBe(
      "hermes-durable-session",
    );
    expect(attached.boundary.hermesSessionId).toBe("hermes-durable-session");
  });

  it.each([
    ["owner", true],
    ["admin", true],
    ["auditor", false],
    ["member", false],
  ] as const)("gates Organization draft authoring for %s", (role, allowed) => {
    const { manager } = fullManager(() => ({
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role,
    }));
    const operation = Promise.resolve().then(() =>
      manager.createDraft(draftInput()),
    );
    return allowed
      ? expect(operation).resolves.toMatchObject({ revision: 1 })
      : expect(operation).rejects.toMatchObject({
          code: "organization_agent_forbidden",
        });
  });

  it.each([
    ["owner", true, true, true],
    ["admin", true, true, true],
    ["auditor", false, true, false],
    ["member", false, false, true],
  ] as const)(
    "enforces Organization role %s for submit=%s history=%s install=%s",
    async (role, canSubmit, canReadHistory, canUseInstallations) => {
      const listOrganizationAgentSubmissions = vi.fn(async () => []);
      const { manager } = fullManager(
        () => ({
          scope: "ORGANIZATION",
          organizationId: ORGANIZATION_ID,
          role,
        }),
        { listOrganizationAgentSubmissions },
      );

      if (canSubmit) {
        const draft = manager.createDraft(draftInput());
        await expect(
          manager.prepareOrganizationSubmission(draft.id),
        ).resolves.toMatchObject({ draftId: draft.id, revision: 1 });
      } else {
        await expect(
          manager.prepareOrganizationSubmission(
            "30000000-0000-4000-8000-000000000001",
          ),
        ).rejects.toMatchObject({ code: "organization_agent_forbidden" });
      }

      const history = manager.listOrganizationSubmissions();
      if (canReadHistory) {
        await expect(history).resolves.toEqual([]);
        expect(listOrganizationAgentSubmissions).toHaveBeenCalledWith(
          ORGANIZATION_ID,
        );
      } else {
        await expect(history).rejects.toMatchObject({
          code: "organization_agent_forbidden",
        });
      }

      const installations = manager.listInstallations();
      if (canUseInstallations) {
        await expect(installations).resolves.toEqual([]);
      } else {
        await expect(installations).rejects.toMatchObject({
          code: "organization_agent_forbidden",
        });
      }
    },
  );

  it("invalidates Organization submission handles on trusted context changes", async () => {
    let context: AgenteraAgentControlContext = {
      scope: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
      role: "owner",
    };
    const submitOrganizationAgent = vi.fn();
    const { manager } = fullManager(() => context, {
      submitOrganizationAgent,
    });
    const draft = manager.createDraft(draftInput());
    const preview = await manager.prepareOrganizationSubmission(draft.id);

    context = {
      scope: "ORGANIZATION",
      organizationId: OTHER_ORGANIZATION_ID,
      role: "owner",
    };
    manager.notifyAgentContextChanged();
    await expect(
      manager.confirmOrganizationSubmission({
        publicationHandle: preview.publicationHandle,
        confirmation: "submit-organization-agent",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(submitOrganizationAgent).not.toHaveBeenCalled();
  });

  it("routes official catalog and install preparation through trusted main-process context", async () => {
    const listOfficialAgents = vi.fn(async () => [officialSummary()]);
    const getOfficialRelease = vi.fn(async () => officialSummary());
    const { manager } = fullManager(() => ({ scope: "USER" }), {
      listOfficialAgents,
      getOfficialRelease,
      getOfficialAgentChannel: () => "internal",
    });

    await expect(manager.listOfficialAgents()).resolves.toEqual([
      officialSummary(),
    ]);
    await expect(
      manager.prepareOfficialInstall(OFFICIAL_DEFINITION_ID),
    ).resolves.toMatchObject({
      agent: officialSummary(),
      expiresAt: expect.any(String),
      installHandle: expect.any(String),
    });
    expect(listOfficialAgents).toHaveBeenCalledOnce();
    expect(getOfficialRelease).toHaveBeenCalledWith(OFFICIAL_DEFINITION_ID);
  });

  it("keeps the runtime component identity independent of Product Space", () => {
    expect(runtimeComponentKey(OWNER)).toBe(
      [OWNER.tenantId, OWNER.ownerId, OWNER.deviceInstallationId].join("\0"),
    );
  });

  it("single-flights installation reconciliation only for authenticated online local Runtime access", async () => {
    let authState: AgenteraAuthPublicState = { status: "unauthenticated" };
    let connectionMode: "local" | "remote" | "ssh" = "local";
    let finishReconciliation!: () => void;
    const reconciliation = new Promise<never[]>((resolve) => {
      finishReconciliation = () => resolve([]);
    });
    const reconcilePendingInstallations = vi
      .spyOn(
        AgentInstallationManager.prototype,
        "reconcilePendingInstallations",
      )
      .mockReturnValue(reconciliation);
    const { manager } = fullManager(
      () => ({ scope: "USER" }),
      {},
      {
        getAuthState: () => authState,
        getConnectionMode: () => connectionMode,
      },
    );

    manager.notifyAccessStateChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconcilePendingInstallations).not.toHaveBeenCalled();

    authState = {
      status: "offline",
      userId: OWNER.ownerId,
      personalSpaceId: OWNER.tenantId,
      deviceId: OWNER.deviceInstallationId,
      offlineExpiresAt: "2026-07-28T00:00:00.000Z",
      cloudAvailable: false,
    };
    manager.notifyAccessStateChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconcilePendingInstallations).not.toHaveBeenCalled();

    authState = { ...authState, status: "authenticated", cloudAvailable: true };
    connectionMode = "remote";
    manager.notifyAccessStateChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reconcilePendingInstallations).not.toHaveBeenCalled();

    connectionMode = "local";
    manager.notifyAccessStateChanged();
    manager.notifyAccessStateChanged();
    await vi.waitFor(() => {
      expect(reconcilePendingInstallations).toHaveBeenCalledTimes(1);
    });

    finishReconciliation();
    await reconciliation;
    await Promise.resolve();
  });

  it("does not interrupt an already installed Hermes Profile turn", async () => {
    const prepared = {
      binding: { id: "30000000-0000-4000-8000-000000000001" },
      profilePath: "/local/hermes-profile",
      resumeSessionId: null,
      envelope: {
        instructions: "fixed",
        requireBoundApiTransport: true,
      },
    };
    const prepareInstalledTurn = vi.fn(async () => prepared);
    const manager = new AgenteraAgentControlManager({
      profileBindings: {
        verifyProfileBinding: vi.fn(() => ({
          tenantId: OWNER.tenantId,
          ownerScope: "USER",
          ownerId: OWNER.ownerId,
          deviceInstallationId: OWNER.deviceInstallationId,
          agentInstallationId: "40000000-0000-4000-8000-000000000001",
          runtimeProfileId: "50000000-0000-4000-8000-000000000001",
          boundAt: "2026-07-21T00:00:00.000Z",
        })),
      } as never,
      hermesAdapter: {
        prepareInstalledTurn,
      } as unknown as AgenteraHermesAdapter,
      getAgentContext: () => ({
        scope: "ORGANIZATION",
        organizationId: ORGANIZATION_ID,
        role: "member",
      }),
    });
    const input = {
      conversationKey: "existing-conversation",
      profilePath: "/local/hermes-profile",
      owner: OWNER,
      resumeSessionId: null,
    };

    await expect(manager.prepareHermesTurn(input)).resolves.toBe(prepared);
    expect(prepareInstalledTurn).toHaveBeenCalledWith(input);
  });
});
