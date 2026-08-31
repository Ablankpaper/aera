#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

/**
 * Compare the native Runtime ZIP extractor with a sequential yauzl control on
 * the exact verified Windows Seed.  This is an evidence-only diagnostic: it
 * never runs the Desktop installer, Gateway, health checks, or inventory
 * verifier.  A packaged Electron executable can be supplied so the native
 * variant uses the same ELECTRON_RUN_AS_NODE boundary as production.
 *
 * The parent process owns the timeout and cleanup.  The child process does
 * only one extraction, which means a native async task that stops resolving
 * cannot keep the diagnostic parent alive or hide its final filesystem
 * snapshot.
 */

import { execFile, spawn } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 180_000;
const PROGRESS_INTERVAL_MS = 2_000;
const TERMINATION_TIMEOUT_MS = 15_000;
const MAX_TAIL_BYTES = 32 * 1024;
const MAX_WALK_ENTRIES = 200_000;
const CHILD_MARKER = "AERA_RUNTIME_EXTRACTION_DIAGNOSTIC_CHILD";

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function requiredAbsolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
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

function tailText(current, chunk) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length > MAX_TAIL_BYTES
    ? next.subarray(next.length - MAX_TAIL_BYTES)
    : next;
}

function redactDiagnosticText(value, privateValues = []) {
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
      if (entries > MAX_WALK_ENTRIES) {
        truncated = true;
        return {
          files,
          directories,
          bytes,
          entries: MAX_WALK_ENTRIES,
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
          // The file may be in flight while the native worker is writing it.
        }
      }
    }
  }
  return { files, directories, bytes, entries, truncated };
}

function normalizeArchiveEntry(rawName) {
  const normalized = rawName.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error("diagnostic archive entry is unsafe");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) {
    throw new Error("diagnostic archive entry escapes destination");
  }
  return parts.join("/");
}

async function loadNativeExtractor(modulePath) {
  const module = await import(pathToFileURL(modulePath).href);
  const extract = module.extract ?? module.default;
  if (typeof extract !== "function") {
    throw new Error("native extractor export is unavailable");
  }
  return extract;
}

function loadYauzl(yauzlPath) {
  const requireFromScript = createRequire(import.meta.url);
  const module = requireFromScript(yauzlPath);
  if (!module || typeof module.open !== "function") {
    throw new Error("yauzl control extractor is unavailable");
  }
  return module;
}

function extractWithYauzl(yauzl, archivePath, destination) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    yauzl.open(
      archivePath,
      {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zipfile) => {
        if (error || !zipfile) {
          finish(error ?? new Error("could not open diagnostic archive"));
          return;
        }
        zipfile.on("error", finish);
        zipfile.on("end", () => finish());
        zipfile.on("entry", (entry) => {
          let relative;
          try {
            relative = normalizeArchiveEntry(entry.fileName);
          } catch (entryError) {
            zipfile.close();
            finish(entryError);
            return;
          }
          const output = path.join(destination, relative);
          const relativeCheck = path.relative(destination, output);
          if (
            relativeCheck.startsWith("..") ||
            path.isAbsolute(relativeCheck)
          ) {
            zipfile.close();
            finish(new Error("diagnostic archive entry escapes destination"));
            return;
          }
          if (entry.fileName.endsWith("/")) {
            mkdir(output, { recursive: true })
              .then(() => zipfile.readEntry())
              .catch((mkdirError) => {
                zipfile.close();
                finish(mkdirError);
              });
            return;
          }
          const parent = path.dirname(output);
          mkdir(parent, { recursive: true })
            .then(
              () =>
                new Promise((resolveStream, rejectStream) => {
                  zipfile.openReadStream(entry, (streamError, stream) => {
                    if (streamError || !stream) {
                      rejectStream(
                        streamError ??
                          new Error("could not open diagnostic ZIP entry"),
                      );
                      return;
                    }
                    pipeline(stream, createWriteStream(output, { flags: "w" }))
                      .then(resolveStream)
                      .catch(rejectStream);
                  });
                }),
            )
            .then(() => zipfile.readEntry())
            .catch((entryError) => {
              zipfile.close();
              finish(entryError);
            });
        });
        zipfile.readEntry();
      },
    );
  });
}

async function childMain(values) {
  if (process.env[CHILD_MARKER] !== "1") {
    throw new Error("invalid diagnostic child invocation");
  }
  const mode = values.get("mode");
  const archivePath = requiredAbsolute(values.get("archive"), "--archive");
  const destination = requiredAbsolute(
    values.get("destination"),
    "--destination",
  );
  await mkdir(destination, { recursive: true });
  if (mode === "native") {
    const modulePath = requiredAbsolute(values.get("module"), "--module");
    const extract = await loadNativeExtractor(modulePath);
    await extract(archivePath, { dir: destination });
  } else if (mode === "yauzl") {
    const yauzlPath = requiredAbsolute(values.get("yauzl"), "--yauzl");
    await extractWithYauzl(loadYauzl(yauzlPath), archivePath, destination);
  } else {
    throw new Error("--mode must be native or yauzl");
  }
  process.stdout.write('{"schemaVersion":1,"ok":true}\n');
}

function runCommand(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, arguments_, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

function childEnvironment() {
  const environment = {};
  for (const key of [
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
  ]) {
    if (typeof process.env[key] === "string" && process.env[key].length > 0) {
      environment[key] = process.env[key];
    }
  }
  return {
    ...environment,
    ELECTRON_RUN_AS_NODE: "1",
    [CHILD_MARKER]: "1",
  };
}

async function terminateChild(child, emit, mode) {
  const pid = child.pid;
  if (!pid) return { attempted: false, completed: true };
  emit("variant-termination-start", { mode, pid });
  let errorCode = null;
  if (process.platform === "win32") {
    try {
      await runCommand("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        timeout: TERMINATION_TIMEOUT_MS,
        windowsHide: true,
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
  emit("variant-termination-complete", { mode, pid, completed, errorCode });
  return { attempted: true, completed, errorCode };
}

async function runVariant({
  mode,
  executable,
  scriptPath,
  archivePath,
  modulePath,
  yauzlPath,
  root,
  timeoutMs,
  emit,
  privateValues = [],
}) {
  const destination = path.join(root, mode);
  await mkdir(destination, { recursive: false });
  const childArgs = [
    scriptPath,
    "--child",
    "--mode",
    mode,
    "--archive",
    archivePath,
    "--destination",
    destination,
  ];
  if (modulePath) childArgs.push("--module", modulePath);
  if (yauzlPath) childArgs.push("--yauzl", yauzlPath);
  const child = spawn(executable, childArgs, {
    cwd: path.dirname(scriptPath),
    env: childEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdoutTail = Buffer.alloc(0);
  let stderrTail = Buffer.alloc(0);
  child.stdout?.on("data", (chunk) => {
    stdoutTail = tailText(stdoutTail, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderrTail = tailText(stderrTail, chunk);
  });
  const startedAt = Date.now();
  emit("variant-start", { mode, pid: child.pid ?? null, timeoutMs });
  let progressInFlight = false;
  const progressTimer = setInterval(async () => {
    if (progressInFlight) return;
    progressInFlight = true;
    try {
      const snapshot = await walkSnapshot(destination);
      emit("variant-progress", {
        mode,
        pid: child.pid ?? null,
        childAlive: child.exitCode === null && child.signalCode === null,
        elapsedMs: Date.now() - startedAt,
        ...snapshot,
      });
    } finally {
      progressInFlight = false;
    }
  }, PROGRESS_INTERVAL_MS);
  progressTimer.unref?.();
  const exitPromise = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
  }, timeoutMs);
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve(null), timeoutMs).unref?.();
  });
  const result = await Promise.race([exitPromise, timeoutPromise]);
  clearTimeout(timeoutTimer);
  clearInterval(progressTimer);
  let termination = { attempted: false, completed: true, errorCode: null };
  if (timedOut) termination = await terminateChild(child, emit, mode);
  const finalSnapshot = await walkSnapshot(destination);
  const outcome = timedOut
    ? "timeout"
    : result?.code === 0
      ? "complete"
      : "failed";
  emit("variant-complete", {
    mode,
    pid: child.pid ?? null,
    outcome,
    exitCode: result?.code ?? null,
    signal: result?.signal ?? null,
    elapsedMs: Date.now() - startedAt,
    stdoutTail: redactDiagnosticText(stdoutTail.toString("utf8"), [
      ...privateValues,
      destination,
    ]),
    stderrTail: redactDiagnosticText(stderrTail.toString("utf8"), [
      ...privateValues,
      destination,
    ]),
    ...finalSnapshot,
    termination,
  });
  if (termination.completed && child.exitCode !== null) {
    await rm(destination, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
  return { mode, outcome, finalSnapshot, termination };
}

async function parentMain(values) {
  const archivePath = requiredAbsolute(values.get("archive"), "--archive");
  const electronPath = requiredAbsolute(values.get("electron"), "--electron");
  const modulePath = requiredAbsolute(values.get("module"), "--module");
  const yauzlPath = requiredAbsolute(values.get("yauzl"), "--yauzl");
  const outputPath = values.get("output")
    ? requiredAbsolute(values.get("output"), "--output")
    : null;
  const timeoutMs = values.has("timeout-ms")
    ? parsePositiveInteger(values.get("timeout-ms"), "--timeout-ms")
    : DEFAULT_TIMEOUT_MS;
  if (!existsSync(archivePath))
    throw new Error("Runtime archive does not exist");
  if (!existsSync(electronPath))
    throw new Error("Electron executable does not exist");
  if (!existsSync(modulePath))
    throw new Error("packaged native module does not exist");
  if (!existsSync(yauzlPath)) throw new Error("yauzl module does not exist");
  const archiveMetadata = await stat(archivePath);
  const runRoot = await mkdtemp(
    path.join(tmpdir(), "aera-runtime-extraction-diagnostic-"),
  );
  const emit = makeEmitter(outputPath);
  emit("diagnostic-start", {
    platform: process.platform,
    architecture: process.arch,
    archiveBytes: archiveMetadata.size,
    variants: 2,
  });
  const results = [];
  try {
    // Run the sequential control first. If it cannot complete, the filesystem
    // itself is the leading boundary and a native run would add little value.
    results.push(
      await runVariant({
        mode: "yauzl",
        executable: electronPath,
        scriptPath: fileURLToPath(import.meta.url),
        archivePath,
        yauzlPath,
        root: runRoot,
        timeoutMs,
        emit,
        privateValues: [archivePath, electronPath, modulePath, yauzlPath],
      }),
    );
    results.push(
      await runVariant({
        mode: "native",
        executable: electronPath,
        scriptPath: fileURLToPath(import.meta.url),
        archivePath,
        modulePath,
        root: runRoot,
        timeoutMs,
        emit,
        privateValues: [archivePath, electronPath, modulePath, yauzlPath],
      }),
    );
  } finally {
    emit("diagnostic-complete", {
      results: results.map(({ mode, outcome, finalSnapshot }) => ({
        mode,
        outcome,
        ...finalSnapshot,
      })),
    });
    await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
  }
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
