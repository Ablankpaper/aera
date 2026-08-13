/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSpdxDocument,
  buildUpdateMetadata,
  canonicalJSONStringify,
} from "./candidate-manifest.mjs";
import { validateCandidateDocument } from "./verify-candidate.mjs";

const SOURCE_SHA = "a".repeat(40);
const VERSION = "0.7.3";

test("accepts a complete signed two-platform candidate", () => {
  assert.doesNotThrow(() =>
    validateCandidateDocument(candidate(), {
      expectedSourceSha: SOURCE_SHA,
      expectedVersion: VERSION,
    }),
  );
});

test("rejects source SHA and package version mismatches", () => {
  assert.throws(
    () =>
      validateCandidateDocument(candidate(), {
        expectedSourceSha: "b".repeat(40),
        expectedVersion: VERSION,
      }),
    /source SHA/u,
  );
  assert.throws(
    () =>
      validateCandidateDocument(candidate(), {
        expectedSourceSha: SOURCE_SHA,
        expectedVersion: "0.7.4",
      }),
    /version/u,
  );
});

test("rejects missing locked Runtime Seed manifest evidence", () => {
  const malformed = candidate();
  delete malformed.runtimeSeed.targets[0].manifest;
  assert.throws(
    () => validateCandidateDocument(malformed),
    /Runtime Seed manifest/u,
  );
});

test("rejects unsigned macOS or Windows artifacts", () => {
  const mac = candidate();
  mac.platformEvidence.macos.codesignVerified = false;
  assert.throws(() => validateCandidateDocument(mac), /macOS.*signature/u);

  const windows = candidate();
  windows.platformEvidence.windows.authenticodeVerifiedArtifacts.pop();
  assert.throws(() => validateCandidateDocument(windows), /Authenticode/u);
});

test("rejects missing notarization, stapling, or Authenticode timestamp evidence", () => {
  const notarization = candidate();
  notarization.platformEvidence.macos.notarizations = [];
  assert.throws(() => validateCandidateDocument(notarization), /notarization/u);

  const stapling = candidate();
  stapling.platformEvidence.macos.dmgStapled = false;
  assert.throws(() => validateCandidateDocument(stapling), /stapled/u);

  const timestamp = candidate();
  timestamp.platformEvidence.windows.timestampVerifiedArtifacts = [];
  assert.throws(() => validateCandidateDocument(timestamp), /timestamp/u);
});

test("rejects wrong target or native-module architectures", () => {
  const mac = candidate();
  mac.platformEvidence.macos.nativeModuleArchitecture = "x64";
  assert.throws(() => validateCandidateDocument(mac), /architecture/u);

  const windows = candidate();
  windows.artifacts.find((artifact) => artifact.kind === "windows_setup").arch =
    "arm64";
  assert.throws(() => validateCandidateDocument(windows), /architecture/u);
});

test("rejects update metadata inconsistent with the signed target bytes", () => {
  const malformed = candidate();
  malformed.updateMetadata.windows.targetSha512 = "f".repeat(128);
  assert.throws(() => validateCandidateDocument(malformed), /update metadata/u);
});

test("never treats a Linux artifact as releasable", () => {
  const malformed = candidate();
  malformed.artifacts.push({
    name: "Aera-0.7.3.AppImage",
    platform: "linux",
    arch: "x64",
    kind: "linux_appimage",
    size: 64,
    sha256: "7".repeat(64),
    sha512: "7".repeat(128),
    releasable: true,
  });
  assert.throws(
    () => validateCandidateDocument(malformed),
    /Linux.*releasable/u,
  );
});

test("builds deterministic update metadata and an SPDX Runtime Seed package", () => {
  const updateSha512 = Buffer.from("a".repeat(128), "hex").toString("base64");
  const metadata = buildUpdateMetadata({
    version: VERSION,
    target: {
      name: "Aera-0.7.3-setup.exe",
      size: 123,
      sha512: updateSha512,
    },
    releaseDate: "2026-07-23T09:00:00Z",
  });
  assert.match(metadata, /^version: 0\.7\.3$/mu);
  assert.match(metadata, new RegExp(`sha512: ${updateSha512}`, "u"));

  const sbom = buildSpdxDocument({
    packageLock: {
      name: "agentera-studio",
      version: VERSION,
      lockfileVersion: 3,
      packages: {
        "": { name: "agentera-studio", version: VERSION },
        "node_modules/example": { version: "1.2.3", license: "MIT" },
      },
    },
    runtimeLock: {
      repository: "Ablankpaper/aera-runtime",
      runtime_version: "0.18.2-agentera.1",
      source_commit: "c".repeat(40),
    },
    sourceSha: SOURCE_SHA,
    createdAt: "2026-07-23T09:00:00Z",
  });
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.ok(
    sbom.packages.some(
      (item) =>
        item.name === "Aera Runtime Seed" &&
        item.versionInfo === "0.18.2-agentera.1",
    ),
  );
  assert.equal(
    canonicalJSONStringify({ z: 1, a: { z: 2, a: 3 } }),
    '{"a":{"a":3,"z":2},"z":1}\n',
  );
});

function candidate() {
  const macDmg = artifact(
    "Aera-0.7.3-arm64.dmg",
    "macos",
    "arm64",
    "macos_dmg",
    "1",
  );
  const macZip = artifact(
    "Aera-0.7.3-arm64-mac.zip",
    "macos",
    "arm64",
    "macos_zip",
    "2",
  );
  const windowsSetup = artifact(
    "Aera-0.7.3-setup.exe",
    "windows",
    "x64",
    "windows_setup",
    "3",
  );
  const windowsPortable = artifact(
    "Aera-0.7.3-portable.exe",
    "windows",
    "x64",
    "windows_portable",
    "4",
  );
  const latestMac = artifact(
    "latest-mac.yml",
    "macos",
    "arm64",
    "update_metadata",
    "5",
  );
  const latestWindows = artifact(
    "latest.yml",
    "windows",
    "x64",
    "update_metadata",
    "6",
  );
  return {
    schemaVersion: 1,
    repository: "Ablankpaper/aera",
    sourceSha: SOURCE_SHA,
    version: VERSION,
    build: {
      workflow: "Desktop signed candidate",
      runUrl: "https://github.com/Ablankpaper/aera/actions/runs/1234",
      ciRunUrl: "https://github.com/Ablankpaper/aera/actions/runs/1200",
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
        notarizations: [
          {
            artifact: macDmg.name,
            id: "019f0000-0000-7000-8000-000000000601",
            status: "Accepted",
          },
          {
            artifact: macZip.name,
            id: "019f0000-0000-7000-8000-000000000602",
            status: "Accepted",
          },
        ],
        runtimeSeedVerifiedArtifacts: [macDmg.name, macZip.name],
        nativeModuleArchitecture: "arm64",
      },
      windows: {
        arch: "x64",
        signerSubject: "CN=Aera Code Signing",
        signerThumbprint: "A".repeat(40),
        authenticodeVerifiedArtifacts: [
          windowsSetup.name,
          windowsPortable.name,
        ],
        timestampVerifiedArtifacts: [windowsSetup.name, windowsPortable.name],
        runtimeSeedVerifiedArtifacts: [windowsSetup.name, windowsPortable.name],
        nativeModuleArchitecture: "x64",
      },
    },
    artifacts: [
      macDmg,
      macZip,
      windowsSetup,
      windowsPortable,
      latestMac,
      latestWindows,
    ],
    updateMetadata: {
      macos: {
        file: latestMac.name,
        version: VERSION,
        target: macZip.name,
        targetSha512: Buffer.from(macZip.sha512, "hex").toString("base64"),
        targetSize: macZip.size,
      },
      windows: {
        file: latestWindows.name,
        version: VERSION,
        target: windowsSetup.name,
        targetSha512: Buffer.from(windowsSetup.sha512, "hex").toString(
          "base64",
        ),
        targetSize: windowsSetup.size,
      },
    },
    supplyChain: {
      sbom: { name: "sbom.spdx.json", sha256: "b".repeat(64) },
      provenance: { name: "provenance.json", sha256: "c".repeat(64) },
      githubAttestation: {
        required: true,
        signerWorkflow:
          "github.com/Ablankpaper/aera/.github/workflows/release-candidate.yml",
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
