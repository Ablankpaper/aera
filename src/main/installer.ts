import { spawn, execFile, execFileSync } from "child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { join, delimiter, resolve } from "path";
import { homedir } from "os";
import { app } from "electron";
import {
  getConnectionConfig,
  getModelConfig,
  hasOAuthCredentials,
} from "./config";
import { providerDoesNotNeedApiKey } from "./providers";
import { getActiveProfileNameSync, profileHome, stripAnsi } from "./utils";
import { HIDDEN_SUBPROCESS_OPTIONS } from "./process-options";
import {
  configureRuntimeInvocationContext,
  getRuntimeInvocation,
  refreshRuntimeInvocation,
  selectExternalRuntime,
  selectManagedRuntime,
  type RuntimeInvocation,
} from "./agentera-runtime-distribution/invocation";
import {
  persistRuntimeSelection,
  readRuntimeSelection,
  type RuntimeSelectionMode,
} from "./agentera-runtime-distribution/selection-store";
import { createRuntimeDistributionPaths } from "./agentera-runtime-distribution/paths";
import { resolvePackagedRuntimeSeedDirectory } from "./agentera-runtime-distribution/seed-path";
import {
  getAvailableRuntimeDiskBytes,
  installPackagedSeed,
  type PackagedSeedInstallResult,
} from "./agentera-runtime-distribution/seed-installer";
import { loadRuntimeTrustFile } from "./agentera-runtime-distribution/trust";

const IS_WINDOWS = process.platform === "win32";

// Resolve the Hermes data directory. Precedence:
//   1. HERMES_HOME env var if set (legacy Windows installs may set it at
//      User scope; users may also override manually for WSL/custom setups).
//   2. On Windows, probe both candidates and pick whichever already has
//      data. Legacy Windows installs defaulted to %LOCALAPPDATA%\hermes, but some
//      setups put data at ~/.hermes (e.g. a junction into WSL, or a
//      custom -HermesHome flag on install). Without probing we'd silently
//      switch directories on users who had it working before.
//   3. Data-home fallback: %LOCALAPPDATA%\hermes on Windows, ~/.hermes
//      elsewhere. Managed Runtime binaries are stored under Electron userData.
//
// Motivating bug: Electron launched from the Start Menu doesn't always
// inherit shell-set env vars, so relying on HERMES_HOME alone left
// Windows users staring at an empty ~/.hermes while their real data
// sat in %LOCALAPPDATA%\hermes.
function looksLikeHermesHome(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return (
    existsSync(join(dir, "hermes-agent")) ||
    existsSync(join(dir, "gateway.pid")) ||
    existsSync(join(dir, "config.yaml")) ||
    existsSync(join(dir, "active_profile")) ||
    existsSync(join(dir, ".env"))
  );
}

function defaultHermesHome(): string {
  const homeDot = join(homedir(), ".hermes");
  if (!IS_WINDOWS) return homeDot;

  const localApp = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "hermes")
    : null;

  // Prefer whichever location already has hermes data.
  if (localApp && looksLikeHermesHome(localApp)) return localApp;
  if (looksLikeHermesHome(homeDot)) return homeDot;

  // Neither populated yet — retain the legacy data-home default so existing
  // Profiles continue to resolve consistently.
  return localApp ?? homeDot;
}

// A Hermes home the user explicitly pointed the app at via the "use an
// existing installation" flow (issue #272). Persisted in the desktop's own
// userData dir — outside any Hermes home — so it can be read here, before
// HERMES_HOME is resolved. Strictly additive: with no override file the
// behaviour is identical to before.
function hermesHomeOverrideFile(): string {
  // `app` is undefined outside an Electron runtime (e.g. unit tests) —
  // optional-chain it so module load degrades to "no override" instead of
  // throwing.
  const userData = app?.getPath?.("userData");
  return userData ? join(userData, "hermes-home.json") : "";
}

const persistedRuntimeSelection = readRuntimeSelection(
  hermesHomeOverrideFile(),
);
let selectedRuntimeMode: RuntimeSelectionMode =
  persistedRuntimeSelection?.mode ?? "managed";

function readHermesHomeOverride(): string {
  return persistedRuntimeSelection?.hermesHome ?? "";
}

/** Persist (when `home` is set) or clear (when "") the Hermes home override. */
export function setHermesHomeOverride(home: string): void {
  try {
    const file = hermesHomeOverrideFile();
    if (!file) return;
    if (!home.trim()) {
      if (existsSync(file)) unlinkSync(file);
      selectedRuntimeMode = "managed";
      selectManagedRuntime();
      return;
    }
    persistRuntimeSelection(file, {
      mode: "external",
      hermesHome: resolve(home.trim()),
    });
    selectedRuntimeMode = "external";
    selectExternalRuntime(home);
  } catch {
    /* best effort — a failed write just means no override next launch */
  }
}

export function isExternalRuntimeSelected(): boolean {
  return selectedRuntimeMode === "external";
}

export const HERMES_HOME =
  process.env.HERMES_HOME?.trim() ||
  readHermesHomeOverride() ||
  defaultHermesHome();
export const HERMES_REPO = join(HERMES_HOME, "hermes-agent");
export const HERMES_VENV = join(HERMES_REPO, "venv");
// On Windows, use `pythonw.exe` (the GUI-subsystem interpreter that ships in
// every venv) instead of `python.exe` so that subprocess spawns don't flash
// a blank console window before `windowsHide: true` / CREATE_NO_WINDOW takes
// effect. Issue #342: on every chat send the `sendMessageViaCli` fallback
// path spawned `python.exe`, and the console appeared for a few hundred ms
// despite `windowsHide: true` — a well-known race between console allocation
// and CREATE_NO_WINDOW on console-subsystem child binaries. `pythonw.exe`
// is linked as Windows subsystem, so the OS can never allocate a console
// for it regardless of creation flags. It's a bit-identical interpreter
// otherwise — same modules, same stdout/stderr behaviour over piped stdio
// (which is what every call site here uses).
export const HERMES_PYTHON = IS_WINDOWS
  ? join(HERMES_VENV, "Scripts", "pythonw.exe")
  : join(HERMES_VENV, "bin", "python");
export const HERMES_SCRIPT = IS_WINDOWS
  ? join(HERMES_VENV, "Scripts", "hermes.exe")
  : join(HERMES_REPO, "hermes");
export const HERMES_ENV_FILE = join(HERMES_HOME, ".env");
export const HERMES_CONFIG_FILE = join(HERMES_HOME, "config.yaml");
export const HERMES_AUTH_FILE = join(HERMES_HOME, "auth.json");

function currentUserDataPath(): string | null {
  try {
    return app?.getPath?.("userData") || null;
  } catch {
    return null;
  }
}

configureRuntimeInvocationContext({
  hermesHome: HERMES_HOME,
  userDataPath: currentUserDataPath(),
  platform: process.platform,
});
if (selectedRuntimeMode === "external") {
  selectExternalRuntime(HERMES_HOME);
} else {
  selectManagedRuntime();
}

/** Switch to an already prepared managed Runtime without touching the legacy
 * checkout. Returns null when a managed current version is not available. */
export function activateManagedRuntimeMode(): RuntimeInvocation | null {
  const wasExternal = selectedRuntimeMode === "external";
  selectManagedRuntime();
  const invocation = refreshRuntimeInvocation();
  if (invocation?.source !== "managed") {
    if (wasExternal) selectExternalRuntime(HERMES_HOME);
    return null;
  }
  try {
    const file = hermesHomeOverrideFile();
    if (file) {
      persistRuntimeSelection(file, {
        mode: "managed",
        hermesHome: HERMES_HOME,
      });
    }
    selectedRuntimeMode = "managed";
    return invocation;
  } catch {
    if (wasExternal) {
      selectExternalRuntime(HERMES_HOME);
      selectedRuntimeMode = "external";
    }
    return null;
  }
}

/** The Python + hermes-script paths for a Hermes install rooted at `home`,
 *  in the layout the desktop's own installer produces. */
function installBinariesFor(home: string): { python: string; script: string } {
  const repo = join(home, "hermes-agent");
  const venv = join(repo, "venv");
  return IS_WINDOWS
    ? {
        python: join(venv, "Scripts", "python.exe"),
        script: join(venv, "Scripts", "hermes.exe"),
      }
    : { python: join(venv, "bin", "python"), script: join(repo, "hermes") };
}

export function hermesCliArgs(args: string[] = []): string[] {
  return (
    getRuntimeInvocation()?.cliArgs(args) ?? ["-m", "hermes_cli.main", ...args]
  );
}

function runtimeEnvironment(
  invocation: RuntimeInvocation,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return invocation.environment({
    ...process.env,
    PATH: getEnhancedPath(),
    HOME: homedir(),
    HERMES_HOME,
    ...overrides,
  });
}

export interface InstallStatus {
  installed: boolean;
  configured: boolean;
  hasApiKey: boolean;
  verified: boolean;
  activeProfile?: string;
}

export interface InstallProgress {
  step: number;
  totalSteps: number;
  title: string;
  detail: string;
  log: string;
}

export function getEnhancedPath(): string {
  const home = homedir();
  const extra = (
    IS_WINDOWS
      ? [
          // Legacy external installs may bundle these inside HERMES_HOME.
          join(HERMES_HOME, "git", "bin"),
          join(HERMES_HOME, "git", "cmd"),
          join(HERMES_HOME, "git", "usr", "bin"),
          join(HERMES_HOME, "node"),
          join(HERMES_VENV, "Scripts"),
          // Common user/system installs used when Claw3D setup runs before or
          // outside the bundled installer.
          process.env.NVM_SYMLINK,
          process.env.APPDATA ? join(process.env.APPDATA, "npm") : undefined,
          process.env.ProgramFiles
            ? join(process.env.ProgramFiles, "nodejs")
            : undefined,
          process.env["ProgramFiles(x86)"]
            ? join(process.env["ProgramFiles(x86)"], "nodejs")
            : undefined,
          process.env.ProgramFiles
            ? join(process.env.ProgramFiles, "Git", "cmd")
            : undefined,
          process.env.LOCALAPPDATA
            ? join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd")
            : undefined,
          // Where `uv` lands when astral.sh's installer runs.
          join(home, ".local", "bin"),
          join(home, ".cargo", "bin"),
        ]
      : [
          join(home, ".local", "bin"),
          join(home, ".cargo", "bin"),
          join(HERMES_VENV, "bin"),
          // Node version manager shim directories
          join(home, ".volta", "bin"),
          join(home, ".asdf", "shims"),
          join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
          join(home, ".fnm", "aliases", "default", "bin"),
          ...resolveNvmBin(home),
          "/usr/local/bin",
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
        ]
  ).filter((entry): entry is string => Boolean(entry));
  return [...extra, process.env.PATH || ""].filter(Boolean).join(delimiter);
}

/** Resolve the active nvm node version's bin directory. */
function resolveNvmBin(home: string): string[] {
  const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  const versionsDir = join(nvmDir, "versions", "node");
  if (!existsSync(versionsDir)) return [];
  try {
    // Try to read the default alias to find the active version
    const aliasFile = join(nvmDir, "alias", "default");
    if (existsSync(aliasFile)) {
      const alias = readFileSync(aliasFile, "utf-8").trim();
      // alias can be a full version "v20.11.0" or a partial "20" or "lts/*"
      if (alias.startsWith("v")) {
        const bin = join(versionsDir, alias, "bin");
        if (existsSync(bin)) return [bin];
      }
    }
    // Fallback: pick the latest installed version
    const versions = (readdirSync(versionsDir) as string[])
      .filter((d: string) => d.startsWith("v"))
      .sort()
      .reverse();
    if (versions.length > 0) {
      return [join(versionsDir, versions[0], "bin")];
    }
  } catch {
    /* non-fatal */
  }
  return [];
}

function activeEnvFile(profile: string): string {
  return profile === "default"
    ? HERMES_ENV_FILE
    : join(HERMES_HOME, "profiles", profile, ".env");
}

function activeAuthFile(profile: string): string {
  return profile === "default"
    ? HERMES_AUTH_FILE
    : join(HERMES_HOME, "profiles", profile, "auth.json");
}

// Canonical env-var name per known model provider. Keys here are values
// the user might see in `model.provider` in config.yaml; values are the
// env vars the gateway expects to read from .env. Names that don't
// appear here either don't need a key (local providers, nous) or have
// OAuth-style credentials (covered separately via hasHermesAuthCredential).
//
// Used by the install-gate check below. Previously that check
// hard-coded only OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY,
// so any user configured for DeepSeek, Groq, Mistral, etc. saw the
// "set AI provider" first-run screen even with a valid key in .env.
// See issue #236.
const PROVIDER_ENV_KEYS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "ollama-cloud": "OLLAMA_API_KEY",
  aimlapi: "AIMLAPI_API_KEY",
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  mistral: "MISTRAL_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  huggingface: "HF_TOKEN",
  hf: "HF_TOKEN",
  // DashScope: `alibaba` is the canonical agent slug; the rest are the
  // agent's own aliases for it (models.py PROVIDER_ALIASES) — including
  // `qwen`, which every pre-#825 desktop config stored. Only `qwen-oauth`
  // is the Qwen Portal OAuth provider.
  alibaba: "DASHSCOPE_API_KEY",
  dashscope: "DASHSCOPE_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  aliyun: "DASHSCOPE_API_KEY",
  "alibaba-cloud": "DASHSCOPE_API_KEY",
  "qwen-oauth": "QWEN_API_KEY",
  minimax: "MINIMAX_API_KEY",
  glm: "GLM_API_KEY",
  kimi: "KIMI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  // Nous Portal supports BOTH OAuth (`nous` variant) AND API key
  // (`nous-api` variant). Register the env var name under both ids so
  // the install-gate + pre-send validation + config-health audit can
  // detect a missing key — whichever id the user's profile happens to
  // be configured under. The OAuth case is handled separately by
  // checking auth.json via hasOAuthCredentials() (config.ts).
  nous: "NOUS_API_KEY",
  "nous-api": "NOUS_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
};

// When provider is "custom" or "auto", the desktop's setup flow falls
// back to recognizing the endpoint by base URL. Same patterns hermes.ts
// uses for runtime header injection.
const URL_TO_ENV_KEY: Array<[RegExp, string]> = [
  [/openrouter\.ai/i, "OPENROUTER_API_KEY"],
  [/anthropic\.com/i, "ANTHROPIC_API_KEY"],
  [/openai\.com/i, "OPENAI_API_KEY"],
  [/(^|\/\/|\.)ollama\.com(?=\/|:|$)/i, "OLLAMA_API_KEY"],
  [/api\.aimlapi\.com/i, "AIMLAPI_API_KEY"],
  [/huggingface\.co/i, "HF_TOKEN"],
  [/api\.groq\.com/i, "GROQ_API_KEY"],
  [/api\.deepseek\.com/i, "DEEPSEEK_API_KEY"],
  [/api\.together\.xyz/i, "TOGETHER_API_KEY"],
  [/api\.fireworks\.ai/i, "FIREWORKS_API_KEY"],
  [/api\.cerebras\.ai/i, "CEREBRAS_API_KEY"],
  [/atlascloud\.ai/i, "ATLASCLOUD_API_KEY"],
  [/api\.mistral\.ai/i, "MISTRAL_API_KEY"],
  [/api\.perplexity\.ai/i, "PERPLEXITY_API_KEY"],
  [/api\.xiaomimimo\.com/i, "XIAOMI_API_KEY"],
  [/dashscope(-intl)?\.aliyuncs\.com/i, "DASHSCOPE_API_KEY"],
];

/**
 * Resolve the env var name the gateway expects for a given model config.
 * Returns null when the provider/URL combination has no known canonical
 * env var (the caller falls back to a permissive `*_API_KEY|*_TOKEN`
 * scan, matching the spirit of the prior hard-coded check).
 *
 * Exported for unit testing.
 */
export function expectedEnvKeyForModel(
  provider: string,
  baseUrl: string,
): string | null {
  const direct = PROVIDER_ENV_KEYS[provider.trim().toLowerCase()];
  if (direct) return direct;
  for (const [pattern, envKey] of URL_TO_ENV_KEY) {
    if (pattern.test(baseUrl)) return envKey;
  }
  return null;
}

function envHasUsableValue(
  content: string,
  expectedKey: string | null,
): boolean {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    // Strip surrounding quotes so `KEY=""` or `KEY="abc"` parse the
    // same way as `KEY=abc`.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value) continue;

    if (expectedKey) {
      if (key === expectedKey) return true;
    } else {
      // No known mapping for this provider/URL — accept any value that
      // looks like a credential. Avoids regressing users on providers
      // we haven't catalogued explicitly, while still rejecting
      // unrelated env vars (TELEGRAM_BOT_TOKEN etc. shouldn't satisfy
      // the model install gate, but a custom `*_API_KEY` should).
      if (/_API_KEY$/.test(key)) return true;
    }
  }
  return false;
}

/** True when `dir` is a Hermes home the desktop can drive as-is — it must
 *  contain a `hermes-agent` install with the venv binaries in the layout the
 *  desktop expects. A hand-rolled install with a different layout fails here
 *  rather than being silently adopted into a broken state (issue #272). */
export function validateHermesHome(dir: string): boolean {
  const home = dir?.trim();
  if (!home || !existsSync(home)) return false;
  const { python, script } = installBinariesFor(home);
  return existsSync(python) && existsSync(script);
}

export function checkInstallStatus(): InstallStatus {
  const activeProfile = getActiveProfileNameSync();

  // Remote mode: skip local checks entirely
  const conn = getConnectionConfig();
  if (conn.mode === "remote" && conn.remoteUrl) {
    return {
      installed: true,
      configured: true,
      hasApiKey: true,
      verified: true,
      activeProfile,
    };
  }

  // Fast path: file existence is enough to gate the UI. The deep
  // `python --version` check used to run here adds 1–10s of cold-start
  // latency, so it now lives in `verifyInstall()` and is invoked lazily
  // by the renderer after the main UI is mounted.
  const installed = getRuntimeInvocation() !== null;
  const envFile = activeEnvFile(activeProfile);
  const authFile = activeAuthFile(activeProfile);
  const configured = existsSync(envFile) || existsSync(authFile);
  let hasApiKey = false;
  const verified = installed;

  // Local/custom providers don't need an API key. OAuth-backed providers
  // (including credential-pool entries) can be configured through Hermes
  // auth.json instead of .env, so check those before falling back to keys.
  let mc: { provider: string; model: string; baseUrl: string } | null = null;
  try {
    mc = getModelConfig(activeProfile);
    if (
      providerDoesNotNeedApiKey(mc.provider) ||
      hasOAuthCredentials(mc.provider, activeProfile)
    ) {
      hasApiKey = true;
    }
  } catch {
    /* ignore */
  }

  if (!hasApiKey && configured && existsSync(envFile)) {
    try {
      const content = readFileSync(envFile, "utf-8");
      const expectedKey = mc
        ? expectedEnvKeyForModel(mc.provider, mc.baseUrl)
        : null;
      hasApiKey = envHasUsableValue(content, expectedKey);
    } catch {
      /* ignore read errors */
    }
  }

  return { installed, configured, hasApiKey, verified, activeProfile };
}

// Lazy background verification: actually invoke Python to confirm the
// install runs. Called from the renderer after the UI is already up.
let _verifyCache: { ok: boolean; ts: number } | null = null;
const VERIFY_TTL_MS = 5 * 60 * 1000;

export async function verifyInstall(): Promise<boolean> {
  const invocation = getRuntimeInvocation();
  if (invocation === null) return false;
  if (_verifyCache && Date.now() - _verifyCache.ts < VERIFY_TTL_MS) {
    return _verifyCache.ok;
  }
  return new Promise((resolve) => {
    execFile(
      invocation.python,
      invocation.cliArgs(["--version"]),
      {
        cwd: invocation.workingDirectory,
        env: runtimeEnvironment(invocation),
        timeout: 15000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
      (error) => {
        const ok = !error;
        _verifyCache = { ok, ts: Date.now() };
        resolve(ok);
      },
    );
  });
}

// Cached version to avoid re-running the Python process
let _cachedVersion: string | null = null;
let _versionFetching = false;

export async function getHermesVersion(): Promise<string | null> {
  if (_cachedVersion !== null) return _cachedVersion;
  const invocation = getRuntimeInvocation();
  if (invocation === null) return null;
  if (_versionFetching) {
    // Wait for the in-flight fetch but cap the wait. The execFile below
    // has a 15s timeout and its callback unconditionally clears
    // `_versionFetching`, so under normal failure paths the poll
    // unblocks on its own. Pathological cases (callback never invoked,
    // worker killed mid-callback, async exception in handler) would
    // otherwise leak a 100 ms interval per caller forever. Cap at 20s
    // — comfortably above the execFile timeout — and resolve with
    // whatever `_cachedVersion` happens to be (typically `null`),
    // which matches the same return shape callers already handle.
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = setInterval(() => {
        if (!_versionFetching || Date.now() - startedAt > 20_000) {
          clearInterval(check);
          resolve(_cachedVersion);
        }
      }, 100);
    });
  }
  _versionFetching = true;
  return new Promise((resolve) => {
    execFile(
      invocation.python,
      invocation.cliArgs(["--version"]),
      {
        cwd: invocation.workingDirectory,
        env: runtimeEnvironment(invocation),
        timeout: 15000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
      (error, stdout) => {
        _versionFetching = false;
        if (error) {
          resolve(null);
        } else {
          _cachedVersion = stdout.toString().trim();
          resolve(_cachedVersion);
        }
      },
    );
  });
}

export function clearVersionCache(): void {
  _cachedVersion = null;
}

export function runHermesDoctor(): string {
  const invocation = getRuntimeInvocation();
  if (invocation === null) {
    return "AgentEra Runtime is not installed.";
  }
  try {
    const output = execFileSync(
      invocation.python,
      invocation.cliArgs(["doctor"]),
      {
        cwd: invocation.workingDirectory,
        env: runtimeEnvironment(invocation),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
    );
    return stripAnsi(output.toString());
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() || "";
    return stripAnsi(stderr) || "Doctor check failed.";
  }
}

const OPENCLAW_DIR_NAMES = [".openclaw", ".clawdbot", ".moldbot"];

// hermes-desktop itself creates ~/.openclaw/claw3d/ as a stub when preparing
// Claw3D settings (see claw3d.ts:writeClaw3dSettings), so a bare `existsSync`
// check would surface that empty stub as a "real" OpenClaw install and
// prompt the user to migrate from themselves. Require at least one regular
// file anywhere in the tree so empty scaffolding doesn't trigger the banner.
function dirContainsAnyFile(dir: string, maxDepth = 3): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) return true;
      if (entry.isDirectory() && maxDepth > 0) {
        if (dirContainsAnyFile(join(dir, entry.name), maxDepth - 1)) {
          return true;
        }
      }
    }
  } catch {
    // unreadable → treat as empty
  }
  return false;
}

export function checkOpenClawExists(home: string = homedir()): {
  found: boolean;
  path: string | null;
} {
  for (const name of OPENCLAW_DIR_NAMES) {
    const dir = join(home, name);
    if (existsSync(dir) && dirContainsAnyFile(dir)) {
      return { found: true, path: dir };
    }
  }
  return { found: false, path: null };
}

export async function runClawMigrate(
  onProgress: (progress: InstallProgress) => void,
): Promise<void> {
  const invocation = getRuntimeInvocation();
  if (invocation === null) {
    throw new Error("AgentEra Runtime is not installed.");
  }

  const openclaw = checkOpenClawExists();
  if (!openclaw.found) {
    throw new Error("No OpenClaw installation found.");
  }

  let log = "";
  function emit(text: string): void {
    log += text;
    onProgress({
      step: 1,
      totalSteps: 1,
      title: "Migrating from OpenClaw",
      detail: text.trim().slice(0, 120),
      log,
    });
  }

  emit(`Migrating from ${openclaw.path}...\n`);

  return new Promise((resolve, reject) => {
    const args = invocation.cliArgs(["claw", "migrate", "--preset", "full"]);

    const proc = spawn(invocation.python, args, {
      cwd: invocation.workingDirectory,
      env: runtimeEnvironment(invocation, {
        TERM: "dumb",
      }),
      stdio: ["ignore", "pipe", "pipe"],
      ...HIDDEN_SUBPROCESS_OPTIONS,
    });

    proc.stdout?.on("data", (data: Buffer) => {
      emit(stripAnsi(data.toString()));
    });

    proc.stderr?.on("data", (data: Buffer) => {
      emit(stripAnsi(data.toString()));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        emit("\nMigration complete!\n");
        resolve();
      } else {
        reject(new Error(`Migration failed (exit code ${code}).`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to run migration: ${err.message}`));
    });
  });
}

// @lat: [[agentera-runtime-distribution#Explicit external compatibility]]
export async function runHermesUpdate(
  onProgress: (progress: InstallProgress) => void,
  spawnRuntime: typeof spawn = spawn,
): Promise<void> {
  const invocation = getRuntimeInvocation();
  if (invocation === null) {
    throw new Error(
      "AgentEra Runtime is not installed. Please install it first.",
    );
  }
  if (invocation.source === "managed") {
    throw new Error(
      "Managed AgentEra Runtime updates are installed through the signed desktop update flow.",
    );
  }

  let log = "";
  function emit(text: string): void {
    log += text;
    onProgress({
      step: 1,
      totalSteps: 1,
      title: "Updating AgentEra Runtime",
      detail: text.trim().slice(0, 120),
      log,
    });
  }

  emit("Running hermes update...\n");

  return new Promise((resolve, reject) => {
    const proc = spawnRuntime(
      invocation.python,
      invocation.cliArgs(["update"]),
      {
        cwd: invocation.workingDirectory,
        env: runtimeEnvironment(invocation, {
          TERM: "dumb",
        }),
        stdio: ["ignore", "pipe", "pipe"],
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
    );

    proc.stdout?.on("data", (data: Buffer) => {
      emit(stripAnsi(data.toString()));
    });

    proc.stderr?.on("data", (data: Buffer) => {
      emit(stripAnsi(data.toString()));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        emit("\nUpdate complete!\n");
        resolve();
      } else {
        reject(new Error(`Update failed (exit code ${code}).`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to run update: ${err.message}`));
    });
  });
}

function packagedRuntimeSeedDirectory(): string {
  return resolvePackagedRuntimeSeedDirectory({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    workingDirectory: process.cwd(),
    developmentOverride: process.env.AGENTERA_RUNTIME_SEED_DIR,
  });
}

function runtimeTrustFile(): string {
  const candidates = [
    join(
      process.resourcesPath,
      "app.asar.unpacked",
      "resources",
      "agentera-runtime-trust.json",
    ),
    join(
      process.resourcesPath,
      "app.asar",
      "resources",
      "agentera-runtime-trust.json",
    ),
    join(process.cwd(), "resources", "agentera-runtime-trust.json"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("AgentEra Runtime trust document is missing");
  return path;
}

function nativeRuntimeTarget(): {
  platform: "darwin" | "windows";
  arch: "arm64" | "x64";
} {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { platform: "darwin", arch: "arm64" };
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return { platform: "windows", arch: "x64" };
  }
  throw new Error(
    `Bundled AgentEra Runtime is not available for ${process.platform}-${process.arch}`,
  );
}

/** Prepare the signed Seed shipped inside the desktop package. This path is
 * deliberately local-only: no Git, package manager, shell installer, or HTTP
 * fallback is reachable from it. */
export async function runPackagedSeedInstall(
  onProgress: (progress: InstallProgress) => void,
): Promise<PackagedSeedInstallResult> {
  const restoreExternalOnFailure = selectedRuntimeMode === "external";
  const target = nativeRuntimeTarget();
  const userDataPath = app.getPath("userData");
  configureRuntimeInvocationContext({
    hermesHome: HERMES_HOME,
    userDataPath,
    platform: process.platform,
  });
  const paths = createRuntimeDistributionPaths(
    userDataPath,
    packagedRuntimeSeedDirectory(),
  );
  let log = "";
  const result = await installPackagedSeed({
    paths,
    trustedPublicKeys: loadRuntimeTrustFile(runtimeTrustFile()),
    manifestContext: {
      repository: "bignormal/aera-runtime",
      platform: target.platform,
      arch: target.arch,
      desktopVersion: app.getVersion(),
      allowedChannels: new Set(["candidate", "stable"]),
    },
    availableDiskBytes: getAvailableRuntimeDiskBytes,
    onProgress: (progress) => {
      const line = `${progress.detail}\n`;
      log += line;
      onProgress({ ...progress, log });
    },
  });
  if (result.status === "installed") {
    clearVersionCache();
    if (activateManagedRuntimeMode() === null) {
      return {
        ...result,
        status: "repair-required",
        errorCode: "runtime-activation-failed",
        action: "retry",
      };
    }
  } else if (restoreExternalOnFailure) {
    selectExternalRuntime(HERMES_HOME);
    selectedRuntimeMode = "external";
  }
  return result;
}

// ────────────────────────────────────────────────────
//  Backup & Import
// ────────────────────────────────────────────────────

export async function runHermesBackup(
  profile?: string,
): Promise<{ success: boolean; path?: string; error?: string }> {
  const invocation = getRuntimeInvocation();
  if (invocation === null) {
    return { success: false, error: "AgentEra Runtime is not installed." };
  }
  const args = invocation.cliArgs();
  if (profile && profile !== "default") args.push("-p", profile);
  args.push("backup");

  return new Promise((resolve) => {
    execFile(
      invocation.python,
      args,
      {
        cwd: invocation.workingDirectory,
        env: runtimeEnvironment(invocation, {
          TERM: "dumb",
        }),
        timeout: 120000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            error: stripAnsi(stderr || error.message).slice(0, 500),
          });
          return;
        }
        const output = stripAnsi(stdout);
        // Try to extract the backup file path from output
        const pathMatch = output.match(
          /(?:Backup saved|Written|Created).*?(\S+\.(?:tar\.gz|zip|tgz))/i,
        );
        resolve({
          success: true,
          path: pathMatch?.[1] || output.trim().split("\n").pop()?.trim(),
        });
      },
    );
  });
}

export async function runHermesImport(
  archivePath: string,
  profile?: string,
): Promise<{ success: boolean; error?: string }> {
  const archive = validateImportArchivePath(archivePath);
  if (!archive.success) {
    return { success: false, error: archive.error };
  }

  const invocation = getRuntimeInvocation();
  if (invocation === null) {
    return { success: false, error: "AgentEra Runtime is not installed." };
  }
  const args = invocation.cliArgs();
  if (profile && profile !== "default") args.push("-p", profile);
  args.push("import", archive.path);

  return new Promise((resolve) => {
    execFile(
      invocation.python,
      args,
      {
        cwd: invocation.workingDirectory,
        env: runtimeEnvironment(invocation, {
          TERM: "dumb",
        }),
        timeout: 120000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
      (error, _stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            error: stripAnsi(stderr || error.message).slice(0, 500),
          });
          return;
        }
        resolve({ success: true });
      },
    );
  });
}

export function validateImportArchivePath(
  archivePath: unknown,
): { success: true; path: string } | { success: false; error: string } {
  if (typeof archivePath !== "string" || archivePath.trim() === "") {
    return { success: false, error: "Import archive path is required." };
  }

  const path = resolve(archivePath);
  if (!existsSync(path)) {
    return { success: false, error: "Import archive does not exist." };
  }

  try {
    if (!statSync(path).isFile()) {
      return { success: false, error: "Import archive must be a file." };
    }
  } catch {
    return { success: false, error: "Import archive is not readable." };
  }

  return { success: true, path };
}

// ────────────────────────────────────────────────────
//  Debug dump
// ────────────────────────────────────────────────────

export function runHermesDump(): Promise<string> {
  const invocation = getRuntimeInvocation();
  if (invocation === null) {
    return Promise.resolve("AgentEra Runtime is not installed.");
  }
  return new Promise((resolve) => {
    execFile(
      invocation.python,
      invocation.cliArgs(["dump"]),
      {
        cwd: invocation.workingDirectory,
        env: runtimeEnvironment(invocation, {
          TERM: "dumb",
        }),
        timeout: 30000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(stripAnsi(stderr || error.message));
        } else {
          resolve(stripAnsi(stdout));
        }
      },
    );
  });
}

// ────────────────────────────────────────────────────
//  Memory provider discovery
// ────────────────────────────────────────────────────

export interface MemoryProviderInfo {
  name: string;
  description: string;
  installed: boolean;
  active: boolean;
  envVars: string[];
}

/**
 * Discover available memory providers by scanning the plugins directory
 * and reading config.yaml for the active provider.
 */
export function discoverMemoryProviders(
  profile?: string,
): MemoryProviderInfo[] {
  const invocation = getRuntimeInvocation();
  if (invocation === null) return [];
  const pluginsDir = join(invocation.workingDirectory, "plugins", "memory");
  if (!existsSync(pluginsDir)) return [];

  const activeProvider = getActiveMemoryProvider(profile);

  // Known providers with their metadata (from plugin.yaml files)
  const KNOWN_PROVIDERS: Record<
    string,
    { description: string; envVars: string[]; pip?: string }
  > = {
    honcho: {
      description: "memory.providers.honcho",
      envVars: ["HONCHO_API_KEY"],
      pip: "honcho-ai",
    },
    hindsight: {
      description: "memory.providers.hindsight",
      envVars: ["HINDSIGHT_API_KEY", "HINDSIGHT_API_URL", "HINDSIGHT_BANK_ID"],
      pip: "hindsight-client",
    },
    mem0: {
      description: "memory.providers.mem0",
      envVars: ["MEM0_API_KEY"],
      pip: "mem0ai",
    },
    retaindb: {
      description: "memory.providers.retaindb",
      envVars: ["RETAINDB_API_KEY"],
    },
    supermemory: {
      description: "memory.providers.supermemory",
      envVars: ["SUPERMEMORY_API_KEY"],
      pip: "supermemory",
    },
    holographic: {
      description: "memory.providers.holographic",
      envVars: [],
    },
    openviking: {
      description: "memory.providers.openviking",
      envVars: ["OPENVIKING_ENDPOINT", "OPENVIKING_API_KEY"],
    },
    byterover: {
      description: "memory.providers.byterover",
      envVars: ["BRV_API_KEY"],
    },
  };

  const results: MemoryProviderInfo[] = [];

  try {
    const dirs = readdirSync(pluginsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith("_")) continue;
      const name = d.name;
      const known = KNOWN_PROVIDERS[name];
      const initFile = join(pluginsDir, name, "__init__.py");
      const installed = existsSync(initFile);

      results.push({
        name,
        description: known?.description || name,
        installed,
        active: name === activeProvider,
        envVars: known?.envVars || [],
      });
    }
  } catch {
    /* non-fatal */
  }

  // Sort: active first, then installed, then alphabetical
  results.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * Read the active memory provider from config.yaml.
 */
export function getActiveMemoryProvider(profile?: string): string {
  try {
    const configPath = join(profileHome(profile), "config.yaml");
    if (!existsSync(configPath)) return "";
    const content = readFileSync(configPath, "utf-8");
    const match = content.match(/^\s*provider:\s*["']?(\w+)["']?\s*$/m);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

// ────────────────────────────────────────────────────
//  MCP server management
// ────────────────────────────────────────────────────

export function listMcpServers(
  profile?: string,
): Array<{ name: string; type: string; enabled: boolean; detail: string }> {
  try {
    const configPath = join(profileHome(profile), "config.yaml");
    if (!existsSync(configPath)) return [];
    const content = readFileSync(configPath, "utf-8");
    // Simple YAML parse for mcp_servers section
    const match = content.match(/^mcp_servers:\s*\n((?:[ \t]+.+\n)*)/m);
    if (!match) return [];

    const servers: Array<{
      name: string;
      type: string;
      enabled: boolean;
      detail: string;
    }> = [];
    const block = match[1];
    // Each top-level key under mcp_servers is a server name (2-space indent)
    const nameRe = /^[ ]{2}(\w[\w-]*):\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(block)) !== null) {
      const name = m[1];
      // Extract following indented block for this server.
      // Find the next line at exactly 2-space indent (next server name).
      const start = m.index + m[0].length;
      const nextMatch = /\n {2}\w/g;
      nextMatch.lastIndex = start;
      const next = nextMatch.exec(block);
      const serverBlock = block.slice(start, next ? next.index : undefined);
      const hasUrl = /url:/.test(serverBlock);
      const hasCommand = /command:/.test(serverBlock);
      const enabledMatch = serverBlock.match(/enabled:\s*(true|false)/i);
      const enabled =
        enabledMatch === null || enabledMatch[1].toLowerCase() === "true";

      let detail = "";
      if (hasUrl) {
        const urlMatch = serverBlock.match(/url:\s*["']?([^\s"']+)/);
        detail = urlMatch?.[1] || "HTTP";
      } else if (hasCommand) {
        const cmdMatch = serverBlock.match(/command:\s*["']?([^\s"']+)/);
        detail = cmdMatch?.[1] || "stdio";
      }

      servers.push({
        name,
        type: hasUrl ? "http" : "stdio",
        enabled,
        detail,
      });
    }
    return servers;
  } catch {
    return [];
  }
}

// ────────────────────────────────────────────────────
//  Log viewer
// ────────────────────────────────────────────────────

export function readLogs(
  logFile = "agent.log",
  lines = 200,
): { content: string; path: string } {
  const logsDir = join(HERMES_HOME, "logs");
  // Sanitize: only allow known log file names
  const allowed = ["agent.log", "errors.log", "gateway.log"];
  const file = allowed.includes(logFile) ? logFile : "agent.log";
  const fullPath = join(logsDir, file);

  if (!existsSync(fullPath)) {
    return { content: "", path: fullPath };
  }
  try {
    const content = readFileSync(fullPath, "utf-8");
    // Return the last N lines
    const allLines = content.split("\n");
    const tail = allLines.slice(-lines).join("\n");
    return { content: tail, path: fullPath };
  } catch {
    return { content: "", path: fullPath };
  }
}
