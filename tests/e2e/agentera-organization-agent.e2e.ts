import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect, test } from "playwright/test";

import type {
  AgentDraftDetail,
  AgenteraAgentControlPublicState,
  AgenteraAgentControlResult,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
  AgenteraAgentVersionSummary,
  CreateAgentDraftInput,
  OrganizationAgentSubmissionSummary,
  OrganizationReviewPreview,
  OrganizationSubmissionPreview,
  OrganizationWithdrawalPreview,
} from "../../src/shared/agentera-agent-control";
import type {
  AgenteraOrganizationResult,
  OrganizationCachedCollection,
  OrganizationInvitationCreation,
  OrganizationMember,
  OrganizationPublicState,
  OrganizationSummary,
} from "../../src/shared/agentera-organization";
import type {
  ProductSpacePublicState,
  ProductSpaceResult,
} from "../../src/shared/agentera-product-space";
import {
  agentControlExchangeDiagnostics,
  agentControlRequests,
  authenticateFirstAgentControlDevice,
  claimDefaultProfile,
  closeAgentControlHarness,
  cloudAgentControlCounts,
  createAgentControlHarness,
  deviceProcessDiagnostics,
  deviceProfilePath,
  invokeAgentera,
  launchAgentControlDevice,
  localAgentControlState,
  localInstallationOwner,
  privateProfileSnapshot,
  startAgentControlCloud,
  startBoundConversation,
  stopAgentControlCloud,
  type AgentControlDevice,
  type AgentControlDeviceName,
  type AgentControlHarness,
} from "./support/agentera-agent-control-harness";

const OWNER_PHONE = "+8613900000051";
const ADMIN_PHONE = "+8613900000052";
const AUDITOR_PHONE = "+8613900000053";
const MEMBER_PHONE = "+8613900000054";
const MEMBER_PROFILE = "organization-member-agent";
const OWNER_PRIVATE_SECRET = "ORGANIZATION_OWNER_PRIVATE_2026_07_21";
const MEMBER_MEMORY_SECRET = "ORGANIZATION_MEMBER_MEMORY_2026_07_21";
const MEMBER_SKILL_SECRET = "ORGANIZATION_MEMBER_SKILL_2026_07_21";
const LOCKED_V1_MARKER = "ORGANIZATION_LOCKED_SKILL_V1_2026_07_21";
const LOCKED_V2_MARKER = "ORGANIZATION_LOCKED_SKILL_V2_2026_07_21";
const DEFAULT_PRIVATE_MARKERS = [
  ".env",
  "MEMORY.md",
  "USER.md",
  "sessions/authoring.json",
  "files/private.txt",
  "skills/local-authoring/SKILL.md",
  "curator/state.json",
  "adaptive/device-marker.txt",
] as const;
const MEMBER_PRIVATE_MARKERS = [
  "MEMORY.md",
  "skills/member-private/SKILL.md",
] as const;

type OrganizationMethod =
  | "getState"
  | "refresh"
  | "create"
  | "archive"
  | "listMembers"
  | "patchMember"
  | "removeMember"
  | "createInvitation"
  | "acceptInvitation";

interface AccountIdentity {
  userId: string;
  personalSpaceId: string;
  deviceId: string;
}

interface AccountFixture {
  device: AgentControlDevice;
  identity: AccountIdentity;
}

let harness: AgentControlHarness | null = null;
let ownerDevice: AgentControlDevice | null = null;
let adminDevice: AgentControlDevice | null = null;
let auditorDevice: AgentControlDevice | null = null;
let memberDevice: AgentControlDevice | null = null;

test.setTimeout(360_000);

function diagnostics(): string {
  return JSON.stringify({
    exchanges: harness ? agentControlExchangeDiagnostics(harness) : [],
    processes: [
      ...deviceProcessDiagnostics(ownerDevice),
      ...deviceProcessDiagnostics(adminDevice),
      ...deviceProcessDiagnostics(auditorDevice),
      ...deviceProcessDiagnostics(memberDevice),
    ],
  });
}

function unwrapAgent<T>(result: AgenteraAgentControlResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Organization Agent operation failed: ${result.errorCode}; ${diagnostics()}`,
    );
  }
  return result.data;
}

function unwrapOrganization<T>(result: AgenteraOrganizationResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Organization operation failed: ${result.errorCode}; ${diagnostics()}`,
    );
  }
  return result.data;
}

function unwrapProductSpace<T>(result: ProductSpaceResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Product-space operation failed: ${result.errorCode}; ${diagnostics()}`,
    );
  }
  return result.data;
}

async function invokeOrganization<T>(
  device: AgentControlDevice,
  method: OrganizationMethod,
  ...args: unknown[]
): Promise<AgenteraOrganizationResult<T>> {
  return device.page.evaluate(
    async ({ requestedMethod, requestedArgs }) => {
      const api = window.agenteraOrganization as unknown as Record<
        string,
        (...parameters: unknown[]) => Promise<unknown>
      >;
      return api[requestedMethod](...requestedArgs) as Promise<
        AgenteraOrganizationResult<T>
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

async function launchAccount(
  harnessValue: AgentControlHarness,
  name: AgentControlDeviceName,
  phone: string,
  resetBrowser: boolean,
): Promise<AccountFixture> {
  if (resetBrowser) await resetBrowserIdentity(harnessValue);
  harnessValue.phone = phone;
  const device = await launchAgentControlDevice(harnessValue, name);
  await authenticateFirstAgentControlDevice(harnessValue, device);
  await claimDefaultProfile(device);
  const state = await device.page.evaluate(() =>
    window.agenteraAuth.getState(),
  );
  if (state.status !== "authenticated") {
    throw new Error(`Account ${name} did not authenticate.`);
  }
  return {
    device,
    identity: {
      userId: state.userId,
      personalSpaceId: state.personalSpaceId,
      deviceId: state.deviceId,
    },
  };
}

async function createInvitationAndAccept(
  owner: AgentControlDevice,
  invitee: AgentControlDevice,
  organizationId: string,
): Promise<void> {
  const invitation = unwrapOrganization(
    await invokeOrganization<OrganizationInvitationCreation>(
      owner,
      "createInvitation",
      { organizationId },
    ),
  );
  if (!invitation.token) {
    throw new Error("Organization invitation token is unavailable.");
  }
  unwrapOrganization(
    await invokeOrganization(invitee, "acceptInvitation", {
      token: invitation.token,
    }),
  );
}

async function organizationMembers(
  device: AgentControlDevice,
  organizationId: string,
): Promise<readonly OrganizationMember[]> {
  return unwrapOrganization(
    await invokeOrganization<OrganizationCachedCollection<OrganizationMember>>(
      device,
      "listMembers",
      { organizationId },
    ),
  ).items;
}

async function selectOrganization(
  device: AgentControlDevice,
  organizationId: string,
  role: "owner" | "admin" | "auditor" | "member",
): Promise<void> {
  unwrapOrganization(
    await invokeOrganization<OrganizationPublicState>(device, "refresh"),
  );
  const state = await device.page.evaluate(
    async ({ selectedOrganizationId }) => {
      const refreshed = await window.agenteraProductSpace.refresh();
      if (!refreshed.ok) return refreshed;
      return window.agenteraProductSpace.select({
        kind: "ORGANIZATION",
        organizationId: selectedOrganizationId,
      });
    },
    { selectedOrganizationId: organizationId },
  );
  unwrapProductSpace(state as ProductSpaceResult<ProductSpacePublicState>);
  await expect
    .poll(async () => {
      const result = await invokeAgentera<AgenteraAgentControlPublicState>(
        device,
        "getState",
      );
      return result.ok ? result.data.context : null;
    })
    .toEqual({ scope: "ORGANIZATION", organizationId, role });
}

function organizationDraft(
  marker: string,
  source?: { definitionId: string; baseVersionId: string },
): CreateAgentDraftInput {
  return {
    sourceAgentDefinitionId: source?.definitionId ?? null,
    baseAgentVersionId: source?.baseVersionId ?? null,
    displayName: "Enterprise Research",
    icon: null,
    manifest: {
      schemaVersion: 1,
      identity: {
        systemPrompt: `Use only the approved Organization base: ${marker}`,
      },
      assets: [
        {
          path: "skills/research/SKILL.md",
          kind: "skill",
          mediaType: "text/markdown",
        },
        {
          path: "sop/research.md",
          kind: "sop",
          mediaType: "text/markdown",
        },
        {
          path: "knowledge/research.md",
          kind: "knowledge",
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
        path: "skills/research/SKILL.md",
        content: [
          "---",
          "name: research",
          "description: Approved Organization research skill",
          "---",
          "",
          marker,
          "",
        ].join("\n"),
      },
      { path: "sop/research.md", content: `# Approved SOP\n${marker}\n` },
      {
        path: "knowledge/research.md",
        content: `# Approved knowledge\n${marker}\n`,
      },
    ],
  };
}

async function createAndSubmit(
  device: AgentControlDevice,
  input: CreateAgentDraftInput,
): Promise<{
  draft: AgentDraftDetail;
  submission: OrganizationAgentSubmissionSummary;
}> {
  const draft = unwrapAgent(
    await invokeAgentera<AgentDraftDetail>(device, "createDraft", input),
  );
  const preview = unwrapAgent(
    await invokeAgentera<OrganizationSubmissionPreview>(
      device,
      "prepareOrganizationSubmission",
      draft.id,
    ),
  );
  const submission = unwrapAgent(
    await invokeAgentera<OrganizationAgentSubmissionSummary>(
      device,
      "confirmOrganizationSubmission",
      {
        publicationHandle: preview.publicationHandle,
        confirmation: "submit-organization-agent",
      },
    ),
  );
  return { draft, submission };
}

async function prepareApproval(
  device: AgentControlDevice,
  submissionId: string,
): Promise<OrganizationReviewPreview> {
  return unwrapAgent(
    await invokeAgentera<OrganizationReviewPreview>(
      device,
      "prepareOrganizationReview",
      {
        submissionId,
        decision: "approve",
        reasonCode: null,
        safeNote: null,
      },
    ),
  );
}

async function approve(
  device: AgentControlDevice,
  submissionId: string,
): Promise<OrganizationAgentSubmissionSummary> {
  const preview = await prepareApproval(device, submissionId);
  if (!preview.reviewHandle) {
    throw new Error("A different Organization reviewer is required.");
  }
  return unwrapAgent(
    await invokeAgentera<OrganizationAgentSubmissionSummary>(
      device,
      "confirmOrganizationReview",
      {
        reviewHandle: preview.reviewHandle,
        confirmation: "approve-organization-agent",
      },
    ),
  );
}

async function latestVersion(
  device: AgentControlDevice,
  definitionId: string,
): Promise<AgenteraAgentVersionSummary> {
  const versions = unwrapAgent(
    await invokeAgentera<AgenteraAgentVersionSummary[]>(
      device,
      "listVersions",
      definitionId,
    ),
  );
  const value = versions.toSorted(
    (left, right) => right.versionNumber - left.versionNumber,
  )[0];
  if (!value) throw new Error("Approved Organization version is missing.");
  return value;
}

async function assertReadOnlyTree(path: string): Promise<void> {
  const stats = await lstat(path);
  if (process.platform !== "win32") {
    expect(stats.mode & 0o222, `${path} must be read-only`).toBe(0);
  }
  if (!stats.isDirectory()) return;
  for (const entry of await readdir(path)) {
    await assertReadOnlyTree(join(path, entry));
  }
}

async function treeContains(path: string, marker: string): Promise<boolean> {
  const stats = await lstat(path);
  if (stats.isFile()) {
    return (await readFile(path, "utf8")).includes(marker);
  }
  if (!stats.isDirectory()) return false;
  for (const entry of await readdir(path)) {
    if (await treeContains(join(path, entry), marker)) return true;
  }
  return false;
}

async function writeMemberLearning(profilePath: string): Promise<void> {
  await writeFile(
    join(profilePath, "MEMORY.md"),
    `# Member local Memory\n${MEMBER_MEMORY_SECRET}\n`,
    "utf8",
  );
  const skill = join(profilePath, "skills", "member-private", "SKILL.md");
  await mkdir(dirname(skill), { recursive: true });
  await writeFile(
    skill,
    `# Member private Skill\n${MEMBER_SKILL_SECRET}\n`,
    "utf8",
  );
}

async function attemptBoundConversation(
  device: AgentControlDevice,
  profileId: string,
  conversationKey: string,
): Promise<{ outcome: "resolved" | "rejected" | "pending"; error?: string }> {
  return device.page.evaluate(
    async ({ profile, runId }) =>
      Promise.race([
        window.hermesAPI
          .sendMessage(
            "This new Organization conversation must fail after membership removal.",
            profile,
            undefined,
            undefined,
            undefined,
            undefined,
            runId,
          )
          .then(() => ({ outcome: "resolved" as const }))
          .catch((error: unknown) => ({
            outcome: "rejected" as const,
            error: error instanceof Error ? error.message : String(error),
          })),
        new Promise<{ outcome: "pending" }>((resolvePending) =>
          setTimeout(() => resolvePending({ outcome: "pending" }), 5_000),
        ),
      ]),
    { profile: profileId, runId: conversationKey },
  );
}

test.beforeAll(async () => {
  harness = await createAgentControlHarness();
});

test.afterAll(async () => {
  await closeAgentControlHarness(harness);
  harness = null;
  ownerDevice = null;
  adminDevice = null;
  auditorDevice = null;
  memberDevice = null;
});

// @lat: [[agentera-organizations#Organization Agent approval#Multi-account executable proof]]
// @lat: [[agentera-agent-control-plane#Release gate#Organization Agent isolation]]
test("organization agent requires two people and keeps every employee runtime private", async () => {
  if (!harness)
    throw new Error("Organization Agent E2E harness is unavailable.");

  const owner = await launchAccount(harness, "A", OWNER_PHONE, false);
  ownerDevice = owner.device;
  const admin = await launchAccount(harness, "B", ADMIN_PHONE, true);
  adminDevice = admin.device;
  const auditor = await launchAccount(harness, "C", AUDITOR_PHONE, true);
  auditorDevice = auditor.device;
  const member = await launchAccount(harness, "D", MEMBER_PHONE, true);
  memberDevice = member.device;

  const defaultSnapshots = new Map<
    AgentControlDeviceName,
    Record<string, string | null>
  >();
  for (const account of [owner, admin, auditor, member]) {
    defaultSnapshots.set(
      account.device.name,
      await privateProfileSnapshot(
        deviceProfilePath(account.device, "default"),
        DEFAULT_PRIVATE_MARKERS,
      ),
    );
  }
  const ownerPrivatePath = join(
    deviceProfilePath(owner.device, "default"),
    "skills",
    "owner-private",
    "SKILL.md",
  );
  await mkdir(dirname(ownerPrivatePath), { recursive: true });
  await writeFile(ownerPrivatePath, OWNER_PRIVATE_SECRET, "utf8");

  const organization = unwrapOrganization(
    await invokeOrganization<OrganizationSummary>(owner.device, "create", {
      displayName: "Organization Agent E2E",
    }),
  );
  await createInvitationAndAccept(owner.device, admin.device, organization.id);
  await createInvitationAndAccept(
    owner.device,
    auditor.device,
    organization.id,
  );
  await createInvitationAndAccept(owner.device, member.device, organization.id);

  let members = await organizationMembers(owner.device, organization.id);
  const adminMember = members.find(
    ({ userId }) => userId === admin.identity.userId,
  );
  const auditorMember = members.find(
    ({ userId }) => userId === auditor.identity.userId,
  );
  const memberRow = members.find(
    ({ userId }) => userId === member.identity.userId,
  );
  if (!adminMember || !auditorMember || !memberRow) {
    throw new Error("Organization membership fixture is incomplete.");
  }
  const patchedAdmin = unwrapOrganization(
    await invokeOrganization<OrganizationMember>(owner.device, "patchMember", {
      organizationId: organization.id,
      userId: admin.identity.userId,
      patch: { role: "admin", expectedRevision: adminMember.revision },
    }),
  );
  unwrapOrganization(
    await invokeOrganization<OrganizationMember>(owner.device, "patchMember", {
      organizationId: organization.id,
      userId: auditor.identity.userId,
      patch: { role: "auditor", expectedRevision: auditorMember.revision },
    }),
  );

  await selectOrganization(owner.device, organization.id, "owner");
  await selectOrganization(admin.device, organization.id, "admin");
  await selectOrganization(auditor.device, organization.id, "auditor");
  await selectOrganization(member.device, organization.id, "member");

  expect(
    await invokeAgentera(
      member.device,
      "createDraft",
      organizationDraft("member"),
    ),
  ).toEqual({ ok: false, errorCode: "organization_agent_forbidden" });
  expect(
    await invokeAgentera(
      auditor.device,
      "createDraft",
      organizationDraft("auditor"),
    ),
  ).toEqual({ ok: false, errorCode: "organization_agent_forbidden" });

  const initial = await createAndSubmit(
    owner.device,
    organizationDraft(LOCKED_V1_MARKER),
  );
  const selfReview = await prepareApproval(owner.device, initial.submission.id);
  expect(selfReview).toMatchObject({ selfReview: true, reviewHandle: null });
  expect(
    await invokeAgentera(
      member.device,
      "prepareOrganizationSubmission",
      initial.draft.id,
    ),
  ).toEqual({ ok: false, errorCode: "organization_agent_forbidden" });
  expect(
    await invokeAgentera(member.device, "prepareOrganizationReview", {
      submissionId: initial.submission.id,
      decision: "approve",
      reasonCode: null,
      safeNote: null,
    }),
  ).toEqual({ ok: false, errorCode: "organization_agent_forbidden" });

  const approvedInitial = await approve(admin.device, initial.submission.id);
  expect(approvedInitial.status).toBe("approved");
  const definitions = unwrapAgent(
    await invokeAgentera<AgenteraAgentDefinitionSummary[]>(
      member.device,
      "listDefinitions",
    ),
  );
  expect(definitions).toHaveLength(1);
  const definition = definitions[0];
  const versionOne = await latestVersion(member.device, definition.id);
  expect(versionOne.versionNumber).toBe(1);

  const history = unwrapAgent(
    await invokeAgentera<OrganizationAgentSubmissionSummary[]>(
      auditor.device,
      "listOrganizationSubmissions",
    ),
  );
  expect(history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: initial.submission.id,
        status: "approved",
      }),
    ]),
  );
  const requestsBeforeAuditorInstall = agentControlRequests(harness).length;
  expect(
    await invokeAgentera(auditor.device, "installVersion", {
      definitionId: definition.id,
      versionId: versionOne.id,
      profileName: "auditor-must-not-install",
    }),
  ).toEqual({ ok: false, errorCode: "organization_agent_forbidden" });
  expect(agentControlRequests(harness)).toHaveLength(
    requestsBeforeAuditorInstall,
  );

  expect(
    unwrapAgent(
      await invokeAgentera<AgenteraAgentInstallationSummary[]>(
        member.device,
        "listInstallations",
      ),
    ),
  ).toEqual([]);

  const installation = unwrapAgent(
    await invokeAgentera<AgenteraAgentInstallationSummary>(
      member.device,
      "installVersion",
      {
        definitionId: definition.id,
        versionId: versionOne.id,
        profileName: MEMBER_PROFILE,
      },
    ),
  );
  const installationOwner = localInstallationOwner(
    member.device,
    installation.id,
  );
  expect(installationOwner).toMatchObject({
    tenantId: member.identity.personalSpaceId,
    ownerId: member.identity.userId,
    sourceScope: "ORGANIZATION",
    sourceWorkspaceId: null,
    sourceOrganizationId: organization.id,
  });
  expect(installationOwner.deviceInstallationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(installationOwner.deviceInstallationId).not.toBe(
    owner.identity.deviceId,
  );

  const memberProfile = deviceProfilePath(member.device, MEMBER_PROFILE);
  await writeMemberLearning(memberProfile);
  const memberPrivate = await privateProfileSnapshot(
    memberProfile,
    MEMBER_PRIVATE_MARKERS,
  );
  await startBoundConversation(member.device, MEMBER_PROFILE, "member-v1");
  await expect
    .poll(
      async () => (await localAgentControlState(member.device)).bindings.length,
    )
    .toBe(1);
  expect(
    (await localAgentControlState(member.device)).bindings[0],
  ).toMatchObject({
    conversationKey: "member-v1",
    agentVersionId: versionOne.id,
    agentInstallationId: installation.id,
  });

  const demotionSubmission = await createAndSubmit(
    owner.device,
    organizationDraft("DEMOTION_RACE", {
      definitionId: definition.id,
      baseVersionId: versionOne.id,
    }),
  );
  const preparedBeforeDemotion = await prepareApproval(
    admin.device,
    demotionSubmission.submission.id,
  );
  if (!preparedBeforeDemotion.reviewHandle) {
    throw new Error("Admin demotion review handle is missing.");
  }
  const demoted = unwrapOrganization(
    await invokeOrganization<OrganizationMember>(owner.device, "patchMember", {
      organizationId: organization.id,
      userId: admin.identity.userId,
      patch: { role: "member", expectedRevision: patchedAdmin.revision },
    }),
  );
  expect(
    await invokeAgentera(admin.device, "confirmOrganizationReview", {
      reviewHandle: preparedBeforeDemotion.reviewHandle,
      confirmation: "approve-organization-agent",
    }),
  ).toEqual({ ok: false, errorCode: "organization_agent_forbidden" });
  unwrapOrganization(
    await invokeOrganization<OrganizationMember>(owner.device, "patchMember", {
      organizationId: organization.id,
      userId: admin.identity.userId,
      patch: { role: "admin", expectedRevision: demoted.revision },
    }),
  );
  await selectOrganization(admin.device, organization.id, "admin");

  expect(
    await invokeAgentera(
      admin.device,
      "prepareOrganizationWithdrawal",
      demotionSubmission.submission.id,
    ),
  ).toEqual({ ok: false, errorCode: "organization_agent_forbidden" });
  const withdrawal = unwrapAgent(
    await invokeAgentera<OrganizationWithdrawalPreview>(
      owner.device,
      "prepareOrganizationWithdrawal",
      demotionSubmission.submission.id,
    ),
  );
  expect(
    unwrapAgent(
      await invokeAgentera<OrganizationAgentSubmissionSummary>(
        owner.device,
        "confirmOrganizationWithdrawal",
        {
          withdrawalHandle: withdrawal.withdrawalHandle,
          confirmation: "withdraw-organization-agent",
        },
      ),
    ).status,
  ).toBe("withdrawn");

  const nextA = await createAndSubmit(
    owner.device,
    organizationDraft(LOCKED_V2_MARKER, {
      definitionId: definition.id,
      baseVersionId: versionOne.id,
    }),
  );
  const nextB = await createAndSubmit(
    owner.device,
    organizationDraft("STALE_NEXT_SUBMISSION", {
      definitionId: definition.id,
      baseVersionId: versionOne.id,
    }),
  );
  expect((await approve(admin.device, nextA.submission.id)).status).toBe(
    "approved",
  );
  const staleReview = await prepareApproval(admin.device, nextB.submission.id);
  if (!staleReview.reviewHandle) {
    throw new Error("Stale next review handle is missing.");
  }
  expect(
    await invokeAgentera(admin.device, "confirmOrganizationReview", {
      reviewHandle: staleReview.reviewHandle,
      confirmation: "approve-organization-agent",
    }),
  ).toEqual({ ok: false, errorCode: "organization_submission_superseded" });
  const superseded = unwrapAgent(
    await invokeAgentera<OrganizationAgentSubmissionSummary[]>(
      admin.device,
      "listOrganizationSubmissions",
    ),
  ).find(({ id }) => id === nextB.submission.id);
  expect(superseded?.status).toBe("superseded");

  const versionTwo = await latestVersion(member.device, definition.id);
  expect(versionTwo.versionNumber).toBe(2);
  unwrapAgent(
    await invokeAgentera<AgenteraAgentInstallationSummary>(
      member.device,
      "selectInstallationVersion",
      {
        id: installation.id,
        versionId: versionTwo.id,
        localProfileId: MEMBER_PROFILE,
      },
    ),
  );
  expect(
    await privateProfileSnapshot(memberProfile, MEMBER_PRIVATE_MARKERS),
  ).toEqual(memberPrivate);
  await startBoundConversation(member.device, MEMBER_PROFILE, "member-v2");
  await expect
    .poll(
      async () => (await localAgentControlState(member.device)).bindings.length,
    )
    .toBe(2);
  const versionedBindings = (await localAgentControlState(member.device))
    .bindings;
  expect(
    versionedBindings.find(
      ({ conversationKey }) => conversationKey === "member-v1",
    )?.agentVersionId,
  ).toBe(versionOne.id);
  expect(
    versionedBindings.find(
      ({ conversationKey }) => conversationKey === "member-v2",
    )?.agentVersionId,
  ).toBe(versionTwo.id);

  const projectionRoot = (await localAgentControlState(member.device))
    .projectionRoots[0];
  expect(projectionRoot).toBeTruthy();
  await assertReadOnlyTree(join(projectionRoot, "active"));
  expect(await treeContains(projectionRoot, LOCKED_V1_MARKER)).toBe(true);
  expect(await treeContains(projectionRoot, LOCKED_V2_MARKER)).toBe(true);
  expect(await treeContains(projectionRoot, OWNER_PRIVATE_SECRET)).toBe(false);
  expect(await treeContains(projectionRoot, MEMBER_MEMORY_SECRET)).toBe(false);
  expect(await treeContains(projectionRoot, MEMBER_SKILL_SECRET)).toBe(false);

  await stopAgentControlCloud(harness);
  await member.device.app.close();
  memberDevice = await launchAgentControlDevice(harness, "D");
  await expect(memberDevice.page.locator(".layout")).toBeVisible({
    timeout: 180_000,
  });
  await expect
    .poll(() =>
      memberDevice!.page.evaluate(() => window.agenteraAuth.getState()),
    )
    .toMatchObject({ status: "offline", cloudAvailable: false });
  await startBoundConversation(
    memberDevice,
    MEMBER_PROFILE,
    "member-offline-v2",
  );
  await expect
    .poll(
      async () => (await localAgentControlState(memberDevice!)).bindings.length,
    )
    .toBe(3);
  expect(
    await privateProfileSnapshot(memberProfile, MEMBER_PRIVATE_MARKERS),
  ).toEqual(memberPrivate);

  await startAgentControlCloud(harness);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
  await owner.device.page.evaluate(() => window.agenteraAuth.retryOnline());
  await memberDevice.page.evaluate(() => window.agenteraAuth.retryOnline());
  members = await organizationMembers(owner.device, organization.id);
  const removable = members.find(
    ({ userId }) => userId === member.identity.userId,
  );
  if (!removable) throw new Error("Member removal fixture is unavailable.");
  unwrapOrganization(
    await invokeOrganization(owner.device, "removeMember", {
      organizationId: organization.id,
      userId: member.identity.userId,
      expectedRevision: removable.revision,
    }),
  );
  unwrapOrganization(
    await invokeOrganization<OrganizationPublicState>(memberDevice, "refresh"),
  );
  const productState = unwrapProductSpace(
    (await memberDevice.page.evaluate(() =>
      window.agenteraProductSpace.refresh(),
    )) as ProductSpaceResult<ProductSpacePublicState>,
  );
  expect(productState.selected).toEqual({ kind: "PERSONAL" });
  await expect
    .poll(async () => {
      const state = await invokeAgentera<AgenteraAgentControlPublicState>(
        memberDevice!,
        "getState",
      );
      return state.ok ? state.data.context : null;
    })
    .toEqual({ scope: "USER" });
  const bindingsBeforeRemovalAttempt = (
    await localAgentControlState(memberDevice)
  ).bindings.length;
  const removedAttempt = await attemptBoundConversation(
    memberDevice,
    MEMBER_PROFILE,
    "member-after-removal",
  );
  expect(removedAttempt.outcome).toBe("rejected");
  expect((await localAgentControlState(memberDevice)).bindings).toHaveLength(
    bindingsBeforeRemovalAttempt,
  );
  expect(
    (await localAgentControlState(memberDevice)).installations,
  ).toHaveLength(1);
  expect(
    await privateProfileSnapshot(memberProfile, MEMBER_PRIVATE_MARKERS),
  ).toEqual(memberPrivate);

  const archivedDraft = unwrapAgent(
    await invokeAgentera<AgentDraftDetail>(
      owner.device,
      "createDraft",
      organizationDraft("ARCHIVED_MUTATION", {
        definitionId: definition.id,
        baseVersionId: versionTwo.id,
      }),
    ),
  );
  const archivedPreview = unwrapAgent(
    await invokeAgentera<OrganizationSubmissionPreview>(
      owner.device,
      "prepareOrganizationSubmission",
      archivedDraft.id,
    ),
  );
  const submissionMutationsBeforeArchive = agentControlRequests(harness).filter(
    ({ method, path }) =>
      method === "POST" &&
      path ===
        `/api/v1/organizations/${organization.id}/agent-publication-submissions`,
  ).length;
  const refreshedOwner = unwrapOrganization(
    await invokeOrganization<OrganizationPublicState>(owner.device, "refresh"),
  );
  const activeOrganization = refreshedOwner.organizations.find(
    ({ id }) => id === organization.id,
  );
  if (!activeOrganization) throw new Error("Organization disappeared.");
  unwrapOrganization(
    await invokeOrganization<OrganizationSummary>(owner.device, "archive", {
      organizationId: organization.id,
      expectedRevision: activeOrganization.revision,
    }),
  );
  expect(
    await invokeAgentera(owner.device, "confirmOrganizationSubmission", {
      publicationHandle: archivedPreview.publicationHandle,
      confirmation: "submit-organization-agent",
    }),
  ).toEqual({ ok: false, errorCode: "organization_agent_forbidden" });
  expect(
    agentControlRequests(harness).filter(
      ({ method, path }) =>
        method === "POST" &&
        path ===
          `/api/v1/organizations/${organization.id}/agent-publication-submissions`,
    ),
  ).toHaveLength(submissionMutationsBeforeArchive);

  await expect
    .poll(() => cloudAgentControlCounts(harness!))
    .toMatchObject({
      definitions: 1,
      versions: 2,
      installations: 1,
    });
  expect(await readFile(ownerPrivatePath, "utf8")).toBe(OWNER_PRIVATE_SECRET);
  for (const account of [owner, admin, auditor]) {
    expect(
      await privateProfileSnapshot(
        deviceProfilePath(account.device, "default"),
        DEFAULT_PRIVATE_MARKERS,
      ),
    ).toEqual(defaultSnapshots.get(account.device.name));
  }

  const requests = agentControlRequests(harness);
  const installationRequest = requests.find(
    ({ method, path }) =>
      method === "POST" && path === "/api/v1/agent-installations",
  );
  expect(installationRequest?.body).toMatchObject({
    definition_id: definition.id,
    version_id: versionOne.id,
    organization_id: organization.id,
  });
  const captured = JSON.stringify(requests);
  for (const forbidden of [
    OWNER_PRIVATE_SECRET,
    MEMBER_MEMORY_SECRET,
    MEMBER_SKILL_SECRET,
    createHash("sha256").update(OWNER_PRIVATE_SECRET).digest("hex"),
    createHash("sha256").update(MEMBER_MEMORY_SECRET).digest("hex"),
    createHash("sha256").update(MEMBER_SKILL_SECRET).digest("hex"),
    "refreshToken",
    "offlineEntitlement",
    "devicePrivateKey",
    "profilePath",
    "MEMORY.md",
    "USER.md",
    "sessions/authoring.json",
    "curator/state.json",
  ]) {
    expect(captured).not.toContain(forbidden);
  }
});
