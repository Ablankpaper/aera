/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { canonicalJSONStringify } from "./manifest.mjs";
import {
  BETA33_ACCEPTANCE_SCENARIOS,
  parseAndValidateBeta33Acceptance,
  validateBeta33AcceptanceForRelease,
  validateBeta33Acceptance,
  validateBeta33AcceptanceSchema,
} from "./verify-beta33-acceptance.mjs";

const TARGET_VERSION = "0.7.4-internal-beta.33";
const SOURCE_SHA = "a".repeat(40);
const START = Date.parse("2026-08-18T08:00:00Z");

const SUCCESS_STAGES = [
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
];

const ROLLBACK_STAGES = [
  ...SUCCESS_STAGES.slice(0, -4),
  ["health", "started"],
  ["health", "failed", "update_health_timeout", "after_restart"],
  ["rollback", "started"],
  ["rollback", "rolled_back", "update_health_timeout", "after_restart"],
];

const artifactSpecs = [
  ["macos_dmg", `Aera-Internal-Beta-${TARGET_VERSION}-macos-arm64.dmg`, "1"],
  ["macos_zip", `Aera-Internal-Beta-${TARGET_VERSION}-macos-arm64.zip`, "2"],
  [
    "windows_setup",
    `Aera-Internal-Beta-${TARGET_VERSION}-windows-x64-setup.exe`,
    "3",
  ],
  [
    "windows_portable",
    `Aera-Internal-Beta-${TARGET_VERSION}-windows-x64-portable.exe`,
    "4",
  ],
  [
    "windows_app_zip",
    `Aera-Internal-Beta-${TARGET_VERSION}-windows-x64-app.zip`,
    "5",
  ],
];

function manifest() {
  return {
    schemaVersion: 3,
    repository: "Ablankpaper/aera",
    sourceSha: SOURCE_SHA,
    version: TARGET_VERSION,
    signingStatus: "macos_developer_id_notarized_windows_authenticode",
    artifacts: artifactSpecs.map(([kind, name, digit], index) => ({
      arch: kind.startsWith("macos") ? "arm64" : "x64",
      kind:
        kind === "macos_dmg"
          ? "dmg"
          : kind === "macos_zip"
            ? "zip"
            : kind === "windows_setup"
              ? "setup"
              : kind === "windows_portable"
                ? "portable"
                : "app_zip",
      name,
      platform: kind.startsWith("macos") ? "macos" : "windows",
      sha256: digit.repeat(64),
      size: 100 + index,
    })),
    supplyChain: {
      macosEvidence: { name: "macos-evidence.json", sha256: "6".repeat(64) },
      windowsEvidence: {
        name: "windows-evidence.json",
        sha256: "7".repeat(64),
      },
      nativeEvidence: artifactSpecs.map(([, , digit], index) => ({
        name: `native-${index}.json`,
        sha256: digit.repeat(64),
      })),
      packagedStartupEvidence: [
        { name: "packaged-startup-macos.json", sha256: "8".repeat(64) },
        { name: "packaged-startup-windows.json", sha256: "9".repeat(64) },
      ],
    },
  };
}

function event(
  [stage, state, code = null, retryability = "not_retryable"],
  index,
  baseTime = START,
  operationId = "019f0000-0000-4000-8000-000000000033",
  diagnosticId = "abcdef012345",
) {
  return {
    at: new Date(baseTime + index * 1_000).toISOString().replace(".000Z", "Z"),
    schemaVersion: 2,
    operationId,
    stage,
    state,
    code,
    retryability,
    diagnosticId,
    targetVersion: stage === "metadata" && index < 2 ? null : TARGET_VERSION,
  };
}

function scenario(key, index) {
  const isWindows = key.startsWith("windows_");
  const isBridge = key === "macos_beta29_manual_bridge";
  const isRollback = key.endsWith("health_failure_rollback");
  const sourceVersion = isBridge
    ? "0.7.4-internal-beta.29"
    : key.includes("beta31")
      ? "0.7.4-internal-beta.31"
      : "0.7.4-internal-beta.32";
  const artifactIndex = isBridge ? 0 : isWindows ? 4 : 1;
  const startedAt = new Date(START + index * 60_000)
    .toISOString()
    .replace(".000Z", "Z");
  const operationId = `019f0000-0000-4000-8000-${String(index + 33).padStart(12, "0")}`;
  const diagnosticId = (index + 1).toString(16).padStart(12, "0");
  const timeline = isBridge
    ? []
    : (isRollback ? ROLLBACK_STAGES : SUCCESS_STAGES).map((value, eventIndex) =>
        event(
          value,
          eventIndex,
          Date.parse(startedAt),
          operationId,
          diagnosticId,
        ),
      );
  return {
    platform: isWindows ? "win32" : "darwin",
    architecture: isWindows ? "x64" : "arm64",
    environment: isRollback ? "isolated_ci" : "physical",
    sourceVersion,
    targetVersion: TARGET_VERSION,
    method: isBridge
      ? "manual_dmg_bridge"
      : isRollback
        ? "injected_health_failure"
        : "online_update",
    installedArtifact: {
      name: artifactSpecs[artifactIndex][1],
      sha256: artifactSpecs[artifactIndex][2].repeat(64),
    },
    executableSha256: String((index % 8) + 1).repeat(64),
    protectedUserDataBeforeSha256: "c".repeat(64),
    protectedUserDataAfterSha256: "c".repeat(64),
    startupPassed: true,
    modelSavePassed: true,
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + 30_000)
      .toISOString()
      .replace(".000Z", "Z"),
    operationId: isBridge ? null : operationId,
    diagnosticId: isBridge ? null : diagnosticId,
    timeline,
    evidenceFileDigests: {
      modelSave: String((index % 7) + 1).repeat(64),
      processLog: String(((index + 1) % 7) + 1).repeat(64),
      updateTimeline: String(((index + 2) % 7) + 1).repeat(64),
    },
  };
}

function fixture() {
  const candidateManifest = manifest();
  const candidateManifestRaw = canonicalJSONStringify(candidateManifest);
  const manifestSha256 = createHash("sha256")
    .update(candidateManifestRaw)
    .digest("hex");
  const document = {
    schemaVersion: 1,
    status: "BETA33_ACCEPTED",
    candidate: {
      repository: "Ablankpaper/aera",
      sourceSha: SOURCE_SHA,
      version: TARGET_VERSION,
      manifestSha256,
    },
    scenarios: Object.fromEntries(
      BETA33_ACCEPTANCE_SCENARIOS.map((key, index) => [
        key,
        scenario(key, index),
      ]),
    ),
    completedAt: "2026-08-18T10:00:00Z",
  };
  return { candidateManifest, candidateManifestRaw, document };
}

test("Beta.33 acceptance schema is closed and exact", async () => {
  const schema = JSON.parse(
    await readFile(new URL("./beta33-acceptance-schema.json", import.meta.url)),
  );
  assert.doesNotThrow(() => validateBeta33AcceptanceSchema(schema));

  const open = structuredClone(schema);
  open.$defs.scenario.additionalProperties = true;
  assert.throws(() => validateBeta33AcceptanceSchema(open), /closed|schema/iu);
});

// @lat: [[lat.md/desktop-updates#Desktop Updates#Internal Beta signed update channel#Beta.33 physical update acceptance]]
test("accepts one canonical ledger bound to the Beta.33 candidate and all scenarios", () => {
  const { candidateManifestRaw, document } = fixture();
  assert.equal(
    validateBeta33Acceptance(document, { candidateManifestRaw }),
    document,
  );
  assert.deepEqual(
    parseAndValidateBeta33Acceptance(canonicalJSONStringify(document), {
      candidateManifestRaw,
    }),
    document,
  );
});

test("binds Beta.33 release acceptance to source, version, and completion time", () => {
  const { candidateManifestRaw, document } = fixture();
  assert.deepEqual(
    validateBeta33AcceptanceForRelease({
      acceptanceRaw: canonicalJSONStringify(document),
      candidateManifestRaw,
      releaseCompletedAt: document.completedAt,
      sourceSha: document.candidate.sourceSha,
      version: document.candidate.version,
    }),
    document,
  );
  assert.throws(
    () =>
      validateBeta33AcceptanceForRelease({
        acceptanceRaw: canonicalJSONStringify(document),
        candidateManifestRaw,
        sourceSha: "b".repeat(40),
        version: document.candidate.version,
      }),
    /source|version/iu,
  );
  assert.throws(
    () =>
      validateBeta33AcceptanceForRelease({
        acceptanceRaw: canonicalJSONStringify(document),
        candidateManifestRaw,
        releaseCompletedAt: "2026-08-18T09:59:59Z",
        sourceSha: document.candidate.sourceSha,
        version: document.candidate.version,
      }),
    /completion/iu,
  );
});

test("rejects Beta.28 or Beta.29 claims of an online update", () => {
  const { candidateManifestRaw, document } = fixture();
  const invalid = structuredClone(document);
  invalid.scenarios.macos_beta31_online_update.sourceVersion =
    "0.7.4-internal-beta.28";

  assert.throws(
    () => validateBeta33Acceptance(invalid, { candidateManifestRaw }),
    /source|bridge|Beta\.28|Beta\.31/iu,
  );
});

test("rejects missing scenarios, event reordering, or a false rollback", () => {
  for (const mutate of [
    (document) => {
      delete document.scenarios.windows_health_failure_rollback;
    },
    (document) => {
      document.scenarios.macos_beta32_online_update.timeline.reverse();
    },
    (document) => {
      document.scenarios.windows_health_failure_rollback.timeline.at(-1).state =
        "failed";
    },
  ]) {
    const { candidateManifestRaw, document } = fixture();
    mutate(document);
    assert.throws(
      () => validateBeta33Acceptance(document, { candidateManifestRaw }),
      /scenario|timeline|sequence|rollback|state/iu,
    );
  }
});

test("rejects changed candidate bytes, artifact substitution, or changed protected data", () => {
  for (const mutate of [
    (document) => {
      document.candidate.manifestSha256 = "f".repeat(64);
    },
    (document) => {
      document.scenarios.macos_beta29_manual_bridge.installedArtifact.sha256 =
        "f".repeat(64);
    },
    (document) => {
      document.scenarios.windows_beta32_online_update.protectedUserDataAfterSha256 =
        "f".repeat(64);
    },
  ]) {
    const { candidateManifestRaw, document } = fixture();
    mutate(document);
    assert.throws(
      () => validateBeta33Acceptance(document, { candidateManifestRaw }),
      /candidate|artifact|manifest|protected.*data|digest/iu,
    );
  }
});

test("rejects free-form notes, raw paths, and noncanonical JSON", () => {
  const { candidateManifestRaw, document } = fixture();
  const withNotes = structuredClone(document);
  withNotes.scenarios.macos_beta29_manual_bridge.notes =
    "/Users/test API key was visible";
  assert.throws(
    () => validateBeta33Acceptance(withNotes, { candidateManifestRaw }),
    /field|unknown|closed/iu,
  );
  assert.throws(
    () =>
      parseAndValidateBeta33Acceptance(JSON.stringify(document, null, 2), {
        candidateManifestRaw,
      }),
    /canonical/iu,
  );
});
