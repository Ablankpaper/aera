/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  canonicalJSONStringify,
  updaterSha512,
} from "./candidate-manifest.mjs";
import {
  REQUIRED_DEVICE_ROLES,
  REQUIRED_SCENARIOS,
  validateDeviceEvidence,
  validateDeviceEvidenceSchema,
} from "./verify-device-evidence.mjs";

const SOURCE_SHA = "a".repeat(40);
const VERSION = "0.7.3";

test("accepts four independent signed-device records bound to one candidate", () => {
  const candidateDocument = candidate();
  assert.doesNotThrow(() =>
    validateDeviceEvidence(evidence(candidateDocument), {
      candidate: candidateDocument,
      candidateManifestSha256: candidateDigest(candidateDocument),
      now: new Date("2026-07-23T18:00:00Z"),
    }),
  );
});

test("keeps the published JSON schema aligned with verifier scenarios", async () => {
  const schema = JSON.parse(
    await readFile(
      new URL("../../release/evidence.schema.json", import.meta.url),
      "utf8",
    ),
  );
  assert.doesNotThrow(() => validateDeviceEvidenceSchema(schema));
});

test("requires every macOS and Windows device role exactly once", () => {
  const candidateDocument = candidate();
  const malformed = evidence(candidateDocument);
  malformed.entries.pop();
  assert.throws(
    () => verify(malformed, candidateDocument),
    /device role|four independent/u,
  );

  const duplicateRole = evidence(candidateDocument);
  duplicateRole.entries[3].role = "windows_physical";
  duplicateRole.entries[3].deviceClass = "physical";
  duplicateRole.entries[3].installedArtifact = {
    ...duplicateRole.entries[2].installedArtifact,
  };
  assert.throws(
    () => verify(duplicateRole, candidateDocument),
    /device role/iu,
  );
});

test("rejects duplicate devices and a virtual-only Windows matrix", () => {
  const candidateDocument = candidate();
  const duplicate = evidence(candidateDocument);
  duplicate.entries[3].deviceFingerprint =
    duplicate.entries[2].deviceFingerprint;
  assert.throws(
    () => verify(duplicate, candidateDocument),
    /device fingerprint/iu,
  );

  const virtualOnly = evidence(candidateDocument);
  virtualOnly.entries[2].deviceClass = "trusted_vm";
  assert.throws(
    () => verify(virtualOnly, candidateDocument),
    /physical Windows/u,
  );
});

test("rejects evidence for different source, version, manifest, or artifact bytes", () => {
  const candidateDocument = candidate();
  for (const mutate of [
    (value) => {
      value.candidate.sourceSha = "b".repeat(40);
    },
    (value) => {
      value.candidate.version = "0.7.4";
    },
    (value) => {
      value.candidate.manifestSha256 = "b".repeat(64);
    },
    (value) => {
      value.entries[0].installedArtifact.sha256 = "b".repeat(64);
    },
  ]) {
    const malformed = evidence(candidateDocument);
    mutate(malformed);
    assert.throws(
      () => verify(malformed, candidateDocument),
      /candidate|artifact/u,
    );
  }
});

test("requires local signature, notarization, and Authenticode verification", () => {
  const candidateDocument = candidate();
  const unsigned = evidence(candidateDocument);
  unsigned.entries[0].signatureVerification.verified = false;
  assert.throws(() => verify(unsigned, candidateDocument), /signature/u);

  const wrongMacSigner = evidence(candidateDocument);
  wrongMacSigner.entries[1].signatureVerification.signerIdentityRef =
    "developer-id-team:ZZZZZZZZZZ";
  assert.throws(() => verify(wrongMacSigner, candidateDocument), /signer/u);

  const missingTimestamp = evidence(candidateDocument);
  missingTimestamp.entries[2].signatureVerification.timestampVerified = false;
  assert.throws(
    () => verify(missingTimestamp, candidateDocument),
    /timestamp/u,
  );
});

test("rejects any failed or incomplete acceptance scenario", () => {
  const candidateDocument = candidate();
  const failed = evidence(candidateDocument);
  failed.entries[2].scenarioResults.backupCiphertextCorruptionRejected = false;
  assert.throws(() => verify(failed, candidateDocument), /scenario/u);

  const incomplete = evidence(candidateDocument);
  delete incomplete.entries[0].scenarioResults.noPrivateDataUploadCanary;
  assert.throws(() => verify(incomplete, candidateDocument), /scenario/u);
});

test("requires two accounts, two backup devices, and unique device evidence", () => {
  const candidateDocument = candidate();
  const oneAccount = evidence(candidateDocument);
  oneAccount.coverage.accountIdentityRefs.pop();
  assert.throws(() => verify(oneAccount, candidateDocument), /two account/u);

  const oneBackupDevice = evidence(candidateDocument);
  oneBackupDevice.coverage.backupDeviceIdentityRefs.pop();
  assert.throws(
    () => verify(oneBackupDevice, candidateDocument),
    /backup device/u,
  );

  const duplicateEvidence = evidence(candidateDocument);
  duplicateEvidence.entries[3].evidenceId =
    duplicateEvidence.entries[2].evidenceId;
  assert.throws(
    () => verify(duplicateEvidence, candidateDocument),
    /evidence ID/u,
  );
});

test("rejects private fields and unredacted evidence links", () => {
  const candidateDocument = candidate();
  const privatePath = evidence(candidateDocument);
  privatePath.entries[0].profilePath =
    "/Users/example/.hermes/profiles/private";
  assert.throws(
    () => verify(privatePath, candidateDocument),
    /unexpected|field/u,
  );

  const secretLink = evidence(candidateDocument);
  secretLink.entries[0].evidenceLinks = [
    "https://evidence.example.test/run/1?token=secret",
  ];
  assert.throws(() => verify(secretLink, candidateDocument), /redacted|link/u);
});

function verify(document, candidateDocument) {
  return validateDeviceEvidence(document, {
    candidate: candidateDocument,
    candidateManifestSha256: candidateDigest(candidateDocument),
    now: new Date("2026-07-23T18:00:00Z"),
  });
}

function candidateDigest(document) {
  return createHash("sha256")
    .update(canonicalJSONStringify(document))
    .digest("hex");
}

function evidence(candidateDocument) {
  const manifestSha256 = candidateDigest(candidateDocument);
  const macDmg = candidateDocument.artifacts.find(
    (artifact) => artifact.kind === "macos_dmg",
  );
  const windowsSetup = candidateDocument.artifacts.find(
    (artifact) => artifact.kind === "windows_setup",
  );
  const windowsPortable = candidateDocument.artifacts.find(
    (artifact) => artifact.kind === "windows_portable",
  );
  const specs = [
    {
      role: "macos_current",
      deviceClass: "physical",
      os: { name: "macOS", major: 15, version: "15.5", build: "24F74" },
      arch: "arm64",
      artifact: macDmg,
      method: "codesign_spctl_stapler",
      signerIdentityRef: "developer-id-team:ABCDEFGHIJ",
      timestampVerified: true,
    },
    {
      role: "macos_previous",
      deviceClass: "physical",
      os: { name: "macOS", major: 14, version: "14.7.6", build: "23H626" },
      arch: "arm64",
      artifact: macDmg,
      method: "codesign_spctl_stapler",
      signerIdentityRef: "developer-id-team:ABCDEFGHIJ",
      timestampVerified: true,
    },
    {
      role: "windows_physical",
      deviceClass: "physical",
      os: {
        name: "Windows 11",
        major: 11,
        version: "10.0.26100",
        build: "26100.4652",
      },
      arch: "x64",
      artifact: windowsSetup,
      method: "authenticode_signtool",
      signerIdentityRef: `authenticode-thumbprint:${"A".repeat(40)}`,
      timestampVerified: true,
    },
    {
      role: "windows_second",
      deviceClass: "trusted_vm",
      os: {
        name: "Windows 11",
        major: 11,
        version: "10.0.22631",
        build: "22631.5624",
      },
      arch: "x64",
      artifact: windowsPortable,
      method: "authenticode_signtool",
      signerIdentityRef: `authenticode-thumbprint:${"A".repeat(40)}`,
      timestampVerified: true,
    },
  ];
  return {
    schemaVersion: 1,
    candidate: {
      repository: "bignormal/aera",
      sourceSha: candidateDocument.sourceSha,
      version: candidateDocument.version,
      manifestSha256,
    },
    supportPolicy: {
      currentMacosMajor: 15,
      previousMacosMajor: 14,
      windowsMajor: 11,
    },
    coverage: {
      accountIdentityRefs: ["qa-account:alpha", "qa-account:bravo"],
      backupDeviceIdentityRefs: [
        "backup-device:authorized-alpha",
        "backup-device:authorized-bravo",
      ],
    },
    entries: specs.map((spec, index) => ({
      evidenceId: `019f0000-0000-7000-8${index}00-00000000070${index}`,
      role: spec.role,
      deviceFingerprint: `sha256:${String(index + 1).repeat(64)}`,
      deviceClass: spec.deviceClass,
      os: spec.os,
      arch: spec.arch,
      installedArtifact: {
        name: spec.artifact.name,
        sha256: spec.artifact.sha256,
      },
      candidateManifestSha256: manifestSha256,
      signatureVerification: {
        verified: true,
        method: spec.method,
        signerIdentityRef: spec.signerIdentityRef,
        timestampVerified: spec.timestampVerified,
        verificationLogSha256: String(index + 5).repeat(64),
      },
      scenarioResults: Object.fromEntries(
        REQUIRED_SCENARIOS.map((scenario) => [scenario, true]),
      ),
      testedAccountIdentityRefs: ["qa-account:alpha", "qa-account:bravo"],
      backupAuthorizedDeviceIdentityRefs: [
        "backup-device:authorized-alpha",
        "backup-device:authorized-bravo",
      ],
      testedAt: `2026-07-23T1${index + 2}:00:00Z`,
      testerIdentityRef: `employee:release-qa-0${index + 1}`,
      evidenceLinks: [
        `https://github.com/bignormal/aera/actions/runs/1234/artifacts/${2000 + index}`,
      ],
    })),
    completedAt: "2026-07-23T16:00:00Z",
  };
}

function candidate() {
  const artifacts = [
    artifact(
      "Aera-0.7.3-arm64.dmg",
      "macos",
      "arm64",
      "macos_dmg",
      "1",
    ),
    artifact(
      "Aera-0.7.3-arm64-mac.zip",
      "macos",
      "arm64",
      "macos_zip",
      "2",
    ),
    artifact(
      "Aera-0.7.3-setup.exe",
      "windows",
      "x64",
      "windows_setup",
      "3",
    ),
    artifact(
      "Aera-0.7.3-portable.exe",
      "windows",
      "x64",
      "windows_portable",
      "4",
    ),
    artifact("latest-mac.yml", "macos", "arm64", "update_metadata", "5"),
    artifact("latest.yml", "windows", "x64", "update_metadata", "6"),
  ];
  const byKind = (kind) => artifacts.find((item) => item.kind === kind);
  const macDmg = byKind("macos_dmg");
  const macZip = byKind("macos_zip");
  const setup = byKind("windows_setup");
  const portable = byKind("windows_portable");
  return {
    schemaVersion: 1,
    repository: "bignormal/aera",
    sourceSha: SOURCE_SHA,
    version: VERSION,
    build: {
      workflow: "Desktop signed candidate",
      runUrl: "https://github.com/bignormal/aera/actions/runs/1234",
      ciRunUrl: "https://github.com/bignormal/aera/actions/runs/1200",
    },
    runtimeSeed: {
      lockSha256: "8".repeat(64),
      sourceCommit: "c".repeat(40),
      runtimeVersion: "0.18.2-agentera.1",
      targets: [
        {
          platform: "macos",
          arch: "arm64",
          manifest:
            "agentera-runtime-0.18.2-agentera.1-darwin-arm64.manifest.json",
          manifestSha256: "9".repeat(64),
        },
        {
          platform: "windows",
          arch: "x64",
          manifest:
            "agentera-runtime-0.18.2-agentera.1-windows-x64.manifest.json",
          manifestSha256: "a".repeat(64),
        },
      ],
    },
    platformEvidence: {
      macos: {
        arch: "arm64",
        signingIdentity: "Developer ID Application: Aera (ABCDEFGHIJ)",
        teamId: "ABCDEFGHIJ",
        codesignVerified: true,
        gatekeeperAccepted: true,
        appStapled: true,
        dmgStapled: true,
        notarizations: [macDmg, macZip].map((item, index) => ({
          artifact: item.name,
          id: `019f0000-0000-7000-8000-00000000060${index + 1}`,
          status: "Accepted",
        })),
        runtimeSeedVerifiedArtifacts: [macDmg.name, macZip.name],
        nativeModuleArchitecture: "arm64",
      },
      windows: {
        arch: "x64",
        signerSubject: "CN=Aera Code Signing",
        signerThumbprint: "A".repeat(40),
        authenticodeVerifiedArtifacts: [setup.name, portable.name],
        timestampVerifiedArtifacts: [setup.name, portable.name],
        runtimeSeedVerifiedArtifacts: [setup.name, portable.name],
        nativeModuleArchitecture: "x64",
      },
    },
    artifacts,
    updateMetadata: {
      macos: {
        file: "latest-mac.yml",
        version: VERSION,
        target: macZip.name,
        targetSha512: updaterSha512(macZip.sha512),
        targetSize: macZip.size,
      },
      windows: {
        file: "latest.yml",
        version: VERSION,
        target: setup.name,
        targetSha512: updaterSha512(setup.sha512),
        targetSize: setup.size,
      },
    },
    supplyChain: {
      sbom: { name: "sbom.spdx.json", sha256: "b".repeat(64) },
      provenance: { name: "provenance.json", sha256: "c".repeat(64) },
      githubAttestation: {
        required: true,
        signerWorkflow:
          "github.com/bignormal/aera/.github/workflows/release-candidate.yml",
      },
    },
    linuxReleasable: false,
    createdAt: "2026-07-23T09:00:00Z",
  };
}

function artifact(name, platform, arch, kind, digit) {
  return {
    name,
    platform,
    arch,
    kind,
    size: 64,
    sha256: digit.repeat(64),
    sha512: digit.repeat(128),
    releasable: true,
  };
}

assert.deepEqual(REQUIRED_DEVICE_ROLES, [
  "macos_current",
  "macos_previous",
  "windows_physical",
  "windows_second",
]);
