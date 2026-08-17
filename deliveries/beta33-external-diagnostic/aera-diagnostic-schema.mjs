/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { safeRelativeName } from "./aera-diagnostic-core.mjs";

const SHA256 = /^[0-9a-f]{64}$/i;
const SOURCE_SHA = /^[0-9a-f]{40,64}$/i;
const CAPTURE_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export const REQUIRED_DIAGNOSTIC_SECTIONS = Object.freeze([
  "target",
  "process",
  "pid_continuity",
  "network",
  "dns_routes",
  "open_files",
  "signature",
  "quarantine",
  "environment",
  "native_abi",
  "runtime_logs",
  "unified_log",
  "platform_events",
  "database",
  "journal",
  "model_chain",
  "managed_files",
  "backups",
  "model_comparison",
  "route_catalog",
  "owner",
  "cloud_origin",
  "main_events",
  "preload_events",
  "renderer_events",
  "runtime_events",
  "owner_events",
  "updater_events",
  "updater",
  "main_renderer_ipc",
  "redaction",
]);
const DIAGNOSTIC_SECTION_NAMES = new Set(REQUIRED_DIAGNOSTIC_SECTIONS);

const TARGET_FIELDS = new Set([
  "schemaVersion",
  "platform",
  "version",
  "bundleId",
  "applicationId",
  "architecture",
  "executableSha256",
  "packageSha256",
  "artifactSha256",
  "appAsarSha256",
  "mainSha256",
  "preloadSha256",
  "rendererSha256",
  "sourceSha",
  "candidateManifestSha256",
  "bindingStatus",
]);

const BUNDLE_FIELDS = new Set([
  "schemaVersion",
  "collectorVersion",
  "captureId",
  "target",
  "startedAt",
  "endedAt",
  "sections",
  "missingEvidence",
  "files",
  "platform",
  "mode",
  "finishReason",
  "reproductionConfirmed",
  "processContinuityConfirmed",
  "internal_stage_visibility",
  "redaction",
]);

const REDACTION_FIELDS = new Set([
  "schemaVersion",
  "finalScan",
  "replacements",
  "dropped",
  "truncated",
]);

function assertClosedObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!fields.has(key))
      throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function assertString(value, label, maximum = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`${label} is invalid`);
}

function assertSha(value, label) {
  if (!SHA256.test(String(value || "")))
    throw new Error(`${label} must be SHA-256`);
}

function assertIso(value, label) {
  assertString(value, label, 64);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new Error(`${label} must be canonical ISO time`);
}

export function parseDiagnosticTargetV1(input) {
  assertClosedObject(input, TARGET_FIELDS, "target");
  if (input.schemaVersion !== 1)
    throw new Error("target schemaVersion must be 1");
  if (!new Set(["darwin", "win32"]).has(input.platform))
    throw new Error("target platform is invalid");
  assertString(input.version, "target version", 128);
  const identity = input.bundleId ?? input.applicationId;
  assertString(identity, "target application identity", 256);
  if (!new Set(["arm64", "x64"]).has(input.architecture))
    throw new Error("target architecture is invalid");
  assertSha(input.executableSha256, "target executableSha256");
  assertSha(input.packageSha256, "target packageSha256");
  if (!SOURCE_SHA.test(String(input.sourceSha || "")))
    throw new Error("target sourceSha is invalid");
  assertSha(input.candidateManifestSha256, "target candidateManifestSha256");
  for (const field of [
    "artifactSha256",
    "appAsarSha256",
    "mainSha256",
    "preloadSha256",
    "rendererSha256",
  ]) {
    if (input[field] != null) assertSha(input[field], `target ${field}`);
  }
  if (input.bindingStatus != null) {
    if (
      !new Set(["runtime-unbound", "candidate-bound"]).has(input.bindingStatus)
    )
      throw new Error("target bindingStatus is invalid");
  }
  return input;
}

export function validateDiagnosticBundleV4(input) {
  assertClosedObject(input, BUNDLE_FIELDS, "bundle");
  if (input.schemaVersion !== 4)
    throw new Error("bundle schemaVersion must be 4");
  assertString(input.collectorVersion, "collectorVersion", 64);
  if (!CAPTURE_ID.test(String(input.captureId || "")))
    throw new Error("captureId is invalid");
  parseDiagnosticTargetV1(input.target);
  assertIso(input.startedAt, "startedAt");
  assertIso(input.endedAt, "endedAt");
  if (Date.parse(input.endedAt) < Date.parse(input.startedAt))
    throw new Error("endedAt precedes startedAt");
  if (!Array.isArray(input.sections))
    throw new Error("sections must be an array");
  if (!Array.isArray(input.missingEvidence))
    throw new Error("missingEvidence must be an array");
  if (!Array.isArray(input.files)) throw new Error("files must be an array");
  assertClosedObject(input.redaction, REDACTION_FIELDS, "redaction");
  if (input.redaction.schemaVersion !== 1)
    throw new Error("redaction schemaVersion must be 1");
  if (input.redaction.finalScan !== "passed")
    throw new Error("redaction finalScan must be passed");
  for (const field of ["replacements", "dropped", "truncated"]) {
    if (
      !Number.isSafeInteger(input.redaction[field]) ||
      input.redaction[field] < 0
    )
      throw new Error(`redaction ${field} is invalid`);
  }
  if (
    input.platform != null &&
    !new Set(["darwin", "win32"]).has(input.platform)
  )
    throw new Error("bundle platform is invalid");
  if (input.mode != null && !new Set(["external", "internal"]).has(input.mode))
    throw new Error("bundle mode is invalid");
  if (
    input.internal_stage_visibility != null &&
    input.internal_stage_visibility !== "external_only"
  )
    throw new Error("internal_stage_visibility is invalid");

  const sectionNames = new Set();
  const missing = new Set(input.missingEvidence);
  for (const section of input.sections) {
    assertClosedObject(
      section,
      new Set(["name", "status", "reason"]),
      "section",
    );
    assertString(section.name, "section name", 128);
    if (!DIAGNOSTIC_SECTION_NAMES.has(section.name))
      throw new Error(`unknown section: ${section.name}`);
    if (sectionNames.has(section.name))
      throw new Error(`duplicate section: ${section.name}`);
    sectionNames.add(section.name);
    if (!new Set(["collected", "missing", "failed"]).has(section.status))
      throw new Error(`section status is invalid: ${section.name}`);
    if (section.status === "collected") {
      if (section.reason !== null)
        throw new Error(
          `collected section must have null reason: ${section.name}`,
        );
    } else {
      assertString(section.reason, `section reason: ${section.name}`, 128);
      if (!missing.has(section.name))
        throw new Error(`missingEvidence lacks section: ${section.name}`);
    }
  }
  for (const name of missing) {
    if (!sectionNames.has(name))
      throw new Error(`missingEvidence names unknown section: ${name}`);
    const section = input.sections.find((entry) => entry.name === name);
    if (section.status === "collected")
      throw new Error(`missingEvidence includes collected section: ${name}`);
  }
  for (const name of REQUIRED_DIAGNOSTIC_SECTIONS) {
    if (!sectionNames.has(name))
      throw new Error(`bundle lacks required section: ${name}`);
  }

  const filenames = new Set();
  for (const file of input.files) {
    assertClosedObject(file, new Set(["name", "size", "sha256"]), "file");
    let safeName;
    try {
      safeName = safeRelativeName(file.name);
    } catch {
      throw new Error("file filename is unsafe");
    }
    if (filenames.has(safeName)) throw new Error(`duplicate file: ${safeName}`);
    filenames.add(safeName);
    if (!Number.isSafeInteger(file.size) || file.size < 0)
      throw new Error(`file size is invalid: ${safeName}`);
    assertSha(file.sha256, `file sha256: ${safeName}`);
  }
  return input;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort())
      result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

export function canonicalDiagnosticJson(value) {
  return JSON.stringify(canonicalize(value));
}
