#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

/**
 * Diagnose the extraction-helper boundary from inside a real packaged Aera
 * main process.  The probe is evidence-only: it creates disposable
 * Runtime-shaped directories, starts the already-packaged helper, records its
 * bounded result, and removes the probe tree.  It never invokes start-install,
 * Gateway, signing, promotion, or release code.
 */

import { _electron as electron } from "playwright";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";

const HELPER_MARKER = "AGENTERA_RUNTIME_ARCHIVE_EXTRACTION_HELPER";
const DIAGNOSTIC_OUTPUT = "AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT";
const DEFAULT_TIMEOUT_MS = 90_000;

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
  if (typeof value !== "string" || !win32.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute Windows path`);
  }
  return value;
}

function redactedShape(value, privateValues = []) {
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

function emit(outputPath, event, fields = {}) {
  const line = `${JSON.stringify({
    schemaVersion: 1,
    event,
    timestampMs: Date.now(),
    ...fields,
  })}\n`;
  process.stdout.write(line);
  if (outputPath) appendFileSync(outputPath, line, "utf8");
}

function helperPath(resourcesPath) {
  return win32.join(
    resourcesPath,
    "runtime-archive-extraction-helper",
    "runtime-archive-extraction-helper.js",
  );
}

function makeProbeEnvironment(source) {
  const result = {
    ELECTRON_RUN_AS_NODE: "1",
    [HELPER_MARKER]: "1",
  };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const value = Object.entries(source ?? {}).find(
      ([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
    )?.[1];
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  return result;
}

async function runInApplication({
  app,
  archivePath,
  resourcesPath,
  noOpModulePath,
  timeoutMs,
}) {
  return app.evaluate(
    async ({ app: electronApp }, config) => {
      const fs = process.getBuiltinModule("node:fs/promises");
      const childProcess = process.getBuiltinModule("node:child_process");
      const electronModule = process.getBuiltinModule("electron");
      const pathModule = process.getBuiltinModule("node:path");
      const os = process.getBuiltinModule("node:os");
      const appUserData = electronApp.getPath("userData");
      const probeRoot = pathModule.join(
        appUserData,
        "runtime",
        "staging",
        `helper-boundary-probe-${process.pid}-${Date.now()}`,
      );
      const privateRoot = pathModule.join(probeRoot, "private");
      await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
      const variants = [
        {
          name: "app-user-data-noasar",
          noAsar: true,
          launchMode: "exec-file",
          moduleOverridePath: null,
          destinationRoot: probeRoot,
        },
        {
          name: "app-user-data-plain",
          noAsar: false,
          launchMode: "exec-file",
          moduleOverridePath: null,
          destinationRoot: probeRoot,
        },
        {
          name: "app-temp-noasar",
          noAsar: true,
          launchMode: "exec-file",
          moduleOverridePath: null,
          destinationRoot: pathModule.join(
            await fs.mkdtemp(
              pathModule.join(os.tmpdir(), "aera-app-temp-probe-"),
            ),
            "runtime",
          ),
        },
        {
          name: "app-user-data-noasar-noop",
          noAsar: true,
          launchMode: "exec-file",
          moduleOverridePath: config.noOpModulePath,
          destinationRoot: probeRoot,
        },
        {
          name: "app-user-data-noasar-utility",
          noAsar: true,
          launchMode: "utility-process",
          moduleOverridePath: null,
          destinationRoot: probeRoot,
        },
        {
          name: "app-user-data-noasar-spawn",
          noAsar: true,
          launchMode: "spawn",
          moduleOverridePath: null,
          destinationRoot: probeRoot,
        },
        {
          name: "app-user-data-noasar-exec-no-options",
          noAsar: true,
          launchMode: "exec-file-no-options",
          moduleOverridePath: null,
          destinationRoot: probeRoot,
        },
      ];
      const results = [];
      const previousNoAsar = process.noAsar;
      try {
        for (const variant of variants) {
          const variantRoot = pathModule.join(
            variant.destinationRoot,
            variant.name,
          );
          const destination = pathModule.join(
            variantRoot,
            "transaction",
            "payload.zip-extracting",
          );
          await fs.mkdir(destination, { recursive: true, mode: 0o700 });
          const requestDirectory = await fs.mkdtemp(
            pathModule.join(os.tmpdir(), "aera-runtime-helper-request-"),
          );
          const requestPath = pathModule.join(requestDirectory, "request.json");
          const eventsPath = pathModule.join(
            variantRoot,
            "helper-events.jsonl",
          );
          await fs.writeFile(
            requestPath,
            `${JSON.stringify({
              schemaVersion: 1,
              archivePath: config.archivePath,
              destination,
              hostPlatform: "win32",
            })}\n`,
            { flag: "wx", mode: 0o600 },
          );
          const environment = {
            ...config.helperEnvironment,
            [config.diagnosticOutputName]: eventsPath,
            ...(variant.moduleOverridePath
              ? {
                  AGENTERA_RUNTIME_EXTRACT_ZIP_MODULE_PATH:
                    variant.moduleOverridePath,
                }
              : {}),
          };
          process.noAsar = variant.noAsar;
          const startedAt = Date.now();
          const execution = await new Promise((resolve) => {
            let child;
            let settled = false;
            let timer;
            let stdout = "";
            let stderr = "";
            let utilityChild = false;
            const finish = (value) => {
              if (settled) return;
              settled = true;
              if (timer) clearTimeout(timer);
              resolve(value);
            };
            const terminate = () => {
              if (!child) return;
              if (utilityChild) {
                try {
                  child.kill();
                } catch {
                  // The bounded result below remains authoritative.
                }
                return;
              }
              if (child.exitCode !== null) return;
              try {
                child.kill();
              } catch {
                // The bounded result below remains authoritative.
              }
              try {
                childProcess.execFile(
                  "taskkill.exe",
                  ["/PID", String(child.pid), "/T", "/F"],
                  { windowsHide: true, timeout: 10_000 },
                  () => undefined,
                );
              } catch {
                // Best-effort diagnostic cleanup.
              }
            };
            const attachUtilityStreams = () => {
              child.stdout?.on("data", (chunk) => {
                stdout += String(chunk);
              });
              child.stderr?.on("data", (chunk) => {
                stderr += String(chunk);
              });
            };
            const complete = (errorCode, signal) => {
              finish({
                outcome: errorCode || signal ? "failed" : "complete",
                errorCode: errorCode ?? null,
                signal: signal ?? null,
                stdout: stdout.slice(-32_768),
                stderr: stderr.slice(-32_768),
                childPid: child?.pid ?? null,
                durationMs: Date.now() - startedAt,
              });
            };
            try {
              if (variant.launchMode === "utility-process") {
                utilityChild = true;
                child = electronModule.utilityProcess.fork(
                  config.helperPath,
                  [requestPath],
                  {
                    env: environment,
                    cwd: process.cwd(),
                    stdio: ["ignore", "pipe", "pipe"],
                    serviceName: "Aera Runtime extraction diagnostic",
                  },
                );
                attachUtilityStreams();
                child.once("spawn", attachUtilityStreams);
                child.once("error", (type, location, report) =>
                  finish({
                    outcome: "spawn-error",
                    errorCode: "utility-process-error",
                    signal: null,
                    stdout: stdout.slice(-32_768),
                    stderr: `${stderr}${String(type ?? "")} ${String(
                      location ?? "",
                    )} ${String(report ?? "")}`.slice(-32_768),
                    childPid: child?.pid ?? null,
                    durationMs: Date.now() - startedAt,
                  }),
                );
                child.once("exit", (code) =>
                  complete(code === 0 ? null : code, null),
                );
              } else if (variant.launchMode === "spawn") {
                child = childProcess.spawn(
                  process.execPath,
                  [config.helperPath, requestPath],
                  {
                    env: environment,
                    windowsHide: true,
                    stdio: ["ignore", "pipe", "pipe"],
                  },
                );
                child.stdout?.on("data", (chunk) => {
                  stdout += String(chunk);
                });
                child.stderr?.on("data", (chunk) => {
                  stderr += String(chunk);
                });
                child.once("error", (error) =>
                  finish({
                    outcome: "spawn-error",
                    errorCode: error?.code ?? "spawn-error",
                    signal: null,
                    stdout: stdout.slice(-32_768),
                    stderr: `${stderr}${String(error?.message ?? "")}`.slice(
                      -32_768,
                    ),
                    childPid: child?.pid ?? null,
                    durationMs: Date.now() - startedAt,
                  }),
                );
                child.once("close", (code, signal) =>
                  complete(code === 0 ? null : code, signal),
                );
              } else {
                const options = {
                  encoding: "utf8",
                  env: environment,
                  windowsHide: true,
                  maxBuffer: 64 * 1024,
                  ...(variant.launchMode === "exec-file"
                    ? {
                        timeout: config.timeoutMs,
                        killSignal: "SIGTERM",
                      }
                    : {}),
                };
                child = childProcess.execFile(
                  process.execPath,
                  [config.helperPath, requestPath],
                  options,
                  (error, output, errorOutput) => {
                    stdout = String(output ?? "");
                    stderr = String(errorOutput ?? "");
                    complete(error?.code ?? null, error?.signal ?? null);
                  },
                );
                child.once("error", (error) =>
                  finish({
                    outcome: "spawn-error",
                    errorCode: error?.code ?? "spawn-error",
                    signal: null,
                    stdout: stdout.slice(-32_768),
                    stderr: `${stderr}${String(error?.message ?? "")}`.slice(
                      -32_768,
                    ),
                    childPid: child?.pid ?? null,
                    durationMs: Date.now() - startedAt,
                  }),
                );
              }
              timer = setTimeout(() => {
                terminate();
                finish({
                  outcome: "timeout",
                  errorCode: "diagnostic-timeout",
                  signal: null,
                  stdout: "",
                  stderr: "",
                  childPid: child?.pid ?? null,
                  durationMs: Date.now() - startedAt,
                });
              }, config.timeoutMs + 2_000);
            } catch (error) {
              finish({
                outcome: "spawn-error",
                errorCode: error?.code ?? "spawn-error",
                signal: null,
                stdout: "",
                stderr: String(error?.message ?? ""),
                childPid: null,
                durationMs: Date.now() - startedAt,
              });
            }
          });
          const helperEvents = await (async () => {
            try {
              const bytes = await fs.readFile(eventsPath);
              return bytes
                .toString("utf8")
                .trim()
                .split(/\r?\n/u)
                .filter(Boolean)
                .map((line) => {
                  try {
                    return JSON.parse(line);
                  } catch {
                    return { event: "invalid-helper-event" };
                  }
                });
            } catch {
              return [];
            }
          })();
          results.push({
            name: variant.name,
            noAsar: variant.noAsar,
            launchMode: variant.launchMode,
            moduleOverride: Boolean(variant.moduleOverridePath),
            appUserDataLength: appUserData.length,
            appUserDataRoot: pathModule.parse(appUserData).root,
            destinationLength: destination.length,
            destinationRoot: pathModule.parse(destination).root,
            execution,
            helperEvents,
          });
          await fs
            .rm(requestDirectory, { recursive: true, force: true })
            .catch(() => undefined);
          await fs
            .rm(variantRoot, { recursive: true, force: true })
            .catch(() => undefined);
        }
      } finally {
        process.noAsar = previousNoAsar;
        await fs
          .rm(probeRoot, { recursive: true, force: true })
          .catch(() => undefined);
      }
      return {
        processPid: process.pid,
        execPathShape: pathModule.basename(process.execPath),
        resourcesPathLength: process.resourcesPath?.length ?? null,
        appUserDataLength: appUserData.length,
        appUserDataRoot: pathModule.parse(appUserData).root,
        results,
      };
    },
    {
      archivePath,
      helperPath: helperPath(resourcesPath),
      helperEnvironment: makeProbeEnvironment(process.env),
      diagnosticOutputName: DIAGNOSTIC_OUTPUT,
      noOpModulePath,
      timeoutMs,
    },
  );
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const electronPath = requiredAbsolute(values.get("electron"), "--electron");
  const resourcesPath = requiredAbsolute(
    values.get("resources"),
    "--resources",
  );
  const archivePath = requiredAbsolute(values.get("archive"), "--archive");
  const outputPath = requiredAbsolute(values.get("output"), "--output");
  const timeoutMs = values.has("timeout-ms")
    ? parsePositiveInteger(values.get("timeout-ms"), "--timeout-ms")
    : DEFAULT_TIMEOUT_MS;
  for (const [label, candidate] of [
    ["Electron executable", electronPath],
    ["resources directory", resourcesPath],
    ["Runtime archive", archivePath],
  ]) {
    if (!existsSync(candidate)) throw new Error(`${label} does not exist`);
  }
  const helper = helperPath(resourcesPath);
  if (!existsSync(helper))
    throw new Error("packaged extraction helper is missing");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, "", { flag: "w", mode: 0o600 });
  emit(outputPath, "app-diagnostic-start", {
    timeoutMs,
    variants: 7,
    helper: redactedShape(helper, [electronPath, resourcesPath, archivePath]),
  });
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "aera-runtime-app-boundary-"),
  );
  const userData = join(temporaryRoot, "user-data");
  const hermesHome = join(temporaryRoot, "hermes-home");
  const noOpModulePath = join(temporaryRoot, "runtime-extractor-noop.mjs");
  await writeFile(
    noOpModulePath,
    "export async function extract() {}\nexport default extract;\n",
    { flag: "wx", mode: 0o600 },
  );
  await mkdir(userData, { recursive: true, mode: 0o700 });
  await mkdir(hermesHome, { recursive: true, mode: 0o700 });
  let app = null;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [`--user-data-dir=${userData}`],
      cwd: dirname(electronPath),
      env: {
        ...process.env,
        AGENTERA_E2E_DIAGNOSTICS: "1",
        AGENTERA_RUNTIME_SEED_DIR: join(resourcesPath, "agentera-runtime-seed"),
        HERMES_HOME: hermesHome,
        HERMES_DISABLE_GPU: "1",
        HERMES_OPEN_DEVTOOLS: "0",
        HERMES_DESKTOP_OPEN_DEVTOOLS: "0",
        MAIN_VITE_AGENTERA_CLOUD_PUBLIC_URL: "https://127.0.0.1",
        MAIN_VITE_AGENTERA_OFFLINE_PUBLIC_KEYS_JSON:
          '{"issuer":"https://127.0.0.1","keys":[]}',
      },
    });
    await app.firstWindow();
    emit(outputPath, "app-window-ready");
    const result = await runInApplication({
      app,
      archivePath,
      resourcesPath,
      noOpModulePath,
      timeoutMs,
    });
    emit(outputPath, "app-diagnostic-result", {
      processPid: result.processPid,
      appUserDataLength: result.appUserDataLength,
      appUserDataRoot: result.appUserDataRoot,
      results: result.results,
    });
  } finally {
    if (app) await app.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
  emit(outputPath, "app-diagnostic-complete");
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}
