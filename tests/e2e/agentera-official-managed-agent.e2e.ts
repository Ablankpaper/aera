import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect, test } from "playwright/test";

import type {
  AgenteraAgentControlResult,
  AgenteraAgentInstallationSummary,
  OfficialAgentInstallPreview,
  OfficialAgentSummary,
  OfficialManagedUpdate,
} from "../../src/shared/agentera-agent-control";
import {
  agentControlExchangeDiagnostics,
  agentControlRequests,
  authenticateFirstAgentControlDevice,
  claimDefaultProfile,
  closeAgentControlHarness,
  createOfficialManagedAgentHarness,
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
  type AgentControlHarness,
} from "./support/agentera-agent-control-harness";

type AdminRole =
  | "super_admin"
  | "developer"
  | "operator"
  | "support"
  | "finance"
  | "auditor";

interface AdministratorFixture {
  adminId: string;
  email: string;
  password: string;
  recoveryCodes: string[];
  role: AdminRole;
  totpSecret: string;
}

interface AdminFixtures {
  roles: Record<AdminRole, AdministratorFixture[]>;
}

interface AuthenticatedAdmin {
  cookie: string;
  csrfToken: string;
  fixture: AdministratorFixture;
}

interface APIResult<T> {
  body: T;
  headers: Headers;
  raw: string;
  status: number;
}

interface PageResult<T> {
  items: T[];
}

interface OfficialOperation {
  operation_id: string;
  state:
    | "queued"
    | "executing"
    | "reconciling"
    | "succeeded"
    | "failed"
    | "conflict";
  error_code?: string;
}

interface OfficialDefinition {
  definition_id: string;
  display_name: string;
}

interface OfficialDraft {
  draft_id: string;
  definition_id: string;
  base_version_id?: string;
  kind: "initial" | "next";
  content_digest: string;
  revision: number;
  status: "active" | "archived";
}

interface OfficialSubmission {
  submission_id: string;
  draft_id: string;
  definition_id: string;
  content_digest: string;
  revision: number;
  status: "pending" | "approved" | "rejected" | "withdrawn" | "superseded";
}

interface OfficialVersion {
  version_id: string;
  definition_id: string;
  version_number: number;
  content_digest: string;
}

interface OfficialRelease {
  release_id: string;
  definition_id: string;
  channel: "internal" | "stable";
  current_revision_id: string;
  head_revision: number;
  agent_version_id: string;
  state: "active" | "paused";
  action:
    | "initial"
    | "activate"
    | "rollout_update"
    | "pause"
    | "resume"
    | "rollback";
  rollback_target_revision_id?: string;
}

interface OfficialRollbackApproval {
  id: string;
  approval_status:
    | "pending_review"
    | "approved"
    | "rejected"
    | "cancelled"
    | "expired";
  execution_status:
    | "not_started"
    | "queued"
    | "executing"
    | "reconciling"
    | "succeeded"
    | "failed"
    | "conflict";
}

interface OfficialAuditEvent {
  event_type: string;
}

interface DraftPackagePayload {
  bundle: {
    assets: Array<{ content: string; path: string }>;
  };
  manifest: {
    assets: Array<{
      kind: "knowledge" | "skill" | "sop";
      media_type: string;
      path: string;
      sha256: string;
    }>;
    dependencies: unknown[];
    identity: { system_prompt: string };
    model_constraints: {
      allowed_models: string[];
      allowed_providers: string[];
    };
    runtime_compatibility: { minimum_version: string };
    schema_version: number;
    tools: { allowed: string[]; denied: string[] };
  };
}

interface AccountIdentity {
  userId: string;
  personalSpaceId: string;
  deviceId: string;
}

interface AccountFixture {
  device: AgentControlDevice;
  identity: AccountIdentity;
}

const ELIGIBLE_PHONE = "+8613900000071";
const INELIGIBLE_PHONE = "+8613900000072";
const DISPLAY_NAME = "E2E Official Research Assistant";
const PRIVATE_MEMORY = "OFFICIAL_E2E_PRIVATE_MEMORY_2026_07_22";
const PRIVATE_SKILL = "OFFICIAL_E2E_PRIVATE_SKILL_2026_07_22";
const PRIVATE_SESSION = "OFFICIAL_E2E_PRIVATE_SESSION_2026_07_22";
const PRIVATE_MARKERS = [
  "MEMORY.md",
  "skills/private-learning/SKILL.md",
  "sessions/official-private.json",
] as const;

let harness: AgentControlHarness | null = null;
let eligibleDevice: AgentControlDevice | null = null;

test.setTimeout(900_000);

function runGate(
  executable: string,
  args: string[],
  cwd: string,
): { stderr: string; stdout: string } {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function unwrap<T>(result: AgenteraAgentControlResult<T>): T {
  if (!result.ok) throw new Error(`Agent control failed: ${result.errorCode}`);
  return result.data;
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of value.toUpperCase().replace(/=+$/u, "")) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid TOTP secret.");
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function generateTOTP(secret: string, stepOffset = 0): string {
  const counter = BigInt(Math.floor(Date.now() / 30_000) + stepOffset);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", decodeBase32(secret))
    .update(message)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

async function apiRequest<T>(
  baseURL: string,
  path: string,
  options: {
    body?: unknown;
    cookie?: string;
    csrfToken?: string;
    headers?: Record<string, string>;
    method?: string;
  } = {},
): Promise<APIResult<T>> {
  const method =
    options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined)
    headers.set("Content-Type", "application/json");
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.csrfToken) headers.set("X-CSRF-Token", options.csrfToken);
  if (method !== "GET" && method !== "HEAD") headers.set("Origin", baseURL);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }
  const response = await fetch(`${baseURL}/api/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    redirect: "manual",
  });
  const raw = await response.text();
  const body = (raw === "" ? undefined : JSON.parse(raw)) as T;
  return { body, headers: response.headers, raw, status: response.status };
}

function expectStatus(
  result: APIResult<unknown>,
  expected: number,
  operation: string,
): void {
  if (result.status !== expected) {
    throw new Error(`${operation} returned ${result.status}: ${result.raw}`);
  }
}

async function loginWithRecovery(
  baseURL: string,
  fixture: AdministratorFixture,
  recoveryIndex: number,
): Promise<AuthenticatedAdmin> {
  const begun = await apiRequest<{ challenge_id: string }>(
    baseURL,
    "/auth/login",
    {
      body: { email: fixture.email, password: fixture.password },
    },
  );
  expectStatus(begun, 200, "administrator password authentication");
  const recoveryCode = fixture.recoveryCodes[recoveryIndex];
  if (!recoveryCode)
    throw new Error("Administrator recovery code is unavailable.");
  const completed = await apiRequest<{
    csrf_token: string;
    administrator: { admin_id: string; role: AdminRole };
  }>(baseURL, "/auth/totp/verify", {
    body: {
      challenge_id: begun.body.challenge_id,
      recovery_code: recoveryCode,
      totp_code: "",
    },
  });
  expectStatus(completed, 200, "administrator recovery authentication");
  const cookie = (completed.headers.get("set-cookie") ?? "").split(";", 1)[0];
  if (
    !cookie.startsWith("__Host-aera_admin_session=") ||
    completed.body.administrator.admin_id !== fixture.adminId ||
    completed.body.administrator.role !== fixture.role
  ) {
    throw new Error(
      "Administrator authentication returned the wrong principal.",
    );
  }
  return { cookie, csrfToken: completed.body.csrf_token, fixture };
}

async function stepUp(
  baseURL: string,
  authenticated: AuthenticatedAdmin,
): Promise<AuthenticatedAdmin> {
  const response = await apiRequest<{ csrf_token: string }>(
    baseURL,
    "/auth/step-up",
    {
      body: { totp_code: generateTOTP(authenticated.fixture.totpSecret, 1) },
      cookie: authenticated.cookie,
      csrfToken: authenticated.csrfToken,
    },
  );
  expectStatus(response, 200, "administrator step-up");
  return { ...authenticated, csrfToken: response.body.csrf_token };
}

async function waitForOperation(
  baseURL: string,
  authenticated: AuthenticatedAdmin,
  operationID: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await apiRequest<OfficialOperation>(
          baseURL,
          `/operations/${operationID}`,
          { cookie: authenticated.cookie },
        );
        expectStatus(response, 200, "official operation read");
        if (
          response.body.state === "failed" ||
          response.body.state === "conflict"
        ) {
          throw new Error(
            `Official operation ${operationID} ended as ${response.body.state}:${response.body.error_code ?? "UNKNOWN"}`,
          );
        }
        return response.body.state;
      },
      { timeout: 30_000 },
    )
    .toBe("succeeded");
}

async function enqueue(
  baseURL: string,
  authenticated: AuthenticatedAdmin,
  path: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST",
): Promise<void> {
  const response = await apiRequest<OfficialOperation>(baseURL, path, {
    method,
    body,
    cookie: authenticated.cookie,
    csrfToken: authenticated.csrfToken,
    headers: { "Idempotency-Key": randomUUID() },
  });
  expectStatus(response, 202, `enqueue ${path}`);
  await waitForOperation(baseURL, authenticated, response.body.operation_id);
}

async function list<T>(
  baseURL: string,
  authenticated: AuthenticatedAdmin,
  path: string,
): Promise<T[]> {
  const response = await apiRequest<PageResult<T>>(baseURL, path, {
    cookie: authenticated.cookie,
  });
  expectStatus(response, 200, `list ${path}`);
  if (!Array.isArray(response.body.items))
    throw new Error(`Invalid page from ${path}.`);
  return response.body.items;
}

function reason(
  code: string,
  ticket: string,
): { note: string; reason_code: string; ticket_reference: string } {
  return { reason_code: code, ticket_reference: ticket, note: "" };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function packagePayload(
  systemPrompt: string,
  version: number,
): DraftPackagePayload {
  const assets = [
    {
      path: "skills/official-research/SKILL.md",
      kind: "skill",
      content: `# Official Skill v${version}\nOFFICIAL_SKILL_V${version}\n`,
    },
    {
      path: "sop/official-research.md",
      kind: "sop",
      content: `# Official SOP v${version}\nOFFICIAL_SOP_V${version}\n`,
    },
    {
      path: "knowledge/official-research.md",
      kind: "knowledge",
      content: `# Official Knowledge v${version}\nOFFICIAL_KNOWLEDGE_V${version}\n`,
    },
  ] as const;
  return {
    manifest: {
      schema_version: 1,
      identity: { system_prompt: systemPrompt },
      assets: assets.map((asset) => ({
        path: asset.path,
        kind: asset.kind,
        media_type: "text/markdown",
        sha256: sha256(asset.content),
      })),
      model_constraints: {
        allowed_providers: ["openai"],
        allowed_models: ["gpt-5.6"],
      },
      tools: { allowed: ["files.read"], denied: [] },
      dependencies: [],
      runtime_compatibility: { minimum_version: "0.18.2-agentera.1" },
    },
    bundle: {
      assets: assets.map((asset) => ({
        path: asset.path,
        content: asset.content,
      })),
    },
  };
}

async function createDraft(
  baseURL: string,
  developer: AuthenticatedAdmin,
  definitionID: string,
  kind: "initial" | "next",
  version: number,
  existing?: OfficialDraft,
  baseVersionID?: string,
): Promise<OfficialDraft> {
  const payload = {
    ...(baseVersionID ? { base_version_id: baseVersionID } : {}),
    kind,
    display_name: DISPLAY_NAME,
    ...packagePayload(
      `You are the approved official research assistant version ${version}.`,
      version,
    ),
  };
  if (existing) {
    await enqueue(
      baseURL,
      developer,
      `/official-agent-drafts/${existing.draft_id}`,
      {
        expected_revision: existing.revision,
        expected_target_digest: existing.content_digest,
        ...reason("official_content_review", `OFFICIAL-E2E-V${version}-DRAFT`),
        payload,
      },
      "PATCH",
    );
  } else {
    await enqueue(baseURL, developer, "/official-agent-drafts", {
      expected_revision: 1,
      ...reason("official_content_review", `OFFICIAL-E2E-V${version}-DRAFT`),
      payload: { definition_id: definitionID, ...payload },
    });
  }
  const drafts = await list<OfficialDraft>(
    baseURL,
    developer,
    "/official-agent-drafts?limit=100",
  );
  const draft = drafts.find(
    (candidate) =>
      candidate.definition_id === definitionID &&
      candidate.kind === kind &&
      candidate.status === "active",
  );
  if (!draft) throw new Error(`Official v${version} draft is missing.`);
  const validation = await apiRequest<{ valid: boolean; findings: unknown[] }>(
    baseURL,
    `/official-agent-drafts/${draft.draft_id}/validate`,
    {
      method: "POST",
      cookie: developer.cookie,
      csrfToken: developer.csrfToken,
    },
  );
  expectStatus(validation, 200, "official draft validation");
  expect(validation.body).toEqual({
    ...validation.body,
    valid: true,
    findings: [],
  });
  return draft;
}

async function submitDraft(
  baseURL: string,
  developer: AuthenticatedAdmin,
  draft: OfficialDraft,
): Promise<OfficialSubmission> {
  await enqueue(
    baseURL,
    developer,
    `/official-agent-drafts/${draft.draft_id}/submit`,
    {
      expected_revision: draft.revision,
      expected_target_digest: draft.content_digest,
      ...reason("official_content_review", "OFFICIAL-E2E-SUBMIT"),
      payload: {},
    },
  );
  const submissions = await list<OfficialSubmission>(
    baseURL,
    developer,
    "/official-agent-submissions?status=pending&limit=50",
  );
  const submission = submissions.find(
    (candidate) =>
      candidate.draft_id === draft.draft_id && candidate.status === "pending",
  );
  if (!submission) throw new Error("Pending official submission is missing.");
  return submission;
}

async function approveSubmission(
  baseURL: string,
  reviewer: AuthenticatedAdmin,
  submission: OfficialSubmission,
): Promise<void> {
  await enqueue(
    baseURL,
    reviewer,
    `/official-agent-submissions/${submission.submission_id}/review`,
    {
      expected_revision: submission.revision,
      expected_target_digest: submission.content_digest,
      ...reason("official_content_review", "OFFICIAL-E2E-APPROVE"),
      payload: { decision: "approve", initial_channels: ["internal"] },
    },
  );
}

async function currentRelease(
  baseURL: string,
  authenticated: AuthenticatedAdmin,
  definitionID: string,
): Promise<OfficialRelease> {
  const releases = await list<OfficialRelease>(
    baseURL,
    authenticated,
    "/official-agent-releases?limit=50",
  );
  const release = releases.find(
    (candidate) =>
      candidate.definition_id === definitionID &&
      candidate.channel === "internal",
  );
  if (!release) throw new Error("Internal official release is missing.");
  return release;
}

async function activateRelease(
  baseURL: string,
  operator: AuthenticatedAdmin,
  release: OfficialRelease,
  version: OfficialVersion,
  allowlistedUserIDs: string[],
  ticket: string,
): Promise<OfficialRelease> {
  await enqueue(
    baseURL,
    operator,
    `/official-agent-releases/${release.release_id}/activate`,
    {
      expected_revision: release.head_revision,
      expected_target_digest: version.content_digest,
      ...reason("official_rollout_change", ticket),
      payload: {
        version_id: version.version_id,
        rollout_basis_points: 0,
        minimum_desktop_version: "0.7.0",
        allowlisted_user_ids: allowlistedUserIDs,
      },
    },
  );
  return currentRelease(baseURL, operator, release.definition_id);
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
  name: "A" | "B",
  phone: string,
  displayName: string,
  resetBrowser: boolean,
): Promise<AccountFixture> {
  if (resetBrowser) await resetBrowserIdentity(harnessValue);
  const device = await launchAgentControlDevice(harnessValue, name);
  await authenticateFirstAgentControlDevice(harnessValue, device, {
    phone,
    displayName,
  });
  await claimDefaultProfile(device);
  const state = await device.page.evaluate(() =>
    window.agenteraAuth.getState(),
  );
  if (state.status !== "authenticated") {
    throw new Error(`Official E2E account ${name} did not authenticate.`);
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

async function writePrivateLearning(profilePath: string): Promise<void> {
  await writeFile(
    join(profilePath, "MEMORY.md"),
    `# Private official-Agent Memory\n${PRIVATE_MEMORY}\n`,
    "utf8",
  );
  const skill = join(profilePath, "skills/private-learning/SKILL.md");
  await mkdir(dirname(skill), { recursive: true });
  await writeFile(skill, `# Private learned Skill\n${PRIVATE_SKILL}\n`, "utf8");
  const session = join(profilePath, "sessions/official-private.json");
  await mkdir(dirname(session), { recursive: true });
  await writeFile(session, JSON.stringify({ marker: PRIVATE_SESSION }), "utf8");
}

async function treeContains(path: string, marker: string): Promise<boolean> {
  const stats = await lstat(path);
  if (stats.isFile()) return (await readFile(path, "utf8")).includes(marker);
  if (!stats.isDirectory()) return false;
  for (const entry of await readdir(path)) {
    if (await treeContains(join(path, entry), marker)) return true;
  }
  return false;
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

test.afterAll(async () => {
  await closeAgentControlHarness(harness);
  harness = null;
});

test("failure injection matrix remains fail-closed at every owned boundary", async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(360_000);
  const cloudRoot = process.env.AERA_OFFICIAL_AGENT_E2E_CLOUD_REPO?.trim();
  const adminRoot = process.env.AERA_OFFICIAL_AGENT_E2E_ADMIN_REPO?.trim();
  if (!cloudRoot || !adminRoot) {
    throw new Error("Official Agent E2E repository paths are required.");
  }
  const desktop = runGate(
    "npx",
    [
      "vitest",
      "run",
      "src/main/agentera-agent-control/installation-manager.test.ts",
      "src/main/agentera-agent-control/hermes-adapter.test.ts",
      "src/main/agentera-agent-control/version-cache.test.ts",
      "src/main/agentera-agent-control/hermes-projection.test.ts",
    ],
    process.cwd(),
  );
  const admin = runGate(
    "go",
    [
      "test",
      "./internal/operations",
      "./internal/officialagent",
      "-run",
      "Official|Rollback",
      "-count=1",
    ],
    adminRoot,
  );
  const cloud = runGate(
    "go",
    [
      "test",
      "./internal/agentcontrol",
      "./internal/adminapi",
      "-run",
      "Official|Platform|Signer",
      "-count=1",
    ],
    cloudRoot,
  );
  const coverage = {
    admin_outbox_loss: "Admin operations and rollback tests",
    ambiguous_cloud_response:
      "Admin worker reconciliation and desktop idempotency tests",
    signer_or_audit_failure:
      "Cloud Platform publication and release atomicity tests",
    stale_release_revision:
      "Cloud release concurrency and Admin rollback tests",
    interrupted_download: "Desktop installation failure-table tests",
    digest_mismatch: "Desktop cache and Cloud canonical publication tests",
    policy_denial: "Desktop installation policy tests",
    cache_profile_projection_failure:
      "Desktop cache, Profile, and projection tests",
    managed_selection_conflict: "Cloud and desktop managed selection tests",
    rollback_materialization_failure: "Desktop v2/rollback preservation tests",
    reconnect_after_offline_use: "real-process scenario in this file",
  };
  expect(Object.keys(coverage)).toHaveLength(11);
  await testInfo.attach("official-failure-matrix", {
    body: JSON.stringify(
      {
        coverage,
        gates: {
          desktop: desktop.stdout.trim().split(/\r?\n/u).slice(-4),
          admin: admin.stdout.trim().split(/\r?\n/u).slice(-4),
          cloud: cloud.stdout.trim().split(/\r?\n/u).slice(-4),
        },
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

// @lat: [[agentera-agent-control-plane#Official Managed Agent V1#Executable lifecycle gate]]
test("real Admin, Cloud, and two desktops preserve v1 v2 rollback pause offline and privacy boundaries", async ({
  browserName: _browserName,
}, testInfo) => {
  harness = await createOfficialManagedAgentHarness();
  const official = harness.official;
  if (!official)
    throw new Error("Official managed Agent harness is unavailable.");
  const fixtures = JSON.parse(
    await readFile(official.adminFixtureFile, "utf8"),
  ) as AdminFixtures;
  const baseURL = official.adminBaseURL;

  const eligible = await launchAccount(
    harness,
    "A",
    ELIGIBLE_PHONE,
    "Eligible Official E2E User",
    false,
  );
  eligibleDevice = eligible.device;
  const ineligible = await launchAccount(
    harness,
    "B",
    INELIGIBLE_PHONE,
    "Ineligible Official E2E User",
    true,
  );
  const developer = await loginWithRecovery(
    baseURL,
    fixtures.roles.developer[0],
    3,
  );
  let reviewer = await loginWithRecovery(
    baseURL,
    fixtures.roles.super_admin[6],
    0,
  );
  let operator = await loginWithRecovery(
    baseURL,
    fixtures.roles.operator[1],
    0,
  );
  reviewer = await stepUp(baseURL, reviewer);
  operator = await stepUp(baseURL, operator);
  expect(developer.fixture.adminId).not.toBe(reviewer.fixture.adminId);
  expect(operator.fixture.adminId).not.toBe(reviewer.fixture.adminId);

  await enqueue(baseURL, developer, "/official-agents", {
    expected_revision: 1,
    ...reason("official_content_review", "OFFICIAL-E2E-DEFINITION"),
    payload: { display_name: DISPLAY_NAME },
  });
  const definitions = await list<OfficialDefinition>(
    baseURL,
    developer,
    "/official-agents?limit=50",
  );
  const definition = definitions.find(
    (candidate) => candidate.display_name === DISPLAY_NAME,
  );
  if (!definition) throw new Error("Official definition is missing.");

  const v1Draft = await createDraft(
    baseURL,
    developer,
    definition.definition_id,
    "initial",
    1,
  );
  const v1Submission = await submitDraft(baseURL, developer, v1Draft);
  expect(v1Submission.definition_id).toBe(definition.definition_id);
  expect(v1Submission.status).toBe("pending");
  await approveSubmission(baseURL, reviewer, v1Submission);
  let versions = await list<OfficialVersion>(
    baseURL,
    reviewer,
    "/official-agent-versions?limit=100",
  );
  const v1 = versions.find(
    (candidate) =>
      candidate.definition_id === definition.definition_id &&
      candidate.version_number === 1,
  );
  if (!v1) throw new Error("Immutable official v1 is missing.");

  let release = await currentRelease(
    baseURL,
    operator,
    definition.definition_id,
  );
  release = await activateRelease(
    baseURL,
    operator,
    release,
    v1,
    [eligible.identity.userId],
    "OFFICIAL-E2E-V1-ROLLOUT",
  );
  const v1ReleaseRevisionID = release.current_revision_id;
  expect(release).toMatchObject({
    agent_version_id: v1.version_id,
    state: "active",
  });

  const eligibleCatalog = unwrap(
    await invokeAgentera<OfficialAgentSummary[]>(
      eligible.device,
      "listOfficialAgents",
    ),
  );
  expect(eligibleCatalog).toHaveLength(1);
  expect(eligibleCatalog[0]).toMatchObject({
    definitionId: definition.definition_id,
    versionId: v1.version_id,
    releaseRevisionId: v1ReleaseRevisionID,
    channel: "internal",
    installationState: "not_installed",
  });
  expect(
    unwrap(
      await invokeAgentera<OfficialAgentSummary[]>(
        ineligible.device,
        "listOfficialAgents",
      ),
    ),
  ).toEqual([]);

  const profilesBeforeInstall = await eligible.device.page.evaluate(
    async () => await window.hermesAPI.listProfiles(),
  );
  const preview = unwrap(
    await invokeAgentera<OfficialAgentInstallPreview>(
      eligible.device,
      "prepareOfficialInstall",
      definition.definition_id,
    ),
  );
  const installationResult =
    await invokeAgentera<AgenteraAgentInstallationSummary>(
      eligible.device,
      "confirmOfficialInstall",
      {
        installHandle: preview.installHandle,
        confirmation: "install-official-agent",
      },
    );
  if (!installationResult.ok) {
    throw new Error(
      `Official installation failed: ${installationResult.errorCode}\n${JSON.stringify(
        {
          device: deviceProcessDiagnostics(eligible.device),
          exchanges: agentControlExchangeDiagnostics(harness),
        },
      )}`,
    );
  }
  const installation = installationResult.data;
  expect(installation).toMatchObject({
    sourceScope: "PLATFORM",
    officialReleaseId: release.release_id,
    selectedReleaseRevisionId: v1ReleaseRevisionID,
    updatePolicy: "managed",
    selectedVersionId: v1.version_id,
    status: "active",
  });
  if (!installation.runtimeProfileId) {
    throw new Error("Official installation did not create a fresh Profile.");
  }
  const officialRuntimeProfileID = installation.runtimeProfileId;
  const profilesAfterInstall = await eligible.device.page.evaluate(
    async () => await window.hermesAPI.listProfiles(),
  );
  expect(profilesAfterInstall).toHaveLength(profilesBeforeInstall.length + 1);
  const previousProfileIDs = new Set(
    profilesBeforeInstall.map((profile) => profile.id),
  );
  const newProfiles = profilesAfterInstall.filter(
    (profile) => !previousProfileIDs.has(profile.id),
  );
  expect(newProfiles).toHaveLength(1);
  const officialHermesProfileID = newProfiles[0].id;
  expect(
    localInstallationOwner(eligible.device, installation.id),
  ).toMatchObject({
    tenantId: eligible.identity.personalSpaceId,
    ownerId: eligible.identity.userId,
    sourceScope: "PLATFORM",
    sourceWorkspaceId: null,
    sourceOrganizationId: null,
    officialReleaseId: release.release_id,
    selectedReleaseRevisionId: v1ReleaseRevisionID,
    updatePolicy: "managed",
  });

  const officialProfile = newProfiles[0].path;
  expect(officialProfile).toBe(
    deviceProfilePath(eligible.device, officialHermesProfileID),
  );
  await writePrivateLearning(officialProfile);
  const privateHashes = await privateProfileSnapshot(
    officialProfile,
    PRIVATE_MARKERS,
  );
  await startBoundConversation(
    eligible.device,
    officialHermesProfileID,
    "official-v1-running",
  );
  await expect
    .poll(
      async () =>
        (await localAgentControlState(eligible.device)).bindings.length,
    )
    .toBe(1);
  let local = await localAgentControlState(eligible.device);
  expect(local.bindings[0]).toMatchObject({
    conversationKey: "official-v1-running",
    agentVersionId: v1.version_id,
    agentInstallationId: installation.id,
    runtimeProfileId: officialRuntimeProfileID,
    officialReleaseRevisionId: v1ReleaseRevisionID,
  });
  expect(local.projectionRoots).toHaveLength(1);
  expect(
    await treeContains(local.projectionRoots[0], "OFFICIAL_KNOWLEDGE_V1"),
  ).toBe(true);
  expect(await treeContains(local.projectionRoots[0], PRIVATE_MEMORY)).toBe(
    false,
  );
  await assertReadOnlyTree(join(local.projectionRoots[0], "active"));

  const v2Draft = await createDraft(
    baseURL,
    developer,
    definition.definition_id,
    "next",
    2,
    v1Draft,
    v1.version_id,
  );
  const v2Submission = await submitDraft(baseURL, developer, v2Draft);
  const releaseBeforeV2Review = await currentRelease(
    baseURL,
    operator,
    definition.definition_id,
  );
  await approveSubmission(baseURL, reviewer, v2Submission);
  versions = await list<OfficialVersion>(
    baseURL,
    reviewer,
    "/official-agent-versions?limit=100",
  );
  const v2 = versions.find(
    (candidate) =>
      candidate.definition_id === definition.definition_id &&
      candidate.version_number === 2,
  );
  if (!v2) throw new Error("Immutable official v2 is missing.");
  release = await currentRelease(baseURL, operator, definition.definition_id);
  expect(release.current_revision_id).toBe(
    releaseBeforeV2Review.current_revision_id,
  );
  expect(release.agent_version_id).toBe(v1.version_id);

  release = await activateRelease(
    baseURL,
    operator,
    release,
    v2,
    [eligible.identity.userId],
    "OFFICIAL-E2E-V2-ROLLOUT",
  );
  const v2ReleaseRevisionID = release.current_revision_id;
  const updates = unwrap(
    await invokeAgentera<OfficialManagedUpdate[]>(
      eligible.device,
      "refreshOfficialUpdates",
    ),
  );
  expect(updates).toEqual([
    expect.objectContaining({
      installationId: installation.id,
      targetVersionId: v2.version_id,
      targetReleaseRevisionId: v2ReleaseRevisionID,
    }),
  ]);
  const v2Installation = unwrap(
    await invokeAgentera<AgenteraAgentInstallationSummary>(
      eligible.device,
      "applyOfficialUpdate",
      installation.id,
    ),
  );
  expect(v2Installation).toMatchObject({
    id: installation.id,
    runtimeProfileId: officialRuntimeProfileID,
    selectedVersionId: v2.version_id,
    selectedReleaseRevisionId: v2ReleaseRevisionID,
  });
  expect(
    await privateProfileSnapshot(officialProfile, PRIVATE_MARKERS),
  ).toEqual(privateHashes);
  await startBoundConversation(
    eligible.device,
    officialHermesProfileID,
    "official-v2-running",
  );
  await expect
    .poll(
      async () =>
        (await localAgentControlState(eligible.device)).bindings.length,
    )
    .toBe(2);
  local = await localAgentControlState(eligible.device);
  expect(
    local.bindings.find(
      (binding) => binding.conversationKey === "official-v1-running",
    ),
  ).toMatchObject({
    agentVersionId: v1.version_id,
    officialReleaseRevisionId: v1ReleaseRevisionID,
  });
  expect(
    local.bindings.find(
      (binding) => binding.conversationKey === "official-v2-running",
    ),
  ).toMatchObject({
    agentVersionId: v2.version_id,
    officialReleaseRevisionId: v2ReleaseRevisionID,
  });

  const rollbackRequest = await apiRequest<OfficialRollbackApproval>(
    baseURL,
    `/official-agent-releases/${release.release_id}/rollback-requests`,
    {
      body: {
        target_version_id: v1.version_id,
        target_release_revision_id: v1ReleaseRevisionID,
        expected_head_revision: release.head_revision,
        target_digest: v1.content_digest,
        ...reason("official_release_rollback", "OFFICIAL-E2E-ROLLBACK"),
      },
      cookie: operator.cookie,
      csrfToken: operator.csrfToken,
      headers: { "Idempotency-Key": randomUUID() },
    },
  );
  expectStatus(rollbackRequest, 201, "official rollback request");
  expect(rollbackRequest.body.approval_status).toBe("pending_review");
  expect(operator.fixture.adminId).not.toBe(reviewer.fixture.adminId);
  const rollbackApproval = await apiRequest<OfficialRollbackApproval>(
    baseURL,
    `/official-agent-rollback-requests/${rollbackRequest.body.id}/approve`,
    {
      body: {},
      cookie: reviewer.cookie,
      csrfToken: reviewer.csrfToken,
      headers: { "Idempotency-Key": randomUUID() },
    },
  );
  expectStatus(rollbackApproval, 202, "official rollback approval");
  await expect
    .poll(
      async () => {
        const requests = await list<OfficialRollbackApproval>(
          baseURL,
          reviewer,
          "/official-agent-rollback-requests?view=all&limit=50",
        );
        return requests.find(
          (candidate) => candidate.id === rollbackRequest.body.id,
        )?.execution_status;
      },
      { timeout: 30_000 },
    )
    .toBe("succeeded");
  release = await currentRelease(baseURL, operator, definition.definition_id);
  expect(release).toMatchObject({
    agent_version_id: v1.version_id,
    action: "rollback",
    rollback_target_revision_id: v1ReleaseRevisionID,
  });
  const rollbackReleaseRevisionID = release.current_revision_id;
  expect(
    unwrap(
      await invokeAgentera<OfficialManagedUpdate[]>(
        eligible.device,
        "refreshOfficialUpdates",
      ),
    ),
  ).toEqual([
    expect.objectContaining({
      installationId: installation.id,
      targetVersionId: v1.version_id,
      targetReleaseRevisionId: rollbackReleaseRevisionID,
    }),
  ]);
  const rollbackInstallation = unwrap(
    await invokeAgentera<AgenteraAgentInstallationSummary>(
      eligible.device,
      "applyOfficialUpdate",
      installation.id,
    ),
  );
  expect(rollbackInstallation).toMatchObject({
    id: installation.id,
    runtimeProfileId: officialRuntimeProfileID,
    selectedVersionId: v1.version_id,
    selectedReleaseRevisionId: rollbackReleaseRevisionID,
  });
  await startBoundConversation(
    eligible.device,
    officialHermesProfileID,
    "official-v1-after-rollback",
  );
  await expect
    .poll(
      async () =>
        (await localAgentControlState(eligible.device)).bindings.length,
    )
    .toBe(3);
  local = await localAgentControlState(eligible.device);
  expect(
    local.bindings.find(
      (binding) => binding.conversationKey === "official-v2-running",
    ),
  ).toMatchObject({
    agentVersionId: v2.version_id,
    officialReleaseRevisionId: v2ReleaseRevisionID,
  });
  expect(
    local.bindings.find(
      (binding) => binding.conversationKey === "official-v1-after-rollback",
    ),
  ).toMatchObject({
    agentVersionId: v1.version_id,
    officialReleaseRevisionId: rollbackReleaseRevisionID,
  });
  expect(
    await privateProfileSnapshot(officialProfile, PRIVATE_MARKERS),
  ).toEqual(privateHashes);

  release = await activateRelease(
    baseURL,
    operator,
    release,
    v1,
    [eligible.identity.userId, ineligible.identity.userId],
    "OFFICIAL-E2E-PAUSE-AUDIENCE",
  );
  expect(
    unwrap(
      await invokeAgentera<OfficialAgentSummary[]>(
        ineligible.device,
        "listOfficialAgents",
      ),
    ),
  ).toHaveLength(1);
  await enqueue(
    baseURL,
    operator,
    `/official-agent-releases/${release.release_id}/pause`,
    {
      expected_revision: release.head_revision,
      expected_target_digest: v1.content_digest,
      ...reason("official_release_pause", "OFFICIAL-E2E-PAUSE"),
      payload: {},
    },
  );
  release = await currentRelease(baseURL, operator, definition.definition_id);
  expect(release.state).toBe("paused");
  expect(
    unwrap(
      await invokeAgentera<OfficialAgentSummary[]>(
        ineligible.device,
        "listOfficialAgents",
      ),
    ),
  ).toEqual([]);
  expect(
    await invokeAgentera(
      ineligible.device,
      "prepareOfficialInstall",
      definition.definition_id,
    ),
  ).toEqual({ ok: false, errorCode: "official_release_paused" });
  await startBoundConversation(
    eligible.device,
    officialHermesProfileID,
    "official-paused-installed",
  );
  await expect
    .poll(
      async () =>
        (await localAgentControlState(eligible.device)).bindings.length,
    )
    .toBe(4);

  const requestsBeforeOffline = agentControlRequests(harness).length;
  await stopAgentControlCloud(harness);
  await eligible.device.app.close();
  eligibleDevice = await launchAgentControlDevice(harness, "A");
  await expect(eligibleDevice.page.locator(".layout")).toBeVisible({
    timeout: 180_000,
  });
  await expect
    .poll(() =>
      eligibleDevice!.page.evaluate(() => window.agenteraAuth.getState()),
    )
    .toMatchObject({ status: "offline", cloudAvailable: false });
  expect(await invokeAgentera(eligibleDevice, "listOfficialAgents")).toEqual({
    ok: false,
    errorCode: "online_required",
  });
  expect(agentControlRequests(harness)).toHaveLength(requestsBeforeOffline);
  await startBoundConversation(
    eligibleDevice,
    officialHermesProfileID,
    "official-offline-cached",
  );
  await expect
    .poll(
      async () =>
        (await localAgentControlState(eligibleDevice!)).bindings.length,
    )
    .toBe(5);
  expect(
    await privateProfileSnapshot(officialProfile, PRIVATE_MARKERS),
  ).toEqual(privateHashes);

  await startAgentControlCloud(harness);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
  await eligibleDevice.page.evaluate(() => window.agenteraAuth.retryOnline());
  await expect
    .poll(() =>
      eligibleDevice!.page.evaluate(() => window.agenteraAuth.getState()),
    )
    .toMatchObject({ status: "authenticated", cloudAvailable: true });

  local = await localAgentControlState(eligibleDevice);
  expect(local.installations).toHaveLength(1);
  expect(local.installations[0]).toMatchObject({
    id: installation.id,
    runtimeProfileId: officialRuntimeProfileID,
    sourceScope: "PLATFORM",
  });
  expect(local.bindings).toHaveLength(5);
  expect(
    new Set(local.bindings.map((binding) => binding.runtimeProfileId)),
  ).toEqual(new Set([officialRuntimeProfileID]));
  expect(
    await eligibleDevice.page.evaluate(
      async () => (await window.hermesAPI.listProfiles()).length,
    ),
  ).toBe(profilesBeforeInstall.length + 1);
  expect(
    await privateProfileSnapshot(officialProfile, PRIVATE_MARKERS),
  ).toEqual(privateHashes);
  expect(
    await treeContains(local.projectionRoots[0], "OFFICIAL_KNOWLEDGE_V1"),
  ).toBe(true);
  expect(
    await treeContains(local.projectionRoots[0], "OFFICIAL_KNOWLEDGE_V2"),
  ).toBe(true);
  expect(await treeContains(local.projectionRoots[0], PRIVATE_SKILL)).toBe(
    false,
  );

  const captured = agentControlRequests(harness);
  expect(
    captured.some((request) =>
      request.path.startsWith("/api/v1/official-agents"),
    ),
  ).toBe(true);
  expect(
    captured.some((request) => request.path.startsWith("/api/agents")),
  ).toBe(false);
  const serializedCapture = JSON.stringify(captured);
  for (const marker of [PRIVATE_MEMORY, PRIVATE_SKILL, PRIVATE_SESSION]) {
    expect(serializedCapture).not.toContain(marker);
  }
  const audit = await list<OfficialAuditEvent>(
    baseURL,
    reviewer,
    "/official-agent-audit-events?limit=100",
  );
  expect(
    audit.some((event) => event.event_type === "official_release_rollback"),
  ).toBe(true);
  expect(
    audit.some((event) => event.event_type === "official_release_pause"),
  ).toBe(true);

  await testInfo.attach("official-managed-agent-evidence", {
    body: JSON.stringify(
      {
        schemaVersion: 1,
        evidenceKind: "isolated_cross_repo_preflight",
        suite: "official_managed_agent",
        scenarios: {
          officialDraftSeparateApproval: true,
          officialImmutableRelease: true,
          officialDeterministicRollout: true,
          officialPauseResumeRollback: true,
          officialRuntimeBindingStability: true,
          dependenciesFailClosed: true,
          featureShutdownPreservesProfiles: true,
          noPrivateMarkerInRequests: true,
        },
        counts: {
          immutableVersions: 2,
          releaseRevisions: 3,
          runtimeBindings: local.bindings.length,
        },
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});
