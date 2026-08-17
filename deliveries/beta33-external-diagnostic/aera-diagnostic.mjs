#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, normalize, resolve } from "node:path";

import {
  classifyCollectorError,
  runBoundedCommand,
  safeRelativeName,
} from "./aera-diagnostic-core.mjs";
import {
  parseStableEvents,
  buildMacUnifiedLogRequest,
} from "./aera-diagnostic-events.mjs";
import {
  collectModelChain,
  compareModelSnapshots,
  managedModelPaths,
  snapshotManagedModelFiles,
} from "./aera-diagnostic-model.mjs";
import {
  collectMacOpenFilePaths,
  collectMacPlatformEvidence,
} from "./aera-diagnostic-platform-macos.mjs";
import {
  discoverRuntimeLogEvidence,
  findRuntimeLogSources,
} from "./aera-diagnostic-platform.mjs";
import { collectWindowsPlatformEvidence } from "./aera-diagnostic-platform-windows.mjs";
import {
  parseDiagnosticTargetV1,
  validateDiagnosticBundleV4,
} from "./aera-diagnostic-schema.mjs";
import {
  redactStructured,
  redactText,
  redactionCounters,
  resetRedactionCounters,
  scanShareableText,
} from "./aera-diagnostic-redaction.mjs";

export const COLLECTOR_VERSION = "4.0.0";
export const SCHEMA_VERSION = 4;
export const DEFAULT_TIMEOUT_SECONDS = 15 * 60;
const PLATFORM = { macos: "darwin", windows: "win32" };

function usage() {
  return `Aera external diagnostic collector V4

macOS:  bash run-macos.sh --app "/Applications/Aera.app" [--target target.json]
Windows: powershell -ExecutionPolicy Bypass -File .\\run-windows.ps1 -App "C:\\Program Files\\Aera\\Aera.exe" -Target .\\target.json

Options:
  --platform macos|windows
  --app <absolute path>
  --target <descriptor JSON>       exact candidate identity (recommended)
  --output <absolute directory>
  --hermes-home <absolute path>
  --user-data <absolute path>
  --mode external|internal          external is default; internal remains redacted
  --timeout-seconds <10..1800>
  --version <version>               fixture-only with --no-launch
  --no-launch                       fixture/self-test mode; never starts Aera
  --help
`;
}

function fail(message, code = 2) {
  console.error(`诊断工具未启动：${redactText(message, 512)}`);
  process.exitCode = code;
  return { ok: false, code };
}

export function parseArgs(argv) {
  const args = {
    platform: null,
    app: null,
    target: null,
    output: null,
    hermesHome: null,
    userData: null,
    mode: "external",
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    version: null,
    noLaunch: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--no-launch") {
      args.noLaunch = true;
      continue;
    }
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 需要参数`);
      index += 1;
      return value;
    };
    if (arg === "--platform") args.platform = next();
    else if (arg === "--app" || arg === "-App") args.app = next();
    else if (arg === "--target" || arg === "-Target") args.target = next();
    else if (arg === "--output" || arg === "-Output") args.output = next();
    else if (arg === "--hermes-home" || arg === "-HermesHome")
      args.hermesHome = next();
    else if (arg === "--user-data" || arg === "-UserData")
      args.userData = next();
    else if (arg === "--mode" || arg === "-Mode") args.mode = next();
    else if (arg === "--timeout-seconds" || arg === "-TimeoutSeconds")
      args.timeoutSeconds = Number(next());
    else if (arg === "--version") args.version = next();
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
}

function assertAbsolute(value, label) {
  if (!value || !/^(?:[A-Za-z]:[\\/]|\/)/.test(value))
    throw new Error(`${label} 必须是绝对路径`);
  return resolve(value);
}

function plistValue(appPath, key) {
  const path = join(appPath, "Contents", "Info.plist");
  try {
    const value = readFileSync(path, "utf8");
    const match = value.match(
      new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, "i"),
    );
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function windowsProductVersion(executable) {
  if (process.platform !== "win32") return null;
  const literal = `'${String(executable).replaceAll("'", "''")}'`;
  const result = runBoundedCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `(Get-Item -LiteralPath ${literal}).VersionInfo.ProductVersion`,
    ],
    { timeoutMs: 5_000, maximumBytes: 8 * 1024 },
  );
  if (result.code !== 0) return null;
  const version = result.stdout.trim().split(/\r?\n/).at(-1)?.trim() || "";
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version)
    ? version
    : null;
}

function findExecutable(appPath, platform) {
  if (platform === "darwin" && appPath.endsWith(".app")) {
    const directory = join(appPath, "Contents", "MacOS");
    try {
      const entries = readdirSync(directory).filter(
        (name) => !name.startsWith("."),
      );
      const preferred = entries.find((name) => /aera|agentera/i.test(name));
      return join(directory, preferred || entries[0] || "Aera");
    } catch {
      return join(directory, "Aera");
    }
  }
  return appPath;
}

function hashFile(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function hashPath(path) {
  return createHash("sha256")
    .update(`aera-diagnostic-executable-path-v1\0${normalize(path)}`)
    .digest("hex");
}

function hashDirectory(root) {
  const hash = createHash("sha256");
  const walk = (path, relative = "") => {
    let entries;
    try {
      entries = readdirSync(path).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const child = join(path, name);
      const childRelative = `${relative}/${name}`;
      let info;
      try {
        info = lstatSync(child);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(child, childRelative);
      else if (info.isFile()) {
        hash.update(childRelative);
        hash.update(readFileSync(child));
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}

function appIdentity(appPath, executable, platform, versionOverride) {
  const version =
    versionOverride ||
    (platform === "darwin"
      ? plistValue(appPath, "CFBundleShortVersionString")
      : windowsProductVersion(executable)) ||
    "unknown";
  const bundleId =
    platform === "darwin" ? plistValue(appPath, "CFBundleIdentifier") : null;
  const executableSha256 = hashFile(executable);
  const packageSha256 =
    existsSync(appPath) && lstatSync(appPath).isDirectory()
      ? hashDirectory(appPath)
      : executableSha256;
  let architecture = process.arch === "arm64" ? "arm64" : "x64";
  const file = runBoundedCommand("file", [executable], {
    timeoutMs: 5000,
    maximumBytes: 8192,
  });
  if (/arm64|aarch64/i.test(file.stdout)) architecture = "arm64";
  else if (/x86_64|amd64/i.test(file.stdout)) architecture = "x64";
  return {
    platform,
    version,
    bundleId,
    architecture,
    executableSha256,
    packageSha256,
    executablePathSha256: hashPath(executable),
    file: {
      code: file.code,
      stdoutBytes: file.stdoutBytes,
      truncated: file.stdoutTruncated,
    },
  };
}

function targetDescriptor(identity, source = "runtime-unbound") {
  return {
    schemaVersion: 1,
    platform: identity.platform,
    version: identity.version || "unknown",
    bundleId: identity.bundleId || "unknown",
    architecture: identity.architecture,
    executableSha256: identity.executableSha256 || "0".repeat(64),
    packageSha256: identity.packageSha256 || "0".repeat(64),
    sourceSha: "0".repeat(40),
    candidateManifestSha256: "0".repeat(64),
    bindingStatus: source,
  };
}

function loadTarget(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return parseDiagnosticTargetV1(value);
  } catch (error) {
    throw new Error(
      `target descriptor invalid (${classifyCollectorError(error)})`,
    );
  }
}

function validateTarget(identity, target) {
  const mismatches = [];
  if (target.platform !== identity.platform) mismatches.push("platform");
  if (target.version !== identity.version) mismatches.push("version");
  if (target.architecture !== identity.architecture)
    mismatches.push("architecture");
  if (target.executableSha256 !== identity.executableSha256)
    mismatches.push("executableSha256");
  if (target.packageSha256 !== identity.packageSha256)
    mismatches.push("packageSha256");
  if (
    target.bundleId &&
    identity.bundleId &&
    target.bundleId !== identity.bundleId
  )
    mismatches.push("bundleId");
  if (mismatches.length)
    throw new Error(`target identity mismatch: ${mismatches.join(",")}`);
}

function discoverExistingAeraProcesses(appPath) {
  if (process.platform === "win32") return [];
  const result = runBoundedCommand("ps", ["-axo", "pid=,command="], {
    timeoutMs: 5000,
    maximumBytes: 1024 * 1024,
  });
  return result.stdout
    .split(/\r?\n/)
    .filter(
      (line) =>
        /(?:^|[\\/ ])(?:Aera|Aera 2)(?:\.app|\.exe|$)|agentera-studio(?:\.exe)?(?:\s|$)/i.test(
          line,
        ) &&
        !/\bnode(?:\.exe)?\b/i.test(line) &&
        !line.includes(process.argv[1]) &&
        !line.includes(appPath) &&
        !line.includes("--app"),
    )
    .map((line) => line.trim().slice(0, 256));
}

function readTail(path, maximum = 128 * 1024) {
  try {
    const content = readFileSync(path, "utf8");
    return content.length <= maximum ? content : content.slice(-maximum);
  } catch {
    return "";
  }
}

function writeJson(path, value) {
  writeFileSync(
    path,
    `${JSON.stringify(redactStructured(value), null, 2)}\n`,
    "utf8",
  );
}

function writeText(path, value, maximum = 512 * 1024) {
  writeFileSync(path, redactText(value, maximum), "utf8");
}

function fileList(captureDir) {
  return readdirSync(captureDir)
    .sort()
    .filter((name) => name !== "manifest.json")
    .map((name) => {
      safeRelativeName(name);
      const path = join(captureDir, name);
      const info = statSync(path);
      return { name, size: info.size, sha256: hashFile(path) };
    });
}

function scanCapture(captureDir) {
  const findings = [];
  for (const name of readdirSync(captureDir)) {
    const path = join(captureDir, name);
    try {
      if (!statSync(path).isFile()) continue;
      const scan = scanShareableText(readFileSync(path, "utf8"));
      if (!scan.passed) findings.push({ name, findings: scan.findings });
    } catch {
      findings.push({ name, findings: ["unreadable"] });
    }
  }
  return { passed: findings.length === 0, findings };
}

function packageCapture(captureDir, outputDir, platform, captureId) {
  mkdirSync(outputDir, { recursive: true });
  const name = `aera-beta33-${platform === "darwin" ? "macos" : "windows"}-external-diagnostic-${captureId}.zip`;
  const zip = join(outputDir, name);
  const result =
    process.platform === "win32"
      ? runBoundedCommand(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Compress-Archive -LiteralPath ${captureDir}\\* -DestinationPath ${zip} -Force`,
          ],
          { timeoutMs: 30_000, maximumBytes: 64 * 1024 },
        )
      : runBoundedCommand("zip", ["-X", "-q", "-r", zip, "."], {
          cwd: captureDir,
          timeoutMs: 30_000,
          maximumBytes: 64 * 1024,
        });
  if (result.code !== 0 || !existsSync(zip))
    throw new Error("diagnostic ZIP packaging failed");
  try {
    renameSync(captureDir, `${zip}.quarantine`);
  } catch {
    // The ZIP remains usable; manifest records quarantine move failure below.
  }
  return zip;
}

function section(name, value, fallbackReason = "evidence_unavailable") {
  if (value?.status === "collected")
    return { name, status: "collected", reason: null };
  if (value?.status === "failed")
    return { name, status: "failed", reason: value.reason || fallbackReason };
  return { name, status: "missing", reason: value?.reason || fallbackReason };
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function executableStillMatches(pid, executable) {
  if (!processAlive(pid)) return false;
  if (process.platform === "win32") return true;
  const result = runBoundedCommand("ps", ["-p", String(pid), "-o", "comm="], {
    timeoutMs: 3000,
    maximumBytes: 16 * 1024,
  });
  if (result.code !== 0) return false;
  const actual = result.stdout.trim().split(/\r?\n/)[0] || "";
  return actual === executable || basename(actual) === basename(executable);
}

async function waitForObservation({
  child,
  timeoutSeconds,
  noLaunch,
  appPath,
  executable,
}) {
  if (noLaunch)
    return {
      reason: "fixture_no_launch",
      observedPids: [],
      observedOpenFiles: [],
    };
  const started = Date.now();
  let finish;
  const observedPids = new Set(child?.pid ? [child.pid] : []);
  const observedOpenFiles = new Map();
  const sample = () => {
    if (!child?.pid || process.platform !== "darwin") return;
    const platform = collectMacPlatformEvidence({
      rootPid: child.pid,
      executable,
      appPath,
    });
    for (const entry of platform.process?.tree || []) {
      observedPids.add(entry.pid);
      for (const file of collectMacOpenFilePaths(entry.pid)) {
        observedOpenFiles.set(`${file.pid}:${file.path}`, file);
      }
    }
  };
  sample();
  const result = new Promise((resolveWait) => {
    let timer;
    let check;
    let readline;
    let settled = false;
    finish = (reason) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (check) clearInterval(check);
      readline?.close();
      resolveWait(reason);
    };
    child.once("exit", () => finish("tracked_process_exited"));
    child.once("error", () => finish("tracked_process_exited"));
    timer = setTimeout(() => finish("timeout"), timeoutSeconds * 1000);
    timer.unref?.();
    check = setInterval(() => {
      sample();
      if (!executableStillMatches(child.pid, executable))
        finish("process_identity_changed");
      if (Date.now() - started > timeoutSeconds * 1000) finish("timeout");
    }, 250);
    check.unref?.();
    if (process.stdin.isTTY) {
      readline = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      readline.question(
        "\n完成一次操作后按回车结束采集（只操作一次，不会自动重试）：",
        () => {
          readline.close();
          if (
            processAlive(child.pid) &&
            executableStillMatches(child.pid, executable)
          )
            finish("user_enter_with_verified_process");
          else finish("tracked_process_exited");
        },
      );
    }
  });
  const reason = await result;
  return {
    reason,
    observedPids: [...observedPids].sort((left, right) => left - right),
    observedOpenFiles: [...observedOpenFiles.values()],
  };
}

async function collectUnifiedLog(platform, startedAt, endedAt, pids, bundleId) {
  if (platform !== "darwin")
    return { status: "missing", reason: "platform_not_macos", text: "" };
  const request = buildMacUnifiedLogRequest({
    startedAt,
    endedAt,
    pids,
    bundleId,
  });
  const command = runBoundedCommand(request.command, request.args, {
    timeoutMs: 10_000,
    maximumBytes: 2 * 1024 * 1024,
  });
  return {
    status: command.code === 0 ? "collected" : "failed",
    reason:
      command.code === 0
        ? null
        : command.timedOut
          ? "unified_log_timeout"
          : "unified_log_query_failed",
    request: {
      start: request.args[request.args.indexOf("--start") + 1],
      end: request.args[request.args.indexOf("--end") + 1],
      pidCount: pids.length,
    },
    command: {
      code: command.code,
      timedOut: command.timedOut,
      stdoutBytes: command.stdoutBytes,
      stderrBytes: command.stderrBytes,
      stdoutTruncated: command.stdoutTruncated,
      stderrTruncated: command.stderrTruncated,
    },
    text: redactText(command.stdout || command.stderr || "", 2 * 1024 * 1024),
  };
}

function initialMissingSection(name, reason) {
  return { name, status: "missing", reason };
}

export async function runDiagnostic(args) {
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!PLATFORM[args.platform])
    return fail("必须指定 --platform macos 或 windows");
  const platform = PLATFORM[args.platform];
  if (!args.noLaunch && process.platform !== platform)
    return fail(`当前系统是 ${process.platform}，不能运行 ${platform} 工具`);
  if (!args.app) return fail("必须指定 --app");
  const appPath = assertAbsolute(args.app, "--app");
  if (!existsSync(appPath)) return fail("应用路径不存在");
  if (!new Set(["external", "internal"]).has(args.mode))
    return fail("--mode 只能是 external 或 internal");
  if (
    !Number.isInteger(args.timeoutSeconds) ||
    args.timeoutSeconds < 10 ||
    args.timeoutSeconds > 1800
  )
    return fail("--timeout-seconds 必须是 10 到 1800 的整数");
  const executable = findExecutable(appPath, platform);
  if (!existsSync(executable)) return fail("应用主可执行文件不存在");
  const identity = appIdentity(appPath, executable, platform, args.version);
  if (!identity.version) return fail("无法读取应用版本");
  let target;
  if (args.target) {
    try {
      target = loadTarget(assertAbsolute(args.target, "--target"));
      validateTarget(identity, target);
    } catch (error) {
      return fail(error?.message || "target descriptor invalid");
    }
  } else {
    target = targetDescriptor(identity);
  }
  if (args.noLaunch && args.version && identity.version !== args.version)
    identity.version = args.version;
  if (!args.noLaunch) {
    const running = discoverExistingAeraProcesses(appPath);
    if (running.length)
      return fail("检测到已有 Aera 进程，请完全退出后再运行采集器");
  }

  const captureId = randomBytes(16).toString("hex");
  const startedAt = new Date().toISOString();
  const outputDir = args.output
    ? assertAbsolute(args.output, "--output")
    : join(homedir(), "Desktop", "Aera-Diagnostics");
  const captureDir = join(outputDir, `.capture-${captureId}`);
  mkdirSync(captureDir, { recursive: true, mode: 0o700 });
  resetRedactionCounters();
  const hermesHome = args.hermesHome
    ? assertAbsolute(args.hermesHome, "--hermes-home")
    : resolve(process.env.HERMES_HOME || join(homedir(), ".hermes"));
  const userDataPaths = args.userData
    ? [assertAbsolute(args.userData, "--user-data")]
    : [
        join(homedir(), "Library", "Application Support", "agentera-studio"),
        join(homedir(), "Library", "Application Support", "Aera"),
        join(homedir(), "AppData", "Roaming", "agentera-studio"),
      ].filter(existsSync);
  const activeProfile = (() => {
    try {
      const value = readFileSync(
        join(hermesHome, "active_profile"),
        "utf8",
      ).trim();
      return /^[a-z0-9_][a-z0-9_-]{0,127}$/i.test(value) ? value : "default";
    } catch {
      return "default";
    }
  })();
  const paths = managedModelPaths(hermesHome, activeProfile);
  const beforeModel = collectModelChain({
    hermesHome,
    userData: userDataPaths[0] || join(hermesHome, ".aera-user-data"),
    profile: activeProfile,
  });
  const beforeFiles = snapshotManagedModelFiles(paths, "before");
  let child = null;
  let childStdout = "";
  let childStderr = "";
  let rootPid = null;
  if (!args.noLaunch) {
    child = spawn(executable, [], {
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key !== "ELECTRON_RUN_AS_NODE",
        ),
      ),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    rootPid = child.pid || null;
    child.stdout?.on("data", (chunk) => {
      childStdout = `${childStdout}${chunk}`.slice(-256 * 1024);
    });
    child.stderr?.on("data", (chunk) => {
      childStderr = `${childStderr}${chunk}`.slice(-256 * 1024);
    });
  }
  console.log(`Aera 外部诊断已启动，captureId=${captureId}`);
  if (!args.noLaunch)
    console.log(
      "请只复现一次目标操作，看到错误后在终端按回车；采集器不会点击、重试或修改 Aera。",
    );
  const observation = await waitForObservation({
    child,
    timeoutSeconds: args.timeoutSeconds,
    noLaunch: args.noLaunch,
    appPath,
    executable,
  });
  const finishReason = observation.reason;
  const endedAt = new Date().toISOString();
  const platformEvidence =
    platform === "darwin" && rootPid
      ? collectMacPlatformEvidence({
          rootPid,
          executable,
          appPath,
          startedAt,
          endedAt,
        })
      : platform === "win32" && rootPid
        ? collectWindowsPlatformEvidence({
            rootPid,
            executable,
            appPath,
            startedAt,
            endedAt,
          })
        : {
            platform,
            process: initialMissingSection("process", "process_not_launched"),
            network: initialMissingSection("network", "process_not_launched"),
            nativeInventory: {
              status: "missing",
              reason: "process_not_launched",
              entries: [],
              electronModulesAbi: String(process.versions.modules || "unknown"),
            },
            openFiles: {
              status: "missing",
              reason: "process_not_launched",
              entries: [],
            },
          };
  const runtimeEvidence = discoverRuntimeLogEvidence({
    hermesHome,
    userDataPaths,
    openFiles: observation.observedOpenFiles,
    startedAt,
    endedAt,
  });
  const runtimeSources = findRuntimeLogSources({
    hermesHome,
    userDataPaths,
    openFiles: observation.observedOpenFiles,
  });
  const runtimeText = runtimeSources
    .filter((entry) =>
      runtimeEvidence.logs.some(
        (candidate) =>
          candidate.pathSha256 ===
          createHash("sha256")
            .update(`aera-diagnostic-log-path-v1\0${normalize(entry.path)}`)
            .digest("hex"),
      ),
    )
    .map((entry) => `--- ${entry.source} ---\n${readTail(entry.path)}`)
    .join("\n");
  const logsText = redactText(
    `${childStdout}\n${childStderr}\n${runtimeText}`,
    512 * 1024,
  );
  const eventParse = parseStableEvents(logsText.split(/\r?\n/), {
    startedAt,
    endedAt,
  });
  const unifiedLog = await collectUnifiedLog(
    platform,
    startedAt,
    endedAt,
    [
      ...new Set([
        rootPid,
        ...observation.observedPids,
        ...(platformEvidence.process?.tree || []).map((entry) => entry.pid),
      ]),
    ].filter(Boolean),
    identity.bundleId,
  );
  const afterModel = collectModelChain({
    hermesHome,
    userData: userDataPaths[0] || join(hermesHome, ".aera-user-data"),
    profile: activeProfile,
  });
  const afterFiles = snapshotManagedModelFiles(paths, "after");
  const modelComparison = compareModelSnapshots(beforeFiles, afterFiles);
  const updater = eventParse.events.filter(
    (event) => event.source === "updater",
  ).length
    ? {
        status: "collected",
        reason: null,
        events: eventParse.events.filter((event) => event.source === "updater"),
      }
    : { status: "missing", reason: "updater_events_unavailable", events: [] };
  const sections = [
    section("target", { status: "collected" }),
    section("process", platformEvidence.process),
    section(
      "pid_continuity",
      finishReason === "process_identity_changed" ||
        finishReason === "tracked_process_exited"
        ? { status: "failed", reason: finishReason }
        : { status: "collected" },
    ),
    section("network", platformEvidence.network),
    section("native_abi", platformEvidence.nativeInventory),
    section("runtime_logs", runtimeEvidence),
    section("unified_log", unifiedLog),
    section("model_chain", beforeModel),
    section("database", beforeModel.journal),
    section("journal", beforeModel.journal),
    section("route_catalog", { status: "collected" }),
    section(
      "owner",
      beforeModel.owner?.available
        ? { status: "collected" }
        : {
            status: "missing",
            reason: beforeModel.owner?.reason || "owner_unavailable",
          },
    ),
    section("updater", updater),
    section(
      "main_renderer_ipc",
      eventParse.events.length
        ? { status: "collected" }
        : { status: "missing", reason: "stable_product_events_unavailable" },
    ),
  ];
  const missingEvidence = sections
    .filter((entry) => entry.status !== "collected")
    .map((entry) => entry.name);
  writeJson(join(captureDir, "timeline.json"), {
    startedAt,
    endedAt,
    finishReason,
    events: eventParse.events,
  });
  writeJson(join(captureDir, "app-identity.json"), {
    installed: identity,
    target,
    running: rootPid
      ? { pid: rootPid, executableSha256: identity.executableSha256 }
      : null,
  });
  writeJson(join(captureDir, "process.json"), {
    rootPid,
    finishReason,
    process: platformEvidence.process,
    continuity: {
      verified:
        finishReason === "user_enter_with_verified_process" || args.noLaunch,
    },
  });
  writeJson(join(captureDir, "network.json"), platformEvidence.network);
  writeJson(
    join(captureDir, "native-inventory.json"),
    platformEvidence.nativeInventory,
  );
  writeJson(join(captureDir, "journal.json"), beforeModel.journal);
  writeJson(join(captureDir, "transaction-evidence.json"), {
    before: beforeModel,
    after: afterModel,
    comparison: modelComparison,
  });
  writeJson(join(captureDir, "profile-evidence.json"), {
    activeProfileSha256: beforeModel.profileSha256,
    owner: beforeModel.owner,
    managedFiles: beforeModel.files,
  });
  writeJson(
    join(captureDir, "route-catalog-evidence.json"),
    beforeModel.routeCatalog,
  );
  writeJson(join(captureDir, "updater.json"), updater);
  writeJson(join(captureDir, "runtime-evidence.json"), runtimeEvidence);
  writeJson(join(captureDir, "events.json"), {
    events: eventParse.events,
    missingFamilies: eventParse.missingFamilies,
  });
  writeJson(join(captureDir, "config-snapshot.json"), {
    before: beforeFiles,
    after: afterFiles,
    comparison: modelComparison,
    profileSha256: beforeModel.profileSha256,
  });
  writeText(join(captureDir, "logs.txt"), logsText);
  writeText(join(captureDir, "macos-unified-log.txt"), unifiedLog.text || "");
  writeJson(join(captureDir, "platform-diagnostics.json"), {
    platform,
    process: platformEvidence.process?.command || null,
    network: platformEvidence.network?.status || null,
    unifiedLog: unifiedLog.request || null,
    mode: args.mode,
  });
  const scan = scanCapture(captureDir);
  if (!scan.passed) {
    writeJson(join(captureDir, "redaction.json"), {
      passed: false,
      findings: scan.findings,
      ...redactionCounters,
    });
    return fail("检测到未脱敏信息，已拒绝生成 ZIP", 1);
  }
  writeJson(join(captureDir, "redaction.json"), {
    passed: true,
    findings: [],
    ...redactionCounters,
    rules: [
      "credential_fields",
      "bearer_jwt_pem",
      "home_path",
      "url_query",
      "final_secret_scan",
    ],
  });
  const files = fileList(captureDir);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    collectorVersion: COLLECTOR_VERSION,
    captureId,
    target,
    startedAt,
    endedAt,
    platform,
    mode: args.mode,
    finishReason,
    reproductionConfirmed: finishReason === "user_enter_with_verified_process",
    processContinuityConfirmed:
      args.noLaunch ||
      finishReason === "user_enter_with_verified_process" ||
      finishReason === "timeout",
    internal_stage_visibility: "external_only",
    sections,
    missingEvidence,
    files,
  };
  // Validate the closed V4 contract before packaging. Runtime-unbound target descriptors
  // remain valid hashes but are clearly marked in app-identity.json/README as non-candidate.
  try {
    validateDiagnosticBundleV4(manifest);
  } catch (error) {
    return fail(
      `manifest validation failed: ${error?.message || "invalid"}`,
      1,
    );
  }
  writeJson(join(captureDir, "manifest.json"), manifest);
  const zip = packageCapture(captureDir, outputDir, platform, captureId);
  console.log(`采集完成：${zip}`);
  console.log(`发送前请检查：${zip}.quarantine/redaction.json`);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    return await runDiagnostic(args);
  } catch (error) {
    return fail(error?.message || "collector_error", 1);
  }
}

if (
  process.argv[1] &&
  normalize(process.argv[1]) === normalize(new URL(import.meta.url).pathname)
) {
  main().then((code) => {
    if (typeof code === "number") process.exitCode = code;
  });
}
