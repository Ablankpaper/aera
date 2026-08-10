import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { expect, test } from "playwright/test";

import type {
  AgentDraftDetail,
  AgenteraAgentControlPublicState,
  AgenteraAgentControlResult,
  AgenteraAgentDefinitionSummary,
  AgenteraAgentInstallationSummary,
  AgenteraAgentVersionSummary,
  EligibleExperienceSkill,
  OrganizationAgentSubmissionSummary,
  OrganizationExperienceCandidateDetail,
  OrganizationExperienceCandidateImportPreview,
  OrganizationExperienceCandidatePreview,
  OrganizationExperienceCandidateSummary,
  OrganizationReviewPreview,
  OrganizationSubmissionPreview,
} from "../../src/shared/agentera-agent-control";
import type {
  AgenteraOrganizationResult,
  OrganizationInvitationCreation,
  OrganizationPublicState,
  OrganizationSummary,
} from "../../src/shared/agentera-organization";
import type {
  ProductSpacePublicState,
  ProductSpaceResult,
} from "../../src/shared/agentera-product-space";
import { customProviderRuntimeRoute } from "../../src/shared/custom-providers";
import {
  agentControlExchangeDiagnostics,
  agentControlRequests,
  authenticateFirstAgentControlDevice,
  claimDefaultProfile,
  closeAgentControlHarness,
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
  type AgentControlDeviceName,
  type AgentControlHarness,
} from "./support/agentera-agent-control-harness";

const OWNER_PHONE = "+8613900000061";
const EMPLOYEE_PHONE = "+8613900000062";
const EMPLOYEE_PROFILE = "organization-experience-employee";

type OrganizationMethod =
  | "create"
  | "createInvitation"
  | "acceptInvitation"
  | "refresh";

let harness: AgentControlHarness | null = null;
let ownerDevice: AgentControlDevice | null = null;
let employeeDevice: AgentControlDevice | null = null;
let modelServer: Server | null = null;
let completedModelResponses = 0;

test.setTimeout(360_000);

function diagnostics(): string {
  return JSON.stringify({
    exchanges: harness ? agentControlExchangeDiagnostics(harness) : [],
    processes: [
      ...deviceProcessDiagnostics(ownerDevice),
      ...deviceProcessDiagnostics(employeeDevice),
    ],
  });
}

function unwrapAgent<T>(result: AgenteraAgentControlResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Organization experience operation failed: ${result.errorCode}; ${diagnostics()}`,
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
): Promise<AgentControlDevice> {
  if (resetBrowser) await resetBrowserIdentity(harnessValue);
  harnessValue.phone = phone;
  const device = await launchAgentControlDevice(harnessValue, name);
  await authenticateFirstAgentControlDevice(harnessValue, device);
  await claimDefaultProfile(device);
  return device;
}

async function selectOrganization(
  device: AgentControlDevice,
  organizationId: string,
  role: "owner" | "member",
): Promise<void> {
  unwrapOrganization(
    await invokeOrganization<OrganizationPublicState>(device, "refresh"),
  );
  const selected = await device.page.evaluate(
    async ({ targetOrganizationId }) => {
      const refreshed = await window.agenteraProductSpace.refresh();
      if (!refreshed.ok) return refreshed;
      return window.agenteraProductSpace.select({
        kind: "ORGANIZATION",
        organizationId: targetOrganizationId,
      });
    },
    { targetOrganizationId: organizationId },
  );
  unwrapProductSpace(selected as ProductSpaceResult<ProductSpacePublicState>);
  await expect
    .poll(async () => {
      const state = await invokeAgentera<AgenteraAgentControlPublicState>(
        device,
        "getState",
      );
      return state.ok ? state.data.context : null;
    })
    .toEqual({ scope: "ORGANIZATION", organizationId, role });
}

function initialDraft() {
  return {
    sourceAgentDefinitionId: null,
    baseAgentVersionId: null,
    displayName: "Evolving Organization Agent",
    icon: null,
    manifest: {
      schemaVersion: 2 as const,
      identity: { systemPrompt: "Use approved Organization assets only." },
      assets: [
        {
          path: "skills/base-research/SKILL.md",
          kind: "skill" as const,
          mediaType: "text/markdown" as const,
        },
      ],
      modelPolicy: {
        mode: "user_select" as const,
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
        path: "skills/base-research/SKILL.md",
        content:
          "---\nname: base-research\ndescription: Organization base\n---\n\n# Base research\n",
      },
    ],
  };
}

async function submitDraft(
  device: AgentControlDevice,
  draftId: string,
): Promise<OrganizationAgentSubmissionSummary> {
  const preview = unwrapAgent(
    await invokeAgentera<OrganizationSubmissionPreview>(
      device,
      "prepareOrganizationSubmission",
      draftId,
    ),
  );
  return unwrapAgent(
    await invokeAgentera<OrganizationAgentSubmissionSummary>(
      device,
      "confirmOrganizationSubmission",
      {
        publicationHandle: preview.publicationHandle,
        confirmation: "submit-organization-agent",
      },
    ),
  );
}

async function approveSubmission(
  device: AgentControlDevice,
  submissionId: string,
): Promise<OrganizationAgentSubmissionSummary> {
  const preview = unwrapAgent(
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
  if (!preview.reviewHandle) {
    throw new Error("Organization review handle is unavailable.");
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function startModelServer(): Promise<string> {
  modelServer = createServer((request, response) => {
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
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      response.once("finish", () => {
        completedModelResponses += 1;
      });
      const stream =
        typeof body === "object" &&
        body !== null &&
        (body as { stream?: unknown }).stream === true;
      if (!stream) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            id: "organization-experience-e2e",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "ORGANIZATION_EXPERIENCE_MODEL_REPLY",
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
          id: "organization-experience-e2e",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "ORGANIZATION_EXPERIENCE_MODEL_REPLY",
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
    modelServer!.once("error", rejectListen);
    modelServer!.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = modelServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function stopModelServer(): Promise<void> {
  const server = modelServer;
  modelServer = null;
  if (!server) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

test.beforeAll(async () => {
  harness = await createAgentControlHarness();
});

test.afterAll(async () => {
  await stopModelServer();
  await closeAgentControlHarness(harness);
  harness = null;
  ownerDevice = null;
  employeeDevice = null;
});

// @lat: [[agentera-self-evolution#Candidate promotion loop#Organization experience contribution]]
// @lat: [[agentera-organizations#Organization Agent approval#Experience contribution and next-version import]]
test("an employee contributes one Skill and an Owner publishes it only through the next-version flow", async () => {
  if (!harness) {
    throw new Error("Organization experience E2E harness is unavailable.");
  }

  ownerDevice = await launchAccount(harness, "A", OWNER_PHONE, false);
  employeeDevice = await launchAccount(harness, "B", EMPLOYEE_PHONE, true);

  const organization = unwrapOrganization(
    await invokeOrganization<OrganizationSummary>(ownerDevice, "create", {
      displayName: "Organization Experience E2E",
    }),
  );
  const invitation = unwrapOrganization(
    await invokeOrganization<OrganizationInvitationCreation>(
      ownerDevice,
      "createInvitation",
      { organizationId: organization.id },
    ),
  );
  if (!invitation.token) throw new Error("Invitation token is unavailable.");
  unwrapOrganization(
    await invokeOrganization(employeeDevice, "acceptInvitation", {
      token: invitation.token,
    }),
  );
  await selectOrganization(ownerDevice, organization.id, "owner");
  await selectOrganization(employeeDevice, organization.id, "member");

  const draft = unwrapAgent(
    await invokeAgentera<AgentDraftDetail>(
      ownerDevice,
      "createDraft",
      initialDraft(),
    ),
  );
  const initialSubmission = await submitDraft(ownerDevice, draft.id);
  const approvedInitial = await approveSubmission(
    ownerDevice,
    initialSubmission.id,
  );
  if (!approvedInitial.publishedVersionId) {
    throw new Error("Initial Organization version is unavailable.");
  }

  const definitions = unwrapAgent(
    await invokeAgentera<AgenteraAgentDefinitionSummary[]>(
      employeeDevice,
      "listDefinitions",
    ),
  );
  const definition = definitions.find(
    ({ id }) => id === approvedInitial.definitionId,
  );
  if (!definition) throw new Error("Organization definition is unavailable.");
  const versions = unwrapAgent(
    await invokeAgentera<AgenteraAgentVersionSummary[]>(
      employeeDevice,
      "listVersions",
      definition.id,
    ),
  );
  const versionOne = versions.find(
    ({ id }) => id === approvedInitial.publishedVersionId,
  );
  if (!versionOne) throw new Error("Organization version one is unavailable.");

  const installation = unwrapAgent(
    await invokeAgentera<AgenteraAgentInstallationSummary>(
      employeeDevice,
      "installVersion",
      {
        definitionId: definition.id,
        versionId: versionOne.id,
        profileName: EMPLOYEE_PROFILE,
      },
    ),
  );
  expect(installation).toMatchObject({
    sourceScope: "ORGANIZATION",
    status: "active",
    selectedVersionId: versionOne.id,
  });
  const employeeProfile = deviceProfilePath(employeeDevice, EMPLOYEE_PROFILE);
  const fixture = await seedExperienceCandidateProfile(employeeProfile);
  const modelOrigin = await startModelServer();
  const configuredModel = await employeeDevice.page.evaluate(
    async ({ baseUrl, model, profileId, providerName }) => {
      await window.hermesAPI.upsertCustomProvider(profileId, {
        name: providerName,
        baseUrl,
      });
      await window.hermesAPI.addModel(
        model,
        "custom",
        model,
        baseUrl,
        64_000,
        providerName,
        "chat_completions",
      );
      await window.hermesAPI.setModelConfig(
        "custom",
        model,
        baseUrl,
        profileId,
      );
      return window.hermesAPI.getModelConfig(profileId);
    },
    {
      baseUrl: `${modelOrigin}/v1`,
      model: "organization-experience-e2e",
      profileId: EMPLOYEE_PROFILE,
      providerName: "organization-experience-e2e",
    },
  );
  expect(configuredModel).toEqual({
    provider: customProviderRuntimeRoute("organization-experience-e2e"),
    model: "organization-experience-e2e",
    baseUrl: `${modelOrigin}/v1`,
  });
  await appendFile(
    join(employeeProfile, ".env"),
    "CUSTOM_API_KEY=e2e-loopback-only\n",
    "utf8",
  );
  await startBoundConversation(employeeDevice, EMPLOYEE_PROFILE, "org-exp-v1");
  await expect
    .poll(async () => (await localAgentControlState(employeeDevice!)).bindings)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationKey: "org-exp-v1",
          agentVersionId: versionOne.id,
        }),
      ]),
    );
  await expect.poll(() => completedModelResponses).toBeGreaterThan(0);

  const privateBefore = await privateProfileSnapshot(
    employeeProfile,
    fixture.privateMarkers,
  );
  const eligible = unwrapAgent(
    await invokeAgentera<EligibleExperienceSkill[]>(
      employeeDevice,
      "listEligibleOrganizationExperienceSkills",
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

  const submissionPath = `/api/v1/organizations/${organization.id}/agent-definitions/${definition.id}/experience-candidates`;
  const requestsBeforeBlocked = agentControlRequests(harness).length;
  expect(
    await invokeAgentera<OrganizationExperienceCandidatePreview>(
      employeeDevice,
      "prepareOrganizationExperienceCandidate",
      {
        installationId: installation.id,
        skillName: fixture.unsafeSkillName,
      },
    ),
  ).toMatchObject({
    ok: false,
    errorCode: "candidate_dlp_blocked",
  });
  expect(agentControlRequests(harness)).toHaveLength(requestsBeforeBlocked);

  const prepared = unwrapAgent(
    await invokeAgentera<OrganizationExperienceCandidatePreview>(
      employeeDevice,
      "prepareOrganizationExperienceCandidate",
      {
        installationId: installation.id,
        skillName: fixture.selectedSkillName,
      },
    ),
  );
  expect(prepared).toMatchObject({
    installationId: installation.id,
    sourceAgentVersionId: versionOne.id,
    skillName: fixture.selectedSkillName,
    findings: [],
  });

  failNextAgentControlRequest(harness, submissionPath);
  expect(
    await invokeAgentera<OrganizationExperienceCandidateSummary>(
      employeeDevice,
      "submitOrganizationExperienceCandidate",
      {
        candidateHandle: prepared.candidateHandle,
        confirmation: "submit-selected-organization-skill",
      },
    ),
  ).toEqual({ ok: false, errorCode: "cloud_unavailable" });
  expect(
    await privateProfileSnapshot(employeeProfile, fixture.privateMarkers),
  ).toEqual(privateBefore);

  const submitted = unwrapAgent(
    await invokeAgentera<OrganizationExperienceCandidateSummary>(
      employeeDevice,
      "submitOrganizationExperienceCandidate",
      {
        candidateHandle: prepared.candidateHandle,
        confirmation: "submit-selected-organization-skill",
      },
    ),
  );
  expect(submitted).toMatchObject({
    cloudCandidateId: expect.any(String),
    skillName: fixture.selectedSkillName,
    localStatus: "SUBMITTED",
    reviewStatus: "PENDING_REVIEW",
  });
  if (!submitted.cloudCandidateId) {
    throw new Error("Organization candidate ID is unavailable.");
  }

  const queue = unwrapAgent(
    await invokeAgentera<OrganizationExperienceCandidateSummary[]>(
      ownerDevice,
      "listOrganizationExperienceReviewQueue",
    ),
  );
  const pending = queue.find(
    ({ cloudCandidateId }) => cloudCandidateId === submitted.cloudCandidateId,
  );
  if (!pending?.reviewHandle) {
    throw new Error("Organization candidate review handle is unavailable.");
  }
  const detail = unwrapAgent(
    await invokeAgentera<OrganizationExperienceCandidateDetail>(
      ownerDevice,
      "getOrganizationExperienceCandidate",
      submitted.cloudCandidateId,
    ),
  );
  expect(detail.bundle.skillName).toBe(fixture.selectedSkillName);
  const approved = unwrapAgent(
    await invokeAgentera<OrganizationExperienceCandidateDetail>(
      ownerDevice,
      "reviewOrganizationExperienceCandidate",
      {
        reviewHandle: pending.reviewHandle,
        confirmation: "approve-organization-experience",
        reasonCode: null,
        safeNote: null,
      },
    ),
  );
  expect(approved.reviewStatus).toBe("APPROVED");

  const importPreview = unwrapAgent(
    await invokeAgentera<OrganizationExperienceCandidateImportPreview>(
      ownerDevice,
      "prepareOrganizationExperienceImport",
      submitted.cloudCandidateId,
    ),
  );
  expect(importPreview).toMatchObject({
    sourceVersionId: versionOne.id,
    latestVersionId: versionOne.id,
    skillName: fixture.selectedSkillName,
  });
  const importedDraft = unwrapAgent(
    await invokeAgentera<AgentDraftDetail>(
      ownerDevice,
      "confirmOrganizationExperienceImport",
      {
        importHandle: importPreview.importHandle,
        confirmation: "apply-approved-skill-to-organization-draft",
      },
    ),
  );
  expect(importedDraft).toMatchObject({
    sourceAgentDefinitionId: definition.id,
    baseAgentVersionId: versionOne.id,
  });
  expect(
    importedDraft.editableAssets.find(
      ({ path }) => path === `skills/${fixture.selectedSkillName}/SKILL.md`,
    )?.content,
  ).toContain(fixture.selectedMarker);

  const nextSubmissionPreview = unwrapAgent(
    await invokeAgentera<OrganizationSubmissionPreview>(
      ownerDevice,
      "prepareOrganizationSubmission",
      importedDraft.id,
    ),
  );
  expect(nextSubmissionPreview.kind).toBe("next");
  const nextSubmission = unwrapAgent(
    await invokeAgentera<OrganizationAgentSubmissionSummary>(
      ownerDevice,
      "confirmOrganizationSubmission",
      {
        publicationHandle: nextSubmissionPreview.publicationHandle,
        confirmation: "submit-organization-agent",
      },
    ),
  );
  const approvedNext = await approveSubmission(ownerDevice, nextSubmission.id);
  if (!approvedNext.publishedVersionId) {
    throw new Error("Organization version two is unavailable.");
  }

  unwrapAgent(
    await invokeAgentera<AgenteraAgentInstallationSummary>(
      employeeDevice,
      "selectInstallationVersion",
      {
        id: installation.id,
        versionId: approvedNext.publishedVersionId,
        localProfileId: EMPLOYEE_PROFILE,
      },
    ),
  );
  const reply = await employeeDevice.page.evaluate(
    async ({ profile, runId }) =>
      window.hermesAPI.sendMessage(
        "Use the approved Organization experience in this new conversation.",
        profile,
        undefined,
        undefined,
        undefined,
        undefined,
        runId,
      ),
    { profile: EMPLOYEE_PROFILE, runId: "org-exp-v2" },
  );
  expect(reply.response).toContain("ORGANIZATION_EXPERIENCE_MODEL_REPLY");
  await expect
    .poll(async () => (await localAgentControlState(employeeDevice!)).bindings)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationKey: "org-exp-v1",
          agentVersionId: versionOne.id,
        }),
        expect.objectContaining({
          conversationKey: "org-exp-v2",
          agentVersionId: approvedNext.publishedVersionId,
        }),
      ]),
    );
  expect(
    await privateProfileSnapshot(employeeProfile, fixture.privateMarkers),
  ).toEqual(privateBefore);

  const submissions = agentControlRequests(harness).filter(
    ({ method, path }) => method === "POST" && path === submissionPath,
  );
  expect(submissions).toHaveLength(2);
  for (const request of submissions) {
    expect(Object.keys(request.body as Record<string, unknown>).sort()).toEqual(
      [
        "bundle",
        "dlp_contract_version",
        "schema_version",
        "skill_name",
        "source_version_id",
      ],
    );
  }
  const captured = JSON.stringify(agentControlRequests(harness));
  expect(captured).toContain(fixture.selectedMarker);
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
    "sourceRelativePath",
  ]) {
    expect(captured).not.toContain(forbidden);
  }
});
