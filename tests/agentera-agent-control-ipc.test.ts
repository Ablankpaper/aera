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
  parseCreateDraftInput,
  parseInstallVersionInput,
  parsePrepareExperienceCandidateInput,
  parseReviewExperienceCandidateInput,
  parseSubmitExperienceCandidateInput,
  parseUpdateDraftInput,
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
    ]) {
      expect(AGENTERA_IPC_CHANNEL_POLICY[channel]).toBe("online");
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
    expect(start).toContain("getSelectedAgentContext");
    expect(start).toContain("subscribeSelectedAgentContext");
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
    ]) {
      expect(register.match(new RegExp(`"${channel}"`, "g"))).toHaveLength(1);
    }
  });
});
