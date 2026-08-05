import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

import { expect, test } from "playwright/test";

import type {
  AgentDraft,
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
const UNPUBLISHED_AFTER_SUBMISSION =
  "ORGANIZATION_UNPUBLISHED_AFTER_SUBMISSION_2026_08_05";
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
  | "revokeInvitation"
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
let visionModelServer: Server | null = null;
const visionModelRequests: Array<{
  method: string;
  path: string;
  body: unknown;
}> = [];

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
): Promise<OrganizationInvitationCreation> {
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
  return invitation;
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
      schemaVersion: 2,
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
      modelPolicy: {
        mode: "user_select",
        allowedProviders: [],
        allowedModels: [],
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
    throw new Error(
      "The current Owner or Admin did not receive a review handle.",
    );
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

async function startVisionModelServer(): Promise<string> {
  visionModelServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400).end();
        return;
      }
      visionModelRequests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body,
      });
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const stream =
        typeof body === "object" &&
        body !== null &&
        (body as { stream?: unknown }).stream === true;
      if (!stream) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            id: "vision-e2e",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "IMAGE_TRANSPORT_RECOVERED",
                },
                finish_reason: "stop",
              },
            ],
          }),
        );
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(
        `data: ${JSON.stringify({
          id: "vision-e2e",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "IMAGE_TRANSPORT_RECOVERED",
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    visionModelServer!.once("error", rejectListen);
    visionModelServer!.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = visionModelServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function stopVisionModelServer(): Promise<void> {
  const server = visionModelServer;
  visionModelServer = null;
  if (!server) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

test.beforeAll(async () => {
  harness = await createAgentControlHarness();
});

test.afterAll(async () => {
  await stopVisionModelServer();
  await closeAgentControlHarness(harness);
  harness = null;
  ownerDevice = null;
  adminDevice = null;
  auditorDevice = null;
  memberDevice = null;
});

// @lat: [[agentera-organizations#Organization Agent approval#Multi-account executable proof]]
// @lat: [[agentera-agent-control-plane#Release gate#Organization Agent isolation]]
test("organization agent needs one current reviewer and keeps every employee runtime private", async () => {
  if (!harness)
    throw new Error("Organization Agent E2E harness is unavailable.");

  let owner = await launchAccount(harness, "A", OWNER_PHONE, false);
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
  const adminInvitation = await createInvitationAndAccept(
    owner.device,
    admin.device,
    organization.id,
  );
  expect(
    await invokeOrganization(auditor.device, "acceptInvitation", {
      token: adminInvitation.token,
    }),
  ).toEqual({ ok: false, errorCode: "invitation_used" });
  const auditorInvitation = await createInvitationAndAccept(
    owner.device,
    auditor.device,
    organization.id,
  );
  expect(
    await invokeOrganization(member.device, "acceptInvitation", {
      token: auditorInvitation.token,
    }),
  ).toEqual({ ok: false, errorCode: "invitation_used" });
  const revokedMemberInvitation = unwrapOrganization(
    await invokeOrganization<OrganizationInvitationCreation>(
      owner.device,
      "createInvitation",
      { organizationId: organization.id },
    ),
  );
  unwrapOrganization(
    await invokeOrganization<true>(owner.device, "revokeInvitation", {
      organizationId: organization.id,
      invitationId: revokedMemberInvitation.invitation.id,
    }),
  );
  expect(
    await invokeOrganization(member.device, "acceptInvitation", {
      token: revokedMemberInvitation.token,
    }),
  ).toEqual({ ok: false, errorCode: "invitation_revoked" });
  const memberInvitation = await createInvitationAndAccept(
    owner.device,
    member.device,
    organization.id,
  );
  expect(
    await invokeOrganization(admin.device, "acceptInvitation", {
      token: memberInvitation.token,
    }),
  ).toEqual({ ok: false, errorCode: "invitation_used" });

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
  const unpublishedInput = organizationDraft(UNPUBLISHED_AFTER_SUBMISSION);
  const editedWhilePending = unwrapAgent(
    await invokeAgentera<AgentDraftDetail>(owner.device, "updateDraft", {
      id: initial.draft.id,
      expectedRevision: initial.draft.revision,
      displayName: unpublishedInput.displayName,
      icon: unpublishedInput.icon,
      manifest: unpublishedInput.manifest,
      assets: unpublishedInput.assets,
    }),
  );
  expect(editedWhilePending).toMatchObject({
    id: initial.draft.id,
    revision: 2,
    publishedRevision: null,
  });

  await owner.device.app.close();
  ownerDevice = await launchAgentControlDevice(harness, "A");
  owner = { ...owner, device: ownerDevice };
  await expect(owner.device.page.locator(".layout")).toBeVisible({
    timeout: 180_000,
  });
  await expect
    .poll(() =>
      owner.device.page.evaluate(() => window.agenteraAuth.getState()),
    )
    .toMatchObject({ status: "authenticated", cloudAvailable: true });
  const startupModelPrompt = owner.device.page.locator(".startup-model-prompt");
  await startupModelPrompt
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => undefined);
  if (await startupModelPrompt.isVisible()) {
    await startupModelPrompt
      .getByRole("button", { name: /^(Later|稍后)$/u })
      .click();
  }
  await selectOrganization(owner.device, organization.id, "owner");

  const selfReview = await prepareApproval(owner.device, initial.submission.id);
  expect(selfReview).toMatchObject({
    selfReview: true,
    reviewHandle: expect.any(String),
  });
  if (!selfReview.reviewHandle) {
    throw new Error("Single-owner review handle is missing.");
  }
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

  const approvedInitial = unwrapAgent(
    await invokeAgentera<OrganizationAgentSubmissionSummary>(
      owner.device,
      "confirmOrganizationReview",
      {
        reviewHandle: selfReview.reviewHandle,
        confirmation: "approve-organization-agent",
      },
    ),
  );
  expect(approvedInitial.status).toBe("approved");
  expect(approvedInitial).toMatchObject({
    localDraftId: initial.draft.id,
    localDraftRevision: 1,
  });
  const reconciledHistory = unwrapAgent(
    await invokeAgentera<OrganizationAgentSubmissionSummary[]>(
      owner.device,
      "listOrganizationSubmissions",
    ),
  );
  expect(reconciledHistory).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: initial.submission.id,
        status: "approved",
        localDraftId: initial.draft.id,
        localDraftRevision: 1,
      }),
    ]),
  );
  const reconciledDraft = unwrapAgent(
    await invokeAgentera<AgentDraftDetail>(
      owner.device,
      "getDraft",
      initial.draft.id,
    ),
  );
  expect(reconciledDraft).toMatchObject({
    id: initial.draft.id,
    revision: 2,
    publishedRevision: {
      revision: 1,
      definitionId: approvedInitial.definitionId,
      versionId: approvedInitial.publishedVersionId,
    },
  });

  await owner.device.page
    .getByRole("button", { name: /^(Agents|智能体)$/ })
    .click();
  await owner.device.page
    .getByRole("tab", { name: /^(Enterprise Agents|企业智能体)$/ })
    .click();
  const lifecycleCard = owner.device.page
    .locator('[data-testid="personal-agent-grid"] .agent-hub-card')
    .filter({ hasText: "Enterprise Research" });
  await expect(lifecycleCard).toHaveCount(1);
  await expect(lifecycleCard).toContainText(
    /Published with unpublished changes|已发布，有未发布修改/,
  );

  const disposableDraft = unwrapAgent(
    await invokeAgentera<AgentDraftDetail>(
      owner.device,
      "createDraft",
      organizationDraft("DISPOSABLE_LOCAL_DRAFT"),
    ),
  );
  expect(
    unwrapAgent(
      await invokeAgentera<true>(
        owner.device,
        "deleteDraft",
        disposableDraft.id,
      ),
    ),
  ).toBe(true);
  expect(
    unwrapAgent(
      await invokeAgentera<AgentDraft[]>(owner.device, "listDrafts"),
    ).some(({ id }) => id === disposableDraft.id),
  ).toBe(false);
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
  const visionModelOrigin = await startVisionModelServer();
  await writeFile(
    join(memberProfile, "config.yaml"),
    [
      "model:",
      "  provider: custom",
      "  default: e2e-vision",
      `  base_url: "${visionModelOrigin}/v1"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await appendFile(
    join(memberProfile, ".env"),
    "CUSTOM_API_KEY=e2e-loopback-only\n",
    "utf8",
  );
  const imageTurn = await member.device.page.evaluate(
    async ({ profile, attachment }) => {
      try {
        const result = await window.hermesAPI.sendMessage(
          "Describe this test image.",
          profile,
          undefined,
          undefined,
          [attachment],
          undefined,
          "member-image-recovery",
        );
        return { ok: true as const, result };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      profile: MEMBER_PROFILE,
      attachment: {
        id: "vision-recovery-image",
        kind: "image" as const,
        name: "pixel.png",
        mime: "image/png",
        size: 68,
        dataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    },
  );
  expect(imageTurn).toMatchObject({
    ok: true,
    result: { response: expect.stringContaining("IMAGE_TRANSPORT_RECOVERED") },
  });
  expect(JSON.stringify(visionModelRequests)).toContain(
    "data:image/png;base64,",
  );
  await stopVisionModelServer();
  await writeMemberLearning(memberProfile);
  const memberPrivate = await privateProfileSnapshot(
    memberProfile,
    MEMBER_PRIVATE_MARKERS,
  );
  await startBoundConversation(member.device, MEMBER_PROFILE, "member-v1");
  await expect
    .poll(
      async () =>
        (await localAgentControlState(member.device)).bindings.find(
          ({ conversationKey }) => conversationKey === "member-v1",
        ) ?? null,
    )
    .toMatchObject({
      conversationKey: "member-v1",
      agentVersionId: versionOne.id,
      agentInstallationId: installation.id,
    });
  expect(
    (await localAgentControlState(member.device)).bindings.find(
      ({ conversationKey }) => conversationKey === "member-v1",
    ),
  ).toMatchObject({
    conversationKey: "member-v1",
    agentVersionId: versionOne.id,
    agentInstallationId: installation.id,
  });
  const organizationBoundary = await member.device.page.evaluate(
    ({ runId, profile }) =>
      window.agenteraGlobalProfile.prepareConversationContext({
        runId,
        profile,
        resumeSessionId: null,
      }),
    { runId: "member-v1", profile: MEMBER_PROFILE },
  );
  expect(organizationBoundary.conversationBoundary).toEqual({
    scope: "ORGANIZATION",
    scopeId: organization.id,
    scopeDisplayName: organization.displayName,
    visibility: "PRIVATE",
    origin: "NEW_CONVERSATION",
  });

  const selectedPersonal = unwrapProductSpace(
    (await member.device.page.evaluate(() =>
      window.agenteraProductSpace.select({ kind: "PERSONAL" }),
    )) as ProductSpaceResult<ProductSpacePublicState>,
  );
  expect(selectedPersonal.selected).toEqual({ kind: "PERSONAL" });
  const bindingsBeforeScopeSwitchAttempt = (
    await localAgentControlState(member.device)
  ).bindings.length;
  const pinnedAfterScopeSwitch = await member.device.page.evaluate(
    ({ runId, profile }) =>
      window.agenteraGlobalProfile.prepareConversationContext({
        runId,
        profile,
        resumeSessionId: null,
      }),
    { runId: "member-v1", profile: MEMBER_PROFILE },
  );
  expect(pinnedAfterScopeSwitch.conversationBoundary).toEqual(
    organizationBoundary.conversationBoundary,
  );
  const crossScopeAttempt = await attemptBoundConversation(
    member.device,
    MEMBER_PROFILE,
    "member-personal-cross-scope",
  );
  expect(crossScopeAttempt.outcome).toBe("rejected");
  expect((await localAgentControlState(member.device)).bindings).toHaveLength(
    bindingsBeforeScopeSwitchAttempt,
  );
  await selectOrganization(member.device, organization.id, "member");

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
      async () =>
        (await localAgentControlState(member.device)).bindings.find(
          ({ conversationKey }) => conversationKey === "member-v2",
        ) ?? null,
    )
    .toMatchObject({
      conversationKey: "member-v2",
      agentVersionId: versionTwo.id,
      agentInstallationId: installation.id,
    });
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
      async () =>
        (await localAgentControlState(memberDevice!)).bindings.find(
          ({ conversationKey }) => conversationKey === "member-offline-v2",
        ) ?? null,
    )
    .toMatchObject({
      conversationKey: "member-offline-v2",
      agentVersionId: versionTwo.id,
      agentInstallationId: installation.id,
    });
  const offlineBindings = (await localAgentControlState(memberDevice)).bindings;
  expect(
    new Set(offlineBindings.map(({ conversationKey }) => conversationKey)).size,
  ).toBe(offlineBindings.length);
  expect(
    offlineBindings.find(
      ({ conversationKey }) => conversationKey === "member-v1",
    )?.agentVersionId,
  ).toBe(versionOne.id);
  expect(
    offlineBindings.find(
      ({ conversationKey }) => conversationKey === "member-v2",
    )?.agentVersionId,
  ).toBe(versionTwo.id);
  expect(
    await privateProfileSnapshot(memberProfile, MEMBER_PRIVATE_MARKERS),
  ).toEqual(memberPrivate);

  await startAgentControlCloud(harness);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
  await owner.device.page.evaluate(() => window.agenteraAuth.retryOnline());
  await memberDevice.page.evaluate(() => window.agenteraAuth.retryOnline());

  const archivedInstallation = unwrapAgent(
    await invokeAgentera<AgenteraAgentInstallationSummary>(
      memberDevice,
      "archiveInstallation",
      installation.id,
    ),
  );
  expect(archivedInstallation.status).toBe("archived");
  expect(
    (await localAgentControlState(memberDevice)).installations.find(
      ({ id }) => id === installation.id,
    ),
  ).toMatchObject({ id: installation.id, status: "archived" });
  expect(
    await privateProfileSnapshot(memberProfile, MEMBER_PRIVATE_MARKERS),
  ).toEqual(memberPrivate);

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
