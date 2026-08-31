import { appendFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isAbsolute, join, win32 } from "node:path";

const HELPER_MARKER = "AGENTERA_RUNTIME_ARCHIVE_EXTRACTION_HELPER";
const DIAGNOSTIC_OUTPUT = "AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT";
const MAX_REQUEST_BYTES = 32 * 1024;
const EXPECTED_REQUEST_FIELDS = new Set([
  "schemaVersion",
  "archivePath",
  "destination",
  "hostPlatform",
]);

interface RuntimeArchiveExtractionHelperRequest {
  schemaVersion: 1;
  archivePath: string;
  destination: string;
  hostPlatform: "win32";
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

function parseRequest(value: unknown): RuntimeArchiveExtractionHelperRequest {
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
    !win32.isAbsolute(candidate.archivePath) ||
    typeof candidate.destination !== "string" ||
    !win32.isAbsolute(candidate.destination) ||
    candidate.hostPlatform !== "win32"
  ) {
    throw new Error("invalid request");
  }
  return {
    schemaVersion: 1,
    archivePath: candidate.archivePath,
    destination: candidate.destination,
    hostPlatform: "win32",
  };
}

function packagedExtractZipModulePath(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (!resourcesPath)
    throw new Error("packaged Runtime extractor is unavailable");
  return join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@electron-internal",
    "extract-zip",
    "index.js",
  );
}

async function loadExtractor(): Promise<
  (archivePath: string, options: { dir: string }) => Promise<void>
> {
  const modulePath =
    process.env.AGENTERA_RUNTIME_EXTRACT_ZIP_MODULE_PATH?.trim() ||
    packagedExtractZipModulePath();
  const module = (await import(
    /* @vite-ignore */ pathToFileURL(modulePath).href
  )) as {
    extract?: (archivePath: string, options: { dir: string }) => Promise<void>;
    default?: (archivePath: string, options: { dir: string }) => Promise<void>;
  };
  const extract = module.extract ?? module.default;
  if (!extract) throw new Error("packaged Runtime extractor is unavailable");
  return extract;
}

async function main(): Promise<void> {
  helperDiagnostic("archive-extraction-helper-main-start");
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
  helperDiagnostic("archive-extraction-helper-request-complete");
  const destinationMetadata = await stat(request.destination);
  if (!destinationMetadata.isDirectory()) {
    throw new Error("invalid extraction destination");
  }
  helperDiagnostic("archive-extraction-helper-load-start");
  const extract = await loadExtractor();
  helperDiagnostic("archive-extraction-helper-load-complete");
  const startedAt = Date.now();
  helperDiagnostic("archive-extraction-helper-extract-start");
  const heartbeat = setInterval(() => {
    helperDiagnostic("archive-extraction-helper-extract-heartbeat", {
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  }, 5_000);
  heartbeat.unref?.();
  try {
    await extract(request.archivePath, { dir: request.destination });
  } finally {
    clearInterval(heartbeat);
  }
  helperDiagnostic("archive-extraction-helper-result-written", {
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  process.stdout.write('{"schemaVersion":1,"ok":true}\n');
}

void main().catch(() => {
  helperDiagnostic("archive-extraction-helper-failed");
  process.stdout.write(
    '{"schemaVersion":1,"ok":false,"errorCode":"runtime_archive_extraction_failed"}\n',
  );
  process.exitCode = 1;
});
