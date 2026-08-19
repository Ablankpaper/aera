#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalJSONStringify } from "./manifest.mjs";

export const BETA33_TARGET_VERSION = "0.7.4-internal-beta.33";
const SIGNING_STATUS = "macos_developer_id_notarized_windows_authenticode";
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIAGNOSTIC_ID = /^[0-9a-f]{12}$/u;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const DEFAULT_SCHEMA = fileURLToPath(
  new URL("./beta33-acceptance-schema.json", import.meta.url),
);

export const BETA33_ACCEPTANCE_SCENARIOS = Object.freeze([
  "macos_beta29_manual_bridge",
  "macos_beta31_online_update",
  "macos_beta32_online_update",
  "windows_beta31_online_update",
  "windows_beta32_online_update",
  "macos_health_failure_rollback",
  "windows_health_failure_rollback",
]);

const TOP_LEVEL_FIELDS = [
  "schemaVersion",
  "status",
  "candidate",
  "scenarios",
  "completedAt",
];
const CANDIDATE_FIELDS = [
  "repository",
  "sourceSha",
  "version",
  "manifestSha256",
];
const SCENARIO_FIELDS = [
  "platform",
  "architecture",
  "environment",
  "sourceVersion",
  "targetVersion",
  "method",
  "installedArtifact",
  "executableSha256",
  "protectedUserDataBeforeSha256",
  "protectedUserDataAfterSha256",
  "startupPassed",
  "modelSavePassed",
  "startedAt",
  "completedAt",
  "operationId",
  "diagnosticId",
  "timeline",
  "evidenceFileDigests",
];
const EVENT_FIELDS = [
  "at",
  "schemaVersion",
  "operationId",
  "stage",
  "state",
  "code",
  "retryability",
  "diagnosticId",
  "targetVersion",
];
const SUCCESS_SEQUENCE = Object.freeze([
  ["metadata", "started"],
  ["metadata", "succeeded"],
  ["verify", "started"],
  ["verify", "succeeded"],
  ["download", "started"],
  ["download", "succeeded"],
  ["verify", "started"],
  ["verify", "succeeded"],
  ["extract", "started"],
  ["extract", "succeeded"],
  ["stage", "started"],
  ["stage", "succeeded"],
  ["swap", "started"],
  ["swap", "succeeded"],
  ["launch", "started"],
  ["launch", "succeeded"],
  ["health", "started"],
  ["health", "succeeded"],
  ["finalize", "started"],
  ["finalize", "succeeded"],
]);
const ROLLBACK_SEQUENCE = Object.freeze([
  ...SUCCESS_SEQUENCE.slice(0, -4),
  ["health", "started"],
  ["health", "failed", "update_health_timeout", "after_restart"],
  ["rollback", "started"],
  ["rollback", "rolled_back", "update_health_timeout", "after_restart"],
]);

const SCENARIO_POLICY = Object.freeze({
  macos_beta29_manual_bridge: Object.freeze({
    platform: "darwin",
    architecture: "arm64",
    environment: "physical",
    sourceVersion: "0.7.4-internal-beta.29",
    method: "manual_dmg_bridge",
    artifactKind: "dmg",
    sequence: null,
  }),
  macos_beta31_online_update: Object.freeze({
    platform: "darwin",
    architecture: "arm64",
    environment: "physical",
    sourceVersion: "0.7.4-internal-beta.31",
    method: "online_update",
    artifactKind: "zip",
    sequence: SUCCESS_SEQUENCE,
  }),
  macos_beta32_online_update: Object.freeze({
    platform: "darwin",
    architecture: "arm64",
    environment: "physical",
    sourceVersion: "0.7.4-internal-beta.32",
    method: "online_update",
    artifactKind: "zip",
    sequence: SUCCESS_SEQUENCE,
  }),
  windows_beta31_online_update: Object.freeze({
    platform: "win32",
    architecture: "x64",
    environment: "physical",
    sourceVersion: "0.7.4-internal-beta.31",
    method: "online_update",
    artifactKind: "app_zip",
    sequence: SUCCESS_SEQUENCE,
  }),
  windows_beta32_online_update: Object.freeze({
    platform: "win32",
    architecture: "x64",
    environment: "physical",
    sourceVersion: "0.7.4-internal-beta.32",
    method: "online_update",
    artifactKind: "app_zip",
    sequence: SUCCESS_SEQUENCE,
  }),
  macos_health_failure_rollback: Object.freeze({
    platform: "darwin",
    architecture: "arm64",
    environment: "isolated_ci",
    sourceVersion: "0.7.4-internal-beta.32",
    method: "injected_health_failure",
    artifactKind: "zip",
    sequence: ROLLBACK_SEQUENCE,
  }),
  windows_health_failure_rollback: Object.freeze({
    platform: "win32",
    architecture: "x64",
    environment: "isolated_ci",
    sourceVersion: "0.7.4-internal-beta.32",
    method: "injected_health_failure",
    artifactKind: "app_zip",
    sequence: ROLLBACK_SEQUENCE,
  }),
});

function fail(message) {
  throw new Error(`Beta.33 acceptance evidence is invalid: ${message}`);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    fail(`${label} contains an unknown or missing field`);
  }
  return value;
}

function exactString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function sameNames(actual, expected) {
  return (
    Array.isArray(actual) &&
    [...actual].sort().join("\0") === [...expected].sort().join("\0")
  );
}

function parseTimestamp(value, label) {
  exactString(value, TIMESTAMP, label);
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().replace(".000Z", "Z") !== value
  ) {
    fail(`${label} is invalid`);
  }
  return time;
}

function parseCanonical(raw, label, limit = 2 * 1024 * 1024) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > limit) {
    fail(`${label} bytes are unavailable or oversized`);
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    fail(`${label} JSON is invalid`);
  }
  if (canonicalJSONStringify(document) !== raw) {
    fail(`${label} JSON is not canonical`);
  }
  return document;
}

function hashRaw(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function validateSupplyDigest(value, expectedName, label) {
  if (
    !value ||
    typeof value !== "object" ||
    value.name !== expectedName ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256)
  ) {
    fail(`${label} is missing or invalid`);
  }
}

function validateCandidateManifest(raw) {
  const manifest = parseCanonical(raw, "candidate manifest");
  if (
    manifest.schemaVersion !== 3 ||
    manifest.repository !== "Ablankpaper/aera" ||
    !SHA.test(manifest.sourceSha ?? "") ||
    manifest.version !== BETA33_TARGET_VERSION ||
    manifest.signingStatus !== SIGNING_STATUS
  ) {
    fail("candidate manifest is not the signed Beta.33 identity");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 5) {
    fail("candidate artifact set is incomplete");
  }
  const requiredArtifacts = [
    ["macos", "arm64", "dmg"],
    ["macos", "arm64", "zip"],
    ["windows", "x64", "setup"],
    ["windows", "x64", "portable"],
    ["windows", "x64", "app_zip"],
  ];
  const artifactByKind = new Map();
  for (let index = 0; index < requiredArtifacts.length; index += 1) {
    const artifact = manifest.artifacts[index];
    const [platform, arch, kind] = requiredArtifacts[index];
    if (
      !artifact ||
      artifact.platform !== platform ||
      artifact.arch !== arch ||
      artifact.kind !== kind ||
      !SAFE_FILENAME.test(artifact.name ?? "") ||
      !SHA256.test(artifact.sha256 ?? "") ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      artifactByKind.has(kind)
    ) {
      fail("candidate artifact identity is invalid or reordered");
    }
    artifactByKind.set(kind, artifact);
  }

  const supply = manifest.supplyChain;
  if (!supply || typeof supply !== "object" || Array.isArray(supply)) {
    fail("candidate supply-chain evidence is missing");
  }
  validateSupplyDigest(
    supply.macosEvidence,
    "macos-evidence.json",
    "macOS signing evidence",
  );
  validateSupplyDigest(
    supply.windowsEvidence,
    "windows-evidence.json",
    "Windows Authenticode evidence",
  );
  if (
    !Array.isArray(supply.nativeEvidence) ||
    supply.nativeEvidence.length !== 5
  ) {
    fail("candidate final native evidence is incomplete");
  }
  for (const [index, value] of supply.nativeEvidence.entries()) {
    if (
      !value ||
      typeof value !== "object" ||
      !SHA256.test(value.sha256 ?? "")
    ) {
      fail(`candidate native evidence ${index} is invalid`);
    }
  }
  const startupNames = [
    "packaged-startup-macos.json",
    "packaged-startup-windows.json",
  ];
  if (
    !Array.isArray(supply.packagedStartupEvidence) ||
    supply.packagedStartupEvidence.length !== startupNames.length
  ) {
    fail("candidate packaged startup evidence is incomplete");
  }
  for (let index = 0; index < startupNames.length; index += 1) {
    validateSupplyDigest(
      supply.packagedStartupEvidence[index],
      startupNames[index],
      `packaged startup evidence ${index}`,
    );
  }
  return { manifest, artifactByKind, manifestSha256: hashRaw(raw) };
}

export function validateBeta33AcceptanceSchema(schema) {
  if (
    schema?.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
    schema?.$id !==
      "https://github.com/Ablankpaper/aera/scripts/internal-beta/beta33-acceptance-schema.json" ||
    schema?.additionalProperties !== false ||
    !sameNames(schema.required, TOP_LEVEL_FIELDS) ||
    !sameNames(Object.keys(schema.properties ?? {}), TOP_LEVEL_FIELDS)
  ) {
    fail("acceptance schema identity is invalid or not closed");
  }
  if (
    schema.properties?.scenarios?.additionalProperties !== false ||
    !sameNames(
      schema.properties?.scenarios?.required,
      BETA33_ACCEPTANCE_SCENARIOS,
    ) ||
    !sameNames(
      Object.keys(schema.properties?.scenarios?.properties ?? {}),
      BETA33_ACCEPTANCE_SCENARIOS,
    ) ||
    schema.$defs?.scenario?.additionalProperties !== false ||
    !sameNames(schema.$defs?.scenario?.required, SCENARIO_FIELDS) ||
    !sameNames(
      Object.keys(schema.$defs?.scenario?.properties ?? {}),
      SCENARIO_FIELDS,
    ) ||
    schema.$defs?.event?.additionalProperties !== false ||
    !sameNames(schema.$defs?.event?.required, EVENT_FIELDS) ||
    !sameNames(Object.keys(schema.$defs?.event?.properties ?? {}), EVENT_FIELDS)
  ) {
    fail("acceptance schema scenario or event contract differs");
  }
  function assertClosed(node, label) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    if (node.type === "object" && node.additionalProperties !== false) {
      fail(`${label} object schema is not closed`);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      assertClosed(child, `${label}.${key}`);
    }
    for (const [key, child] of Object.entries(node.$defs ?? {})) {
      assertClosed(child, `${label}.$defs.${key}`);
    }
    if (node.items) assertClosed(node.items, `${label}[]`);
  }
  assertClosed(schema, "acceptance schema");
  return schema;
}

function validateEventTimeline(scenario, policy, startedAt, completedAt) {
  if (policy.sequence === null) {
    if (
      scenario.timeline.length !== 0 ||
      scenario.operationId !== null ||
      scenario.diagnosticId !== null
    ) {
      fail("manual bridge must not claim an online update timeline");
    }
    return;
  }
  exactString(scenario.operationId, UUID_V4, "scenario operation ID");
  exactString(scenario.diagnosticId, DIAGNOSTIC_ID, "scenario diagnostic ID");
  if (
    !Array.isArray(scenario.timeline) ||
    scenario.timeline.length !== policy.sequence.length
  ) {
    fail("scenario timeline sequence is incomplete");
  }
  let previousTime = startedAt - 1;
  for (let index = 0; index < policy.sequence.length; index += 1) {
    const event = exactObject(
      scenario.timeline[index],
      EVENT_FIELDS,
      `scenario timeline event ${index}`,
    );
    const [stage, state, code = null, retryability = "not_retryable"] =
      policy.sequence[index];
    const expectedTarget =
      stage === "metadata" && index < 2 ? null : BETA33_TARGET_VERSION;
    if (
      event.schemaVersion !== 2 ||
      event.operationId !== scenario.operationId ||
      event.diagnosticId !== scenario.diagnosticId ||
      event.stage !== stage ||
      event.state !== state ||
      event.code !== code ||
      event.retryability !== retryability ||
      event.targetVersion !== expectedTarget
    ) {
      fail(
        `scenario timeline event ${index} differs from the required sequence`,
      );
    }
    const eventTime = parseTimestamp(
      event.at,
      `scenario timeline event ${index}`,
    );
    if (
      eventTime <= previousTime ||
      eventTime < startedAt ||
      eventTime > completedAt
    ) {
      fail("scenario timeline timestamps are not monotonic and bounded");
    }
    previousTime = eventTime;
  }
}

function validateScenario(key, scenario, context) {
  const policy = SCENARIO_POLICY[key];
  exactObject(scenario, SCENARIO_FIELDS, `scenario ${key}`);
  if (
    scenario.platform !== policy.platform ||
    scenario.architecture !== policy.architecture ||
    scenario.environment !== policy.environment ||
    scenario.sourceVersion !== policy.sourceVersion ||
    scenario.targetVersion !== BETA33_TARGET_VERSION ||
    scenario.method !== policy.method
  ) {
    fail(`scenario ${key} platform, source, bridge, or method is invalid`);
  }
  if (scenario.startupPassed !== true || scenario.modelSavePassed !== true) {
    fail(`scenario ${key} startup or model-save result did not pass`);
  }
  exactString(scenario.executableSha256, SHA256, `${key} executable digest`);
  exactString(
    scenario.protectedUserDataBeforeSha256,
    SHA256,
    `${key} protected user data before digest`,
  );
  exactString(
    scenario.protectedUserDataAfterSha256,
    SHA256,
    `${key} protected user data after digest`,
  );
  if (
    scenario.protectedUserDataBeforeSha256 !==
    scenario.protectedUserDataAfterSha256
  ) {
    fail(`scenario ${key} changed protected user data`);
  }

  const installed = exactObject(
    scenario.installedArtifact,
    ["name", "sha256"],
    `${key} installed artifact`,
  );
  const artifact = context.artifactByKind.get(policy.artifactKind);
  if (
    installed.name !== artifact?.name ||
    installed.sha256 !== artifact?.sha256
  ) {
    fail(`scenario ${key} artifact differs from the candidate`);
  }

  const digests = exactObject(
    scenario.evidenceFileDigests,
    ["modelSave", "processLog", "updateTimeline"],
    `${key} evidence digests`,
  );
  for (const [name, digest] of Object.entries(digests)) {
    exactString(digest, SHA256, `${key} ${name} evidence digest`);
  }
  const startedAt = parseTimestamp(scenario.startedAt, `${key} start`);
  const completedAt = parseTimestamp(scenario.completedAt, `${key} completion`);
  if (completedAt <= startedAt || completedAt > context.completedAt) {
    fail(`scenario ${key} timestamps are invalid`);
  }
  validateEventTimeline(scenario, policy, startedAt, completedAt);
  return scenario.operationId;
}

export function validateBeta33Acceptance(document, options = {}) {
  const context = validateCandidateManifest(options.candidateManifestRaw);
  exactObject(document, TOP_LEVEL_FIELDS, "acceptance ledger");
  if (document.schemaVersion !== 1 || document.status !== "BETA33_ACCEPTED") {
    fail("acceptance ledger status or schema is invalid");
  }
  const completedAt = parseTimestamp(document.completedAt, "ledger completion");
  context.completedAt = completedAt;

  const candidate = exactObject(
    document.candidate,
    CANDIDATE_FIELDS,
    "acceptance candidate",
  );
  if (
    candidate.repository !== "Ablankpaper/aera" ||
    candidate.sourceSha !== context.manifest.sourceSha ||
    candidate.version !== context.manifest.version ||
    candidate.manifestSha256 !== context.manifestSha256
  ) {
    fail("acceptance candidate manifest identity or digest differs");
  }

  exactObject(
    document.scenarios,
    BETA33_ACCEPTANCE_SCENARIOS,
    "acceptance scenarios",
  );
  const operationIds = new Set();
  for (const key of BETA33_ACCEPTANCE_SCENARIOS) {
    const operationId = validateScenario(key, document.scenarios[key], context);
    if (operationId !== null) {
      if (operationIds.has(operationId)) {
        fail("acceptance scenarios reuse one updater operation ID");
      }
      operationIds.add(operationId);
    }
  }
  return document;
}

export function parseAndValidateBeta33Acceptance(raw, options = {}) {
  const document = parseCanonical(raw, "acceptance ledger");
  return validateBeta33Acceptance(document, options);
}

export function validateBeta33AcceptanceForRelease(options = {}) {
  if (options.version !== BETA33_TARGET_VERSION) return null;
  if (
    typeof options.acceptanceRaw !== "string" ||
    typeof options.candidateManifestRaw !== "string"
  ) {
    fail("dedicated acceptance ledger and candidate manifest are required");
  }
  const document = parseAndValidateBeta33Acceptance(options.acceptanceRaw, {
    candidateManifestRaw: options.candidateManifestRaw,
  });
  if (
    document.candidate.sourceSha !== options.sourceSha ||
    document.candidate.version !== options.version
  ) {
    fail("release source or version differs from the acceptance ledger");
  }
  if (
    options.releaseCompletedAt !== undefined &&
    parseTimestamp(document.completedAt, "ledger completion") >
      parseTimestamp(options.releaseCompletedAt, "release completion")
  ) {
    fail("ledger completion is after release acceptance");
  }
  return document;
}

function parseOptions(arguments_) {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    fail("options must be flag/value pairs");
  }
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      fail("options must be flag/value pairs");
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(values, key)) fail(`duplicate option ${flag}`);
    values[key] = value;
  }
  return values;
}

async function runCLI(arguments_) {
  const values = parseOptions(arguments_);
  if (!values.evidence || !values.candidate_manifest) {
    fail("--evidence and --candidate-manifest are required");
  }
  const [evidenceRaw, candidateManifestRaw, schemaRaw] = await Promise.all([
    readFile(resolve(values.evidence), "utf8"),
    readFile(resolve(values.candidate_manifest), "utf8"),
    readFile(resolve(values.schema ?? DEFAULT_SCHEMA), "utf8"),
  ]);
  validateBeta33AcceptanceSchema(JSON.parse(schemaRaw));
  parseAndValidateBeta33Acceptance(evidenceRaw, { candidateManifestRaw });
  process.stdout.write("Beta.33 acceptance evidence accepted.\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCLI(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
