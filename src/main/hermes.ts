import { ChildProcess, execFile, spawn } from "child_process";
import { randomUUID } from "crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  rmSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  statSync,
  fstatSync,
  readSync,
} from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import http from "http";
import https from "https";
import net from "net";
import WebSocket from "ws";
import { app } from "electron";
import { HERMES_HOME, getEnhancedPath } from "./installer";
import { getRuntimeInvocation } from "./agentera-runtime-distribution/invocation";
import {
  getApiServerKey,
  getConnectionConfig,
  getConfigValue,
  getModelConfig,
  readEnv,
} from "./config";
import {
  getSshTunnelUrl,
  isSshTunnelActive,
  isSshTunnelHealthy,
  ensureSshTunnel,
} from "./ssh-tunnel";
import {
  pidIsAliveAs,
  stripAnsi,
  profileHome,
  normalizeProfileName,
  getActiveProfileNameSync,
} from "./utils";
import {
  normalizeProcessImage,
  processImageMatchesExecutable,
  processEvidenceMatches,
  readProcessIdentityEvidence,
  readProcessIdentityEvidenceAsync,
  type ProcessIdentityEvidence,
} from "./process-identity";
import { getProfilePort, isLoopbackPortReleased } from "./gateway-ports";
import {
  prepareGatewayManagedConfiguration,
  type GatewayManagedConfigurationDependencies,
} from "./gateway-managed-config";
import { runtimeProviderForRoute } from "./runtime-provider-compat";
import { promptSudoPassword, promptSecretValue } from "./gatewayPrompt";
import { getSecret } from "./secrets";
import { readModels } from "./models";
import { providerListSafe } from "./secrets";
import { HIDDEN_SUBPROCESS_OPTIONS } from "./process-options";
import {
  retryCapturedProcessTermination,
  terminateProcessTree,
  terminateProcessTreeByPid,
  type ProcessTreeRetryOwnership,
  type ProcessTreeTerminationResult,
} from "./process-tree";
import { type Attachment, escapeXmlAttr } from "../shared/attachments";
import { type SessionModelOverride } from "../shared/model-override";
import {
  OPENAI_COMPAT_PROVIDERS,
  customProviderEnvKey,
} from "../shared/url-key-map";
import {
  chatToolEventFromPayload,
  chatToolProgressLabel,
  type ChatToolEvent,
} from "../shared/chat-stream";
import {
  chatToolEventFromRunEvent,
  parseRunSseBlock,
  runCompletedUsage,
  runEventReasoningText,
  runFailureCode,
  shouldFallbackFromRunFailure,
  supportsHermesRunsTransport,
  type HermesApiCapabilities,
} from "./run-stream";
import {
  gatewayCompletionSuffix,
  gatewayMessageCompleteText,
  gatewayMessageDelta,
  gatewayReasoningText,
  gatewayToolEvent,
  gatewayUsage,
  type GatewayEvent,
} from "./tui-gateway-stream";
import {
  hostDerivedEnvKeyForUrl,
  runtimeHostDerivedEnvKeyForUrl,
  shouldPruneOpenRouterApiKey,
} from "./host-derived-env";
import { hydrateProfileRuntimeEnv } from "./profile-runtime-env";
import {
  GatewayProcessOwnershipError,
  GatewayProcessOwnershipLedger,
  type GatewayProcessOwnershipErrorCode,
  type GatewayLaunchOwnershipRecord,
} from "./gateway-process-ownership";

/**
 * Resolve which profile a gateway call targets. An explicit profile always
 * wins; otherwise we fall back to the file-backed active profile so that
 * callers without a profile argument (health polling, status, app-exit)
 * operate on whatever the desktop is currently showing — not a hardcoded
 * "default". Returns `undefined` for the default profile (matching the
 * profileHome/readEnv/getProfilePort convention).
 */
function resolveProfile(profile?: string): string | undefined {
  return normalizeProfileName(profile ?? getActiveProfileNameSync());
}

/** Map a resolved profile to the key used in the per-profile process maps. */
function profileKey(profile?: string): string {
  return resolveProfile(profile) ?? "default";
}

let gatewayManagedConfigurationDependencies: GatewayManagedConfigurationDependencies | null =
  null;
// The managed bootstrap transaction can create API_SERVER_KEY and invalidate
// config.ts's read cache before the next readiness probe runs. Keep the exact
// prepared value for this Profile while its Gateway is alive so a later
// bound-send health check cannot treat a healthy process as unauthenticated.
const preparedGatewayKeys = new Map<string, string>();

export function configureGatewayManagedConfiguration(
  dependencies: GatewayManagedConfigurationDependencies | null,
): void {
  gatewayManagedConfigurationDependencies = dependencies;
}

export async function prepareGatewayForLaunch(
  profile?: string,
): Promise<PreparedGatewayLaunch> {
  if (!gatewayManagedConfigurationDependencies) {
    throw new Error("model_configuration_mutation_unavailable");
  }
  // Preserve an explicit "default" target. `resolveProfile("default")`
  // intentionally returns undefined for file helpers, but passing that
  // undefined across this boundary makes the managed-config layer interpret
  // it as "use the active Profile". That can prepare a credential for the
  // active account space while the caller starts the default Agent Profile.
  const targetProfile =
    profile === undefined ? (resolveProfile(undefined) ?? "default") : profile;
  const prepared = await prepareGatewayManagedConfiguration(
    targetProfile,
    gatewayManagedConfigurationDependencies,
  );
  preparedGatewayKeys.set(profileKey(targetProfile), prepared.key);
  return prepared;
}

export interface PreparedGatewayLaunch {
  readonly key: string;
  readonly port: number;
}

/**
 * Normalise a remote-mode URL the user typed into the connection
 * settings.  Strips trailing slashes and, importantly, a trailing
 * `/v1` segment — callers append `/v1/<path>` themselves, so leaving
 * the user's `/v1` would produce `http://host/v1/v1/chat/completions`
 * → 404.  Reported as #266 (multiple users entered the URL "with
 * /v1" because the gateway's curl examples show that form).
 *
 * Also tolerates trailing whitespace and the rare `/v1/` (slash-suffixed)
 * form.  Returns the cleaned string.
 */
export function normaliseRemoteUrl(raw: string): string {
  let url = (raw || "").trim();
  // Strip trailing slashes
  url = url.replace(/\/+$/, "");
  // Strip trailing `/v1` (callers append /v1/<path> themselves)
  url = url.replace(/\/v1$/i, "");
  return url;
}

export function getApiUrl(profile?: string): string {
  const conn = getConnectionConfig();
  if (conn.mode === "ssh") {
    const sshUrl = getSshTunnelUrl();
    if (sshUrl) return normaliseRemoteUrl(sshUrl);
    throw new Error("SSH tunnel is not active");
  }
  if (conn.mode === "remote" && conn.remoteUrl) {
    return normaliseRemoteUrl(conn.remoteUrl);
  }
  // Local mode: each profile's gateway binds its own port so they can run
  // concurrently. Address the active (or explicitly requested) profile's
  // gateway rather than a fixed 8642 — that constant would always resolve to
  // whichever gateway grabbed the port first, regardless of active profile.
  return `http://127.0.0.1:${getProfilePort(resolveProfile(profile))}`;
}

export function isRemoteMode(): boolean {
  const mode = getConnectionConfig().mode;
  return mode === "remote" || mode === "ssh";
}

/** True only for pure remote HTTP — SSH tunnel has full local access via SSH exec */
export function isRemoteOnlyMode(): boolean {
  return getConnectionConfig().mode === "remote";
}

// Cached API key read from the remote .env when SSH tunnel starts
let _sshRemoteApiKey = "";

export function setSshRemoteApiKey(key: string): void {
  _sshRemoteApiKey = key;
}

export function getRemoteAuthHeader(): Record<string, string> {
  const conn = getConnectionConfig();
  if (conn.mode === "ssh") {
    if (_sshRemoteApiKey)
      return { Authorization: `Bearer ${_sshRemoteApiKey}` };
    return {};
  }
  if (
    conn.mode === "remote" &&
    conn.remoteAuthMode !== "oauth" &&
    conn.apiKey
  ) {
    return { Authorization: `Bearer ${conn.apiKey}` };
  }
  return {};
}

function getApiAuthHeaders(
  profile?: string,
  preparedApiServerKey?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...getRemoteAuthHeader(),
  };
  // Local API server key (API_SERVER_KEY in the profile's .env /
  // config.yaml) only applies in local mode — in remote/SSH mode the
  // remote endpoint's own auth header is authoritative.
  if (!isRemoteMode()) {
    const apiServerKey =
      preparedApiServerKey?.trim() ||
      preparedGatewayKeys.get(profileKey(profile)) ||
      getApiServerKey(profile);
    if (apiServerKey) {
      headers.Authorization = `Bearer ${apiServerKey}`;
    }
  }
  return headers;
}

function getJsonApiHeaders(
  profile: string | undefined,
  bodyBuf: Buffer,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Content-Length": String(bodyBuf.length),
    ...getApiAuthHeaders(profile),
  };
}

function capabilityCacheKey(
  profile?: string,
  preparedApiServerKey?: string,
): string {
  const auth = getApiAuthHeaders(profile, preparedApiServerKey).Authorization
    ? "auth"
    : "anon";
  return `${getApiUrl(profile)}|${auth}`;
}

async function getApiCapabilities(
  profile?: string,
  preparedApiServerKey?: string,
): Promise<HermesApiCapabilities | null> {
  let key: string;
  try {
    key = capabilityCacheKey(profile, preparedApiServerKey);
  } catch {
    return null;
  }
  const cached = capabilitiesCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const url = `${getApiUrl(profile)}/v1/capabilities`;
  const requester = url.startsWith("https") ? https : http;
  const value = await new Promise<HermesApiCapabilities | null>((resolve) => {
    let done = false;
    let timeout: NodeJS.Timeout | null = null;
    const finish = (result: HermesApiCapabilities | null): void => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const req = requester.request(
      url,
      {
        method: "GET",
        headers: getApiAuthHeaders(profile, preparedApiServerKey),
        timeout: CAPABILITIES_TIMEOUT_MS,
        // Readiness/capability probes are short-lived lifecycle traffic. Do
        // not leave an idle keep-alive socket on the gateway port that can be
        // closed by the gateway during a restart and become TIME_WAIT there.
        agent: isLoopbackGatewayUrl(url)
          ? gatewayAgentFor(url, profile)
          : undefined,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            finish(null);
            return;
          }
          try {
            finish(JSON.parse(raw) as HermesApiCapabilities);
          } catch {
            finish(null);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.on("error", () => finish(null));
    timeout = setTimeout(() => {
      req.destroy();
      finish(null);
    }, CAPABILITIES_TIMEOUT_MS);
    req.end();
  });
  capabilitiesCache.set(key, {
    value,
    expiresAt: Date.now() + CAPABILITIES_CACHE_MS,
  });
  return value;
}

function resolveRemoteApiKey(url: string, apiKey?: string): string {
  if (apiKey !== undefined) return apiKey;

  const conn = getConnectionConfig();
  if (conn.mode !== "remote" || !conn.apiKey || !conn.remoteUrl) return "";
  if (normaliseRemoteUrl(conn.remoteUrl) !== normaliseRemoteUrl(url)) {
    return "";
  }
  if (conn.remoteAuthMode === "oauth") return "";
  return conn.apiKey;
}

export async function ensureSshTunnelIfNeeded(): Promise<void> {
  const conn = getConnectionConfig();
  if (
    conn.mode === "ssh" &&
    (!isSshTunnelActive() || !(await isSshTunnelHealthy()))
  ) {
    await ensureSshTunnel(conn.ssh);
  }
}

function audioExtensionForMime(mimeType: string): string {
  const type = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (type === "audio/mp4") return ".m4a";
  if (type === "audio/mpeg") return ".mp3";
  if (type === "audio/ogg") return ".ogg";
  if (type === "audio/wav" || type === "audio/x-wav") return ".wav";
  if (type === "audio/flac") return ".flac";
  if (type === "video/webm" || type === "audio/webm") return ".webm";
  return ".webm";
}

function transcribeAudioViaLocalPython(
  audio: Uint8Array,
  mimeType: string,
  profile?: string,
): Promise<string> {
  const invocation = getRuntimeInvocation();
  if (!invocation) {
    throw new Error(
      "Voice input needs a local Aera Runtime install with speech-to-text support.",
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "hermes-desktop-stt-"));
  const audioPath = join(dir, `speech${audioExtensionForMime(mimeType)}`);
  writeFileSync(audioPath, Buffer.from(audio));

  const script = [
    "import json, sys",
    "from tools.transcription_tools import transcribe_audio",
    "result = transcribe_audio(sys.argv[1])",
    "print(json.dumps(result))",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const proc = spawn(invocation.python, ["-c", script, audioPath], {
      cwd: invocation.workingDirectory,
      env: tuiGatewayEnv(profile),
      stdio: ["ignore", "pipe", "pipe"],
      ...HIDDEN_SUBPROCESS_OPTIONS,
    });

    let stdout = "";
    let stderr = "";
    const cleanup = (): void => {
      try {
        unlinkSync(audioPath);
      } catch {
        // best effort
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort; the file cleanup above is the important part.
      }
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    proc.on("error", (error) => {
      cleanup();
      reject(error);
    });
    proc.on("close", (code) => {
      cleanup();
      if (code !== 0) {
        reject(
          new Error(
            `Local transcription failed (${code ?? "unknown"}). ${stderr.slice(
              0,
              200,
            )}`.trim(),
          ),
        );
        return;
      }
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const jsonLine = lines[lines.length - 1] || "";
      let result: {
        success?: boolean;
        transcript?: string;
        text?: string;
        error?: string;
      };
      try {
        result = JSON.parse(jsonLine) as typeof result;
      } catch {
        reject(
          new Error(
            `Local transcription returned an invalid response. ${stdout
              .slice(0, 200)
              .trim()}`,
          ),
        );
        return;
      }
      if (result.success === false) {
        reject(new Error(result.error || "Local transcription failed."));
        return;
      }
      resolve((result.transcript || result.text || "").trim());
    });
  });
}

/**
 * Transcribe a recorded audio clip through the Hermes API server.
 *
 * The Python server owns STT provider selection (`stt.provider`, local
 * faster-whisper, Groq, OpenAI, ElevenLabs, etc.). Keeping desktop voice input
 * on `/api/audio/transcribe` matches upstream and avoids assuming that the
 * active chat model endpoint also exposes Whisper-compatible routes.
 *
 * Throws with a user-readable message so the caller can surface it.
 */
export async function transcribeAudio(
  audio: Uint8Array,
  mimeType: string,
  profile?: string,
): Promise<string> {
  const resolved = resolveProfile(profile);
  if (!isRemoteMode()) {
    const ready =
      apiServerAvailable === true ||
      (await isApiServerReady(resolved)) ||
      (await startGatewayWithRecovery(resolved));
    setApiCacheFor(resolved, ready);
    if (!ready) {
      throw new Error(
        "Voice input needs the Aera Runtime API server, but it is not running.",
      );
    }
  }

  const safeMimeType = mimeType || "audio/webm";
  const body = {
    data_url: `data:${safeMimeType};base64,${Buffer.from(audio).toString(
      "base64",
    )}`,
    mime_type: safeMimeType,
  };
  const res = await fetch(`${getApiUrl(resolved)}/api/audio/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getApiAuthHeaders(resolved),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    if (!isRemoteMode() && res.status === 404) {
      return transcribeAudioViaLocalPython(audio, safeMimeType, resolved);
    }
    throw new Error(
      `Transcription failed (${res.status}). ${bodyText.slice(0, 200)}`.trim(),
    );
  }
  const data = (await res.json().catch(() => null)) as {
    transcript?: string;
    text?: string;
  } | null;
  if (!data) {
    throw new Error(
      "Transcription failed. The Aera Runtime API returned an invalid response.",
    );
  }
  return (data.transcript || data.text || "").trim();
}

interface ChatHandle {
  abort: () => void;
}

interface GatewayRpcFrame {
  error?: { message?: string };
  id?: string | number | null;
  method?: string;
  params?: GatewayEvent;
  result?: unknown;
}

interface GatewayPending {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

type GatewayEventHandler = (event: GatewayEvent) => void;

const DASHBOARD_GATEWAY_PORT_FLOOR = 9120;
const DASHBOARD_GATEWAY_PORT_CEILING = 9199;

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function pickDashboardPort(): Promise<number> {
  for (
    let port = DASHBOARD_GATEWAY_PORT_FLOOR;
    port <= DASHBOARD_GATEWAY_PORT_CEILING;
    port += 1
  ) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(
    `No free localhost port in ${DASHBOARD_GATEWAY_PORT_FLOOR}-${DASHBOARD_GATEWAY_PORT_CEILING}`,
  );
}

function isDashboardReady(baseUrl: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      `${baseUrl}/api/status`,
      {
        method: "GET",
        headers: { "X-Hermes-Session-Token": token },
        timeout: 1500,
      },
      (res) => {
        resolve((res.statusCode || 500) < 400);
        res.resume();
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitForDashboardReady(
  baseUrl: string,
  token: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDashboardReady(baseUrl, token)) return;
    await delay(500);
  }
  throw new Error("Aera Runtime dashboard gateway did not become ready");
}

const TUI_GATEWAY_STOPPED_MESSAGE =
  "Aera Runtime dashboard gateway stream stopped";

export interface TuiGatewayClientDependencies {
  pickDashboardPort: () => Promise<number>;
  spawnBackend: typeof spawn;
  waitForDashboardReady: typeof waitForDashboardReady;
  terminateProcessTree: (
    proc: ChildProcess,
    options: {
      detachedProcessGroup: boolean;
      forceAfterMs: number;
    },
  ) => Promise<ProcessTreeTerminationResult>;
  retryCapturedProcessTermination?: (
    ownership: ProcessTreeRetryOwnership,
    options: {
      detachedProcessGroup: boolean;
      forceAfterMs: number;
    },
  ) => Promise<ProcessTreeTerminationResult>;
}

const defaultTuiGatewayClientDependencies: TuiGatewayClientDependencies = {
  pickDashboardPort,
  spawnBackend: spawn,
  waitForDashboardReady,
  terminateProcessTree,
  retryCapturedProcessTermination,
};

class TuiGatewayStoppedError extends Error {
  constructor(message = TUI_GATEWAY_STOPPED_MESSAGE) {
    super(message);
    this.name = "TuiGatewayStoppedError";
  }
}

const TUI_STARTUP_DRAIN_TIMEOUT_MS = 3_000;

/**
 * A stop must observe the complete startup continuation, but a third-party
 * readiness implementation can fail to notice that its child was terminated.
 * Keep the drain bounded so Electron quit cannot inherit an unbounded network
 * wait; generation checks and the late-child pass still own anything that
 * appears after this bound.
 */
async function waitForTuiStartupDrain(
  startupTask: Promise<void> | null,
): Promise<void> {
  if (!startupTask) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, TUI_STARTUP_DRAIN_TIMEOUT_MS);
    timer.unref?.();
  });
  await Promise.race([startupTask.catch(() => undefined), timeout]);
  if (timer) clearTimeout(timer);
}

let tuiGatewayPoolClosed = false;
let tuiGatewayPoolStopping = false;
let tuiGatewayShutdownRequests = 0;
let tuiGatewayShutdownQueue: Promise<void> = Promise.resolve();
const tuiGatewayStopsInFlight = new Set<Promise<void>>();
const tuiGatewayFailedClientKeys = new Set<string>();

function maybeReopenTuiGatewayPool(): void {
  if (
    tuiGatewayShutdownRequests === 0 &&
    !tuiGatewayPoolClosed &&
    tuiGatewayFailedClientKeys.size === 0 &&
    tuiGatewayClients.size === 0
  ) {
    tuiGatewayPoolStopping = false;
  }
}

function assertTuiGatewayPoolAdmissionOpen(): void {
  if (
    tuiGatewayPoolClosed ||
    tuiGatewayPoolStopping ||
    tuiGatewayFailedClientKeys.size > 0
  ) {
    throw new TuiGatewayStoppedError(
      "Aera Runtime dashboard gateway pool is shutting down",
    );
  }
}

function trackTuiGatewayStop(stopping: Promise<void>): Promise<void> {
  tuiGatewayStopsInFlight.add(stopping);
  void stopping
    .finally(() => tuiGatewayStopsInFlight.delete(stopping))
    .catch(() => {
      // The owning shutdown path reports its own cleanup error.
    });
  return stopping;
}

export async function waitForTuiGatewayShutdowns(): Promise<void> {
  for (;;) {
    const queue = tuiGatewayShutdownQueue;
    const inFlight = [...tuiGatewayStopsInFlight];
    await Promise.allSettled([...inFlight, queue]);
    if (
      queue === tuiGatewayShutdownQueue &&
      tuiGatewayStopsInFlight.size === 0
    ) {
      break;
    }
  }
  if (tuiGatewayFailedClientKeys.size > 0) {
    throw new Error("Aera Runtime dashboard gateway cleanup is incomplete");
  }
}

export class TuiGatewayClient {
  private readonly dependencies: TuiGatewayClientDependencies;
  private admissionClosed = false;
  private generation = 0;
  private handlers = new Set<GatewayEventHandler>();
  private nextId = 0;
  private pending = new Map<string, GatewayPending>();
  private proc: ChildProcess | null = null;
  private recentEvents: GatewayEvent[] = [];
  private ready: Promise<void> | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyResolve: (() => void) | null = null;
  /**
   * The complete backend startup continuation.  Keeping this separate from
   * `ready` is important: `ready` is rejected as soon as shutdown begins,
   * while the async continuation may still be between port selection,
   * process spawn, readiness polling, and WebSocket setup.
   */
  private startupTask: Promise<void> | null = null;
  /** Exact identity-bound ownership handles retained when a stop leaves one
   * or more reparented Windows descendants alive. A single cleanup attempt can
   * produce independent handles for the old retry tree and a newly published
   * explicit child; dropping either handle would orphan that tree. */
  private retryOwnerships: ProcessTreeRetryOwnership[] = [];
  private stopPromise: Promise<void> | null = null;
  private ws: WebSocket | null = null;

  constructor(
    private readonly key: string,
    private readonly env: Record<string, string>,
    dependencies: Partial<TuiGatewayClientDependencies> = {},
  ) {
    this.dependencies = {
      ...defaultTuiGatewayClientDependencies,
      ...dependencies,
    };
  }

  onEvent(handler: GatewayEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  findRecentEvent(
    predicate: (event: GatewayEvent) => boolean,
  ): GatewayEvent | null {
    for (let i = this.recentEvents.length - 1; i >= 0; i--) {
      const event = this.recentEvents[i];
      if (predicate(event)) return event;
    }
    return null;
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 120_000,
  ): Promise<T> {
    await this.start();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Aera Runtime dashboard gateway stream is not connected");
    }

    const id = `r${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Aera Runtime gateway request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        reject,
        resolve: (value) => resolve(value as T),
        timer,
      });

      try {
        this.ws!.send(JSON.stringify({ id, jsonrpc: "2.0", method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async start(): Promise<void> {
    if (this.admissionClosed) {
      throw new TuiGatewayStoppedError(
        "Aera Runtime dashboard gateway pool is shutting down",
      );
    }
    assertTuiGatewayPoolAdmissionOpen();
    if (this.stopPromise) await this.stopPromise;
    if (this.admissionClosed) {
      throw new TuiGatewayStoppedError(
        "Aera Runtime dashboard gateway pool is shutting down",
      );
    }
    assertTuiGatewayPoolAdmissionOpen();
    if (this.ready) return this.ready;
    if (this.proc || this.retryOwnerships.length > 0) {
      throw new TuiGatewayStoppedError(
        "Aera Runtime dashboard gateway cleanup is incomplete",
      );
    }

    const generation = ++this.generation;
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.ready = ready;

    const startupTask = this.startDashboardBackend(generation);
    this.startupTask = startupTask;
    void startupTask
      .then(() => {
        if (this.generation === generation && this.ready === ready) {
          this.readyResolve?.();
        }
      })
      .catch((error) => {
        if (this.generation !== generation) return;
        const err = error instanceof Error ? error : new Error(String(error));
        this.readyReject?.(err);
        this.rejectPending(err);
        void this.stop(err).catch((cleanupError) => {
          console.error(
            `[dashboard-gateway:${this.key}] Runtime process cleanup failed:`,
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
          );
        });
      })
      .finally(() => {
        if (this.startupTask === startupTask) {
          this.startupTask = null;
        }
      });

    return ready;
  }

  async stop(reason: Error = new TuiGatewayStoppedError()): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    ++this.generation;
    const proc = this.proc;
    const startupTask = this.startupTask;
    const readyReject = this.readyReject;
    this.rejectPending(reason);
    this.resetTransportState();
    readyReject?.(reason);

    const stopping = (async (): Promise<void> => {
      let terminationError: unknown = null;
      try {
        await this.terminateOwnedProcess(proc);
      } catch (error) {
        terminationError = error;
      }

      // The process can be assigned after stop() snapshots `this.proc` (for
      // example, while startDashboardBackend is resuming from port selection).
      // When the first exact-tree termination succeeds, drain the startup
      // continuation before declaring the client stopped, then make one more
      // exact-child cleanup attempt for anything it published during that
      // continuation.  If termination itself failed, return that bounded
      // ownership failure promptly; the invalidated continuation is detached
      // (with its rejection already observed by start()) and a later stop()
      // retry owns the exact child without waiting on a readiness promise that
      // may never receive a process-exit event.
      if (terminationError === null) {
        await waitForTuiStartupDrain(startupTask);
      } else if (this.startupTask === startupTask) {
        this.startupTask = null;
      }
      const lateProc = this.proc;
      if (lateProc && lateProc !== proc) {
        try {
          await this.terminateOwnedProcess(lateProc);
        } catch (error) {
          terminationError ??= error;
        }
      }

      if (terminationError !== null) throw terminationError;
    })();
    this.stopPromise = stopping;
    try {
      await stopping;
      if (this.proc === proc || (proc === null && this.proc !== null)) {
        this.proc = null;
      }
    } finally {
      if (this.stopPromise === stopping) this.stopPromise = null;
    }
  }

  closeAdmission(): void {
    this.admissionClosed = true;
    ++this.generation;
  }

  private assertGeneration(generation: number): void {
    if (this.generation !== generation) {
      throw new TuiGatewayStoppedError();
    }
  }

  private async startDashboardBackend(generation: number): Promise<void> {
    const invocation = getRuntimeInvocation();
    if (!invocation) {
      throw new Error("Aera Runtime is not prepared.");
    }

    const port = await this.dependencies.pickDashboardPort();
    this.assertGeneration(generation);
    const token = randomUUID();
    const dashboardEnv = invocation.environment({
      ...this.env,
      HERMES_DASHBOARD_SESSION_TOKEN: token,
      HERMES_DASHBOARD_TUI: "1",
      HERMES_DESKTOP: "1",
    });
    // Runtime 0.20 reserves `dashboard` for the browser management surface.
    // Desktop owns a Profile-scoped, headless JSON-RPC/WebSocket backend.
    const args = invocation.cliArgs([
      "serve",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ]);
    const proc = this.dependencies.spawnBackend(invocation.python, args, {
      cwd: invocation.workingDirectory,
      env: dashboardEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      ...HIDDEN_SUBPROCESS_OPTIONS,
    });
    this.proc = proc;
    if (this.generation !== generation) {
      // A concurrent stop() may have taken its snapshot before this spawn
      // completed.  Do not call stop() recursively here: stop() is waiting
      // for this startup task and that would deadlock.  Its post-startup
      // exact-child pass will normally own this process; if no stop is in
      // flight (for example closeAdmission() alone), clean it up here.
      if (this.stopPromise === null) {
        await this.terminateOwnedProcess(proc);
        if (this.proc === proc) this.proc = null;
      }
      throw new TuiGatewayStoppedError();
    }

    let rejectEarlyExit!: (error: Error) => void;
    const exitBeforeReady = new Promise<never>((_resolve, reject) => {
      rejectEarlyExit = reject;
    });
    let backendReady = false;
    const handleProcessFailure = (error: Error): void => {
      if (this.generation !== generation || this.proc !== proc) return;
      this.rejectPending(error);
      this.readyReject?.(error);
      void this.stop(error).catch((cleanupError) => {
        console.error(
          `[dashboard-gateway:${this.key}] Runtime process cleanup failed:`,
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
        );
      });
    };
    const onProcessError = (error: Error): void => {
      if (!backendReady) {
        rejectEarlyExit(error);
        return;
      }
      handleProcessFailure(error);
    };
    const onEarlyExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      rejectEarlyExit(
        new Error(
          `Aera Runtime dashboard gateway exited before ready (${signal || code})`,
        ),
      );
    };
    proc.on("error", onProcessError);
    proc.once("exit", onEarlyExit);

    proc.stdout?.on("data", (chunk: Buffer) => {
      const line = stripAnsi(chunk.toString()).trim();
      if (line) console.log(`[dashboard-gateway:${this.key}] ${line}`);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const line = stripAnsi(chunk.toString()).trim();
      if (line) console.warn(`[dashboard-gateway:${this.key}] ${line}`);
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await Promise.race([
      this.dependencies.waitForDashboardReady(baseUrl, token, 45_000),
      exitBeforeReady,
    ]);
    this.assertGeneration(generation);
    if (this.proc !== proc) throw new TuiGatewayStoppedError();
    await Promise.race([
      this.connectWebSocket(
        `ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`,
        generation,
      ),
      exitBeforeReady,
    ]);
    this.assertGeneration(generation);
    if (this.proc !== proc) throw new TuiGatewayStoppedError();

    backendReady = true;
    proc.removeListener("exit", onEarlyExit);
    proc.once("exit", (code, signal) => {
      handleProcessFailure(
        new Error(`Aera Runtime dashboard gateway exited (${signal || code})`),
      );
    });
  }

  private connectWebSocket(url: string, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.assertGeneration(generation);
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error("Aera Runtime dashboard gateway WebSocket timed out"));
        ws.close();
      }, 15_000);
      timer.unref?.();

      ws.on("open", () => {
        clearTimeout(timer);
        try {
          this.assertGeneration(generation);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      ws.on("message", (data) => {
        if (this.generation === generation) {
          this.handleFrame(wsDataToString(data));
        }
      });
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      ws.on("close", () => {
        if (this.generation !== generation || this.ws !== ws) return;
        const error = new Error(
          "Aera Runtime dashboard gateway WebSocket closed",
        );
        this.rejectPending(error);
        void this.stop(error).catch((cleanupError) => {
          console.error(
            `[dashboard-gateway:${this.key}] Runtime process cleanup failed:`,
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
          );
        });
      });
    });
  }

  private async terminateOwnedProcess(
    proc: ChildProcess | null,
  ): Promise<void> {
    if (!proc && this.retryOwnerships.length === 0) return;
    const options = {
      detachedProcessGroup: process.platform !== "win32",
      forceAfterMs: 3_000,
    };
    const retryOwnerships = [...this.retryOwnerships];
    let explicitResult: ProcessTreeTerminationResult | null = null;
    let firstError: unknown = null;

    // A prior Windows cleanup can retain reparented descendants while a
    // startup continuation publishes a new explicit ChildProcess.  These are
    // independent identity-bound targets: always make both bounded attempts
    // instead of letting the retry handle hide the explicit process.
    const retryResults: Array<{
      ownership: ProcessTreeRetryOwnership;
      result: ProcessTreeTerminationResult | null;
    }> = [];
    for (const retryOwnership of retryOwnerships) {
      try {
        const retryResult = await (
          this.dependencies.retryCapturedProcessTermination ??
          retryCapturedProcessTermination
        )(retryOwnership, options);
        retryResults.push({ ownership: retryOwnership, result: retryResult });
      } catch (error) {
        retryResults.push({ ownership: retryOwnership, result: null });
        firstError ??= error;
      }
    }
    if (proc !== null) {
      try {
        explicitResult = await this.dependencies.terminateProcessTree(
          proc,
          options,
        );
      } catch (error) {
        firstError ??= error;
      }
    }

    const remainingPids = [
      ...retryResults.flatMap(({ result }) => result?.remainingPids ?? []),
      ...(explicitResult?.remainingPids ?? []),
    ];
    // A rejected retry probe is itself an ownership ambiguity: it does not
    // prove that the previously captured descendants exited or that their
    // identities changed. Keep the opaque handle so a later bounded stop can
    // retry the exact evidence rather than silently dropping a live Runtime.
    const nextRetryOwnerships: ProcessTreeRetryOwnership[] = [];
    for (const { ownership, result } of retryResults) {
      if (result === null) {
        // A rejected evidence probe is ambiguous; retain the exact handle for
        // a later bounded retry instead of treating the tree as gone.
        nextRetryOwnerships.push(ownership);
      } else if (result.remainingPids.length > 0) {
        nextRetryOwnerships.push(result.retryOwnership ?? ownership);
      }
    }
    if ((explicitResult?.remainingPids.length ?? 0) > 0) {
      const explicitOwnership = explicitResult?.retryOwnership;
      if (
        explicitOwnership &&
        !nextRetryOwnerships.includes(explicitOwnership)
      ) {
        nextRetryOwnerships.push(explicitOwnership);
      }
    }
    this.retryOwnerships = nextRetryOwnerships;

    if (firstError !== null) throw firstError;
    if (remainingPids.length > 0) {
      throw new Error(
        `Runtime process tree did not fully exit: ${[
          ...new Set(remainingPids),
        ].join(",")}`,
      );
    }
    // Only release identity-bound ownership after the retry reports a fully
    // drained tree.  A later stop must be able to retry the same descendants.
    this.retryOwnerships = [];
  }

  private resetTransportState(): void {
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.removeAllListeners();
      if (
        ws &&
        (ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING)
      ) {
        ws.close();
      }
    } catch {
      // best-effort cleanup
    }
    this.recentEvents = [];
    this.ready = null;
    this.readyReject = null;
    this.readyResolve = null;
  }

  private handleFrame(raw: string): void {
    let frame: GatewayRpcFrame;
    try {
      frame = JSON.parse(raw) as GatewayRpcFrame;
    } catch {
      return;
    }

    if (frame.id != null) {
      const pending = this.pending.get(String(frame.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(frame.id));
      if (frame.error) {
        pending.reject(
          new Error(frame.error.message || "Aera Runtime RPC failed"),
        );
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    if (frame.method !== "event" || !frame.params?.type) return;
    this.recentEvents.push(frame.params);
    if (this.recentEvents.length > 50) {
      this.recentEvents.splice(0, this.recentEvents.length - 50);
    }
    if (frame.params.type === "gateway.ready") {
      this.readyResolve?.();
    }
    for (const handler of this.handlers) {
      handler(frame.params);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function waitForGatewayEvent(
  client: TuiGatewayClient,
  predicate: (event: GatewayEvent) => boolean,
  timeoutMs: number,
): Promise<GatewayEvent> {
  const recent = client.findRecentEvent(predicate);
  if (recent) return Promise.resolve(recent);

  return new Promise((resolve, reject) => {
    let cleanup = (): void => undefined;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Aera Runtime gateway readiness"));
    }, timeoutMs);
    timer.unref?.();
    cleanup = client.onEvent((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      cleanup();
      resolve(event);
    });
  });
}

function wsDataToString(
  data: string | Buffer | ArrayBuffer | Buffer[],
): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
  return Buffer.from(data).toString("utf-8");
}

const tuiGatewayClients = new Map<string, TuiGatewayClient>();

export function tuiGatewayEnv(profile?: string): Record<string, string> {
  const resolved = resolveProfile(profile);
  const invocation = getRuntimeInvocation();
  const base: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: getEnhancedPath(),
    HOME: homedir(),
    HERMES_HOME: profileHome(resolved),
    PYTHONUNBUFFERED: "1",
  };
  const env = (invocation ? invocation.environment(base) : base) as Record<
    string,
    string
  >;
  if (invocation?.source === "external") {
    const envPathDelimiter = process.platform === "win32" ? ";" : ":";
    env.HERMES_PYTHON_SRC_ROOT = invocation.workingDirectory;
    const existingPythonPath = env.PYTHONPATH?.trim();
    env.PYTHONPATH = existingPythonPath
      ? `${invocation.workingDirectory}${envPathDelimiter}${existingPythonPath}`
      : invocation.workingDirectory;
  }
  if (resolved) env.HERMES_PROFILE = resolved;
  hydrateProfileRuntimeEnv(env, resolved);
  return env;
}

export function getTuiGatewayClient(
  profile?: string,
  dependencies: Partial<TuiGatewayClientDependencies> = {},
): TuiGatewayClient {
  assertTuiGatewayPoolAdmissionOpen();
  const key = profileKey(profile);
  let client = tuiGatewayClients.get(key);
  if (!client) {
    client = new TuiGatewayClient(key, tuiGatewayEnv(profile), dependencies);
    tuiGatewayClients.set(key, client);
  }
  return client;
}

function shouldUseTuiGatewayClient(): boolean {
  return (
    process.env.VITEST !== "true" &&
    process.env.NODE_ENV !== "test" &&
    process.env.npm_lifecycle_event !== "test"
  );
}

function warmTuiGatewayClient(profile?: string): void {
  if (isRemoteMode()) return;
  if (!shouldUseTuiGatewayClient()) return;
  try {
    void getTuiGatewayClient(profile)
      .start()
      .catch((error) => {
        console.warn(
          `[dashboard-gateway:${profileKey(profile)}] warmup failed:`,
          error instanceof Error ? error.message : String(error),
        );
      });
  } catch (error) {
    console.warn(
      `[dashboard-gateway:${profileKey(profile)}] warmup skipped:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function retireTuiGatewayClient(profile?: string): Promise<void> {
  const key = profileKey(profile);
  const client = tuiGatewayClients.get(key);
  if (!client) return;
  client.closeAdmission();
  const stopping = trackTuiGatewayStop(client.stop());
  try {
    await stopping;
    tuiGatewayFailedClientKeys.delete(key);
    if (tuiGatewayClients.get(key) === client) {
      tuiGatewayClients.delete(key);
    }
    maybeReopenTuiGatewayPool();
  } catch (error) {
    tuiGatewayFailedClientKeys.add(key);
    console.error(
      `[dashboard-gateway:${key}] Runtime process cleanup failed:`,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

function stopTuiGatewayClient(profile?: string): void {
  void retireTuiGatewayClient(profile).catch(() => {
    // The exact-profile retirement path records and reports cleanup failure.
  });
}

export async function stopAllTuiGatewayClients(
  options: {
    closePool?: boolean;
  } = {},
): Promise<void> {
  if (options.closePool) tuiGatewayPoolClosed = true;
  tuiGatewayPoolStopping = true;
  tuiGatewayShutdownRequests += 1;

  const shutdown = tuiGatewayShutdownQueue.then(async () => {
    const clients = [...tuiGatewayClients.entries()];
    for (const [, client] of clients) client.closeAdmission();
    const results = await Promise.allSettled(
      clients.map(([, client]) => trackTuiGatewayStop(client.stop())),
    );
    const errors: unknown[] = [];
    results.forEach((result, index) => {
      const [key, client] = clients[index] ?? [];
      if (result.status === "fulfilled") {
        if (key !== undefined) tuiGatewayFailedClientKeys.delete(key);
        if (key !== undefined && tuiGatewayClients.get(key) === client) {
          tuiGatewayClients.delete(key);
        }
      } else {
        if (key !== undefined) tuiGatewayFailedClientKeys.add(key);
        errors.push(result.reason);
      }
    });
    if (errors.length > 0) {
      const details = errors
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        )
        .join("; ");
      throw new AggregateError(
        errors,
        `Aera Runtime dashboard gateway cleanup is incomplete: ${details}`,
      );
    }
  });
  const settled = shutdown.finally(() => {
    tuiGatewayShutdownRequests -= 1;
    maybeReopenTuiGatewayPool();
  });
  tuiGatewayShutdownQueue = settled.catch(() => undefined);
  await settled;
}

const CAPABILITIES_TIMEOUT_MS = 350;
const CAPABILITIES_CACHE_MS = 60_000;

const capabilitiesCache = new Map<
  string,
  { expiresAt: number; value: HermesApiCapabilities | null }
>();

// ────────────────────────────────────────────────────
//  API Server health check
// ────────────────────────────────────────────────────

// Every loopback request to a gateway we manage goes through these agents so
// the sockets are ours to close. Node's global agent has kept connections
// alive by default since v19, and a still-ESTABLISHED connection at SIGTERM is
// closed by the *gateway*, which parks a TIME_WAIT socket on its own port. That
// socket blocks the next gateway's bind for a full MSL (~30s measured on
// darwin) because aiohttp deliberately sets `reuse_address=False` there, and
// the runtime treats EADDRINUSE as fatal and non-retryable. Draining these
// pools before SIGTERM makes the desktop close first, so the TIME_WAIT lands on
// our ephemeral port instead and the gateway port is reusable immediately.
// Built on first use rather than at import: this module is imported by tests
// that stub `http`/`https` with partial shapes, and an agent is only ever needed
// once something actually talks to a gateway.
type GatewayConnectionAgents = {
  http?: http.Agent;
  https?: https.Agent;
};

const gatewayConnectionAgents = new Map<string, GatewayConnectionAgents>();

function gatewayAgentFor(
  url: string,
  profile?: string,
): http.Agent | https.Agent | undefined {
  const key = profileKey(profile);
  const agents = gatewayConnectionAgents.get(key) ?? {};
  gatewayConnectionAgents.set(key, agents);
  try {
    if (url.startsWith("https")) {
      agents.https ??= new https.Agent({ keepAlive: true, maxSockets: 8 });
      return agents.https;
    }
    agents.http ??= new http.Agent({ keepAlive: true, maxSockets: 8 });
    return agents.http;
  } catch {
    // No usable Agent (stubbed module). Fall back to the default agent; the
    // drain below then has nothing of ours to close, which is correct.
    return undefined;
  }
}

/** Only gateways we spawn are ours to drain; remote and SSH targets are not. */
function isLoopbackGatewayUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
    );
  } catch {
    return false;
  }
}

/**
 * Close every idle *and* active socket the desktop holds against a gateway.
 *
 * Must run before the SIGTERM in {@link stopGateway}: after the signal the
 * gateway wins the race to close and the port is lost to TIME_WAIT.
 */
function drainGatewayConnections(profile?: string): void {
  const key = profileKey(profile);
  const agents = gatewayConnectionAgents.get(key);
  if (!agents) return;
  for (const agent of [agents.http, agents.https]) {
    if (!agent) continue;
    try {
      agent.destroy();
    } catch {
      // Best effort: a failed drain only costs us the fast rebind.
    }
  }
  gatewayConnectionAgents.delete(key);
}

function isApiServerReady(
  profile?: string,
  preparedApiServerKey?: string,
  preparedApiServerPort?: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const resolved = resolveProfile(profile);
      const local = !isRemoteMode();
      // `/health` is intentionally public and proves only that a listener is
      // alive. Local readiness must exercise a Bearer-protected route so a
      // mismatched desktop/gateway key is detected before the first chat.
      const baseUrl =
        local && Number.isInteger(preparedApiServerPort)
          ? `http://127.0.0.1:${preparedApiServerPort}`
          : getApiUrl(resolved);
      const url = `${baseUrl}${local ? "/v1/capabilities" : "/health"}`;
      const mod = url.startsWith("https") ? https : http;
      const req = mod.request(
        url,
        {
          method: "GET",
          timeout: 1500,
          // This is lifecycle traffic, not an application stream. Keep it on
          // the profile pool so shutdown can drain it, and close the response
          // from the Desktop as soon as headers arrive; otherwise the Gateway
          // can be the first peer to close and leave TIME_WAIT on its fixed
          // listening port.
          agent: local ? gatewayAgentFor(url, profile) : undefined,
          ...(local
            ? {
                headers: {
                  ...getApiAuthHeaders(resolved, preparedApiServerKey),
                  Connection: "close",
                },
              }
            : { headers: getRemoteAuthHeader() }),
        },
        (res) => {
          const ready = res.statusCode === 200;
          if (typeof res.destroy === "function") res.destroy();
          else res.resume();
          resolve(ready);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ────────────────────────────────────────────────────
//  HTTP API streaming (fast path — no process spawn)
// ────────────────────────────────────────────────────

/**
 * Pull the streaming reasoning / thinking text from one SSE `delta`
 * object, if present. Two shapes seen in the wild:
 *
 *   - DeepSeek (reasoning models): `delta.reasoning_content`
 *   - OpenAI o1/o3-style streams + some OpenRouter routes:
 *     `delta.reasoning` (older OpenAI thinking-mode docs also use this
 *     field name).
 *
 * Returns `""` (falsy) for any other shape, so the caller can skip
 * forwarding without a null check.
 *
 * Exported so we can unit-test the field-extraction without booting
 * the whole HTTP path. (#352)
 */
export function extractReasoningDelta(delta: unknown): string {
  if (!delta || typeof delta !== "object") return "";
  const d = delta as Record<string, unknown>;
  if (typeof d.reasoning_content === "string" && d.reasoning_content)
    return d.reasoning_content;
  if (typeof d.reasoning === "string" && d.reasoning) return d.reasoning;
  return "";
}

/**
 * Pending clarify requests, keyed by the gateway `request_id`. When the agent
 * asks a clarifying question the stream handler registers a resolver here (a
 * closure over the live gateway client) and surfaces the question to the
 * renderer. The renderer's answer arrives via the `clarify-respond` IPC handler,
 * which calls `resolvePendingClarify` to fire the resolver and forward the
 * answer to the gateway. Entries are one-shot and self-clear on use; the stream
 * handler also clears any leftover on turn end so an abandoned turn can't leak a
 * stale resolver.
 */
const pendingClarify = new Map<string, (answer: string) => void>();

export function registerPendingClarify(
  requestId: string,
  resolver: (answer: string) => void,
): void {
  pendingClarify.set(requestId, resolver);
}

/** Fire and remove the resolver for `requestId`. Returns true if one was waiting. */
export function resolvePendingClarify(
  requestId: string,
  answer: string,
): boolean {
  const resolver = pendingClarify.get(requestId);
  if (!resolver) return false;
  pendingClarify.delete(requestId);
  resolver(answer);
  return true;
}

export function clearPendingClarify(requestId: string): void {
  pendingClarify.delete(requestId);
}

export interface ChatCallbacks {
  onChunk: (text: string) => void;
  /** Streaming reasoning / thinking tokens, when the provider emits them
   *  alongside `content`. DeepSeek surfaces these as `delta.reasoning_content`;
   *  OpenAI o1/o3-style streams use `delta.reasoning`. Forwarded on a
   *  dedicated channel so the renderer can render the thinking bubble
   *  live instead of waiting for a state-DB refresh on focus change
   *  (issue #352). */
  onReasoningChunk?: (text: string) => void;
  onDone: (sessionId?: string) => void;
  onSessionStarted?: (sessionId: string) => void;
  onError: (error: string) => void;
  onToolProgress?: (tool: string) => void;
  onToolEvent?: (event: ChatToolEvent) => void;
  onUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost?: number;
    rateLimitRemaining?: number;
    rateLimitReset?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }) => void;
  /** The agent asked a clarifying question mid-turn (`clarify.request`). The
   *  renderer shows an inline card; the user's answer returns via the
   *  `clarify-respond` IPC handler, which resolves the pending request for this
   *  `requestId` by calling `clarify.respond` on the live gateway client. */
  onClarify?: (req: {
    requestId: string;
    question: string;
    choices: string[];
  }) => void;
}

/**
 * Generic, caller-composed instructions that must stay attached to one Hermes
 * conversation. Hermes does not know which product feature produced them.
 */
export interface HermesConversationEnvelope {
  instructions: string;
  requireBoundApiTransport: boolean;
  toolPolicy?: Readonly<{
    allowed: readonly string[];
    denied: readonly string[];
  }>;
}

/**
 * Main-only, turn-scoped route resolved by the installed-Agent execution
 * lease. Credential values must never cross preload IPC or persistence.
 */
export interface HermesAgentModelExecution {
  modelOverride: SessionModelOverride;
  apiMode: string | null;
  credential: string | null;
  routeMode: "configured" | "dynamic";
  disableTransportReplay: boolean;
}

export interface HermesAgentModelTransportRoute {
  provider: string;
  model: string;
  base_url: string;
  api_mode: string | null;
}

/** Build the short-lived upstream route consumed only by a transport request. */
export function buildAgentModelTransportRoute(
  execution: HermesAgentModelExecution,
): HermesAgentModelTransportRoute {
  return {
    provider: runtimeProviderForRoute(
      execution.modelOverride.provider,
      execution.modelOverride.baseUrl,
    ),
    model: execution.modelOverride.model,
    base_url: execution.modelOverride.baseUrl,
    api_mode: execution.apiMode,
  };
}

/**
 * Dynamic routes are sent only to a Runtime that explicitly advertises the
 * request-scoped route contract; unknown/older Runtimes stay fail-closed.
 */
export function supportsHermesAgentModelRoute(
  capabilities: HermesApiCapabilities | null | undefined,
): boolean {
  const endpoint = capabilities?.endpoints?.chat_completions;
  const path =
    endpoint && typeof endpoint === "object"
      ? (endpoint as { path?: unknown }).path
      : null;
  return (
    capabilities?.features?.request_model_route === true &&
    path === "/v1/chat/completions"
  );
}

export function assertHermesAgentModelRouteSupported(
  capabilities: HermesApiCapabilities | null | undefined,
): void {
  if (supportsHermesAgentModelRoute(capabilities)) return;
  throw Object.assign(
    new Error(
      "The connected Aera Runtime does not support request-scoped Agent model routes.",
    ),
    { code: "model_switch_runtime_route_unsupported" },
  );
}

/** Signed Agent turns require Runtime-side, request-scoped tool enforcement. */
export function supportsHermesAgentToolPolicy(
  capabilities: HermesApiCapabilities | null | undefined,
): boolean {
  return capabilities?.features?.request_tool_policy === true;
}

export function assertHermesAgentToolPolicySupported(
  capabilities: HermesApiCapabilities | null | undefined,
): void {
  if (supportsHermesAgentToolPolicy(capabilities)) return;
  throw Object.assign(
    new Error(
      "The connected Aera Runtime does not support request-scoped Agent tool policy.",
    ),
    { code: "agent_tool_policy_runtime_unsupported" },
  );
}

export function shouldProbeAgentModelTransport(
  execution: HermesAgentModelExecution | null | undefined,
): boolean {
  return execution?.disableTransportReplay !== true;
}

const BOUND_API_TRANSPORT_UNAVAILABLE =
  "Aera bound runtime connection is unavailable.";
const AGENT_MODEL_EMPTY_RESPONSE =
  "Aera Agent model route returned no output; the candidate segment was not replayed.";

export interface BoundAgentCapabilitiesDependencies {
  ensureReady: () => Promise<boolean>;
  getCapabilities: () => Promise<HermesApiCapabilities | null>;
}

/**
 * A bound Agent must establish the profile Gateway before asking it for the
 * request-scoped contract.  Probing first creates a false "unsupported"
 * result whenever a newly-installed profile has not started its Gateway yet;
 * that result is then cached and blocks the first real turn.  Keeping this
 * ordering in one small seam makes the lifecycle contract testable without
 * booting Electron.
 */
export async function prepareBoundAgentCapabilities(
  profile: string | undefined,
  dependencies?: BoundAgentCapabilitiesDependencies,
): Promise<HermesApiCapabilities | null> {
  const ensureReady =
    dependencies?.ensureReady ??
    (async () =>
      (await isApiServerReady(profile)) ||
      (await startGatewayWithRecovery(profile, 30_000)));
  const getCapabilities =
    dependencies?.getCapabilities ?? (() => getApiCapabilities(profile));

  if (!(await ensureReady())) {
    throw Object.assign(new Error(BOUND_API_TRANSPORT_UNAVAILABLE), {
      code: "bound_runtime_unavailable",
    });
  }
  return getCapabilities();
}

type ChatContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

/**
 * Build the OpenAI-compatible `content` payload for a user turn.
 *
 * - No attachments → plain string (preserves prompt-cache friendliness for
 *   the all-text path).
 * - Text-file attachments → inlined into the text part as `<file …>…</file>`
 *   wrappers (the gateway rejects `file`/`input_file` content parts, see
 *   gateway/platforms/api_server.py:263).
 * - Image attachments → emitted as `image_url` parts in the OpenAI vision
 *   format, which the gateway accepts and converts for Anthropic providers.
 * - Path-ref attachments → appended as `[Attached file: <abs-path>]` lines
 *   so the agent's existing file-reading skills can pick them up.  Works
 *   for PDFs/docx/binaries the gateway won't pass through inline.
 */
export function buildUserContent(
  text: string,
  attachments?: Attachment[],
): ChatContent {
  if (!attachments || attachments.length === 0) return text;

  const textFiles = attachments.filter((a) => a.kind === "text-file");
  const pathRefs = attachments.filter(
    (a) => a.kind === "path-ref" && typeof a.path === "string" && a.path,
  );
  const images = attachments.filter(
    (a) => a.kind === "image" && typeof a.dataUrl === "string" && a.dataUrl,
  );

  const parts: string[] = [];
  if (text.trim()) parts.push(text);
  for (const f of textFiles) {
    if (typeof f.text !== "string") continue;
    const name = escapeXmlAttr(f.name);
    const mime = escapeXmlAttr(f.mime || "text/plain");
    parts.push(`<file name="${name}" mime="${mime}">\n${f.text}\n</file>`);
  }
  if (pathRefs.length > 0) {
    const lines = pathRefs.map((f) => `[Attached file: ${f.path}]`);
    parts.push(lines.join("\n"));
  }
  const composedText = parts.join("\n\n");

  if (images.length === 0) return composedText;

  const imageParts = images.map((img) => ({
    type: "image_url" as const,
    image_url: { url: img.dataUrl! },
  }));

  // Omit the text part entirely when there's nothing to say — some
  // providers (Anthropic via Bedrock, certain vision endpoints) reject an
  // empty-string text part as `invalid_content_part`.
  if (!composedText) return imageParts;

  return [{ type: "text" as const, text: composedText }, ...imageParts];
}

/**
 * Build the system message that scopes a conversation to a working folder
 * (issue #27). Returns null when no folder is set (undefined / empty /
 * whitespace) so callers can skip injection. Exported for unit testing.
 */
export function contextFolderSystemMessage(
  contextFolder?: string,
): { role: "system"; content: string } | null {
  const folder = contextFolder?.trim();
  if (!folder) return null;
  return {
    role: "system",
    content:
      `The working folder for this conversation is ${folder}. ` +
      `When the user asks you to read, create, modify, or run project ` +
      `files, use the file, terminal, and code-execution tools with ` +
      `absolute paths under this folder.`,
  };
}

/**
 * Build the single system instruction sent to both supported HTTP transports.
 * The caller envelope is always first and the local working-folder constraint
 * is always second. Without an envelope this preserves the existing payload.
 */
export function conversationSystemMessage(
  contextFolder?: string,
  envelope?: HermesConversationEnvelope,
): { role: "system"; content: string } | null {
  const context = contextFolderSystemMessage(contextFolder);
  const instructions = envelope?.instructions.trim() ?? "";
  if (!instructions) return context;
  return {
    role: "system",
    content: context ? `${instructions}\n\n${context.content}` : instructions,
  };
}

export interface HermesAgentModelRequestBodyInput {
  message: string;
  history?: Array<{ role: string; content: string }>;
  attachments?: Attachment[];
  contextFolder?: string;
  envelope?: HermesConversationEnvelope;
  sessionId?: string;
  model?: string;
  reasoningEffort?: string | null;
  execution?: HermesAgentModelExecution;
}

/**
 * Build the JSON body for the short-lived Agent model transport. The route is
 * deliberately nested under an internal request field and is only supplied
 * when Main has already proven Runtime request-route capability. Nothing here
 * is written to a binding, transcript, or renderer-facing object.
 */
export function buildAgentModelRequestBody(
  input: HermesAgentModelRequestBodyInput,
): Record<string, unknown> {
  const messages: Array<{ role: string; content: ChatContent }> = [];
  for (const msg of input.history ?? []) {
    messages.push({
      role: msg.role === "agent" ? "assistant" : msg.role,
      content: msg.content,
    });
  }
  messages.push({
    role: "user",
    content: buildUserContent(input.message, input.attachments),
  });
  const system = conversationSystemMessage(input.contextFolder, input.envelope);
  if (system) messages.unshift(system);

  const model =
    input.execution?.modelOverride.model || input.model || "hermes-agent";
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
  };
  if (input.reasoningEffort) body.reasoning_effort = input.reasoningEffort;
  if (input.execution?.routeMode === "dynamic") {
    body.aera_model_route = buildAgentModelTransportRoute(input.execution);
  }
  if (input.envelope?.toolPolicy) {
    body.aera_tool_policy = input.envelope.toolPolicy;
  }
  return body;
}

function reasoningEffortForProfile(
  profile?: string,
): "minimal" | "low" | "medium" | "high" | "xhigh" | null {
  const value = (getConfigValue("agent.reasoning_effort", profile) || "")
    .trim()
    .toLowerCase();

  return value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : null;
}

function sendMessageViaApi(
  message: string,
  cb: ChatCallbacks,
  profile?: string,
  _resumeSessionId?: string,
  history?: Array<{ role: string; content: string }>,
  attachments?: Attachment[],
  contextFolder?: string,
  override?: SessionModelOverride,
  envelope?: HermesConversationEnvelope,
  execution?: HermesAgentModelExecution,
): ChatHandle {
  const mc = effectiveModelConfig(profile, override);
  const controller = new AbortController();

  // Build full conversation from history + current message (standard OpenAI format).
  // History items are kept text-only — attachments from prior turns live in
  // the gateway's session state when resuming via session_id.
  const messages: Array<{ role: string; content: ChatContent }> = [];
  if (history && history.length > 0) {
    for (const msg of history) {
      messages.push({
        role: msg.role === "agent" ? "assistant" : msg.role,
        content: msg.content,
      });
    }
  }
  const userContent = buildUserContent(message, attachments);
  messages.push({ role: "user", content: userContent });

  // Context folder (issue #27): when the conversation is bound to a working
  // folder, prepend a system message so the agent scopes file/terminal work
  // there. Injected only at the request-build step — the renderer's visible
  // transcript stays clean, and getSessionMessages filters non-user/assistant
  // roles, so reloaded sessions stay clean too.
  const ctxSystem = conversationSystemMessage(contextFolder, envelope);
  if (ctxSystem) messages.unshift(ctxSystem);

  const reasoningEffort = reasoningEffortForProfile(profile);
  const bodyObj: Record<string, unknown> = {
    model: mc.model || "hermes-agent",
    messages,
    stream: true,
    ...(_resumeSessionId ? { session_id: _resumeSessionId } : {}),
  };
  if (execution?.routeMode === "dynamic") {
    bodyObj.aera_model_route = buildAgentModelTransportRoute(execution);
  }
  if (envelope?.toolPolicy) {
    bodyObj.aera_tool_policy = envelope.toolPolicy;
  }
  if (reasoningEffort) bodyObj.reasoning_effort = reasoningEffort;
  const body = JSON.stringify(bodyObj);

  // Encode the body up-front into a Buffer so we can:
  //  1. Set `Content-Length` accurately based on byte length (NOT char
  //     count — JSON.stringify of an image data URL is ASCII so they
  //     match, but multi-byte chars in user text would diverge).
  //  2. Disable Node's default `Transfer-Encoding: chunked` framing for
  //     bodies written via `req.write(body); req.end();`. Chunked
  //     framing skips the gateway's `body_limit_middleware` (which
  //     inspects Content-Length only), so an oversized payload that
  //     should produce a clean 413 "body_too_large" gets the
  //     misleading 400 "Invalid JSON in request body" via aiohttp's
  //     client_max_size overflow path. See #405.
  const bodyBuf = Buffer.from(body, "utf-8");

  const headers = getJsonApiHeaders(profile, bodyBuf);

  // Session id: always send via `X-Hermes-Session-Id` so the gateway
  // doesn't fall back to its `_derive_chat_session_id` fingerprint —
  // sha256(system_prompt + first_user_message)[:16] — which collides
  // across every chat whose first user message is the same (e.g. "Hi").
  // The collision silently fragments state.db rows across unrelated
  // conversations and, post-#352, surfaces as old-session content
  // bleeding into new chats when our end-of-stream merge reads
  // getSessionMessages(). Filed upstream as
  // NousResearch/hermes-agent#7484 (security framing — same root cause).
  //
  // Format: `desk-<ms>-<uuidv4>`. UUIDv4 alone is collision-safe
  // probabilistically (~10⁻³⁶ for any pair); the timestamp prefix makes
  // it defensively unique even under a hypothetical PRNG bug, and the
  // `desk-` tag makes desktop-originated sessions visually distinct
  // from the gateway's fingerprint-derived `api-<hash>` ids in
  // state.db / logs.
  //
  // Gate on auth: the gateway rejects `X-Hermes-Session-Id` with 403
  // when API_SERVER_KEY isn't configured (its history-load is gated
  // behind auth). The desktop auto-generates API_SERVER_KEY at install
  // and remote mode supplies its own bearer, so in practice this
  // branch is always taken; the guard exists only so a misconfigured
  // local install degrades to the pre-fix (fingerprint) behaviour
  // rather than 403-looping.
  const hasAuth = "Authorization" in headers;
  const resumingExistingSession = Boolean(_resumeSessionId);
  let sessionId =
    _resumeSessionId || (hasAuth ? `desk-${Date.now()}-${randomUUID()}` : "");
  if (sessionId) {
    headers["X-Hermes-Session-Id"] = sessionId;
  }
  let announcedSessionId = "";
  function announceSessionId(id: string): void {
    if (!id || announcedSessionId === id) return;
    announcedSessionId = id;
    cb.onSessionStarted?.(id);
  }
  if (resumingExistingSession) {
    announceSessionId(sessionId);
  }

  let hasContent = false;
  let finished = false; // guard against double callbacks
  let lastError = ""; // capture embedded error messages
  // Tool progress pattern: `emoji tool_name` or `emoji description`
  const toolProgressRe = /^`([^\s`]+)\s+([^`]+)`$/;

  function finish(error?: string): void {
    if (finished) return;
    finished = true;
    console.log(
      "[hermes] finish called:",
      error ? `error=${error}` : "done",
      "sessionId=",
      sessionId,
    );
    if (error) {
      cb.onError(error);
    } else {
      cb.onDone(sessionId || undefined);
    }
  }

  function probeRealError(): void {
    if (!shouldProbeAgentModelTransport(execution)) {
      finish(AGENT_MODEL_EMPTY_RESPONSE);
      return;
    }
    // When streaming returns empty, make a non-streaming request to surface the real error
    const probeBodyObj: Record<string, unknown> = {
      model: mc.model || "hermes-agent",
      messages: [{ role: "user", content: userContent }],
      stream: false,
    };
    if (reasoningEffort) probeBodyObj.reasoning_effort = reasoningEffort;
    const probeBody = JSON.stringify(probeBodyObj);
    const probeBodyBuf = Buffer.from(probeBody, "utf-8");
    // Per-request Content-Length (the outer `headers` object's value
    // belongs to the streaming request — reusing it here would lie about
    // this body's size and break the framing the same way the missing
    // Content-Length did before #405). Spread + override.
    const probeHeaders = {
      ...headers,
      "Content-Length": String(probeBodyBuf.length),
    };
    const probeUrl = `${getApiUrl(profile)}/v1/chat/completions`;
    const probeMod = probeUrl.startsWith("https") ? https : http;
    const probeReq = probeMod.request(
      probeUrl,
      {
        method: "POST",
        headers: probeHeaders,
        agent: isLoopbackGatewayUrl(probeUrl)
          ? gatewayAgentFor(probeUrl, profile)
          : undefined,
      },
      (res) => {
        let raw = "";
        res.on("data", (d) => {
          raw += d.toString();
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            const content = parsed.choices?.[0]?.message?.content || "";
            const errMsg = parsed.error?.message || "";
            finish(
              content ||
                errMsg ||
                "No response received from the model. Check your model configuration and API key.",
            );
          } catch {
            finish(
              "No response received from the model. Check your model configuration and API key.",
            );
          }
        });
      },
    );
    probeReq.on("error", () => {
      finish(
        "No response received from the model. Check your model configuration and API key.",
      );
    });
    probeReq.write(probeBodyBuf);
    probeReq.end();
  }

  /** Handle a custom SSE event (non-data lines with `event:` prefix). */
  function processCustomEvent(eventType: string, data: string): void {
    if (eventType === "hermes.tool.progress") {
      try {
        const payload = JSON.parse(data) as Record<string, unknown>;
        const toolEvent = chatToolEventFromPayload(payload);
        announceSessionId(sessionId);
        if (cb.onToolEvent) {
          cb.onToolEvent(toolEvent);
        }
        if (!cb.onToolEvent && cb.onToolProgress) {
          cb.onToolProgress(chatToolProgressLabel(toolEvent));
        }
      } catch {
        /* malformed — skip */
      }
    }
  }

  function processSseData(data: string): boolean {
    if (data === "[DONE]") {
      if (hasContent) {
        finish();
      } else if (lastError) {
        finish(lastError);
      } else {
        // Streaming returned empty — probe non-streaming to get the real error
        probeRealError();
      }
      return true; // signals done
    }
    try {
      const parsed = JSON.parse(data);
      const stableFailureCode =
        parsed.error?.code === "provider_authentication_rejected" ||
        parsed.hermes?.error_code === "provider_authentication_rejected"
          ? "provider_authentication_rejected"
          : "";

      // Capture error responses forwarded through SSE
      if (parsed.error) {
        const message = parsed.error.message || JSON.stringify(parsed.error);
        lastError = stableFailureCode
          ? `${stableFailureCode}: ${message}`
          : message;
        return false;
      }

      const choice = parsed.choices?.[0];
      const delta = choice?.delta;

      // A failed stream may carry its stable code in the final Hermes
      // metadata rather than an OpenAI ``error`` object. Capture it before
      // the [DONE] sentinel so we do not issue an empty-stream probe (which
      // would replay the failed provider request).
      if (stableFailureCode) {
        const message =
          typeof parsed.hermes.error === "string"
            ? parsed.hermes.error
            : "The model provider rejected the current credential.";
        lastError = `${stableFailureCode}: ${message}`;
      }

      // Extract usage from final chunk (with optional cost + rate limit info)
      if (parsed.usage && cb.onUsage) {
        cb.onUsage({
          promptTokens: parsed.usage.prompt_tokens || 0,
          completionTokens: parsed.usage.completion_tokens || 0,
          totalTokens: parsed.usage.total_tokens || 0,
          cost: parsed.usage.cost,
          rateLimitRemaining: parsed.usage.rate_limit_remaining,
          rateLimitReset: parsed.usage.rate_limit_reset,
          // Prompt-cache stats for the context gauge. The gateway emits
          // cache_read_tokens / cache_write_tokens; OpenAI-style providers
          // expose cached_tokens under prompt_tokens_details.
          cacheReadTokens:
            parsed.usage.cache_read_tokens ??
            parsed.usage.prompt_tokens_details?.cached_tokens,
          cacheWriteTokens: parsed.usage.cache_write_tokens,
        });
      }

      // Reasoning / thinking tokens, when the provider emits them.
      // Forwarded on a dedicated callback so the renderer can render the
      // thinking bubble live (#352). We do NOT set `hasContent = true`
      // here — reasoning alone shouldn't suppress the "empty stream"
      // diagnostic probe.
      const reasoningDelta = extractReasoningDelta(delta);
      if (reasoningDelta && cb.onReasoningChunk) {
        announceSessionId(sessionId);
        cb.onReasoningChunk(reasoningDelta);
      }

      if (delta?.content) {
        const content = delta.content.trim();
        // Legacy: Detect tool progress lines injected into content: `🔍 search_web`
        const match = toolProgressRe.exec(content);
        if (match && cb.onToolProgress) {
          cb.onToolProgress(`${match[1]} ${match[2]}`);
        } else {
          hasContent = true;
          announceSessionId(sessionId);
          cb.onChunk(delta.content);
        }
      }
    } catch {
      /* malformed chunk — skip */
    }
    return false;
  }

  const chatUrl = `${getApiUrl(profile)}/v1/chat/completions`;
  const requester = chatUrl.startsWith("https") ? https.request : http.request;
  const req = requester(
    chatUrl,
    {
      method: "POST",
      headers,
      signal: controller.signal,
      timeout: 120000,
      agent: isLoopbackGatewayUrl(chatUrl)
        ? gatewayAgentFor(chatUrl, profile)
        : undefined,
    },
    (res) => {
      const sid = res.headers["x-hermes-session-id"];
      if (sid && typeof sid === "string") {
        sessionId = sid;
        announceSessionId(sessionId);
      }

      if (res.statusCode !== 200) {
        let errBody = "";
        res.on("data", (d) => {
          errBody += d.toString();
        });
        res.on("end", () => {
          finish(formatApiErrorResponse(res.statusCode || 0, errBody));
        });
        return;
      }

      let buffer = "";

      /** Parse an SSE block which may contain `event:` and `data:` lines. */
      function processSseBlock(block: string): boolean {
        let eventType = "";
        let dataLine = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            dataLine = line.slice(6);
          }
        }
        if (!dataLine) return false;
        if (eventType) {
          // Custom event (e.g. hermes.tool.progress) — never signals [DONE]
          processCustomEvent(eventType, dataLine);
          return false;
        }
        return processSseData(dataLine);
      }

      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          if (processSseBlock(part)) return;
        }
      });

      res.on("end", () => {
        if (buffer.trim()) {
          for (const part of buffer.split("\n\n")) {
            if (processSseBlock(part)) return;
          }
        }
        // Signal completion — even when no content was received
        if (!hasContent && !lastError) {
          probeRealError();
          return;
        }
        finish(hasContent ? undefined : lastError);
      });

      res.on("error", (err) => {
        if (err.message === "aborted" || err.name === "AbortError") return;
        finish(`Stream error: ${err.message}`);
      });
    },
  );

  req.on("error", (err) => {
    if (err.name === "AbortError") return;
    finish(`API request failed: ${err.message}`);
  });
  req.on("timeout", () => {
    finish(
      "API request timed out. Check the SSH tunnel and remote Aera Runtime gateway.",
    );
    req.destroy();
  });

  req.write(bodyBuf);
  req.end();

  return {
    abort: () => {
      controller.abort();
    },
  };
}

function apiHistory(
  history?: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  if (!history || history.length === 0) return [];
  return history.map((msg) => ({
    role:
      msg.role === "agent"
        ? "assistant"
        : msg.role === "assistant"
          ? "assistant"
          : "user",
    content: msg.content,
  }));
}

/** A successful Runs status is not a successful model response without output. */
export function shouldFallbackFromEmptyRunCompletion(
  hasActivity: boolean,
  output: string,
): boolean {
  return !hasActivity && output.trim().length === 0;
}

function postRunStop(
  apiUrl: string,
  profile: string | undefined,
  runId: string,
): void {
  const url = `${apiUrl}/v1/runs/${encodeURIComponent(runId)}/stop`;
  const requester = url.startsWith("https") ? https : http;
  const req = requester.request(url, {
    method: "POST",
    headers: getApiAuthHeaders(profile),
    timeout: 3000,
    agent: isLoopbackGatewayUrl(url)
      ? gatewayAgentFor(url, profile)
      : undefined,
  });
  req.on("error", () => undefined);
  req.on("timeout", () => req.destroy());
  req.end();
}

function sendMessageViaRuns(
  message: string,
  cb: ChatCallbacks,
  profile?: string,
  resumeSessionId?: string,
  history?: Array<{ role: string; content: string }>,
  attachments?: Attachment[],
  contextFolder?: string,
  override?: SessionModelOverride,
  envelope?: HermesConversationEnvelope,
): ChatHandle {
  const mc = effectiveModelConfig(profile, override);
  const controller = new AbortController();
  const apiUrl = getApiUrl(profile);
  const headersForAuth = getApiAuthHeaders(profile);
  const sessionId =
    resumeSessionId ||
    (headersForAuth.Authorization ? `desk-${Date.now()}-${randomUUID()}` : "");
  const ctxSystem = conversationSystemMessage(contextFolder, envelope);
  const bodyObj: Record<string, unknown> = {
    model: mc.model || "hermes-agent",
    input: message,
    conversation_history: apiHistory(history),
  };
  const reasoningEffort = reasoningEffortForProfile(profile);
  if (reasoningEffort) bodyObj.reasoning_effort = reasoningEffort;
  if (sessionId) bodyObj.session_id = sessionId;
  if (ctxSystem) bodyObj.instructions = ctxSystem.content;
  if (envelope?.toolPolicy) {
    bodyObj.aera_tool_policy = envelope.toolPolicy;
  }
  const bodyBuf = Buffer.from(JSON.stringify(bodyObj), "utf-8");
  const headers = getJsonApiHeaders(profile, bodyBuf);
  if (sessionId) {
    headers["X-Hermes-Session-Id"] = sessionId;
  }
  const resumingExistingSession = Boolean(resumeSessionId);
  let announcedSessionId = "";
  function announceSessionId(id: string): void {
    if (!id || announcedSessionId === id) return;
    announcedSessionId = id;
    cb.onSessionStarted?.(id);
  }
  if (resumingExistingSession) {
    announceSessionId(sessionId);
  }

  let runId = "";
  let hasContent = false;
  let hasRunActivity = false;
  let finished = false;
  let fallbackStarted = false;
  let startReq: http.ClientRequest | null = null;
  let eventsReq: http.ClientRequest | null = null;
  let fallbackHandle: ChatHandle | null = null;

  function finish(error?: string): void {
    if (finished || fallbackStarted) return;
    finished = true;
    if (error) {
      cb.onError(error);
    } else {
      cb.onDone(sessionId || undefined);
    }
  }

  function fallbackToChatCompletions(): void {
    if (finished || fallbackStarted) return;
    fallbackStarted = true;
    fallbackHandle = sendMessageViaApi(
      message,
      cb,
      profile,
      resumeSessionId,
      history,
      attachments,
      contextFolder,
      override,
      envelope,
    );
  }

  function stopRunAndFallback(): void {
    if (finished || fallbackStarted) return;
    if (runId) postRunStop(apiUrl, profile, runId);
    eventsReq?.destroy();
    fallbackToChatCompletions();
  }

  function handleRunEvent(raw: Record<string, unknown>): void {
    const eventName = typeof raw.event === "string" ? raw.event : "";
    if (eventName === "message.delta") {
      const delta = typeof raw.delta === "string" ? raw.delta : "";
      if (delta) {
        hasContent = true;
        hasRunActivity = true;
        announceSessionId(sessionId);
        cb.onChunk(delta);
      }
      return;
    }

    const reasoning = runEventReasoningText(raw);
    if (reasoning) {
      hasRunActivity = true;
      announceSessionId(sessionId);
      cb.onReasoningChunk?.(reasoning);
      return;
    }

    const toolEvent = chatToolEventFromRunEvent(raw);
    if (toolEvent) {
      hasRunActivity = true;
      announceSessionId(sessionId);
      if (cb.onToolEvent) {
        cb.onToolEvent(toolEvent);
      } else if (cb.onToolProgress) {
        cb.onToolProgress(chatToolProgressLabel(toolEvent));
      }
      return;
    }

    if (eventName === "run.completed") {
      const output = typeof raw.output === "string" ? raw.output : "";
      if (shouldFallbackFromEmptyRunCompletion(hasRunActivity, output)) {
        fallbackToChatCompletions();
        return;
      }
      if (output && !hasContent) {
        hasContent = true;
        hasRunActivity = true;
        announceSessionId(sessionId);
        cb.onChunk(output);
      }
      const usage = runCompletedUsage(raw);
      if (usage && cb.onUsage) cb.onUsage(usage);
      finish();
      return;
    }

    if (eventName === "run.failed") {
      const err =
        typeof raw.error === "string" && raw.error
          ? raw.error
          : "Aera Runtime run failed.";
      const failureCode = runFailureCode(raw);
      const reportedError = failureCode ? `${failureCode}: ${err}` : err;
      // A bounded provider-auth failure is a request-level result. Reporting
      // it directly prevents the empty-run compatibility fallback from
      // replaying the same rejected credential and keeps the healthy Gateway
      // alive for the next turn.
      if (failureCode) {
        finish(reportedError);
        return;
      }
      if (shouldFallbackFromRunFailure(raw, hasRunActivity)) {
        fallbackToChatCompletions();
        return;
      }
      finish(reportedError);
      return;
    }

    if (eventName === "run.cancelled") {
      finish(hasContent ? undefined : "Aera Runtime run was cancelled.");
      return;
    }

    if (eventName === "approval.request") {
      // The current renderer's approval controls are wired to the legacy chat
      // flow and only appear after a response finishes. A run pauses before it
      // can finish, so fall back to the existing path instead of deadlocking
      // the user on a hidden approval request.
      stopRunAndFallback();
    }
  }

  function openEventStream(nextRunId: string): void {
    const eventsUrl = `${apiUrl}/v1/runs/${encodeURIComponent(nextRunId)}/events`;
    const requester = eventsUrl.startsWith("https") ? https : http;
    eventsReq = requester.request(
      eventsUrl,
      {
        method: "GET",
        headers: getApiAuthHeaders(profile),
        signal: controller.signal,
        timeout: 120000,
        agent: isLoopbackGatewayUrl(eventsUrl)
          ? gatewayAgentFor(eventsUrl, profile)
          : undefined,
      },
      (res) => {
        if (res.statusCode !== 200) {
          stopRunAndFallback();
          return;
        }
        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            const parsed = parseRunSseBlock(part);
            if (!parsed || !parsed.data || parsed.data.startsWith(":")) {
              continue;
            }
            try {
              handleRunEvent(
                JSON.parse(parsed.data) as Record<string, unknown>,
              );
            } catch {
              /* malformed run event — skip */
            }
          }
        });
        res.on("end", () => {
          if (buffer.trim()) {
            const parsed = parseRunSseBlock(buffer);
            if (parsed?.data) {
              try {
                handleRunEvent(
                  JSON.parse(parsed.data) as Record<string, unknown>,
                );
              } catch {
                /* malformed run event — skip */
              }
            }
          }
          if (!finished && !fallbackStarted) {
            if (!hasRunActivity) {
              stopRunAndFallback();
            } else {
              finish();
            }
          }
        });
      },
    );
    eventsReq.on("error", (err) => {
      if (err.name === "AbortError" || finished) return;
      if (!hasRunActivity) {
        stopRunAndFallback();
        return;
      }
      finish(`Run event stream failed: ${err.message}`);
    });
    eventsReq.on("timeout", () => {
      eventsReq?.destroy();
      if (!hasRunActivity) {
        stopRunAndFallback();
        return;
      }
      finish("Run event stream timed out.");
    });
    eventsReq.end();
  }

  const startUrl = `${apiUrl}/v1/runs`;
  const requester = startUrl.startsWith("https") ? https : http;
  startReq = requester.request(
    startUrl,
    {
      method: "POST",
      headers,
      signal: controller.signal,
      timeout: 30000,
      agent: isLoopbackGatewayUrl(startUrl)
        ? gatewayAgentFor(startUrl, profile)
        : undefined,
    },
    (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk.toString();
      });
      res.on("end", () => {
        if (res.statusCode !== 202 && res.statusCode !== 200) {
          fallbackToChatCompletions();
          return;
        }
        try {
          const parsed = JSON.parse(raw) as { run_id?: unknown };
          runId = typeof parsed.run_id === "string" ? parsed.run_id : "";
        } catch {
          runId = "";
        }
        if (!runId) {
          fallbackToChatCompletions();
          return;
        }
        openEventStream(runId);
      });
    },
  );
  startReq.on("error", (err) => {
    if (err.name === "AbortError" || finished) return;
    fallbackToChatCompletions();
  });
  startReq.on("timeout", () => {
    startReq?.destroy();
    fallbackToChatCompletions();
  });
  startReq.write(bodyBuf);
  startReq.end();

  return {
    abort: () => {
      if (finished && !fallbackStarted) return;
      controller.abort();
      startReq?.destroy();
      eventsReq?.destroy();
      fallbackHandle?.abort();
      if (runId) postRunStop(apiUrl, profile, runId);
    },
  };
}

async function sendMessageViaTuiGateway(
  message: string,
  cb: ChatCallbacks,
  profile?: string,
  resumeSessionId?: string,
  history?: Array<{ role: string; content: string }>,
  contextFolder?: string,
): Promise<ChatHandle> {
  const client = getTuiGatewayClient(profile);
  let activeSessionId = "";
  let storedSessionId = resumeSessionId || "";
  let finished = false;
  let hasGatewayOutput = false;
  let hasSessionInfo = false;
  let streamedText = "";
  let fallbackAborted = false;
  let fallbackHandle: ChatHandle | null = null;
  let fallbackStarted = false;
  let promptSubmitted = false;
  let cleanup = (): void => undefined;
  // request_id of an in-flight clarify question, if the agent is awaiting an
  // answer. Cleared on turn end so an abandoned turn leaks no stale resolver.
  let pendingClarifyId: string | null = null;

  function finish(error?: string): void {
    if (finished) return;
    finished = true;
    if (pendingClarifyId) {
      clearPendingClarify(pendingClarifyId);
      pendingClarifyId = null;
    }
    cleanup();
    if (error) {
      cb.onError(error);
    } else {
      cb.onDone(storedSessionId || undefined);
    }
  }

  function cancel(): void {
    if (finished) return;
    finished = true;
    if (pendingClarifyId) {
      clearPendingClarify(pendingClarifyId);
      pendingClarifyId = null;
    }
    cleanup();
  }

  function startApiFallback(reason: string): void {
    if (finished || fallbackStarted) return;
    fallbackStarted = true;
    cleanup();
    client.stop();
    console.warn(
      "[chat] Aera Runtime gateway stream failed before output; falling back to API stream:",
      reason,
    );
    void sendMessageViaNonGatewayApi(
      message,
      cb,
      profile,
      resumeSessionId,
      history,
      undefined,
      contextFolder,
    )
      .then((handle) => {
        fallbackHandle = handle;
        if (fallbackAborted) handle.abort();
      })
      .catch((error) => {
        finish(error instanceof Error ? error.message : String(error));
      });
  }

  cleanup = client.onEvent((event) => {
    if (event.session_id && event.session_id !== activeSessionId) return;

    const delta = gatewayMessageDelta(event);
    if (delta) {
      streamedText += delta;
      hasGatewayOutput = true;
      cb.onChunk(delta);
      return;
    }

    const reasoning = gatewayReasoningText(event);
    if (reasoning && cb.onReasoningChunk) {
      hasGatewayOutput = true;
      cb.onReasoningChunk(reasoning);
      return;
    }

    const toolEvent = gatewayToolEvent(event);
    if (toolEvent) {
      hasGatewayOutput = true;
      if (cb.onToolEvent) {
        cb.onToolEvent(toolEvent);
      } else if (cb.onToolProgress) {
        cb.onToolProgress(chatToolProgressLabel(toolEvent));
      }
      return;
    }

    if (event.type === "message.complete") {
      const finalText = gatewayMessageCompleteText(event);
      const completionSuffix = gatewayCompletionSuffix(streamedText, finalText);
      if (completionSuffix) {
        streamedText += completionSuffix;
        cb.onChunk(completionSuffix);
      }
      const usage = gatewayUsage(event);
      if (usage && cb.onUsage) cb.onUsage(usage);
      finish();
      return;
    }

    if (event.type === "error") {
      if (!promptSubmitted) return;
      const error =
        typeof event.payload?.message === "string"
          ? event.payload.message
          : "Aera Runtime gateway stream reported an error.";
      if (!hasGatewayOutput) {
        startApiFallback(error);
        return;
      }
      finish(error);
      return;
    }

    if (event.type === "approval.request") {
      // Match the existing local chat posture: Hermes One does not expose a
      // mid-stream approval dialog, so answer the dashboard protocol once and
      // keep the transcript focused on the resulting tool call/result events.
      void client
        .request(
          "approval.respond",
          {
            session_id: activeSessionId,
            choice: "once",
            all: false,
          },
          30_000,
        )
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          if (!hasGatewayOutput) {
            startApiFallback(message);
            return;
          }
          finish(message);
        });
      return;
    }

    if (event.type === "clarify.request") {
      const requestId =
        typeof event.payload?.request_id === "string"
          ? event.payload.request_id
          : "";
      if (!requestId) {
        // No id to answer — fall back to the legacy interrupt so the turn ends
        // cleanly rather than hanging on a question we can never resolve.
        void client
          .request("session.interrupt", { session_id: activeSessionId }, 5_000)
          .catch(() => undefined);
        finish(
          "Aera Runtime requested clarify input, but the gateway provided no request_id to answer.",
        );
        return;
      }
      pendingClarifyId = requestId;
      // The resolver closes over the live gateway client; the renderer's answer
      // (via the clarify-respond IPC handler) forwards it to clarify.respond.
      registerPendingClarify(requestId, (answer: string) => {
        if (pendingClarifyId === requestId) pendingClarifyId = null;
        void client
          .request(
            "clarify.respond",
            { request_id: requestId, answer },
            300_000,
          )
          .catch((error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            if (!hasGatewayOutput) {
              startApiFallback(message);
              return;
            }
            finish(message);
          });
      });
      const payload = event.payload as
        | { question?: string; prompt?: string; choices?: unknown }
        | undefined;
      cb.onClarify?.({
        requestId,
        question: String(payload?.question ?? payload?.prompt ?? ""),
        choices: Array.isArray(payload?.choices)
          ? payload.choices.map((c) => String(c))
          : [],
      });
      return;
    }

    if (event.type === "sudo.request" || event.type === "secret.request") {
      const isSudo = event.type === "sudo.request";
      const requestId =
        typeof event.payload?.request_id === "string"
          ? event.payload.request_id
          : "";
      if (!requestId) {
        void client
          .request("session.interrupt", { session_id: activeSessionId }, 5_000)
          .catch(() => undefined);
        finish(
          `Aera Runtime requested ${event.type.replace(".request", "")} input, but the gateway provided no request_id to answer.`,
        );
        return;
      }
      // A sudo password / secret value is sensitive — collect it in the
      // hardened askpass modal (never the chat transcript) and forward it to
      // the gateway. Cancel maps to "" (a safe skip the gateway handles).
      //
      // For secret.request: try the configured security provider first. If the
      // vault already holds the key, answer silently without prompting the user.
      const payload = event.payload as
        | { prompt?: string; env_var?: string }
        | undefined;
      const envVar = String(payload?.env_var ?? "");

      // Vault-first resolution for secret.request: attempt a provider lookup
      // before falling back to the interactive modal. sudo.request always needs
      // an interactive password — no vault lookup applies.
      const vaultValue = !isSudo && envVar ? getSecret(envVar, profile) : null;

      const collect: Promise<string> =
        vaultValue != null
          ? Promise.resolve(vaultValue)
          : isSudo
            ? promptSudoPassword()
            : promptSecretValue(envVar, String(payload?.prompt ?? ""));

      void collect
        .then((answer) => {
          if (finished) return; // turn was cancelled while modal was open
          const method = isSudo ? "sudo.respond" : "secret.respond";
          const params = isSudo
            ? { request_id: requestId, password: answer }
            : { request_id: requestId, value: answer };
          return client.request(method, params, 300_000);
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          if (!hasGatewayOutput) {
            startApiFallback(message);
            return;
          }
          finish(message);
        });
      return;
    }
  });

  try {
    if (resumeSessionId) {
      const resumed = await client.request<{
        info?: unknown;
        resumed?: string;
        session_id?: string;
      }>("session.resume", {
        cols: 96,
        session_id: resumeSessionId,
      });
      activeSessionId = String(resumed.session_id || "");
      storedSessionId = String(resumed.resumed || resumeSessionId);
      hasSessionInfo = !!resumed.info;
    } else {
      const created = await client.request<{
        info?: unknown;
        session_id?: string;
        stored_session_id?: string;
      }>("session.create", {
        cols: 96,
        ...(contextFolder ? { cwd: contextFolder } : {}),
        ...(history?.length ? { messages: apiHistory(history) } : {}),
      });
      activeSessionId = String(created.session_id || "");
      storedSessionId = String(created.stored_session_id || activeSessionId);
      hasSessionInfo = !!created.info;
    }

    if (!activeSessionId) {
      throw new Error("Aera Runtime gateway did not return a session id");
    }

    if (!hasSessionInfo) {
      await waitForGatewayEvent(
        client,
        (event) =>
          event.type === "session.info" && event.session_id === activeSessionId,
        120_000,
      );
    }

    promptSubmitted = true;
    await client.request("prompt.submit", {
      session_id: activeSessionId,
      text: message,
    });
  } catch (error) {
    cleanup();
    if (!promptSubmitted) {
      client.stop();
    }
    throw error;
  }

  return {
    abort: () => {
      if (finished) return;
      if (fallbackStarted) {
        fallbackAborted = true;
        fallbackHandle?.abort();
        cancel();
        return;
      }
      void client
        .request("session.interrupt", { session_id: activeSessionId }, 5_000)
        .catch(() => undefined);
      cancel();
    },
  };
}

// ────────────────────────────────────────────────────
//  CLI fallback (slow path — spawns process)
// ────────────────────────────────────────────────────

const NOISE_PATTERNS = [/^[╭╰│╮╯─┌┐└┘┤├┬┴┼]/, /⚕\s*Hermes/];
const CLI_COMPAT_PROVIDER_OVERRIDE: Record<string, string> = {
  aimlapi: "custom",
};

type ModelConfig = ReturnType<typeof getModelConfig>;

/**
 * Overlay a session-scoped model override on top of the persisted config.yaml
 * model config. Non-empty override fields win; empty/absent fields fall back to
 * the persisted value. The result drives request routing for a single turn
 * without ever touching config.yaml (the global default is preserved — #688).
 */
function effectiveModelConfig(
  profile: string | undefined,
  override?: SessionModelOverride,
): ModelConfig {
  const mc = getModelConfig(profile);
  if (!override) return mc;
  return {
    provider: override.provider || mc.provider,
    model: override.model || mc.model,
    // baseUrl is intentionally taken verbatim from the override (including an
    // empty string) so a switch to a built-in provider clears a stale custom
    // URL; only fall back to the persisted value when the override omits it.
    baseUrl: override.baseUrl !== undefined ? override.baseUrl : mc.baseUrl,
  };
}

function hasAttachments(attachments?: Attachment[]): boolean {
  return (attachments?.length ?? 0) > 0;
}

/**
 * Legacy CLI is only a safe session-override escape hatch for text-only turns.
 * Upstream desktop applies `/model <model> --provider <provider>` on the active
 * gateway session, then attaches media and submits through that same session.
 * If we force an attachment turn through the CLI, images/path refs are silently
 * dropped by `sendMessageViaCli`, so leave attachment turns on the gateway/API
 * path whenever it is available.
 */
export function shouldForceCliForSessionOverride(
  persisted: ModelConfig,
  effective: ModelConfig,
  override: SessionModelOverride | undefined,
  attachments?: Attachment[],
): boolean {
  if (hasAttachments(attachments)) return false;
  const overrideChangesRouting =
    !!override &&
    (effective.provider !== persisted.provider ||
      effective.baseUrl !== persisted.baseUrl);
  return (
    !!CLI_COMPAT_PROVIDER_OVERRIDE[effective.provider] || overrideChangesRouting
  );
}

function sendMessageViaCli(
  message: string,
  cb: ChatCallbacks,
  profile?: string,
  resumeSessionId?: string,
  attachments?: Attachment[],
  override?: SessionModelOverride,
): ChatHandle {
  const invocation = getRuntimeInvocation();
  if (!invocation) {
    cb.onError("Aera Runtime is not prepared.");
    return { abort: () => undefined };
  }

  // CLI fallback can't pipe multimodal content; inline text-file attachments
  // and ignore images.  The gateway is the supported attachment path; this
  // is only hit when the API server isn't reachable.
  if (attachments && attachments.length > 0) {
    const textFiles = attachments.filter(
      (a) => a.kind === "text-file" && typeof a.text === "string",
    );
    if (textFiles.length > 0) {
      const wrapped = textFiles
        .map(
          (f) =>
            `<file name="${escapeXmlAttr(f.name)}" mime="${escapeXmlAttr(f.mime || "text/plain")}">\n${f.text}\n</file>`,
        )
        .join("\n\n");
      message = message.trim() ? `${message}\n\n${wrapped}` : wrapped;
    }
  }
  // Effective config = persisted config.yaml overlaid with the session
  // override. Everything downstream (provider routing, base_url env, key
  // resolution, apiMode lookup) reads from `mc`, so the override drives the
  // whole CLI invocation without touching config.yaml.
  const mc = effectiveModelConfig(profile, override);
  const baseMc = getModelConfig(profile);
  const overrideChangesRouting =
    !!override &&
    (mc.provider !== baseMc.provider || mc.baseUrl !== baseMc.baseUrl);
  const profileEnv = readEnv(profile);

  const subArgs: string[] = [];
  if (profile && profile !== "default") {
    subArgs.push("-p", profile);
  }
  subArgs.push("chat", "-q", message, "-Q", "--source", "desktop");

  if (resumeSessionId) {
    subArgs.push("--resume", resumeSessionId);
  }

  if (mc.model) {
    subArgs.push("-m", mc.model);
  }

  const cliProvider = CLI_COMPAT_PROVIDER_OVERRIDE[mc.provider];
  if (cliProvider) {
    subArgs.push("--provider", cliProvider);
  } else if (overrideChangesRouting && mc.provider && mc.provider !== "auto") {
    // A session override that switches to a named provider (e.g. gemini) must
    // select it explicitly — otherwise the CLI would infer the provider from
    // the now-stale config/env and route to the wrong host.
    subArgs.push("--provider", mc.provider);
  }
  const args = invocation.cliArgs(subArgs);

  const env = invocation.environment({
    ...(process.env as Record<string, string>),
    PATH: getEnhancedPath(),
    HOME: homedir(),
    HERMES_HOME: HERMES_HOME,
    PYTHONUNBUFFERED: "1",
  }) as Record<string, string>;

  // Inject all API keys from the profile .env so the CLI can access them.
  // The built-in remote OpenAI-compatible providers (DeepSeek, Together,
  // Fireworks, Cerebras, Mistral) are listed here too — without them the
  // agent has no way to see the user-configured key when the user picked
  // the built-in provider entry rather than a `custom` entry, and the
  // upstream fallback chain then misroutes the request (see #260 / the
  // `pickAutoApiKeyForCustomProvider` workaround in config.ts).
  const KNOWN_API_KEYS = [
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "OLLAMA_API_KEY",
    "AIMLAPI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
    "DEEPSEEK_API_KEY",
    "TOGETHER_API_KEY",
    "FIREWORKS_API_KEY",
    "CEREBRAS_API_KEY",
    "MISTRAL_API_KEY",
    "PERPLEXITY_API_KEY",
    "XIAOMI_API_KEY",
    "GLM_API_KEY",
    "KIMI_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_CN_API_KEY",
    "HF_TOKEN",
    "EXA_API_KEY",
    "PARALLEL_API_KEY",
    "TAVILY_API_KEY",
    "FIRECRAWL_API_KEY",
    "FAL_KEY",
    "HONCHO_API_KEY",
    "BROWSERBASE_API_KEY",
    "BROWSERBASE_PROJECT_ID",
    "VOICE_TOOLS_OPENAI_KEY",
    "TINKER_API_KEY",
    "WANDB_API_KEY",
  ];
  // Resolve the configured secrets provider's enumerable secrets ONCE (not
  // per-key): a `command` backend would otherwise spawn the helper ~30 times
  // synchronously here, freezing the main process if the helper blocks on an
  // unlock prompt. list() runs the helper at most once. A bare-value helper that
  // can't enumerate returns {} — those users resolve a key via the targeted
  // getSecret() path elsewhere, never this broadcast loop (which would otherwise
  // spray one secret across every vendor key name).
  const providerSecrets = providerListSafe(profile);
  for (const key of KNOWN_API_KEYS) {
    if (env[key]) continue; // already present (e.g. from process.env spread)
    // Prefer the .env file value, then the provider's enumerated secrets, so a
    // vault-resolved key reaches the agent without being written to plaintext.
    const value = profileEnv[key] || providerSecrets[key];
    if (value) env[key] = value;
  }

  const isCustomEndpoint = OPENAI_COMPAT_PROVIDERS.has(mc.provider);
  if (isCustomEndpoint && mc.baseUrl) {
    // Check if this model has an explicit apiMode from custom_providers
    let modelApiMode: string | null = null;
    try {
      const modelEntry = readModels().find(
        (m) => m.baseUrl === mc.baseUrl && m.model === mc.model,
      );
      if (modelEntry) modelApiMode = modelEntry.apiMode || null;
    } catch {
      /* ignore */
    }
    const isAnthropicProtocol = modelApiMode === "anthropic_messages";
    if (isAnthropicProtocol) {
      env.HERMES_INFERENCE_PROVIDER = "anthropic";
      env.ANTHROPIC_BASE_URL = mc.baseUrl.replace(/\/+$/, "");
    } else {
      env.HERMES_INFERENCE_PROVIDER = "custom";
      env.OPENAI_BASE_URL = mc.baseUrl.replace(/\/+$/, "");
      if (cliProvider === "custom") {
        env.CUSTOM_BASE_URL = mc.baseUrl.replace(/\/+$/, "");
      }
    }

    // Find the host-derived env-var name (if any). Used both for resolving
    // the key here, AND for writing it back into the child env below so
    // both old and new engines locate the same value:
    //
    //  - Old engine (≤ v0.14.0) routes via OPENAI_API_KEY + OPENAI_BASE_URL.
    //  - Current upstream main refuses to forward OPENAI_API_KEY to a
    //    non-openai host and instead derives <VENDOR>_API_KEY from the
    //    URL host (see hermes_cli/runtime_provider.py::_host_derived_api_key).
    //    Without the host-derived var in the child env, chat against a
    //    custom provider on api.deepseek.com / api.groq.com / etc. falls
    //    through to "no-key-required" and 401s.
    //
    // Writing both env-var forms is the additive compat strategy — each
    // engine reads the form it knows; the unused one is dead weight.
    const hostDerivedEnvKey = hostDerivedEnvKeyForUrl(mc.baseUrl);
    const runtimeHostDerivedEnvKey = runtimeHostDerivedEnvKeyForUrl(mc.baseUrl);

    // Resolve the right API key: host-derived first, then custom provider
    // entry from models.json, then CUSTOM_API_KEY / OPENAI_API_KEY fallback.
    let resolvedKey = "";
    if (hostDerivedEnvKey) {
      resolvedKey =
        profileEnv[hostDerivedEnvKey] || env[hostDerivedEnvKey] || "";
    }
    if (!resolvedKey) {
      // Try custom provider auto-generated key from models.json
      try {
        const models = readModels();
        const matching = models.find((m) => m.baseUrl === mc.baseUrl);
        if (matching) {
          // Key off the provider label (stable across all of a named custom
          // provider's models) when present, else the model's own name.
          const envKey2 = customProviderEnvKey(
            matching.providerLabel || matching.name,
          );
          resolvedKey = profileEnv[envKey2] || env[envKey2] || "";
        }
      } catch {
        /* ignore */
      }
      if (!resolvedKey) {
        resolvedKey =
          profileEnv.CUSTOM_API_KEY ||
          env.CUSTOM_API_KEY ||
          profileEnv.OPENAI_API_KEY ||
          env.OPENAI_API_KEY ||
          "";
      }
    }
    // Local servers (localhost/127.0.0.1) don't need a real key
    if (!resolvedKey && /localhost|127\.0\.0\.1/i.test(mc.baseUrl)) {
      resolvedKey = "no-key-required";
    }
    if (isAnthropicProtocol) {
      env.ANTHROPIC_API_KEY = resolvedKey || "no-key-required";
    } else {
      env.OPENAI_API_KEY = resolvedKey || "no-key-required";
    }

    // Forward-compat with upstream main: also write the host-derived
    // env var so `_host_derived_api_key` finds it. Only when the URL
    // matches a known vendor (NOT for generic local LLMs), and only
    // when we have a real key — never propagate "no-key-required" to
    // a vendor-scoped slot, and never overwrite OPENAI_API_KEY /
    // ANTHROPIC_API_KEY through this path (they're handled above).
    const forwardedHostEnvKey = runtimeHostDerivedEnvKey || hostDerivedEnvKey;
    if (
      forwardedHostEnvKey &&
      forwardedHostEnvKey !== "OPENAI_API_KEY" &&
      forwardedHostEnvKey !== "ANTHROPIC_API_KEY" &&
      resolvedKey &&
      resolvedKey !== "no-key-required"
    ) {
      env[forwardedHostEnvKey] = resolvedKey;
    }

    if (shouldPruneOpenRouterApiKey(hostDerivedEnvKey)) {
      delete env.OPENROUTER_API_KEY;
    }
    delete env.ANTHROPIC_TOKEN;
    delete env.OPENROUTER_BASE_URL;
  }

  const proc = spawn(invocation.python, args, {
    cwd: invocation.workingDirectory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    ...HIDDEN_SUBPROCESS_OPTIONS,
  });

  let hasOutput = false;
  let capturedSessionId = "";
  let outputBuffer = "";

  function captureSessionId(text: string): void {
    const sidMatch = text.match(/session_id:\s*(\S+)/);
    if (sidMatch) capturedSessionId = sidMatch[1];
  }

  function processOutput(raw: Buffer): void {
    const text = stripAnsi(raw.toString());
    outputBuffer += text;

    captureSessionId(outputBuffer);

    const cleaned = text.replace(/session_id:\s*\S+\n?/g, "");
    const lines = cleaned.split("\n");
    const result: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (t && NOISE_PATTERNS.some((p) => p.test(t))) continue;
      result.push(line);
    }

    const output = result.join("\n");
    if (output) {
      hasOutput = true;
      cb.onChunk(output);
    }
  }

  proc.stdout?.on("data", processOutput);

  let stderrBuffer = "";
  proc.stderr?.on("data", (data: Buffer) => {
    const text = stripAnsi(data.toString());
    captureSessionId(text);
    if (
      !text.trim() ||
      text.includes("UserWarning") ||
      text.includes("FutureWarning")
    ) {
      return;
    }
    // Forward errors visibly to the chat
    if (
      /❌|⚠️|Error|Traceback|error|failed|denied|unauthorized|invalid/i.test(
        text,
      )
    ) {
      hasOutput = true;
      cb.onChunk(text);
    } else {
      // Buffer other stderr for reporting on non-zero exit
      stderrBuffer += text;
    }
  });

  proc.on("close", (code) => {
    if (code === 0 || hasOutput) {
      cb.onDone(capturedSessionId || undefined);
    } else {
      const detail = stderrBuffer.trim();
      cb.onError(
        detail
          ? `Aera Runtime exited with code ${code}: ${detail}`
          : `Aera Runtime exited with code ${code}. Check your model configuration and API key.`,
      );
    }
  });

  proc.on("error", (err) => {
    cb.onError(err.message);
  });

  return {
    abort: () => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 3000);
    },
  };
}

// ────────────────────────────────────────────────────
//  Public API: auto-routes to HTTP API or CLI fallback
// ────────────────────────────────────────────────────

let apiServerAvailable: boolean | null = null; // cached after first check

function setApiCacheFor(
  profile: string | undefined,
  value: boolean | null,
): void {
  if (profileKey(profile) === profileKey(undefined)) {
    apiServerAvailable = value;
  }
}

function isLocalApiTransportError(error: string): boolean {
  return /^API request failed:.*(?:\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE)\b|socket hang up)/i.test(
    error,
  );
}

export type ChatErrorRecoveryAction =
  | "report_only"
  | "retry_transport"
  | "restart_gateway";

/**
 * Keep provider authentication failures separate from local Gateway failures.
 * The Runtime includes this bounded code in its HTTP/SSE error envelope; a
 * provider rejecting a credential does not mean the healthy local Gateway
 * needs to be restarted, and the failed turn must never be replayed.
 */
export function classifyChatErrorRecovery(
  error: string,
): ChatErrorRecoveryAction {
  if (
    /(^|[^a-z0-9_])provider_authentication_rejected([^a-z0-9_]|$)/i.test(error)
  ) {
    return "report_only";
  }
  if (isLocalApiTransportError(error)) return "retry_transport";
  return "restart_gateway";
}

function formatApiErrorResponse(statusCode: number, rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const error =
      parsed.error && typeof parsed.error === "object"
        ? (parsed.error as Record<string, unknown>)
        : null;
    const message =
      typeof error?.message === "string" && error.message
        ? error.message
        : `API error ${statusCode}`;
    const code =
      error?.code === "provider_authentication_rejected" ? error.code : null;
    return code ? `${code}: ${message}` : message;
  } catch {
    return rawBody
      ? `API server returned ${statusCode}: ${rawBody.slice(0, 200)}`
      : `API error ${statusCode}`;
  }
}

async function sendMessageViaNonGatewayApi(
  message: string,
  cb: ChatCallbacks,
  profile?: string,
  resumeSessionId?: string,
  history?: Array<{ role: string; content: string }>,
  attachments?: Attachment[],
  contextFolder?: string,
  override?: SessionModelOverride,
  envelope?: HermesConversationEnvelope,
): Promise<ChatHandle> {
  const approvalCommand = /^\/(?:approve|deny)\b/i.test(message.trim());
  if (!attachments?.length && !approvalCommand) {
    const capabilities = await getApiCapabilities(profile);
    if (supportsHermesRunsTransport(capabilities)) {
      return sendMessageViaRuns(
        message,
        cb,
        profile,
        resumeSessionId,
        history,
        attachments,
        contextFolder,
        override,
        envelope,
      );
    }
  }

  return sendMessageViaApi(
    message,
    cb,
    profile,
    resumeSessionId,
    history,
    attachments,
    contextFolder,
    override,
    envelope,
  );
}

async function sendMessageViaBestApi(
  message: string,
  cb: ChatCallbacks,
  profile?: string,
  resumeSessionId?: string,
  history?: Array<{ role: string; content: string }>,
  attachments?: Attachment[],
  contextFolder?: string,
  override?: SessionModelOverride,
  envelope?: HermesConversationEnvelope,
): Promise<ChatHandle> {
  const approvalCommand = /^\/(?:approve|deny)\b/i.test(message.trim());
  // Skip the TUI gateway when a session-scoped model override is active — the
  // TUI gateway reads its model from config.yaml and has no per-request
  // override mechanism. The API path below already honours the override.
  if (
    shouldUseTuiGatewayClient() &&
    !isRemoteMode() &&
    !attachments?.length &&
    !approvalCommand &&
    !override &&
    !envelope?.requireBoundApiTransport
  ) {
    try {
      return await sendMessageViaTuiGateway(
        message,
        cb,
        profile,
        resumeSessionId,
        history,
        contextFolder,
      );
    } catch (error) {
      console.warn(
        "[chat] Aera Runtime gateway stream unavailable; falling back to API stream:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return sendMessageViaNonGatewayApi(
    message,
    cb,
    profile,
    resumeSessionId,
    history,
    attachments,
    contextFolder,
    override,
    envelope,
  );
}

async function sendMessageViaBestApiWithLocalRecovery(
  message: string,
  cb: ChatCallbacks,
  profile?: string,
  resumeSessionId?: string,
  history?: Array<{ role: string; content: string }>,
  attachments?: Attachment[],
  contextFolder?: string,
  override?: SessionModelOverride,
  envelope?: HermesConversationEnvelope,
): Promise<ChatHandle> {
  let aborted = false;
  let retrying = false;
  let sawOutput = false;
  let settled = false;
  let activeHandle: ChatHandle | null = null;

  const recoverAfterPartialOutput = (error: string): void => {
    if (aborted || retrying || settled) return;

    retrying = true;
    activeHandle?.abort();
    setApiCacheFor(profile, false);
    settled = true;
    cb.onError(error);

    void startGatewayWithRecovery(profile)
      .then((recovered) => {
        setApiCacheFor(profile, recovered);
      })
      .catch(() => {
        setApiCacheFor(profile, false);
      });
  };

  const recoverAndRetry = async (): Promise<void> => {
    if (aborted || retrying || settled) return;

    retrying = true;
    activeHandle?.abort();
    setApiCacheFor(profile, false);
    const recovered = await startGatewayWithRecovery(
      profile,
      envelope?.requireBoundApiTransport ? 30_000 : 8_000,
    );
    if (aborted) return;

    if (recovered) {
      setApiCacheFor(profile, true);
      activeHandle = await sendMessageViaBestApi(
        message,
        cb,
        profile,
        resumeSessionId,
        history,
        attachments,
        contextFolder,
        override,
        envelope,
      );
      return;
    }

    if (envelope?.requireBoundApiTransport) {
      settled = true;
      cb.onError(BOUND_API_TRANSPORT_UNAVAILABLE);
      return;
    }

    activeHandle = await sendMessageViaCli(
      message,
      cb,
      profile,
      resumeSessionId,
      attachments,
      override,
    );
  };

  const recoverAndFail = async (error: string): Promise<void> => {
    if (aborted || retrying || settled) return;

    retrying = true;
    activeHandle?.abort();
    setApiCacheFor(profile, false);
    const recovered = await startGatewayWithRecovery(profile);
    if (aborted) return;

    setApiCacheFor(profile, recovered);
    settled = true;
    cb.onError(error);
  };

  const handle: ChatHandle = {
    abort: () => {
      aborted = true;
      activeHandle?.abort();
    },
  };

  const callbacks: ChatCallbacks = {
    ...cb,
    onChunk: (text) => {
      sawOutput = true;
      cb.onChunk(text);
    },
    onReasoningChunk: cb.onReasoningChunk
      ? (text) => {
          sawOutput = true;
          cb.onReasoningChunk?.(text);
        }
      : undefined,
    onToolProgress: cb.onToolProgress
      ? (tool) => {
          sawOutput = true;
          cb.onToolProgress?.(tool);
        }
      : undefined,
    onToolEvent: cb.onToolEvent
      ? (event) => {
          sawOutput = true;
          cb.onToolEvent?.(event);
        }
      : undefined,
    onUsage: cb.onUsage,
    onSessionStarted: cb.onSessionStarted,
    onDone: (sessionId) => {
      settled = true;
      cb.onDone(sessionId);
    },
    onError: (error) => {
      // Provider authentication is a request-level failure. Do not mark a
      // healthy Gateway unavailable, restart it, or replay the turn (whether
      // or not the provider emitted partial output).
      if (classifyChatErrorRecovery(error) === "report_only") {
        settled = true;
        cb.onError(error);
        return;
      }

      if (sawOutput) {
        recoverAfterPartialOutput(error);
        return;
      }

      if (isLocalApiTransportError(error)) {
        void recoverAndRetry();
        return;
      }

      void recoverAndFail(error);
    },
  };

  activeHandle = await sendMessageViaBestApi(
    message,
    callbacks,
    profile,
    resumeSessionId,
    history,
    attachments,
    contextFolder,
    override,
    envelope,
  );

  return handle;
}

export async function sendMessage(
  message: string,
  cb: ChatCallbacks,
  profile?: string,
  resumeSessionId?: string,
  history?: Array<{ role: string; content: string }>,
  attachments?: Attachment[],
  contextFolder?: string,
  override?: SessionModelOverride,
  envelope?: HermesConversationEnvelope,
  execution?: HermesAgentModelExecution,
): Promise<ChatHandle> {
  ensureInitialized();

  const needsBoundCapabilities = Boolean(
    envelope?.requireBoundApiTransport &&
    (envelope.toolPolicy || execution?.routeMode === "dynamic"),
  );
  const boundCapabilities = needsBoundCapabilities
    ? await prepareBoundAgentCapabilities(profile)
    : null;
  const boundTransportReady = needsBoundCapabilities ? true : null;
  const capabilities = needsBoundCapabilities
    ? boundCapabilities
    : envelope?.toolPolicy || execution?.routeMode === "dynamic"
      ? await getApiCapabilities(profile)
      : null;
  if (envelope?.toolPolicy) {
    assertHermesAgentToolPolicySupported(capabilities);
  }

  // A candidate Agent segment must never silently fall back to a different
  // transport or replay the prompt. Dynamic routes additionally require an
  // explicit Runtime capability before their short-lived route is serialized.
  if (execution?.routeMode === "dynamic") {
    assertHermesAgentModelRouteSupported(capabilities);
    return sendMessageViaApi(
      message,
      cb,
      profile,
      resumeSessionId,
      history,
      attachments,
      contextFolder,
      override,
      envelope,
      execution,
    );
  }
  if (execution?.disableTransportReplay) {
    return sendMessageViaApi(
      message,
      cb,
      profile,
      resumeSessionId,
      history,
      attachments,
      contextFolder,
      override,
      envelope,
      execution,
    );
  }

  // Remote mode: always use API, no CLI fallback. Cross-provider session
  // overrides are limited to the model string here (no CLI transport remotely).
  if (isRemoteMode()) {
    return sendMessageViaBestApi(
      message,
      cb,
      profile,
      resumeSessionId,
      history,
      attachments,
      contextFolder,
      override,
      envelope,
    );
  }

  // Runtime-bound Agent turns are profile-specific and fail closed. Never
  // trust the process-wide readiness cache here: it may describe the profile
  // that was active immediately before this Agent was selected. That stale
  // `true` was most visible on image turns because attachments cannot use the
  // text-only CLI fallback. Probe the bound profile directly and give a new or
  // slow-starting profile the full recovery window before sending.
  if (envelope?.requireBoundApiTransport) {
    const ready =
      boundTransportReady ??
      ((await isApiServerReady(profile)) ||
        (await startGatewayWithRecovery(profile, 30_000)));
    setApiCacheFor(profile, ready);
    if (!ready) {
      throw new Error(BOUND_API_TRANSPORT_UNAVAILABLE);
    }
    return sendMessageViaBestApiWithLocalRecovery(
      message,
      cb,
      profile,
      resumeSessionId,
      history,
      attachments,
      contextFolder,
      override,
      envelope,
    );
  }

  const mc = getModelConfig(profile);
  const eff = effectiveModelConfig(profile, override);
  // Official upstream desktop hot-swaps the active gateway session with
  // `/model ... --provider ...` before attaching media and submitting. Our
  // renderer dashboard transport follows that path. The legacy CLI fallback is
  // kept only for text-only turns; it cannot preserve image/path attachments.
  if (
    !envelope?.requireBoundApiTransport &&
    shouldForceCliForSessionOverride(mc, eff, override, attachments)
  ) {
    return sendMessageViaCli(
      message,
      cb,
      profile,
      resumeSessionId,
      attachments,
      override,
    );
  }

  // Check API server availability when the cache is cold or known-bad. Once
  // the API is known healthy, keep the normal send path fast and let the API
  // transport error wrapper handle a stale cache caused by external lifecycle
  // events such as `hermes update` or Windows sleep/resume.
  if (apiServerAvailable === null || apiServerAvailable === false) {
    apiServerAvailable = await isApiServerReady(profile);
    if (!apiServerAvailable) {
      apiServerAvailable = await startGatewayWithRecovery(profile);
    }
  }

  if (apiServerAvailable) {
    return sendMessageViaBestApiWithLocalRecovery(
      message,
      cb,
      profile,
      resumeSessionId,
      history,
      attachments,
      contextFolder,
      override,
      envelope,
    );
  }

  // Fallback to CLI
  return sendMessageViaCli(
    message,
    cb,
    profile,
    resumeSessionId,
    attachments,
    override,
  );
}

// Lazy init — called on first sendMessage or gateway start
let _initialized = false;
let _healthCheckInterval: ReturnType<typeof setInterval> | null = null;

function ensureInitialized(): void {
  if (_initialized) return;
  _initialized = true;
  // Note: api_server config is written per-profile by startGateway() now
  // (each profile needs its own port), so ensureInitialized only owns the
  // shared health poller. The dashboard backend is intentionally not warmed
  // here: it shares the Runtime's Python interpreter with the primary
  // gateway, and cold-starting both together starves the primary gateway.
  startHealthPolling();
}

function startHealthPolling(): void {
  if (_healthCheckInterval) return;
  _healthCheckInterval = setInterval(async () => {
    apiServerAvailable = await isApiServerReady();
    // Stop polling once API is confirmed available — only re-check on demand
    if (apiServerAvailable && _healthCheckInterval) {
      clearInterval(_healthCheckInterval);
      _healthCheckInterval = null;
    }
  }, 15000);
}

export function stopHealthPolling(): void {
  if (_healthCheckInterval) {
    clearInterval(_healthCheckInterval);
    _healthCheckInterval = null;
  }
}

// ────────────────────────────────────────────────────
//  Gateway management
// ────────────────────────────────────────────────────

// Profiles each own a gateway, keyed by profileKey() ("default" for the
// default profile, the profile name otherwise). Tracking them in maps —
// rather than a single global — lets several profiles' gateways run at once
// (e.g. each keeping its own Telegram bot online), which is the documented
// hermes model: one gateway per profile, bound to that profile's own port.
const gatewayProcesses = new Map<string, ChildProcess>();
const appStartedProfiles = new Set<string>();
const gatewayOwnershipTerminationTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
// `hermes gateway` starts a short-lived CLI wrapper which writes gateway.pid
// from the long-lived Python listener. Keep a small adoption window so the
// durable ownership record follows that listener PID before the wrapper exits.
const gatewayPidAdoptionTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
let gatewayProcessOwnership: GatewayProcessOwnershipLedger | null = null;

export function configureGatewayProcessOwnership(userDataPath: string): void {
  for (const timer of gatewayOwnershipTerminationTimers.values()) {
    clearTimeout(timer);
  }
  gatewayOwnershipTerminationTimers.clear();
  for (const timer of gatewayPidAdoptionTimers.values()) {
    clearTimeout(timer);
  }
  gatewayPidAdoptionTimers.clear();
  gatewayProcessOwnership = new GatewayProcessOwnershipLedger({
    userDataPath,
  });
}

export interface GatewayStartDiagnostics {
  pid?: number;
  command?: string;
  args?: string[];
  logPath?: string;
  exitCode?: number | null;
  signal?: string | null;
  stderrTail?: string;
  /** Parsed /v1/capabilities evidence captured once the API served. */
  capabilities?: {
    requestToolPolicy: boolean;
    requestModelRoute: boolean;
  };
  /** Outcome of the bounded cleanup after a readiness timeout. */
  termination?: {
    forced: boolean;
    remainingPids: number[];
  };
}

export interface GatewayStartResult {
  success: boolean;
  running: boolean;
  alreadyRunning?: boolean;
  /**
   * True only when the gateway's Bearer-protected API actually answered a
   * readiness probe. A spawned-but-still-cold-starting process reports
   * `running: true` with `ready` unset/false — never treat `running` alone
   * as proof the API is serving.
   */
  ready?: boolean;
  error?: string;
  logPath?: string;
  diagnostics?: GatewayStartDiagnostics;
}

/**
 * Clear the cached API-server-ready flag, but only when `profile` is the one
 * the desktop currently addresses (the active profile). A *background*
 * profile's gateway dying must not flip the active profile's chat into the
 * CLI-fallback path on its next message.
 */
function invalidateApiCacheFor(profile?: string): void {
  if (profileKey(profile) === profileKey(undefined)) {
    apiServerAvailable = false;
  }
  try {
    const prefix = `${getApiUrl(profile)}|`;
    for (const key of capabilitiesCache.keys()) {
      if (key.startsWith(prefix)) capabilitiesCache.delete(key);
    }
  } catch {
    // A transiently unavailable SSH tunnel has no capability-cache key to
    // invalidate. The next successful probe will populate a fresh entry.
  }
}

function getGatewaySpawnError(): string | null {
  return getRuntimeInvocation()
    ? null
    : "Cannot start the gateway because Aera Runtime is not prepared. Install or repair Aera Runtime, then try again.";
}

function canSpawnGateway(): boolean {
  const error = getGatewaySpawnError();
  if (error) {
    console.error(`[gateway] ${error}`);
    return false;
  }
  return true;
}

function gatewayLogPath(profile?: string): string {
  const logDir = profileHome(resolveProfile(profile));
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // ignore
  }
  return join(logDir, "gateway-stderr.log");
}

export function buildGatewayEnv(
  profile?: string,
  prepared?: PreparedGatewayLaunch,
): Record<string, string> {
  const resolved = resolveProfile(profile);
  const apiServerKey = (prepared?.key ?? getApiServerKey(resolved)).trim();
  if (!apiServerKey) {
    throw new Error(
      "The local gateway credential must be prepared before process launch.",
    );
  }
  const port = prepared?.port ?? getProfilePort(resolved);

  const invocation = getRuntimeInvocation();
  const baseEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: getEnhancedPath(),
    HOME: homedir(),
    HERMES_HOME: HERMES_HOME,
    API_SERVER_ENABLED: "true",
    // Bind to this profile's port. config.yaml's api_server.port wins when
    // present (getProfilePort keeps it collision-free); this env value covers
    // the case where the block exists but omits an explicit port.
    API_SERVER_PORT: String(port),
  };
  const gatewayEnv = (
    invocation ? invocation.environment(baseEnv) : baseEnv
  ) as Record<string, string>;

  hydrateProfileRuntimeEnv(gatewayEnv, resolved);

  // Inject the resolved API_SERVER_KEY into the gateway's env.
  //
  // The desktop's `getApiServerKey` reads the shared secret from six
  // sources: config.yaml top-level `API_SERVER_KEY:`, `.env`
  // `API_SERVER_KEY=`, and config.yaml `api_server.token:` (each per-profile
  // and default-profile). The upstream gateway's `APIServerAdapter` (see
  // `gateway/platforms/api_server.py:647`) only reads two of those:
  // `api_server.extra.key` from config.yaml, or `os.getenv("API_SERVER_KEY")`
  // at startup. Upstream `gateway/run.py:608-610` bridges *top-level*
  // config.yaml keys into env vars, so `API_SERVER_KEY:` at the top
  // level works — but the nested `api_server.token:` location does not
  // become an env var, and the gateway never reads it directly.
  //
  // The result is a divergence: the desktop happily sends
  // `Authorization: Bearer <key>` + `X-Hermes-Session-Id` for users
  // whose key lives in `api_server.token`, while the gateway's
  // `self._api_key` is empty and returns 403 with
  //   "Session continuation requires API key authentication.
  //    Configure API_SERVER_KEY to enable this feature."
  // (api_server.py:1097-1109). This is what users on Telegram, Reddit,
  // and several open issues have been hitting since v0.5.1 — PR #357
  // started sending the session header on every fresh chat, which made
  // the latent divergence user-visible on every send.
  //
  // Bridging the desktop's resolved value into the spawn env makes the
  // gateway's `os.getenv("API_SERVER_KEY")` fallback see whatever the
  // desktop sees, regardless of source. This is the canonical fix until
  // upstream learns to read `api_server.token` directly.
  gatewayEnv.API_SERVER_KEY = apiServerKey;

  return gatewayEnv;
}

function gatewayCliCommandArgs(
  profile: string | undefined,
  command: string[],
): string[] {
  const resolved = resolveProfile(profile);
  return resolved ? ["--profile", resolved, ...command] : command;
}

export function startGatewayDetailed(
  profile?: string,
  prepared?: PreparedGatewayLaunch,
  options?: {
    /**
     * Launch-scoped hook fired synchronously once the wrapper process has a
     * PID. The wrapper is short-lived by design (the daemonized listener
     * writes gateway.pid), so its `close` handler removes the tracked map
     * entry; a caller that must keep process evidence through a longer
     * operation (readiness, cleanup) captures the reference here.
     */
    onSpawn?: (
      proc: ChildProcess,
      ownership: GatewayLaunchOwnershipRecord,
    ) => void;
    /**
     * Readiness-gated callers perform the listener adoption themselves after
     * the authenticated probe.  Suppress the background adoption probe for
     * that launch so it cannot race/consume the same cold-start readiness
     * budget (or adopt a PID before the gate has established API health).
     */
    schedulePidAdoption?: boolean;
    /**
     * Readiness-gated callers must not synchronously activate the Windows CIM
     * provider on Electron's main thread. They capture the wrapper evidence
     * through the bounded async reader and persist it before adoption/cleanup.
     */
    deferSpawnEvidence?: boolean;
  },
): GatewayStartResult {
  // Defensive: the local gateway is never the right thing to spawn in
  // remote/SSH mode — the user is pointing at an off-machine server.
  // Callers should already gate, but several IPC handlers historically
  // forgot to (issue #266), and reaching the local Runtime spawn path when
  // there is no prepared Runtime produces an uncaught ENOENT
  // that pops a generic error dialog.  Refuse cleanly here.
  if (isRemoteMode()) {
    const error =
      "The local gateway can only be started in local mode. Switch to local mode, or start the gateway on the remote Aera Runtime host.";
    console.warn(
      "[gateway] startGateway() called in remote/SSH mode — refusing local spawn",
    );
    return { success: false, running: false, error };
  }
  ensureInitialized();
  const ownershipLoadIssue = gatewayProcessOwnership?.getLoadIssue() ?? null;
  if (gatewayProcessOwnership === null || ownershipLoadIssue !== null) {
    const error =
      ownershipLoadIssue === null
        ? "Aera gateway ownership is unavailable."
        : `Aera gateway ownership is unavailable: ${ownershipLoadIssue}.`;
    console.error(`[gateway:${profileKey(profile)}] ${error}`);
    return { success: false, running: false, error };
  }
  if (isGatewayRunning(profile)) {
    return {
      success: true,
      running: true,
      alreadyRunning: true,
      diagnostics: {
        pid: readPidFile(profile) ?? undefined,
        logPath: gatewayLogPath(profile),
      },
    };
  }

  // Pre-flight: verify the Python interpreter exists before attempting to
  // spawn. Without this check, spawn() fails with ENOENT and the error is
  // completely silent (stdio:"ignore", no error handler).
  const spawnError = getGatewaySpawnError();
  if (spawnError) {
    console.error(`[gateway] ${spawnError}`);
    return { success: false, running: false, error: spawnError };
  }
  const invocation = getRuntimeInvocation();
  if (!invocation) {
    const error = "Aera Runtime is not prepared.";
    return { success: false, running: false, error };
  }

  const key = profileKey(profile);
  let gatewayEnv: Record<string, string>;
  try {
    gatewayEnv = buildGatewayEnv(profile, prepared);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = `Cannot start the local gateway: ${message}`;
    console.error(`[gateway:${key}] ${error}`);
    return { success: false, running: false, error };
  }

  // Route stderr to a log file so startup errors are visible for debugging.
  // Per-profile log dir so a named profile's failures (e.g. a duplicate bot
  // token, which the gateway refuses to start with) don't get mixed into the
  // default profile's log. stdout is ignored (the gateway daemonizes and
  // writes its own logs).
  const logPath = gatewayLogPath(profile);
  // A previous failed process may have cached a null /v1/capabilities result.
  // Do not carry that failure into the newly spawned gateway.
  invalidateApiCacheFor(profile);
  // Open the log synchronously and hand spawn a real fd. A createWriteStream
  // opens its fd asynchronously, so passing the stream to stdio races: when
  // the fd hasn't resolved yet (fd: null) Electron's Node rejects it with
  // ERR_INVALID_ARG_VALUE. An integer fd sidesteps the race entirely.
  let stderrFd: number;
  try {
    stderrFd = openSync(logPath, "a");
  } catch {
    // If the log file can't be opened (e.g. permissions), fall back to
    // discarding stderr rather than failing the whole gateway start.
    stderrFd = -1;
  }

  // Target the specific profile via `--profile <name>` (placed before the
  // subcommand, as the CLI requires). The flag makes the CLI repoint
  // HERMES_HOME at the profile's dir internally; the shared repo/venv stay
  // put. The default profile takes no flag.
  const cliArgs = gatewayCliCommandArgs(profile, ["gateway"]);
  let proc: ChildProcess | null = null;
  let ownership: GatewayLaunchOwnershipRecord | null = null;
  let spawnedEvidence: ProcessIdentityEvidence | null = null;
  let spawnArgs: string[] | undefined;
  try {
    if (gatewayProcessOwnership === null) {
      throw new Error("Aera gateway ownership is unavailable.");
    }
    ownership = gatewayProcessOwnership.beginLaunch({
      profileId: key,
      preLaunchPid: readPidFile(profile),
    });
    spawnArgs = invocation.cliArgs(cliArgs);
    proc = spawn(invocation.python, spawnArgs, {
      cwd: invocation.workingDirectory,
      env: gatewayEnv,
      stdio: ["ignore", "ignore", stderrFd >= 0 ? stderrFd : "ignore"],
      detached: process.platform !== "win32",
      ...HIDDEN_SUBPROCESS_OPTIONS,
    });
    if (typeof proc.pid !== "number") {
      throw new Error("The gateway process identity is unavailable.");
    }
    if (options?.deferSpawnEvidence !== true) {
      spawnedEvidence = readGatewayProcessEvidence(proc.pid);
    }
    ownership = gatewayProcessOwnership.markSpawned({
      profileId: key,
      launchId: ownership.launchId,
      spawnedPid: proc.pid,
      spawnedIdentity: spawnedEvidence?.identity,
      spawnedImage: spawnedEvidence?.image,
    });
    options?.onSpawn?.(proc, ownership);
  } catch (err) {
    if (ownership !== null && proc !== null && typeof proc.pid === "number") {
      retainFailedSpawnOwnershipUntilExit(
        profile,
        proc,
        ownership,
        spawnedEvidence,
      );
    } else if (ownership !== null) {
      try {
        gatewayProcessOwnership?.clearLaunch(key, ownership.launchId);
      } catch {
        // Preserve the bounded launch failure.
      }
    } else if (proc !== null) {
      // Without a durable ownership record there is no identity-bound target
      // to signal. A ChildProcess handle alone is not sufficient protection
      // against PID reuse, so leave the process for the explicit recovery
      // path rather than issuing an unverified TERM.
      console.warn(
        `[gateway:${key}] Refusing to signal a process whose ownership could not be recorded.`,
      );
    }
    if (stderrFd >= 0) {
      try {
        closeSync(stderrFd);
      } catch {
        // best-effort
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[gateway:${key}] start ownership/spawn failure code=${err instanceof GatewayProcessOwnershipError ? err.code : "unknown"} message=${message}`,
    );
    const error = `Failed to start the gateway process: ${message}`;
    console.error(`[gateway:${key}] ${error}`);
    return { success: false, running: false, error, logPath };
  }
  if (proc === null) {
    return {
      success: false,
      running: false,
      error: "The gateway process identity is unavailable.",
      logPath,
    };
  }
  // The child has inherited (dup'd) the fd; close our copy so we don't leak a
  // descriptor on every gateway (re)start.
  if (stderrFd >= 0) {
    try {
      closeSync(stderrFd);
    } catch {
      // best-effort
    }
  }

  proc.on("error", (err) => {
    console.error(
      `[gateway:${key}] Failed to spawn gateway process:`,
      err.message,
    );
    if (gatewayProcesses.get(key) === proc) gatewayProcesses.delete(key);
    appStartedProfiles.delete(key);
    if (ownership !== null) {
      // A wrapper error does not prove that a daemonized listener is gone.
      // Reconcile against the latest durable record and retain any adopted
      // listener; only a fully dead, identity-verified launch may be cleared.
      reconcileCompletedGatewayOwnership(profile, ownership);
    }
    invalidateApiCacheFor(profile);
    preparedGatewayKeys.delete(key);
  });

  proc.on("close", (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(
        `[gateway:${key}] Process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}. ` +
          `Check ${logPath} for details.`,
      );
    }
    if (gatewayProcesses.get(key) === proc) gatewayProcesses.delete(key);
    appStartedProfiles.delete(key);
    reconcileCompletedGatewayOwnership(profile, ownership, {
      wrapperExitedCleanly: code === 0 && signal === null,
    });
    invalidateApiCacheFor(profile);
    preparedGatewayKeys.delete(key);
    // Restart health polling to detect if gateway comes back
    startHealthPolling();
  });

  proc.unref();
  gatewayProcesses.set(key, proc);
  appStartedProfiles.add(key);
  if (ownership !== null && options?.schedulePidAdoption !== false) {
    scheduleGatewayPidAdoption(profile, ownership, {
      apiServerKey: prepared?.key,
      apiServerPort: prepared?.port,
    });
  }
  // The dashboard backend is intentionally NOT warmed here: it shares this
  // Runtime's Python interpreter, and cold-starting both processes together
  // (first Windows launch + Defender scan) starves the primary gateway so it
  // never reaches its pid-file/listening milestones. Readiness-gated callers
  // warm the dashboard only after the primary API is actually serving.

  // Wait a bit then check if API server came up (only meaningful for the
  // active profile, whose URL getApiUrl() resolves to).
  setTimeout(async () => {
    if (profileKey(profile) === profileKey(undefined)) {
      apiServerAvailable = await isApiServerReady(
        profile,
        prepared?.key,
        prepared?.port,
      );
    }
  }, 3000);

  return {
    success: true,
    running: true,
    logPath,
    diagnostics: {
      pid: proc.pid,
      command: invocation.python,
      args: spawnArgs,
      logPath,
    },
  };
}

export function startGateway(profile?: string): boolean {
  const result = startGatewayDetailed(profile);
  return result.success && !result.alreadyRunning;
}

const DEFAULT_GATEWAY_READY_TIMEOUT_MS = 90_000;
const GATEWAY_STDERR_TAIL_BYTES = 4096;

/**
 * Read creation identity and executable image for one Gateway PID.  The
 * process table is an advisory source, so malformed/unavailable evidence is
 * represented as null and every caller must fail closed.  Readiness callers
 * additionally require a Python image; spawn bookkeeping may retain any
 * observed image so a later ownership check can reject a mismatched process.
 */
function readGatewayProcessEvidence(
  pid: number,
): ProcessIdentityEvidence | null {
  try {
    const evidence = readProcessIdentityEvidence(pid);
    if (!evidence) return null;
    const identity = evidence.identity.trim();
    const image = normalizeProcessImage(evidence.image);
    if (!identity || !image) return null;
    return { identity, image };
  } catch {
    return null;
  }
}

/**
 * Read Gateway process evidence without synchronously blocking Electron's
 * main process. The synchronous reader remains available for already-synchronous
 * lifecycle/status APIs; readiness uses this bounded async path so a cold
 * Windows CIM provider cannot starve the Runtime's own startup.
 */
async function readGatewayProcessEvidenceAsync(
  pid: number,
): Promise<ProcessIdentityEvidence | null> {
  try {
    const evidence = await readProcessIdentityEvidenceAsync(pid);
    if (!evidence) return null;
    const identity = evidence.identity.trim();
    const image = normalizeProcessImage(evidence.image);
    if (!identity || !image) return null;
    return { identity, image };
  } catch {
    return null;
  }
}

/**
 * Persist a wrapper's asynchronously captured identity only while the same
 * launch transaction still owns the Profile. A late PowerShell callback must
 * never resurrect a cleared launch or overwrite evidence from a newer
 * restart. The ledger method remains the single atomic writer for the record.
 */
function persistSpawnedGatewayEvidence(
  profileKeyValue: string,
  launchId: string,
  pid: number,
  evidence: ProcessIdentityEvidence | null,
): GatewayLaunchOwnershipRecord | null {
  if (evidence === null || gatewayProcessOwnership === null) return null;
  try {
    const current = gatewayProcessOwnership.get(profileKeyValue);
    if (
      current === null ||
      current.launchId !== launchId ||
      current.spawnedPid !== pid
    ) {
      return current;
    }
    if (current.spawnedIdentity !== null || current.spawnedImage !== null) {
      return current.spawnedIdentity === evidence.identity &&
        current.spawnedImage === evidence.image
        ? current
        : null;
    }
    return gatewayProcessOwnership.markSpawned({
      profileId: profileKeyValue,
      launchId,
      spawnedPid: pid,
      spawnedIdentity: evidence.identity,
      spawnedImage: evidence.image,
    });
  } catch {
    // A concurrent close/restart or persistence failure leaves the durable
    // launch guard intact. Callers must continue to fail closed.
    return null;
  }
}

function isGatewayProcessEvidence(
  evidence: ProcessIdentityEvidence | null,
): evidence is ProcessIdentityEvidence {
  if (!evidence) return false;
  const invocation = getRuntimeInvocation();
  if (invocation) {
    return processImageMatchesExecutable(evidence.image, invocation.python);
  }
  const image = normalizeProcessImage(evidence.image);
  return (
    image !== null &&
    GATEWAY_IMAGE_PREFIXES.some((prefix) =>
      image.startsWith(prefix.toLowerCase()),
    )
  );
}

function gatewayProcessEvidenceStillMatches(
  pid: number,
  expected: ProcessIdentityEvidence,
): boolean {
  const observed = readGatewayProcessEvidence(pid);
  return (
    isGatewayProcessEvidence(observed) &&
    processEvidenceMatches(observed, expected)
  );
}

function gatewayReadinessDiagnostic(
  event: string,
  fields: Readonly<Record<string, boolean | number | string | null>> = {},
): void {
  if (process.env.AGENTERA_E2E_DIAGNOSTICS !== "1") return;
  // Acceptance diagnostics are deliberately path-free and credential-free.
  // They must remain useful even when the IPC never returns to Playwright.
  console.error(`[gateway-readiness] ${JSON.stringify({ event, ...fields })}`);
}

function gatewayReadyTimeoutMs(): number {
  const override = Number(process.env.AERA_GATEWAY_READY_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0
    ? override
    : DEFAULT_GATEWAY_READY_TIMEOUT_MS;
}

type GatewayWrapperCpuSampleState =
  | "not-requested"
  | "unsupported"
  | "pending"
  | "value"
  | "missing"
  | "error";

type GatewayWrapperCpuSample = {
  seconds: number | null;
  state: Exclude<GatewayWrapperCpuSampleState, "not-requested" | "pending">;
  errorCode: string | null;
};

function sampleGatewayWrapperCpuSeconds(
  pid: number,
): Promise<GatewayWrapperCpuSample> {
  if (process.platform !== "win32") {
    return Promise.resolve({
      seconds: null,
      state: "unsupported",
      errorCode: null,
    });
  }
  const safePid = Number.isSafeInteger(pid) && pid > 0 ? Math.floor(pid) : null;
  if (safePid === null) {
    return Promise.resolve({
      seconds: null,
      state: "error",
      errorCode: "invalid-pid",
    });
  }
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-Process -Id ${safePid} -ErrorAction SilentlyContinue; if ($p) { $p.CPU } else { "" }`,
      ],
      { timeout: 3_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const errorCode =
            error.killed || error.signal
              ? "timeout"
              : typeof code === "string" && /^[A-Za-z0-9_-]{1,32}$/u.test(code)
                ? code
                : "exec-error";
          resolve({ seconds: null, state: "error", errorCode });
          return;
        }
        const output = String(stdout).trim();
        if (!output) {
          resolve({ seconds: null, state: "missing", errorCode: null });
          return;
        }
        const value = Number(output);
        if (!Number.isFinite(value)) {
          resolve({
            seconds: null,
            state: "error",
            errorCode: "invalid-output",
          });
          return;
        }
        resolve({ seconds: value, state: "value", errorCode: null });
      },
    );
  });
}

function readGatewayLogTail(logPath: string | undefined): string | undefined {
  if (!logPath) return undefined;
  let fd: number | null = null;
  try {
    fd = openSync(logPath, "r");
    const { size } = fstatSync(fd);
    if (size <= 0) return undefined;
    const length = Math.min(size, GATEWAY_STDERR_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, Math.max(0, size - length));
    return buffer.toString("utf-8");
  } catch {
    return undefined;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

export interface StartGatewayWithReadinessOptions {
  /** Total readiness budget; defaults to 90s (AERA_GATEWAY_READY_TIMEOUT_MS). */
  readyTimeoutMs?: number;
  pollMs?: number;
  /** Test seam: defaults to the real dashboard warm-up. */
  warmDashboard?: (profile?: string) => void;
}

/**
 * Readiness is two facts, not one: the daemonized listener has written its
 * gateway.pid (so the OS-level identity exists) AND the Bearer-protected API
 * answers on the prepared port (so the HTTP surface serves). A live socket
 * without the pid file still fails the acceptance's pid evidence check; a
 * pid file without a serving API is a dead process.
 */
async function waitForGatewayServing(
  profile: string | undefined,
  timeoutMs: number,
  pollMs: number,
  preparedApiServerKey?: string,
  preparedApiServerPort?: number,
  preLaunchPid?: number | null,
  launchPid?: number | null,
): Promise<{
  ready: boolean;
  listenerPid: number | null;
  listenerEvidence: ProcessIdentityEvidence | null;
}> {
  const deadline = Date.now() + timeoutMs;
  let lastWrapperCpuSampleAt = 0;
  let lastWrapperCpuSeconds: number | null = null;
  let lastWrapperCpuSampleState: GatewayWrapperCpuSampleState =
    process.platform === "win32" ? "not-requested" : "unsupported";
  let lastWrapperCpuSampleError: string | null = null;
  let wrapperCpuSampleInFlight: Promise<void> | null = null;
  for (;;) {
    // A pid file alone is not evidence: the listener PID must parse, differ
    // from the pre-launch stale pid, and resolve to a live Python process.
    const candidate = readPidFile(profile);
    const candidateIsPreLaunch =
      candidate !== null && candidate === (preLaunchPid ?? null);
    const candidateIsTrackedLaunch =
      candidate !== null && candidate === (launchPid ?? null);
    // The async identity query is itself the liveness proof: a complete row
    // can only be returned for a process that exists at query time. Avoid the
    // synchronous tasklist/CIM pair here; on a cold packaged Windows launch
    // either call can block the Electron main loop long enough to starve the
    // Runtime and make every subsequent readiness poll miss its evidence.
    const observedListenerEvidence =
      candidate !== null && !candidateIsPreLaunch
        ? await readGatewayProcessEvidenceAsync(candidate)
        : null;
    const candidateAlive = observedListenerEvidence !== null;
    const listenerEvidence = isGatewayProcessEvidence(observedListenerEvidence)
      ? observedListenerEvidence
      : null;
    const listenerPid = listenerEvidence === null ? null : candidate;
    const apiProbeAttempted = listenerPid !== null;
    let apiReady = false;
    if (apiProbeAttempted) {
      apiReady = await isApiServerReady(
        profile,
        preparedApiServerKey,
        preparedApiServerPort,
      );
    }
    // Diagnostic-only wrapper liveness/CPU curve: distinguishes a slow
    // cold-start (CPU accumulating) from a hung wrapper (CPU flat) on the
    // next packaged candidate. Bounded to one PowerShell sample per 4s.
    let wrapperAlive: boolean | null = null;
    if (launchPid !== null && launchPid !== undefined) {
      wrapperAlive = pidIsAliveAs(launchPid, GATEWAY_IMAGE_PREFIXES);
      const now = Date.now();
      if (
        process.env.AGENTERA_E2E_DIAGNOSTICS === "1" &&
        now - lastWrapperCpuSampleAt >= 4_000 &&
        wrapperCpuSampleInFlight === null
      ) {
        lastWrapperCpuSampleAt = now;
        lastWrapperCpuSampleState = "pending";
        lastWrapperCpuSampleError = null;
        // Diagnostic sampling must never hold the readiness gate open. A
        // cold Windows PowerShell/CIM startup can outlive several readiness
        // polls; keep one bounded sample in flight and publish its result to
        // the next poll instead of awaiting it here.
        wrapperCpuSampleInFlight = sampleGatewayWrapperCpuSeconds(launchPid)
          .then((sample) => {
            if (sample.seconds !== null) {
              lastWrapperCpuSeconds = sample.seconds;
            }
            lastWrapperCpuSampleState = sample.state;
            lastWrapperCpuSampleError = sample.errorCode;
          })
          .catch(() => {
            // The poll already records the last known value (or null). A
            // diagnostic failure must not alter readiness or cleanup.
            lastWrapperCpuSampleState = "error";
            lastWrapperCpuSampleError = "sample-failed";
          })
          .finally(() => {
            wrapperCpuSampleInFlight = null;
          });
      }
    }
    gatewayReadinessDiagnostic("poll", {
      candidatePid: candidate,
      candidateIsPreLaunch,
      candidateIsTrackedLaunch,
      candidateAlive,
      identityAvailable: observedListenerEvidence !== null,
      identityValid: listenerEvidence !== null,
      apiProbeAttempted,
      apiReady,
      wrapperPid: launchPid ?? null,
      wrapperAlive,
      wrapperCpuSeconds: lastWrapperCpuSeconds,
      wrapperCpuSampleState: lastWrapperCpuSampleState,
      wrapperCpuSampleError: lastWrapperCpuSampleError,
    });
    if (listenerPid !== null && apiReady) {
      return { ready: true, listenerPid, listenerEvidence };
    }
    if (Date.now() >= deadline) {
      return { ready: false, listenerPid, listenerEvidence };
    }
    await delay(pollMs);
  }
}

type GatewayLaunchCleanupResult = {
  termination: GatewayStartDiagnostics["termination"];
  terminated: boolean;
};

/**
 * Stop every process identity left by one readiness-gated launch.  The
 * wrapper is represented by its ChildProcess handle while it lives; a
 * daemonized listener is represented by the exact PID/evidence observed by
 * the readiness probe.  Both identities are revalidated immediately before
 * entering the platform tree terminator, so an adoption/persistence failure
 * cannot turn a stale PID into a signal target.
 */
async function cleanupGatewayLaunch(
  key: string,
  profile: string | undefined,
  launchProc: ChildProcess | null,
  listenerPid: number | null,
  listenerEvidence: ProcessIdentityEvidence | null,
): Promise<GatewayLaunchCleanupResult> {
  const targets: Array<
    | { kind: "child"; proc: ChildProcess; evidence: ProcessIdentityEvidence }
    | { kind: "pid"; pid: number; evidence: ProcessIdentityEvidence }
  > = [];

  let ownership: GatewayLaunchOwnershipRecord | null = null;
  let cleanupFailed = false;
  try {
    ownership = gatewayProcessOwnership?.get(key) ?? null;
  } catch {
    // A persistence/read failure is not an empty ownership ledger. Keep every
    // live launch identity unresolved and refuse to report a clean stop.
    cleanupFailed = true;
  }

  // The listener can publish gateway.pid in the narrow interval after the
  // final readiness poll has observed no file but before timeout cleanup
  // starts. Capture and durably adopt that exact PID now; otherwise cleanup
  // would see only the exited wrapper and leave the daemon behind. Adoption
  // still requires a live Python image plus creation identity, and a failed
  // persistence step deliberately leaves the PID unowned/fail-closed.
  if (!cleanupFailed && ownership !== null && ownership.listenerPid === null) {
    const latePidEntry = readPidFileEntry(profile);
    if (latePidEntry !== null && latePidEntry.pid !== ownership.preLaunchPid) {
      const lateEvidence = readGatewayProcessEvidence(latePidEntry.pid);
      if (isGatewayProcessEvidence(lateEvidence)) {
        const adopted = adoptGatewayPidFromFile(
          profile,
          ownership,
          lateEvidence,
        );
        if (
          adopted !== null &&
          adopted.listenerPid === latePidEntry.pid &&
          adopted.listenerIdentity === lateEvidence.identity &&
          adopted.listenerImage === lateEvidence.image
        ) {
          ownership = adopted;
          listenerPid = latePidEntry.pid;
          listenerEvidence = lateEvidence;
        }
      }
    }
  }
  const wrapperTargetRecord = ownership ? wrapperTarget(ownership) : null;
  if (
    launchProc !== null &&
    typeof launchProc.pid === "number" &&
    wrapperTargetRecord !== null &&
    wrapperTargetRecord.pid === launchProc.pid &&
    wrapperTargetRecord.identity !== null &&
    wrapperTargetRecord.image !== null
  ) {
    const observed = readGatewayProcessEvidence(launchProc.pid);
    if (
      isChildProcessAlive(launchProc) &&
      processEvidenceMatches(observed, {
        identity: wrapperTargetRecord.identity,
        image: wrapperTargetRecord.image,
      }) &&
      isGatewayProcessEvidence(observed)
    ) {
      targets.push({
        kind: "child",
        proc: launchProc,
        evidence: observed,
      });
    }
  }

  if (
    listenerPid !== null &&
    listenerEvidence !== null &&
    isGatewayProcessEvidence(listenerEvidence) &&
    listenerPid !== launchProc?.pid
  ) {
    const observed = readGatewayProcessEvidence(listenerPid);
    if (
      processEvidenceMatches(observed, listenerEvidence) &&
      isGatewayProcessEvidence(observed)
    ) {
      targets.push({ kind: "pid", pid: listenerPid, evidence: observed });
    }
  }

  const targetedPids = new Set(
    targets.flatMap((target) => {
      const pid = target.kind === "child" ? target.proc.pid : target.pid;
      return typeof pid === "number" ? [pid] : [];
    }),
  );
  const unresolvedPids: number[] = [];
  if (
    launchProc !== null &&
    typeof launchProc.pid === "number" &&
    isChildProcessAlive(launchProc) &&
    !targetedPids.has(launchProc.pid)
  ) {
    unresolvedPids.push(launchProc.pid);
  }
  const currentPidEntry = readPidFileEntry(profile);
  if (
    currentPidEntry !== null &&
    currentPidEntry.pid !== ownership?.preLaunchPid &&
    !targetedPids.has(currentPidEntry.pid)
  ) {
    const observed = readGatewayProcessEvidence(currentPidEntry.pid);
    if (
      observed !== null ||
      pidIsAliveAs(currentPidEntry.pid, GATEWAY_IMAGE_PREFIXES)
    ) {
      // A live PID with missing/mismatched evidence is an ambiguity, not an
      // exited listener. It stays in diagnostics and is never signalled.
      unresolvedPids.push(currentPidEntry.pid);
    }
  }

  gatewayReadinessDiagnostic("cleanup-plan", {
    targetCount: targets.length,
    wrapperPid: launchProc?.pid ?? null,
    listenerPid,
  });

  const remainingPids: number[] = [...unresolvedPids];
  let forced = false;
  for (const target of targets) {
    const targetPid = target.kind === "child" ? target.proc.pid : target.pid;
    gatewayReadinessDiagnostic("cleanup-target-start", {
      kind: target.kind,
      pid: targetPid ?? null,
    });
    try {
      const terminationOptions = {
        detachedProcessGroup:
          target.kind === "child" && process.platform !== "win32",
        forceAfterMs: 3_000,
        verifyRootOwnership: (pid: number) => {
          if (
            pid !== targetPid ||
            !gatewayProcessEvidenceStillMatches(pid, target.evidence)
          ) {
            return false;
          }
          try {
            return (
              ownership !== null &&
              gatewayProcessOwnership?.get(key)?.launchId ===
                ownership.launchId &&
              (target.kind !== "pid" || readPidFile(profile) === pid)
            );
          } catch {
            return false;
          }
        },
        ...(process.platform === "win32"
          ? {
              commandTimeoutMs: 3_000,
              snapshotTimeoutMs: 3_000,
              snapshotTotalBudgetMs: 6_000,
              diagnosticProfileKey: key,
            }
          : {}),
      };
      const result =
        target.kind === "child"
          ? await terminateProcessTree(target.proc, terminationOptions)
          : await terminateProcessTreeByPid(target.pid, terminationOptions);
      forced ||= result.forced;
      remainingPids.push(...result.remainingPids);
      gatewayReadinessDiagnostic("cleanup-target-complete", {
        kind: target.kind,
        pid: targetPid ?? null,
        forced: result.forced,
        remainingPidCount: result.remainingPids.length,
      });
    } catch (cleanupError) {
      cleanupFailed = true;
      const stillAlive =
        typeof targetPid === "number" &&
        (target.kind === "child"
          ? isChildProcessAlive(target.proc)
          : pidIsAliveAs(target.pid, GATEWAY_IMAGE_PREFIXES));
      if (stillAlive && typeof targetPid === "number") {
        remainingPids.push(targetPid);
      }
      gatewayReadinessDiagnostic("cleanup-target-failed", {
        kind: target.kind,
        pid: targetPid ?? null,
        failure:
          cleanupError instanceof Error
            ? cleanupError.name.slice(0, 80)
            : "unknown",
      });
      console.error(
        `[gateway:${key}] Never-ready gateway cleanup failed:`,
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError),
      );
    }
  }

  if (!cleanupFailed && remainingPids.length === 0 && ownership !== null) {
    try {
      const current = gatewayProcessOwnership?.get(key) ?? null;
      if (current !== null) {
        if (current.launchId !== ownership.launchId) {
          throw new Error("Gateway ownership changed during launch cleanup.");
        }
        for (const targetPid of targetedPids) {
          clearPidFileBestEffort(profile, targetPid);
        }
        gatewayProcessOwnership?.clearLaunch(key, ownership.launchId);
      }
      cancelGatewayPidAdoption(profile);
    } catch (cleanupError) {
      cleanupFailed = true;
      console.error(
        `[gateway:${key}] Never-ready gateway ownership release failed:`,
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError),
      );
    }
  }

  const termination = {
    forced,
    remainingPids: [...new Set(remainingPids)],
  };
  return {
    termination,
    terminated: !cleanupFailed && termination.remainingPids.length === 0,
  };
}

/**
 * Launch the local gateway and hold the answer until its API is actually
 * serving. `startGatewayDetailed` resolves as soon as the Python process
 * spawns; on a first Windows launch that cold start can outlast any naive
 * caller-side timeout, so callers that act on "the gateway is up" must gate
 * on `ready` here instead of `running` there.
 *
 * The dashboard backend is warmed only after the primary gateway answers an
 * authenticated readiness probe, and that probe authenticates with the same
 * prepared credential the process was launched with.
 *
 * A readiness timeout terminates the process tree we spawned (bounded);
 * leaving a never-ready Python process behind is exactly the residue that
 * later fails temp-dir cleanup (EBUSY) and blocks Electron quit. A gateway
 * this call did NOT spawn (`alreadyRunning`) is reported, never killed.
 */
export async function startGatewayWithReadiness(
  profile?: string,
  prepared?: PreparedGatewayLaunch,
  options: StartGatewayWithReadinessOptions = {},
): Promise<GatewayStartResult> {
  // Snapshot the stale listener identity before launch so readiness can
  // reject a leftover gateway.pid, and keep a launch-scoped reference to the
  // wrapper process: its `close` handler removes the tracked map entry, but
  // the readiness operation still needs the wrapper's exit code/signal and
  // must be able to terminate a never-ready tree after the wrapper exits.
  const preLaunchPid = readPidFile(profile);
  // An object cell: TS control-flow cannot track closure assignment into a
  // plain `let`, which would narrow the later reads to `null`/`never`.
  const launchRef: {
    proc: ChildProcess | null;
    launchId: string | null;
  } = { proc: null, launchId: null };
  const startResult = startGatewayDetailed(profile, prepared, {
    onSpawn: (proc, ownership) => {
      launchRef.proc = proc;
      launchRef.launchId = ownership.launchId;
    },
    schedulePidAdoption: false,
    deferSpawnEvidence: true,
  });
  if (!startResult.success) {
    return { ...startResult, ready: false };
  }

  // Capture the short-lived wrapper without activating PowerShell/CIM on the
  // Electron main thread. The promise is allowed to run alongside the normal
  // pid/API readiness gate; it is joined once before adoption or cleanup so
  // the durable record contains every identity we were able to prove.
  const wrapperEvidencePromise =
    launchRef.proc?.pid !== undefined
      ? readGatewayProcessEvidenceAsync(launchRef.proc.pid)
      : Promise.resolve(null);

  const readyTimeoutMs = options.readyTimeoutMs ?? gatewayReadyTimeoutMs();
  const pollMs = options.pollMs ?? 500;
  const probeKey =
    prepared?.key ?? preparedGatewayKeys.get(profileKey(profile));
  const readinessStartedAt = Date.now();
  gatewayReadinessDiagnostic("wait-start", {
    wrapperPid: startResult.diagnostics?.pid ?? null,
    alreadyRunning: startResult.alreadyRunning === true,
    timeoutMs: readyTimeoutMs,
  });
  const serving = await waitForGatewayServing(
    profile,
    readyTimeoutMs,
    pollMs,
    probeKey,
    prepared?.port,
    // An already-running gateway legitimately keeps its existing pid; the
    // stale-pid rejection only applies to a launch this call made.
    startResult.alreadyRunning ? null : preLaunchPid,
    startResult.alreadyRunning ? null : (launchRef.proc?.pid ?? null),
  );
  gatewayReadinessDiagnostic("wait-complete", {
    ready: serving.ready,
    listenerPid: serving.listenerPid,
    elapsedMs: Date.now() - readinessStartedAt,
  });

  const wrapperEvidence = await wrapperEvidencePromise;
  if (launchRef.proc?.pid !== undefined && launchRef.launchId !== null) {
    persistSpawnedGatewayEvidence(
      profileKey(profile),
      launchRef.launchId,
      launchRef.proc.pid,
      wrapperEvidence,
    );
  }

  if (serving.ready) {
    setApiCacheFor(profile, true);
    // The wrapper PID is only a launch transport.  Once gateway.pid and the
    // authenticated API identify the long-lived listener, atomically transfer
    // durable ownership to that listener before warming the dashboard or
    // returning `ready=true`.
    if (!startResult.alreadyRunning) {
      const currentOwnership =
        gatewayProcessOwnership?.get(profileKey(profile)) ?? null;
      const adopted = adoptGatewayPidFromFile(
        profile,
        currentOwnership,
        serving.listenerEvidence,
      );
      // A serving listener without a durable identity transfer cannot be
      // safely cleaned up on Electron quit. Treat that as a launch failure;
      // the timeout cleanup below will still terminate any process we own.
      if (
        adopted === null ||
        adopted.listenerPid !== serving.listenerPid ||
        adopted.listenerIdentity !== serving.listenerEvidence?.identity ||
        adopted.listenerImage !== serving.listenerEvidence?.image
      ) {
        const key = profileKey(profile);
        console.error(
          `[gateway:${key}] Listener became ready but ownership adoption could not be confirmed.`,
        );
        const cleanup = await cleanupGatewayLaunch(
          key,
          profile,
          launchRef.proc,
          serving.listenerPid,
          serving.listenerEvidence,
        );
        return {
          ...startResult,
          success: false,
          running: cleanup.terminated ? false : startResult.running,
          ready: false,
          error:
            "The gateway became ready but its listener ownership could not be recorded.",
          diagnostics: {
            ...startResult.diagnostics,
            pid: serving.listenerPid ?? startResult.diagnostics?.pid,
            exitCode: launchRef.proc?.exitCode ?? null,
            signal: launchRef.proc?.signalCode ?? null,
            stderrTail: readGatewayLogTail(
              startResult.logPath ?? startResult.diagnostics?.logPath,
            ),
            termination: cleanup.termination,
          },
        };
      }
    }
    (options.warmDashboard ?? warmTuiGatewayClient)(profile);
    // Carry the capabilities document as acceptance evidence. This is
    // evidence, not a gate: older Runtimes legitimately lack these feature
    // flags and must still count as ready.
    const capabilities = await getApiCapabilities(profile, probeKey);
    return {
      ...startResult,
      ready: true,
      diagnostics: {
        ...startResult.diagnostics,
        pid: serving.listenerPid ?? startResult.diagnostics?.pid,
        capabilities: {
          requestToolPolicy:
            capabilities?.features?.request_tool_policy === true,
          requestModelRoute:
            capabilities?.features?.request_model_route === true,
        },
      },
    };
  }

  const key = profileKey(profile);
  const cleanup = startResult.alreadyRunning
    ? {
        termination: undefined,
        terminated: false,
      }
    : await cleanupGatewayLaunch(
        key,
        profile,
        launchRef.proc,
        serving.listenerPid,
        serving.listenerEvidence,
      );
  const termination = cleanup.termination;
  const terminated = cleanup.terminated;
  const launchProc = launchRef.proc;
  const error =
    `The gateway process launched but its API did not become ready within ${readyTimeoutMs}ms. ` +
    "See the gateway log for details.";
  // Process diagnostics only — never user paths or credentials.
  console.error(
    `[gateway:${key}] ${error} pid=${startResult.diagnostics?.pid ?? "unknown"} exitCode=${launchProc?.exitCode ?? "still-running"}`,
  );
  return {
    ...startResult,
    success: false,
    running:
      !startResult.alreadyRunning && terminated ? false : startResult.running,
    ready: false,
    error,
    diagnostics: {
      ...startResult.diagnostics,
      pid: serving.listenerPid ?? startResult.diagnostics?.pid,
      exitCode: launchProc?.exitCode ?? null,
      signal: launchProc?.signalCode ?? null,
      stderrTail: readGatewayLogTail(
        startResult.logPath ?? startResult.diagnostics?.logPath,
      ),
      termination,
    },
  };
}

function parsePidFromFile(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  try {
    const raw = readFileSync(pidFile, "utf-8").trim();
    // PID file can be JSON ({"pid": 1234, ...}) or plain integer
    const parsed = raw.startsWith("{")
      ? JSON.parse(raw).pid
      : parseInt(raw, 10);
    return typeof parsed === "number" && !isNaN(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The gateway.pid path for a profile. The hermes CLI writes it into the
 * profile's home directory (~/.hermes/gateway.pid for default,
 * ~/.hermes/profiles/<name>/gateway.pid for a named profile), so each
 * profile's gateway has its own PID file — that's what lets them coexist.
 */
function gatewayPidPath(profile?: string): string {
  return join(profileHome(resolveProfile(profile)), "gateway.pid");
}

function readPidFile(profile?: string): number | null {
  return readPidFileEntry(profile)?.pid ?? null;
}

function readPidFileEntry(
  profile?: string,
): { path: string; pid: number } | null {
  const pidFile = gatewayPidPath(profile);
  const pid = parsePidFromFile(pidFile);
  return pid === null ? null : { path: pidFile, pid };
}

function adoptGatewayPidFromFile(
  profile: string | undefined,
  ownership: GatewayLaunchOwnershipRecord | null,
  listenerEvidence?: ProcessIdentityEvidence | null,
  options: { replaceExistingListener?: boolean } = {},
): GatewayLaunchOwnershipRecord | null {
  if (ownership === null || gatewayProcessOwnership === null) return ownership;
  const pidEntry = readPidFileEntry(profile);
  if (pidEntry === null || ownership.spawnedPid === null) return ownership;
  const evidence = listenerEvidence ?? readGatewayProcessEvidence(pidEntry.pid);
  // A readiness pass may call adoption more than once while the wrapper is
  // still attached.  Preserve the existing listener evidence when the same
  // PID is observed again, and never overwrite it with a different identity.
  if (
    ownership.listenerPid !== null &&
    (ownership.listenerPid !== pidEntry.pid ||
      ownership.listenerIdentity !== evidence?.identity ||
      ownership.listenerImage !== evidence?.image)
  ) {
    return ownership;
  }
  if (
    pidEntry.pid === ownership.preLaunchPid ||
    !pidIsAliveAs(pidEntry.pid, GATEWAY_IMAGE_PREFIXES) ||
    !isGatewayProcessEvidence(evidence)
  ) {
    return ownership;
  }
  try {
    return gatewayProcessOwnership.adoptSpawnedPid({
      profileId: ownership.profileId,
      launchId: ownership.launchId,
      previousSpawnedPid: ownership.spawnedPid,
      spawnedPid: pidEntry.pid,
      previousSpawnedIdentity: ownership.spawnedIdentity,
      previousSpawnedImage: ownership.spawnedImage,
      spawnedIdentity: evidence.identity,
      spawnedImage: evidence.image,
      replaceExistingListener: options.replaceExistingListener === true,
    });
  } catch {
    // A concurrent cold-start/restart owns the record now; keep the existing
    // evidence and let the normal ownership checks fail closed.
    return ownership;
  }
}

function scheduleGatewayPidAdoption(
  profile: string | undefined,
  ownership: GatewayLaunchOwnershipRecord,
  options: {
    apiServerKey?: string;
    apiServerPort?: number;
  } = {},
): void {
  const key = ownership.profileId;
  const previous = gatewayPidAdoptionTimers.get(key);
  if (previous) clearTimeout(previous);
  const deadline = Date.now() + 5_000;
  const tick = async (): Promise<void> => {
    gatewayPidAdoptionTimers.delete(key);
    const current = gatewayProcessOwnership?.get(key) ?? null;
    if (current === null || current.launchId !== ownership.launchId) return;
    const pidEntry = readPidFileEntry(profile);
    const candidateEvidence =
      pidEntry !== null &&
      pidEntry.pid !== current.preLaunchPid &&
      pidIsAliveAs(pidEntry.pid, GATEWAY_IMAGE_PREFIXES)
        ? readGatewayProcessEvidence(pidEntry.pid)
        : null;
    if (!isGatewayProcessEvidence(candidateEvidence)) {
      if (Date.now() >= deadline) return;
      const timer = setTimeout(tick, 50);
      timer.unref?.();
      gatewayPidAdoptionTimers.set(key, timer);
      return;
    }
    // A gateway.pid appearing is not sufficient to transfer ownership.  A
    // daemonized wrapper can publish a stale/replacement PID while the API is
    // still cold; adopting on that observation would let shutdown signal an
    // unrelated process.  Conversely, an API probe before a verifiable pid
    // candidate exists cannot prove which listener answered and races the
    // foreground readiness flow. Require both facts in that order before
    // accepting a cross-PID listener.
    let healthy = false;
    try {
      healthy = await isApiServerReady(
        profile,
        options.apiServerKey ?? preparedGatewayKeys.get(key),
        options.apiServerPort,
      );
    } catch {
      healthy = false;
    }
    const latest = gatewayProcessOwnership?.get(key) ?? null;
    if (latest === null || latest.launchId !== ownership.launchId) return;
    const adopted = healthy
      ? adoptGatewayPidFromFile(profile, latest, candidateEvidence)
      : latest;
    if (adopted !== latest) return;
    if (Date.now() >= deadline) return;
    const timer = setTimeout(tick, 50);
    timer.unref?.();
    gatewayPidAdoptionTimers.set(key, timer);
  };
  void tick().catch(() => {
    // A transient probe failure leaves the durable wrapper record intact. The
    // next bounded timer tick retries with the same launch identity.
    if (Date.now() < deadline) {
      const timer = setTimeout(() => void tick(), 50);
      timer.unref?.();
      gatewayPidAdoptionTimers.set(key, timer);
    }
  });
}

function cancelGatewayPidAdoption(profile: string | undefined): void {
  const timer = gatewayPidAdoptionTimers.get(profileKey(profile));
  if (timer) clearTimeout(timer);
  gatewayPidAdoptionTimers.delete(profileKey(profile));
}

function reconcileCompletedGatewayOwnership(
  profile: string | undefined,
  ownership: GatewayLaunchOwnershipRecord | null,
  options: { wrapperExitedCleanly?: boolean } = {},
): void {
  if (ownership === null || gatewayProcessOwnership === null) return;
  let currentOwnership = ownership;
  try {
    const latest = gatewayProcessOwnership.get(ownership.profileId);
    if (latest === null || latest.launchId !== ownership.launchId) return;
    currentOwnership = latest;
  } catch {
    return;
  }
  const pidEntry = readPidFileEntry(profile);
  const trackedProcess = gatewayProcesses.get(ownership.profileId) ?? null;
  const wrapper = wrapperTarget(currentOwnership);
  const listener = listenerTarget(currentOwnership, pidEntry);
  const wrapperStatus = ownedTargetStatus(wrapper, trackedProcess);
  const listenerStatus = ownedTargetStatus(listener, null);
  // Unknown identity evidence is not equivalent to a dead process. Retain
  // the durable record so a later retry/restart can obtain a fresh proof.
  if (wrapperStatus === "alive" || listenerStatus === "alive") return;
  if (
    wrapperStatus === "unknown" ||
    listenerStatus === "unknown" ||
    wrapperStatus === "mismatch" ||
    listenerStatus === "mismatch"
  )
    return;

  // The CLI wrapper can exit before the daemonized listener has published its
  // gateway.pid. Keep the launch intent through that bounded hand-off window;
  // the readiness path (or the adoption timer) will attach the listener's
  // exact identity instead of allowing the close event to erase ownership.
  if (
    options.wrapperExitedCleanly === true &&
    currentOwnership.listenerPid === null &&
    readPidFileEntry(profile) === null
  ) {
    scheduleGatewayPidAdoption(profile, currentOwnership);
    return;
  }

  // A live PID file that is neither the adopted listener nor the exact legacy
  // same-PID target is a replacement/foreign process. Preserve ownership and
  // never clear its durable guard automatically.
  const knownPids = new Set(
    [wrapper?.pid, listener?.pid].filter(
      (value): value is number => value !== undefined,
    ),
  );
  if (
    pidEntry !== null &&
    pidEntry.pid !== currentOwnership.preLaunchPid &&
    !knownPids.has(pidEntry.pid) &&
    pidIsAliveAs(pidEntry.pid, GATEWAY_IMAGE_PREFIXES)
  ) {
    return;
  }
  try {
    // Remove the exact listener marker before dropping durable ownership. The
    // daemon PID is normally different from the short-lived wrapper PID, so
    // clearing only spawnedPid would leave a stale gateway.pid behind.
    const expectedPid =
      currentOwnership.listenerPid ?? currentOwnership.spawnedPid;
    if (expectedPid !== null) {
      clearPidFileBestEffort(profile, expectedPid);
    }
    gatewayProcessOwnership.clearLaunch(
      currentOwnership.profileId,
      currentOwnership.launchId,
    );
  } catch {
    // A later cold start will re-evaluate the bounded record.
  }
}

function retainFailedSpawnOwnershipUntilExit(
  profile: string | undefined,
  proc: ChildProcess,
  ownership: GatewayLaunchOwnershipRecord,
  spawnedEvidence: ProcessIdentityEvidence | null = null,
): void {
  if (typeof proc.pid !== "number") return;
  const key = ownership.profileId;
  const trackedOwnership = {
    ...ownership,
    spawnedPid: proc.pid,
    spawnedIdentity:
      ownership.spawnedIdentity ?? spawnedEvidence?.identity ?? null,
    spawnedImage: ownership.spawnedImage ?? spawnedEvidence?.image ?? null,
  };
  let completed = false;
  const complete = (): void => {
    if (completed) return;
    completed = true;
    const timer = gatewayOwnershipTerminationTimers.get(key);
    if (timer) clearTimeout(timer);
    gatewayOwnershipTerminationTimers.delete(key);
    if (gatewayProcesses.get(key) === proc) gatewayProcesses.delete(key);
    appStartedProfiles.delete(key);
    preparedGatewayKeys.delete(key);
    clearCompletedGatewayOwnership(profile, trackedOwnership);
    invalidateApiCacheFor(profile);
  };
  proc.once("close", complete);
  proc.once("error", () => {
    if (!isChildProcessAlive(proc)) complete();
  });
  gatewayProcesses.set(key, proc);
  appStartedProfiles.add(key);
  // A persistence failure still has to obey the same identity gate as every
  // other TERM/KILL path. If the spawn-time evidence was unavailable, keep the
  // durable intent ambiguous and let an explicit operator/recovery path decide
  // what to do; a bare ChildProcess handle is not enough to signal safely.
  signalOwnedTarget(wrapperTarget(trackedOwnership), proc, "SIGTERM");
  if (!isChildProcessAlive(proc)) {
    complete();
    return;
  }
  scheduleGatewayOwnershipTermination(profile, trackedOwnership, 0, {
    trackedProcess: proc,
    acceptUncommittedSpawnedPid: true,
  });
}

/**
 * Stop a single profile's gateway. Defaults to the active profile. By design
 * this only touches the named profile — switching profiles, app exit, etc.
 * must never take down a *different* profile's gateway (and its bots).
 */
export function stopGateway(
  profileOrForce?: string | boolean,
  force = false,
): void {
  const profile =
    typeof profileOrForce === "boolean" ? undefined : profileOrForce;
  const shouldForce =
    typeof profileOrForce === "boolean" ? profileOrForce : force;
  const key = profileKey(profile);
  if (!shouldForce && !appStartedProfiles.has(key)) return;
  cancelGatewayPidAdoption(profile);

  // A malformed or durably-unpromoted ledger is an authorization failure, not
  // evidence that the PID is safe to kill.  Keep both the durable file and any
  // in-memory handle untouched until a later explicit recovery can obtain a
  // fresh identity/image proof.
  if (gatewayProcessOwnership?.getLoadIssue() !== null) {
    console.warn(
      `[gateway:${key}] Refusing to stop a gateway while ownership state is unavailable.`,
    );
    // Drop only the process-manager's in-memory claim.  The OS process and
    // durable ledger remain untouched; retaining a stale handle in this map
    // would make a later app-wide shutdown retry an unverified target after a
    // corrupt ledger has already denied authorization.
    gatewayProcesses.delete(key);
    appStartedProfiles.delete(key);
    stopTuiGatewayClient(profile);
    return;
  }

  let ownership: GatewayLaunchOwnershipRecord | null = null;
  try {
    ownership = gatewayProcessOwnership?.get(key) ?? null;
  } catch {
    // Without valid durable evidence, retain the durable guard and refuse an
    // unverified PID stop below.
  }

  // Close our sockets while the gateway is still listening. Once it starts
  // shutting down it closes them itself and parks a TIME_WAIT on its own port.
  drainGatewayConnections(profile);

  const proc = gatewayProcesses.get(key);
  const wrapper = ownership === null ? null : wrapperTarget(ownership);
  if (proc && isChildProcessAlive(proc)) {
    // Never let a live ChildProcess handle bypass the durable creation/image
    // proof. A reused PID must be left untouched (and its ownership record
    // retained for an explicit, better-evidenced recovery decision).
    if (ownership !== null) {
      const wrapperStatus = ownedTargetStatus(wrapper, proc);
      if (wrapperStatus === "alive") {
        signalOwnedTarget(wrapper, proc, "SIGTERM");
      } else {
        // Detach a stale in-memory handle after a failed proof. The durable
        // record remains as the fail-closed guard and can be reviewed/recovered
        // later, while subsequent starts must not mistake this handle for a
        // currently managed Gateway.
        gatewayProcesses.delete(key);
        appStartedProfiles.delete(key);
      }
    } else {
      console.warn(
        `[gateway:${key}] Refusing to stop an unrecorded Gateway process without identity evidence.`,
      );
      gatewayProcesses.delete(key);
      appStartedProfiles.delete(key);
    }
  }
  const trackedProcessStillAlive = proc ? isChildProcessAlive(proc) : false;
  if (!trackedProcessStillAlive) gatewayProcesses.delete(key);

  const pidEntry = readPidFileEntry(profile);
  const listener =
    ownership === null ? null : listenerTarget(ownership, pidEntry);
  if (listener !== null && listener.pid !== proc?.pid) {
    // A synchronous stop can only signal a listener after a fresh identity
    // proof. Missing/mismatched evidence leaves the durable record intact for
    // the bounded async retry/recovery path.
    signalOwnedTarget(listener, null, "SIGTERM");
  }
  appStartedProfiles.delete(key);
  preparedGatewayKeys.delete(key);
  const wrapperAlive = ownedTargetStatus(wrapper, proc);
  const listenerAlive = ownedTargetStatus(listener);
  if (
    ownership !== null &&
    (wrapperAlive !== "dead" || listenerAlive !== "dead")
  ) {
    scheduleGatewayOwnershipTermination(profile, ownership);
  } else if (ownership !== null) {
    clearCompletedGatewayOwnership(profile, ownership);
  } else {
    clearPidFileBestEffort(profile);
  }
  invalidateApiCacheFor(profile);
  stopTuiGatewayClient(profile);
}

export async function stopAeraOwnedGateways(): Promise<void> {
  const profiles = new Set<string>(appStartedProfiles);
  for (const profile of gatewayProcessOwnership?.listCurrentProcessProfiles() ??
    []) {
    profiles.add(profile);
  }
  const sortedProfiles = [...profiles].sort();
  const results: PromiseSettledResult<void>[] = [];
  if (process.platform === "win32") {
    for (const profile of sortedProfiles) {
      const [result] = await Promise.allSettled([
        stopAeraOwnedGateway(profile),
      ]);
      results.push(result);
    }
  } else {
    results.push(
      ...(await Promise.allSettled(
        sortedProfiles.map((profile) => stopAeraOwnedGateway(profile)),
      )),
    );
  }
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length > 0) {
    const details = errors
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join("; ");
    throw new AggregateError(errors, `Aera gateway cleanup failed: ${details}`);
  }
}

async function stopAeraOwnedGateway(profile: string): Promise<void> {
  const key = profileKey(profile);
  cancelGatewayPidAdoption(profile);
  // App teardown is not allowed to weaken the synchronous stop boundary. A
  // corrupt/truncated pending transaction means the durable launch identity
  // may differ from this instance's cached record, so no ChildProcess handle
  // or PID may be signalled until the ledger is readable again.
  if (
    gatewayProcessOwnership === null ||
    gatewayProcessOwnership.getLoadIssue() !== null
  ) {
    throw new Error(
      `Aera gateway ownership is unavailable for ${key}; refusing an unverified process stop.`,
    );
  }
  const proc = gatewayProcesses.get(key) ?? null;
  // App shutdown uses the process-tree path rather than stopGateway(). Drain
  // the same loopback pools here while the listener is still alive, otherwise
  // a fast Electron relaunch can recreate the TIME_WAIT bind collision.
  drainGatewayConnections(profile);
  let ownership: GatewayLaunchOwnershipRecord | null = null;
  try {
    ownership = gatewayProcessOwnership?.get(key) ?? null;
  } catch {
    // Without a valid durable record, only the exact in-memory child is owned.
  }

  stopTuiGatewayClient(profile);
  const trackedProcessWasAlive = proc !== null && isChildProcessAlive(proc);
  if (trackedProcessWasAlive) {
    if (
      ownership !== null &&
      ownership.spawnedPid !== null &&
      proc?.pid !== ownership.spawnedPid
    ) {
      throw new Error(
        `Aera gateway ownership identity changed for ${key}; refusing an unverified process stop.`,
      );
    }
    if (ownership !== null) {
      const wrapperStatus = ownedTargetStatus(wrapperTarget(ownership), proc);
      if (wrapperStatus !== "alive") {
        throw new Error(
          `Aera gateway wrapper identity could not be verified for ${key}; refusing an unverified process stop.`,
        );
      }
    } else {
      // A process handle without a durable creation token is not enough to
      // authorize a shutdown during app teardown. Leave it for explicit
      // operator recovery rather than risking a reused PID.
      throw new Error(
        `Aera gateway ownership is unavailable for ${key}; refusing an unverified process stop.`,
      );
    }
    const result = await terminateProcessTree(proc!, {
      detachedProcessGroup: process.platform !== "win32",
      forceAfterMs: 3_000,
      verifyRootOwnership: (pid) => {
        if (pid !== wrapperTarget(ownership!)?.pid) return false;
        try {
          const current = gatewayProcessOwnership?.get(key) ?? null;
          return (
            current?.launchId === ownership!.launchId &&
            ownedTargetStatus(wrapperTarget(current), proc) === "alive"
          );
        } catch {
          return false;
        }
      },
      ...(process.platform === "win32"
        ? {
            commandTimeoutMs: 3_000,
            snapshotTimeoutMs: 3_000,
            snapshotTotalBudgetMs: 6_000,
            diagnosticProfileKey: key,
          }
        : {}),
    });
    if (result.remainingPids.length > 0) {
      throw new Error(
        `Aera gateway process tree did not fully exit: ${result.remainingPids.join(",")}`,
      );
    }
    // A successful bounded tree result is the lifecycle authority. Test
    // doubles and a few Windows child handles may not emit `close` or update
    // `exitCode` synchronously, so retaining the handle here would make the
    // ownership scheduler believe the wrapper is still alive and wait until
    // its retry budget expires.
    if (gatewayProcesses.get(key) === proc) gatewayProcesses.delete(key);
  }
  if (!proc || !isChildProcessAlive(proc)) gatewayProcesses.delete(key);

  const pidEntry = readPidFileEntry(profile);
  const latestOwnership = gatewayProcessOwnership?.get(key) ?? ownership;
  const listener =
    latestOwnership === null ? null : listenerTarget(latestOwnership, pidEntry);
  if (listener !== null && listener.pid !== proc?.pid) {
    const listenerStatus = ownedTargetStatus(listener);
    if (listenerStatus === "unknown") {
      throw new Error(
        `Aera gateway listener identity could not be verified for ${key}; refusing an unverified process stop.`,
      );
    }
    if (listenerStatus === "mismatch") {
      throw new Error(
        `Aera gateway listener identity changed for ${key}; refusing an unverified process stop.`,
      );
    }
    if (listenerStatus === "alive") {
      const result = await terminateProcessTreeByPid(listener.pid, {
        detachedProcessGroup: false,
        forceAfterMs: 3_000,
        verifyRootOwnership: (pid) => {
          if (pid !== listener.pid || readPidFile(profile) !== pid)
            return false;
          try {
            const current = gatewayProcessOwnership?.get(key) ?? null;
            return (
              current?.launchId === latestOwnership?.launchId &&
              ownedTargetStatus(
                current === null
                  ? null
                  : listenerTarget(current, readPidFileEntry(profile)),
              ) === "alive"
            );
          } catch {
            return false;
          }
        },
        ...(process.platform === "win32"
          ? {
              commandTimeoutMs: 3_000,
              snapshotTimeoutMs: 3_000,
              snapshotTotalBudgetMs: 6_000,
              diagnosticProfileKey: key,
            }
          : {}),
      });
      if (result.remainingPids.length > 0) {
        throw new Error(
          `Aera gateway listener process tree did not fully exit: ${result.remainingPids.join(",")}`,
        );
      }
      // The listener has just been identity-verified and fully drained. Clear
      // only its still-matching pid marker before any durable ownership
      // reconciliation can drop the record; otherwise a wrapper/listener
      // adoption leaves a stale gateway.pid behind.
      clearPidFileBestEffort(profile, listener.pid);
    }
  }

  appStartedProfiles.delete(key);
  preparedGatewayKeys.delete(key);
  invalidateApiCacheFor(profile);
  if (latestOwnership !== null) {
    const knownPids = new Set(
      [
        wrapperTarget(latestOwnership)?.pid,
        listenerTarget(latestOwnership, pidEntry)?.pid,
      ].filter((value): value is number => value !== undefined),
    );
    const replacementPid =
      pidEntry !== null &&
      pidEntry.pid !== latestOwnership.preLaunchPid &&
      !knownPids.has(pidEntry.pid) &&
      pidIsAliveAs(pidEntry.pid, GATEWAY_IMAGE_PREFIXES);
    if (replacementPid) {
      // A different process now occupies the Profile. Preserve the durable
      // record so a later cold recovery can classify it; never clear or signal
      // the replacement from this shutdown path.
      return;
    }
    reconcileCompletedGatewayOwnership(profile, latestOwnership);
    try {
      if (gatewayProcessOwnership?.get(latestOwnership.profileId) !== null) {
        scheduleGatewayOwnershipTermination(profile, latestOwnership);
        await waitForGatewayOwnershipTermination(latestOwnership);
      }
    } catch (error) {
      // Keep the durable record for a later cold-start reconciliation.
      throw new Error(
        `Aera gateway ownership cleanup could not be confirmed for ${key}.`,
        {
          cause: error,
        },
      );
    }
  } else {
    // Without durable ownership, only the exact in-memory child above was
    // ours. Never remove or signal an unrelated PID file.
  }
}

export function recoverAeraOwnedGatewaysFromPreviousRun(): {
  reapedProfiles: string[];
  ambiguousProfiles: string[];
  errorCode?: GatewayProcessOwnershipErrorCode;
} {
  if (gatewayProcessOwnership === null) {
    return { reapedProfiles: [], ambiguousProfiles: [] };
  }
  const initialLoadIssue = gatewayProcessOwnership.getLoadIssue();
  let recovery: {
    ownedProfiles: string[];
    ambiguousProfiles: string[];
  };
  try {
    recovery = gatewayProcessOwnership.reconcileColdStart({
      readCurrentPid: (profileId) => readPidFile(profileId),
      isAlive: (pid) => pidIsAliveAs(pid, GATEWAY_IMAGE_PREFIXES),
      readEvidence: (pid) => readGatewayProcessEvidence(pid),
      clearDeadListenerPid: (profileId, pid) =>
        clearPidFileBestEffort(profileId, pid),
    });
  } catch (error) {
    const errorCode =
      error instanceof GatewayProcessOwnershipError
        ? error.code
        : "ownership_persistence_failed";
    return {
      reapedProfiles: [],
      ambiguousProfiles: gatewayProcessOwnership.listProfiles(),
      errorCode,
    };
  }
  const reapedProfiles: string[] = [];
  const ambiguousProfiles = new Set(recovery.ambiguousProfiles);
  for (const profile of recovery.ownedProfiles) {
    const result = reapRecoveredAeraOwnedGateway(profile);
    if (result === "reaped") reapedProfiles.push(profile);
    if (result === "ambiguous") ambiguousProfiles.add(profile);
  }
  const result: {
    reapedProfiles: string[];
    ambiguousProfiles: string[];
    errorCode?: GatewayProcessOwnershipErrorCode;
  } = {
    reapedProfiles: reapedProfiles.sort(),
    ambiguousProfiles: [...ambiguousProfiles].sort(),
  };
  const loadIssue = gatewayProcessOwnership.getLoadIssue() ?? initialLoadIssue;
  if (loadIssue !== null) result.errorCode = loadIssue;
  return result;
}

function reapRecoveredAeraOwnedGateway(
  profile: string,
): "reaped" | "inactive" | "ambiguous" {
  if (gatewayProcessOwnership === null) return "ambiguous";
  let ownership: GatewayLaunchOwnershipRecord | null;
  try {
    ownership = gatewayProcessOwnership.get(profile);
  } catch {
    return "ambiguous";
  }
  if (ownership === null) {
    return "ambiguous";
  }

  const pidEntry = readPidFileEntry(profile);
  const listener = listenerTarget(ownership, pidEntry);
  if (listener === null || pidEntry === null || pidEntry.pid !== listener.pid) {
    return "ambiguous";
  }
  const listenerStatus = ownedTargetStatus(listener);
  if (listenerStatus === "unknown") return "ambiguous";
  if (listenerStatus === "dead") {
    try {
      clearPidFileBestEffort(profile, listener.pid);
      gatewayProcessOwnership.clearLaunch(profile, ownership.launchId);
      return "inactive";
    } catch {
      return "ambiguous";
    }
  }

  if (!signalOwnedTarget(listener, null, "SIGTERM")) {
    // A failed revalidation (including PID reuse or missing evidence) is an
    // ambiguity, never permission to clear or signal a replacement process.
    if (ownedTargetStatus(listener) !== "dead") return "ambiguous";
    try {
      clearPidFileBestEffort(profile, listener.pid);
      gatewayProcessOwnership.clearLaunch(profile, ownership.launchId);
      return "inactive";
    } catch {
      return "ambiguous";
    }
  }

  // A listener can exit synchronously in response to TERM (especially during
  // cold recovery). Re-check the complete identity proof immediately so an
  // exact dead target does not leave a stale gateway.pid while the bounded
  // retry timer is still pending. A reused or unreadable PID remains
  // ambiguous and is never cleared here.
  if (ownedTargetStatus(listener) === "dead") {
    try {
      clearPidFileBestEffort(profile, listener.pid);
      gatewayProcessOwnership.clearLaunch(profile, ownership.launchId);
      return "inactive";
    } catch {
      return "ambiguous";
    }
  }

  gatewayProcesses.delete(profileKey(profile));
  appStartedProfiles.delete(profileKey(profile));
  invalidateApiCacheFor(profile);
  stopTuiGatewayClient(profile);
  scheduleGatewayOwnershipTermination(profile, ownership);
  return "ambiguous";
}

const GATEWAY_TERMINATION_RETRY_MS = 100;
const GATEWAY_TERMINATION_GRACE_ATTEMPTS = 10;
const GATEWAY_TERMINATION_FORCE_ATTEMPTS = 20;
const GATEWAY_EADDRINUSE_RETRY_DELAY_MS = 35_000;

async function waitForGatewayOwnershipTermination(
  ownership: GatewayLaunchOwnershipRecord,
): Promise<void> {
  const deadline =
    Date.now() +
    GATEWAY_TERMINATION_RETRY_MS * (GATEWAY_TERMINATION_FORCE_ATTEMPTS + 3);
  while (Date.now() < deadline) {
    const current = gatewayProcessOwnership?.get(ownership.profileId) ?? null;
    if (current === null) return;
    if (current.launchId !== ownership.launchId) {
      throw new Error("Aera gateway ownership changed during cleanup.");
    }
    await delay(GATEWAY_TERMINATION_RETRY_MS);
  }
  throw new Error("Aera gateway ownership cleanup did not finish in time.");
}

function gatewayLogReportsAddressInUse(
  profile?: string,
  fromByteOffset = 0,
): boolean {
  try {
    const log = readFileSync(gatewayLogPath(profile));
    return /EADDRINUSE|address already in use|already in use/iu.test(
      log.subarray(Math.max(0, fromByteOffset)).toString("utf8"),
    );
  } catch {
    return false;
  }
}

interface GatewayOwnershipTerminationTracking {
  trackedProcess?: ChildProcess;
  acceptUncommittedSpawnedPid?: boolean;
}

function scheduleGatewayOwnershipTermination(
  profile: string | undefined,
  ownership: GatewayLaunchOwnershipRecord,
  attempt = 0,
  tracking: GatewayOwnershipTerminationTracking = {},
): void {
  const key = ownership.profileId;
  const existing = gatewayOwnershipTerminationTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    gatewayOwnershipTerminationTimers.delete(key);
    if (gatewayProcessOwnership === null) return;
    let current: GatewayLaunchOwnershipRecord | null;
    try {
      current = gatewayProcessOwnership.get(key);
    } catch {
      return;
    }
    if (current === null || current.launchId !== ownership.launchId) {
      return;
    }

    const trackedProcess = tracking.trackedProcess;
    const pidEntry = readPidFileEntry(profile);
    const targets: GatewayOwnedProcessTarget[] = [];
    const wrapper = wrapperTarget(current);
    const listener = listenerTarget(current, pidEntry);
    if (wrapper !== null) targets.push(wrapper);
    if (
      listener !== null &&
      !targets.some((target) => target.pid === listener.pid)
    ) {
      targets.push(listener);
    }
    // A markSpawned persistence failure can leave the launch record at its
    // intent state while the exact ChildProcess is still alive. Keep the
    // launch-scoped handle eligible for termination, but never invent a
    // durable PID target from an unverified pid file.
    if (
      targets.length === 0 &&
      tracking.acceptUncommittedSpawnedPid === true &&
      trackedProcess?.pid !== undefined
    ) {
      targets.push({
        pid: trackedProcess.pid,
        identity: null,
        image: null,
        kind: "wrapper",
      });
    }

    let aliveTarget = false;
    let uncertainTarget = false;
    for (const target of targets) {
      const status = ownedTargetStatus(
        target,
        target.kind === "wrapper" ? trackedProcess : null,
      );
      if (status === "alive") {
        aliveTarget = true;
        if (attempt >= GATEWAY_TERMINATION_GRACE_ATTEMPTS) {
          // Re-read the pid file immediately before listener escalation, then
          // run the same identity/image gate used by ordinary TERM. A changed
          // file, PID reuse, or unavailable evidence is never signalled.
          if (
            target.kind !== "listener" ||
            readPidFile(profile) === target.pid
          ) {
            if (
              !signalOwnedTarget(
                target,
                target.kind === "wrapper" ? (trackedProcess ?? null) : null,
                "SIGKILL",
              )
            ) {
              uncertainTarget = true;
            }
          } else {
            uncertainTarget = true;
          }
        }
      } else if (status === "unknown" || status === "mismatch") {
        uncertainTarget = true;
      }
    }

    if (!aliveTarget && !uncertainTarget) {
      clearCompletedGatewayOwnership(profile, current);
      return;
    }

    if (attempt < GATEWAY_TERMINATION_FORCE_ATTEMPTS) {
      scheduleGatewayOwnershipTermination(
        profile,
        current,
        attempt + 1,
        tracking,
      );
    } else {
      console.warn(
        `[gateway-ownership:${key}] termination_unconfirmed; retaining durable ownership.`,
      );
    }
  }, GATEWAY_TERMINATION_RETRY_MS);
  gatewayOwnershipTerminationTimers.set(key, timer);
}

function clearCompletedGatewayOwnership(
  profile: string | undefined,
  ownership: GatewayLaunchOwnershipRecord,
): void {
  // After wrapper/listener adoption gateway.pid names the long-lived
  // listener, not the short-lived spawn wrapper. Prefer that exact durable
  // PID when clearing the file; falling back to spawnedPid preserves legacy
  // same-PID records without ever unlinking a replacement PID file.
  const expectedPid = ownership.listenerPid ?? ownership.spawnedPid;
  if (expectedPid !== null) {
    clearPidFileBestEffort(profile, expectedPid);
  }
  try {
    gatewayProcessOwnership?.clearLaunch(
      ownership.profileId,
      ownership.launchId,
    );
  } catch {
    // A later cold start will retry the exact durable record.
  }
}

function clearPidFileBestEffort(
  profile: string | undefined,
  expectedPid?: number,
): boolean {
  const pidEntry = readPidFileEntry(profile);
  if (pidEntry === null) return true;
  if (expectedPid !== undefined && pidEntry.pid !== expectedPid) return false;
  try {
    unlinkSync(pidEntry.path);
    return true;
  } catch {
    // A stale exact PID is still guarded by process-image verification.
    return false;
  }
}

/**
 * Explicitly replace a healthy, unrecorded legacy Gateway during the native
 * restart/takeover flow.  Ordinary shutdown paths must never use this helper:
 * they have no durable proof that a PID-file process belongs to Aera.  The
 * caller supplies the PID observed immediately before the restart and this
 * function re-reads the file and verifies liveness before handing the exact
 * PID to the bounded process-tree terminator.  A changed PID, unavailable
 * liveness evidence, or an incompletely drained tree is a failed takeover;
 * none of those cases signal a replacement process.
 */
async function stopLegacyGatewayForTakeover(
  profile: string | undefined,
  expectedPidEntry: { path: string; pid: number },
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const current = readPidFileEntry(profile);
  if (current === null || current.pid !== expectedPidEntry.pid) {
    return false;
  }
  if (!pidIsAliveAs(current.pid, GATEWAY_IMAGE_PREFIXES)) {
    clearPidFileBestEffort(profile, current.pid);
    return true;
  }
  const expectedEvidence = readGatewayProcessEvidence(current.pid);
  if (!isGatewayProcessEvidence(expectedEvidence)) return false;

  drainGatewayConnections(profile);
  try {
    const result = await terminateProcessTreeByPid(current.pid, {
      detachedProcessGroup: false,
      forceAfterMs: Math.max(0, timeoutMs),
      pollIntervalMs: Math.max(1, pollMs),
      verifyRootOwnership: (pid) =>
        pid === current.pid &&
        readPidFile(profile) === pid &&
        gatewayProcessEvidenceStillMatches(pid, expectedEvidence),
      ...(process.platform === "win32"
        ? {
            // The snapshot/taskkill tooling budget is a platform property,
            // not a caller property: one CIM attempt plus one WMI fallback
            // cannot complete inside an arbitrarily small stop budget on a
            // loaded host, and a timed-out snapshot fail-closes the takeover
            // before taskkill ever runs. Match the same floor the owned
            // shutdown path uses. Every fail-closed check above is unchanged.
            commandTimeoutMs: 3_000,
            snapshotTimeoutMs: 3_000,
            snapshotTotalBudgetMs: 6_000,
            diagnosticProfileKey: profileKey(profile),
          }
        : {}),
    });
    if (result.remainingPids.length > 0) {
      return false;
    }
  } catch {
    return false;
  }

  // Only remove the legacy marker if the file still names the exact process
  // we just drained.  A concurrently published replacement remains intact.
  clearPidFileBestEffort(profile, current.pid);
  return true;
}

// Python image prefixes covering both native Windows (pythonw.exe / python.exe)
// and POSIX (python, python3, pythonw). Used to verify the PID we read from
// gateway.pid actually belongs to a python process before reporting alive.
const GATEWAY_IMAGE_PREFIXES = ["python", "pythonw"];

type GatewayOwnedProcessTarget = {
  pid: number;
  identity: string | null;
  image: string | null;
  kind: "wrapper" | "listener";
};

function wrapperTarget(
  ownership: GatewayLaunchOwnershipRecord,
): GatewayOwnedProcessTarget | null {
  if (ownership.spawnedPid === null) return null;
  const hasSpawnedEvidence =
    ownership.spawnedIdentity !== null && ownership.spawnedImage !== null;
  const hasSamePidListenerEvidence =
    ownership.listenerPid === ownership.spawnedPid &&
    ownership.listenerIdentity !== null &&
    ownership.listenerImage !== null;
  // Windows can keep the Gateway in the foreground, so gateway.pid names the
  // exact ChildProcess PID. If the cold spawn-time CIM read missed its bounded
  // window but readiness later captured and durably adopted that same PID,
  // the listener proof is also valid proof for the tracked process. This does
  // not authorize a cross-PID hand-off: different wrapper/listener PIDs retain
  // their independent evidence and every signal still re-reads the identity.
  const identity = hasSpawnedEvidence
    ? ownership.spawnedIdentity
    : hasSamePidListenerEvidence
      ? ownership.listenerIdentity
      : ownership.spawnedIdentity;
  const image = hasSpawnedEvidence
    ? ownership.spawnedImage
    : hasSamePidListenerEvidence
      ? ownership.listenerImage
      : ownership.spawnedImage;
  return {
    pid: ownership.spawnedPid,
    identity,
    image,
    kind: "wrapper",
  };
}

function listenerTarget(
  ownership: GatewayLaunchOwnershipRecord,
  pidEntry?: { pid: number } | null,
): GatewayOwnedProcessTarget | null {
  if (ownership.listenerPid !== null) {
    return {
      pid: ownership.listenerPid,
      identity: ownership.listenerIdentity,
      image: ownership.listenerImage,
      kind: "listener",
    };
  }
  // Compatibility for v1/v2 records and non-daemonized test/Runtime
  // launches: only treat the spawned PID as the listener when the pid file
  // names that exact same PID. A cross-PID hand-off without explicit listener
  // evidence remains ambiguous and is never signalled.
  if (pidEntry?.pid !== undefined && ownership.spawnedPid === pidEntry.pid) {
    return {
      pid: ownership.spawnedPid,
      identity: ownership.spawnedIdentity,
      image: ownership.spawnedImage,
      kind: "listener",
    };
  }
  return null;
}

type OwnedTargetStatus = "alive" | "dead" | "unknown" | "mismatch";

interface OwnedTargetInspection {
  status: OwnedTargetStatus;
  observed: ProcessIdentityEvidence | null;
}

/**
 * Refresh every piece of process evidence in one place immediately before a
 * lifecycle decision. `mismatch` is deliberately distinct from `dead`: a
 * live PID with a different creation token/image is a possible PID reuse and
 * must keep the durable ownership guard rather than being silently cleared.
 */
function inspectOwnedTarget(
  target: GatewayOwnedProcessTarget | null,
  trackedProcess?: ChildProcess | null,
): OwnedTargetInspection {
  if (target === null) return { status: "dead", observed: null };

  const trackedAlive =
    target.kind === "wrapper" &&
    trackedProcess?.pid === target.pid &&
    isChildProcessAlive(trackedProcess);
  const observed = readGatewayProcessEvidence(target.pid);

  // A ChildProcess exit state is definitive. For a PID-only target, a false
  // liveness probe is treated as dead unless it supplied contradictory live
  // evidence; an unavailable identity while the PID is live is unknown.
  const live = trackedAlive || pidIsAliveAs(target.pid, GATEWAY_IMAGE_PREFIXES);
  if (!live) {
    if (
      observed !== null &&
      target.identity !== null &&
      target.image !== null &&
      !processEvidenceMatches(observed, {
        identity: target.identity,
        image: target.image,
      })
    ) {
      return { status: "mismatch", observed };
    }
    return { status: "dead", observed };
  }

  // A PID/handle is never ownership evidence by itself. Missing or unreadable
  // identity/image data is an ambiguous live target; callers must not signal
  // or clear it automatically.
  if (target.identity === null || target.image === null || observed === null) {
    return { status: "unknown", observed };
  }
  return processEvidenceMatches(observed, {
    identity: target.identity,
    image: target.image,
  })
    ? { status: "alive", observed }
    : { status: "mismatch", observed };
}

function ownedTargetStatus(
  target: GatewayOwnedProcessTarget | null,
  trackedProcess?: ChildProcess | null,
): OwnedTargetStatus {
  return inspectOwnedTarget(target, trackedProcess).status;
}

/**
 * Revalidate a target and send one signal only when its creation identity and
 * canonical executable image still match the durable record. There is no
 * fallback to a raw PID/ChildProcess kill on an unknown or mismatched probe.
 */
function signalOwnedTarget(
  target: GatewayOwnedProcessTarget | null,
  trackedProcess: ChildProcess | null,
  signal: NodeJS.Signals,
): boolean {
  const inspection = inspectOwnedTarget(target, trackedProcess);
  if (inspection.status !== "alive" || target === null) return false;
  try {
    if (
      target.kind === "wrapper" &&
      trackedProcess !== null &&
      trackedProcess?.pid === target.pid &&
      isChildProcessAlive(trackedProcess)
    ) {
      trackedProcess.kill(signal);
      return true;
    }
    process.kill(target.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function isChildProcessAlive(proc: ChildProcess): boolean {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return false;
  }
  if (typeof proc.pid !== "number") return !proc.killed;
  try {
    process.kill(proc.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isGatewayRunning(profile?: string): boolean {
  const key = profileKey(profile);
  if (gatewayProcessOwnership?.getLoadIssue() !== null) return false;
  let ownership: GatewayLaunchOwnershipRecord | null = null;
  try {
    ownership = gatewayProcessOwnership?.get(key) ?? null;
  } catch {
    return false;
  }

  const proc = gatewayProcesses.get(key);
  if (proc && typeof proc.pid === "number") {
    if (ownership === null) {
      return (
        isChildProcessAlive(proc) &&
        isGatewayProcessEvidence(readGatewayProcessEvidence(proc.pid))
      );
    }
    const target = wrapperTarget(ownership);
    return (
      target !== null &&
      target.pid === proc.pid &&
      ownedTargetStatus(target, proc) === "alive"
    );
  }

  const pidEntry = readPidFileEntry(profile);
  if (pidEntry === null) return false;
  if (ownership !== null) {
    const target = listenerTarget(ownership, pidEntry);
    return (
      target !== null &&
      target.pid === pidEntry.pid &&
      ownedTargetStatus(target) === "alive"
    );
  }
  // An unrecorded legacy Gateway is deliberately not reported as owned/running
  // by this status primitive. The explicit recovery path performs its own
  // fresh identity/image probe before deciding whether a takeover is safe.
  return (
    pidIsAliveAs(pidEntry.pid, GATEWAY_IMAGE_PREFIXES) &&
    isGatewayProcessEvidence(readGatewayProcessEvidence(pidEntry.pid))
  );
}

export function isApiReady(): boolean {
  return apiServerAvailable === true;
}

export function isGatewayHealthy(profile?: string): Promise<boolean> {
  return isApiServerReady(profile);
}

export function testRemoteConnection(
  url: string,
  apiKey?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = getConnectionConfig();
    const configuredOAuth =
      apiKey === undefined &&
      conn.mode === "remote" &&
      conn.remoteAuthMode === "oauth" &&
      normaliseRemoteUrl(conn.remoteUrl) === normaliseRemoteUrl(url);
    const target = `${normaliseRemoteUrl(url)}${
      configuredOAuth ? "/api/status" : "/health"
    }`;
    const mod = target.startsWith("https") ? https : http;
    const headers: Record<string, string> = {};
    const resolvedApiKey = resolveRemoteApiKey(url, apiKey);
    if (resolvedApiKey) headers.Authorization = `Bearer ${resolvedApiKey}`;
    const req = mod.request(
      target,
      { method: "GET", timeout: 5000, headers },
      (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitForApiServerStopped(
  profile?: string,
  timeoutMs = 5000,
  pollMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isApiServerReady(profile))) return true;
    await delay(pollMs);
  }
  return false;
}

async function waitForGatewayOwnershipReleased(
  profile?: string,
  timeoutMs = 5000,
  pollMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const key = profileKey(profile);
  while (Date.now() < deadline) {
    let ownership: GatewayLaunchOwnershipRecord | null = null;
    try {
      ownership = gatewayProcessOwnership?.get(key) ?? null;
    } catch {
      return false;
    }
    if (ownership === null) return true;

    const proc = gatewayProcesses.get(key);
    if (!proc || !isChildProcessAlive(proc)) {
      reconcileCompletedGatewayOwnership(profile, ownership);
      try {
        if (gatewayProcessOwnership?.get(key) === null) return true;
      } catch {
        return false;
      }
    }
    await delay(pollMs);
  }
  return false;
}

// The spawn wrapper exits as soon as the gateway daemonizes, and the health
// endpoint stops answering before the listener socket is torn down. Neither
// signal proves the listener is gone, so give it a bounded chance to clear.
//
// This is advisory only — never a gate on launching. Node always sets
// SO_REUSEADDR, so a probe here cannot see the TIME_WAIT sockets that actually
// block the gateway's non-reuse bind on darwin; treating a failed probe as
// fatal would refuse valid launches for a full MSL. That exact regression is
// why upstream removed its own pre-bind check (hermes#10297). Prevention lives
// in drainGatewayConnections(); this only avoids racing a live listener.
async function waitForGatewayPortReleased(
  port: number,
  profile?: string,
  timeoutMs = 5000,
  pollMs = 250,
): Promise<boolean> {
  const key = profileKey(profile);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    if (await isLoopbackPortReleased(port)) return true;
    if (Date.now() >= deadline) {
      console.warn(
        `[gateway:${key}] Port ${String(port)} not confirmed free after ${String(timeoutMs)}ms (${String(attempts)} probes); launching anyway`,
      );
      return false;
    }
    await delay(pollMs);
  }
}

function gatewayRestartProfileKey(profile?: string): string {
  return profileKey(profile);
}

let gatewayRestartQueueTail: Promise<unknown> = Promise.resolve();
const gatewayRestartByProfile = new Map<string, Promise<boolean>>();
const GATEWAY_RECOVERY_REGISTRY_KEY = "__aeraGatewayRecoveryByProfile";
type GatewayRecoveryRegistry = Map<string, Promise<boolean>>;
const gatewayRecoveryByProfile: GatewayRecoveryRegistry = (() => {
  // Keep this on the Node process object rather than module/global scope. The
  // Electron main bundle can evaluate the Gateway module through more than
  // one loader context; those contexts share `process` but not module-level
  // state. A profile must still have one recovery flight across all of them.
  const globalState = (app ?? process) as typeof app & {
    [GATEWAY_RECOVERY_REGISTRY_KEY]?: unknown;
  };
  const existing = globalState[GATEWAY_RECOVERY_REGISTRY_KEY];
  if (existing instanceof Map) {
    return existing as GatewayRecoveryRegistry;
  }
  const created: GatewayRecoveryRegistry = new Map();
  globalState[GATEWAY_RECOVERY_REGISTRY_KEY] = created;
  return created;
})();

function markGatewayRestartFailed(profile?: string): void {
  const key = profileKey(profile);
  gatewayProcesses.delete(key);
  appStartedProfiles.delete(key);
  invalidateApiCacheFor(profile);
  startHealthPolling();
}

function restoreGatewayAfterRestartFailure(
  profile: string | undefined,
  previousProcess: ChildProcess | null,
  previousStartedByApp: boolean,
  previousPidEntry: { path: string; pid: number } | null = null,
): void {
  const key = profileKey(profile);
  if (previousProcess && isChildProcessAlive(previousProcess)) {
    gatewayProcesses.set(key, previousProcess);
    if (previousStartedByApp) {
      appStartedProfiles.add(key);
    } else {
      appStartedProfiles.delete(key);
    }
    invalidateApiCacheFor(profile);
    startHealthPolling();
    return;
  }
  if (
    previousPidEntry &&
    pidIsAliveAs(previousPidEntry.pid, GATEWAY_IMAGE_PREFIXES)
  ) {
    try {
      writeFileSync(
        previousPidEntry.path,
        String(previousPidEntry.pid),
        "utf-8",
      );
    } catch {
      // best-effort; health polling will still recover API readiness.
    }
    gatewayProcesses.delete(key);
    if (previousStartedByApp) {
      appStartedProfiles.add(key);
    } else {
      appStartedProfiles.delete(key);
    }
    invalidateApiCacheFor(profile);
    startHealthPolling();
    return;
  }
  markGatewayRestartFailed(profile);
}

async function restartGatewayLocallyOnce(
  profile?: string,
  healthTimeoutMs = 30000,
  healthPollMs = 250,
  stopTimeoutMs = 30000,
): Promise<boolean> {
  try {
    if (isRemoteMode()) return false;
    ensureInitialized();
    if (!canSpawnGateway()) return false;
    const invocation = getRuntimeInvocation();
    if (!invocation) return false;

    const key = profileKey(profile);
    const previousProcess = gatewayProcesses.get(key) ?? null;
    const previousStartedByApp = appStartedProfiles.has(key);
    const previousPidEntry = readPidFileEntry(profile);
    // A healthy Gateway that predates the ownership ledger is replaceable only
    // from this explicit restart/takeover flow.  Capture the ledger state
    // before stopGateway() so an unavailable/corrupt ledger cannot silently
    // authorize a PID-file kill.
    let previousOwnership: GatewayLaunchOwnershipRecord | null = null;
    let ownershipStateAvailable = false;
    try {
      if (
        gatewayProcessOwnership !== null &&
        gatewayProcessOwnership.getLoadIssue() === null
      ) {
        ownershipStateAvailable = true;
        previousOwnership = gatewayProcessOwnership.get(key);
      }
    } catch {
      ownershipStateAvailable = false;
    }
    if (
      ownershipStateAvailable &&
      previousOwnership === null &&
      previousPidEntry !== null
    ) {
      const legacyStopped = await stopLegacyGatewayForTakeover(
        profile,
        previousPidEntry,
        stopTimeoutMs,
        healthPollMs,
      );
      if (!legacyStopped) {
        console.error(
          `[gateway:${key}] Native restart refused to take over an unverified legacy Gateway`,
        );
        restoreGatewayAfterRestartFailure(
          profile,
          previousProcess,
          previousStartedByApp,
          previousPidEntry,
        );
        return false;
      }
    }
    stopGateway(profile, true);
    const stopped = await waitForApiServerStopped(
      profile,
      stopTimeoutMs,
      healthPollMs,
    );
    if (!stopped) {
      console.error(
        `[gateway:${key}] Native restart failed: gateway did not stop before restart`,
      );
      restoreGatewayAfterRestartFailure(
        profile,
        previousProcess,
        previousStartedByApp,
        previousPidEntry,
      );
      return false;
    }
    const ownershipReleased = await waitForGatewayOwnershipReleased(
      profile,
      stopTimeoutMs,
      healthPollMs,
    );
    if (!ownershipReleased) {
      console.error(
        `[gateway:${key}] Native restart failed: prior gateway ownership remains active`,
      );
      restoreGatewayAfterRestartFailure(
        profile,
        previousProcess,
        previousStartedByApp,
        previousPidEntry,
      );
      return false;
    }

    const prepared = await prepareGatewayForLaunch(profile);
    const gatewayLog = gatewayLogPath(profile);
    let gatewayLogOffset = 0;
    try {
      gatewayLogOffset = statSync(gatewayLog).size;
    } catch {
      // The launch path creates the log below; an absent file means there is
      // no historical content to exclude.
    }
    const portReleased = await waitForGatewayPortReleased(
      prepared.port,
      profile,
      stopTimeoutMs,
      healthPollMs,
    );
    if (!portReleased) {
      console.warn(
        `[gateway:${key}] Port ${String(prepared.port)} not confirmed free; restarting anyway`,
      );
    }
    const startResult = await startGatewayWithReadiness(profile, prepared, {
      readyTimeoutMs: healthTimeoutMs,
      pollMs: healthPollMs,
      // Recovery is a gateway lifecycle operation.  Dashboard startup is
      // deliberately left to its own caller so it cannot recurse into this
      // recovery flight or create a second Runtime Python process.
      warmDashboard: () => undefined,
    });
    if (startResult.ready === true) return true;

    // uvicorn/aiohttp on macOS may reject a rebind while the old listener's
    // TIME_WAIT entries are still inside the kernel, even after the port has
    // stopped accepting connections. Retry the same prepared launch once
    // after the measured MSL window instead of recursively starting another
    // recovery flight against the same port.
    if (gatewayLogReportsAddressInUse(profile, gatewayLogOffset)) {
      stopGateway(profile, true);
      await delay(GATEWAY_EADDRINUSE_RETRY_DELAY_MS);
      const retryStart = await startGatewayWithReadiness(profile, prepared, {
        readyTimeoutMs: healthTimeoutMs,
        pollMs: healthPollMs,
        warmDashboard: () => undefined,
      });
      if (retryStart.ready === true) return true;
    }
    markGatewayRestartFailed(profile);
    return false;
  } catch (err) {
    console.error("[gateway] Native restart failed:", (err as Error).message);
    markGatewayRestartFailed(profile);
    return false;
  }
}

export function restartGateway(
  profile?: string,
  healthTimeoutMs = 30000,
  healthPollMs = 250,
  stopTimeoutMs = 30000,
): Promise<boolean> {
  // Same defensive gate as startGateway — the local gateway has no role
  // in remote/SSH mode. Cheap to check; catches IPC paths that don't
  // wrap their restart calls in an isRemoteMode() check.
  if (isRemoteMode()) return Promise.resolve(false);

  const key = gatewayRestartProfileKey(profile);
  const existing = gatewayRestartByProfile.get(key);
  if (existing) {
    return existing;
  }

  const queued = gatewayRestartQueueTail.then(
    () =>
      restartGatewayLocallyOnce(
        profile,
        healthTimeoutMs,
        healthPollMs,
        stopTimeoutMs,
      ),
    () =>
      restartGatewayLocallyOnce(
        profile,
        healthTimeoutMs,
        healthPollMs,
        stopTimeoutMs,
      ),
  );

  const promise = queued.finally(() => {
    if (gatewayRestartByProfile.get(key) === promise) {
      gatewayRestartByProfile.delete(key);
    }
  });

  gatewayRestartByProfile.set(key, promise);
  gatewayRestartQueueTail = promise.catch(() => undefined);
  return promise;
}

async function startGatewayWithRecoveryOnce(
  profile?: string,
  healthTimeoutMs = 8000,
  healthPollMs = 250,
  restartCommandTimeoutMs = 15000,
  restartHealthTimeoutMs = 30000,
  restartStopTimeoutMs = 30000,
): Promise<boolean> {
  // Fourth argument kept for call-site compatibility with the earlier CLI
  // restart implementation.
  void restartCommandTimeoutMs;

  if (isRemoteMode()) return false;

  // A model/configuration commit can retire the old Gateway and schedule an
  // asynchronous restart from its presentation-refresh hook. A send that
  // arrives during that small window must join the restart flight instead of
  // preparing a second credential/configuration transaction in parallel. The
  // two operations used to have separate single-flight registries, which made
  // both plans read the same pre-restart `.env` and left the loser with a
  // stale-plan rejection.
  const pendingRestart = gatewayRestartByProfile.get(
    gatewayRestartProfileKey(profile),
  );
  if (pendingRestart) {
    try {
      if (await pendingRestart) {
        setApiCacheFor(profile, true);
        return true;
      }
    } catch {
      // The restart failed; continue through the normal bounded recovery path
      // so a fresh launch can still repair the Profile.
    }
  }

  if (isGatewayRunning(profile)) {
    const key = profileKey(profile);
    if (
      gatewayProcessOwnership === null ||
      gatewayProcessOwnership.getLoadIssue() !== null
    ) {
      console.warn(
        `[gateway:${key}] Refusing to reconcile an unowned gateway because ownership state is unavailable.`,
      );
      return false;
    }
    let ownership: GatewayLaunchOwnershipRecord | null;
    try {
      ownership = gatewayProcessOwnership.get(key);
    } catch {
      console.warn(
        `[gateway:${key}] Refusing to reconcile an unowned gateway because ownership state is invalid.`,
      );
      return false;
    }
    if (ownership === null) {
      return restartGateway(
        profile,
        restartHealthTimeoutMs,
        healthPollMs,
        restartStopTimeoutMs,
      );
    }
    return (
      (await isGatewayHealthy(profile)) ||
      restartGateway(
        profile,
        restartHealthTimeoutMs,
        healthPollMs,
        restartStopTimeoutMs,
      )
    );
  }

  const prepared = await prepareGatewayForLaunch(profile);
  // A process can exit after its close event while its durable ownership
  // record is still being reconciled by the bounded termination timer. Wait
  // for that exact record to clear before beginLaunch(), otherwise a healthy
  // recovery is rejected as ownership_conflict.
  const ownershipReleased = await waitForGatewayOwnershipReleased(
    profile,
    restartStopTimeoutMs,
    Math.max(50, Math.min(250, healthPollMs)),
  );
  if (!ownershipReleased) return false;

  const portReleased = await waitForGatewayPortReleased(
    prepared.port,
    profile,
    restartStopTimeoutMs,
    Math.max(50, Math.min(250, healthPollMs)),
  );
  if (!portReleased) {
    // A gateway whose pid file was lost still answers health checks while
    // holding the port. Adopt it instead of spawning a doomed duplicate.
    if (await isGatewayHealthy(profile)) {
      setApiCacheFor(profile, true);
      return true;
    }
    // Nothing is serving, so the port is held by a socket we cannot observe
    // (TIME_WAIT) or one that is still closing. Fall through and launch: a
    // real EADDRINUSE surfaces as a start failure with the gateway's own log,
    // which is far more actionable than silently refusing to start.
  }
  const startResult = await startGatewayWithReadiness(profile, prepared, {
    readyTimeoutMs: healthTimeoutMs,
    pollMs: healthPollMs,
    warmDashboard: () => undefined,
  });
  if (startResult.ready === true) return true;

  return restartGateway(
    profile,
    restartHealthTimeoutMs,
    healthPollMs,
    restartStopTimeoutMs,
  );
}

/**
 * Recovery is a single-flight operation per Gateway Profile. Several UI
 * surfaces can request readiness for the same Agent turn at once; allowing
 * each caller to prepare config and spawn independently races on the fixed
 * profile port and makes one healthy process look like an ownership/port
 * failure.
 */
export function startGatewayWithRecovery(
  profile?: string,
  healthTimeoutMs = 8000,
  healthPollMs = 250,
  restartCommandTimeoutMs = 15000,
  restartHealthTimeoutMs = 30000,
  restartStopTimeoutMs = 5000,
): Promise<boolean> {
  const key = gatewayRestartProfileKey(profile);
  const existing = gatewayRecoveryByProfile.get(key);
  if (existing) return existing;

  // Publish the in-flight promise before starting the async body. This avoids
  // a same-turn re-entry (two IPC sends can reach this function together)
  // creating two managed plans with different collision-free ports.
  let resolveRecovery!: (value: boolean) => void;
  let rejectRecovery!: (reason?: unknown) => void;
  const promise = new Promise<boolean>((resolve, reject) => {
    resolveRecovery = resolve;
    rejectRecovery = reject;
  }).finally(() => {
    if (gatewayRecoveryByProfile.get(key) === promise) {
      gatewayRecoveryByProfile.delete(key);
    }
  });
  gatewayRecoveryByProfile.set(key, promise);
  void startGatewayWithRecoveryOnce(
    profile,
    healthTimeoutMs,
    healthPollMs,
    restartCommandTimeoutMs,
    restartHealthTimeoutMs,
    restartStopTimeoutMs,
  ).then(resolveRecovery, rejectRecovery);
  return promise;
}

export function restartGatewayViaCli(
  profile?: string,
  healthTimeoutMs = 30000,
  healthPollMs = 250,
): Promise<boolean> {
  if (isRemoteMode()) return Promise.resolve(false);
  const key = gatewayRestartProfileKey(profile);

  const existing = gatewayRestartByProfile.get(key);
  if (existing) {
    return existing;
  }

  const queued = gatewayRestartQueueTail.then(
    () => restartGatewayViaCliOnce(profile, healthTimeoutMs, healthPollMs),
    () => restartGatewayViaCliOnce(profile, healthTimeoutMs, healthPollMs),
  );

  const promise = queued.finally(() => {
    if (gatewayRestartByProfile.get(key) === promise) {
      gatewayRestartByProfile.delete(key);
    }
  });

  gatewayRestartByProfile.set(key, promise);
  gatewayRestartQueueTail = promise.catch(() => undefined);
  return promise;
}

async function restartGatewayViaCliOnce(
  profile?: string,
  healthTimeoutMs = 30000,
  healthPollMs = 250,
): Promise<boolean> {
  try {
    if (isRemoteMode()) return false;
    ensureInitialized();
    if (!canSpawnGateway()) return false;
    const invocation = getRuntimeInvocation();
    if (!invocation) return false;
    const prepared = await prepareGatewayForLaunch(profile);

    const key = profileKey(profile);
    const previousProcess = gatewayProcesses.get(key) ?? null;
    const previousStartedByApp = appStartedProfiles.has(key);
    const previousPidEntry = readPidFileEntry(profile);
    const logPath = gatewayLogPath(profile);
    const wasHealthyBeforeRestart = await isApiServerReady(profile);
    if (
      gatewayProcessOwnership === null ||
      gatewayProcessOwnership.getLoadIssue() !== null
    ) {
      console.warn(
        `[gateway:${key}] Refusing CLI restart while ownership state is unavailable.`,
      );
      return false;
    }

    // Every restart gets a durable launch intent before the Python wrapper is
    // spawned.  When the profile is already ours, retain the old listener
    // proof as a rollback guard; when it is a fresh profile, beginLaunch()
    // still prevents a process from becoming implicitly owned after a crash.
    const previousOwnership = gatewayProcessOwnership.get(key);
    const preLaunchPid =
      previousPidEntry?.pid ?? previousOwnership?.listenerPid ?? null;
    let launchOwnership: GatewayLaunchOwnershipRecord;
    let restartPreviousOwnership: GatewayLaunchOwnershipRecord | null = null;
    try {
      if (previousOwnership !== null) {
        const restart = gatewayProcessOwnership.beginRestart({
          profileId: key,
          preLaunchPid,
        });
        launchOwnership = restart.record;
        restartPreviousOwnership = restart.previous;
      } else {
        launchOwnership = gatewayProcessOwnership.beginLaunch({
          profileId: key,
          preLaunchPid,
        });
      }
    } catch (error) {
      console.warn(
        `[gateway:${key}] Refusing CLI restart because ownership intent could not be recorded:`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }

    appendFileSync(
      logPath,
      `\n[gateway:${key}] Desktop requested hermes gateway restart at ${new Date().toISOString()}\n`,
    );

    let proc: ChildProcess | null = null;
    let stderrFd = -1;
    let spawnArgs: string[] | undefined;
    let spawnError: unknown = null;
    let spawnedEvidence: ProcessIdentityEvidence | null = null;
    try {
      stderrFd = openSync(logPath, "a");
      spawnArgs = invocation.cliArgs(
        gatewayCliCommandArgs(profile, ["gateway", "restart"]),
      );
      proc = spawn(invocation.python, spawnArgs, {
        cwd: invocation.workingDirectory,
        env: buildGatewayEnv(profile, prepared),
        stdio: ["ignore", "ignore", stderrFd >= 0 ? stderrFd : "ignore"],
        detached: true,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      });
      if (typeof proc.pid !== "number") {
        throw new Error("The restart process identity is unavailable.");
      }
      spawnedEvidence = readGatewayProcessEvidence(proc.pid);
      launchOwnership = gatewayProcessOwnership.markSpawned({
        profileId: key,
        launchId: launchOwnership.launchId,
        spawnedPid: proc.pid,
        spawnedIdentity: spawnedEvidence?.identity,
        spawnedImage: spawnedEvidence?.image,
      });
    } catch (error) {
      spawnError = error;
    } finally {
      if (stderrFd >= 0) {
        try {
          closeSync(stderrFd);
        } catch {
          // best-effort
        }
      }
    }

    if (spawnError !== null || proc === null) {
      console.error(
        `[gateway:${key}] Failed to launch restart command:`,
        spawnError instanceof Error ? spawnError.message : String(spawnError),
      );
      // A failed spawn has no live child to clean.  Restore the exact prior
      // record (or remove the fresh intent) without ever trusting a bare PID.
      try {
        if (restartPreviousOwnership !== null) {
          gatewayProcessOwnership.restoreRestart(
            launchOwnership.launchId,
            restartPreviousOwnership,
          );
        } else {
          gatewayProcessOwnership.clearLaunch(key, launchOwnership.launchId);
        }
      } catch {
        // Keep the durable guard if persistence/concurrency prevents rollback.
      }
      setApiCacheFor(profile, wasHealthyBeforeRestart);
      return false;
    }

    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let processError: Error | null = null;
    proc.once("error", (error) => {
      processError = error;
      console.error(
        `[gateway:${key}] Failed to restart gateway:`,
        error.message,
      );
    });
    proc.once("close", (code, signal) => {
      closeCode = code;
      closeSignal = signal;
      if (gatewayProcesses.get(key) === proc) gatewayProcesses.delete(key);
      // A wrapper close does not mean the adopted listener is gone. Retain
      // the app-level ownership marker whenever the durable listener proof
      // still exists.
      const current = gatewayProcessOwnership?.get(key) ?? null;
      if (current?.listenerPid === null || current === null) {
        appStartedProfiles.delete(key);
      }
      invalidateApiCacheFor(profile);
      startHealthPolling();
    });
    proc.unref();
    gatewayProcesses.set(key, proc);
    appStartedProfiles.add(key);

    const serving = await waitForGatewayServing(
      profile,
      healthTimeoutMs,
      healthPollMs,
      prepared.key,
      prepared.port,
      preLaunchPid,
      proc.pid,
    );
    const processExitedWithError =
      processError !== null || (closeCode !== null && closeCode !== 0);
    let readyAndOwned = false;
    if (serving.ready && !processExitedWithError) {
      const current = gatewayProcessOwnership.get(key);
      const adopted = adoptGatewayPidFromFile(
        profile,
        current,
        serving.listenerEvidence,
        { replaceExistingListener: restartPreviousOwnership !== null },
      );
      readyAndOwned =
        adopted !== null &&
        adopted.listenerPid === serving.listenerPid &&
        adopted.listenerIdentity === serving.listenerEvidence?.identity &&
        adopted.listenerImage === serving.listenerEvidence?.image;
      if (readyAndOwned) {
        if (isChildProcessAlive(proc)) gatewayProcesses.set(key, proc);
        else gatewayProcesses.delete(key);
        appStartedProfiles.add(key);
        setApiCacheFor(profile, true);
        return true;
      }
      console.error(
        `[gateway:${key}] Restart listener became ready but durable ownership adoption failed.`,
      );
    }

    const cleanup = await cleanupGatewayLaunch(
      key,
      profile,
      proc,
      serving.listenerPid,
      serving.listenerEvidence,
    );
    if (!cleanup.terminated) {
      // Do not restore the previous record while a new identity-bound target
      // is still alive: that would orphan a process and make a later stop
      // unsafe. The current launch intent remains the fail-closed guard.
      console.error(
        `[gateway:${key}] Restart cleanup could not be confirmed; retaining durable ownership.`,
      );
      setApiCacheFor(profile, false);
      return false;
    }

    // Once every newly spawned target is confirmed gone, either restore the
    // exact prior listener proof (if it is still present/ambiguous) or clear
    // the failed fresh launch. A dead prior process is deliberately not
    // resurrected in memory.
    try {
      if (restartPreviousOwnership === null) {
        gatewayProcessOwnership.clearLaunch(key, launchOwnership.launchId);
        gatewayProcesses.delete(key);
        appStartedProfiles.delete(key);
      } else {
        const priorWrapperStatus = ownedTargetStatus(
          wrapperTarget(restartPreviousOwnership),
          previousProcess,
        );
        const priorListenerStatus = ownedTargetStatus(
          listenerTarget(restartPreviousOwnership, previousPidEntry),
        );
        const priorGone =
          priorWrapperStatus === "dead" && priorListenerStatus === "dead";
        if (priorGone) {
          gatewayProcessOwnership.clearLaunch(key, launchOwnership.launchId);
          gatewayProcesses.delete(key);
          appStartedProfiles.delete(key);
        } else {
          gatewayProcessOwnership.restoreRestart(
            launchOwnership.launchId,
            restartPreviousOwnership,
          );
          if (priorWrapperStatus === "alive" && previousProcess !== null) {
            gatewayProcesses.set(key, previousProcess);
          } else {
            gatewayProcesses.delete(key);
          }
          if (
            priorWrapperStatus === "alive" ||
            priorListenerStatus === "alive" ||
            priorWrapperStatus === "unknown" ||
            priorListenerStatus === "unknown" ||
            priorWrapperStatus === "mismatch" ||
            priorListenerStatus === "mismatch"
          ) {
            appStartedProfiles.add(key);
          } else if (!previousStartedByApp) {
            appStartedProfiles.delete(key);
          }
        }
      }
    } catch {
      // Preserve whichever durable record is currently on disk; never replace
      // a concurrent launch with a stale rollback.
    }
    setApiCacheFor(profile, false);
    console.error(
      `[gateway:${key}] Restart did not become ready within ${healthTimeoutMs}ms pid=${proc.pid} exitCode=${closeCode ?? "still-running"}${closeSignal ? ` signal=${closeSignal}` : ""}. ` +
        `Check ${logPath} for details.`,
    );
    return readyAndOwned;
  } catch (err) {
    console.error(
      "[gateway] Restart failed before the command could complete:",
      (err as Error).message,
    );
    return false;
  }
}

/**
 * Hook for the profile-switch handler: drop the cached ready flag so the next
 * health check probes the newly active profile's port instead of trusting a
 * value sampled against the previous profile's gateway.
 */
export function notifyProfileSwitched(): void {
  apiServerAvailable = null;
  // No dashboard warm-up here: the dashboard backend starts on demand (or
  // after a readiness-gated gateway launch), never concurrently with a
  // cold-starting primary gateway.
}
