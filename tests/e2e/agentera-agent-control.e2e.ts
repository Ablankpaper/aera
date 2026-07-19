import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect, test } from "playwright/test";

import type {
  AgentDraftDetail,
  AgenteraAgentControlResult,
  CreateAgentDraftInput,
  PublishedRevision,
} from "../../src/shared/agentera-agent-control";
import {
  agentControlExchangeDiagnostics,
  agentControlRequests,
  authenticateExistingAgentControlDevice,
  authenticateFirstAgentControlDevice,
  claimDefaultProfile,
  closeAgentControlHarness,
  cloudAgentControlCounts,
  createAgentControlHarness,
  deviceProcessDiagnostics,
  deviceProfilePath,
  encryptedDevicePrivateKey,
  failNextAgentControlRequest,
  invokeAgentera,
  launchAgentControlDevice,
  localAgentControlState,
  privateProfileSnapshot,
  startBoundConversation,
  type AgentControlDevice,
  type AgentControlHarness,
} from "./support/agentera-agent-control-harness";

const PRIVATE_MARKERS = [
  ".env",
  "MEMORY.md",
  "USER.md",
  "sessions/authoring.json",
  "files/private.txt",
  "skills/local-authoring/SKILL.md",
  "curator/state.json",
  "adaptive/device-marker.txt",
] as const;

const DEVICE_A_MEMORY_SECRET = "DEVICE_A_NATIVE_MEMORY_SECRET_2026_07_19";
const DEVICE_A_SKILL_SECRET = "DEVICE_A_LEARNED_SKILL_SECRET_2026_07_19";

let harness: AgentControlHarness | null = null;
let deviceA: AgentControlDevice | null = null;
let deviceB: AgentControlDevice | null = null;

function unwrap<T>(result: AgenteraAgentControlResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Agent control failed: ${result.errorCode}; exchanges=${JSON.stringify(
        harness ? agentControlExchangeDiagnostics(harness) : [],
      )}; process=${JSON.stringify([
        ...deviceProcessDiagnostics(deviceA),
        ...deviceProcessDiagnostics(deviceB),
      ])}`,
    );
  }
  expect(result.ok).toBe(true);
  return result.data;
}

function draftInput(content: string): CreateAgentDraftInput {
  return {
    sourceAgentDefinitionId: null,
    baseAgentVersionId: null,
    displayName: "Two-device research Agent",
    icon: null,
    manifest: {
      schemaVersion: 1,
      identity: { systemPrompt: "Use only the explicitly published base." },
      assets: [
        {
          path: "skills/research/SKILL.md",
          kind: "skill",
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
        content: `---\nname: research\ndescription: Published research workflow\n---\n\n${content}\n`,
      },
      { path: "knowledge/research.md", content: `${content}\n` },
    ],
  };
}

async function publish(
  device: AgentControlDevice,
  draftId: string,
): Promise<PublishedRevision> {
  const preview = unwrap(
    await invokeAgentera(device, "preparePublication", draftId),
  );
  const confirmed = await invokeAgentera<PublishedRevision>(
    device,
    "confirmPublication",
    preview.publicationHandle,
  );
  if (!confirmed.ok) {
    const detail = await invokeAgentera<AgentDraftDetail>(
      device,
      "getDraft",
      draftId,
    );
    throw new Error(
      `Publication failed: ${confirmed.errorCode}; attempt=${JSON.stringify(
        detail.ok ? detail.data.lastPublicationAttempt : null,
      )}; exchanges=${JSON.stringify(
        harness ? agentControlExchangeDiagnostics(harness) : [],
      )}`,
    );
  }
  return confirmed.data;
}

async function updateForVersionTwo(
  device: AgentControlDevice,
  draftId: string,
): Promise<AgentDraftDetail> {
  const current = unwrap<AgentDraftDetail>(
    await invokeAgentera(device, "getDraft", draftId),
  );
  const {
    sourceAgentDefinitionId: _sourceAgentDefinitionId,
    baseAgentVersionId: _baseAgentVersionId,
    ...next
  } = draftInput("Published base version two");
  return unwrap(
    await invokeAgentera(device, "updateDraft", {
      ...next,
      id: current.id,
      expectedRevision: current.revision,
    }),
  );
}

async function writeDeviceALearning(profilePath: string): Promise<void> {
  await writeFile(
    join(profilePath, "MEMORY.md"),
    `# Native local Memory\n${DEVICE_A_MEMORY_SECRET}\n`,
    "utf8",
  );
  const learnedSkill = join(profilePath, "skills/learned-local/SKILL.md");
  await mkdir(dirname(learnedSkill), { recursive: true });
  await writeFile(
    learnedSkill,
    `# Native learned Skill\n${DEVICE_A_SKILL_SECRET}\n`,
    "utf8",
  );
}

test.beforeAll(async () => {
  harness = await createAgentControlHarness();
});

test.afterAll(async () => {
  await closeAgentControlHarness(harness);
  harness = null;
  deviceA = null;
  deviceB = null;
});

// @lat: [[agentera-agent-control-plane#Release gate#Two-device boundary]]
// @lat: [[agentera-agent-control-plane#Release gate]]
// @lat: [[agentera-self-evolution#Release gate]]
test("shares immutable Agent versions while every Hermes adaptive state remains device-local", async () => {
  if (!harness) throw new Error("Agent control E2E harness is unavailable.");

  deviceA = await launchAgentControlDevice(harness, "A");
  await authenticateFirstAgentControlDevice(harness, deviceA);
  await claimDefaultProfile(deviceA);

  deviceB = await launchAgentControlDevice(harness, "B");
  await authenticateExistingAgentControlDevice(harness, deviceB);
  await claimDefaultProfile(deviceB);

  expect(deviceA.userData).not.toBe(deviceB.userData);
  expect(deviceA.hermesHome).not.toBe(deviceB.hermesHome);
  expect(await encryptedDevicePrivateKey(deviceA)).not.toBe(
    await encryptedDevicePrivateKey(deviceB),
  );

  const created = unwrap<AgentDraftDetail>(
    await invokeAgentera(
      deviceA,
      "createDraft",
      draftInput("Published base version one"),
    ),
  );
  await expect
    .poll(() => cloudAgentControlCounts(harness))
    .toMatchObject({ definitions: 0, versions: 0, installations: 0 });

  const versionOne = await publish(deviceA, created.id);
  await expect
    .poll(() => cloudAgentControlCounts(harness))
    .toMatchObject({ definitions: 1, versions: 1, installations: 0 });

  const aProfile = deviceProfilePath(deviceA, "default");
  const aBeforeClaim = await privateProfileSnapshot(aProfile, PRIVATE_MARKERS);
  const aInstallation = unwrap(
    await invokeAgentera(deviceA, "claimVersion", {
      definitionId: versionOne.definitionId,
      versionId: versionOne.versionId,
      localProfileId: "default",
      confirmation: "claim-existing-profile",
    }),
  );
  expect(await privateProfileSnapshot(aProfile, PRIVATE_MARKERS)).toEqual(
    aBeforeClaim,
  );

  const discovered = unwrap(await invokeAgentera(deviceB, "listDefinitions"));
  expect(discovered).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: versionOne.definitionId,
        latestVersionId: versionOne.versionId,
      }),
    ]),
  );

  const beforeFailedInstallA = await privateProfileSnapshot(
    aProfile,
    PRIVATE_MARKERS,
  );
  const beforeFailedInstallB = await privateProfileSnapshot(
    deviceProfilePath(deviceB, "default"),
    PRIVATE_MARKERS,
  );
  failNextAgentControlRequest(harness, "/api/v1/agent-installations");
  const failedInstall = await invokeAgentera(deviceB, "installVersion", {
    definitionId: versionOne.definitionId,
    versionId: versionOne.versionId,
    profileName: "failed-installation-probe",
  });
  expect(failedInstall.ok).toBe(false);
  expect(await privateProfileSnapshot(aProfile, PRIVATE_MARKERS)).toEqual(
    beforeFailedInstallA,
  );
  expect(
    await privateProfileSnapshot(
      deviceProfilePath(deviceB, "default"),
      PRIVATE_MARKERS,
    ),
  ).toEqual(beforeFailedInstallB);

  const bInstallationResult = await invokeAgentera(deviceB, "installVersion", {
    definitionId: versionOne.definitionId,
    versionId: versionOne.versionId,
    profileName: "device-b-agent",
  });
  if (!bInstallationResult.ok) {
    const pending = await invokeAgentera(deviceB, "listInstallations");
    const freshProfile = await privateProfileSnapshot(
      deviceProfilePath(deviceB, "device-b-agent"),
      [
        ".env",
        "auth.json",
        "MEMORY.md",
        "USER.md",
        "sessions",
        "files",
        "skills",
        "curator",
        ".curator",
        "config.yaml",
        "profile-meta.json",
      ],
    );
    throw new Error(
      `Device B installation failed: ${bInstallationResult.errorCode}; local=${JSON.stringify(
        pending,
      )}; freshProfile=${JSON.stringify(freshProfile)}; exchanges=${JSON.stringify(
        agentControlExchangeDiagnostics(harness),
      )}`,
    );
  }
  const bInstallation = bInstallationResult.data;
  const bProfile = deviceProfilePath(deviceB, "device-b-agent");
  const bAdaptiveMarker = join(bProfile, "adaptive/device-marker.txt");
  await mkdir(dirname(bAdaptiveMarker), { recursive: true });
  await writeFile(bAdaptiveMarker, "DEVICE_B_ADAPTIVE_MARKER\n", "utf8");

  expect(aInstallation.id).not.toBe(bInstallation.id);
  expect(aInstallation.runtimeProfileId).not.toBe(
    bInstallation.runtimeProfileId,
  );
  expect(aProfile).not.toBe(bProfile);
  expect(
    await readFile(join(aProfile, "adaptive/device-marker.txt"), "utf8"),
  ).not.toBe(await readFile(bAdaptiveMarker, "utf8"));

  await startBoundConversation(deviceA, "default", "device-a-v1");
  await startBoundConversation(deviceB, "device-b-agent", "device-b-v1");
  await expect
    .poll(async () => (await localAgentControlState(deviceA)).bindings.length)
    .toBe(1);
  await expect
    .poll(async () => (await localAgentControlState(deviceB)).bindings.length)
    .toBe(1);
  const aV1 = await localAgentControlState(deviceA);
  const bV1 = await localAgentControlState(deviceB);
  expect(aV1.bindings[0]).toMatchObject({
    agentVersionId: versionOne.versionId,
    agentInstallationId: aInstallation.id,
  });
  expect(bV1.bindings[0]).toMatchObject({
    agentVersionId: versionOne.versionId,
    agentInstallationId: bInstallation.id,
  });
  expect(aV1.bindings[0].localAdaptiveStateRevision).not.toBe(
    bV1.bindings[0].localAdaptiveStateRevision,
  );

  const bBeforeLearning = await privateProfileSnapshot(
    bProfile,
    PRIVATE_MARKERS,
  );
  await writeDeviceALearning(aProfile);
  expect(await privateProfileSnapshot(bProfile, PRIVATE_MARKERS)).toEqual(
    bBeforeLearning,
  );
  await expect(
    readFile(join(bProfile, "skills/learned-local/SKILL.md"), "utf8"),
  ).rejects.toThrow();

  await updateForVersionTwo(deviceA, created.id);
  const versionTwo = await publish(deviceA, created.id);
  expect(versionTwo.versionNumber).toBe(2);

  const bPrivateAfterLearning = await privateProfileSnapshot(
    bProfile,
    PRIVATE_MARKERS,
  );
  failNextAgentControlRequest(
    harness,
    `/api/v1/agent-installations/${bInstallation.id}/select-version`,
  );
  const failedUpdate = await invokeAgentera(
    deviceB,
    "selectInstallationVersion",
    {
      id: bInstallation.id,
      versionId: versionTwo.versionId,
      localProfileId: "device-b-agent",
    },
  );
  expect(failedUpdate.ok).toBe(false);
  expect(await privateProfileSnapshot(bProfile, PRIVATE_MARKERS)).toEqual(
    bPrivateAfterLearning,
  );

  const successfulUpdate = await invokeAgentera(
    deviceB,
    "selectInstallationVersion",
    {
      id: bInstallation.id,
      versionId: versionTwo.versionId,
      localProfileId: "device-b-agent",
    },
  );
  if (!successfulUpdate.ok) {
    throw new Error(
      `Agent control update failed: ${successfulUpdate.errorCode}; local=${JSON.stringify(
        await localAgentControlState(deviceB),
      )}; exchanges=${JSON.stringify(
        agentControlExchangeDiagnostics(harness),
      )}; process=${JSON.stringify(deviceProcessDiagnostics(deviceB))}`,
    );
  }
  const oldBinding = (await localAgentControlState(deviceB)).bindings[0];
  expect(oldBinding.agentVersionId).toBe(versionOne.versionId);
  await startBoundConversation(deviceB, "device-b-agent", "device-b-v2");
  await expect
    .poll(async () => (await localAgentControlState(deviceB)).bindings.length)
    .toBe(2);
  const bUpdated = await localAgentControlState(deviceB);
  expect(
    bUpdated.bindings.find(
      (binding) => binding.conversationKey === "device-b-v2",
    )?.agentVersionId,
  ).toBe(versionTwo.versionId);
  expect(
    bUpdated.bindings.find(
      (binding) => binding.conversationKey === "device-b-v1",
    )?.agentVersionId,
  ).toBe(versionOne.versionId);

  failNextAgentControlRequest(
    harness,
    `/api/v1/agent-installations/${bInstallation.id}/archive`,
  );
  const failedArchive = await invokeAgentera(
    deviceB,
    "archiveInstallation",
    bInstallation.id,
  );
  expect(failedArchive.ok).toBe(false);
  expect(await privateProfileSnapshot(bProfile, PRIVATE_MARKERS)).toEqual(
    bPrivateAfterLearning,
  );
  unwrap(
    await invokeAgentera(deviceB, "archiveInstallation", bInstallation.id),
  );
  expect(await privateProfileSnapshot(bProfile, PRIVATE_MARKERS)).toEqual(
    bPrivateAfterLearning,
  );

  const finalA = await localAgentControlState(deviceA);
  const finalB = await localAgentControlState(deviceB);
  expect(finalA.installations).toHaveLength(1);
  expect(finalB.installations).toHaveLength(1);
  expect(finalA.projectionRoots[0]).not.toBe(finalB.projectionRoots[0]);

  await expect
    .poll(() => cloudAgentControlCounts(harness))
    .toMatchObject({
      definitions: 1,
      versions: 2,
      installations: 2,
      runtimeBindings: 3,
    });

  const requests = agentControlRequests(harness);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.some((request) => request.path === "/api/agents")).toBe(
    false,
  );
  const captured = JSON.stringify(requests);
  for (const forbidden of [
    DEVICE_A_MEMORY_SECRET,
    DEVICE_A_SKILL_SECRET,
    createHash("sha256").update(DEVICE_A_MEMORY_SECRET).digest("hex"),
    createHash("sha256").update(DEVICE_A_SKILL_SECRET).digest("hex"),
    "refreshToken",
    "offlineEntitlement",
    "devicePrivateKey",
    "profilePath",
    "filePath",
    "curator/state.json",
    "sessions/authoring.json",
  ]) {
    expect(captured).not.toContain(forbidden);
  }
});
