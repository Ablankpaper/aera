import { createHash } from "node:crypto";

export type RuntimeInventoryDiagnosticErrorClass =
  | "access-denied"
  | "aborted"
  | "already-exists"
  | "budget-exceeded"
  | "filesystem-unavailable"
  | "hash-mismatch"
  | "invalid"
  | "kind-mismatch"
  | "not-directory"
  | "not-found"
  | "size-mismatch"
  | "timeout"
  | "unexpected-path"
  | "unknown";

export interface RuntimeInventoryDiagnosticErrorFields {
  errorName: string;
  errorCode: string | null;
  errorMessageClass: RuntimeInventoryDiagnosticErrorClass;
  errorMessageLength: number;
  errorMessageSha256: string;
}

const SAFE_LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "");
}

function errorName(error: unknown): string {
  const value =
    error && typeof error === "object"
      ? (error as { name?: unknown }).name
      : undefined;
  return typeof value === "string" && SAFE_LABEL_PATTERN.test(value)
    ? value
    : "unknown";
}

function errorCode(error: unknown): string | null {
  const value =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof value === "string" && SAFE_ERROR_CODE_PATTERN.test(value)
    ? value
    : null;
}

function classifyErrorMessage(
  message: string,
  code: string | null,
): RuntimeInventoryDiagnosticErrorClass {
  if (code === "EACCES" || code === "EPERM") return "access-denied";
  if (code === "ENOENT") return "not-found";
  if (code === "ENOTDIR") return "not-directory";
  if (code === "EEXIST") return "already-exists";
  const normalized = message.toLowerCase();
  if (/aborted|cancelled|canceled/u.test(normalized)) return "aborted";
  if (/timed? out|timeout/u.test(normalized)) return "timeout";
  if (/permission denied|access is denied/u.test(normalized)) {
    return "access-denied";
  }
  if (/no such file|not found|does not exist/u.test(normalized)) {
    return "not-found";
  }
  if (/not a directory/u.test(normalized)) return "not-directory";
  if (/already exists/u.test(normalized)) return "already-exists";
  if (/unexpected path/u.test(normalized)) return "unexpected-path";
  if (/kind differs|special file/u.test(normalized)) return "kind-mismatch";
  if (/hash differs/u.test(normalized)) return "hash-mismatch";
  if (/size differs|byte count differs/u.test(normalized)) {
    return "size-mismatch";
  }
  if (/exceeds.*budget/u.test(normalized)) return "budget-exceeded";
  if (/filesystem.*unavailable/u.test(normalized)) {
    return "filesystem-unavailable";
  }
  if (/invalid|unsupported|must be|canonical/u.test(normalized)) {
    return "invalid";
  }
  return "unknown";
}

/**
 * Return bounded, path-free identity for a helper failure.
 *
 * The raw error text is intentionally never returned.  A short semantic
 * class, byte length, and SHA-256 fingerprint let diagnostics distinguish
 * failures without copying local paths, request contents, or credentials.
 */
export function runtimeInventoryDiagnosticErrorFields(
  error: unknown,
): RuntimeInventoryDiagnosticErrorFields {
  const message = errorMessage(error);
  const code = errorCode(error);
  return {
    errorName: errorName(error),
    errorCode: code,
    errorMessageClass: classifyErrorMessage(message, code),
    errorMessageLength: Buffer.byteLength(message, "utf8"),
    errorMessageSha256: createHash("sha256")
      .update(message, "utf8")
      .digest("hex"),
  };
}
