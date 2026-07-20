import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "playwright/test";

import type {
  AgentDraftDetail,
  AgenteraAgentControlPublicState,
  AgenteraAgentControlResult,
  EligibleExperienceSkill,
  ExperienceCandidateDetail,
  ExperienceCandidateImportPreview,
  ExperienceCandidatePreview,
  ExperienceCandidateSummary,
  PublicationPreview,
  PublishedRevision,
} from "../../src/shared/agentera-agent-control";
import type {
  AgenteraWorkspaceResult,
  WorkspaceInvitationAcceptance,
  WorkspaceInvitationCreation,
  WorkspaceMember,
  WorkspacePublicState,
  WorkspaceSummary,
} from "../../src/shared/agentera-workspace";
import {
  agentControlExchangeDiagnostics,
  agentControlRequests,
  authenticateExistingAgentControlDevice,
  authenticateFirstAgentControlDevice,
  claimDefaultProfile,
  closeAgentControlHarness,
  cloudAgentControlCounts,
  cloudExperienceCandidateCounts,
  createAgentControlHarness,
  deviceProcessDiagnostics,
  deviceProfilePath,
  failNextAgentControlRequest,
  invokeAgentera,
  launchAgentControlDevice,
  localAgentControlState,
  privateProfileSnapshot,
  seedExperienceCandidateProfile,
  startBoundConversation,
  type AgentControlDevice,
  type AgentControlHarness,
} from "./support/agentera-agent-control-harness";

const OWNER_PHONE = "+8613900000051";
const ADMIN_PHONE = "+8613900000052";
const MEMBER_ONE_PHONE = "+8613900000053";
const MEMBER_TWO_PHONE = "+8613900000054";
const MEMBER_PROFILE = "experience-member-agent";
const IMPORT_FAILURE_TRIGGER = "e2e_fail_experience_candidate_import";

type WorkspaceMethod =
  | "getState"
  | "refresh"
  | "select"
  | "create"
  | "listMembers"
  | "changeMemberRole"
  | "createInvitation"
  | "acceptInvitation";

let harness: AgentControlHarness | null = null;
let deviceA: AgentControlDevice | null = null;
let deviceB: AgentControlDevice | null = null;

test.setTimeout(360_000);

function diagnosticContext(): string {
  return JSON.stringify({
    exchanges: harness ? agentControlExchangeDiagnostics(harness) : [],
    processes: [
      ...deviceProcessDiagnostics(deviceA),
      ...deviceProcessDiagnostics(deviceB),
    ],
  });
}

function unwrapAgent<T>(result: AgenteraAgentControlResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `ExperienceCandidate operation failed: ${result.errorCode}; ${diagnosticContext()}`,
    );
  }
  return result.data;
}

function unwrapWorkspace<T>(result: AgenteraWorkspaceResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Workspace operation failed: ${result.errorCode}; ${diagnosticContext()}`,
    );
  }
  return result.value;
}

async function invokeWorkspace<T>(
  device: AgentControlDevice,
  method: WorkspaceMethod,
  ...args: unknown[]
): Promise<AgenteraWorkspaceResult<T>> {
  return device.page.evaluate(
    async ({ requestedMethod, requestedArgs }) => {
      const api = window.agenteraWorkspace as unknown as Record<
        string,
        (...parameters: unknown[]) => Promise<unknown>
      >;
      return api[requestedMethod](...requestedArgs) as Promise<
        AgenteraWorkspaceResult<T>
      >;
    },
    { requestedMethod: method, requestedArgs: args },
  );
}

async function resetBrowserIdentity(
  harnessValue: AgentControlHarness,
): Promise<void> {
  await harnessValue.browserPage.context().close();
  harnessValue.browserPage = await (
    await harnessValue.browser.newContext({ locale: "en-US" })
  ).newPage();
}

async function logout(device: AgentControlDevice): Promise<void> {
  await device.page.evaluate(() => window.agenteraAuth.logout());
  await expect(device.page.locator('[data-testid="screen-auth"]')).toBeVisible({
    timeout: 180_000,
  });
}

async function waitForAgentContext(
  device: AgentControlDevice,
  expected: AgenteraAgentControlPublicState["context"],
): Promise<void> {
  await expect
    .poll(async () => {
      const result = await invokeAgentera<AgenteraAgentControlPublicState>(
        device,
        "getState",
      );
      return result.ok ? result.data.context : null;
    })
    .toEqual(expected);
}

async function invitation(
  device: AgentControlDevice,
  workspaceId: string,
): Promise<string> {
  const created = unwrapWorkspace(
    await invokeWorkspace<WorkspaceInvitationCreation>(
      device,
      "createInvitation",
      { workspaceId },
    ),
  );
  if (!created.token) throw new Error("Invitation secret is unavailable.");
  return created.token;
}

async function acceptAndSelect(
  device: AgentControlDevice,
  workspaceId: string,
  token: string,
): Promise<void> {
  unwrapWorkspace(
    await invokeWorkspace<WorkspaceInvitationAcceptance>(
      device,
      "acceptInvitation",
      { token },
    ),
  );
  unwrapWorkspace(
    await invokeWorkspace<WorkspacePublicState>(device, "select", {
      workspaceId,
    }),
  );
}

function workspaceDraft(): Parameters<
  typeof invokeAgentera<AgentDraftDetail>
>[2] {
  return {
    sourceAgentDefinitionId: null,
    baseAgentVersionId: null,
    displayName: "Evolving Workspace research Agent",
    icon: null,
    manifest: {
      schemaVersion: 1,
      identity: {
        systemPrompt: "Use only explicitly reviewed Workspace assets.",
      },
      assets: [
        {
          path: "skills/base-research/SKILL.md",
          kind: "skill",
          mediaType: "text/markdown",
        },
      ],
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
    assets: [
      {
        path: "skills/base-research/SKILL.md",
        content:
          "---\nname: base-research\ndescription: Workspace version one base\n---\n\n# Base research\n",
      },
    ],
  };
}

async function publish(
  device: AgentControlDevice,
  draftId: string,
): Promise<PublishedRevision> {
  const preview = unwrapAgent(
    await invokeAgentera<PublicationPreview>(
      device,
      "preparePublication",
      draftId,
    ),
  );
  expect(preview.targetScope).toBe("WORKSPACE");
  return unwrapAgent(
    await invokeAgentera<PublishedRevision>(
      device,
      "confirmPublication",
      preview.publicationHandle,
    ),
  );
}

function setImportFailure(device: AgentControlDevice, enabled: boolean): void {
  const database = new DatabaseSync(
    join(device.userData, "agentera-control-plane", "control-plane.db"),
  );
  try {
    database.exec(`DROP TRIGGER IF EXISTS ${IMPORT_FAILURE_TRIGGER}`);
    if (enabled) {
      database.exec(`
        CREATE TRIGGER ${IMPORT_FAILURE_TRIGGER}
        BEFORE INSERT ON local_experience_candidate_imports
        BEGIN
          SELECT RAISE(ABORT, 'injected ExperienceCandidate import failure');
        END;
      `);
    }
  } finally {
    database.close();
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test.beforeAll(async () => {
  harness = await createAgentControlHarness();
});

test.afterAll(async () => {
  if (deviceB) setImportFailure(deviceB, false);
  await closeAgentControlHarness(harness);
  harness = null;
  deviceA = null;
  deviceB = null;
});

// @lat: [[agentera-self-evolution#Release gate#Controlled promotion boundary]]
// @lat: [[agentera-agent-control-plane#Release gate#ExperienceCandidate boundary]]
test("promotes only an explicitly selected Skill into v2 while private learning and v1 conversations remain local", async () => {
  if (!harness)
    throw new Error("ExperienceCandidate E2E harness is unavailable.");

  harness.phone = OWNER_PHONE;
  deviceA = await launchAgentControlDevice(harness, "A");
  await authenticateFirstAgentControlDevice(harness, deviceA);
  await claimDefaultProfile(deviceA);

  await resetBrowserIdentity(harness);
  harness.phone = ADMIN_PHONE;
  deviceB = await launchAgentControlDevice(harness, "B");
  await authenticateFirstAgentControlDevice(harness, deviceB);
  await claimDefaultProfile(deviceB);

  const workspace = unwrapWorkspace(
    await invokeWorkspace<WorkspaceSummary>(deviceA, "create", {
      displayName: "ExperienceCandidate E2E",
    }),
  );
  const adminToken = await invitation(deviceA, workspace.id);
  await acceptAndSelect(deviceB, workspace.id, adminToken);
  unwrapWorkspace(
    await invokeWorkspace<WorkspacePublicState>(deviceA, "select", {
      workspaceId: workspace.id,
    }),
  );
  const members = unwrapWorkspace(
    await invokeWorkspace<readonly WorkspaceMember[]>(deviceA, "listMembers", {
      workspaceId: workspace.id,
    }),
  );
  const adminMember = members.find((member) => member.role === "member");
  if (!adminMember) throw new Error("Admin fixture member is unavailable.");
  unwrapWorkspace(
    await invokeWorkspace<WorkspaceMember>(deviceA, "changeMemberRole", {
      workspaceId: workspace.id,
      userId: adminMember.userId,
      role: "admin",
      expectedRevision: adminMember.revision,
    }),
  );
  unwrapWorkspace(
    await invokeWorkspace<WorkspacePublicState>(deviceB, "refresh"),
  );
  await waitForAgentContext(deviceB, {
    scope: "WORKSPACE",
    workspaceId: workspace.id,
    role: "admin",
  });

  const initialDraft = unwrapAgent(
    await invokeAgentera<AgentDraftDetail>(
      deviceA,
      "createDraft",
      workspaceDraft(),
    ),
  );
  const versionOne = await publish(deviceA, initialDraft.id);
  expect(versionOne.versionNumber).toBe(1);

  const memberOneToken = await invitation(deviceB, workspace.id);
  const memberTwoToken = await invitation(deviceB, workspace.id);

  await logout(deviceA);
  await resetBrowserIdentity(harness);
  harness.phone = MEMBER_ONE_PHONE;
  await authenticateFirstAgentControlDevice(harness, deviceA);
  await claimDefaultProfile(deviceA);
  await acceptAndSelect(deviceA, workspace.id, memberOneToken);
  await waitForAgentContext(deviceA, {
    scope: "WORKSPACE",
    workspaceId: workspace.id,
    role: "member",
  });

  const installation = unwrapAgent(
    await invokeAgentera(deviceA, "installVersion", {
      definitionId: versionOne.definitionId,
      versionId: versionOne.versionId,
      profileName: MEMBER_PROFILE,
    }),
  ) as { id: string; runtimeProfileId: string | null };
  expect(installation.runtimeProfileId).not.toBeNull();
  const memberProfile = deviceProfilePath(deviceA, MEMBER_PROFILE);
  await startBoundConversation(deviceA, MEMBER_PROFILE, "experience-v1");
  await expect
    .poll(async () => (await localAgentControlState(deviceA!)).bindings.length)
    .toBe(1);

  const fixture = await seedExperienceCandidateProfile(memberProfile);
  const privateBefore = await privateProfileSnapshot(
    memberProfile,
    fixture.privateMarkers,
  );
  const eligible = unwrapAgent(
    await invokeAgentera<EligibleExperienceSkill[]>(
      deviceA,
      "listEligibleExperienceSkills",
      installation.id,
    ),
  );
  expect(eligible.map(({ skillName }) => skillName).sort()).toEqual(
    [
      fixture.selectedSkillName,
      fixture.unsafeSkillName,
      fixture.unselectedSkillName,
    ].sort(),
  );

  const candidatePostsBeforeUnsafe = agentControlRequests(harness).filter(
    (request) =>
      request.method === "POST" &&
      request.path.endsWith("/experience-candidates"),
  ).length;
  const blocked = await invokeAgentera<ExperienceCandidatePreview>(
    deviceA,
    "prepareExperienceCandidate",
    {
      installationId: installation.id,
      skillName: fixture.unsafeSkillName,
    },
  );
  expect(blocked).toMatchObject({
    ok: false,
    errorCode: "candidate_dlp_blocked",
    findings: [expect.objectContaining({ code: "credential_api_key" })],
  });
  expect(
    agentControlRequests(harness).filter(
      (request) =>
        request.method === "POST" &&
        request.path.endsWith("/experience-candidates"),
    ),
  ).toHaveLength(candidatePostsBeforeUnsafe);
  expect(await cloudExperienceCandidateCounts(harness)).toEqual({
    candidates: 0,
    reviews: 0,
  });

  const prepared = unwrapAgent(
    await invokeAgentera<ExperienceCandidatePreview>(
      deviceA,
      "prepareExperienceCandidate",
      {
        installationId: installation.id,
        skillName: fixture.selectedSkillName,
      },
    ),
  );
  expect(prepared).toMatchObject({
    installationId: installation.id,
    sourceAgentVersionId: versionOne.versionId,
    skillName: fixture.selectedSkillName,
    findings: [],
    fileCount: 2,
  });

  const submitPath = `/api/v1/workspaces/${workspace.id}/agent-definitions/${versionOne.definitionId}/experience-candidates`;
  failNextAgentControlRequest(harness, submitPath);
  const failedUpload = await invokeAgentera<ExperienceCandidateSummary>(
    deviceA,
    "submitExperienceCandidate",
    {
      candidateId: prepared.localCandidateId,
      confirmation: "submit-selected-skill",
    },
  );
  expect(failedUpload).toEqual({ ok: false, errorCode: "cloud_unavailable" });
  expect(
    await privateProfileSnapshot(memberProfile, fixture.privateMarkers),
  ).toEqual(privateBefore);
  expect(await cloudExperienceCandidateCounts(harness)).toEqual({
    candidates: 0,
    reviews: 0,
  });

  const submitted = unwrapAgent(
    await invokeAgentera<ExperienceCandidateSummary>(
      deviceA,
      "submitExperienceCandidate",
      {
        candidateId: prepared.localCandidateId,
        confirmation: "submit-selected-skill",
      },
    ),
  );
  expect(submitted).toMatchObject({
    localCandidateId: prepared.localCandidateId,
    skillName: fixture.selectedSkillName,
    contentDigest: prepared.contentDigest,
    localStatus: "SUBMITTED",
    reviewStatus: "PENDING_REVIEW",
  });
  if (!submitted.cloudCandidateId) {
    throw new Error("Submitted cloud candidate ID is unavailable.");
  }
  const ownCandidates = unwrapAgent(
    await invokeAgentera<ExperienceCandidateSummary[]>(
      deviceA,
      "listMyExperienceCandidates",
    ),
  );
  expect(ownCandidates).toEqual([
    expect.objectContaining({
      cloudCandidateId: submitted.cloudCandidateId,
      skillName: fixture.selectedSkillName,
    }),
  ]);

  const candidateSubmissions = agentControlRequests(harness).filter(
    (request) => request.method === "POST" && request.path === submitPath,
  );
  expect(candidateSubmissions).toHaveLength(2);
  for (const request of candidateSubmissions) {
    expect(Object.keys(request.body as Record<string, unknown>).sort()).toEqual(
      ["bundle", "content_digest", "source_version_id"],
    );
    expect(request.body).toEqual({
      source_version_id: versionOne.versionId,
      content_digest: prepared.contentDigest,
      bundle: {
        schema_version: 1,
        skill_name: fixture.selectedSkillName,
        assets: [
          expect.objectContaining({
            path: `skills/${fixture.selectedSkillName}/SKILL.md`,
            media_type: "text/markdown",
          }),
          expect.objectContaining({
            path: `skills/${fixture.selectedSkillName}/references/checklist.md`,
            media_type: "text/markdown",
          }),
        ],
      },
    });
    expect(JSON.stringify(request.body)).toContain(fixture.selectedMarker);
  }

  await logout(deviceA);
  await resetBrowserIdentity(harness);
  harness.phone = MEMBER_TWO_PHONE;
  await authenticateFirstAgentControlDevice(harness, deviceA);
  await claimDefaultProfile(deviceA);
  await acceptAndSelect(deviceA, workspace.id, memberTwoToken);
  await waitForAgentContext(deviceA, {
    scope: "WORKSPACE",
    workspaceId: workspace.id,
    role: "member",
  });
  expect(
    unwrapAgent(
      await invokeAgentera<ExperienceCandidateSummary[]>(
        deviceA,
        "listMyExperienceCandidates",
      ),
    ),
  ).toEqual([]);
  const requestsBeforeDeniedReview = agentControlRequests(harness).length;
  expect(await invokeAgentera(deviceA, "listExperienceReviewQueue")).toEqual({
    ok: false,
    errorCode: "workspace_forbidden",
  });
  expect(agentControlRequests(harness)).toHaveLength(
    requestsBeforeDeniedReview,
  );

  const reviewQueue = unwrapAgent(
    await invokeAgentera<ExperienceCandidateSummary[]>(
      deviceB,
      "listExperienceReviewQueue",
    ),
  );
  expect(reviewQueue).toEqual([
    expect.objectContaining({
      cloudCandidateId: submitted.cloudCandidateId,
      reviewStatus: "PENDING_REVIEW",
      skillName: fixture.selectedSkillName,
    }),
  ]);
  const candidateDetail = unwrapAgent(
    await invokeAgentera<ExperienceCandidateDetail>(
      deviceB,
      "getExperienceCandidate",
      submitted.cloudCandidateId,
    ),
  );
  expect(candidateDetail.bundle.skillName).toBe(fixture.selectedSkillName);

  const reviewPath = `/api/v1/workspaces/${workspace.id}/experience-candidates/${submitted.cloudCandidateId}/review`;
  failNextAgentControlRequest(harness, reviewPath);
  const failedReview = await invokeAgentera<ExperienceCandidateDetail>(
    deviceB,
    "reviewExperienceCandidate",
    {
      candidateId: submitted.cloudCandidateId,
      decision: "APPROVED",
      reasonCode: null,
      safeNote: null,
    },
  );
  expect(failedReview).toEqual({ ok: false, errorCode: "cloud_unavailable" });
  expect(
    await privateProfileSnapshot(memberProfile, fixture.privateMarkers),
  ).toEqual(privateBefore);

  const approved = unwrapAgent(
    await invokeAgentera<ExperienceCandidateDetail>(
      deviceB,
      "reviewExperienceCandidate",
      {
        candidateId: submitted.cloudCandidateId,
        decision: "APPROVED",
        reasonCode: null,
        safeNote: null,
      },
    ),
  );
  expect(approved.reviewStatus).toBe("APPROVED");

  const failedImportPreview = unwrapAgent(
    await invokeAgentera<ExperienceCandidateImportPreview>(
      deviceB,
      "prepareExperienceCandidateImport",
      submitted.cloudCandidateId,
    ),
  );
  expect(failedImportPreview).toMatchObject({
    candidateId: submitted.cloudCandidateId,
    latestVersionId: versionOne.versionId,
    skillName: fixture.selectedSkillName,
  });
  setImportFailure(deviceB, true);
  const failedImport = await invokeAgentera<AgentDraftDetail>(
    deviceB,
    "confirmExperienceCandidateImport",
    {
      importHandle: failedImportPreview.importHandle,
      confirmation: "apply-approved-skill-to-latest",
    },
  );
  expect(failedImport).toEqual({
    ok: false,
    errorCode: "candidate_import_failed",
  });
  setImportFailure(deviceB, false);
  expect(
    await privateProfileSnapshot(memberProfile, fixture.privateMarkers),
  ).toEqual(privateBefore);

  const importPreview = unwrapAgent(
    await invokeAgentera<ExperienceCandidateImportPreview>(
      deviceB,
      "prepareExperienceCandidateImport",
      submitted.cloudCandidateId,
    ),
  );
  const importedDraft = unwrapAgent(
    await invokeAgentera<AgentDraftDetail>(
      deviceB,
      "confirmExperienceCandidateImport",
      {
        importHandle: importPreview.importHandle,
        confirmation: "apply-approved-skill-to-latest",
      },
    ),
  );
  expect(importedDraft).toMatchObject({
    sourceAgentDefinitionId: versionOne.definitionId,
    baseAgentVersionId: versionOne.versionId,
  });
  expect(
    importedDraft.editableAssets.find(
      ({ path }) => path === `skills/${fixture.selectedSkillName}/SKILL.md`,
    )?.content,
  ).toContain(fixture.selectedMarker);
  const importedBytes = JSON.stringify(importedDraft.editableAssets);
  expect(importedBytes).not.toContain(fixture.unsafeSecret);
  expect(importedBytes).not.toContain(fixture.unselectedSecret);

  const versionTwo = await publish(deviceB, importedDraft.id);
  expect(versionTwo).toMatchObject({
    definitionId: versionOne.definitionId,
    versionNumber: 2,
  });

  await logout(deviceA);
  await resetBrowserIdentity(harness);
  harness.phone = MEMBER_ONE_PHONE;
  await authenticateExistingAgentControlDevice(harness, deviceA);
  await claimDefaultProfile(deviceA);
  unwrapWorkspace(
    await invokeWorkspace<WorkspacePublicState>(deviceA, "select", {
      workspaceId: workspace.id,
    }),
  );
  await waitForAgentContext(deviceA, {
    scope: "WORKSPACE",
    workspaceId: workspace.id,
    role: "member",
  });
  unwrapAgent(
    await invokeAgentera(deviceA, "selectInstallationVersion", {
      id: installation.id,
      versionId: versionTwo.versionId,
      localProfileId: MEMBER_PROFILE,
    }),
  );
  expect(
    await privateProfileSnapshot(memberProfile, fixture.privateMarkers),
  ).toEqual(privateBefore);
  const beforeNewConversation = await localAgentControlState(deviceA);
  expect(
    beforeNewConversation.bindings.find(
      ({ conversationKey }) => conversationKey === "experience-v1",
    )?.agentVersionId,
  ).toBe(versionOne.versionId);
  await startBoundConversation(deviceA, MEMBER_PROFILE, "experience-v2");
  await expect
    .poll(async () => (await localAgentControlState(deviceA!)).bindings.length)
    .toBe(2);
  const finalLocal = await localAgentControlState(deviceA);
  expect(
    finalLocal.bindings.find(
      ({ conversationKey }) => conversationKey === "experience-v1",
    )?.agentVersionId,
  ).toBe(versionOne.versionId);
  expect(
    finalLocal.bindings.find(
      ({ conversationKey }) => conversationKey === "experience-v2",
    )?.agentVersionId,
  ).toBe(versionTwo.versionId);
  expect(
    await privateProfileSnapshot(memberProfile, fixture.privateMarkers),
  ).toEqual(privateBefore);

  await expect
    .poll(() => cloudExperienceCandidateCounts(harness!))
    .toEqual({
      candidates: 1,
      reviews: 1,
    });
  await expect
    .poll(() => cloudAgentControlCounts(harness!))
    .toMatchObject({
      definitions: 1,
      versions: 2,
      installations: 1,
      runtimeBindings: 2,
    });

  const captured = JSON.stringify(agentControlRequests(harness));
  expect(captured).not.toContain("/api/agents");
  for (const forbidden of [
    fixture.unsafeSecret,
    fixture.unselectedSecret,
    sha256(fixture.unsafeSecret),
    sha256(fixture.unselectedSecret),
    "MEMBER_MEMORY_PRIVATE_2026_07_20",
    "MEMBER_USER_PRIVATE_2026_07_20",
    "MEMBER_SESSION_PRIVATE_2026_07_20",
    "MEMBER_CURATOR_PRIVATE_2026_07_20",
    "MEMBER_LOCAL_FILE_PRIVATE_2026_07_20",
    "never-upload-this-value",
    "profilePath",
    "sourcePath",
    "refreshToken",
  ]) {
    expect(captured).not.toContain(forbidden);
  }
});
