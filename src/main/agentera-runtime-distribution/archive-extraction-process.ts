import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

import { RuntimeExtractionError } from "./inventory";

const HELPER_MARKER = "AGENTERA_RUNTIME_ARCHIVE_EXTRACTION_HELPER";
const HELPER_DIAGNOSTIC_OUTPUT = "AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT";
const HELPER_TERMINATION_GRACE_MS = 1_000;
const HELPER_ENVIRONMENT_KEYS = [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  HELPER_DIAGNOSTIC_OUTPUT,
] as const;

// A native ZIP extraction can be slowed substantially by Windows Defender and
// hosted-runner storage. Keep the operation bounded without making the
// normal macOS/Linux path or an explicit caller timeout more permissive.
export const WINDOWS_ARCHIVE_EXTRACTION_TIMEOUT_MS = 8 * 60 * 1000;

export interface RuntimeArchiveExtractionHelperRequest {
  schemaVersion?: 1;
  archivePath: string;
  destination: string;
  hostPlatform: NodeJS.Platform;
}

interface RuntimeArchiveExtractionHelperExecutionOptions {
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface RuntimeArchiveExtractionHelperExecutionResult {
  stdout: string;
  stderr: string;
}

export type RuntimeArchiveExtractionHelperExecutor = (
  executable: string,
  arguments_: string[],
  options: RuntimeArchiveExtractionHelperExecutionOptions,
) => Promise<RuntimeArchiveExtractionHelperExecutionResult>;

interface RuntimeArchiveExtractionHelperOptions {
  executablePath?: string;
  helperPath?: string;
  sourceEnvironment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  execute?: RuntimeArchiveExtractionHelperExecutor;
}

function helperAbortError(): Error {
  const error = new Error("Runtime extraction was cancelled");
  error.name = "AbortError";
  return error;
}

function helperTimeoutError(): RuntimeExtractionError {
  return new RuntimeExtractionError(
    "isolated Runtime archive extraction timed out",
  );
}

function runtimeArchiveExtractionDiagnostic(
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

function executeRuntimeArchiveExtractionHelper(
  executable: string,
  arguments_: string[],
  options: RuntimeArchiveExtractionHelperExecutionOptions,
): Promise<RuntimeArchiveExtractionHelperExecutionResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      executable,
      arguments_,
      {
        encoding: "utf8",
        env: options.env,
        windowsHide: options.windowsHide,
        signal: options.signal,
        // Keep a native child-process deadline in addition to the parent
        // Promise.race.  This makes the real helper terminate even when the
        // caller's AbortSignal is not observed by a platform-specific child
        // process implementation.
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

export function shouldUseIsolatedRuntimeArchiveExtraction(
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

export function buildRuntimeArchiveExtractionHelperEnvironment(
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

export function resolveRuntimeArchiveExtractionHelperPath(
  resourcesPath: string,
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  return (hostPlatform === "win32" ? win32 : { join }).join(
    resourcesPath,
    "runtime-archive-extraction-helper",
    "runtime-archive-extraction-helper.js",
  );
}

function defaultHelperPath(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (!resourcesPath) {
    throw new RuntimeExtractionError(
      "isolated Runtime archive extraction helper is unavailable",
    );
  }
  return resolveRuntimeArchiveExtractionHelperPath(resourcesPath);
}

function parseHelperResult(stdout: string): void {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new RuntimeExtractionError(
      "isolated Runtime archive extraction helper returned an invalid result",
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
      "isolated Runtime archive extraction helper returned an invalid result",
    );
  }
}

function validateRequest(
  request: Omit<RuntimeArchiveExtractionHelperRequest, "schemaVersion">,
): void {
  const absolute = (value: string): boolean =>
    request.hostPlatform === "win32"
      ? win32.isAbsolute(value)
      : isAbsolute(value);
  if (
    request.hostPlatform !== "win32" ||
    !absolute(request.archivePath) ||
    !absolute(request.destination)
  ) {
    throw new RuntimeExtractionError(
      "isolated Runtime archive extraction request is invalid",
    );
  }
}

export async function extractRuntimeArchiveWithHelper(
  request: Omit<RuntimeArchiveExtractionHelperRequest, "schemaVersion">,
  options: RuntimeArchiveExtractionHelperOptions = {},
): Promise<void> {
  if (options.signal?.aborted) throw helperAbortError();
  validateRequest(request);
  const timeoutMs = options.timeoutMs ?? WINDOWS_ARCHIVE_EXTRACTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RuntimeExtractionError(
      "isolated Runtime archive extraction timeout is invalid",
    );
  }
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "aera-runtime-archive-extraction-"),
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
    const execute = options.execute ?? executeRuntimeArchiveExtractionHelper;
    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let executionPromise:
      | Promise<RuntimeArchiveExtractionHelperExecutionResult>
      | undefined;
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
      runtimeArchiveExtractionDiagnostic(
        sourceEnvironment,
        "archive-extraction-helper-spawn-start",
      );
      executionPromise = execute(
        options.executablePath ?? process.execPath,
        [options.helperPath ?? defaultHelperPath(), requestPath],
        {
          env: buildRuntimeArchiveExtractionHelperEnvironment(
            sourceEnvironment,
          ),
          windowsHide: true,
          signal: controller.signal,
          timeoutMs,
        },
      );
      // The real execFile rejects when the signal is aborted.  The race also
      // protects the parent when a test double or a broken child ignores it.
      void executionPromise.catch(() => undefined);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(helperTimeoutError());
        }, timeoutMs);
      });
      const races: Promise<
        RuntimeArchiveExtractionHelperExecutionResult | never
      >[] = [executionPromise, timeoutPromise];
      if (externalAbortPromise) races.push(externalAbortPromise);
      const execution = await Promise.race(races);
      if (options.signal?.aborted) throw helperAbortError();
      runtimeArchiveExtractionDiagnostic(
        sourceEnvironment,
        "archive-extraction-helper-process-complete",
      );
      parseHelperResult(execution.stdout);
      runtimeArchiveExtractionDiagnostic(
        sourceEnvironment,
        "archive-extraction-helper-result-parsed",
      );
    } catch (error) {
      if (timedOut) {
        runtimeArchiveExtractionDiagnostic(
          sourceEnvironment,
          "archive-extraction-helper-timeout",
        );
      } else if (externallyAborted) {
        runtimeArchiveExtractionDiagnostic(
          sourceEnvironment,
          "archive-extraction-helper-cancelled",
        );
      }
      runtimeArchiveExtractionDiagnostic(
        sourceEnvironment,
        "archive-extraction-helper-process-failed",
      );
      if (timedOut) throw helperTimeoutError();
      if (externallyAborted) throw helperAbortError();
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof RuntimeExtractionError) throw error;
      throw new RuntimeExtractionError(
        "isolated Runtime archive extraction failed",
        { cause: error },
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
      if (timedOut || externallyAborted) {
        // The real execFile implementation receives controller.abort() and
        // normally settles immediately.  Keep a short bounded grace period
        // for Windows process teardown so a timed-out helper cannot linger
        // while its request directory is being removed.  Test doubles or a
        // broken child cannot extend the parent operation indefinitely.
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
