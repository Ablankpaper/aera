import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { type Page } from "playwright/test";

import {
  authenticateExistingAgentControlDevice,
  authenticateFirstAgentControlDevice,
  launchAgentControlDevice,
  type AgentControlDevice,
  type AgentControlHarness,
} from "./agentera-agent-control-harness";

export type DesktopFleetRepositories = {
  cloud: string;
  admin: string;
};

/** Resolve only the two explicitly supplied, clean cross-repository checkouts. */
export function resolveDesktopFleetRepositories(
  input: Partial<DesktopFleetRepositories> = {},
): DesktopFleetRepositories {
  const cloudValue =
    input.cloud?.trim() ||
    process.env.AERA_DESKTOP_FLEET_E2E_CLOUD_REPO?.trim();
  const adminValue =
    input.admin?.trim() ||
    process.env.AERA_DESKTOP_FLEET_E2E_ADMIN_REPO?.trim();
  if (!cloudValue || !adminValue) {
    throw new Error(
      "Desktop Fleet E2E requires explicit Cloud and Admin repository roots.",
    );
  }

  const cloud = validateRepository(
    cloudValue,
    "Cloud",
    "go.mod",
    "module github.com/bignormal/aera-cloud",
  );
  const admin = validateRepository(
    adminValue,
    "Admin",
    "package.json",
    '"name": "agentera-admin"',
  );
  if (!admin || !cloud)
    throw new Error("Desktop Fleet E2E repositories are invalid.");
  const adminWeb = join(admin, "admin-web");
  if (!isDirectory(adminWeb))
    throw new Error("Admin checkout must contain admin-web.");
  return { cloud, admin };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function validateRepository(
  value: string,
  label: string,
  markerPath: string,
  marker: string,
): string {
  let repository: string;
  try {
    repository = realpathSync(resolve(value));
  } catch {
    throw new Error(`${label} repository does not exist.`);
  }
  const topLevel = runGit(repository, ["rev-parse", "--show-toplevel"]);
  if (topLevel !== repository)
    throw new Error(`${label} repository must be a checkout root.`);
  if (runGit(repository, ["status", "--porcelain"])) {
    throw new Error(`${label} repository checkout must be clean.`);
  }
  let contents: string;
  try {
    contents = readFileSync(join(repository, markerPath), "utf8");
  } catch {
    throw new Error(`${label} repository is missing ${markerPath}.`);
  }
  if (!contents.includes(marker))
    throw new Error(`${label} repository identity is unexpected.`);
  return repository;
}

function runGit(repository: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed for ${repository}.`);
  return String(result.stdout).trim();
}

export function desktopFleetOwnedPaths(runRoot: string): string[] {
  const root = resolve(runRoot);
  return [
    join(root, "pki"),
    join(root, "desktop-control-clock.txt"),
    join(root, "device-a", "electron-user-data"),
    join(root, "device-a", "hermes-home"),
    join(root, "device-b", "electron-user-data"),
    join(root, "device-b", "hermes-home"),
    join(root, "admin-web-user-data"),
    join(root, "admin.sqlite"),
  ];
}

export function assertOwnedCleanupTarget(
  target: string,
  runRoot: string,
): void {
  const root = resolve(runRoot);
  const candidate = resolve(target);
  const rel = relative(root, candidate);
  if (
    candidate !== root &&
    (rel === "" || rel.startsWith("..") || rel.includes(`${sep}..`))
  ) {
    throw new Error(
      `Cleanup target is not owned by the Desktop Fleet E2E run root: ${candidate}`,
    );
  }
}

export type DesktopControlRequestEvidence = {
  method: string;
  path: string;
  body: unknown;
  responseStatus?: number;
  responseBody?: unknown;
};

export function desktopControlRequests(
  harness: AgentControlHarness,
  commandId?: string,
): DesktopControlRequestEvidence[] {
  return harness.requests
    .filter((request) => request.path.includes("/desktop-control/"))
    .filter(
      (request) =>
        commandId === undefined || JSON.stringify(request).includes(commandId),
    )
    .map((request) => ({
      method: request.method,
      path: request.path,
      body: request.body,
      ...(request.responseStatus === undefined
        ? {}
        : { responseStatus: request.responseStatus }),
      ...(request.responseBody === undefined
        ? {}
        : { responseBody: request.responseBody }),
    }));
}

export function acceptedDesktopHeartbeat(
  requests: DesktopControlRequestEvidence[],
): { deviceId: string; acceptedAt: string } | null {
  for (const request of requests) {
    if (
      !request.path.endsWith("/desktop-control/heartbeat") ||
      request.responseStatus === undefined ||
      request.responseStatus < 200 ||
      request.responseStatus >= 300 ||
      request.responseBody === null ||
      typeof request.responseBody !== "object" ||
      Array.isArray(request.responseBody)
    ) {
      continue;
    }
    const body = request.responseBody as Record<string, unknown>;
    if (
      typeof body.instance_id === "string" &&
      body.instance_id.length > 0 &&
      typeof body.accepted_at === "string" &&
      body.accepted_at.length > 0
    ) {
      return { deviceId: body.instance_id, acceptedAt: body.accepted_at };
    }
  }
  return null;
}

export type CloudDesktopRow = {
  device_id: string;
  user_id: string;
  display_name: string;
  client_version: string;
  effective_status: string;
  last_heartbeat_at: string | null;
};

export type CloudCommandRow = {
  command_id: string;
  device_id: string;
  state: string;
  result_code: string | null;
};

/**
 * Read bounded control-plane evidence through the run-owned database service.
 * The helper intentionally selects only control columns and never prints rows.
 */
export async function readCloudDesktopRows(
  harness: AgentControlHarness,
): Promise<CloudDesktopRow[]> {
  const output = runCloudPsql(
    harness,
    `SELECT device_id::text, user_id::text, display_name, client_version, COALESCE(to_char(last_heartbeat_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''), health_status FROM desktop_control_instances ORDER BY updated_at DESC, device_id`,
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [device_id, user_id, display_name, client_version, heartbeat] =
        line.split("\t");
      const last_heartbeat_at = heartbeat || null;
      const now = readFleetClock(harness);
      return {
        device_id,
        user_id,
        display_name,
        client_version,
        effective_status:
          last_heartbeat_at &&
          now.getTime() - Date.parse(last_heartbeat_at) <= 150_000
            ? "online"
            : "offline",
        last_heartbeat_at,
      };
    });
}

export async function readCloudCommand(
  harness: AgentControlHarness,
  commandId: string,
): Promise<CloudCommandRow> {
  if (!/^[0-9a-f-]{36}$/iu.test(commandId)) {
    throw new Error("Cloud command ID must be a UUID.");
  }
  const output = runCloudPsql(
    harness,
    `SELECT id::text, device_id::text, state, COALESCE(result_code, '') FROM desktop_control_commands WHERE id = '${commandId}'`,
  );
  const [line] = output.split("\n").filter(Boolean);
  if (!line)
    throw new Error("Cloud command was not found in the run-owned database.");
  const [command_id, device_id, state, resultCode] = line.split("\t");
  return { command_id, device_id, state, result_code: resultCode || null };
}

function readFleetClock(harness: AgentControlHarness): Date {
  const clockFile = harness.desktopControlClockFile;
  if (!clockFile) return new Date();
  const parsed = new Date(readFileSync(clockFile, "utf8").trim());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function runCloudPsql(harness: AgentControlHarness, sql: string): string {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      harness.composeProject,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "aera_cloud",
      "-d",
      "aera_cloud",
      "-At",
      "-F",
      "\t",
      "-c",
      sql,
    ],
    { cwd: harness.cloudRoot, encoding: "utf8", stdio: "pipe" },
  );
  if (result.status !== 0) {
    throw new Error(
      `Cloud evidence query failed: ${result.stderr || result.stdout}`,
    );
  }
  return String(result.stdout).trim();
}

export function assertNoAdminDesktopCopy(_adminRoot: string): void {
  const result = spawnSync(
    "rg",
    [
      "-n",
      "slug\\s*:\\s*['\"](?:desktop|desktop-control)|desktop_control_(?:instances|commands)",
      "src/collections",
    ],
    { cwd: _adminRoot, encoding: "utf8", stdio: "pipe" },
  );
  if (result.status === 0 && String(result.stdout).trim()) {
    throw new Error(
      "Admin contains a local Desktop instance or command collection.",
    );
  }
}

export async function authenticateAdminBrowser(
  harness: AgentControlHarness,
  operator: { email?: string; password?: string } = {},
): Promise<{ page: Page }> {
  const official = harness.official;
  if (!official) throw new Error("Desktop Fleet harness has no Admin service.");
  const page = await (
    await harness.browser.newContext({ locale: "zh-CN" })
  ).newPage();
  await page.goto(`${official.adminBaseURL}/admin/login`);
  await page
    .getByTestId("admin-email")
    .fill(operator.email || "desktop-fleet-operator@agentera.local");
  await page
    .getByTestId("admin-password")
    .fill(operator.password || "Aera Desktop Fleet E2E operator 2026");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL(/\/admin\/home/);
  return { page };
}

export async function advanceDesktopControlClock(
  harness: AgentControlHarness,
  instant: Date,
): Promise<void> {
  const clockFile = harness.desktopControlClockFile;
  if (!clockFile)
    throw new Error("Desktop Fleet clock file is not configured.");
  assertOwnedCleanupTarget(clockFile, harness.root);
  const temporary = `${clockFile}.next`;
  await writeFile(temporary, `${instant.toISOString()}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, clockFile);
  await chmod(clockFile, 0o600);
}

export async function removeRunOwnedRuntime(
  harness: AgentControlHarness,
  name: "A" | "B" | "C" | "D",
): Promise<void> {
  const runtimeSeed = harness.runtimeSeedDirectory;
  const installedRuntime = join(harness.deviceRoots[name].userData, "runtime");
  assertOwnedCleanupTarget(runtimeSeed, harness.root);
  assertOwnedCleanupTarget(installedRuntime, harness.root);
  await rm(installedRuntime, { recursive: true, force: true });
  await mkdir(runtimeSeed, { recursive: true });
  const entries = await readdir(runtimeSeed);
  for (const entry of entries) {
    await rm(join(runtimeSeed, entry), { recursive: true, force: true });
  }
}

export async function launchDesktopWithoutRuntime(
  harness: AgentControlHarness,
  name: "A" | "B" | "C" | "D",
): Promise<AgentControlDevice> {
  await removeRunOwnedRuntime(harness, name);
  return launchAgentControlDevice(harness, name);
}

export async function authenticateDesktop(
  harness: AgentControlHarness,
  device: AgentControlDevice,
  existing = false,
): Promise<void> {
  if (existing) await authenticateExistingAgentControlDevice(harness, device);
  else
    await authenticateFirstAgentControlDevice(harness, device, {
      displayName: "Desktop Fleet User",
    });
}

export function commandIdHash(commandId: string): string {
  return createHash("sha256").update(commandId).digest("hex");
}
