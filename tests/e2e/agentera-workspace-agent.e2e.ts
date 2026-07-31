import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "playwright/test";

import type {
  AgentDraftDetail,
  AgenteraAgentControlPublicState,
  AgenteraAgentControlResult,
  CreateAgentDraftInput,
  PublicationPreview,
  PublishedRevision,
} from "../../src/shared/agentera-agent-control";
import type {
  AgenteraWorkspaceResult,
  WorkspaceInvitationAcceptance,
  WorkspaceInvitationCreation,
  WorkspacePublicState,
  WorkspaceSummary,
} from "../../src/shared/agentera-workspace";
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
  privateProfileSnapshot,
  startBoundConversation,
  type AgentControlDevice,
  type AgentControlHarness,
} from "./support/agentera-agent-control-harness";

const OWNER_PHONE = "+8613900000041";
const MEMBER_PHONE = "+8613900000042";
const MEMBER_PROFILE = "workspace-member-agent";
const RENAMED_WORKSPACE_AGENT = "Renamed Workspace research Agent";
const MEMBER_MEMORY_SECRET = "WORKSPACE_MEMBER_PRIVATE_MEMORY_2026_07_20";
const MEMBER_SKILL_SECRET = "WORKSPACE_MEMBER_PRIVATE_SKILL_2026_07_20";
const PRIVATE_MARKERS = [
  ".env",
  "MEMORY.md",
  "USER.md",
  "sessions/authoring.json",
  "files/private.txt",
  "skills/local-authoring/SKILL.md",
  "skills/member-learned/SKILL.md",
  "curator/state.json",
  "adaptive/device-marker.txt",
] as const;

type WorkspaceMethod =
  | "getState"
  | "select"
  | "create"
  | "createInvitation"
  | "acceptInvitation";

interface CachedVersionRow {
  tenantId: string;
  ownerId: string;
  versionId: string;
  relativePath: string;
}

interface LocalInstallationOwnerRow {
  tenantId: string;
  ownerId: string;
  deviceInstallationId: string;
  sourceScope: string;
  sourceWorkspaceId: string | null;
}

interface RuntimeBindingPayload {
  conversationKey: string;
  ownerScope: string;
  agentVersionId: string;
  agentInstallationId: string;
  runtimeProfileId: string;
  [key: string]: unknown;
}

let harness: AgentControlHarness | null = null;
let ownerDevice: AgentControlDevice | null = null;
let memberDevice: AgentControlDevice | null = null;

test.setTimeout(180_000);

function diagnosticContext(): string {
  return JSON.stringify({
    exchanges: harness ? agentControlExchangeDiagnostics(harness) : [],
    processes: [
      ...deviceProcessDiagnostics(ownerDevice),
      ...deviceProcessDiagnostics(memberDevice),
    ],
  });
}

function unwrapAgent<T>(result: AgenteraAgentControlResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Workspace Agent operation failed: ${result.errorCode}; ${diagnosticContext()}`,
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

function workspaceDraft(content: string): CreateAgentDraftInput {
  return {
    sourceAgentDefinitionId: null,
    baseAgentVersionId: null,
    displayName: "Workspace research Agent",
    icon: null,
    manifest: {
      schemaVersion: 1,
      identity: {
        systemPrompt: `Use the immutable Workspace base: ${content}`,
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
        content: `---\nname: research\ndescription: Approved Workspace research skill\n---\n\n${content}\n`,
      },
      { path: "sop/research.md", content: `# Approved SOP\n${content}\n` },
      {
        path: "knowledge/research.md",
        content: `# Approved knowledge\n${content}\n`,
      },
    ],
  };
}

async function publishWorkspaceDraft(
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

async function updateWorkspaceDraft(
  device: AgentControlDevice,
  draftId: string,
  content: string,
  displayName: string,
): Promise<AgentDraftDetail> {
  const current = unwrapAgent(
    await invokeAgentera<AgentDraftDetail>(device, "getDraft", draftId),
  );
  const {
    sourceAgentDefinitionId: _sourceAgentDefinitionId,
    baseAgentVersionId: _baseAgentVersionId,
    ...editable
  } = workspaceDraft(content);
  return unwrapAgent(
    await invokeAgentera<AgentDraftDetail>(device, "updateDraft", {
      ...editable,
      displayName,
      id: current.id,
      expectedRevision: current.revision,
    }),
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

async function writeMemberLearning(profilePath: string): Promise<void> {
  await writeFile(
    join(profilePath, "MEMORY.md"),
    `# Member local Memory\n${MEMBER_MEMORY_SECRET}\n`,
    "utf8",
  );
  const skillPath = join(profilePath, "skills/member-learned/SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(
    skillPath,
    `# Member learned Skill\n${MEMBER_SKILL_SECRET}\n`,
    "utf8",
  );
}

function openControlDatabase(device: AgentControlDevice): DatabaseSync {
  return new DatabaseSync(
    join(device.userData, "agentera-control-plane", "control-plane.db"),
    { readOnly: true },
  );
}

function cachedVersionRows(device: AgentControlDevice): CachedVersionRow[] {
  const database = openControlDatabase(device);
  try {
    return database
      .prepare(
        `SELECT tenant_id, owner_id, version_id, cache_relative_path
         FROM cached_agent_versions
         ORDER BY version_id`,
      )
      .all()
      .map((row) => ({
        tenantId: String(row.tenant_id),
        ownerId: String(row.owner_id),
        versionId: String(row.version_id),
        relativePath: String(row.cache_relative_path),
      }));
  } finally {
    database.close();
  }
}

function installationOwner(
  device: AgentControlDevice,
  installationId: string,
): LocalInstallationOwnerRow {
  const database = openControlDatabase(device);
  try {
    const row = database
      .prepare(
        `SELECT tenant_id, owner_id, device_installation_id,
                source_scope, source_workspace_id
         FROM local_agent_installations
         WHERE agent_installation_id = ?`,
      )
      .get(installationId);
    if (!row) throw new Error("Workspace installation row is missing.");
    return {
      tenantId: String(row.tenant_id),
      ownerId: String(row.owner_id),
      deviceInstallationId: String(row.device_installation_id),
      sourceScope: String(row.source_scope),
      sourceWorkspaceId:
        row.source_workspace_id === null
          ? null
          : String(row.source_workspace_id),
    };
  } finally {
    database.close();
  }
}

function runtimeBindingPayloads(
  device: AgentControlDevice,
): RuntimeBindingPayload[] {
  const database = openControlDatabase(device);
  try {
    return database
      .prepare(
        `SELECT binding_json FROM runtime_bindings
         ORDER BY created_at, id`,
      )
      .all()
      .map((row) => {
        if (typeof row.binding_json !== "string") {
          throw new Error("RuntimeBinding fixture is corrupt.");
        }
        return JSON.parse(row.binding_json) as RuntimeBindingPayload;
      });
  } finally {
    database.close();
  }
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

test.beforeAll(async () => {
  harness = await createAgentControlHarness();
});

test.afterAll(async () => {
  await closeAgentControlHarness(harness);
  harness = null;
  ownerDevice = null;
  memberDevice = null;
});

// @lat: [[agentera-agent-control-plane#Release gate#Workspace Agent isolation]]
// @lat: [[agentera-workspaces#Release gate#Workspace Agent runtime boundary]]
// @lat: [[agentera-self-evolution#Local learning loop]]
test("publishes Workspace versions while Member learning and RuntimeBindings remain USER-local", async () => {
  if (!harness) throw new Error("Workspace Agent E2E harness is unavailable.");

  harness.phone = OWNER_PHONE;
  ownerDevice = await launchAgentControlDevice(harness, "A");
  await authenticateFirstAgentControlDevice(harness, ownerDevice);
  await claimDefaultProfile(ownerDevice);
  const ownerProfile = deviceProfilePath(ownerDevice, "default");
  const ownerPrivateBefore = await privateProfileSnapshot(
    ownerProfile,
    PRIVATE_MARKERS,
  );

  await resetBrowserIdentity(harness);
  harness.phone = MEMBER_PHONE;
  memberDevice = await launchAgentControlDevice(harness, "B");
  await authenticateFirstAgentControlDevice(harness, memberDevice);
  await claimDefaultProfile(memberDevice);
  const memberDefaultProfile = deviceProfilePath(memberDevice, "default");
  const memberDefaultBefore = await privateProfileSnapshot(
    memberDefaultProfile,
    PRIVATE_MARKERS,
  );

  const workspace = unwrapWorkspace(
    await invokeWorkspace<WorkspaceSummary>(ownerDevice, "create", {
      displayName: "Workspace Agent E2E",
    }),
  );
  const invitation = unwrapWorkspace(
    await invokeWorkspace<WorkspaceInvitationCreation>(
      ownerDevice,
      "createInvitation",
      { workspaceId: workspace.id },
    ),
  );
  if (!invitation.token) throw new Error("Invitation secret is unavailable.");
  unwrapWorkspace(
    await invokeWorkspace<WorkspaceInvitationAcceptance>(
      memberDevice,
      "acceptInvitation",
      { token: invitation.token },
    ),
  );
  unwrapWorkspace(
    await invokeWorkspace<WorkspacePublicState>(ownerDevice, "select", {
      workspaceId: workspace.id,
    }),
  );
  unwrapWorkspace(
    await invokeWorkspace<WorkspacePublicState>(memberDevice, "select", {
      workspaceId: workspace.id,
    }),
  );
  await waitForAgentContext(ownerDevice, {
    scope: "WORKSPACE",
    workspaceId: workspace.id,
    role: "owner",
  });
  await waitForAgentContext(memberDevice, {
    scope: "WORKSPACE",
    workspaceId: workspace.id,
    role: "member",
  });

  const requestsBeforeMemberAuthoring = agentControlRequests(harness).length;
  const deniedMemberDraft = await invokeAgentera(
    memberDevice,
    "createDraft",
    workspaceDraft("Member must not publish this"),
  );
  expect(deniedMemberDraft).toEqual({
    ok: false,
    errorCode: "workspace_forbidden",
  });
  expect(agentControlRequests(harness)).toHaveLength(
    requestsBeforeMemberAuthoring,
  );

  const draft = unwrapAgent(
    await invokeAgentera<AgentDraftDetail>(
      ownerDevice,
      "createDraft",
      workspaceDraft("Workspace base version one"),
    ),
  );
  const versionOne = await publishWorkspaceDraft(ownerDevice, draft.id);
  expect(versionOne.versionNumber).toBe(1);

  const discovered = unwrapAgent(
    await invokeAgentera(memberDevice, "listDefinitions"),
  ) as Array<{ id: string; latestVersionId: string | null }>;
  expect(discovered).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: versionOne.definitionId,
        latestVersionId: versionOne.versionId,
      }),
    ]),
  );

  const memberInstallation = unwrapAgent(
    await invokeAgentera(memberDevice, "installVersion", {
      definitionId: versionOne.definitionId,
      versionId: versionOne.versionId,
      profileName: MEMBER_PROFILE,
    }),
  ) as { id: string; runtimeProfileId: string | null };
  const memberProfile = deviceProfilePath(memberDevice, MEMBER_PROFILE);
  expect(memberProfile).not.toBe(memberDefaultProfile);
  expect(memberProfile).not.toBe(ownerProfile);
  expect(memberInstallation.runtimeProfileId).not.toBeNull();

  const localOwner = installationOwner(memberDevice, memberInstallation.id);
  expect(localOwner).toMatchObject({
    sourceScope: "WORKSPACE",
    sourceWorkspaceId: workspace.id,
  });
  expect(localOwner.tenantId).toMatch(/^[0-9a-f-]{36}$/);
  expect(localOwner.ownerId).toMatch(/^[0-9a-f-]{36}$/);
  expect(localOwner.deviceInstallationId).toMatch(/^[0-9a-f-]{36}$/);

  await startBoundConversation(memberDevice, MEMBER_PROFILE, "member-v1");
  await expect
    .poll(
      async () => (await localAgentControlState(memberDevice!)).bindings.length,
    )
    .toBe(1);
  expect(
    (await localAgentControlState(memberDevice)).bindings[0],
  ).toMatchObject({
    conversationKey: "member-v1",
    agentVersionId: versionOne.versionId,
    agentInstallationId: memberInstallation.id,
  });

  await writeMemberLearning(memberProfile);
  const memberLearning = await privateProfileSnapshot(
    memberProfile,
    PRIVATE_MARKERS,
  );
  expect(await readFile(join(memberProfile, "MEMORY.md"), "utf8")).toContain(
    MEMBER_MEMORY_SECRET,
  );
  expect(
    await readFile(
      join(memberProfile, "skills/member-learned/SKILL.md"),
      "utf8",
    ),
  ).toContain(MEMBER_SKILL_SECRET);

  await updateWorkspaceDraft(
    ownerDevice,
    draft.id,
    "Workspace base version two",
    RENAMED_WORKSPACE_AGENT,
  );
  const versionTwo = await publishWorkspaceDraft(ownerDevice, draft.id);
  expect(versionTwo.versionNumber).toBe(2);
  for (const device of [ownerDevice, memberDevice]) {
    const definitions = unwrapAgent(
      await invokeAgentera(device, "listDefinitions"),
    ) as Array<{ id: string; displayName: string }>;
    expect(definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: versionOne.definitionId,
          displayName: RENAMED_WORKSPACE_AGENT,
        }),
      ]),
    );
  }
  expect(await privateProfileSnapshot(memberProfile, PRIVATE_MARKERS)).toEqual(
    memberLearning,
  );

  unwrapAgent(
    await invokeAgentera(memberDevice, "selectInstallationVersion", {
      id: memberInstallation.id,
      versionId: versionTwo.versionId,
      localProfileId: MEMBER_PROFILE,
    }),
  );
  expect(await privateProfileSnapshot(memberProfile, PRIVATE_MARKERS)).toEqual(
    memberLearning,
  );

  const beforeSecondConversation = await localAgentControlState(memberDevice);
  expect(beforeSecondConversation.bindings[0].agentVersionId).toBe(
    versionOne.versionId,
  );
  await startBoundConversation(memberDevice, MEMBER_PROFILE, "member-v2");
  await expect
    .poll(
      async () => (await localAgentControlState(memberDevice!)).bindings.length,
    )
    .toBe(2);
  const updated = await localAgentControlState(memberDevice);
  expect(
    updated.bindings.find((binding) => binding.conversationKey === "member-v1")
      ?.agentVersionId,
  ).toBe(versionOne.versionId);
  expect(
    updated.bindings.find((binding) => binding.conversationKey === "member-v2")
      ?.agentVersionId,
  ).toBe(versionTwo.versionId);

  const bindingPayloads = runtimeBindingPayloads(memberDevice);
  expect(bindingPayloads).toHaveLength(2);
  for (const binding of bindingPayloads) {
    expect(binding.ownerScope).toBe("USER");
    expect(binding).not.toHaveProperty("workspaceId");
    expect(binding).not.toHaveProperty("workspace_id");
  }

  const ownerCache = cachedVersionRows(ownerDevice);
  const memberCache = cachedVersionRows(memberDevice);
  for (const versionId of [versionOne.versionId, versionTwo.versionId]) {
    const ownerRow = ownerCache.find((row) => row.versionId === versionId);
    const memberRow = memberCache.find((row) => row.versionId === versionId);
    expect(ownerRow).toBeTruthy();
    expect(memberRow).toBeTruthy();
    expect(ownerRow?.tenantId).not.toBe(memberRow?.tenantId);
    expect(ownerRow?.ownerId).not.toBe(memberRow?.ownerId);
    expect(ownerRow?.relativePath).not.toBe(memberRow?.relativePath);
  }

  expect(updated.projectionRoots).toHaveLength(1);
  const projectionRoot = updated.projectionRoots[0];
  await assertReadOnlyTree(join(projectionRoot, "active"));
  await assertReadOnlyTree(
    join(
      projectionRoot,
      "versions",
      versionOne.versionId,
      versionOne.contentDigest,
    ),
  );
  await assertReadOnlyTree(
    join(
      projectionRoot,
      "versions",
      versionTwo.versionId,
      versionTwo.contentDigest,
    ),
  );

  expect(await privateProfileSnapshot(ownerProfile, PRIVATE_MARKERS)).toEqual(
    ownerPrivateBefore,
  );
  expect(
    await privateProfileSnapshot(memberDefaultProfile, PRIVATE_MARKERS),
  ).toEqual(memberDefaultBefore);
  expect(await privateProfileSnapshot(memberProfile, PRIVATE_MARKERS)).toEqual(
    memberLearning,
  );

  await expect
    .poll(() => cloudAgentControlCounts(harness!))
    .toMatchObject({
      definitions: 1,
      versions: 2,
      installations: 1,
      runtimeBindings: 2,
    });

  const requests = agentControlRequests(harness);
  expect(
    requests.some(
      (request) =>
        request.method === "POST" &&
        request.path === `/api/v1/workspaces/${workspace.id}/agent-definitions`,
    ),
  ).toBe(true);
  expect(
    requests.some(
      (request) =>
        request.method === "POST" &&
        request.path ===
          `/api/v1/workspaces/${workspace.id}/agent-definitions/${versionOne.definitionId}/versions`,
    ),
  ).toBe(true);
  const nextPublicationRequest = requests.find(
    (request) =>
      request.method === "POST" &&
      request.path ===
        `/api/v1/workspaces/${workspace.id}/agent-definitions/${versionOne.definitionId}/versions`,
  );
  expect(nextPublicationRequest?.body).toMatchObject({
    base_version_id: versionOne.versionId,
    display_name: RENAMED_WORKSPACE_AGENT,
  });
  const installationRequest = requests.find(
    (request) =>
      request.method === "POST" &&
      request.path === "/api/v1/agent-installations",
  );
  expect(installationRequest?.body).toMatchObject({
    workspace_id: workspace.id,
    definition_id: versionOne.definitionId,
    version_id: versionOne.versionId,
  });

  const captured = JSON.stringify(requests);
  for (const forbidden of [
    MEMBER_MEMORY_SECRET,
    MEMBER_SKILL_SECRET,
    createHash("sha256").update(MEMBER_MEMORY_SECRET).digest("hex"),
    createHash("sha256").update(MEMBER_SKILL_SECRET).digest("hex"),
    "refreshToken",
    "offlineEntitlement",
    "devicePrivateKey",
    "profilePath",
    "filePath",
    "MEMORY.md",
    "USER.md",
    "sessions/authoring.json",
    "curator/state.json",
  ]) {
    expect(captured).not.toContain(forbidden);
  }
});
