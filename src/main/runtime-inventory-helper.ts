import { appendFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { verifyExtractedRuntimeInventoryInProcess } from "./agentera-runtime-distribution/inventory";
import {
  canonicalJsonBytes,
  parseRuntimeManifest,
  type RuntimeManifest,
} from "./agentera-runtime-distribution/manifest";

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const DIAGNOSTIC_OUTPUT = "AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT";
const EXPECTED_REQUEST_FIELDS = new Set([
  "schemaVersion",
  "destination",
  "manifest",
  "maxExtractedBytes",
  "hostPlatform",
]);

interface RuntimeInventoryHelperRequest {
  schemaVersion: 1;
  destination: string;
  manifest: RuntimeManifest;
  maxExtractedBytes: number;
  hostPlatform: NodeJS.Platform;
}

function helperDiagnostic(
  event: string,
  fields: Readonly<Record<string, number | string | boolean | null>> = {},
): void {
  const outputPath = process.env[DIAGNOSTIC_OUTPUT]?.trim();
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

function parseRequest(value: unknown): RuntimeInventoryHelperRequest {
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
    typeof candidate.destination !== "string" ||
    !isAbsolute(candidate.destination) ||
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
    destination: candidate.destination,
    manifest: parseRuntimeManifest(canonicalJsonBytes(candidate.manifest)),
    maxExtractedBytes: candidate.maxExtractedBytes as number,
    hostPlatform: "win32",
  };
}

async function main(): Promise<void> {
  helperDiagnostic("inventory-helper-main-start");
  if (
    process.env.AGENTERA_RUNTIME_INVENTORY_HELPER !== "1" ||
    process.argv.length !== 3
  ) {
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
  helperDiagnostic("inventory-helper-request-complete");
  helperDiagnostic("inventory-walk-hash-start");
  const startedAt = Date.now();
  const result = await verifyExtractedRuntimeInventoryInProcess(
    request.destination,
    request.manifest,
    request.maxExtractedBytes,
    undefined,
    request.hostPlatform,
  );
  helperDiagnostic("inventory-walk-hash-complete", {
    durationMs: Math.max(0, Date.now() - startedAt),
    fileCount: result.fileCount,
    extractedBytes: result.extractedBytes,
  });
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, ok: true, ...result })}\n`,
  );
  helperDiagnostic("inventory-helper-result-written");
}

void main().catch(() => {
  helperDiagnostic("inventory-helper-failed");
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      ok: false,
      errorCode: "runtime_inventory_verification_failed",
    })}\n`,
  );
  process.exitCode = 1;
});
