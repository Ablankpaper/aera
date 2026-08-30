#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * Diagnose where a packaged Windows Runtime Gateway launch stalls.
 *
 * The candidate failure was originally labelled `serve --help`, but the
 * independent Runtime health probes proved that command healthy. This tool
 * follows the managed Desktop invocation instead: it keeps the packaged
 * Runtime's Python and site-packages cwd, materialises the smallest Desktop
 * API-server config, and records one bounded evidence chain.
 *
 * Evidence is JSONL. It contains bounded output tails and process facts only;
 * paths, bearer values, API keys, and provider credentials are redacted before
 * either stdout or the optional file receives a line.
 *
 * Usage:
 *   node scripts/diagnose-windows-serve-help.mjs \
 *     --runtime-root <extracted seed dir> --manifest <manifest.json> \
 *     [--launch-mode traced|direct|instrumented] \
 *     [--home-mode fake|candidate] [--timeout-ms 150000] [--output <path>]
 */

import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DIAGNOSTIC_TAIL_BYTES = 16 * 1024;
const SAMPLE_INTERVAL_MS = 2_000;
const READINESS_POLL_MS = 500;
const CAPABILITIES_TIMEOUT_MS = 2_000;
const CLEANUP_WAIT_MS = 5_000;
const WINDOWS_PROCESS_EVIDENCE_QUERY_TIMEOUT_MS = 5_000;
const WINDOWS_PROCESS_EVIDENCE_RETRY_DELAY_MS = 100;
const WINDOWS_PROCESS_EVIDENCE_MAX_ATTEMPTS = 2;
const SAFE_SYSTEM_ENV_NAMES = [
  "SystemDrive",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TMP",
  "TEMP",
];

function isWindowsPlatform(platform) {
  return platform === "windows" || platform === "win32";
}

function pathApiForPlatform(platform) {
  return isWindowsPlatform(platform) ? path.win32 : path.posix;
}

function buildDesktopEnhancedPath({
  platform,
  python,
  hermesHome,
  home,
  baseEnv,
}) {
  const windows = isWindowsPlatform(platform);
  const pathApi = pathApiForPlatform(platform);
  const existing = readCaseInsensitiveEnv(baseEnv, "PATH") ?? "";
  const homeRoot = home || "";
  const candidates = windows
    ? [
        pathApi.join(hermesHome, "git", "bin"),
        pathApi.join(hermesHome, "git", "cmd"),
        pathApi.join(hermesHome, "git", "usr", "bin"),
        pathApi.join(hermesHome, "node"),
        pathApi.join(hermesHome, "hermes-agent", "venv", "Scripts"),
        readCaseInsensitiveEnv(baseEnv, "NVM_SYMLINK"),
        readCaseInsensitiveEnv(baseEnv, "APPDATA")
          ? pathApi.join(readCaseInsensitiveEnv(baseEnv, "APPDATA"), "npm")
          : undefined,
        readCaseInsensitiveEnv(baseEnv, "ProgramFiles")
          ? pathApi.join(
              readCaseInsensitiveEnv(baseEnv, "ProgramFiles"),
              "nodejs",
            )
          : undefined,
        readCaseInsensitiveEnv(baseEnv, "ProgramFiles(x86)")
          ? pathApi.join(
              readCaseInsensitiveEnv(baseEnv, "ProgramFiles(x86)"),
              "nodejs",
            )
          : undefined,
        readCaseInsensitiveEnv(baseEnv, "ProgramFiles")
          ? pathApi.join(
              readCaseInsensitiveEnv(baseEnv, "ProgramFiles"),
              "Git",
              "cmd",
            )
          : undefined,
        readCaseInsensitiveEnv(baseEnv, "LOCALAPPDATA")
          ? pathApi.join(
              readCaseInsensitiveEnv(baseEnv, "LOCALAPPDATA"),
              "Programs",
              "Git",
              "cmd",
            )
          : undefined,
        homeRoot ? pathApi.join(homeRoot, ".local", "bin") : undefined,
        homeRoot ? pathApi.join(homeRoot, ".cargo", "bin") : undefined,
      ]
    : [
        homeRoot ? pathApi.join(homeRoot, ".local", "bin") : undefined,
        homeRoot ? pathApi.join(homeRoot, ".cargo", "bin") : undefined,
        pathApi.join(hermesHome, "hermes-agent", "venv", "bin"),
        homeRoot ? pathApi.join(homeRoot, ".volta", "bin") : undefined,
        homeRoot ? pathApi.join(homeRoot, ".asdf", "shims") : undefined,
      ];
  return [...new Set([pathApi.dirname(python), ...candidates, existing])]
    .filter(Boolean)
    .join(windows ? ";" : ":");
}

function readCaseInsensitiveEnv(baseEnv, name) {
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (key.toLowerCase() === name.toLowerCase() && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function positivePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("diagnostic API-server port must be between 1 and 65535");
  }
  return port;
}

function safeSecret(value) {
  const secret = String(value ?? "");
  if (!secret || /[\r\n\0]/u.test(secret)) {
    throw new Error("diagnostic API-server key is invalid");
  }
  return secret;
}

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function profileCommandArgs(profile) {
  if (profile === undefined || profile === null || profile === "default") {
    return [];
  }
  if (typeof profile !== "string" || !PROFILE_NAME_PATTERN.test(profile)) {
    throw new Error("diagnostic Profile name is invalid");
  }
  return ["--profile", profile];
}

/**
 * Build the smallest environment that still behaves like a managed Desktop
 * Gateway launch. The parent environment is intentionally not spread: CI
 * markers, provider credentials, PYTHONHOME, and PYTHONPATH must not reach the
 * diagnostic child. Offline package-manager flags and locale/proxy overrides
 * used by the independent health probe are intentionally absent here: they
 * would change the managed Gateway dispatch boundary we are trying to observe.
 */
export function buildManagedGatewayEnvironment({
  platform,
  python,
  hermesHome,
  fakeHome,
  homeMode = "fake",
  apiServerKey,
  apiServerPort,
  baseEnv = process.env,
  envMode = "minimal",
}) {
  if (!new Set(["fake", "candidate"]).has(homeMode)) {
    throw new Error("--home-mode must be fake or candidate");
  }
  const windows = isWindowsPlatform(platform);
  const pathApi = pathApiForPlatform(platform);
  const delimiter = windows ? ";" : ":";

  const systemPath = readCaseInsensitiveEnv(baseEnv, "PATH") ?? "";
  const pythonDirectory = pathApi.dirname(python);
  const inheritedHome = readCaseInsensitiveEnv(baseEnv, "HOME");
  const managedPath =
    envMode === "desktop"
      ? buildDesktopEnhancedPath({
          platform,
          python,
          hermesHome,
          home:
            homeMode === "candidate" ? (inheritedHome ?? fakeHome) : fakeHome,
          baseEnv,
        })
      : [pythonDirectory, systemPath].filter(Boolean).join(delimiter);

  if (envMode === "desktop") {
    // Reproduce hermes.ts buildGatewayEnv(): the managed Desktop spawn
    // spreads the parent environment and then overrides only the managed
    // fields. CI markers and runner variables therefore DO reach the child —
    // exactly the boundary the controlled diagnostic must observe.
    const environment = { ...baseEnv };
    Object.assign(environment, {
      PATH: managedPath,
      HERMES_HOME: hermesHome,
      API_SERVER_ENABLED: "true",
      API_SERVER_PORT: String(positivePort(apiServerPort)),
      API_SERVER_KEY: safeSecret(apiServerKey),
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    });
    if (homeMode === "fake") {
      environment.HOME = fakeHome;
    } else {
      // The packaged Desktop launch inherits the machine user's home and
      // AppData roots. Preserve those values while still isolating
      // HERMES_HOME so this diagnostic cannot touch the user's Runtime data.
      for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
        const inherited = readCaseInsensitiveEnv(baseEnv, name);
        if (inherited !== undefined) environment[name] = inherited;
      }
    }
    return environment;
  }

  const environment = {};

  for (const name of SAFE_SYSTEM_ENV_NAMES) {
    const value = readCaseInsensitiveEnv(baseEnv, name);
    if (value !== undefined) environment[name] = value;
  }

  const systemPathLegacy = readCaseInsensitiveEnv(baseEnv, "PATH") ?? "";
  const pythonDirectoryLegacy = pathApi.dirname(python);
  // Match RuntimeInvocation.environment(): managed Desktop prepends only the
  // selected interpreter directory to the already-enhanced parent PATH. Do
  // not add runtimeRoot/runtime here; doing so would admit a command lookup
  // that the real managed Gateway does not receive and could hide the actual
  // packaged dispatch failure we are trying to localise.
  environment.PATH = [pythonDirectoryLegacy, systemPathLegacy]
    .filter(Boolean)
    .join(delimiter);

  Object.assign(environment, {
    HERMES_HOME: hermesHome,
    API_SERVER_ENABLED: "true",
    API_SERVER_PORT: String(positivePort(apiServerPort)),
    API_SERVER_KEY: safeSecret(apiServerKey),
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  });
  if (homeMode === "fake") {
    Object.assign(environment, {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      APPDATA: pathApi.join(fakeHome, "AppData", "Roaming"),
      LOCALAPPDATA: pathApi.join(fakeHome, "AppData", "Local"),
    });
  } else {
    for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
      const inherited = readCaseInsensitiveEnv(baseEnv, name);
      if (inherited !== undefined) environment[name] = inherited;
    }
  }

  // Keep this explicit even though the object starts empty. It protects a
  // future caller that passes a pre-built object into this helper.
  for (const key of Object.keys(environment)) {
    if (["PYTHONHOME", "PYTHONPATH", "CI"].includes(key.toUpperCase())) {
      delete environment[key];
    }
  }
  return environment;
}

/** Materialise the minimal files Desktop writes before a local Gateway spawn. */
export function buildManagedGatewayConfig({ apiServerKey, apiServerPort }) {
  const key = safeSecret(apiServerKey);
  const port = positivePort(apiServerPort);
  return {
    envFile: `API_SERVER_KEY=${key}\n`,
    configYaml: [
      "platforms:",
      "  api_server:",
      "    enabled: true",
      "    extra:",
      `      port: ${port}`,
      '      host: "127.0.0.1"',
      "",
    ].join("\n"),
  };
}

function guardedImportScript(moduleName) {
  return `import ${moduleName}`;
}

function stackTraceGatewayScript(moduleName, profile) {
  const profileArgs = profileCommandArgs(profile);
  return [
    "import faulthandler,runpy,sys",
    "faulthandler.enable()",
    "faulthandler.dump_traceback_later(10.0, repeat=True)",
    `sys.argv=${JSON.stringify(["aera-managed-gateway-diagnostic", ...profileArgs, "gateway"])}`,
    `runpy.run_module(${JSON.stringify(moduleName)},run_name="__main__")`,
  ].join(";");
}

function syncBundledSkillsScript(moduleName, profile) {
  const profileArgs = profileCommandArgs(profile);
  return [
    "import faulthandler,importlib,sys",
    "faulthandler.enable()",
    "faulthandler.dump_traceback_later(10.0, repeat=True)",
    `sys.argv=${JSON.stringify([
      "aera-managed-gateway-diagnostic",
      ...profileArgs,
    ])}`,
    `main=importlib.import_module(${JSON.stringify(moduleName)})`,
    "main._sync_bundled_skills_quietly()",
  ].join(";");
}

/**
 * Build a diagnostic-only Python wrapper that starts the exact managed CLI
 * command while recording the first startup functions it enters and periodic
 * faulthandler stacks. Evidence paths are supplied through the child
 * environment so they never become command-line secrets or path-bearing
 * arguments in the emitted diagnostic record.
 */
export function buildGatewayInstrumentationScript({ module, profile }) {
  const profileArgs = profileCommandArgs(profile);
  const argv = ["aera-managed-gateway-diagnostic", ...profileArgs, "gateway"];
  const targets = [
    "cmd_gateway",
    "gateway_command",
    "_gateway_command_inner",
    "run_gateway",
    "start_gateway",
    "sync_skills",
    "_sync_bundled_skills_quietly",
    "_sync_bundled_skills_for_startup",
    "record_boot_fingerprint",
    "record_start_and_check_storm",
    "GatewayRunner",
    "GatewayRunner.__init__",
    "setup_logging",
    "acquire_gateway_runtime_lock",
    "write_pid_file",
    "_guard_existing_gateway_process_conflict",
    "_guard_named_profile_under_multiplexer",
    "_guard_supervised_gateway_conflict",
    "_ensure_windows_gateway_venv_imports",
    "discover_mcp_tools",
  ];
  return [
    "import faulthandler,json,os,runpy,sys,time,traceback",
    "_marker_path=os.environ.get('AERA_GATEWAY_DIAGNOSTIC_MARKER')",
    "_stack_path=os.environ.get('AERA_GATEWAY_DIAGNOSTIC_STACK')",
    "_marker_file=None",
    "_stack_file=None",
    "_seen=set()",
    "_event_count=0",
    "_targets=frozenset(" + JSON.stringify(targets) + ")",
    "_files=tuple(('hermes_cli/main.py','hermes_cli/gateway.py','gateway/run.py','gateway/status.py','gateway/code_skew.py','tools/skills_sync.py','hermes_logging.py'))",
    "_file_suffixes=tuple(part.lower() for part in _files)",
    "def _open_files():\n  global _marker_file,_stack_file\n  try:\n    if _marker_path: _marker_file=open(_marker_path,'a',encoding='utf-8',buffering=1)\n  except Exception: _marker_file=None\n  try:\n    if _stack_path: _stack_file=open(_stack_path,'ab',buffering=0)\n  except Exception: _stack_file=None",
    "def _write(event,**extra):\n  global _event_count\n  if _marker_file is None or _event_count >= 512: return\n  try:\n    payload={'event':event,'elapsedMs':int(time.monotonic()*1000)-_started,**extra}\n    _marker_file.write(json.dumps(payload,default=str,separators=(',',':'))+'\\n')\n    _marker_file.flush()\n    _event_count += 1\n  except Exception: pass",
    "def _profile(frame,event,arg):\n  if event not in ('call','return'): return _profile\n  code=frame.f_code\n  short=code.co_name\n  name=getattr(code,'co_qualname',short)\n  if short not in _targets and name not in _targets: return _profile\n  filename=code.co_filename\n  if not filename.replace('\\\\','/').lower().endswith(_file_suffixes): return _profile\n  key=(event,filename,name,frame.f_lineno)\n  if event == 'return' and key in _seen: return _profile\n  if len(_seen) >= 512: return _profile\n  _seen.add(key)\n  _write('function-'+('enter' if event == 'call' else 'return'),function=name,file=filename.replace('\\\\','/').rsplit('/',1)[-1],line=frame.f_lineno,thread='main')\n  return _profile",
    "_started=int(time.monotonic()*1000)",
    "_open_files()",
    "_write('wrapper-start',pid=os.getpid(),argv=sys.argv)",
    "if _stack_file is not None:\n  try:\n    faulthandler.enable(file=_stack_file,all_threads=True)\n    faulthandler.dump_traceback_later(10.0,repeat=True,file=_stack_file)\n  except Exception as _fault_error:\n    _write('faulthandler-error',error=repr(_fault_error))",
    "sys.setprofile(_profile)",
    "sys.argv=" + JSON.stringify(argv),
    "_write('dispatch-before',module=" + JSON.stringify(module) + ")",
    "try:\n  runpy.run_module(" +
      JSON.stringify(module) +
      ",run_name='__main__')\nexcept BaseException as _error:\n  _write('dispatch-exception',error=repr(_error),traceback=traceback.format_exc())\n  raise\nfinally:\n  sys.setprofile(None)\n  _write('dispatch-after')\n  try: faulthandler.cancel_dump_traceback_later()\n  except Exception: pass\n  try:\n    if _marker_file is not None: _marker_file.close()\n  except Exception: pass\n  try:\n    if _stack_file is not None: _stack_file.close()\n  except Exception: pass",
  ].join("\n");
}

/**
 * Return the phase boundaries used by the managed Gateway diagnostic. These
 * six phases are the normal chain; the stack-trace phase is constructed
 * separately and appended only after the traced Gateway launch times out.
 */
export function buildManagedGatewayPhases({
  module,
  profile,
  python,
  cwd,
  launchMode = "traced",
}) {
  const profileArgs = profileCommandArgs(profile);
  if (launchMode === "direct") {
    return [
      {
        name: "gateway-direct",
        file: python,
        cwd,
        args: ["-m", module, ...profileArgs, "gateway"],
        waitForGateway: true,
        instrumented: false,
        diagnosticOnly: false,
      },
    ];
  }
  if (launchMode === "instrumented") {
    return [
      {
        name: "gateway-instrumented",
        file: python,
        cwd,
        args: ["-c", buildGatewayInstrumentationScript({ module, profile })],
        waitForGateway: true,
        instrumented: true,
        diagnosticOnly: true,
      },
    ];
  }
  if (launchMode !== "traced") {
    throw new Error("launchMode must be traced, direct, or instrumented");
  }
  return [
    {
      name: "managed-version",
      file: python,
      cwd,
      args: ["-m", module, ...profileArgs, "--version"],
      waitForGateway: false,
    },
    {
      name: "import-hermes-cli-main",
      file: python,
      cwd,
      args: ["-X", "importtime", "-c", guardedImportScript(module)],
      waitForGateway: false,
    },
    {
      name: "sync-bundled-skills",
      file: python,
      cwd,
      args: [
        "-X",
        "importtime",
        "-c",
        syncBundledSkillsScript(module, profile),
      ],
      waitForGateway: false,
    },
    {
      name: "import-hermes-cli-gateway",
      file: python,
      cwd,
      args: [
        "-X",
        "importtime",
        "-c",
        guardedImportScript("hermes_cli.gateway"),
      ],
      waitForGateway: false,
    },
    {
      name: "import-gateway-run",
      file: python,
      cwd,
      args: ["-X", "importtime", "-c", guardedImportScript("gateway.run")],
      waitForGateway: false,
    },
    {
      name: "gateway-importtime",
      file: python,
      cwd,
      // This is the exact managed Desktop command with importtime added as a
      // diagnostic-only interpreter flag.
      args: ["-X", "importtime", "-m", module, ...profileArgs, "gateway"],
      waitForGateway: true,
    },
  ];
}

export function buildGatewayStacktracePhase({ module, profile, python, cwd }) {
  return {
    name: "gateway-stacktrace",
    file: python,
    cwd,
    args: ["-c", stackTraceGatewayScript(module, profile)],
    waitForGateway: true,
  };
}

function normalizeWindowsPath(value) {
  if (typeof value !== "string") return null;
  let trimmed = value.trim();
  if (!trimmed) return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  let normalized = path.win32.normalize(trimmed.replaceAll("/", "\\"));
  if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
  return normalized.replace(/[\\/]+$/u, "").toLowerCase();
}

function parsePositivePid(value) {
  const pid =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value.trim())
        ? Number(value.trim())
        : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function emptyProcessEvidence(queryOutcome) {
  return {
    available: false,
    valid: false,
    pid: null,
    identity: null,
    imageName: null,
    executablePath: null,
    queryOutcome,
    commandLine: null,
  };
}

/**
 * Parse one bounded Windows CIM row and compare it with the packaged Python.
 * A PID is never enough: the row must carry a creation token, image,
 * executable path, and command line. Arrays are searched for the requested
 * PID instead of blindly taking their first element.
 */
export function parseWindowsProcessEvidence(
  raw,
  expectedPython,
  expectedPid = null,
) {
  const rawText = String(raw ?? "");
  if (!rawText.trim()) return emptyProcessEvidence("empty");
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return emptyProcessEvidence("invalid-json");
  }

  const expected = parsePositivePid(expectedPid);
  let row;
  if (Array.isArray(parsed)) {
    const rows = parsed.filter(
      (candidate) =>
        candidate && typeof candidate === "object" && !Array.isArray(candidate),
    );
    if (rows.length === 0) return emptyProcessEvidence("empty");
    row = expected
      ? rows.find(
          (candidate) => parsePositivePid(candidate.ProcessId) === expected,
        )
      : rows[0];
    if (!row) {
      return {
        ...emptyProcessEvidence("pid-mismatch"),
        available: true,
      };
    }
  } else if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Object.keys(parsed).length > 0
  ) {
    row = parsed;
  } else {
    return emptyProcessEvidence("empty");
  }

  const pid = parsePositivePid(row.ProcessId);
  if (expected !== null && pid !== expected) {
    return {
      ...emptyProcessEvidence("pid-mismatch"),
      available: true,
      pid,
    };
  }

  const creation =
    typeof row.CreationFileTimeUtc === "string" ||
    typeof row.CreationFileTimeUtc === "number"
      ? String(row.CreationFileTimeUtc).trim()
      : "";
  const identity =
    /^\d+$/u.test(creation) && Number(creation) > 0
      ? `windows:${creation}`
      : null;
  const executablePath = normalizeWindowsPath(row.ExecutablePath);
  const imageName =
    typeof row.Name === "string" && row.Name.trim()
      ? path.win32.basename(row.Name.trim().replaceAll("/", "\\")).toLowerCase()
      : null;
  const commandLine =
    typeof row.CommandLine === "string" && row.CommandLine.trim()
      ? row.CommandLine.trim()
      : null;
  const expectedPath = normalizeWindowsPath(expectedPython);
  const expectedImage = expectedPath
    ? path.win32.basename(expectedPath).toLowerCase()
    : null;
  const valid = Boolean(
    pid !== null &&
    identity &&
    executablePath &&
    imageName &&
    commandLine &&
    expectedPath &&
    expectedImage &&
    executablePath === expectedPath &&
    imageName === expectedImage,
  );
  return {
    available: true,
    valid,
    pid,
    identity,
    imageName,
    executablePath,
    queryOutcome: valid ? "valid" : "identity-mismatch",
    commandLine,
  };
}

function windowsProcessQueryScript(pid) {
  const safePid = parsePositivePid(pid);
  if (safePid === null) throw new Error("invalid process id");
  return [
    "$ErrorActionPreference='Stop'",
    `$p = @(Get-CimInstance Win32_Process -Filter 'ProcessId = ${safePid}')`,
    "if ($p.Count -eq 0) { Write-Output '{}' } else {",
    "$p | Select-Object ProcessId,Name,ExecutablePath,CommandLine,@{Name='CreationFileTimeUtc';Expression={if ($_.CreationDate) {$_.CreationDate.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)} else {''}}} | ConvertTo-Json -Compress",
    "}",
  ].join("; ");
}

export async function readProcessEvidenceWithRetry({
  readEvidence,
  sleepFn = sleep,
  retryDelayMs = WINDOWS_PROCESS_EVIDENCE_RETRY_DELAY_MS,
  maxAttempts = WINDOWS_PROCESS_EVIDENCE_MAX_ATTEMPTS,
}) {
  let result = null;
  const attempts =
    Number.isSafeInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      result = await readEvidence();
    } catch {
      result = null;
    }
    const retryable =
      result === null ||
      result === undefined ||
      (result.valid !== true &&
        ["empty", "timeout", "query-error", "invalid-json"].includes(
          result.queryOutcome,
        ));
    if (!retryable || attempt === attempts - 1) return result;
    await sleepFn(retryDelayMs);
  }
  return result;
}

async function readWindowsProcessEvidenceOnce(
  pid,
  expectedPython,
  timeoutMs = WINDOWS_PROCESS_EVIDENCE_QUERY_TIMEOUT_MS,
) {
  const safePid = parsePositivePid(pid);
  if (safePid === null) return emptyProcessEvidence("invalid-pid");
  if (process.platform !== "win32") {
    // The dispatch job is Windows-only. Keep POSIX local tests useful with a
    // synthetic, explicitly-labelled identity; it is never claimed as
    // Windows proof in the emitted runner metadata.
    const executablePath = normalizeWindowsPath(expectedPython);
    return {
      available: true,
      valid: true,
      pid: safePid,
      identity: `posix:${safePid}`,
      imageName: executablePath
        ? path.win32.basename(executablePath).toLowerCase()
        : "python.exe",
      executablePath,
      queryOutcome: "non-windows",
      commandLine: `pid:${safePid}`,
    };
  }
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        windowsProcessQueryScript(safePid),
      ],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 128 * 1024,
      },
    );
    return parseWindowsProcessEvidence(String(stdout), expectedPython, safePid);
  } catch (error) {
    return emptyProcessEvidence(
      error?.code === "ETIMEDOUT" ? "timeout" : "query-error",
    );
  }
}

async function readWindowsProcessEvidence(pid, expectedPython) {
  if (process.platform !== "win32") {
    return readWindowsProcessEvidenceOnce(pid, expectedPython);
  }
  // CIM provider activation is occasionally slow on a freshly extracted
  // Windows runner. One bounded re-query lets a transient provider startup
  // failure recover, while a second miss remains unavailable/fail-closed.
  return readProcessEvidenceWithRetry({
    readEvidence: () => readWindowsProcessEvidenceOnce(pid, expectedPython),
  });
}

function normalizeCommandLine(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/\s+/gu, " ").toLowerCase()
    : null;
}

/** Refuse cleanup unless every captured process identity still matches. */
export function canTerminateProcessIdentity(captured, observed) {
  if (
    !captured ||
    !observed ||
    captured.available !== true ||
    captured.valid !== true ||
    observed.available !== true ||
    observed.valid !== true
  ) {
    return false;
  }
  const capturedPid = parsePositivePid(captured.pid);
  const observedPid = parsePositivePid(observed.pid);
  const capturedPath = normalizeWindowsPath(captured.executablePath);
  const observedPath = normalizeWindowsPath(observed.executablePath);
  const capturedCommand = normalizeCommandLine(captured.commandLine);
  const observedCommand = normalizeCommandLine(observed.commandLine);
  return Boolean(
    capturedPid !== null &&
    capturedPid === observedPid &&
    typeof captured.identity === "string" &&
    captured.identity.length > 0 &&
    captured.identity === observed.identity &&
    typeof captured.imageName === "string" &&
    captured.imageName.toLowerCase() ===
      String(observed.imageName ?? "").toLowerCase() &&
    capturedPath !== null &&
    capturedPath === observedPath &&
    capturedCommand !== null &&
    capturedCommand === observedCommand,
  );
}

/** Decide whether the phase runner continues, stops, or adds one stack trace. */
export function nextDiagnosticPhase({
  phase,
  outcome,
  ready = false,
  exitCode,
}) {
  if (
    phase === "gateway-importtime" ||
    phase === "gateway-direct" ||
    phase === "gateway-instrumented"
  ) {
    if (ready || outcome === "ready-cleaned") {
      return { action: "stop", reason: "gateway-ready" };
    }
    if (phase === "gateway-instrumented") {
      return { action: "stop", reason: "instrumented-complete" };
    }
    if (
      outcome === "readiness-timeout-cleaned" ||
      outcome === "readiness-timeout" ||
      outcome === "readiness-timeout-residue"
    ) {
      return { action: "append", phase: "gateway-stacktrace" };
    }
    return { action: "stop", reason: "gateway-exited" };
  }
  if (phase === "gateway-stacktrace") {
    return { action: "stop", reason: "stacktrace-complete" };
  }
  if (outcome === "exited" && exitCode === 0) {
    return { action: "continue" };
  }
  return { action: "stop", reason: "phase-failed" };
}

/** Redact secrets and local filesystem paths from diagnostic text. */
export function redactDiagnosticText(value, secrets = []) {
  let textValue = String(value ?? "");
  for (const secret of [...secrets]
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .sort((left, right) => right.length - left.length)) {
    textValue = textValue.split(secret).join("<redacted>");
  }

  return (
    textValue
      .replaceAll(String.fromCharCode(27), "")
      .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/giu, "$1<redacted>")
      .replace(/\b(?:sk|vck)[-_][A-Za-z0-9._-]+/gu, "<redacted>")
      .replace(/(api[_ -]?key\s*[=:]\s*)[^\s,;]+/giu, "$1<redacted>")
      .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\)[^"'\r\n]*\1/gu, "$1<path>$1")
      // Keep spaces that are part of a Windows path, but stop before a
      // following command-line option. The previous \S-based expression
      // redacted only up to the first space and leaked the remainder of paths
      // such as `C:\\Users\\runner workspace\\hermes\\gateway.log`.
      .replace(
        /\b[A-Za-z]:[\\/][^\r\n"'<>|,;]*?(?=(?:\s+(?:[-/]{1,2}\S|<)|\s*$)|[),]|$)/giu,
        "<path>",
      )
      .replace(
        /(^|[\s=()]|\[)(\/(?:Users|home|private|tmp|var|opt|workspace|runner|aera)\/[^\s"'<>|]*)/giu,
        "$1<path>",
      )
  );
}

function redactDiagnosticValue(value, secrets) {
  if (typeof value === "string") return redactDiagnosticText(value, secrets);
  if (Array.isArray(value)) {
    return value.map((entry) => redactDiagnosticValue(entry, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactDiagnosticValue(entry, secrets),
      ]),
    );
  }
  return value;
}

function makeEmitter(outputPath, secrets) {
  const startedAt = Date.now();
  return (event, fields = {}) => {
    const line = `${JSON.stringify(
      redactDiagnosticValue(
        {
          schemaVersion: 1,
          event,
          elapsedMs: Date.now() - startedAt,
          ...fields,
        },
        secrets,
      ),
    )}\n`;
    try {
      process.stdout.write(line);
    } catch {
      // Evidence output must never change the diagnostic result.
    }
    if (outputPath) {
      try {
        appendFileSync(outputPath, line, "utf8");
      } catch {
        // Evidence writing must never change the diagnostic result.
      }
    }
  };
}

/**
 * Remove one phase sandbox and retain the result when the filesystem refuses
 * removal (most commonly Windows EBUSY while a residue process still owns a
 * file or current directory). The caller never loses the process/cleanup
 * evidence merely because this best-effort final step failed.
 */
export function cleanupPhaseSandbox({
  phase,
  phaseRoot,
  result,
  remove = rmSync,
  emit = () => {},
}) {
  const cleanup = result?.cleanup ?? {};
  const remainingPids = Array.isArray(cleanup.remainingPids)
    ? cleanup.remainingPids
    : [];
  const sandboxCleanup = {
    attempted: false,
    cleaned: false,
    retainedForResidue: false,
    errorCode: null,
  };

  // Do not unlink a live process's working tree just to make the job look
  // clean. On Windows that normally yields EBUSY; retaining it explicitly is
  // the safer and more informative outcome on every platform.
  if (remainingPids.length > 0) {
    sandboxCleanup.retainedForResidue = true;
    emit("phase-sandbox-retained", {
      phase: phase.name,
      reason: "process-residue",
      remainingPids,
    });
    return { ...result, sandboxCleanup };
  }

  sandboxCleanup.attempted = true;
  try {
    remove(phaseRoot, { recursive: true, force: true });
    sandboxCleanup.cleaned = true;
    emit("phase-sandbox-cleaned", { phase: phase.name });
  } catch (error) {
    sandboxCleanup.errorCode =
      typeof error?.code === "string" ? error.code : "sandbox-cleanup-failed";
    emit("phase-sandbox-cleanup-failed", {
      phase: phase.name,
      errorCode: sandboxCleanup.errorCode,
    });
  }
  return { ...result, sandboxCleanup };
}

function appendBoundedTail(current, chunk) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length > DIAGNOSTIC_TAIL_BYTES
    ? next.subarray(next.length - DIAGNOSTIC_TAIL_BYTES)
    : next;
}

function readBoundedFileTail(filePath) {
  if (!filePath) return { bytes: 0, tail: "" };
  try {
    const raw = readFileSync(filePath);
    const bounded =
      raw.length > DIAGNOSTIC_TAIL_BYTES
        ? raw.subarray(raw.length - DIAGNOSTIC_TAIL_BYTES)
        : raw;
    return { bytes: raw.length, tail: bounded.toString("utf8") };
  } catch {
    return { bytes: 0, tail: "" };
  }
}

function processIsAlive(pid) {
  const safePid = parsePositivePid(pid);
  if (safePid === null) return false;
  try {
    process.kill(safePid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readGatewayPidEntry(pidPath) {
  if (!existsSync(pidPath)) return { state: "missing", pid: null };
  try {
    const raw = readFileSync(pidPath, "utf8").trim();
    const parsed = raw.startsWith("{") ? JSON.parse(raw)?.pid : raw;
    const pid = parsePositivePid(parsed);
    if (pid === null) return { state: "invalid", pid: null };
    return { state: "present", pid };
  } catch {
    return { state: "invalid", pid: null };
  }
}

async function sampleCpuSeconds(pid) {
  if (process.platform !== "win32") return null;
  const safePid = parsePositivePid(pid);
  if (safePid === null) return null;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-Process -Id ${safePid} -ErrorAction SilentlyContinue; if ($p) { $p.CPU } else { "" }`,
      ],
      { timeout: 5_000, windowsHide: true },
    );
    const value = Number(stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function reserveLoopbackPort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => {
        if (error) rejectPort(error);
        else if (!port)
          rejectPort(new Error("could not reserve a loopback port"));
        else resolvePort(port);
      });
    });
  });
}

function probeCapabilities(port, apiServerKey) {
  return new Promise((resolveProbe) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveProbe(result);
    };
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/capabilities",
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiServerKey}`,
          Connection: "close",
        },
      },
      (response) => {
        let bytes = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (Buffer.concat(chunks).length < 64 * 1024) chunks.push(chunk);
        });
        response.on("end", () => {
          let document = null;
          try {
            document = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            // A non-JSON 200 response is not readiness evidence.
          }
          const validDocument =
            response.statusCode === 200 &&
            document !== null &&
            typeof document === "object" &&
            !Array.isArray(document);
          const features = validDocument ? document.features : null;
          finish({
            statusCode: response.statusCode ?? null,
            responseBytes: bytes,
            authenticated: response.statusCode === 200,
            validDocument,
            requestToolPolicy: features?.request_tool_policy === true,
            requestModelRoute: features?.request_model_route === true,
          });
        });
      },
    );
    req.on("error", (error) =>
      finish({ statusCode: null, error: error.code ?? "request-error" }),
    );
    req.setTimeout(CAPABILITIES_TIMEOUT_MS, () => {
      req.destroy();
      finish({ statusCode: null, error: "timeout" });
    });
    timer = setTimeout(() => {
      req.destroy();
      finish({ statusCode: null, error: "timeout" });
    }, CAPABILITIES_TIMEOUT_MS);
    req.end();
  });
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function childExitResult(value) {
  return {
    outcome: "child-exited",
    exitCode: value?.exitCode ?? null,
    signal: value?.signal ?? null,
  };
}

/**
 * Wait for both readiness proofs, but stop immediately when the wrapper exits.
 * The injectable seams make the early-exit contract testable without a Windows
 * process table or a real HTTP listener.
 */
export async function waitForGatewayReadiness({
  phase,
  pidPath,
  python,
  port,
  apiServerKey,
  timeoutMs,
  preLaunchPid = null,
  pollMs = READINESS_POLL_MS,
  emit = () => {},
  childExitPromise,
  readPidEntry = () => readGatewayPidEntry(pidPath),
  isAlive = processIsAlive,
  readEvidence = (pid) => readWindowsProcessEvidence(pid, python),
  probe = probeCapabilities,
  sleepFn = sleep,
  nowFn = Date.now,
}) {
  const startedAt = nowFn();
  const deadline = startedAt + timeoutMs;
  let childExited = false;
  let childExit = null;
  let resolveChildExit = () => {};
  const childExitNotification = childExitPromise
    ? new Promise((resolve) => {
        resolveChildExit = resolve;
      })
    : null;
  if (childExitPromise) {
    Promise.resolve(childExitPromise).then(
      (value) => {
        childExited = true;
        childExit = value;
        resolveChildExit();
      },
      () => {
        childExited = true;
        childExit = { exitCode: null, signal: null };
        resolveChildExit();
      },
    );
    // Let an already-resolved promise publish its flag before the first poll.
    await Promise.resolve();
  }

  let previousPidState = "";
  let previousApiState = "";
  const evidenceChecks = new Map();
  let lastListenerPid = null;
  let lastListenerEvidence = null;
  let lastListenerImageValid = false;
  let lastListenerAlive = false;
  let observedPidFilePid = null;
  let observedPidFileEvidence = null;
  let observedPidFilePreLaunch = false;
  let lastCapabilities = null;
  const pidFileTransitions = [];

  const finishChild = () => {
    const result = childExitResult(childExit);
    emit("gateway-child-exited", {
      phase: phase.name,
      exitCode: result.exitCode,
      signal: result.signal,
      elapsedMs: nowFn() - startedAt,
    });
    return {
      ready: false,
      outcome: result.outcome,
      exitCode: result.exitCode,
      signal: result.signal,
      listenerPid: lastListenerPid,
      listenerEvidence: lastListenerEvidence,
      listenerImage: lastListenerImageValid,
      listenerImageValid: lastListenerImageValid,
      listenerAlive: lastListenerAlive,
      observedPidFilePid,
      observedPidFileEvidence,
      observedPidFilePreLaunch,
      capabilities: lastCapabilities,
      pidFileTransitions,
      elapsedMs: nowFn() - startedAt,
    };
  };

  while (nowFn() < deadline) {
    if (childExited) return finishChild();

    let pidEntry;
    try {
      pidEntry = await readPidEntry();
    } catch {
      pidEntry = { state: "unreadable", pid: null };
    }
    const pidStateKey = `${pidEntry?.state ?? "invalid"}:${pidEntry?.pid ?? ""}`;
    const candidatePid = parsePositivePid(pidEntry?.pid);
    const candidateIsPreLaunch =
      candidatePid !== null && candidatePid === parsePositivePid(preLaunchPid);
    observedPidFilePid = candidatePid;
    observedPidFilePreLaunch = candidateIsPreLaunch;
    if (pidStateKey !== previousPidState) {
      previousPidState = pidStateKey;
      pidFileTransitions.push({
        state: pidEntry?.state ?? "invalid",
        pid: pidEntry?.pid ?? null,
        preLaunch: candidateIsPreLaunch,
        elapsedMs: nowFn() - startedAt,
      });
      emit("gateway-pid-file", {
        phase: phase.name,
        state: pidEntry?.state ?? "invalid",
        pid: pidEntry?.pid ?? null,
        preLaunch: candidateIsPreLaunch,
        transitions: pidFileTransitions.length,
      });
    }

    let alive = false;
    let imageValid = false;
    let listenerEvidence = null;
    if (candidatePid !== null) {
      if (!candidateIsPreLaunch) {
        try {
          alive = Boolean(await isAlive(candidatePid));
        } catch {
          alive = false;
        }
      }
      // A stale PID is not eligible for readiness, but retain one bounded
      // identity read so the artifact can distinguish stale ownership from a
      // missing/invalid pid file.
      if (alive || candidateIsPreLaunch) {
        const evidenceCacheKey = `${candidatePid}:${candidateIsPreLaunch}`;
        const cached = evidenceChecks.get(evidenceCacheKey);
        if (cached && nowFn() - cached.at < SAMPLE_INTERVAL_MS) {
          listenerEvidence = cached.value;
        } else {
          try {
            listenerEvidence = await readEvidence(candidatePid);
          } catch {
            listenerEvidence = null;
          }
          evidenceChecks.set(evidenceCacheKey, {
            at: nowFn(),
            value: listenerEvidence,
          });
        }
        imageValid =
          !candidateIsPreLaunch &&
          listenerEvidence?.valid === true &&
          parsePositivePid(listenerEvidence.pid) === candidatePid;
        if (!candidateIsPreLaunch) lastListenerPid = candidatePid;
        // Keep mismatched/unavailable rows as evidence. They are not readiness
        // proof, but dropping them makes a PID-reuse or CIM failure invisible
        // in the artifact that is meant to explain the timeout.
        if (!candidateIsPreLaunch) {
          lastListenerEvidence = listenerEvidence;
          lastListenerImageValid = imageValid;
          lastListenerAlive = alive;
        }
        observedPidFileEvidence = listenerEvidence;
      }
    } else {
      lastListenerAlive = false;
    }

    let capabilities = null;
    if (candidatePid !== null && alive && imageValid) {
      try {
        capabilities = await probe(port, apiServerKey);
      } catch {
        capabilities = { statusCode: null, error: "probe-error" };
      }
      lastCapabilities = capabilities;
      const apiState = `${capabilities?.statusCode ?? ""}:${capabilities?.validDocument === true}`;
      if (apiState !== previousApiState) {
        previousApiState = apiState;
        emit("gateway-capabilities", {
          phase: phase.name,
          statusCode: capabilities?.statusCode ?? null,
          responseBytes: capabilities?.responseBytes ?? 0,
          authenticated: capabilities?.authenticated === true,
          validDocument: capabilities?.validDocument === true,
          requestToolPolicy: capabilities?.requestToolPolicy === true,
          requestModelRoute: capabilities?.requestModelRoute === true,
        });
      }
      if (
        capabilities?.authenticated === true &&
        capabilities?.validDocument === true
      ) {
        emit("gateway-ready", {
          phase: phase.name,
          listenerPid: candidatePid,
          listenerIsPreLaunch: candidateIsPreLaunch,
          elapsedMs: nowFn() - startedAt,
          requestToolPolicy: capabilities.requestToolPolicy === true,
          requestModelRoute: capabilities.requestModelRoute === true,
        });
        return {
          ready: true,
          outcome: "ready",
          listenerPid: candidatePid,
          listenerEvidence,
          listenerImage: imageValid,
          listenerImageValid: imageValid,
          listenerAlive: alive,
          observedPidFilePid: candidatePid,
          observedPidFileEvidence: listenerEvidence,
          observedPidFilePreLaunch: candidateIsPreLaunch,
          capabilities,
          pidFileTransitions,
          elapsedMs: nowFn() - startedAt,
        };
      }
    }

    emit("gateway-readiness-sample", {
      phase: phase.name,
      listenerPid: candidatePid,
      listenerIsPreLaunch: candidateIsPreLaunch,
      listenerAlive: alive,
      listenerImageValid: imageValid,
      apiProbeAttempted: capabilities !== null,
      apiReady:
        capabilities?.authenticated === true &&
        capabilities?.validDocument === true,
    });
    if (childExited) return finishChild();
    const remaining = deadline - nowFn();
    if (remaining <= 0) break;
    // A child close must interrupt the poll sleep rather than waiting for the
    // next 500ms tick (or a test-provided long poll interval).
    if (childExitNotification) {
      await Promise.race([
        sleepFn(Math.min(pollMs, remaining)),
        childExitNotification,
      ]);
    } else {
      await sleepFn(Math.min(pollMs, remaining));
    }
  }

  if (childExited) return finishChild();
  emit("gateway-readiness-timeout", {
    phase: phase.name,
    timeoutMs,
    listenerPid: lastListenerPid,
    listenerAlive: lastListenerAlive,
    listenerImageValid: lastListenerImageValid,
    lastStatusCode: lastCapabilities?.statusCode ?? null,
  });
  return {
    ready: false,
    outcome: "readiness-timeout",
    listenerPid: lastListenerPid,
    listenerEvidence: lastListenerEvidence,
    listenerImage: lastListenerImageValid,
    listenerImageValid: lastListenerImageValid,
    listenerAlive: lastListenerAlive,
    observedPidFilePid,
    observedPidFileEvidence,
    observedPidFilePreLaunch,
    capabilities: lastCapabilities,
    pidFileTransitions,
    elapsedMs: nowFn() - startedAt,
  };
}

async function terminatePid(pid) {
  const safePid = parsePositivePid(pid);
  if (safePid === null || !processIsAlive(safePid)) {
    return { attempted: false, error: null };
  }
  if (process.platform === "win32") {
    try {
      await execFileAsync(
        "taskkill.exe",
        ["/PID", String(safePid), "/T", "/F"],
        { timeout: 10_000, windowsHide: true },
      );
      return { attempted: true, error: null };
    } catch (error) {
      return { attempted: true, error: error?.code ?? "taskkill-failed" };
    }
  }
  try {
    process.kill(-safePid, "SIGTERM");
  } catch {
    try {
      process.kill(safePid, "SIGTERM");
    } catch (error) {
      return { attempted: true, error: error?.code ?? "signal-failed" };
    }
  }
  await sleep(250);
  if (processIsAlive(safePid)) {
    try {
      process.kill(-safePid, "SIGKILL");
    } catch {
      try {
        process.kill(safePid, "SIGKILL");
      } catch {
        // The liveness result below is the authoritative cleanup evidence.
      }
    }
  }
  return { attempted: true, error: null };
}

export async function cleanupPhaseProcesses({
  phase,
  child,
  wrapperEvidence,
  listenerPid,
  listenerEvidence,
  pidPath,
  python,
  emit,
  reason,
  readPidEntry = () => readGatewayPidEntry(pidPath),
  readEvidence = (pid) => readWindowsProcessEvidence(pid, python),
  isAlive = processIsAlive,
  terminate = terminatePid,
  sleepFn = sleep,
  cleanupWaitMs = CLEANUP_WAIT_MS,
  pidFileTransitions = [],
  preLaunchPid = null,
  nowFn = Date.now,
}) {
  const cleanupStartedAt = nowFn();
  const wrapperPid = parsePositivePid(child?.pid);
  const stalePreLaunchPid = parsePositivePid(preLaunchPid);
  const isPreLaunchPid = (pid) =>
    stalePreLaunchPid !== null && parsePositivePid(pid) === stalePreLaunchPid;
  let listener = parsePositivePid(listenerPid);
  const alive = async (pid) => {
    try {
      return Boolean(await isAlive(pid));
    } catch {
      return false;
    }
  };
  const wrapperAlive = wrapperPid === null ? false : await alive(wrapperPid);
  let latePidEntry = { state: "unread", pid: null };
  try {
    latePidEntry = await readPidEntry();
  } catch {
    latePidEntry = { state: "unreadable", pid: null };
  }
  let lateListenerEvidence = listenerEvidence;
  let observedWrapperEvidence = null;
  if (wrapperPid !== null && wrapperAlive) {
    try {
      observedWrapperEvidence = await readEvidence(wrapperPid);
    } catch {
      observedWrapperEvidence = null;
    }
  }
  const latePid = parsePositivePid(latePidEntry?.pid);
  const latePidIsPreLaunch = isPreLaunchPid(latePid);
  const allPidFileTransitions = [...pidFileTransitions];
  const lastTransition = allPidFileTransitions.at(-1);
  if (
    !lastTransition ||
    lastTransition.state !== latePidEntry.state ||
    lastTransition.pid !== latePidEntry.pid
  ) {
    allPidFileTransitions.push({
      state: latePidEntry.state,
      pid: latePidEntry.pid ?? null,
      elapsedMs: nowFn() - cleanupStartedAt,
      atCleanup: true,
    });
  }
  if (latePid !== null) {
    try {
      lateListenerEvidence = await readEvidence(latePid);
    } catch {
      lateListenerEvidence = null;
    }
    emit("gateway-late-listener", {
      phase: phase.name,
      pid: latePid,
      pidFileState: latePidEntry?.state ?? "invalid",
      preLaunch: latePidIsPreLaunch,
      evidence: lateListenerEvidence,
    });
  }

  // A pid file can be published just after the final readiness sample. If it
  // names a different process while the wrapper is still alive, do not adopt
  // or signal that process: the launch has not established a cross-PID handoff
  // and the file may belong to a concurrent/reused gateway.
  if (
    listener === null &&
    latePid !== null &&
    !latePidIsPreLaunch &&
    lateListenerEvidence?.valid === true &&
    (wrapperPid === null || latePid === wrapperPid || !wrapperAlive)
  ) {
    listener = latePid;
    listenerEvidence = lateListenerEvidence;
  }

  const candidates = [];
  if (
    wrapperPid !== null &&
    !isPreLaunchPid(wrapperPid) &&
    wrapperEvidence?.valid === true
  ) {
    candidates.push({
      pid: wrapperPid,
      kind: "wrapper",
      evidence: wrapperEvidence,
    });
  }
  if (
    listener !== null &&
    !isPreLaunchPid(listener) &&
    listenerEvidence?.valid === true &&
    !candidates.some((target) => target.pid === listener)
  ) {
    candidates.push({
      pid: listener,
      kind: "listener",
      evidence: listenerEvidence,
    });
  }

  const unresolved = new Set();
  const residue = [];
  if (
    wrapperPid !== null &&
    !candidates.some((target) => target.pid === wrapperPid)
  ) {
    const wrapperIsAlive = await alive(wrapperPid);
    const wrapperIsPreLaunch = isPreLaunchPid(wrapperPid);
    if (wrapperIsAlive && !wrapperIsPreLaunch) unresolved.add(wrapperPid);
    residue.push({
      pid: wrapperPid,
      kind: "wrapper",
      reason: wrapperIsPreLaunch
        ? "pre-launch-pid"
        : "wrapper-identity-unverified",
      alive: wrapperIsAlive,
      capturedEvidence: wrapperEvidence,
      observedEvidence: observedWrapperEvidence,
    });
    emit("gateway-cleanup-skip", {
      phase: phase.name,
      pid: wrapperPid,
      reason: residue.at(-1).reason,
      evidence: wrapperEvidence,
    });
  }
  if (
    listener !== null &&
    !candidates.some((target) => target.pid === listener)
  ) {
    const listenerIsAlive = await alive(listener);
    const listenerIsPreLaunch = isPreLaunchPid(listener);
    if (listenerIsAlive && !listenerIsPreLaunch) unresolved.add(listener);
    residue.push({
      pid: listener,
      kind: "listener",
      reason: listenerIsPreLaunch
        ? "pre-launch-pid"
        : latePid === listener && wrapperAlive && wrapperPid !== listener
          ? "wrapper-live-late-pid"
          : "listener-identity-unverified",
      alive: listenerIsAlive,
      capturedEvidence: listenerEvidence,
      observedEvidence: lateListenerEvidence,
    });
    emit("gateway-cleanup-skip", {
      phase: phase.name,
      pid: listener,
      reason: residue.at(-1).reason,
      evidence: listenerEvidence,
    });
  }

  if (latePid !== null && latePid !== wrapperPid && latePid !== listener) {
    const lateAlive = await alive(latePid);
    if (wrapperAlive || lateAlive || lateListenerEvidence !== null) {
      if (lateAlive && !latePidIsPreLaunch) unresolved.add(latePid);
      const lateReason = latePidIsPreLaunch
        ? "pre-launch-pid"
        : wrapperAlive
          ? "wrapper-live-late-pid"
          : "late-pid-identity-unverified";
      residue.push({
        pid: latePid,
        kind: "listener",
        reason: lateReason,
        alive: lateAlive,
        capturedEvidence: null,
        observedEvidence: lateListenerEvidence,
      });
      emit("gateway-cleanup-skip", {
        phase: phase.name,
        pid: latePid,
        reason: lateReason,
        evidence: lateListenerEvidence,
      });
    }
  }

  const attempts = [];
  let forced = false;
  for (const target of candidates) {
    if (!(await alive(target.pid))) {
      emit("gateway-cleanup-skip", {
        phase: phase.name,
        pid: target.pid,
        kind: target.kind,
        reason: "already-exited",
        capturedEvidence: target.evidence,
      });
      continue;
    }
    // Re-read immediately before signalling. A changed creation token,
    // executable path, image, or command line is a possible PID reuse and is
    // never a valid kill target.
    let observed = null;
    try {
      observed = await readEvidence(target.pid);
    } catch {
      observed = null;
    }
    if (!canTerminateProcessIdentity(target.evidence, observed)) {
      const targetIsAlive = await alive(target.pid);
      if (targetIsAlive) unresolved.add(target.pid);
      residue.push({
        pid: target.pid,
        kind: target.kind,
        reason: "identity-changed-or-unavailable",
        alive: targetIsAlive,
        capturedEvidence: target.evidence,
        observedEvidence: observed,
      });
      emit("gateway-cleanup-skip", {
        phase: phase.name,
        pid: target.pid,
        reason: "identity-changed-or-unavailable",
        capturedEvidence: target.evidence,
        observedEvidence: observed,
      });
      continue;
    }
    emit("gateway-cleanup-start", {
      phase: phase.name,
      pid: target.pid,
      kind: target.kind,
      reason,
      capturedEvidence: target.evidence,
      observedEvidence: observed,
    });
    let result;
    try {
      result = (await terminate(target.pid)) ?? {
        attempted: false,
        error: "termination-no-result",
      };
    } catch (error) {
      result = {
        attempted: true,
        error: error?.code ?? error?.name ?? "termination-failed",
      };
    }
    forced ||= result.attempted === true;
    const attempt = {
      pid: target.pid,
      kind: target.kind,
      capturedEvidence: target.evidence,
      observedEvidence: observed,
      ...result,
    };
    attempts.push(attempt);
    const waitStartedAt = nowFn();
    while (
      (await alive(target.pid)) &&
      nowFn() - waitStartedAt < cleanupWaitMs
    ) {
      await sleepFn(100);
    }
    if (await alive(target.pid)) {
      // One final identity read distinguishes a stubborn owned process from an
      // immediately reused PID. Either way it remains in the evidence.
      let finalEvidence = null;
      try {
        finalEvidence = await readEvidence(target.pid);
      } catch {
        finalEvidence = null;
      }
      if (!canTerminateProcessIdentity(target.evidence, finalEvidence)) {
        emit("gateway-cleanup-reuse", {
          phase: phase.name,
          pid: target.pid,
          evidence: finalEvidence,
        });
      }
      unresolved.add(target.pid);
      residue.push({
        pid: target.pid,
        kind: target.kind,
        reason: "still-alive-after-cleanup",
        alive: true,
        capturedEvidence: target.evidence,
        observedEvidence: finalEvidence,
      });
      attempt.finalEvidence = finalEvidence;
      attempt.remaining = true;
    }
  }

  emit("gateway-cleanup-complete", {
    phase: phase.name,
    forced,
    attempts: attempts.length,
    residue,
    remainingPids: [...unresolved],
    latePidEntry,
    preLaunchPid: stalePreLaunchPid,
    latePidIsPreLaunch,
  });
  return {
    forced,
    remainingPids: [...unresolved],
    attempts,
    residue,
    latePidEntry,
    lateListenerEvidence,
    observedWrapperEvidence,
    pidFileTransitions: allPidFileTransitions,
    preLaunchPid: stalePreLaunchPid,
    latePidIsPreLaunch,
  };
}

export function runChildToExit({
  phase,
  env,
  timeoutMs,
  emit,
  pidPath,
  readPidEntry = () => readGatewayPidEntry(pidPath),
  readEvidence = (pid) => readWindowsProcessEvidence(pid, phase.file),
  isAlive = processIsAlive,
  terminate = terminatePid,
  sleepFn = sleep,
  cleanupWaitMs = CLEANUP_WAIT_MS,
  sampleCpu = sampleCpuSeconds,
  nowFn = Date.now,
  stdioMode = "pipe",
  stderrLogPath = null,
}) {
  return new Promise((resolvePhase) => {
    const startedAt = nowFn();
    let pidFileBefore;
    try {
      pidFileBefore = readPidEntry();
    } catch {
      pidFileBefore = { state: "unreadable", pid: null };
    }
    let child;
    let stderrFd = -1;
    try {
      const useFileStderr = stdioMode === "file" && stderrLogPath !== null;
      if (useFileStderr) stderrFd = openSync(stderrLogPath, "a");
      child = spawn(phase.file, phase.args, {
        cwd: phase.cwd,
        env,
        stdio: useFileStderr
          ? ["ignore", "ignore", stderrFd]
          : ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      // The child inherited the handle; drop the parent copy immediately.
      if (stderrFd >= 0) {
        try {
          closeSync(stderrFd);
        } catch {
          // best-effort
        }
        stderrFd = -1;
      }
    } catch (error) {
      resolvePhase({
        phase: phase.name,
        outcome: "spawn-error",
        pid: null,
        elapsedMs: nowFn() - startedAt,
        error: String(error),
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTail: "",
        stderrTail: "",
        wrapperEvidence: null,
        pidFileBefore,
        pidFileAfter: pidFileBefore,
        pidFileTransitions: [],
        cleanup: {
          forced: false,
          remainingPids: [],
          attempts: [],
          residue: [],
          latePidEntry: pidFileBefore,
        },
      });
      return;
    }

    const pid = parsePositivePid(child.pid);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTail = Buffer.alloc(0);
    let stderrTail = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let closeResult = null;
    let cleanupResult = null;
    let pidFileAfter = pidFileBefore;
    const pidFileTransitions = [];
    let finalized = false;
    let finishPromise = null;
    let closeResolve;
    const closePromise = new Promise((resolveClose) => {
      closeResolve = resolveClose;
    });
    let sampleTimer;
    let timeoutTimer;
    const capturedEvidencePromise =
      pid === null
        ? Promise.resolve(null)
        : Promise.resolve()
            .then(() => readEvidence(pid, phase.file))
            .catch(() => null);

    const finish = (extra = {}) => {
      if (finishPromise) return finishPromise;
      finishPromise = (async () => {
        if (finalized) return;
        finalized = true;
        settled = true;
        clearTimeout(timeoutTimer);
        clearInterval(sampleTimer);
        if (stdioMode === "file" && stderrLogPath !== null) {
          try {
            const raw = readFileSync(stderrLogPath);
            stderrBytes = raw.length;
            stderrTail =
              raw.length > DIAGNOSTIC_TAIL_BYTES
                ? raw.subarray(raw.length - DIAGNOSTIC_TAIL_BYTES)
                : raw;
          } catch {
            // Keep the pipe-era zeros when the log is unreadable.
          }
        }
        try {
          pidFileAfter = await readPidEntry();
        } catch {
          pidFileAfter = { state: "unreadable", pid: null };
        }
        const wrapperEvidence = await capturedEvidencePromise;
        const cleanup = cleanupResult ?? {
          forced: false,
          remainingPids: [],
          attempts: [],
          residue: [],
          latePidEntry: pidFileAfter,
          lateListenerEvidence: null,
        };
        const finalPidFileTransitions =
          cleanup.pidFileTransitions ?? pidFileTransitions;
        const defaultOutcome = timedOut
          ? cleanup.remainingPids.length > 0
            ? "timeout-unverified"
            : "timeout-killed"
          : (closeResult?.outcome ?? "exited");
        const result = {
          phase: phase.name,
          instrumented: phase.instrumented === true,
          diagnosticOnly: phase.diagnosticOnly === true,
          pid,
          elapsedMs: nowFn() - startedAt,
          stdoutBytes,
          stderrBytes,
          stdoutTail: stdoutTail.toString("utf8"),
          stderrTail: stderrTail.toString("utf8"),
          exitCode: closeResult?.exitCode ?? null,
          signal: closeResult?.signal ?? null,
          outcome: extra.outcome ?? defaultOutcome,
          wrapperEvidence,
          wrapperIdentity: wrapperEvidence?.identity ?? null,
          wrapperImageValid: wrapperEvidence?.valid === true,
          pidFileBefore,
          pidFileAfter,
          pidFileTransitions: finalPidFileTransitions,
          importtimeTail: phase.args.includes("importtime")
            ? stderrTail.toString("utf8")
            : null,
          faulthandlerTail:
            phase.name === "gateway-stacktrace" || phase.instrumented === true
              ? stderrTail.toString("utf8")
              : null,
          stageMarkerBytes: 0,
          stageMarkerTail: "",
          stacktraceBytes: 0,
          stacktraceTail: "",
          cleanup,
          ...extra,
        };
        emit("probe-finished", result);
        resolvePhase(result);
      })();
      return finishPromise;
    };

    emit("probe-spawned", {
      phase: phase.name,
      pid,
      command: phase.file,
      args: phase.args,
      cwd: phase.cwd,
      pidFile: pidPath,
    });
    child.stdout?.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      stdoutTail = appendBoundedTail(stdoutTail, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
      stderrTail = appendBoundedTail(stderrTail, chunk);
    });
    child.on("error", (error) => {
      emit("probe-error", { phase: phase.name, pid, error: String(error) });
      closeResult = { outcome: "spawn-error", exitCode: null, signal: null };
      closeResolve(closeResult);
      if (!timedOut) void finish();
    });
    child.on("close", (code, signal) => {
      closeResult = { outcome: "exited", exitCode: code, signal };
      emit("probe-exited", { phase: phase.name, pid, exitCode: code, signal });
      closeResolve(closeResult);
      if (!timedOut) void finish();
    });

    const recordPidFileTransition = () => {
      let entry;
      try {
        entry = readPidEntry();
      } catch {
        entry = { state: "unreadable", pid: null };
      }
      const previous = pidFileTransitions.at(-1);
      if (previous?.state === entry.state && previous?.pid === entry.pid) {
        return entry;
      }
      pidFileTransitions.push({
        state: entry.state,
        pid: entry.pid ?? null,
        elapsedMs: nowFn() - startedAt,
      });
      return entry;
    };
    recordPidFileTransition();
    sampleTimer = setInterval(() => {
      void (async () => {
        if (pid === null) return;
        const pidEntry = recordPidFileTransition();
        let alive = false;
        try {
          alive = Boolean(await isAlive(pid));
        } catch {
          alive = false;
        }
        emit("probe-sample", {
          phase: phase.name,
          pid,
          alive,
          stdoutBytes,
          stderrBytes,
          cpuSeconds: await sampleCpu(pid),
          pidFileState: pidEntry.state,
          listenerPid: pidEntry.pid,
        });
      })();
    }, SAMPLE_INTERVAL_MS);
    sampleTimer.unref?.();

    timeoutTimer = setTimeout(async () => {
      if (settled || timedOut) return;
      timedOut = true;
      emit("probe-timeout", { phase: phase.name, pid, timeoutMs });
      await capturedEvidencePromise;
      cleanupResult = await cleanupPhaseProcesses({
        phase,
        child,
        wrapperEvidence: await capturedEvidencePromise,
        listenerPid: null,
        listenerEvidence: null,
        pidPath,
        python: phase.file,
        emit,
        reason: "timeout",
        readPidEntry,
        readEvidence,
        isAlive,
        terminate,
        sleepFn,
        cleanupWaitMs,
        pidFileTransitions,
        preLaunchPid: pidFileBefore.pid,
        nowFn,
      });
      if (
        cleanupResult.residue.some(
          (entry) =>
            entry.pid === pid && entry.reason === "wrapper-identity-unverified",
        )
      ) {
        emit("probe-cleanup-skip", {
          phase: phase.name,
          pid,
          reason: "identity-unverified",
          observedEvidence:
            cleanupResult.residue.find((entry) => entry.pid === pid)
              ?.observedEvidence ?? null,
        });
      }
      await Promise.race([closePromise, sleepFn(cleanupWaitMs)]);
      await finish();
    }, timeoutMs);
    timeoutTimer.unref?.();
  });
}

export async function runGatewayPhase({
  phase,
  env,
  timeoutMs,
  emit,
  pidPath,
  port,
  apiServerKey,
  python,
  spawnFn = spawn,
  readPidEntry = () => readGatewayPidEntry(pidPath),
  readEvidence = (pid) => readWindowsProcessEvidence(pid, python),
  isAlive = processIsAlive,
  probe = probeCapabilities,
  terminate = terminatePid,
  sleepFn = sleep,
  pollMs = READINESS_POLL_MS,
  cleanupWaitMs = CLEANUP_WAIT_MS,
  sampleCpu = sampleCpuSeconds,
  nowFn = Date.now,
  stdioMode = "pipe",
  stderrLogPath = null,
  stageMarkerPath = null,
  stacktracePath = null,
}) {
  const startedAt = nowFn();
  let pidFileBefore;
  try {
    pidFileBefore = await readPidEntry();
  } catch {
    pidFileBefore = { state: "unreadable", pid: null };
  }
  let child;
  let gatewayStderrFd = -1;
  try {
    const useFileStderr = stdioMode === "file" && stderrLogPath !== null;
    if (useFileStderr) gatewayStderrFd = openSync(stderrLogPath, "a");
    child = spawnFn(phase.file, phase.args, {
      cwd: phase.cwd,
      env,
      stdio: useFileStderr
        ? ["ignore", "ignore", gatewayStderrFd]
        : ["ignore", "pipe", "pipe"],
      // Match Desktop's managed spawn: POSIX gets a dedicated process group;
      // Windows cleanup uses the verified taskkill tree instead.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    if (gatewayStderrFd >= 0) {
      try {
        closeSync(gatewayStderrFd);
      } catch {
        // best-effort
      }
      gatewayStderrFd = -1;
    }
  } catch (error) {
    return {
      phase: phase.name,
      outcome: "spawn-error",
      pid: null,
      elapsedMs: nowFn() - startedAt,
      error: String(error),
      pidFileBefore,
      pidFileAfter: pidFileBefore,
      pidFileTransitions: [],
      wrapperEvidence: null,
      listenerEvidence: null,
      cleanup: {
        forced: false,
        remainingPids: [],
        attempts: [],
        residue: [],
      },
    };
  }

  const pid = parsePositivePid(child.pid);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTail = Buffer.alloc(0);
  let stderrTail = Buffer.alloc(0);
  let closeResult = null;
  let closeResolve;
  const closePromise = new Promise((resolveClose) => {
    closeResolve = resolveClose;
  });
  let wrapperEvidence = null;
  const wrapperEvidencePromise =
    pid === null
      ? Promise.resolve(null)
      : Promise.resolve()
          .then(() => readEvidence(pid))
          .catch(() => null);
  void wrapperEvidencePromise.then((evidence) => {
    wrapperEvidence = evidence;
    emit("gateway-wrapper-evidence", {
      phase: phase.name,
      pid,
      evidence,
    });
  });

  child.stdout?.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    stdoutTail = appendBoundedTail(stdoutTail, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderrBytes += chunk.length;
    stderrTail = appendBoundedTail(stderrTail, chunk);
  });
  child.on("error", (error) => {
    emit("probe-error", { phase: phase.name, pid, error: String(error) });
    closeResult = { outcome: "spawn-error", exitCode: null, signal: null };
    closeResolve(closeResult);
  });
  child.on("close", (code, signal) => {
    closeResult = { outcome: "exited", exitCode: code, signal };
    emit("probe-exited", { phase: phase.name, pid, exitCode: code, signal });
    closeResolve(closeResult);
  });
  emit("probe-spawned", {
    phase: phase.name,
    pid,
    command: phase.file,
    args: phase.args,
    cwd: phase.cwd,
    pidFile: pidPath,
    port,
  });

  const sampleTimer = setInterval(() => {
    void (async () => {
      if (pid === null) return;
      let pidEntry;
      try {
        pidEntry = await readPidEntry();
      } catch {
        pidEntry = { state: "unreadable", pid: null };
      }
      emit("probe-sample", {
        phase: phase.name,
        pid,
        alive: await isAlive(pid),
        stdoutBytes,
        stderrBytes,
        cpuSeconds: await sampleCpu(pid),
        pidFileState: pidEntry.state,
        listenerPid: pidEntry.pid,
      });
    })();
  }, SAMPLE_INTERVAL_MS);
  sampleTimer.unref?.();

  let serving;
  if (pid === null) {
    serving = {
      ready: false,
      outcome: "spawn-error",
      listenerPid: null,
      listenerEvidence: null,
      listenerImage: false,
      capabilities: null,
    };
  } else {
    const childExitPromise = closePromise.then((result) => ({
      exitCode: result.exitCode,
      signal: result.signal,
    }));
    serving = await waitForGatewayReadiness({
      phase,
      pidPath,
      python,
      port,
      apiServerKey,
      timeoutMs,
      preLaunchPid: pidFileBefore.pid,
      pollMs,
      emit,
      childExitPromise,
      readPidEntry,
      isAlive,
      readEvidence,
      probe,
      sleepFn,
      nowFn,
    });
  }

  wrapperEvidence = await wrapperEvidencePromise;
  const cleanup = await cleanupPhaseProcesses({
    phase,
    child,
    wrapperEvidence,
    listenerPid: serving.listenerPid,
    listenerEvidence: serving.listenerEvidence,
    pidPath,
    python,
    emit,
    reason: serving.ready ? "ready" : serving.outcome,
    readPidEntry,
    readEvidence,
    isAlive,
    terminate,
    sleepFn,
    cleanupWaitMs,
    pidFileTransitions: serving.pidFileTransitions,
    preLaunchPid: pidFileBefore.pid,
    nowFn,
  });
  // Give the child a bounded chance to publish its final close status before
  // taking the last pid-file snapshot. This snapshot is the post-cleanup
  // residue proof, not merely the state observed at timeout entry.
  await Promise.race([closePromise, sleepFn(cleanupWaitMs)]);
  let pidFileAfter;
  try {
    pidFileAfter = await readPidEntry();
  } catch {
    pidFileAfter = { state: "unreadable", pid: null };
  }
  clearInterval(sampleTimer);
  if (stdioMode === "file" && stderrLogPath !== null) {
    try {
      const raw = readFileSync(stderrLogPath);
      stderrBytes = raw.length;
      stderrTail =
        raw.length > DIAGNOSTIC_TAIL_BYTES
          ? raw.subarray(raw.length - DIAGNOSTIC_TAIL_BYTES)
          : raw;
    } catch {
      // Keep the pipe-era zeros when the log is unreadable.
    }
  }
  const stageEvidence = readBoundedFileTail(stageMarkerPath);
  const stacktraceEvidence = readBoundedFileTail(stacktracePath);
  if (stageMarkerPath || stacktracePath) {
    emit("gateway-stage-evidence", {
      phase: phase.name,
      stageMarkerBytes: stageEvidence.bytes,
      stageMarkerTail: stageEvidence.tail,
      stacktraceBytes: stacktraceEvidence.bytes,
      stacktraceTail: stacktraceEvidence.tail,
    });
  }
  const outcome = serving.ready
    ? "ready-cleaned"
    : serving.outcome === "child-exited"
      ? "child-exited"
      : serving.outcome === "spawn-error"
        ? "spawn-error"
        : serving.outcome === "readiness-timeout"
          ? cleanup.remainingPids.length > 0
            ? "readiness-timeout-residue"
            : "readiness-timeout-cleaned"
          : serving.outcome;
  return {
    phase: phase.name,
    instrumented: phase.instrumented === true,
    diagnosticOnly: phase.diagnosticOnly === true,
    pid,
    elapsedMs: nowFn() - startedAt,
    outcome,
    exitCode: closeResult?.exitCode ?? serving.exitCode ?? null,
    signal: closeResult?.signal ?? serving.signal ?? null,
    stdoutBytes,
    stderrBytes,
    stdoutTail: stdoutTail.toString("utf8"),
    stderrTail: stderrTail.toString("utf8"),
    command: phase.file,
    args: phase.args,
    cwd: phase.cwd,
    wrapperEvidence,
    wrapperIdentity: wrapperEvidence?.identity ?? null,
    wrapperImageValid: wrapperEvidence?.valid === true,
    listenerPid: serving.listenerPid ?? null,
    listenerEvidence: serving.listenerEvidence ?? null,
    listenerIdentity: serving.listenerEvidence?.identity ?? null,
    listenerImageValid:
      serving.listenerImageValid === true || serving.listenerImage === true,
    listenerAlive: serving.listenerAlive === true,
    observedPidFilePid: serving.observedPidFilePid ?? null,
    observedPidFileEvidence: serving.observedPidFileEvidence ?? null,
    observedPidFilePreLaunch: serving.observedPidFilePreLaunch === true,
    ready: serving.ready === true,
    capabilities: serving.capabilities
      ? {
          statusCode: serving.capabilities.statusCode ?? null,
          authenticated: serving.capabilities.authenticated === true,
          validDocument: serving.capabilities.validDocument === true,
          requestToolPolicy: serving.capabilities.requestToolPolicy === true,
          requestModelRoute: serving.capabilities.requestModelRoute === true,
        }
      : null,
    pidFileBefore,
    pidFileAfter,
    pidFileTransitions:
      cleanup.pidFileTransitions ?? serving.pidFileTransitions ?? [],
    importtimeTail: phase.args.includes("importtime")
      ? stderrTail.toString("utf8")
      : null,
    faulthandlerTail:
      phase.name === "gateway-stacktrace" || phase.instrumented === true
        ? stacktraceEvidence.tail || stderrTail.toString("utf8")
        : null,
    stageMarkerBytes: stageEvidence.bytes,
    stageMarkerTail: stageEvidence.tail,
    stacktraceBytes: stacktraceEvidence.bytes,
    stacktraceTail: stacktraceEvidence.tail,
    cleanup,
  };
}

/** Return the bounded, path/secret-redactable shape emitted for one phase. */
export function summarizeDiagnosticPhase(result) {
  return {
    phase: result?.phase ?? null,
    instrumented: result?.instrumented === true,
    diagnosticOnly: result?.diagnosticOnly === true,
    outcome: result?.outcome ?? null,
    elapsedMs: result?.elapsedMs ?? null,
    pid: result?.pid ?? null,
    command: result?.command ?? null,
    args: result?.args ?? [],
    cwd: result?.cwd ?? null,
    exitCode: result?.exitCode ?? null,
    signal: result?.signal ?? null,
    stdoutBytes: result?.stdoutBytes ?? 0,
    stderrBytes: result?.stderrBytes ?? 0,
    stdoutTail: result?.stdoutTail ?? "",
    stderrTail: result?.stderrTail ?? "",
    wrapperEvidence: result?.wrapperEvidence ?? null,
    wrapperIdentity: result?.wrapperIdentity ?? null,
    wrapperImageValid: result?.wrapperImageValid === true,
    listenerPid: result?.listenerPid ?? null,
    listenerEvidence: result?.listenerEvidence ?? null,
    listenerIdentity: result?.listenerIdentity ?? null,
    listenerImageValid: result?.listenerImageValid === true,
    listenerAlive: result?.listenerAlive === true,
    observedPidFilePid: result?.observedPidFilePid ?? null,
    observedPidFileEvidence: result?.observedPidFileEvidence ?? null,
    observedPidFilePreLaunch: result?.observedPidFilePreLaunch === true,
    ready: result?.ready === true,
    capabilities: result?.capabilities ?? null,
    pidFileBefore: result?.pidFileBefore ?? null,
    pidFileAfter: result?.pidFileAfter ?? null,
    pidFileTransitions: result?.pidFileTransitions ?? [],
    importtimeTail: result?.importtimeTail ?? null,
    faulthandlerTail: result?.faulthandlerTail ?? null,
    stageMarkerBytes: result?.stageMarkerBytes ?? 0,
    stageMarkerTail: result?.stageMarkerTail ?? "",
    stacktraceBytes: result?.stacktraceBytes ?? 0,
    stacktraceTail: result?.stacktraceTail ?? "",
    cleanup: result?.cleanup ?? null,
    sandboxCleanup: result?.sandboxCleanup ?? null,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: diagnose-windows-serve-help.mjs --runtime-root <dir> --manifest <file> [--launch-mode traced|direct|instrumented] [--home-mode fake|candidate] [--timeout-ms N] [--output file]",
      );
    }
    values[flag.slice(2).replaceAll("-", "_")] = value;
  }
  const timeoutMs = values.timeout_ms ? Number(values.timeout_ms) : 150_000;
  if (!values.runtime_root || !values.manifest) {
    throw new Error("--runtime-root and --manifest are required");
  }
  if (values.profile !== undefined) profileCommandArgs(values.profile);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  const envMode = values.env_mode ?? "minimal";
  if (!["minimal", "desktop"].includes(envMode)) {
    throw new Error("--env-mode must be minimal or desktop");
  }
  const stdioMode = values.stdio_mode ?? "pipe";
  if (!["pipe", "file"].includes(stdioMode)) {
    throw new Error("--stdio-mode must be pipe or file");
  }
  const launchMode = values.launch_mode ?? "traced";
  if (!["traced", "direct", "instrumented"].includes(launchMode)) {
    throw new Error("--launch-mode must be traced, direct, or instrumented");
  }
  const homeMode = values.home_mode ?? "fake";
  if (!["fake", "candidate"].includes(homeMode)) {
    throw new Error("--home-mode must be fake or candidate");
  }
  return {
    runtimeRoot: values.runtime_root,
    manifestPath: values.manifest,
    profile: values.profile ?? undefined,
    timeoutMs,
    output: values.output ?? null,
    envMode,
    stdioMode,
    launchMode,
    homeMode,
  };
}

function loadManifest(manifestPath) {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entrypoints = parsed?.entrypoints;
  if (
    !entrypoints ||
    typeof entrypoints.python !== "string" ||
    typeof entrypoints.hermes !== "string" ||
    entrypoints.module !== "hermes_cli.main" ||
    parsed.platform !== "windows"
  ) {
    throw new Error("manifest entrypoints or platform are unexpected");
  }
  return parsed;
}

function resolveRuntimeRoot(root, platform = process.platform) {
  const pathApi = pathApiForPlatform(platform);
  if (
    existsSync(pathApi.join(root, "python")) ||
    existsSync(pathApi.join(root, "python.exe")) ||
    existsSync(pathApi.join(root, "python313.dll"))
  ) {
    return root;
  }
  const children = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => pathApi.join(root, entry.name));
  if (children.length === 1) return children[0];
  return root;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(options.manifestPath);
  const pathApi = pathApiForPlatform(manifest.platform);
  const runtimeRoot = resolveRuntimeRoot(
    options.runtimeRoot,
    manifest.platform,
  );
  const python = pathApi.join(
    runtimeRoot,
    ...manifest.entrypoints.python.split(/[\\/]+/u),
  );
  const cwd = pathApi.join(runtimeRoot, "python", "Lib", "site-packages");
  if (!existsSync(python)) {
    throw new Error("Runtime Python entrypoint not found below the seed root");
  }
  if (!existsSync(cwd)) {
    throw new Error("Runtime managed site-packages directory is missing");
  }

  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, "", "utf8");
  }
  const secrets = [];
  const emit = makeEmitter(options.output, secrets);
  const phases = buildManagedGatewayPhases({
    module: manifest.entrypoints.module,
    profile: options.profile,
    python,
    cwd,
    launchMode: options.launchMode,
  });
  const stacktracePhase = buildGatewayStacktracePhase({
    module: manifest.entrypoints.module,
    profile: options.profile,
    python,
    cwd,
  });
  emit("diagnostic-start", {
    platform: manifest.platform,
    arch: manifest.arch,
    runtimeVersion: manifest.runtime_version,
    sourceCommit: manifest.source_commit,
    profile: options.profile ?? "default",
    pythonVersion: manifest.python_version,
    runnerOs: process.platform,
    runnerArch: process.arch,
    node: process.version,
    timeoutMs: options.timeoutMs,
    phases: phases.length,
    launchMode: options.launchMode,
    homeMode: options.homeMode,
    stacktraceOnReadinessTimeout: options.launchMode !== "instrumented",
    envMode: options.envMode,
    stdioMode: options.stdioMode,
  });

  const results = [];
  const queue = phases.slice();
  let stacktraceAdded = false;
  let stopReason = null;
  for (let index = 0; index < queue.length; index += 1) {
    const phase = queue[index];
    const phaseRoot = mkdtempSync(
      pathApi.join(tmpdir(), "aera-managed-gateway-phase-"),
    );
    const fakeHome = pathApi.join(phaseRoot, "home");
    mkdirSync(fakeHome, { recursive: true });
    const hermesRoot = pathApi.join(fakeHome, ".hermes");
    const hermesHome =
      options.profile && options.profile !== "default"
        ? pathApi.join(hermesRoot, "profiles", options.profile)
        : hermesRoot;
    // `--profile <name>` is resolved by hermes_cli.main against the default
    // Hermes root before argparse. Materialise that root/profile shape even
    // though all files remain inside this phase's disposable sandbox.
    mkdirSync(hermesRoot, { recursive: true });
    mkdirSync(hermesHome, { recursive: true });
    const pidPath = pathApi.join(hermesHome, "gateway.pid");
    const stderrLogPath = pathApi.join(phaseRoot, "gateway-stderr.log");
    const stageMarkerPath = phase.instrumented
      ? pathApi.join(phaseRoot, "gateway-stage-markers.jsonl")
      : null;
    const stacktracePath = phase.instrumented
      ? pathApi.join(phaseRoot, "gateway-faulthandler.log")
      : null;
    const apiServerKey = `aera-diagnostic-${randomBytes(18).toString("hex")}`;
    secrets.push(apiServerKey);
    const apiServerPort = await reserveLoopbackPort();
    const config = buildManagedGatewayConfig({
      apiServerKey,
      apiServerPort,
    });
    writeFileSync(pathApi.join(hermesHome, ".env"), config.envFile, {
      encoding: "utf8",
      mode: 0o600,
    });
    writeFileSync(pathApi.join(hermesHome, "config.yaml"), config.configYaml, {
      encoding: "utf8",
      mode: 0o600,
    });
    const env = buildManagedGatewayEnvironment({
      platform: manifest.platform,
      python,
      hermesHome,
      fakeHome,
      apiServerKey,
      apiServerPort,
      baseEnv: process.env,
      envMode: options.envMode,
      homeMode: options.homeMode,
    });
    if (phase.instrumented) {
      env.AERA_GATEWAY_DIAGNOSTIC_MARKER = stageMarkerPath;
      env.AERA_GATEWAY_DIAGNOSTIC_STACK = stacktracePath;
      // The wrapper also enables faulthandler itself; this flag makes the
      // child behavior explicit in the emitted environment contract.
      env.PYTHONFAULTHANDLER = "1";
    }
    emit("phase-start", {
      phase: phase.name,
      profile: options.profile ?? "default",
      waitForGateway: phase.waitForGateway === true,
      pidFile: pidPath,
      port: apiServerPort,
      configMaterialized: true,
      launchMode: options.launchMode,
      homeMode: options.homeMode,
      instrumented: phase.instrumented === true,
      envMode: options.envMode,
      stdioMode: options.stdioMode,
    });

    let result = phase.waitForGateway
      ? await runGatewayPhase({
          phase,
          env,
          timeoutMs: options.timeoutMs,
          emit,
          pidPath,
          port: apiServerPort,
          apiServerKey,
          python,
          stdioMode: options.stdioMode,
          stderrLogPath,
          stageMarkerPath,
          stacktracePath,
        })
      : await runChildToExit({
          phase,
          env,
          timeoutMs: options.timeoutMs,
          emit,
          pidPath,
          stdioMode: options.stdioMode,
          stderrLogPath,
        });
    // Add the result to the queue before touching the sandbox. If Windows
    // refuses removal because a residue process still owns it, the exact
    // phase object remains available for the final diagnostic event.
    results.push(result);
    result = cleanupPhaseSandbox({
      phase,
      phaseRoot,
      result,
      emit,
    });
    Object.assign(results.at(-1), result);
    emit("phase-complete", {
      ...summarizeDiagnosticPhase(result),
    });

    const transition = nextDiagnosticPhase(result);
    if (transition.action === "append") {
      if (!stacktraceAdded) {
        const stacktrace =
          transition.phase === stacktracePhase.name ? stacktracePhase : null;
        if (stacktrace) {
          queue.push(stacktrace);
          stacktraceAdded = true;
          emit("diagnostic-branch", {
            from: phase.name,
            to: stacktrace.name,
            reason: "readiness-timeout",
          });
          continue;
        }
      }
      stopReason = "stacktrace-unavailable";
      break;
    }
    if (transition.action === "stop") {
      stopReason = transition.reason;
      emit("diagnostic-stop", { phase: phase.name, reason: stopReason });
      break;
    }
  }

  const residualPids = results.flatMap((result) =>
    Array.isArray(result.cleanup?.remainingPids)
      ? result.cleanup.remainingPids
      : [],
  );
  const lastResult = results.at(-1) ?? null;
  const ok =
    stopReason === "gateway-ready" &&
    lastResult?.ready === true &&
    residualPids.length === 0 &&
    results.every((result) => result.sandboxCleanup?.cleaned === true);
  emit("diagnostic-complete", {
    ok,
    stopReason,
    residualPids,
    results: results.map((result) => summarizeDiagnosticPhase(result)),
  });
  if (!ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(
      `[serve-help-diagnostic] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
