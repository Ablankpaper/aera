import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

import type { RuntimeManifest } from "./manifest";
import {
  RuntimeExtractionError,
  verifyExtractedRuntimeInventoryInProcess,
  type RuntimeExtractionResult,
} from "./inventory";

const HELPER_MARKER = "AGENTERA_RUNTIME_INVENTORY_HELPER";
const HELPER_DIAGNOSTIC_OUTPUT = "AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT";
const HELPER_ENVIRONMENT_KEYS = [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  HELPER_DIAGNOSTIC_OUTPUT,
] as const;

export interface RuntimeInventoryHelperRequest {
  schemaVersion?: 1;
  destination: string;
  manifest: RuntimeManifest;
  maxExtractedBytes: number;
  hostPlatform: NodeJS.Platform;
}

interface RuntimeInventoryHelperExecutionOptions {
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  signal?: AbortSignal;
}

interface RuntimeInventoryHelperExecutionResult {
  stdout: string;
  stderr: string;
}

export type RuntimeInventoryHelperExecutor = (
  executable: string,
  arguments_: string[],
  options: RuntimeInventoryHelperExecutionOptions,
) => Promise<RuntimeInventoryHelperExecutionResult>;

interface RuntimeInventoryHelperOptions {
  executablePath?: string;
  helperPath?: string;
  sourceEnvironment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  execute?: RuntimeInventoryHelperExecutor;
}

function helperAbortError(): Error {
  const error = new Error("Runtime extraction was cancelled");
  error.name = "AbortError";
  return error;
}

function runtimeInventoryProcessDiagnostic(
  sourceEnvironment: NodeJS.ProcessEnv,
  event: string,
): void {
  const outputPath = sourceEnvironment[HELPER_DIAGNOSTIC_OUTPUT]?.trim();
  if (!outputPath || !isAbsolute(outputPath)) return;
  try {
    appendFileSync(
      outputPath,
      `${JSON.stringify({
        schemaVersion: 1,
        event,
        timestampMs: Date.now(),
        pid: process.pid,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Diagnostic evidence must never change Runtime installation behavior.
  }
}

function executeRuntimeInventoryHelper(
  executable: string,
  arguments_: string[],
  options: RuntimeInventoryHelperExecutionOptions,
): Promise<RuntimeInventoryHelperExecutionResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      executable,
      arguments_,
      {
        encoding: "utf8",
        env: options.env,
        windowsHide: options.windowsHide,
        signal: options.signal,
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

export function shouldUseIsolatedRuntimeInventory(
  hostPlatform: NodeJS.Platform = process.platform,
  electronVersion: string | undefined = process.versions.electron,
  helperMode: boolean = process.env[HELPER_MARKER] === "1",
  packaged: boolean = (process as NodeJS.Process & { defaultApp?: boolean })
    .defaultApp !== true,
): boolean {
  return (
    hostPlatform === "win32" &&
    Boolean(electronVersion) &&
    !helperMode &&
    packaged
  );
}

export function buildRuntimeInventoryHelperEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: "1",
    [HELPER_MARKER]: "1",
  };
  for (const key of HELPER_ENVIRONMENT_KEYS) {
    const value = sourceEnvironment[key];
    if (value) result[key] = value;
  }
  return result;
}

export function resolveRuntimeInventoryHelperPath(
  resourcesPath: string,
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  return (hostPlatform === "win32" ? win32 : { join }).join(
    resourcesPath,
    "runtime-inventory-helper",
    "runtime-inventory-helper.js",
  );
}

function defaultHelperPath(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (!resourcesPath) {
    throw new RuntimeExtractionError(
      "isolated Runtime inventory helper is unavailable",
    );
  }
  return resolveRuntimeInventoryHelperPath(resourcesPath);
}

function parseHelperResult(stdout: string): RuntimeExtractionResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new RuntimeExtractionError(
      "isolated Runtime inventory helper returned an invalid result",
    );
  }
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.ok !== true ||
    !Number.isSafeInteger(record.fileCount) ||
    (record.fileCount as number) < 0 ||
    !Number.isSafeInteger(record.extractedBytes) ||
    (record.extractedBytes as number) < 0 ||
    Object.keys(record ?? {}).some(
      (key) =>
        !["schemaVersion", "ok", "fileCount", "extractedBytes"].includes(key),
    )
  ) {
    throw new RuntimeExtractionError(
      "isolated Runtime inventory helper returned an invalid result",
    );
  }
  return {
    fileCount: record.fileCount as number,
    extractedBytes: record.extractedBytes as number,
  };
}

export async function verifyRuntimeInventoryWithHelper(
  request: Omit<RuntimeInventoryHelperRequest, "schemaVersion">,
  options: RuntimeInventoryHelperOptions = {},
): Promise<RuntimeExtractionResult> {
  if (options.signal?.aborted) throw helperAbortError();
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "aera-runtime-inventory-"),
  );
  const requestPath = join(temporaryDirectory, "request.json");
  const sourceEnvironment = options.sourceEnvironment ?? process.env;
  try {
    if (options.signal?.aborted) throw helperAbortError();
    await writeFile(
      requestPath,
      `${JSON.stringify({ schemaVersion: 1, ...request })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const execute = options.execute ?? executeRuntimeInventoryHelper;
    let execution: RuntimeInventoryHelperExecutionResult;
    try {
      runtimeInventoryProcessDiagnostic(
        sourceEnvironment,
        "helper-spawn-start",
      );
      execution = await execute(
        options.executablePath ?? process.execPath,
        [options.helperPath ?? defaultHelperPath(), requestPath],
        {
          env: buildRuntimeInventoryHelperEnvironment(sourceEnvironment),
          windowsHide: true,
          signal: options.signal,
        },
      );
      runtimeInventoryProcessDiagnostic(
        sourceEnvironment,
        "helper-process-complete",
      );
    } catch (error) {
      runtimeInventoryProcessDiagnostic(
        sourceEnvironment,
        "helper-process-failed",
      );
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new RuntimeExtractionError(
        "isolated Runtime inventory verification failed",
      );
    }
    const result = parseHelperResult(execution.stdout);
    runtimeInventoryProcessDiagnostic(
      sourceEnvironment,
      "helper-result-parsed",
    );
    return result;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

export async function verifyExtractedRuntimeInventory(
  destination: string,
  manifest: RuntimeManifest,
  maxExtractedBytes: number,
  signal?: AbortSignal,
  hostPlatform: NodeJS.Platform = process.platform,
): Promise<RuntimeExtractionResult> {
  if (shouldUseIsolatedRuntimeInventory(hostPlatform)) {
    return verifyRuntimeInventoryWithHelper(
      { destination, manifest, maxExtractedBytes, hostPlatform },
      { signal },
    );
  }
  return verifyExtractedRuntimeInventoryInProcess(
    destination,
    manifest,
    maxExtractedBytes,
    signal,
    hostPlatform,
  );
}
