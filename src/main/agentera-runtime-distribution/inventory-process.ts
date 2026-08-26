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
export const WINDOWS_RUNTIME_INVENTORY_TIMEOUT_MS = 8 * 60 * 1000;
const HELPER_TERMINATION_GRACE_MS = 1_000;
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
  timeoutMs?: number;
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
  timeoutMs?: number;
  execute?: RuntimeInventoryHelperExecutor;
}

function helperAbortError(): Error {
  const error = new Error("Runtime extraction was cancelled");
  error.name = "AbortError";
  return error;
}

function helperTimeoutError(): RuntimeExtractionError {
  return new RuntimeExtractionError(
    "isolated Runtime inventory verification timed out",
  );
}

function runtimeInventoryProcessDiagnostic(
  sourceEnvironment: NodeJS.ProcessEnv,
  event: string,
  fields: Readonly<Record<string, number | string | boolean | null>> = {},
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
        ...fields,
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
        timeout: options.timeoutMs,
        killSignal: "SIGTERM",
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
  const timeoutMs = options.timeoutMs ?? WINDOWS_RUNTIME_INVENTORY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RuntimeExtractionError(
      "isolated Runtime inventory verification timeout is invalid",
    );
  }
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
    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let executionPromise:
      | Promise<RuntimeInventoryHelperExecutionResult>
      | undefined;
    let executionStartedAt = 0;
    let rejectExternalAbort: ((reason: Error) => void) | null = null;
    const externalAbortPromise = options.signal
      ? new Promise<never>((_, reject) => {
          rejectExternalAbort = reject;
        })
      : null;
    const onAbort = (): void => {
      externallyAborted = true;
      controller.abort();
      rejectExternalAbort?.(helperAbortError());
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      runtimeInventoryProcessDiagnostic(
        sourceEnvironment,
        "inventory-helper-spawn-start",
        { timeoutMs },
      );
      executionStartedAt = Date.now();
      executionPromise = execute(
        options.executablePath ?? process.execPath,
        [options.helperPath ?? defaultHelperPath(), requestPath],
        {
          env: buildRuntimeInventoryHelperEnvironment(sourceEnvironment),
          windowsHide: true,
          signal: controller.signal,
          timeoutMs,
        },
      );
      void executionPromise.catch(() => undefined);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(helperTimeoutError());
        }, timeoutMs);
      });
      const races: Promise<RuntimeInventoryHelperExecutionResult | never>[] = [
        executionPromise,
        timeoutPromise,
      ];
      if (externalAbortPromise) races.push(externalAbortPromise);
      const execution = await Promise.race(races);
      if (options.signal?.aborted) throw helperAbortError();
      runtimeInventoryProcessDiagnostic(
        sourceEnvironment,
        "inventory-helper-process-complete",
        {
          durationMs: Math.max(0, Date.now() - executionStartedAt),
          timeoutMs,
        },
      );
      const result = parseHelperResult(execution.stdout);
      runtimeInventoryProcessDiagnostic(
        sourceEnvironment,
        "inventory-helper-result-parsed",
        {
          durationMs: Math.max(0, Date.now() - executionStartedAt),
          timeoutMs,
          fileCount: result.fileCount,
          extractedBytes: result.extractedBytes,
        },
      );
      return result;
    } catch (error) {
      if (timedOut) {
        runtimeInventoryProcessDiagnostic(
          sourceEnvironment,
          "inventory-helper-timeout",
          {
            durationMs: Math.max(
              0,
              Date.now() - (executionStartedAt || Date.now()),
            ),
            timeoutMs,
          },
        );
      } else if (externallyAborted) {
        runtimeInventoryProcessDiagnostic(
          sourceEnvironment,
          "inventory-helper-cancelled",
          {
            durationMs: Math.max(
              0,
              Date.now() - (executionStartedAt || Date.now()),
            ),
            timeoutMs,
          },
        );
      } else {
        runtimeInventoryProcessDiagnostic(
          sourceEnvironment,
          "inventory-helper-process-failed",
          {
            durationMs: Math.max(
              0,
              Date.now() - (executionStartedAt || Date.now()),
            ),
            timeoutMs,
          },
        );
      }
      if (timedOut) throw helperTimeoutError();
      if (externallyAborted) throw helperAbortError();
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof RuntimeExtractionError) throw error;
      throw new RuntimeExtractionError(
        "isolated Runtime inventory verification failed",
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
      if (timedOut || externallyAborted) {
        await Promise.race([
          executionPromise?.catch(() => undefined) ?? Promise.resolve(),
          new Promise<void>((resolve) =>
            setTimeout(resolve, HELPER_TERMINATION_GRACE_MS),
          ),
        ]);
      }
    }
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
