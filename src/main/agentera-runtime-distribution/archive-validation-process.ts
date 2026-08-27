import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

import type { RuntimeManifest } from "./manifest";
import { RuntimeExtractionError } from "./inventory";

const HELPER_MARKER = "AGENTERA_RUNTIME_ARCHIVE_VALIDATION_HELPER";
// Keep archive and extracted-inventory evidence in the same bounded file so a
// single install attempt can be reconstructed without exposing process env.
const HELPER_DIAGNOSTIC_OUTPUT = "AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT";
const HELPER_ENVIRONMENT_KEYS = [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  HELPER_DIAGNOSTIC_OUTPUT,
] as const;

// Windows Defender and first-run filesystem work can delay metadata parsing,
// but the packaged parent must still have a finite, independently observable
// deadline for this helper.
export const WINDOWS_ARCHIVE_VALIDATION_TIMEOUT_MS = 8 * 60 * 1000;

export interface RuntimeArchiveValidationHelperRequest {
  schemaVersion?: 1;
  archivePath: string;
  manifest: RuntimeManifest;
  maxExtractedBytes: number;
  hostPlatform: NodeJS.Platform;
}

interface RuntimeArchiveValidationHelperExecutionOptions {
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface RuntimeArchiveValidationHelperExecutionResult {
  stdout: string;
  stderr: string;
}

export type RuntimeArchiveValidationHelperExecutor = (
  executable: string,
  arguments_: string[],
  options: RuntimeArchiveValidationHelperExecutionOptions,
) => Promise<RuntimeArchiveValidationHelperExecutionResult>;

interface RuntimeArchiveValidationHelperOptions {
  executablePath?: string;
  helperPath?: string;
  sourceEnvironment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  execute?: RuntimeArchiveValidationHelperExecutor;
}

function helperAbortError(): Error {
  const error = new Error("Runtime extraction was cancelled");
  error.name = "AbortError";
  return error;
}

function helperTimeoutError(): RuntimeExtractionError {
  return new RuntimeExtractionError(
    "isolated Runtime archive validation timed out",
  );
}

function isNativeTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  return (
    record.killed === true &&
    (record.signal === "SIGTERM" || record.code === "ETIMEDOUT")
  );
}

function runtimeArchiveProcessDiagnostic(
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

function executeRuntimeArchiveValidationHelper(
  executable: string,
  arguments_: string[],
  options: RuntimeArchiveValidationHelperExecutionOptions,
): Promise<RuntimeArchiveValidationHelperExecutionResult> {
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

export function shouldUseIsolatedRuntimeArchiveValidation(
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

export function buildRuntimeArchiveValidationHelperEnvironment(
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

export function resolveRuntimeArchiveValidationHelperPath(
  resourcesPath: string,
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  return (hostPlatform === "win32" ? win32 : { join }).join(
    resourcesPath,
    "runtime-archive-validation-helper",
    "runtime-archive-validation-helper.js",
  );
}

function defaultHelperPath(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (!resourcesPath) {
    throw new RuntimeExtractionError(
      "isolated Runtime archive validator is unavailable",
    );
  }
  return resolveRuntimeArchiveValidationHelperPath(resourcesPath);
}

function parseHelperResult(stdout: string): void {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new RuntimeExtractionError(
      "isolated Runtime archive validator returned an invalid result",
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
    Object.keys(record).some((key) => !["schemaVersion", "ok"].includes(key))
  ) {
    throw new RuntimeExtractionError(
      "isolated Runtime archive validator returned an invalid result",
    );
  }
}

export async function verifyRuntimeArchiveWithHelper(
  request: Omit<RuntimeArchiveValidationHelperRequest, "schemaVersion">,
  options: RuntimeArchiveValidationHelperOptions = {},
): Promise<void> {
  if (options.signal?.aborted) throw helperAbortError();
  const timeoutMs = options.timeoutMs ?? WINDOWS_ARCHIVE_VALIDATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RuntimeExtractionError(
      "isolated Runtime archive validation timeout is invalid",
    );
  }
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "aera-runtime-archive-validation-"),
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
    const execute = options.execute ?? executeRuntimeArchiveValidationHelper;
    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let executionPromise:
      | Promise<RuntimeArchiveValidationHelperExecutionResult>
      | undefined;
    let execution: RuntimeArchiveValidationHelperExecutionResult | undefined;
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
      if (options.signal?.aborted) onAbort();
      runtimeArchiveProcessDiagnostic(
        sourceEnvironment,
        "archive-helper-spawn-start",
        { timeoutMs },
      );
      executionStartedAt = Date.now();
      executionPromise = execute(
        options.executablePath ?? process.execPath,
        [options.helperPath ?? defaultHelperPath(), requestPath],
        {
          env: buildRuntimeArchiveValidationHelperEnvironment(
            sourceEnvironment,
          ),
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
      const races: Promise<
        RuntimeArchiveValidationHelperExecutionResult | never
      >[] = [executionPromise, timeoutPromise];
      if (externalAbortPromise) races.push(externalAbortPromise);
      execution = await Promise.race(races);
      if (options.signal?.aborted) throw helperAbortError();
      runtimeArchiveProcessDiagnostic(
        sourceEnvironment,
        "archive-helper-process-complete",
        {
          durationMs: Math.max(0, Date.now() - executionStartedAt),
          timeoutMs,
        },
      );
      if (!execution) {
        throw new RuntimeExtractionError(
          "isolated Runtime archive validation returned no result",
        );
      }
      parseHelperResult(execution.stdout);
      runtimeArchiveProcessDiagnostic(
        sourceEnvironment,
        "archive-helper-result-parsed",
        {
          durationMs: Math.max(0, Date.now() - executionStartedAt),
          timeoutMs,
        },
      );
    } catch (error) {
      // Node's execFile can settle its native timeout callback just before
      // the parent Promise.race timer. Preserve the timeout contract when
      // that platform-specific ordering exposes the killed child first.
      if (!externallyAborted && isNativeTimeoutError(error)) {
        timedOut = true;
      }
      const fields = {
        durationMs: Math.max(
          0,
          Date.now() - (executionStartedAt || Date.now()),
        ),
        timeoutMs,
      };
      if (timedOut) {
        runtimeArchiveProcessDiagnostic(
          sourceEnvironment,
          "archive-helper-timeout",
          fields,
        );
      } else if (externallyAborted) {
        runtimeArchiveProcessDiagnostic(
          sourceEnvironment,
          "archive-helper-cancelled",
          fields,
        );
      }
      runtimeArchiveProcessDiagnostic(
        sourceEnvironment,
        "archive-helper-process-failed",
        fields,
      );
      if (timedOut) throw helperTimeoutError();
      if (externallyAborted) throw helperAbortError();
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof RuntimeExtractionError) throw error;
      throw new RuntimeExtractionError(
        "isolated Runtime archive validation failed",
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
      if (timedOut || externallyAborted) {
        await Promise.race([
          executionPromise?.catch(() => undefined) ?? Promise.resolve(),
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}
