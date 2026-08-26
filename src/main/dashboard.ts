import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "fs";
import http from "http";
import https from "https";
import net from "net";
import { homedir } from "os";
import { join } from "path";
import { getConnectionConfig, type ConnectionConfig } from "./config";
import { getEnhancedPath, HERMES_HOME } from "./installer";
import {
  getRuntimeInvocation,
  type RuntimeInvocation,
} from "./agentera-runtime-distribution/invocation";
import { buildLocalDashboardCliArgs } from "./dashboard-launch";
import { dashboardWebSocketUrlForRenderer } from "./dashboard-websocket-relay";
import { ensureLocalDashboardCompatibility } from "./hermes-agent-compat";
import { HIDDEN_SUBPROCESS_OPTIONS } from "./process-options";
import {
  retryCapturedProcessTermination,
  terminateProcessTree,
  type ProcessTreeRetryOwnership,
  type ProcessTreeTerminationResult,
} from "./process-tree";
import { hydrateProfileRuntimeEnv } from "./profile-runtime-env";
import { isGatewayHealthy, startGatewayWithRecovery } from "./hermes";
import {
  buildRemoteOAuthWsUrl,
  mintRemoteOAuthWsTicket,
  probeRemoteAuthMode,
  remoteOAuthSessionState,
  requestRemoteOAuthJson,
} from "./remote-oauth";
import { ensureSshTunnel, getSshTunnelUrl } from "./ssh-tunnel";
import { sshEnsureDashboard } from "./ssh-remote";
import {
  getActiveProfileNameSync,
  normalizeProfileName,
  pidIsAlive,
  profileHome,
} from "./utils";

export interface DashboardConnection {
  baseUrl: string;
  wsUrl: string;
  token: string;
  authMode?: "token" | "oauth";
  mode: "local" | "remote" | "ssh";
  profile?: string;
  pid?: number;
  port?: number;
  logPath?: string;
  alreadyRunning?: boolean;
}

export interface DashboardStatus {
  supported: boolean;
  running: boolean;
  connection?: DashboardConnection;
  error?: string;
  logPath?: string;
  needsOAuthLogin?: boolean;
}

interface ManagedDashboard {
  proc: ChildProcess;
  connection: DashboardConnection;
  retryOwnership?: ProcessTreeRetryOwnership;
}

const dashboards = new Map<string, ManagedDashboard>();
const dashboardStarts = new Map<string, Promise<DashboardStatus>>();
const dashboardStartGenerations = new Map<string, number>();
const dashboardStopsInFlight = new Map<string, Promise<void>>();
const dashboardCleanupFailures = new Map<string, string>();
let dashboardPoolStopping = false;
let dashboardPoolClosed = false;
let dashboardPoolShutdown: Promise<void> | null = null;
const DASHBOARD_START_DRAIN_TIMEOUT_MS = 3_000;

async function waitForDashboardStartDrain(
  start: Promise<DashboardStatus> | undefined,
): Promise<void> {
  if (!start) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, DASHBOARD_START_DRAIN_TIMEOUT_MS);
    timer.unref?.();
  });
  await Promise.race([
    start.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
}

async function terminateDashboardProcess(
  managed: ManagedDashboard,
): Promise<void> {
  const options = {
    detachedProcessGroup: process.platform !== "win32",
    forceAfterMs: 3_000,
    ...(process.platform === "win32"
      ? {
          commandTimeoutMs: 3_000,
          snapshotTimeoutMs: 3_000,
          snapshotTotalBudgetMs: 6_000,
        }
      : {}),
  };
  const result: ProcessTreeTerminationResult = managed.retryOwnership
    ? await retryCapturedProcessTermination(managed.retryOwnership, options)
    : await terminateProcessTree(managed.proc, options);
  if (result.retryOwnership) {
    managed.retryOwnership = result.retryOwnership;
  }
  if (result.remainingPids.length > 0) {
    throw new Error(
      `Aera Dashboard process tree did not fully exit: ${result.remainingPids.join(",")}`,
    );
  }
  // Do not release the handle until the exact retry has reported no remaining
  // owned PID.  This is the point at which a later stop may safely forget the
  // failed Dashboard entry.
  managed.retryOwnership = undefined;
}

function resolveProfile(profile?: string): string | undefined {
  return normalizeProfileName(profile ?? getActiveProfileNameSync());
}

function profileKey(profile?: string): string {
  return resolveProfile(profile) ?? "default";
}

function dashboardStartGeneration(key: string): number {
  return dashboardStartGenerations.get(key) ?? 0;
}

function supersededDashboardStartStatus(): DashboardStatus {
  return {
    supported: true,
    running: false,
    error: "Dashboard start was superseded by a Runtime configuration change.",
  };
}

function dashboardPoolUnavailableStatus(): DashboardStatus {
  return {
    supported: true,
    running: false,
    error: "Aera Dashboard pool is shutting down.",
  };
}

function dashboardWsUrl(baseUrl: string, token: string): string {
  const url = new URL("/api/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

function normalizeRemoteDashboardBaseUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (url.pathname === "/v1" || url.pathname === "/api") {
      url.pathname = "";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function remoteDashboardConnectionFromConfig(
  config: ConnectionConfig,
  profile?: string,
): DashboardConnection | null {
  if (config.mode !== "remote") return null;
  const baseUrl = normalizeRemoteDashboardBaseUrl(config.remoteUrl);
  const token = config.apiKey.trim();
  const authMode = config.remoteAuthMode === "oauth" ? "oauth" : "token";
  if (!baseUrl || (authMode === "token" && !token)) return null;
  return {
    baseUrl,
    wsUrl: authMode === "oauth" ? "" : dashboardWsUrl(baseUrl, token),
    token: authMode === "oauth" ? "" : token,
    authMode,
    mode: "remote",
    profile: resolveProfile(profile),
  };
}

export function sshDashboardConnectionFromTunnel(
  config: ConnectionConfig,
  baseUrl: string | null,
  token: string,
  profile?: string,
): DashboardConnection | null {
  if (config.mode !== "ssh") return null;
  const normalizedBaseUrl = normalizeRemoteDashboardBaseUrl(baseUrl || "");
  const cleanToken = token.trim();
  if (!normalizedBaseUrl || !cleanToken) return null;
  return {
    baseUrl: normalizedBaseUrl,
    wsUrl: dashboardWsUrl(normalizedBaseUrl, cleanToken),
    token: cleanToken,
    authMode: "token",
    mode: "ssh",
    profile: resolveProfile(profile),
  };
}

async function sshDashboardConnectionFromConfig(
  config: ConnectionConfig,
  profile?: string,
): Promise<DashboardConnection | null> {
  if (config.mode !== "ssh" || !config.ssh) return null;

  // Start `hermes dashboard` on the remote and tunnel to it (full parity with
  // local mode). NB: the dashboard is NOT a /v1 superset — web_server.py has no
  // /v1 chat routes (those live only on the gateway api_server, port 8642).
  // This tunnel serves the /api/* set and the /api/ws chat WebSocket, gated by
  // the dashboard session token, which is the SSH credential here. Returns
  // null when the remote can't run the dashboard (no Node / no web dist) —
  // the caller then falls back to legacy over the gateway /v1 tunnel.
  const dash = await sshEnsureDashboard(config.ssh, profile);
  if (!dash) return null;

  await ensureSshTunnel({ ...config.ssh, remotePort: dash.port });
  return sshDashboardConnectionFromTunnel(
    config,
    getSshTunnelUrl(),
    dash.token,
    profile,
  );
}

function getManagedDashboard(profile?: string): ManagedDashboard | undefined {
  const key = profileKey(profile);
  const managed = dashboards.get(key);
  if (!managed) return undefined;
  // ChildProcess.killed/signalCode describe signal bookkeeping, not reliable
  // OS liveness: Python can still serve an established WebSocket after those
  // fields change. Keep the process managed until the PID is actually gone.
  if (
    managed.retryOwnership ||
    (managed.proc.pid && pidIsAlive(managed.proc.pid))
  ) {
    return managed;
  }
  dashboards.delete(key);
  return undefined;
}

function dashboardCleanupFailure(profile?: string): string | undefined {
  return dashboardCleanupFailures.get(profileKey(profile));
}

function rememberDashboardCleanupFailure(key: string, error: unknown): void {
  dashboardCleanupFailures.set(
    key,
    error instanceof Error ? error.message : String(error),
  );
}

function unsupportedReasonForLocalSpawn(): string | undefined {
  return getRuntimeInvocation() ? undefined : "Aera Runtime is not prepared.";
}

function dashboardLogPath(profile: string | undefined): string {
  const dir = profileHome(profile);
  mkdirSync(dir, { recursive: true });
  return join(dir, "dashboard-stderr.log");
}

function dashboardHasPrebuiltWebDist(invocation: RuntimeInvocation): boolean {
  return existsSync(join(invocation.webDistDirectory, "index.html"));
}

async function getFreePort(): Promise<number> {
  const preferred = Number(process.env.HERMES_DESKTOP_DASHBOARD_PORT);
  if (Number.isInteger(preferred) && preferred > 0 && preferred < 65536) {
    if (await isPortFree(preferred)) return preferred;
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function requestJson(
  url: string,
  token: string,
  timeoutMs = 2_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      parsed,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Hermes-Session-Token": token,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("error", reject);
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(
              new Error(`${res.statusCode}: ${text || res.statusMessage}`),
            );
            return;
          }
          if (!text) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(
              new Error(
                `Invalid JSON from ${url} (status ${res.statusCode}): ${text.slice(
                  0,
                  200,
                )}`,
              ),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error(
          `Timed out connecting to the Aera Runtime dashboard after ${timeoutMs}ms`,
        ),
      );
    });
    req.end();
  });
}

export function probeDashboardWebSocket(
  connection: DashboardConnection,
  timeoutMs = 2_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(connection.wsUrl);
    const client = parsed.protocol === "wss:" ? https : http;
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    const req = client.request(parsed, {
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });

    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      req.destroy();
      if (err) reject(err);
      else resolve();
    };

    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      finish();
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8").trim();
        finish(
          new Error(
            `Aera Runtime dashboard chat WebSocket is unavailable (${res.statusCode}${
              body ? `: ${body.slice(0, 160)}` : ""
            })`,
          ),
        );
      });
    });
    req.on("error", (err) => finish(err));
    req.setTimeout(timeoutMs, () => {
      finish(
        new Error(
          `Timed out connecting to the Aera Runtime dashboard chat WebSocket after ${timeoutMs}ms`,
        ),
      );
    });
    req.end();
  });
}

async function waitForDashboardReady(
  connection: DashboardConnection,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await requestJson(`${connection.baseUrl}/api/status`, connection.token);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const message =
    lastError instanceof Error
      ? lastError.message
      : "dashboard did not respond";
  throw new Error(
    `Timed out waiting for the Aera Runtime dashboard: ${message}`,
  );
}

function dashboardStatusRequiresOAuth(status: unknown): boolean {
  return (
    typeof status === "object" &&
    status !== null &&
    (status as { auth_required?: unknown }).auth_required === true
  );
}

function errorNeedsOAuthLogin(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { needsOAuthLogin?: unknown }).needsOAuthLogin === true
  );
}

export async function getRemoteDashboardStatusForConfig(
  config: ConnectionConfig,
  profile?: string,
): Promise<DashboardStatus> {
  if (config.remoteChatTransport === "legacy") {
    return {
      supported: false,
      running: false,
      error: "Remote dashboard transport is disabled in Settings.",
    };
  }

  const baseUrl = normalizeRemoteDashboardBaseUrl(config.remoteUrl);
  if (!baseUrl) {
    return {
      supported: true,
      running: false,
      error: "Remote dashboard transport needs a valid dashboard URL.",
    };
  }

  let connection: DashboardConnection | undefined;
  try {
    const detected = await probeRemoteAuthMode(baseUrl);
    connection =
      remoteDashboardConnectionFromConfig(
        { ...config, remoteAuthMode: detected.authMode },
        profile,
      ) ?? undefined;

    if (detected.authMode === "oauth") {
      if (!connection) throw new Error("Could not resolve remote OAuth URL.");
      const sessionState = await remoteOAuthSessionState(baseUrl);
      if (!sessionState.signedIn) {
        return {
          supported: true,
          running: false,
          connection,
          needsOAuthLogin: true,
          error: "Sign in with your browser to connect to this remote gateway.",
        };
      }

      await requestRemoteOAuthJson(`${baseUrl}/api/sessions?limit=1`);
      const ticket = await mintRemoteOAuthWsTicket(baseUrl);
      await probeDashboardWebSocket({
        ...connection,
        wsUrl: buildRemoteOAuthWsUrl(baseUrl, ticket),
      });
      return { supported: true, running: true, connection };
    }

    if (!connection) {
      return {
        supported: true,
        running: false,
        error:
          "Remote dashboard transport needs a session token for this gateway.",
      };
    }

    await requestJson(
      `${connection.baseUrl}/api/sessions?limit=1`,
      connection.token,
    );
    await probeDashboardWebSocket(connection);

    return { supported: true, running: true, connection };
  } catch (err) {
    return {
      supported: true,
      running: false,
      connection,
      needsOAuthLogin: errorNeedsOAuthLogin(err),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getSshDashboardStatusForConfig(
  config: ConnectionConfig,
  profile?: string,
): Promise<DashboardStatus> {
  if (config.sshChatTransport === "legacy") {
    return {
      supported: false,
      running: false,
      error: "SSH dashboard transport is disabled in Settings.",
    };
  }

  if (!config.ssh?.host || !config.ssh.username) {
    return {
      supported: true,
      running: false,
      error: "SSH dashboard transport needs a configured host and username.",
    };
  }

  let connection: DashboardConnection | null = null;
  try {
    connection = await sshDashboardConnectionFromConfig(config, profile);
  } catch (err) {
    return {
      supported: true,
      running: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!connection) {
    return {
      supported: true,
      running: false,
      error:
        "SSH dashboard transport needs an active tunnel and API_SERVER_KEY on the remote Aera Runtime host.",
    };
  }

  try {
    const status = await requestJson(
      `${connection.baseUrl}/api/status`,
      connection.token,
    );
    if (dashboardStatusRequiresOAuth(status)) {
      return {
        supported: true,
        running: false,
        connection,
        error:
          "SSH dashboard requires OAuth browser authentication. Token-based dashboard over SSH is supported now; OAuth ticket flow is not wired in Aera yet.",
      };
    }

    await requestJson(
      `${connection.baseUrl}/api/sessions?limit=1`,
      connection.token,
    );
    await probeDashboardWebSocket(connection);

    return { supported: true, running: true, connection };
  } catch (err) {
    return {
      supported: true,
      running: false,
      connection,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getDashboardStatus(
  profile?: string,
): Promise<DashboardStatus> {
  const config = getConnectionConfig();
  const mode =
    config.mode === "remote" || config.mode === "ssh" ? config.mode : "local";
  if (mode === "remote")
    return getRemoteDashboardStatusForConfig(config, profile);
  if (mode === "ssh") return getSshDashboardStatusForConfig(config, profile);

  const cleanupFailure = dashboardCleanupFailure(profile);
  if (cleanupFailure) {
    return {
      supported: true,
      running: false,
      error: `Dashboard cleanup is incomplete: ${cleanupFailure}`,
      logPath: dashboardLogPath(resolveProfile(profile)),
    };
  }

  const managed = getManagedDashboard(profile);
  if (managed) {
    return {
      supported: true,
      running: true,
      connection: { ...managed.connection, alreadyRunning: true },
      logPath: managed.connection.logPath,
    };
  }

  const unsupported = unsupportedReasonForLocalSpawn();
  if (unsupported) {
    return { supported: false, running: false, error: unsupported };
  }

  return {
    supported: true,
    running: false,
    logPath: dashboardLogPath(resolveProfile(profile)),
  };
}

export async function freshDashboardWebSocketUrl(
  profile?: string,
): Promise<string> {
  const config = getConnectionConfig();
  if (config.mode === "remote") {
    const baseUrl = normalizeRemoteDashboardBaseUrl(config.remoteUrl);
    if (!baseUrl) throw new Error("Remote dashboard URL is invalid.");
    const detected = await probeRemoteAuthMode(baseUrl);
    if (detected.authMode === "oauth") {
      const ticket = await mintRemoteOAuthWsTicket(baseUrl);
      return dashboardWebSocketUrlForRenderer(
        buildRemoteOAuthWsUrl(baseUrl, ticket),
      );
    }
    const connection = remoteDashboardConnectionFromConfig(
      { ...config, remoteAuthMode: "token" },
      profile,
    );
    if (!connection) {
      throw new Error("Remote dashboard session token is missing.");
    }
    return dashboardWebSocketUrlForRenderer(connection.wsUrl);
  }

  const status = await getDashboardStatus(profile);
  if (!status.running || !status.connection?.wsUrl) {
    throw new Error(status.error || "Dashboard WebSocket is unavailable.");
  }
  return dashboardWebSocketUrlForRenderer(status.connection.wsUrl);
}

export async function startDashboard(
  profile?: string,
): Promise<DashboardStatus> {
  const config = getConnectionConfig();
  const mode =
    config.mode === "remote" || config.mode === "ssh" ? config.mode : "local";
  if (mode === "remote")
    return getRemoteDashboardStatusForConfig(config, profile);
  if (mode === "ssh") return getSshDashboardStatusForConfig(config, profile);

  // Pool-wide cleanup closes local admission synchronously. A caller that
  // races App/Profile shutdown must receive a bounded false result rather
  // than wait for cleanup and then create a brand-new process after the
  // shutdown barrier has already reported success.
  if (dashboardPoolClosed || dashboardPoolStopping) {
    return dashboardPoolUnavailableStatus();
  }

  const key = profileKey(profile);
  const stopping = dashboardStopsInFlight.get(key);
  if (stopping) {
    try {
      await stopping;
    } catch (error) {
      return {
        supported: true,
        running: false,
        error:
          error instanceof Error
            ? error.message
            : "Dashboard cleanup is still incomplete.",
      };
    }
  }
  // The per-Profile stop can be joined by a pool shutdown while this caller
  // is awaiting it. Recheck global admission before publishing a new start;
  // otherwise an already-admitted caller could resume inside the shutdown
  // barrier and rely on a later generation race to clean up after it.
  if (dashboardPoolClosed || dashboardPoolStopping) {
    return dashboardPoolUnavailableStatus();
  }
  const pending = dashboardStarts.get(key);
  if (pending) return pending;

  const cleanupFailure = dashboardCleanupFailure(profile);
  if (cleanupFailure) {
    return {
      supported: true,
      running: false,
      error: `Dashboard cleanup is incomplete: ${cleanupFailure}`,
      logPath: dashboardLogPath(resolveProfile(profile)),
    };
  }

  const existing = getManagedDashboard(profile);
  if (existing) {
    return {
      supported: true,
      running: true,
      connection: { ...existing.connection, alreadyRunning: true },
      logPath: existing.connection.logPath,
    };
  }

  const generation = dashboardStartGeneration(key);
  const start = startLocalDashboard(profile, key, generation);
  dashboardStarts.set(key, start);
  try {
    return await start;
  } finally {
    if (dashboardStarts.get(key) === start) dashboardStarts.delete(key);
  }
}

async function startLocalDashboard(
  profile: string | undefined,
  key: string,
  generation: number,
): Promise<DashboardStatus> {
  // Recheck after winning the per-profile start slot. This covers a process
  // becoming ready between the wrapper's fast-path lookup and this call.
  const existing = getManagedDashboard(profile);
  if (existing) {
    return {
      supported: true,
      running: true,
      connection: { ...existing.connection, alreadyRunning: true },
      logPath: existing.connection.logPath,
    };
  }

  const unsupported = unsupportedReasonForLocalSpawn();
  if (unsupported) {
    return { supported: false, running: false, error: unsupported };
  }
  const invocation = getRuntimeInvocation();
  if (!invocation) {
    return {
      supported: false,
      running: false,
      error: "Aera Runtime is not prepared.",
    };
  }

  const compat = ensureLocalDashboardCompatibility();
  const compatWarning = compat.ok
    ? ""
    : compat.error
      ? `${compat.detail}: ${compat.error}`
      : compat.detail;

  const resolvedProfile = resolveProfile(profile);
  // A local dashboard shares the Runtime's Python interpreter with the
  // primary gateway. Never cold-start one while the gateway itself is still
  // cold-starting: join the readiness-gated recovery path first so the two
  // Python processes never compete (first Windows launch + Defender scan).
  const gatewayHealthy = await isGatewayHealthy(resolvedProfile);
  if (dashboardStartGeneration(key) !== generation) {
    return supersededDashboardStartStatus();
  }
  if (!gatewayHealthy) {
    const gatewayRecovered = await startGatewayWithRecovery(
      resolvedProfile,
      90_000,
      500,
    );
    if (dashboardStartGeneration(key) !== generation) {
      return supersededDashboardStartStatus();
    }
    if (!gatewayRecovered) {
      return {
        supported: true,
        running: false,
        error:
          "Primary Gateway did not become ready; Dashboard was not started.",
      };
    }
  }
  const token = randomBytes(24).toString("hex");
  const port = await getFreePort();
  if (dashboardStartGeneration(key) !== generation) {
    return supersededDashboardStartStatus();
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const logPath = dashboardLogPath(resolvedProfile);
  const stderrFd = openSync(logPath, "a");
  const hasPrebuiltWebDist = dashboardHasPrebuiltWebDist(invocation);
  const cliArgs = buildLocalDashboardCliArgs(resolvedProfile, port, {
    skipBuild: hasPrebuiltWebDist,
  });

  let proc: ChildProcess;
  try {
    const dashboardEnv = invocation.environment({
      ...process.env,
      PATH: getEnhancedPath(),
      HOME: process.env.HOME || homedir(),
      HERMES_HOME,
      ...(hasPrebuiltWebDist
        ? { HERMES_WEB_DIST: invocation.webDistDirectory }
        : {}),
    }) as Record<string, string>;
    hydrateProfileRuntimeEnv(dashboardEnv, resolvedProfile);
    dashboardEnv.HERMES_DASHBOARD_SESSION_TOKEN = token;
    dashboardEnv.HERMES_DESKTOP = "1";
    proc = spawn(invocation.python, invocation.cliArgs(cliArgs), {
      cwd: invocation.workingDirectory,
      env: dashboardEnv,
      stdio: ["ignore", "ignore", stderrFd],
      // A dedicated POSIX process group lets stopDashboard terminate the
      // dashboard and workers it spawned. Windows uses taskkill /T instead.
      detached: process.platform !== "win32",
      ...HIDDEN_SUBPROCESS_OPTIONS,
    });
  } catch (err) {
    closeSync(stderrFd);
    return {
      supported: true,
      running: false,
      logPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  closeSync(stderrFd);

  const connection: DashboardConnection = {
    baseUrl,
    wsUrl: dashboardWsUrl(baseUrl, token),
    token,
    authMode: "token",
    mode: "local",
    profile: resolvedProfile,
    pid: proc.pid,
    port,
    logPath,
  };

  const managed = { proc, connection };
  dashboards.set(key, managed);
  proc.once("exit", () => {
    if (
      dashboards.get(key)?.proc === proc &&
      !dashboardCleanupFailures.has(key) &&
      (!proc.pid || !pidIsAlive(proc.pid))
    ) {
      dashboards.delete(key);
    }
  });

  try {
    await waitForDashboardReady(
      connection,
      hasPrebuiltWebDist ? 45_000 : 180_000,
    );
    await probeDashboardWebSocket(connection, 5_000);
  } catch (err) {
    let cleanupError: unknown = null;
    try {
      await terminateDashboardProcess(managed);
      if (dashboards.get(key)?.proc === proc) dashboards.delete(key);
      dashboardCleanupFailures.delete(key);
    } catch (error) {
      cleanupError = error;
      rememberDashboardCleanupFailure(key, error);
      // The wrapper/root can emit exit while terminateProcessTree is still
      // reporting live descendants. Restore its exact process-group handle so
      // an explicit stop can retry only this owned tree.
      if (!dashboards.has(key)) dashboards.set(key, managed);
      console.error(
        `[dashboard:${key}] process cleanup failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      supported: true,
      running: false,
      logPath,
      error: [
        err instanceof Error ? err.message : String(err),
        cleanupError
          ? `cleanup: ${
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError)
            }`
          : "",
        compatWarning ? `compatibility: ${compatWarning}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    };
  }

  if (dashboardStartGeneration(key) !== generation) {
    try {
      await terminateDashboardProcess(managed);
      if (dashboards.get(key)?.proc === proc) dashboards.delete(key);
      dashboardCleanupFailures.delete(key);
    } catch (error) {
      rememberDashboardCleanupFailure(key, error);
      if (!dashboards.has(key)) dashboards.set(key, managed);
      console.error(
        `[dashboard:${key}] superseded process cleanup failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return supersededDashboardStartStatus();
  }

  return { supported: true, running: true, connection, logPath };
}

export async function stopDashboard(profile?: string): Promise<boolean> {
  const key = profileKey(profile);
  const existingStop = dashboardStopsInFlight.get(key);
  if (existingStop) {
    await existingStop;
    return true;
  }

  const pendingStart = dashboardStarts.get(key);
  dashboardStartGenerations.set(key, dashboardStartGeneration(key) + 1);
  dashboardStarts.delete(key);
  const managed = dashboards.get(key);
  const stopping = (async (): Promise<void> => {
    let cleanupError: unknown = null;
    if (managed) {
      dashboards.delete(key);
      try {
        await terminateDashboardProcess(managed);
      } catch (error) {
        cleanupError = error;
      }
    }

    // A start can be waiting before it has published a ChildProcess. Await
    // its bounded continuation so shutdown cannot report success while the
    // continuation can still publish a late process.
    await waitForDashboardStartDrain(pendingStart);

    // If the start crossed the spawn boundary after our first snapshot, clean
    // that exact late child as well. Starts are serialized behind this map,
    // so this cannot accidentally take ownership from a newer generation.
    const late = dashboards.get(key);
    if (late && late !== managed) {
      dashboards.delete(key);
      try {
        await terminateDashboardProcess(late);
      } catch (error) {
        cleanupError ??= error;
      }
    }

    if (cleanupError !== null) {
      // Preserve exact ownership for an explicit, bounded retry.
      if (!dashboards.has(key)) {
        if (late) dashboards.set(key, late);
        else if (managed) dashboards.set(key, managed);
      }
      rememberDashboardCleanupFailure(key, cleanupError);
      throw cleanupError;
    }
    dashboardCleanupFailures.delete(key);
  })();
  dashboardStopsInFlight.set(key, stopping);
  try {
    await stopping;
    return true;
  } finally {
    if (dashboardStopsInFlight.get(key) === stopping) {
      dashboardStopsInFlight.delete(key);
    }
  }
}

export async function stopAllDashboards(
  options: { closePool?: boolean } = {},
): Promise<void> {
  if (options.closePool) dashboardPoolClosed = true;
  if (dashboardPoolShutdown) {
    await dashboardPoolShutdown;
    return;
  }

  // Close admission before taking the first snapshot. In-flight starts are
  // still drained by stopDashboard, while every new caller is rejected until
  // the fixed-point ownership drain has completed.
  dashboardPoolStopping = true;
  const shutdown = (async (): Promise<void> => {
    for (;;) {
      const keys = [
        ...new Set([
          ...dashboards.keys(),
          ...dashboardStarts.keys(),
          ...dashboardStopsInFlight.keys(),
        ]),
      ];
      if (keys.length === 0) return;

      const results = await Promise.allSettled(
        // `keys` are already canonical storage keys. Passing `undefined` for
        // the default key would resolve it through the mutable active Profile
        // and can stop the wrong Dashboard (or leave the default forever).
        keys.map((key) => stopDashboard(key)),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "Aera Dashboard cleanup failed.");
      }
    }
  })();
  dashboardPoolShutdown = shutdown;
  try {
    await shutdown;
  } finally {
    if (dashboardPoolShutdown === shutdown) dashboardPoolShutdown = null;
    if (!dashboardPoolClosed) dashboardPoolStopping = false;
  }
}
