/**
 * Provider model discovery.
 *
 * Hits the provider's OpenAI-compatible `/models` endpoint and returns the
 * list of model ids it advertises.  Used to power autocomplete in the
 * Providers UI Model field and the Models page Add/Edit dialog so users
 * don't have to type the exact id from memory.
 *
 * Upstream `hermes-agent` has an equivalent helper at
 * ``hermes_cli/models.py::fetch_api_models`` used by the TUI's /model
 * picker; this mirrors that flow on the desktop side without going
 * through the Python CLI.
 */
import http from "http";
import https from "https";
import { createHash } from "node:crypto";
import { URL } from "url";
import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { readEnv, getModelContextLengthOverride } from "./config";
import { profileHome } from "./utils";
import { expectedEnvKeyForModel, getEnhancedPath } from "./installer";
import { getRuntimeInvocation } from "./agentera-runtime-distribution/invocation";
import {
  isProviderDiscoverySuccess,
  providerDiscoveryFailure,
  providerDiscoverySuccess,
  type ProviderDiscoveryResultV2,
  type ProviderDiscoveryFailureStatusV2,
} from "../shared/provider-model-discovery";
// PROVIDER_BASE_URLS lives in its own module so `config.ts` can use the
// same lookup without pulling in this whole file (and triggering a
// circular import via `model-discovery → config → ...`).
import { PROVIDER_BASE_URLS } from "./provider-registry";

/** Providers whose `/models` we never call — either they don't expose it,
 *  use a different protocol, or rely on OAuth credentials we can't
 *  reproduce from a static env var. The OAuth providers below are handled
 *  separately via `discoverOAuthModels`, so they're not listed here. */
const NON_DISCOVERABLE_PROVIDERS = new Set<string>([
  "auto",
  "custom",
  "google",
  "xai",
  "alibaba",
  "minimax",
  "kimi-coding",
]);

/** OAuth/subscription providers — no static-key `/v1/models` endpoint.
 *  Their model lists come from hermes-agent's `provider_model_ids`
 *  (live + account-aware for Codex), reached via a short Python call.
 *  `nous` is included here since the desktop now exposes its OAuth
 *  sign-in surface (issue #367). */
const OAUTH_DISCOVERY_PROVIDERS = new Set<string>([
  "openai-codex",
  "xai-oauth",
  "qwen-oauth",
  "google-gemini-cli",
  "minimax-oauth",
  "nous",
]);

/** Curated fallback model lists, mirrored from hermes-agent's
 *  `hermes_cli/models.py` (`_PROVIDER_MODELS`) and `codex_models.py`
 *  (`DEFAULT_CODEX_MODELS`). Used only when the Python call below is
 *  unavailable (agent not installed, import error, timeout). The live
 *  call is always preferred — these will drift as new models ship. */
const OAUTH_PROVIDER_CURATED: Record<string, string[]> = {
  "openai-codex": [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
  ],
  "xai-oauth": [
    "grok-4.3",
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",
    "grok-4.20-multi-agent-0309",
  ],
  "google-gemini-cli": [
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
  ],
  "minimax-oauth": ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
  "qwen-oauth": [],
};

// One-liner that prints hermes-agent's model list for a provider as a
// JSON array. `provider_model_ids` does the heavy lifting — curated
// lists for most, plus a live account-aware query for openai-codex.
const PROVIDER_MODELS_SNIPPET =
  "import json,sys; from hermes_cli.models import provider_model_ids; " +
  "print(json.dumps(list(provider_model_ids(sys.argv[1]))))";

type OAuthPythonDiscovery = {
  models: string[] | null;
  terminalStatus?: "timeout" | "cancelled";
};

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; killed?: unknown };
  return candidate.code === "ETIMEDOUT" || candidate.killed === true;
}

/** Ask hermes-agent's `provider_model_ids` for a provider's models by
 *  running a short Python snippet against the bundled venv. Generic runtime
 *  failures return null so the caller can use the curated fallback; explicit
 *  cancellation and timeout remain typed outcomes and never masquerade as a
 *  successful fallback catalogue. */
function runProviderModelIdsPython(
  provider: string,
  profile: string | undefined,
  options: ProviderDiscoveryRequestOptions,
): Promise<OAuthPythonDiscovery> {
  if (options.signal?.aborted) {
    return Promise.resolve({ models: null, terminalStatus: "cancelled" });
  }
  const invocation = getRuntimeInvocation();
  if (invocation === null) return Promise.resolve({ models: null });
  const timeoutMs = normalizeDiscoveryTimeout(
    options.timeoutMs ?? DEFAULT_OAUTH_DISCOVERY_TIMEOUT_MS,
  );
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof execFile> | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: OAuthPythonDiscovery): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const terminate = (): void => {
      try {
        child?.kill();
      } catch {
        // The process may have exited between classification and kill.
      }
    };
    const onAbort = (): void => {
      finish({ models: null, terminalStatus: "cancelled" });
      terminate();
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      finish({ models: null, terminalStatus: "timeout" });
      terminate();
    }, timeoutMs);
    timer.unref?.();

    try {
      child = execFile(
        invocation.python,
        ["-c", PROVIDER_MODELS_SNIPPET, provider],
        {
          cwd: invocation.workingDirectory,
          env: invocation.environment({
            ...process.env,
            PATH: getEnhancedPath(),
            // Hermes treats HERMES_HOME as the selected profile root. Passing
            // it explicitly prevents OAuth credentials/model catalogs from
            // leaking across Desktop profiles.
            HERMES_HOME: profileHome(profile),
          }),
          timeout: timeoutMs,
          signal: options.signal,
          windowsHide: true,
        },
        (err, stdout) => {
          if (settled) return;
          if (options.signal?.aborted || isAbortError(err)) {
            finish({ models: null, terminalStatus: "cancelled" });
            return;
          }
          if (isTimeoutError(err)) {
            finish({ models: null, terminalStatus: "timeout" });
            return;
          }
          if (err) {
            finish({ models: null });
            return;
          }
          try {
            const parsed: unknown = JSON.parse(String(stdout).trim());
            if (Array.isArray(parsed)) {
              finish({
                models: parsed.filter(
                  (x): x is string => typeof x === "string",
                ),
              });
              return;
            }
          } catch {
            /* unparseable — fall through */
          }
          finish({ models: null });
        },
      );
    } catch {
      finish({ models: null });
    }
  });
}

/** Resolve an OAuth provider's models: hermes-agent's live list first,
 *  curated fallback when that's unavailable. */
async function discoverOAuthModels(
  provider: string,
  profile: string | undefined,
  options: ProviderDiscoveryRequestOptions,
): Promise<OAuthPythonDiscovery> {
  const live = await runProviderModelIdsPython(provider, profile, options);
  if (live.terminalStatus) return live;
  if (live.models && live.models.length > 0) {
    return { models: uniqueSorted(live.models) };
  }
  return { models: OAUTH_PROVIDER_CURATED[provider] ?? [] };
}

/**
 * Fetch the Nous Portal `/v1/models` catalogue with the OAuth token
 * stored in `auth.json`, and return the IDs of models whose prompt +
 * completion pricing are both zero — i.e. the free tier. Issue #367
 * found that a free-subscription user picking the default Nous model
 * (Hermes-4-405B) gets a billing error. Surfacing free models in the
 * autocomplete makes the right choice discoverable.
 *
 * Returns [] on any failure (no token, no inference_base_url, HTTP
 * error, parse error). Best-effort enrichment — never blocks the
 * main discovery call.
 */
async function fetchNousFreeModelIds(
  profile: string | undefined,
  options: ProviderDiscoveryRequestOptions = {},
): Promise<string[]> {
  try {
    if (options.signal?.aborted) return [];
    const authPath = join(profileHome(profile), "auth.json");
    if (!existsSync(authPath)) return [];
    const auth = JSON.parse(readFileSync(authPath, "utf-8")) as {
      providers?: {
        nous?: { access_token?: string; inference_base_url?: string };
      };
    };
    const token = (auth.providers?.nous?.access_token || "").trim();
    const base = (auth.providers?.nous?.inference_base_url || "").trim();
    if (!token || !base) return [];

    const url = `${base.replace(/\/+$/, "")}/models`;
    // Validate the endpoint before installing the timer and abort listener.
    // A malformed profile URL must not leave those resources registered when
    // the best-effort enrichment exits early.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return [];
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return [];
    }
    const timeoutMs = normalizeDiscoveryTimeout(
      options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    );
    return await new Promise<string[]>((resolve) => {
      let settled = false;
      let request: http.ClientRequest | null = null;
      const finish = (models: string[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(models);
      };
      const terminate = (): void => {
        try {
          request?.destroy();
        } catch {
          // The request may already be closed.
        }
      };
      const onAbort = (): void => {
        finish([]);
        terminate();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        finish([]);
        terminate();
      }, timeoutMs);
      timer.unref?.();
      const u = parsedUrl;
      const mod = u.protocol === "https:" ? https : http;
      try {
        request = mod.request(
          {
            method: "GET",
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || undefined,
            path: `${u.pathname}${u.search}`,
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
            },
            timeout: timeoutMs,
          },
          (res) => {
            if (settled) {
              res.resume();
              return;
            }
            if (!res.statusCode || res.statusCode >= 400) {
              res.resume();
              finish([]);
              return;
            }
            let body = "";
            let bodyBytes = 0;
            let oversized = false;
            res.setEncoding("utf-8");
            res.on("data", (chunk) => {
              if (settled || oversized) return;
              bodyBytes += Buffer.byteLength(String(chunk), "utf8");
              if (bodyBytes > MAX_DISCOVERY_BODY_BYTES) {
                oversized = true;
                finish([]);
                res.destroy();
                return;
              }
              body += chunk;
            });
            res.on("end", () => {
              if (settled || oversized) return;
              try {
                const j = JSON.parse(body) as {
                  data?: Array<{
                    id?: string;
                    pricing?: { prompt?: string; completion?: string };
                  }>;
                };
                const free = (j.data || [])
                  .filter((m) => {
                    // Free iff both prompt and completion cost zero. The
                    // Portal returns them as strings like "0.0000000000".
                    const pr = String(m.pricing?.prompt ?? "").trim();
                    const co = String(m.pricing?.completion ?? "").trim();
                    return (
                      pr !== "" &&
                      co !== "" &&
                      parseFloat(pr) === 0 &&
                      parseFloat(co) === 0
                    );
                  })
                  .map((m) => String(m.id || "").trim())
                  .filter(Boolean);
                finish(uniqueSorted(free));
              } catch {
                finish([]);
              }
            });
            res.on("aborted", () => finish([]));
            res.on("error", () => finish([]));
          },
        );
        request.on("error", () => finish([]));
        request.on("timeout", () => {
          finish([]);
          terminate();
        });
        request.end();
      } catch {
        finish([]);
      }
    });
  } catch {
    return [];
  }
}

// In-memory result cache to avoid hammering the provider on every keystroke.
interface CacheEntry {
  models: string[];
  ts: number;
}
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _cache = new Map<string, CacheEntry>();
// Parallel cache of free-model ids, keyed by provider. Cleared together
// with the main cache via `_clearCache` for test isolation.
const _freeCache = new Map<string, string[]>();
// Parallel cache of per-model context-window sizes (tokens), keyed the same
// way as `_cache` (provider|baseUrl|credential fingerprint) and populated from the `/models`
// response when the provider advertises a `context_length` (OpenRouter and
// many OpenAI-compatible gateways do). Drives authoritative context-gauge
// sizing in the renderer; the static heuristic is only a fallback. Issue #597.
const _ctxCache = new Map<string, Record<string, number>>();

const LOCAL_NO_KEY_PROVIDERS = new Set([
  "lmstudio",
  "atomicchat",
  "ollama",
  "vllm",
  "llamacpp",
]);

function credentialFingerprint(apiKey: string): string {
  if (!apiKey) return "no-credential";
  return createHash("sha256")
    .update("aera-model-discovery-cache\0", "utf8")
    .update(apiKey, "utf8")
    .digest("hex");
}

function profileFingerprint(profile: string | undefined): string {
  const normalized = (profile || "default").trim() || "default";
  return createHash("sha256")
    .update("aera-model-discovery-profile\0", "utf8")
    .update(normalized, "utf8")
    .digest("hex");
}

function cacheKey(
  provider: string,
  baseUrl: string,
  apiKey: string,
  profile?: string,
): string {
  return `${provider.toLowerCase()}|${baseUrl.replace(/\/+$/, "").toLowerCase()}|${credentialFingerprint(apiKey)}|${profileFingerprint(profile)}`;
}

function fromCache(
  provider: string,
  baseUrl: string,
  apiKey: string,
  profile?: string,
): string[] | null {
  const key = cacheKey(provider, baseUrl, apiKey, profile);
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.models;
}

function setCache(
  provider: string,
  baseUrl: string,
  apiKey: string,
  models: string[],
  profile?: string,
): void {
  _cache.set(cacheKey(provider, baseUrl, apiKey, profile), {
    models,
    ts: Date.now(),
  });
}

/** Resolve the canonical base URL for a provider name, or null if we
 *  don't have a mapping (caller must supply baseUrl explicitly). */
function canonicalBaseUrl(provider: string): string | null {
  const direct = PROVIDER_BASE_URLS[provider.toLowerCase()];
  return direct || null;
}

/** Resolve the API key from the user's .env for a given provider. */
function envApiKeyFor(
  provider: string,
  baseUrl: string,
  profile: string | undefined,
): string {
  const envKey = expectedEnvKeyForModel(provider, baseUrl);
  if (!envKey) return "";
  const env = readEnv(profile);
  return (env[envKey] || "").trim().replace(/^["']|["']$/g, "");
}

interface RawModelMeta {
  id?: string;
  context_length?: number | string;
  context_window?: number | string;
  max_context_length?: number | string;
  max_context_window_tokens?: number | string;
  top_provider?: { context_length?: number | string };
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const n = parseInt(value.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Pull a context-window size out of a single `/models` entry, trying the
 *  field names different providers use (OpenRouter exposes both a top-level
 *  `context_length` and a nested `top_provider.context_length`). */
function extractContextLength(item: RawModelMeta): number | null {
  return (
    toPositiveInt(item.context_length) ??
    toPositiveInt(item.context_window) ??
    toPositiveInt(item.max_context_length) ??
    toPositiveInt(item.max_context_window_tokens) ??
    toPositiveInt(item.top_provider?.context_length)
  );
}

/** Map of model id -> advertised context-window size from a `/models`
 *  response body. Empty when the body is unparseable or carries no context
 *  metadata (e.g. OpenAI / DeepSeek, which omit it). */
interface ParsedModelCatalogue {
  models: string[];
  contextLengths: Record<string, number>;
}

/**
 * Parse a successful catalogue exactly once. A body-bearing 2xx response is
 * valid only when it contains a `data` or `models` array; this prevents an
 * HTML/error envelope from being silently presented as an empty catalogue.
 */
function parseModelCatalogue(body: string): ParsedModelCatalogue | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const j = json as { data?: unknown; models?: unknown };
  const arr = Array.isArray(j.data)
    ? j.data
    : Array.isArray(j.models)
      ? j.models
      : null;
  if (!arr) return null;
  const models: string[] = [];
  const out: Record<string, number> = {};
  for (const item of arr) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const model = item as RawModelMeta;
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id) return null;
    models.push(id);
    const ctx = extractContextLength(model);
    if (ctx) out[id] = ctx;
  }
  return { models: uniqueSorted(models), contextLengths: out };
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function buildUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/models`;
}

interface FetchModelsResult {
  /** Public V2 result; only verified catalogues can be successful. */
  result: ProviderDiscoveryResultV2;
  /** Per-model context-window sizes parsed from the response, when present. */
  contextLengths?: Record<string, number>;
}

const MAX_DISCOVERY_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_OAUTH_DISCOVERY_TIMEOUT_MS = 20_000;
const MAX_DISCOVERY_TIMEOUT_MS = 120_000;

function normalizeDiscoveryTimeout(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs) || (timeoutMs ?? 0) <= 0) {
    return DEFAULT_DISCOVERY_TIMEOUT_MS;
  }
  return Math.min(
    MAX_DISCOVERY_TIMEOUT_MS,
    Math.max(1, Math.floor(timeoutMs!)),
  );
}

function statusForHttpFailure(
  statusCode: number,
): ProviderDiscoveryFailureStatusV2 {
  switch (statusCode) {
    case 401:
      return "authentication_rejected";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 429:
      return "rate_limited";
    default:
      return "upstream_error";
  }
}

function transportStatus(error: unknown): ProviderDiscoveryFailureStatusV2 {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
  if (
    ["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "ENODATA"].includes(
      code,
    )
  ) {
    return "dns_error";
  }
  if (code === "ETIMEDOUT") return "timeout";
  if (
    [
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
      "ERR_TLS_DH_PARAM_SIZE",
      "ERR_TLS_INVALID_PROTOCOL_VERSION",
      "EPROTO",
    ].includes(code) ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_")
  ) {
    return "tls_error";
  }
  return "connection_error";
}

function authHeaders(provider: string, apiKey: string): Record<string, string> {
  if (!apiKey) return {};
  const lower = provider.toLowerCase();
  if (lower === "anthropic") {
    // Anthropic uses x-api-key + an API version header on /v1/models.
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function fetchModelsHttp(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<FetchModelsResult> {
  return new Promise((resolve) => {
    let settled = false;
    let request: http.ClientRequest | null = null;
    let response: http.IncomingMessage | null = null;
    let timedOut = false;
    const finish = (
      result: ProviderDiscoveryResultV2,
      contextLengths?: Record<string, number>,
    ): void => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ result, contextLengths });
    };
    const onAbort = (): void => {
      finish(providerDiscoveryFailure("cancelled"));
      request?.destroy();
      response?.destroy();
    };

    if (signal?.aborted) {
      finish(providerDiscoveryFailure("cancelled"));
      return;
    }

    let u: URL;
    try {
      u = new URL(url);
    } catch {
      finish(providerDiscoveryFailure("unknown_endpoint"));
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      finish(providerDiscoveryFailure("unknown_endpoint"));
      return;
    }
    const mod = u.protocol === "https:" ? https : http;
    try {
      request = mod.request(
        {
          method: "GET",
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || undefined,
          path: `${u.pathname}${u.search}`,
          headers: { Accept: "application/json", ...headers },
          timeout: timeoutMs,
        },
        (res) => {
          response = res;
          const statusCode = res.statusCode;
          if (
            typeof statusCode !== "number" ||
            statusCode < 200 ||
            statusCode >= 300
          ) {
            res.resume();
            finish(
              typeof statusCode === "number"
                ? providerDiscoveryFailure(statusForHttpFailure(statusCode), {
                    statusCode,
                  })
                : providerDiscoveryFailure("upstream_error"),
            );
            return;
          }
          let body = "";
          let bodyBytes = 0;
          let oversized = false;
          res.setEncoding("utf-8");
          res.on("data", (chunk) => {
            if (oversized || settled) return;
            bodyBytes += Buffer.byteLength(String(chunk), "utf8");
            if (bodyBytes > MAX_DISCOVERY_BODY_BYTES) {
              oversized = true;
              finish(
                providerDiscoveryFailure("malformed_response", { statusCode }),
              );
              res.destroy();
              return;
            }
            body += chunk;
          });
          res.on("end", () => {
            if (oversized || settled) return;
            // A no-body 204 is a valid empty catalogue. Other body-less 2xx
            // responses are malformed because they do not describe a list.
            if (statusCode === 204 && body.trim() === "") {
              finish(providerDiscoverySuccess([], { statusCode }));
              return;
            }
            const parsed = parseModelCatalogue(body);
            if (!parsed) {
              finish(
                providerDiscoveryFailure("malformed_response", { statusCode }),
              );
              return;
            }
            finish(
              providerDiscoverySuccess(parsed.models, { statusCode }),
              parsed.contextLengths,
            );
          });
          res.on("aborted", () => {
            if (!settled) finish(providerDiscoveryFailure("connection_error"));
          });
          res.on("error", (error) => {
            if (!settled && !timedOut) {
              finish(providerDiscoveryFailure(transportStatus(error)));
            }
          });
        },
      );
    } catch (error) {
      finish(providerDiscoveryFailure(transportStatus(error)));
      return;
    }
    if (!request) {
      finish(providerDiscoveryFailure("connection_error"));
      return;
    }
    request.on("error", (error) => {
      if (settled) return;
      if (signal?.aborted) {
        finish(providerDiscoveryFailure("cancelled"));
        return;
      }
      if (timedOut) return;
      finish(providerDiscoveryFailure(transportStatus(error)));
    });
    request.on("timeout", () => {
      if (settled) return;
      timedOut = true;
      // Settle before destroy: the ensuing ECONNRESET must not overwrite the
      // deterministic timeout classification.
      finish(providerDiscoveryFailure("timeout"));
      request?.destroy();
    });
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      request.end();
    } catch (error) {
      finish(providerDiscoveryFailure(transportStatus(error)));
    }
  });
}

/** Main-process return type. Kept as a named alias for existing imports. */
export type DiscoverModelsResult = ProviderDiscoveryResultV2;

export interface ProviderDiscoveryRequestOptions {
  /** Per-request timeout; defaults to ten seconds. */
  timeoutMs?: number;
  /** Aborting this signal settles the request as `cancelled`. */
  signal?: AbortSignal;
}

/** Discover available models for a provider.  Returns an object so the
 *  UI can distinguish "no key set yet" from "no models advertised". */
export async function discoverProviderModels(
  provider: string,
  baseUrlOverride: string | undefined,
  apiKeyOverride: string | undefined,
  profile: string | undefined,
  options: ProviderDiscoveryRequestOptions = {},
): Promise<DiscoverModelsResult> {
  const lowerProvider = (provider || "").trim().toLowerCase();

  // Cancellation is terminal for the request, including all fast paths. A
  // cached catalogue must never turn an already-cancelled UI request into a
  // successful response.
  if (options.signal?.aborted) {
    return providerDiscoveryFailure("cancelled");
  }

  // OAuth/subscription providers don't have a static-key /v1/models
  // endpoint — route them through hermes-agent's provider_model_ids.
  if (OAUTH_DISCOVERY_PROVIDERS.has(lowerProvider)) {
    const hit = fromCache(lowerProvider, "", "", profile);
    if (hit) {
      // Re-attach free flags from cache. Pricing is fetched fresh on
      // the next non-cache hit; meanwhile the renderer keeps the
      // previous free list.
      const cachedResult = providerDiscoverySuccess(hit, {
        cached: true,
        freeModels:
          _freeCache.get(cacheKey(lowerProvider, "", "", profile)) || [],
      });
      if (lowerProvider === "nous") {
        cachedResult.freeModels = _freeCache.get(
          cacheKey(lowerProvider, "", "", profile),
        ) || [];
      }
      return cachedResult;
    }
    const discovered = await discoverOAuthModels(
      lowerProvider,
      profile,
      options,
    );
    if (discovered.terminalStatus) {
      return providerDiscoveryFailure(discovered.terminalStatus);
    }
    if (options.signal?.aborted) {
      return providerDiscoveryFailure("cancelled");
    }
    const models = discovered.models ?? [];
    // Nous Portal exposes pricing in its catalog — enrich with the
    // subset of models that are free, so the renderer can badge them.
    // Other OAuth providers have no equivalent yet.
    let freeModels: string[] = [];
    if (lowerProvider === "nous") {
      const allFree = await fetchNousFreeModelIds(profile, options);
      if (options.signal?.aborted) {
        return providerDiscoveryFailure("cancelled");
      }
      // Keep only the free IDs that are actually in the curated list
      // we're surfacing — avoids confusing the user with names that
      // wouldn't autocomplete anyway. If hermes-agent's list misses
      // some free ones, fall back to the full live list.
      const inCurated = allFree.filter((id) => models.includes(id));
      freeModels = inCurated.length > 0 ? inCurated : allFree;
    }
    // Publish only after the complete discovery operation has finished. Nous
    // pricing is best-effort, but cancellation during enrichment must not
    // leave a partial catalogue for the next request.
    if (options.signal?.aborted) {
      return providerDiscoveryFailure("cancelled");
    }
    setCache(lowerProvider, "", "", models, profile);
    if (lowerProvider === "nous") {
      _freeCache.set(cacheKey(lowerProvider, "", "", profile), freeModels);
    }
    const result = providerDiscoverySuccess(models, { freeModels });
    if (lowerProvider === "nous") result.freeModels = uniqueSorted(freeModels);
    return result;
  }

  if (!lowerProvider || NON_DISCOVERABLE_PROVIDERS.has(lowerProvider)) {
    // For "custom", caller must pass baseUrl explicitly — fall through
    // and the canonicalBaseUrl() check below will redirect to that path.
    if (lowerProvider !== "custom") {
      return providerDiscoveryFailure("unsupported_provider");
    }
  }

  const explicitBase = (baseUrlOverride || "").trim().replace(/\/+$/, "");
  const baseUrl = explicitBase || canonicalBaseUrl(lowerProvider) || "";
  if (!baseUrl) return providerDiscoveryFailure("unknown_endpoint");

  const apiKey =
    (apiKeyOverride || "").trim() ||
    envApiKeyFor(lowerProvider, baseUrl, profile);
  const canDiscoverWithoutKey =
    LOCAL_NO_KEY_PROVIDERS.has(lowerProvider) ||
    (lowerProvider === "custom" && isLoopbackBaseUrl(baseUrl));
  if (!apiKey && !canDiscoverWithoutKey) {
    return providerDiscoveryFailure("credential_missing");
  }

  const cached = fromCache(lowerProvider, baseUrl, apiKey, profile);
  if (cached) return providerDiscoverySuccess(cached, { cached: true });

  const result = await fetchAndCacheModels(
    lowerProvider,
    baseUrl,
    apiKey,
    profile,
    options,
  );
  return result.result;
}

/**
 * Fetch a provider's `/models` over HTTP and populate BOTH caches together.
 *
 * `_ctxCache` is always written when the endpoint is reachable — even when no
 * model advertises a `context_length` (OpenAI, DeepSeek) — so an empty map
 * doubles as a "already fetched, none advertised" marker. That lets
 * `getModelContextWindow` tell a genuine miss (don't re-fetch) from a
 * never-fetched key, which is what was broken when the model picker had
 * already populated `_cache` but not `_ctxCache` (issue #597 PR review).
 */
async function fetchAndCacheModels(
  lowerProvider: string,
  baseUrl: string,
  apiKey: string,
  profile: string | undefined,
  options: ProviderDiscoveryRequestOptions = {},
): Promise<FetchModelsResult> {
  const url = buildUrl(baseUrl);
  const headers = authHeaders(lowerProvider, apiKey);
  const fetched = await fetchModelsHttp(
    url,
    headers,
    normalizeDiscoveryTimeout(options.timeoutMs),
    options.signal,
  );
  if (options.signal?.aborted) {
    return { result: providerDiscoveryFailure("cancelled") };
  }
  if (isProviderDiscoverySuccess(fetched.result)) {
    setCache(lowerProvider, baseUrl, apiKey, fetched.result.models, profile);
    _ctxCache.set(
      cacheKey(lowerProvider, baseUrl, apiKey, profile),
      fetched.contextLengths ?? {},
    );
  }
  return fetched;
}

/**
 * Resolve the authoritative context-window size (in tokens) for a model by
 * consulting the provider's `/models` catalogue. Returns null when the
 * provider doesn't advertise it (OpenAI, DeepSeek, OAuth providers) or the
 * model id isn't found, in which case the renderer falls back to the static
 * heuristic in `contextWindows.ts`. Issue #597.
 */
// @lat: [[model-context#Model context window#Gauge resolution order]]
export async function getModelContextWindow(
  provider: string,
  model: string,
  baseUrlOverride: string | undefined,
  apiKeyOverride: string | undefined,
  profile: string | undefined,
): Promise<number | null> {
  const modelId = (model || "").trim();
  if (!modelId) return null;
  const lowerProvider = (provider || "").trim().toLowerCase();

  // A manual `model.context_length` override in config.yaml wins over /models
  // detection — it's what the user set explicitly and what the agent's
  // auto-compaction threshold uses. Apply it ONLY when it targets the model
  // being asked about (an exact match against the active `model.default`), so a
  // stale value can't leak onto a different model id — including the case where
  // `model.default` is absent (override.model === ""), which must NOT match.
  // This is the primary fix for providers (qwen, etc.) that don't advertise
  // `context_length`, leaving the gauge on its heuristic.
  const override = getModelContextLengthOverride(profile);
  if (override && override.model && override.model === modelId) {
    return override.contextLength;
  }

  // OAuth/subscription and non-discoverable providers have no static-key
  // `/models` endpoint to read `context_length` from — the renderer falls
  // back to the heuristic for these. ("custom" is discoverable.)
  if (
    OAUTH_DISCOVERY_PROVIDERS.has(lowerProvider) ||
    (NON_DISCOVERABLE_PROVIDERS.has(lowerProvider) &&
      lowerProvider !== "custom")
  ) {
    return null;
  }

  const explicitBase = (baseUrlOverride || "").trim().replace(/\/+$/, "");
  const baseUrl = explicitBase || canonicalBaseUrl(lowerProvider) || "";
  if (!baseUrl) return null;

  const apiKey =
    (apiKeyOverride || "").trim() ||
    envApiKeyFor(lowerProvider, baseUrl, profile);
  const canDiscoverWithoutKey =
    LOCAL_NO_KEY_PROVIDERS.has(lowerProvider) ||
    (lowerProvider === "custom" && isLoopbackBaseUrl(baseUrl));
  if (!apiKey && !canDiscoverWithoutKey) return null;

  const key = cacheKey(lowerProvider, baseUrl, apiKey, profile);

  const readCtx = (): number | null => _ctxCache.get(key)?.[modelId] ?? null;

  const cached = readCtx();
  if (cached) return cached;
  // A present (even empty) ctx map means we've already fetched this
  // catalogue, so a missing entry is authoritative — don't re-fetch. This
  // also avoids hammering the endpoint for providers that omit the field.
  if (_ctxCache.has(key)) return null;

  // Not fetched yet (e.g. the model picker primed `_cache` but never the ctx
  // map). Fetch directly here rather than via `discoverProviderModels`, whose
  // `_cache`-hit early-return would skip the ctx fetch entirely.
  await fetchAndCacheModels(lowerProvider, baseUrl, apiKey, profile);
  return readCtx();
}

/** Internal: exposed for tests / debugging only.  Production callers
 *  should always go through ``discoverProviderModels``. */
export function _clearCache(): void {
  _cache.clear();
  _freeCache.clear();
  _ctxCache.clear();
}
