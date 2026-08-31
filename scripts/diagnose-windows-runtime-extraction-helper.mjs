#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

/**
 * Diagnose the packaged Windows Runtime extraction-helper boundary.
 *
 * This is an evidence-only tool. It invokes the already-built helper with the
 * exact request shape used by production, then compares a small number of
 * process/environment boundaries one at a time. It never calls the Desktop
 * installer, Gateway, signing, promotion, or release paths.
 *
 * The important distinction from diagnose-windows-runtime-extraction.mjs is
 * that this tool executes runtime-archive-extraction-helper.js itself. The
 * native extractor and the helper wrapper therefore remain separate evidence
 * layers.
 */

import { appendFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXTRACTION_MARKER = "AGENTERA_RUNTIME_ARCHIVE_EXTRACTION_HELPER";
const VALIDATION_MARKER = "AGENTERA_RUNTIME_ARCHIVE_VALIDATION_HELPER";
const DIAGNOSTIC_OUTPUT = "AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT";
const MODULE_OVERRIDE = "AGENTERA_RUNTIME_EXTRACT_ZIP_MODULE_PATH";
const SHIM_OUTPUT = "AERA_EXTRACTION_SHIM_OUTPUT";
const SHIM_REAL_MODULE = "AERA_EXTRACTION_REAL_MODULE_PATH";
const ELECTRON_PARENT_MARKER = "AERA_EXTRACTION_ELECTRON_PARENT";

const DEFAULT_TIMEOUT_MS = 120_000;
const TERMINATION_TIMEOUT_MS = 15_000;
const SNAPSHOT_TIMEOUT_MS = 5_000;
const MAX_TAIL_BYTES = 32 * 1024;
const MAX_SNAPSHOT_ENTRIES = 200_000;

const SAFE_WINDOWS_ENV_KEYS = [
  "ComSpec",
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "SystemDrive",
  "SYSTEMDRIVE",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "WINDIR",
];

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) {
      throw new Error("arguments must use --name value pairs");
    }
    if (flag === "--child") {
      values.set("child", true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    values.set(flag.slice(2), value);
    index += 1;
  }
  return values;
}

function requiredAbsolute(value, name) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute Windows path`);
  }
  return value;
}

function tailText(current, chunk) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length > MAX_TAIL_BYTES
    ? next.subarray(next.length - MAX_TAIL_BYTES)
    : next;
}

function redactedText(value, privateValues = []) {
  let result = String(value ?? "");
  for (const privateValue of privateValues
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .sort((left, right) => right.length - left.length)) {
    result = result.split(privateValue).join("<path>");
  }
  return result
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>|,;]*/gu, "<path>")
    .replace(
      /(^|[\s=()]|\[)(\/(?:Users|home|private|tmp|var|opt|workspace|runner|aera)\/[^\s"'<>|]*)/giu,
      "$1<path>",
    );
}

function makeEmitter(outputPath) {
  const startedAt = Date.now();
  if (outputPath) appendFileSync(outputPath, "", "utf8");
  return (event, fields = {}) => {
    const line = `${JSON.stringify({
      schemaVersion: 1,
      event,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      ...fields,
    })}\n`;
    process.stdout.write(line);
    if (outputPath) appendFileSync(outputPath, line, "utf8");
  };
}

function envValue(environment, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (key.toLowerCase() === wanted && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function copySafeWindowsEnvironment(source) {
  const result = {};
  for (const key of SAFE_WINDOWS_ENV_KEYS) {
    const value = envValue(source, key);
    if (value) result[key] = value;
  }
  return result;
}

/** Match buildRuntimeArchiveExtractionHelperEnvironment exactly. */
function productionHelperEnvironment(source, marker, outputPath) {
  const result = {
    ELECTRON_RUN_AS_NODE: "1",
    [marker]: "1",
  };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const value = envValue(source, key);
    if (value) result[key] = value;
  }
  if (outputPath) result[DIAGNOSTIC_OUTPUT] = outputPath;
  return result;
}

function extendedHelperEnvironment(source, marker, outputPath) {
  const result = productionHelperEnvironment(source, marker, outputPath);
  Object.assign(result, copySafeWindowsEnvironment(source));
  return result;
}

async function walkSnapshot(root) {
  const queue = [root];
  let files = 0;
  let directories = 0;
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    let children;
    try {
      children = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      entries += 1;
      if (entries > MAX_SNAPSHOT_ENTRIES) {
        truncated = true;
        return {
          files,
          directories,
          bytes,
          entries: MAX_SNAPSHOT_ENTRIES,
          truncated,
        };
      }
      const childPath = path.join(current, child.name);
      if (child.isDirectory()) {
        directories += 1;
        queue.push(childPath);
      } else if (child.isFile()) {
        files += 1;
        try {
          bytes += (await stat(childPath)).size;
        } catch {
          // A file may still be in flight.
        }
      }
    }
  }
  return { files, directories, bytes, entries, truncated };
}

function helperPaths(resourcesPath) {
  return {
    extraction: path.win32.join(
      resourcesPath,
      "runtime-archive-extraction-helper",
      "runtime-archive-extraction-helper.js",
    ),
    validation: path.win32.join(
      resourcesPath,
      "runtime-archive-validation-helper",
      "runtime-archive-validation-helper.js",
    ),
    nativeModule: path.win32.join(
      resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "@electron-internal",
      "extract-zip",
      "index.js",
    ),
  };
}

function processQueryScript(pid) {
  const safePid = parsePositiveInteger(pid, "pid");
  return [
    "$ErrorActionPreference='Stop'",
    `$rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -eq ${safePid} -or $_.ParentProcessId -eq ${safePid} })`,
    "if ($rows.Count -eq 0) { '[]' } else {",
    "$rows | ForEach-Object { [ordered]@{ ProcessId=[int]$_.ProcessId; ParentProcessId=[int]$_.ParentProcessId; Name=$_.Name; CreationFileTimeUtc=if ($_.CreationDate) {$_.CreationDate.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)} else {$null}; KernelModeTime100ns=$_.KernelModeTime; UserModeTime100ns=$_.UserModeTime; CommandLine=$_.CommandLine } } | ConvertTo-Json -Compress",
    "}",
  ].join("; ");
}

async function processSnapshot(pid, privateValues) {
  if (!pid || process.platform !== "win32")
    return { outcome: "unsupported", rows: [] };
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", processQueryScript(pid)],
      {
        encoding: "utf8",
        timeout: SNAPSHOT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 128 * 1024,
      },
    );
    let parsed;
    try {
      parsed = JSON.parse(String(stdout).trim() || "[]");
    } catch {
      return { outcome: "invalid-json", rows: [] };
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return {
      outcome: "complete",
      rows: rows
        .filter((row) => row && typeof row === "object")
        .map((row) => ({
          pid: Number.isSafeInteger(Number(row.ProcessId))
            ? Number(row.ProcessId)
            : null,
          parentPid: Number.isSafeInteger(Number(row.ParentProcessId))
            ? Number(row.ParentProcessId)
            : null,
          image: typeof row.Name === "string" ? row.Name : null,
          creationIdentity: row.CreationFileTimeUtc
            ? `windows:${String(row.CreationFileTimeUtc)}`
            : null,
          cpuSeconds:
            Number.isFinite(Number(row.KernelModeTime100ns)) &&
            Number.isFinite(Number(row.UserModeTime100ns))
              ? (Number(row.KernelModeTime100ns) +
                  Number(row.UserModeTime100ns)) /
                10_000_000
              : null,
          commandShape: redactedText(row.CommandLine, privateValues),
        })),
    };
  } catch (error) {
    return {
      outcome: error?.code === "ETIMEDOUT" ? "timeout" : "query-error",
      rows: [],
    };
  }
}

async function terminateChild(child) {
  const pid = child?.pid;
  if (!pid) return { attempted: false, completed: true, errorCode: null };
  let errorCode = null;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        encoding: "utf8",
        timeout: TERMINATION_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      });
    } catch (error) {
      errorCode = error?.code ?? "taskkill-failed";
    }
  } else {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      errorCode = error?.code ?? "signal-failed";
    }
  }
  const completed = await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), TERMINATION_TIMEOUT_MS);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  return {
    attempted: true,
    completed,
    errorCode,
  };
}

function executeWithExecFile(command, args, options, timeoutMs, privateValues) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timeoutHandle;
    let stdoutTail = Buffer.alloc(0);
    let stderrTail = Buffer.alloc(0);
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        ...result,
        stdoutTail: redactedText(stdoutTail.toString("utf8"), privateValues),
        stderrTail: redactedText(stderrTail.toString("utf8"), privateValues),
      });
    };
    try {
      child = execFile(
        command,
        args,
        {
          ...options,
          encoding: "utf8",
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (stdout) stdoutTail = tailText(stdoutTail, stdout);
          if (stderr) stderrTail = tailText(stderrTail, stderr);
          if (timedOut) return;
          finish({
            outcome: error ? "failed" : "complete",
            exitCode: error
              ? typeof error.code === "number"
                ? error.code
                : null
              : 0,
            signal: error?.signal ?? null,
            errorCode: error?.code ?? null,
            childPid: child?.pid ?? null,
          });
        },
      );
      child.stdout?.on("data", (chunk) => {
        stdoutTail = tailText(stdoutTail, chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderrTail = tailText(stderrTail, chunk);
      });
      const childPid = child.pid ?? null;
      timeoutHandle = setTimeout(async () => {
        if (settled) return;
        timedOut = true;
        const snapshot = await processSnapshot(childPid, privateValues);
        const termination = await terminateChild(child);
        finish({
          outcome: "timeout",
          exitCode: child.exitCode,
          signal: child.signalCode,
          errorCode: "diagnostic-timeout",
          childPid,
          termination,
          processSnapshot: snapshot,
        });
      }, timeoutMs);
      return;
    } catch (error) {
      finish({
        outcome: "spawn-error",
        exitCode: null,
        signal: null,
        errorCode: error?.code ?? "spawn-error",
        childPid: null,
      });
    }
  });
}

async function writeExtractionRequest(directory, archivePath, destination) {
  const requestPath = path.join(directory, "extraction-request.json");
  await writeFile(
    requestPath,
    `${JSON.stringify({ schemaVersion: 1, archivePath, destination, hostPlatform: "win32" })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return requestPath;
}

async function writeValidationRequest(directory, archivePath, manifest) {
  const maxExtractedBytes = manifest.files
    .filter((entry) => entry.kind === "file")
    .reduce((total, entry) => total + entry.size, 0);
  const requestPath = path.join(directory, "validation-request.json");
  await writeFile(
    requestPath,
    `${JSON.stringify({ schemaVersion: 1, archivePath, manifest, maxExtractedBytes, hostPlatform: "win32" })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return requestPath;
}

async function writeShim(directory) {
  const shimPath = path.join(directory, "extract-zip-probe.mjs");
  await writeFile(
    shimPath,
    `import { appendFileSync } from "node:fs";\nimport { pathToFileURL } from "node:url";\nconst output = process.env["${SHIM_OUTPUT}"];\nfunction event(name, fields = {}) { if (!output) return; try { appendFileSync(output, JSON.stringify({ event: name, timestampMs: Date.now(), ...fields }) + "\\n", "utf8"); } catch {} }\nevent("shim-import-start");\nconst realPath = process.env["${SHIM_REAL_MODULE}"];\nconst loaded = await import(pathToFileURL(realPath).href);\nevent("shim-import-complete");\nconst nativeExtract = loaded.extract ?? loaded.default;\nif (typeof nativeExtract !== "function") throw new Error("native extractor export is unavailable");\nexport async function extract(archivePath, options) { event("shim-extract-start"); try { const result = await nativeExtract(archivePath, options); event("shim-extract-complete"); return result; } catch (error) { event("shim-extract-error", { name: error?.name ?? "Error" }); throw error; } }\nexport default extract;\n`,
    { flag: "wx", mode: 0o600 },
  );
  return shimPath;
}

async function runHelperVariant({
  name,
  electronPath,
  helperPath,
  archivePath,
  resourcesPath,
  root,
  sourceEnvironment,
  timeoutMs,
  emit,
  environmentMode,
  moduleOverride,
  privateValues,
}) {
  const variantRoot = path.join(root, name);
  const destination = path.join(
    variantRoot,
    "runtime",
    "transaction",
    "payload.zip-extracting",
  );
  await mkdir(destination, { recursive: true });
  const requestPath = await writeExtractionRequest(
    variantRoot,
    archivePath,
    destination,
  );
  const eventsPath = path.join(variantRoot, "helper-events.jsonl");
  const env =
    environmentMode === "extended"
      ? extendedHelperEnvironment(
          sourceEnvironment,
          EXTRACTION_MARKER,
          eventsPath,
        )
      : productionHelperEnvironment(
          sourceEnvironment,
          EXTRACTION_MARKER,
          eventsPath,
        );
  if (moduleOverride) {
    env[MODULE_OVERRIDE] = moduleOverride.path;
    env[SHIM_OUTPUT] = moduleOverride.output;
    env[SHIM_REAL_MODULE] = path.win32.join(
      resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "@electron-internal",
      "extract-zip",
      "index.js",
    );
  }
  emit("variant-start", {
    name,
    environmentMode,
    moduleOverride: Boolean(moduleOverride),
    timeoutMs,
  });
  const result = await executeWithExecFile(
    electronPath,
    [helperPath, requestPath],
    { env },
    timeoutMs,
    privateValues,
  );
  const snapshot = await walkSnapshot(destination);
  const helperEvents = existsSync(eventsPath)
    ? (await readFile(eventsPath, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { event: "invalid-helper-event" };
          }
        })
    : [];
  const shimEvents =
    moduleOverride?.output && existsSync(moduleOverride.output)
      ? (await readFile(moduleOverride.output, "utf8"))
          .trim()
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return { event: "invalid-shim-event" };
            }
          })
      : [];
  emit("variant-complete", {
    name,
    ...result,
    ...snapshot,
    helperEvents,
    shimEvents,
  });
  return {
    name,
    result,
    snapshot,
    helperEvents,
    shimEvents,
    eventsPath,
    shimEventsPath: moduleOverride?.output ?? null,
  };
}

async function runElectronParentVariant({
  name,
  electronPath,
  helperPath,
  archivePath,
  root,
  sourceEnvironment,
  timeoutMs,
  emit,
  privateValues,
  parentProbePath,
}) {
  const variantRoot = path.join(root, name);
  const destination = path.join(
    variantRoot,
    "runtime",
    "transaction",
    "payload.zip-extracting",
  );
  await mkdir(destination, { recursive: true });
  const requestPath = await writeExtractionRequest(
    variantRoot,
    archivePath,
    destination,
  );
  const eventsPath = path.join(variantRoot, "helper-events.jsonl");
  const configPath = path.join(variantRoot, "parent-config.json");
  const helperEnv = productionHelperEnvironment(
    sourceEnvironment,
    EXTRACTION_MARKER,
    eventsPath,
  );
  await writeFile(
    configPath,
    `${JSON.stringify({ electronPath, helperPath, requestPath, helperEnv })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const parentEnv = {
    ...copySafeWindowsEnvironment(sourceEnvironment),
    ELECTRON_RUN_AS_NODE: "1",
    [ELECTRON_PARENT_MARKER]: "1",
  };
  emit("variant-start", { name, parent: "packaged-electron-node", timeoutMs });
  const result = await executeWithExecFile(
    electronPath,
    [parentProbePath, configPath],
    { env: parentEnv },
    timeoutMs,
    privateValues,
  );
  const snapshot = await walkSnapshot(destination);
  const helperEvents = existsSync(eventsPath)
    ? (await readFile(eventsPath, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { event: "invalid-helper-event" };
          }
        })
    : [];
  emit("variant-complete", { name, ...result, ...snapshot, helperEvents });
  return { name, result, snapshot, helperEvents, eventsPath };
}

async function runValidationThenExtraction({
  name,
  electronPath,
  validationHelperPath,
  extractionHelperPath,
  archivePath,
  manifest,
  root,
  sourceEnvironment,
  timeoutMs,
  emit,
  privateValues,
}) {
  const variantRoot = path.join(root, name);
  const destination = path.join(
    variantRoot,
    "runtime",
    "transaction",
    "payload.zip-extracting",
  );
  await mkdir(destination, { recursive: true });
  const validationRequest = await writeValidationRequest(
    variantRoot,
    archivePath,
    manifest,
  );
  const validationEventsPath = path.join(
    variantRoot,
    "validation-events.jsonl",
  );
  const validationEnv = productionHelperEnvironment(
    sourceEnvironment,
    VALIDATION_MARKER,
    validationEventsPath,
  );
  emit("validation-start", { name, timeoutMs });
  const validation = await executeWithExecFile(
    electronPath,
    [validationHelperPath, validationRequest],
    { env: validationEnv },
    timeoutMs,
    privateValues,
  );
  emit("validation-complete", { name, ...validation });
  const extractionRequest = await writeExtractionRequest(
    variantRoot,
    archivePath,
    destination,
  );
  const extractionEventsPath = path.join(
    variantRoot,
    "extraction-events.jsonl",
  );
  const extractionEnv = productionHelperEnvironment(
    sourceEnvironment,
    EXTRACTION_MARKER,
    extractionEventsPath,
  );
  const extraction = await executeWithExecFile(
    electronPath,
    [extractionHelperPath, extractionRequest],
    { env: extractionEnv },
    timeoutMs,
    privateValues,
  );
  const snapshot = await walkSnapshot(destination);
  const readEvents = async (filePath) =>
    existsSync(filePath)
      ? (await readFile(filePath, "utf8"))
          .trim()
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return { event: "invalid-helper-event" };
            }
          })
      : [];
  const validationEvents = await readEvents(validationEventsPath);
  const extractionEvents = await readEvents(extractionEventsPath);
  emit("variant-complete", {
    name,
    validation,
    extraction,
    ...snapshot,
    validationEvents,
    extractionEvents,
  });
  return {
    name,
    validation,
    extraction,
    snapshot,
    validationEvents,
    extractionEvents,
    validationEventsPath,
    extractionEventsPath,
  };
}

async function writeElectronParentProbe(directory) {
  const probePath = path.join(directory, "electron-parent-probe.cjs");
  await writeFile(
    probePath,
    `const { execFile } = require("node:child_process");\nconst { readFileSync } = require("node:fs");\nif (process.env["${ELECTRON_PARENT_MARKER}"] !== "1" || process.argv.length !== 3) process.exit(2);\nconst config = JSON.parse(readFileSync(process.argv[2], "utf8"));\nlet stdout = ""; let stderr = "";\nconst child = execFile(config.electronPath, [config.helperPath, config.requestPath], { env: config.helperEnv, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 }, (error, out, err) => { stdout = String(out ?? ""); stderr = String(err ?? ""); process.stdout.write(JSON.stringify({ errorCode: error?.code ?? null, signal: error?.signal ?? null, stdout, stderr }) + "\\n"); });\nchild.on("error", (error) => { process.stdout.write(JSON.stringify({ errorCode: error?.code ?? "spawn-error", signal: null, stdout, stderr }) + "\\n"); });\n`,
    { flag: "wx", mode: 0o600 },
  );
  return probePath;
}

async function parentMain(values) {
  const electronPath = requiredAbsolute(values.get("electron"), "--electron");
  const resourcesPath = requiredAbsolute(
    values.get("resources"),
    "--resources",
  );
  const archivePath = requiredAbsolute(values.get("archive"), "--archive");
  const manifestPath = requiredAbsolute(values.get("manifest"), "--manifest");
  const outputPath = requiredAbsolute(values.get("output"), "--output");
  const timeoutMs = values.has("timeout-ms")
    ? parsePositiveInteger(values.get("timeout-ms"), "--timeout-ms")
    : DEFAULT_TIMEOUT_MS;
  for (const [name, value] of [
    ["Electron executable", electronPath],
    ["resources directory", resourcesPath],
    ["Runtime archive", archivePath],
    ["manifest", manifestPath],
  ]) {
    if (!existsSync(value)) throw new Error(`${name} does not exist`);
  }
  const paths = helperPaths(resourcesPath);
  for (const [name, value] of Object.entries(paths)) {
    if (!existsSync(value))
      throw new Error(`packaged ${name} helper/module does not exist`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const runRoot = await mkdtemp(
    path.join(tmpdir(), "aera-runtime-extraction-helper-diagnostic-"),
  );
  const evidenceDir = path.dirname(outputPath);
  await mkdir(evidenceDir, { recursive: true });
  const emit = makeEmitter(outputPath);
  const privateValues = [
    electronPath,
    resourcesPath,
    archivePath,
    manifestPath,
    runRoot,
  ];
  const results = [];
  emit("diagnostic-start", {
    platform: process.platform,
    architecture: process.arch,
    archiveBytes: (await stat(archivePath)).size,
    timeoutMs,
    variants: 5,
  });
  try {
    results.push(
      await runHelperVariant({
        name: "helper-minimal",
        electronPath,
        helperPath: paths.extraction,
        archivePath,
        resourcesPath,
        root: runRoot,
        sourceEnvironment: process.env,
        timeoutMs,
        emit,
        environmentMode: "minimal",
        privateValues,
      }),
    );
    results.push(
      await runHelperVariant({
        name: "helper-extended",
        electronPath,
        helperPath: paths.extraction,
        archivePath,
        resourcesPath,
        root: runRoot,
        sourceEnvironment: process.env,
        timeoutMs,
        emit,
        environmentMode: "extended",
        privateValues,
      }),
    );
    results.push(
      await runValidationThenExtraction({
        name: "validation-then-helper",
        electronPath,
        validationHelperPath: paths.validation,
        extractionHelperPath: paths.extraction,
        archivePath,
        manifest,
        root: runRoot,
        sourceEnvironment: process.env,
        timeoutMs,
        emit,
        privateValues,
      }),
    );
    const shimDirectory = path.join(runRoot, "shim");
    await mkdir(shimDirectory, { recursive: true });
    const shimPath = await writeShim(shimDirectory);
    results.push(
      await runHelperVariant({
        name: "helper-shim-stages",
        electronPath,
        helperPath: paths.extraction,
        archivePath,
        resourcesPath,
        root: runRoot,
        sourceEnvironment: process.env,
        timeoutMs,
        emit,
        environmentMode: "extended",
        moduleOverride: {
          path: shimPath,
          output: path.join(runRoot, "shim-events.jsonl"),
        },
        privateValues,
      }),
    );
    const parentProbePath = await writeElectronParentProbe(runRoot);
    results.push(
      await runElectronParentVariant({
        name: "helper-electron-parent",
        electronPath,
        helperPath: paths.extraction,
        archivePath,
        root: runRoot,
        sourceEnvironment: process.env,
        timeoutMs,
        emit,
        privateValues,
        parentProbePath,
      }),
    );
  } finally {
    for (const result of results) {
      const eventFiles = [
        [result.eventsPath, `${result.name}-events.jsonl`],
        [result.shimEventsPath, `${result.name}-shim-events.jsonl`],
        [result.validationEventsPath, `${result.name}-validation-events.jsonl`],
        [result.extractionEventsPath, `${result.name}-extraction-events.jsonl`],
      ];
      for (const [source, filename] of eventFiles) {
        if (source) {
          await copyFile(source, path.join(evidenceDir, filename)).catch(
            () => undefined,
          );
        }
      }
    }
    emit("diagnostic-complete", {
      results: results.map((result) => ({
        name: result.name,
        outcome: result.result?.outcome ?? result.extraction?.outcome ?? null,
        files: result.snapshot?.files ?? null,
        bytes: result.snapshot?.bytes ?? null,
      })),
    });
    await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function childMain(values) {
  // The Electron-parent probe is intentionally kept as a separate generated
  // script. This branch makes accidental direct execution fail closed.
  if (values.has("child"))
    throw new Error("diagnostic child mode is not supported");
}

const values = parseArgs(process.argv.slice(2));
try {
  if (values.has("child")) await childMain(values);
  else await parentMain(values);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}
