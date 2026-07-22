// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgenteraAgentControlContext,
  CreateAgentDraftInput,
  OfficialAgentSummary,
} from "../../shared/agentera-agent-control";
import type { AgenteraAgentControlClient } from "./client";
import type { AgenteraHermesAdapter } from "./hermes-adapter";
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
          verifyProfileBinding: vi.fn(),
          bindFreshProfile: vi.fn(),
          claimProfile: vi.fn(),
        } as never,
        profiles: {
          createProfile: vi.fn(),
          resolveProfilePath: vi.fn(),
          activateProfile: vi.fn(),
        },
        userDataPath,
        getOwner: () => OWNER,
        getAgentContext: getContext,
        getAuthState: () => ({
          status: "authenticated",
          userId: OWNER.ownerId,
          personalSpaceId: OWNER.tenantId,
          deviceId: OWNER.deviceInstallationId,
          offlineExpiresAt: "2026-07-28T00:00:00.000Z",
          cloudAvailable: true,
        }),
        getRuntimeVersion: () => "v0.18.2-agentera.1",
        getConnectionMode: () => "local",
        assertEntitled: () => undefined,
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
