#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

/**
 * Measure the packaged Windows Runtime inventory hash boundary after one
 * sequential extraction.  This tool is evidence-only: it never invokes the
 * Desktop installer, Gateway, health checks, signing, promotion, or release
 * paths.  The extracted tree is held constant while the inventory helper is
 * run with a small, explicit set of hash-pool sizes.
 */

import { appendFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import {
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
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXTRACTION_MARKER = "AGENTERA_RUNTIME_ARCHIVE_EXTRACTION_HELPER";
const INVENTORY_MARKER = "AGENTERA_RUNTIME_INVENTORY_HELPER";
const DIAGNOSTIC_OUTPUT = "AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT";
const EXTRACTION_MODE = "AGENTERA_RUNTIME_ARCHIVE_EXTRACTION_MODE";
const HASH_CONCURRENCY = "AERA_RUNTIME_INVENTORY_HASH_CONCURRENCY";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINATION_TIMEOUT_MS = 15_000;
const SNAPSHOT_TIMEOUT_MS = 5_000;
const MAX_TAIL_BYTES = 32 * 1024;
const MAX_SNAPSHOT_ENTRIES = 200_000;
const MAX_HASH_CONCURRENCY = 128;
const DEFAULT_CONCURRENCIES = [32, 8, 4, 1];

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseConcurrencyList(value) {
  const raw = value === undefined ? DEFAULT_CONCURRENCIES.join(",") : value;
  const parts = String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("concurrency list is empty");
  const result = parts.map((part) => {
    const parsed = parsePositiveInteger(part, "hash concurrency");
    if (parsed > MAX_HASH_CONCURRENCY) {
      throw new Error(
        `hash concurrency must be no greater than ${MAX_HASH_CONCURRENCY}`,
      );
    }
    return parsed;
  });
  if (new Set(result).size !== result.length) {
    throw new Error("concurrency list contains a duplicate");
  }
  return result;
}

function requiredAbsolute(value, name) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute Windows path`);
  }
  return value;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) {
      throw new Error("arguments must use --name value pairs");
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

function tailText(current, chunk) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length > MAX_TAIL_BYTES
    ? next.subarray(next.length - MAX_TAIL_BYTES)
    : next;
}

export function redactDiagnosticText(value, privateValues = []) {
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

function envValue(environment, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (key.toLowerCase() === wanted && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

export function buildInventoryHelperEnvironment(
  source,
  outputPath,
  concurrency,
) {
  const result = {
    ELECTRON_RUN_AS_NODE: "1",
    [INVENTORY_MARKER]: "1",
    [DIAGNOSTIC_OUTPUT]: outputPath,
    [HASH_CONCURRENCY]: String(concurrency),
  };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const value = envValue(source, key);
    if (value) result[key] = value;
  }
  return result;
}

function buildExtractionHelperEnvironment(source, outputPath) {
  const result = {
    ELECTRON_RUN_AS_NODE: "1",
    [EXTRACTION_MARKER]: "1",
    [EXTRACTION_MODE]: "sequential",
    [DIAGNOSTIC_OUTPUT]: outputPath,
  };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const value = envValue(source, key);
    if (value) result[key] = value;
  }
  return result;
}

function makeEmitter(outputPath) {
  const startedAt = Date.now();
  return (event, fields = {}) => {
    const line = `${JSON.stringify({
      schemaVersion: 1,
      event,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      ...fields,
    })}\n`;
    process.stdout.write(line);
    appendFileSync(outputPath, line, "utf8");
  };
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
          // A file may be in-flight or briefly locked by the scanner.
        }
      }
    }
  }
  return { files, directories, bytes, entries, truncated };
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
  if (!pid || process.platform !== "win32") {
    return { outcome: "unsupported", rows: [] };
  }
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
          commandShape: redactDiagnosticText(row.CommandLine, privateValues),
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
  return { attempted: true, completed, errorCode };
}

function executeChild({
  executable,
  helperPath,
  requestPath,
  env,
  timeoutMs,
  privateValues,
}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let timeoutHandle;
    let stdoutTail = Buffer.alloc(0);
    let stderrTail = Buffer.alloc(0);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        ...result,
        stdoutTail: redactDiagnosticText(
          stdoutTail.toString("utf8"),
          privateValues,
        ),
        stderrTail: redactDiagnosticText(
          stderrTail.toString("utf8"),
          privateValues,
        ),
      });
    };

    try {
      child = execFile(
        executable,
        [helperPath, requestPath],
        {
          encoding: "utf8",
          env,
          windowsHide: true,
          maxBuffer: 64 * 1024,
        },
        (error, stdout, stderr) => {
          // The streams are authoritative while a child is alive.  The
          // callback still supplies output for very short-lived children that
          // can exit before stream listeners are attached.
          if (stdout && stdoutTail.length === 0) {
            stdoutTail = tailText(stdoutTail, stdout);
          }
          if (stderr && stderrTail.length === 0) {
            stderrTail = tailText(stderrTail, stderr);
          }
          if (timedOut) return;
          finish({
            outcome: error ? "failed" : "complete",
            exitCode: error && typeof error.code === "number" ? error.code : 0,
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
      timeoutHandle = setTimeout(async () => {
        if (settled) return;
        timedOut = true;
        const snapshot = await processSnapshot(child?.pid, privateValues);
        const termination = await terminateChild(child);
        finish({
          outcome: "timeout",
          exitCode: child?.exitCode ?? null,
          signal: child?.signalCode ?? null,
          errorCode: "diagnostic-timeout",
          childPid: child?.pid ?? null,
          processSnapshot: snapshot,
          termination,
        });
      }, timeoutMs);
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

function parseHelperResult(stdout) {
  const lines = String(stdout ?? "")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  if (lines.length === 0) return { valid: false, ok: false };
  try {
    const value = JSON.parse(lines.at(-1));
    return {
      valid:
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        value.schemaVersion === 1 &&
        typeof value.ok === "boolean",
      ok: value?.ok === true,
    };
  } catch {
    return { valid: false, ok: false };
  }
}

async function readJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, "utf8");
  return text
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        const value = JSON.parse(line);
        return value && typeof value === "object"
          ? value
          : { event: "invalid-json" };
      } catch {
        return { event: "invalid-json" };
      }
    });
}

export function summarizeHashEvents(events) {
  const started = new Map();
  const terminal = new Set();
  let startedCount = 0;
  let completedCount = 0;
  let errorCount = 0;
  let lastEvent = null;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (typeof event.event === "string") lastEvent = event.event;
    if (
      event.event !== "inventory-hash-file-start" &&
      event.event !== "inventory-hash-file-complete" &&
      event.event !== "inventory-hash-file-error"
    ) {
      continue;
    }
    const fileIndex = Number(event.fileIndex);
    if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) continue;
    if (event.event === "inventory-hash-file-start") {
      startedCount += 1;
      started.set(fileIndex, {
        fileIndex,
        ...(Number.isSafeInteger(Number(event.size))
          ? { size: Number(event.size) }
          : {}),
        ...(typeof event.relativePathSha256 === "string"
          ? { relativePathSha256: event.relativePathSha256 }
          : {}),
      });
    } else if (event.event === "inventory-hash-file-complete") {
      completedCount += 1;
      terminal.add(fileIndex);
    } else {
      errorCount += 1;
      terminal.add(fileIndex);
    }
  }
  return {
    eventCount: events.length,
    startedCount,
    completedCount,
    errorCount,
    pending: [...started.values()]
      .filter(({ fileIndex }) => !terminal.has(fileIndex))
      .sort((left, right) => left.fileIndex - right.fileIndex),
    lastEvent,
  };
}

function helperPaths(resourcesPath) {
  return {
    extraction: path.win32.join(
      resourcesPath,
      "runtime-archive-extraction-helper",
      "runtime-archive-extraction-helper.js",
    ),
    inventory: path.win32.join(
      resourcesPath,
      "runtime-inventory-helper",
      "runtime-inventory-helper.js",
    ),
  };
}

export function extractedRuntimeDestination(extractionDestination) {
  return path.win32.join(extractionDestination, "agentera-runtime");
}

async function writeRequest(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
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
  const concurrencyList = parseConcurrencyList(values.get("concurrency-list"));

  for (const [label, candidate] of [
    ["Electron executable", electronPath],
    ["resources directory", resourcesPath],
    ["Runtime archive", archivePath],
    ["manifest", manifestPath],
  ]) {
    if (!existsSync(candidate)) throw new Error(`${label} does not exist`);
  }
  const paths = helperPaths(resourcesPath);
  for (const [label, candidate] of Object.entries(paths)) {
    if (!existsSync(candidate)) {
      throw new Error(`packaged ${label} helper does not exist`);
    }
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const maxExtractedBytes = Array.isArray(manifest.files)
    ? manifest.files
        .filter((entry) => entry && entry.kind === "file")
        .reduce((total, entry) => total + Number(entry.size ?? 0), 0)
    : 0;
  if (!Number.isSafeInteger(maxExtractedBytes) || maxExtractedBytes < 0) {
    throw new Error("manifest extracted byte budget is invalid");
  }

  const evidenceDir = path.dirname(outputPath);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(outputPath, "", { flag: "w", mode: 0o600 });
  const emit = makeEmitter(outputPath);
  const runRoot = await mkdtemp(
    path.join(tmpdir(), "aera-runtime-inventory-hash-diagnostic-"),
  );
  const extractionDestination = path.join(runRoot, "extracted");
  const inventoryDestination = extractedRuntimeDestination(
    extractionDestination,
  );
  await mkdir(extractionDestination, { recursive: true, mode: 0o700 });
  const privateValues = [
    electronPath,
    resourcesPath,
    archivePath,
    manifestPath,
    runRoot,
    extractionDestination,
    inventoryDestination,
  ];
  const results = [];
  let extraction = null;

  emit("diagnostic-start", {
    platform: process.platform,
    architecture: process.arch,
    archiveBytes: (await stat(archivePath)).size,
    timeoutMs,
    concurrencies: concurrencyList,
  });

  try {
    const extractionEventsPath = path.join(
      evidenceDir,
      "extraction-helper-events.jsonl",
    );
    await writeFile(extractionEventsPath, "", { flag: "w", mode: 0o600 });
    const extractionRequestPath = path.join(runRoot, "extraction-request.json");
    await writeRequest(extractionRequestPath, {
      schemaVersion: 1,
      archivePath,
      destination: extractionDestination,
      hostPlatform: "win32",
    });
    emit("extraction-start", { timeoutMs });
    extraction = await executeChild({
      executable: electronPath,
      helperPath: paths.extraction,
      requestPath: extractionRequestPath,
      env: buildExtractionHelperEnvironment(process.env, extractionEventsPath),
      timeoutMs,
      privateValues,
    });
    const extractionSnapshot = await walkSnapshot(extractionDestination);
    const extractionEvents = await readJsonLines(extractionEventsPath);
    const extractionResult = parseHelperResult(extraction.stdoutTail);
    emit("extraction-complete", {
      ...extraction,
      stdoutTail: extraction.stdoutTail,
      stderrTail: extraction.stderrTail,
      resultValid: extractionResult.valid,
      resultOk: extractionResult.ok,
      ...extractionSnapshot,
      helperEventCount: extractionEvents.length,
      lastHelperEvent: extractionEvents.at(-1)?.event ?? null,
    });
    if (extraction.outcome !== "complete" || !extractionResult.ok) {
      throw new Error("sequential extraction did not complete");
    }

    for (const concurrency of concurrencyList) {
      const name = `inventory-hash-${concurrency}`;
      const eventsPath = path.join(evidenceDir, `${name}-events.jsonl`);
      const pendingPath = path.join(evidenceDir, `${name}-pending.json`);
      const requestPath = path.join(runRoot, `${name}-request.json`);
      await writeFile(eventsPath, "", { flag: "w", mode: 0o600 });
      await writeRequest(requestPath, {
        schemaVersion: 1,
        destination: inventoryDestination,
        manifest,
        maxExtractedBytes,
        hostPlatform: "win32",
      });
      emit("inventory-variant-start", { name, concurrency, timeoutMs });
      const execution = await executeChild({
        executable: electronPath,
        helperPath: paths.inventory,
        requestPath,
        env: buildInventoryHelperEnvironment(
          process.env,
          eventsPath,
          concurrency,
        ),
        timeoutMs,
        privateValues,
      });
      const snapshot = await walkSnapshot(inventoryDestination);
      const events = await readJsonLines(eventsPath);
      const hashSummary = summarizeHashEvents(events);
      const helperResult = parseHelperResult(execution.stdoutTail);
      await writeFile(
        pendingPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            name,
            concurrency,
            ...hashSummary,
          },
          null,
          2,
        )}\n`,
        { flag: "w", mode: 0o600 },
      );
      const result = {
        name,
        concurrency,
        outcome:
          execution.outcome === "complete" && helperResult.ok
            ? "complete"
            : execution.outcome,
        exitCode: execution.exitCode,
        signal: execution.signal,
        errorCode: execution.errorCode,
        childPid: execution.childPid,
        stdoutTail: execution.stdoutTail,
        stderrTail: execution.stderrTail,
        resultValid: helperResult.valid,
        resultOk: helperResult.ok,
        ...snapshot,
        ...hashSummary,
        processSnapshot: execution.processSnapshot ?? null,
        termination: execution.termination ?? null,
      };
      results.push(result);
      emit("inventory-variant-complete", result);
    }
  } finally {
    emit("diagnostic-complete", {
      extractionOutcome: extraction?.outcome ?? null,
      variantsCompleted: results.length,
      variantFailures: results.filter((result) => result.outcome !== "complete")
        .length,
      results: results.map((result) => ({
        name: result.name,
        concurrency: result.concurrency,
        outcome: result.outcome,
        files: result.files,
        bytes: result.bytes,
        startedCount: result.startedCount,
        completedCount: result.completedCount,
        pendingCount: result.pending.length,
      })),
    });
    await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

const values = parseArgs(process.argv.slice(2));
if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  parentMain(values).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
