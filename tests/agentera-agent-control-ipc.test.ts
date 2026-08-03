// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgenteraAgentControlClient } from "../src/main/agentera-agent-control/client";
import { AgenteraControlPlaneDatabase } from "../src/main/agentera-agent-control/db";
import {
  executeAgentControlIpc,
  parseAgentControlId,
  parseClaimVersionInput,
  parseConfirmExperienceCandidateImportInput,
  parseConfirmOfficialAgentInstallInput,
  parseConfirmOrganizationReviewInput,
  parseConfirmOrganizationSubmissionInput,
  parseConfirmOrganizationWithdrawalInput,
  parseCreateDraftInput,
  parseInstallVersionInput,
  parsePrepareExperienceCandidateInput,
  parsePrepareOrganizationReviewInput,
  parseReviewExperienceCandidateInput,
  parseSubmitExperienceCandidateInput,
  parseUpdateDraftInput,
  serializeOrganizationSubmissionDetail,
} from "../src/main/agentera-agent-control/ipc-contract";
import { AgenteraAgentControlManager } from "../src/main/agentera-agent-control/manager";
import {
  AGENTERA_IPC_CHANNEL_POLICY,
  createProductAccessGuard,
} from "../src/main/ipc/auth-guard";
import type { AgentEditableManifest } from "../src/shared/agentera-agent-control";

const UUID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

function manifest(): AgentEditableManifest {
  return {
    schemaVersion: 1,
    identity: { systemPrompt: "Safe IPC draft" },
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
  };
}

describe("Agent control IPC contract", () => {
  it("assigns local/offline-safe operations separately from online-only operations", () => {
    for (const channel of [
      "agentera-agents-get-state",
      "agentera-agents-list-drafts",
      "agentera-agents-get-draft",
      "agentera-agents-create-draft",
      "agentera-agents-update-draft",
      "agentera-agents-delete-draft",
      "agentera-agents-list-installations",
      "agentera-agents-list-eligible-experience-skills",
      "agentera-agents-prepare-experience-candidate",
      "agentera-agents-list-my-experience-candidates",
    ]) {
      expect(AGENTERA_IPC_CHANNEL_POLICY[channel]).toBe("authenticated");
    }
    for (const channel of [
      "agentera-agents-prepare-publication",
      "agentera-agents-confirm-publication",
      "agentera-agents-list-definitions",
      "agentera-agents-list-versions",
      "agentera-agents-install-version",
      "agentera-agents-claim-version",
      "agentera-agents-retry-installation",
      "agentera-agents-select-version",
      "agentera-agents-archive-installation",
      "agentera-agents-submit-experience-candidate",
      "agentera-agents-list-experience-review-queue",
      "agentera-agents-get-experience-candidate",
      "agentera-agents-review-experience-candidate",
      "agentera-agents-prepare-experience-candidate-import",
      "agentera-agents-confirm-experience-candidate-import",
      "agentera-agents-prepare-organization-submission",
      "agentera-agents-confirm-organization-submission",
      "agentera-agents-list-organization-submissions",
      "agentera-agents-get-organization-submission",
      "agentera-agents-prepare-organization-review",
      "agentera-agents-confirm-organization-review",
      "agentera-agents-prepare-organization-withdrawal",
      "agentera-agents-confirm-organization-withdrawal",
      "agentera-agents-list-official",
      "agentera-agents-prepare-official-install",
      "agentera-agents-confirm-official-install",
      "agentera-agents-refresh-official-updates",
      "agentera-agents-apply-official-update",
    ]) {
      expect(AGENTERA_IPC_CHANNEL_POLICY[channel]).toBe("online");
    }
  });

  it("accepts only bounded official Agent identifiers and the exact install handle confirmation", () => {
    expect(
      parseConfirmOfficialAgentInstallInput({
        installHandle: UUID,
        confirmation: "install-official-agent",
      }),
    ).toEqual({
      installHandle: UUID,
      confirmation: "install-official-agent",
    });
    expect(() =>
      parseConfirmOfficialAgentInstallInput({
        installHandle: UUID,
        confirmation: "yes",
      }),
    ).toThrow();

    for (const forbidden of [
      "ownerScope",
      "platformId",
      "userId",
      "deviceId",
      "role",
      "channel",
      "versionId",
      "releaseId",
      "releaseRevisionId",
      "profileName",
      "profilePath",
      "cloudOrigin",
      "accessToken",
      "signingKey",
      "policy",
      "manifest",
      "bundle",
      "memory",
      "session",
      "privateSkill",
      "localLearning",
    ]) {
      expect(() =>
        parseConfirmOfficialAgentInstallInput({
          installHandle: UUID,
          confirmation: "install-official-agent",
          [forbidden]: "forged",
        }),
      ).toThrow();
    }
  });

  it("validates UUIDs, revisions, exact fields, and bounded draft payloads again in main", () => {
    expect(parseAgentControlId(UUID)).toBe(UUID);
    expect(() => parseAgentControlId("not-an-id")).toThrow();
    const draft = {
      sourceAgentDefinitionId: null,
      baseAgentVersionId: null,
      displayName: "Research Agent",
      icon: null,
      manifest: manifest(),
      assets: [],
    };
    expect(parseCreateDraftInput(draft)).toEqual(draft);
    expect(() =>
      parseCreateDraftInput({ ...draft, unexpected: "private" }),
    ).toThrow();
    expect(() =>
      parseCreateDraftInput({
        ...draft,
        displayName: "x".repeat(4 * 1024 * 1024),
      }),
    ).toThrow();
    expect(
      parseUpdateDraftInput({
        id: UUID,
        expectedRevision: 3,
        displayName: draft.displayName,
        icon: null,
        manifest: manifest(),
        assets: [],
      }).expectedRevision,
    ).toBe(3);
    expect(() =>
      parseUpdateDraftInput({
        id: UUID,
        expectedRevision: 0,
        displayName: draft.displayName,
        icon: null,
        manifest: manifest(),
        assets: [],
      }),
    ).toThrow();
  });

  it("requires an explicit exact confirmation before an existing Profile can be claimed", () => {
    expect(
      parseClaimVersionInput({
        definitionId: UUID,
        versionId: VERSION_ID,
        localProfileId: "research-profile",
        confirmation: "claim-existing-profile",
      }),
    ).toEqual({
      definitionId: UUID,
      versionId: VERSION_ID,
      localProfileId: "research-profile",
      confirmation: "claim-existing-profile",
    });
    expect(() =>
      parseClaimVersionInput({
        definitionId: UUID,
        versionId: VERSION_ID,
        localProfileId: "research-profile",
        confirmation: "yes",
      }),
    ).toThrow();
    expect(() =>
      parseClaimVersionInput({
        definitionId: UUID,
        versionId: VERSION_ID,
        localProfileId: "../other-owner",
        confirmation: "claim-existing-profile",
      }),
    ).toThrow();
    expect(() =>
      parseInstallVersionInput({
        definitionId: UUID,
        versionId: VERSION_ID,
        profileName: "research-profile",
        workspaceId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toThrow();
  });

  it("accepts only the reviewed ExperienceCandidate IPC fields", () => {
    expect(
      parsePrepareExperienceCandidateInput({
        installationId: UUID,
        skillName: "weekly-summary",
      }),
    ).toEqual({ installationId: UUID, skillName: "weekly-summary" });
    expect(
      parseSubmitExperienceCandidateInput({
        candidateId: UUID,
        confirmation: "submit-selected-skill",
      }),
    ).toEqual({
      candidateId: UUID,
      confirmation: "submit-selected-skill",
    });
    expect(
      parseReviewExperienceCandidateInput({
        candidateId: UUID,
        decision: "REJECTED",
        reasonCode: "not_reusable",
        safeNote: "Needs a reusable template.",
      }),
    ).toEqual({
      candidateId: UUID,
      decision: "REJECTED",
      reasonCode: "not_reusable",
      safeNote: "Needs a reusable template.",
    });
    expect(
      parseReviewExperienceCandidateInput({
        candidateId: UUID,
        decision: "APPROVED",
        reasonCode: null,
        safeNote: null,
      }),
    ).toEqual({
      candidateId: UUID,
      decision: "APPROVED",
      reasonCode: null,
      safeNote: null,
    });
    for (const privateField of [
      "workspaceId",
      "ownerId",
      "deviceId",
      "profilePath",
      "runtimeProfileId",
      "sourceRelativePath",
    ]) {
      expect(() =>
        parsePrepareExperienceCandidateInput({
          installationId: UUID,
          skillName: "weekly-summary",
          [privateField]: "private",
        }),
      ).toThrow();
    }
    expect(() =>
      parseSubmitExperienceCandidateInput({
        candidateId: UUID,
        confirmation: "yes",
      }),
    ).toThrow();
    expect(() =>
      parseReviewExperienceCandidateInput({
        candidateId: UUID,
        decision: "APPROVED",
        reasonCode: "unexpected",
        safeNote: null,
      }),
    ).toThrow();
    expect(() =>
      parseReviewExperienceCandidateInput({
        candidateId: UUID,
        decision: "REJECTED",
        reasonCode: "not_reusable",
        safeNote: "private\nsecond line",
      }),
    ).toThrow();
  });

  it("accepts only the experience candidate import handle and exact confirmation", () => {
    expect(
      parseConfirmExperienceCandidateImportInput({
        importHandle: UUID,
        confirmation: "apply-approved-skill-to-latest",
      }),
    ).toEqual({
      importHandle: UUID,
      confirmation: "apply-approved-skill-to-latest",
    });
    expect(() =>
      parseConfirmExperienceCandidateImportInput({
        importHandle: UUID,
        confirmation: "yes",
      }),
    ).toThrow();
    for (const privateField of [
      "workspaceId",
      "ownerScope",
      "profilePath",
      "sourceRelativePath",
      "candidateSnapshot",
    ]) {
      expect(() =>
        parseConfirmExperienceCandidateImportInput({
          importHandle: UUID,
          confirmation: "apply-approved-skill-to-latest",
          [privateField]: "private",
        }),
      ).toThrow();
    }
  });

  it("accepts only handle-based Organization submission mutations", () => {
    expect(
      parseConfirmOrganizationSubmissionInput({
        publicationHandle: UUID,
        confirmation: "submit-organization-agent",
      }),
    ).toEqual({
      publicationHandle: UUID,
      confirmation: "submit-organization-agent",
    });
    expect(
      parsePrepareOrganizationReviewInput({
        submissionId: UUID,
        decision: "reject",
        reasonCode: "needs_revision",
        safeNote: "Remove the unsupported tool.",
      }),
    ).toEqual({
      submissionId: UUID,
      decision: "reject",
      reasonCode: "needs_revision",
      safeNote: "Remove the unsupported tool.",
    });
    expect(
      parseConfirmOrganizationReviewInput({
        reviewHandle: UUID,
        confirmation: "approve-organization-agent",
      }),
    ).toEqual({
      reviewHandle: UUID,
      confirmation: "approve-organization-agent",
    });
    expect(
      parseConfirmOrganizationWithdrawalInput({
        withdrawalHandle: UUID,
        confirmation: "withdraw-organization-agent",
      }),
    ).toEqual({
      withdrawalHandle: UUID,
      confirmation: "withdraw-organization-agent",
    });

    for (const privateField of [
      "organizationId",
      "role",
      "ownerScope",
      "actorUserId",
      "expectedRevision",
      "profilePath",
      "runtimeProfileId",
      "accessToken",
    ]) {
      expect(() =>
        parseConfirmOrganizationSubmissionInput({
          publicationHandle: UUID,
          confirmation: "submit-organization-agent",
          [privateField]: "forged",
        }),
      ).toThrow();
      expect(() =>
        parseConfirmOrganizationReviewInput({
          reviewHandle: UUID,
          confirmation: "approve-organization-agent",
          [privateField]: "forged",
        }),
      ).toThrow();
      expect(() =>
        parseConfirmOrganizationWithdrawalInput({
          withdrawalHandle: UUID,
          confirmation: "withdraw-organization-agent",
          [privateField]: "forged",
        }),
      ).toThrow();
    }
  });

  it("serializes an Organization review package field by field", () => {
    const secret = "must-not-cross-organization-ipc";
    const detail = {
      summary: {
        id: UUID,
        organizationId: VERSION_ID,
        kind: "initial",
        definitionId: "33333333-3333-4333-8333-333333333333",
        baseVersionId: null,
        submittedByUserId: "44444444-4444-4444-8444-444444444444",
        contentDigest: "ab".repeat(32),
        status: "pending",
        revision: 1,
        submittedAt: "2026-07-21T00:00:00.000Z",
        terminalAt: null,
        review: null,
      },
      displayName: "Organization Research Agent",
      icon: null,
      manifest: {
        schema_version: 1,
        identity: { system_prompt: "Research safely." },
        assets: [
          {
            path: "knowledge/notes.md",
            kind: "knowledge",
            media_type: "text/markdown",
            sha256: "cd".repeat(32),
          },
        ],
        model_constraints: {
          allowed_providers: ["openai"],
          allowed_models: ["gpt-5.6"],
        },
        tools: { allowed: ["files.read"], denied: [] },
        dependencies: [],
        runtime_compatibility: {
          minimum_version: "v0.18.2-agentera.1",
          maximum_version_exclusive: null,
        },
      },
      bundle: {
        assets: [{ path: "knowledge/notes.md", content: "# Notes\n" }],
      },
      manifestDigest: "ef".repeat(32),
      bundleDigest: "12".repeat(32),
      assetCounts: { skill: 0, sop: 0, knowledge: 1 },
      totalBytes: 8,
      accessToken: secret,
      profilePath: `/private/${secret}`,
      organizationPolicyBytes: secret,
    } as unknown as Parameters<typeof serializeOrganizationSubmissionDetail>[0];

    const serialized = serializeOrganizationSubmissionDetail(detail);
    expect(serialized).toMatchObject({
      displayName: "Organization Research Agent",
      systemPrompt: "Research safely.",
      assets: [
        {
          path: "knowledge/notes.md",
          kind: "knowledge",
          mediaType: "text/markdown",
          content: "# Notes\n",
          sizeBytes: 8,
        },
      ],
    });
    expect(JSON.stringify(serialized)).not.toContain(secret);
    expect(serialized).not.toHaveProperty("accessToken");
    expect(serialized).not.toHaveProperty("profilePath");
    expect(serialized).not.toHaveProperty("organizationPolicyBytes");
  });

  it("maps failures to stable codes without returning cloud bodies, paths, or private messages", async () => {
    const error = Object.assign(
      new Error(
        'POST /private/profile failed: {"access_token":"secret-value"}',
      ),
      { code: "service_unavailable", responseText: "private cloud body" },
    );
    await expect(
      executeAgentControlIpc(async () => {
        throw error;
      }),
    ).resolves.toEqual({ ok: false, errorCode: "cloud_unavailable" });
  });

  it("returns only bounded ExperienceCandidate DLP finding metadata", async () => {
    const secret = "sk-proj-ipc-secret-must-not-leak-123456789";
    const result = await executeAgentControlIpc(async () => {
      throw Object.assign(new Error(secret), {
        code: "candidate_dlp_blocked",
        findings: [
          {
            code: "credential_api_key",
            path: "skills/weekly-summary/SKILL.md",
            line: 4,
            evidence: secret,
          },
          {
            code: "private_absolute_path",
            path: "C:/Users/Alice/private-profile/SKILL.md",
            line: 1,
            evidence: secret,
          },
        ],
      });
    });
    expect(result).toEqual({
      ok: false,
      errorCode: "candidate_dlp_blocked",
      findings: [
        {
          code: "credential_api_key",
          path: "skills/weekly-summary/SKILL.md",
          line: 4,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    "workspace_forbidden",
    "workspace_archived",
    "workspace_owner_unavailable",
  ] as const)("preserves the stable %s Workspace error", async (code) => {
    await expect(
      executeAgentControlIpc(async () => {
        throw Object.assign(new Error("private Workspace failure"), { code });
      }),
    ).resolves.toEqual({ ok: false, errorCode: code });
  });

  it.each([
    "organization_agent_not_found",
    "organization_agent_forbidden",
    "organization_archived",
    "organization_submission_conflict",
    "organization_submission_superseded",
    "organization_publication_policy_blocked",
  ] as const)("preserves stable Organization error %s", async (code) => {
    await expect(
      executeAgentControlIpc(async () => {
        throw Object.assign(new Error("private Organization failure"), {
          code,
        });
      }),
    ).resolves.toEqual({ ok: false, errorCode: code });
  });

  it.each([
    "official_agent_not_eligible",
    "official_release_paused",
    "official_client_version_unsupported",
    "official_installation_policy_blocked",
  ] as const)("preserves stable Official Agent error %s", async (code) => {
    await expect(
      executeAgentControlIpc(async () => {
        throw Object.assign(new Error("private official release failure"), {
          code,
        });
      }),
    ).resolves.toEqual({ ok: false, errorCode: code });
  });

  it.each([
    ["official_install_handle_invalid", "invalid_request"],
    ["official_release_changed", "conflict"],
  ] as const)("maps %s to bounded error %s", async (code, expected) => {
    await expect(
      executeAgentControlIpc(async () => {
        throw Object.assign(new Error("private official state"), { code });
      }),
    ).resolves.toEqual({ ok: false, errorCode: expected });
  });

  it("returns bounded Organization DLP findings for non-private asset paths", async () => {
    const secret = "organization-dlp-evidence-must-not-leak";
    const result = await executeAgentControlIpc(async () => {
      throw Object.assign(new Error(secret), {
        code: "organization_publication_dlp_blocked",
        findings: [
          {
            code: "credential_api_key",
            path: "knowledge/notes.md",
            line: 2,
            evidence: secret,
          },
          {
            code: "private_absolute_path",
            path: "/Users/private/Profile/MEMORY.md",
            line: 1,
            evidence: secret,
          },
        ],
      });
    });
    expect(result).toEqual({
      ok: false,
      errorCode: "organization_publication_dlp_blocked",
      findings: [
        {
          code: "credential_api_key",
          path: "knowledge/notes.md",
          line: 2,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("maps central online-access denial inside the safe Agent result envelope", async () => {
    const guard = createProductAccessGuard({
      getAuthState: () => ({
        status: "offline",
        userId: UUID,
        personalSpaceId: VERSION_ID,
        deviceId: "33333333-3333-4333-8333-333333333333",
        offlineExpiresAt: "2026-07-25T00:00:00.000Z",
        cloudAvailable: false,
      }),
      isRuntimeContextBound: () => false,
    });

    await expect(
      executeAgentControlIpc(() => {
        guard.assert("online");
        return true;
      }),
    ).resolves.toEqual({ ok: false, errorCode: "online_required" });
  });

  it("rejects Profile installation outside local Runtime mode before any cloud request", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentera-agent-ipc-"));
    const database = new AgenteraControlPlaneDatabase(
      {
        rootPath: root,
        databasePath: join(root, "control-plane.db"),
        draftsPath: join(root, "drafts"),
        versionsPath: join(root, "versions"),
        projectionsPath: join(root, "projections"),
      },
      {
        exec: () => undefined,
        prepare: () => ({
          all: () => [],
          get: () => undefined,
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
        }),
        close: () => undefined,
      },
    );
    const getSigningKeys = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const manager = new AgenteraAgentControlManager({
      database,
      client: {
        origin: "https://cloud.agentera.test",
        getSigningKeys,
      } as unknown as AgenteraAgentControlClient,
      profileBindings: {} as never,
      profiles: {} as never,
      userDataPath: root,
      getOwner: () => ({
        tenantId: UUID,
        ownerId: VERSION_ID,
        deviceInstallationId: "33333333-3333-4333-8333-333333333333",
      }),
      getAuthState: () => ({
        status: "authenticated",
        userId: VERSION_ID,
        personalSpaceId: UUID,
        deviceId: "44444444-4444-4444-8444-444444444444",
        offlineExpiresAt: "2026-07-25T00:00:00.000Z",
        cloudAvailable: true,
      }),
      getRuntimeVersion: () => "v0.18.2-agentera.1",
      getConnectionMode: () => "remote",
      assertEntitled: () => undefined,
    });

    try {
      await expect(
        manager.installVersion({
          definitionId: UUID,
          versionId: VERSION_ID,
          profileName: "isolated-agent",
        }),
      ).rejects.toMatchObject({ code: "local_runtime_required" });
      expect(getSigningKeys).not.toHaveBeenCalled();
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[agentera-agent-control-plane#Trusted Workspace Agent context#Context-only refresh]]
  it("consumes publication confirmation handles before the cloud action and constructs one app-level manager", () => {
    const manager = readFileSync(
      join(__dirname, "../src/main/agentera-agent-control/manager.ts"),
      "utf8",
    );
    const confirm = manager.slice(
      manager.indexOf("async confirmPublication"),
      manager.indexOf("async listDefinitions"),
    );
    expect(confirm.indexOf("publicationOwners.delete(handle)")).toBeLessThan(
      confirm.indexOf("publisher.confirmPublication(handle)"),
    );

    const start = readFileSync(
      join(__dirname, "../src/main/app/start.ts"),
      "utf8",
    );
    expect(start.match(/new AgenteraAgentControlManager\(/g)).toHaveLength(1);
    expect(start).toContain("agenteraAgentControl,");
    expect(start).toContain("agenteraProductSpace?.getAgentContext()");
    expect(start).toContain("agenteraProductSpace?.subscribe");
    expect(start).not.toContain("getSelectedAgentContext");
    expect(start).not.toContain("subscribeSelectedAgentContext");
    expect(start).toContain("notifyAgentContextChanged");
  });

  it("uses a removable event listener and suppresses delivery to destroyed renderers", () => {
    const preload = readFileSync(
      join(__dirname, "../src/preload/index.ts"),
      "utf8",
    );
    const register = readFileSync(
      join(__dirname, "../src/main/ipc/register.ts"),
      "utf8",
    );
    const namespace = preload.slice(
      preload.indexOf("const agenteraAgentsAPI"),
      preload.indexOf("if (process.contextIsolated)"),
    );
    expect(namespace).toContain(
      'ipcRenderer.removeListener("agentera-agents-state-changed", handler)',
    );
    expect(register).toContain("agentera-agents-state-changed");
    expect(register).toMatch(
      /agentera-agents-state-changed[\s\S]*?isDestroyed\(\)/,
    );
    const registrations = register.slice(
      register.indexOf('"agentera-agents-get-state"'),
      register.indexOf("const mainWindow = getMainWindow()"),
    );
    expect(registrations).toContain("registerAgentControlHandler");
    expect(registrations).not.toContain("ipcMain.handle");
    for (const channel of [
      "agentera-agents-list-eligible-experience-skills",
      "agentera-agents-prepare-experience-candidate",
      "agentera-agents-submit-experience-candidate",
      "agentera-agents-list-my-experience-candidates",
      "agentera-agents-list-experience-review-queue",
      "agentera-agents-get-experience-candidate",
      "agentera-agents-review-experience-candidate",
      "agentera-agents-prepare-experience-candidate-import",
      "agentera-agents-confirm-experience-candidate-import",
      "agentera-agents-prepare-organization-submission",
      "agentera-agents-confirm-organization-submission",
      "agentera-agents-list-organization-submissions",
      "agentera-agents-get-organization-submission",
      "agentera-agents-prepare-organization-review",
      "agentera-agents-confirm-organization-review",
      "agentera-agents-prepare-organization-withdrawal",
      "agentera-agents-confirm-organization-withdrawal",
      "agentera-agents-list-official",
      "agentera-agents-prepare-official-install",
      "agentera-agents-confirm-official-install",
      "agentera-agents-refresh-official-updates",
      "agentera-agents-apply-official-update",
    ]) {
      expect(register.match(new RegExp(`"${channel}"`, "g"))).toHaveLength(1);
    }
  });

  it("routes conversation setup and session attachment through the durable coordinator", () => {
    const register = readFileSync(
      join(__dirname, "../src/main/ipc/register.ts"),
      "utf8",
    );
    const contextHandler = register.slice(
      register.indexOf('"agentera-global-profile-conversation-context"'),
      register.indexOf('ipcMain.handle("stop-ssh-tunnel"'),
    );
    expect(contextHandler).toContain("prepareConversationRuntime");
    expect(contextHandler).not.toContain("prepareHermesTurn");
    expect(contextHandler).not.toContain("prepareConversationBoundary");

    const sendMessageHandler = register.slice(
      register.indexOf('ipcMain.handle(\n    "send-message"'),
      register.indexOf('ipcMain.handle(\n    "abort-chat"'),
    );
    expect(sendMessageHandler).toContain("prepareConversationRuntime");
    expect(sendMessageHandler).toContain("attachConversationRuntimeSession");
    expect(sendMessageHandler).not.toContain("prepareHermesTurn");
    expect(sendMessageHandler).not.toContain("prepareConversationBoundary");
    expect(sendMessageHandler).not.toContain("attachHermesSession(");
    expect(sendMessageHandler).not.toContain(
      "attachConversationBoundarySession(",
    );
  });
});
