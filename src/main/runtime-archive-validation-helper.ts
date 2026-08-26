import { appendFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  canonicalJsonBytes,
  parseRuntimeManifest,
  type RuntimeManifest,
} from "./agentera-runtime-distribution/manifest";
import {
  validateRuntimeZipArchive,
  type RuntimeArchiveValidationDiagnostic,
} from "./agentera-runtime-distribution/archive-validation";

const HELPER_MARKER = "AGENTERA_RUNTIME_ARCHIVE_VALIDATION_HELPER";
const DIAGNOSTIC_OUTPUT = "AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT";
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const EXPECTED_REQUEST_FIELDS = new Set([
  "schemaVersion",
  "archivePath",
  "manifest",
  "maxExtractedBytes",
  "hostPlatform",
]);

interface RuntimeArchiveValidationHelperRequest {
  schemaVersion: 1;
  archivePath: string;
  manifest: RuntimeManifest;
  maxExtractedBytes: number;
  hostPlatform: "win32";
}

function helperDiagnostic(
  event:
    | "archive-helper-main-start"
    | "archive-helper-request-complete"
    | "archive-helper-result-written"
    | "archive-helper-failed"
    | RuntimeArchiveValidationDiagnostic,
  fields: Readonly<Record<string, number | string | boolean | null>> = {},
): void {
  const outputPath = process.env[DIAGNOSTIC_OUTPUT]?.trim();
  if (!outputPath || !isAbsolute(outputPath)) return;
  try {
    appendFileSync(
      outputPath,
      `${JSON.stringify({
        schemaVersion: 1,
        ...(typeof event === "string" ? { event, ...fields } : event),
        timestampMs: Date.now(),
        pid: process.pid,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Diagnostic evidence must never change Runtime installation behavior.
  }
}

function parseRequest(value: unknown): RuntimeArchiveValidationHelperRequest {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !EXPECTED_REQUEST_FIELDS.has(key))
  ) {
    throw new Error("invalid request");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.archivePath !== "string" ||
    !isAbsolute(candidate.archivePath) ||
    candidate.hostPlatform !== "win32" ||
    !Number.isSafeInteger(candidate.maxExtractedBytes) ||
    (candidate.maxExtractedBytes as number) < 0 ||
    !candidate.manifest ||
    typeof candidate.manifest !== "object" ||
    Array.isArray(candidate.manifest)
  ) {
    throw new Error("invalid request");
  }
  return {
    schemaVersion: 1,
    archivePath: candidate.archivePath,
    manifest: parseRuntimeManifest(canonicalJsonBytes(candidate.manifest)),
    maxExtractedBytes: candidate.maxExtractedBytes as number,
    hostPlatform: "win32",
  };
}

async function main(): Promise<void> {
  helperDiagnostic("archive-helper-main-start");
  if (process.env[HELPER_MARKER] !== "1" || process.argv.length !== 3) {
    throw new Error("invalid invocation");
  }
  const requestPath = process.argv[2];
  const metadata = await stat(requestPath);
  if (
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > MAX_REQUEST_BYTES
  ) {
    throw new Error("invalid request");
  }
  const request = parseRequest(
    JSON.parse(await readFile(requestPath, "utf8")) as unknown,
  );
  helperDiagnostic("archive-helper-request-complete");
  await validateRuntimeZipArchive(
    request.archivePath,
    request.manifest,
    request.maxExtractedBytes,
    undefined,
    undefined,
    helperDiagnostic,
  );
  process.stdout.write('{"schemaVersion":1,"ok":true}\n');
  helperDiagnostic("archive-helper-result-written");
}

void main().catch(() => {
  helperDiagnostic("archive-helper-failed");
  process.stdout.write(
    '{"schemaVersion":1,"ok":false,"errorCode":"runtime_archive_validation_failed"}\n',
  );
  process.exitCode = 1;
});
