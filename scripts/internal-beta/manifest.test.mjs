/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { hashArtifact } from "../release/candidate-manifest.mjs";
import { buildPackagedStartupEvidence } from "../release/verify-packaged-startup.mjs";

import {
  INTERNAL_BETA_ARTIFACTS,
  INTERNAL_BETA_SIGNING_STATUS,
  buildInternalBetaManifest,
  canonicalJSONStringify,
  parseAndValidateInternalBetaManifest,
  validateInternalBetaManifest,
  verifyInternalBetaManifestFiles,
} from "./manifest.mjs";

const VERSION = "0.7.4-internal-beta.32";
const SOURCE_SHA = "a".repeat(40);
const RUNTIME_SHA = "b890d7de940c02a06da73f6a421d3867a63db8e6";
const ORIGIN = "https://203.0.113.10";
const KEY_ID = "offline-beta-2026-07";
const PUBLIC_KEY = Buffer.alloc(32, 73).toString("base64url");
const CI_RUN_URL =
  "https://github.com/Ablankpaper/aera/actions/runs/30100000001";
const BUILD_RUN_URL =
  "https://github.com/Ablankpaper/aera/actions/runs/30100000002";
const NATIVE_EVIDENCE_NAMES = [
  "native-inventory-macos-dmg.json",
  "native-inventory-macos-zip.json",
  "native-inventory-windows-setup.json",
  "native-inventory-windows-portable.json",
  "native-inventory-windows-app-zip.json",
];

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixture(runtimePatch = {}) {
  const root = await mkdtemp(join(tmpdir(), "aera-internal-beta-manifest-"));
  temporaryRoots.push(root);
  const artifactsDirectory = join(root, "artifacts");
  const runtimeManifestsDirectory = join(root, "runtime-seed");
  const packageJson = join(root, "package.json");
  const runtimeLock = join(root, "runtime-lock.json");
  const evidenceDirectory = join(root, "evidence");
  const macosEvidence = join(evidenceDirectory, "macos-evidence.json");
  const windowsEvidence = join(evidenceDirectory, "windows-evidence.json");
  const sbom = join(root, "internal-beta.spdx.json");
  const provenance = join(root, "internal-beta.provenance.json");
  await Promise.all([
    mkdir(artifactsDirectory, { recursive: true }),
    mkdir(runtimeManifestsDirectory, { recursive: true }),
    mkdir(evidenceDirectory, { recursive: true }),
  ]);

  await writeFile(
    packageJson,
    JSON.stringify({ name: "agentera-studio", version: VERSION }),
  );
  const runtimeDocument = {
    schema_version: 1,
    repository: "Ablankpaper/aera-runtime",
    release_tag: "runtime-v0.20.0-agentera.2-rc.1",
    source_commit: RUNTIME_SHA,
    runtime_version: "0.20.0-agentera.2",
    channel: "candidate",
    assets: {
      "darwin-arm64": {
        platform: "darwin",
        arch: "arm64",
        archive: "agentera-runtime-0.20.0-agentera.2-darwin-arm64.tar.zst",
        manifest:
          "agentera-runtime-0.20.0-agentera.2-darwin-arm64.manifest.json",
        signature:
          "agentera-runtime-0.20.0-agentera.2-darwin-arm64.manifest.sig",
      },
      "windows-x64": {
        platform: "windows",
        arch: "x64",
        archive: "agentera-runtime-0.20.0-agentera.2-windows-x64.zip",
        manifest:
          "agentera-runtime-0.20.0-agentera.2-windows-x64.manifest.json",
        signature:
          "agentera-runtime-0.20.0-agentera.2-windows-x64.manifest.sig",
      },
    },
    ...runtimePatch,
  };
  await writeFile(runtimeLock, canonicalJSONStringify(runtimeDocument));
  await Promise.all(
    Object.values(runtimeDocument.assets).map((asset) =>
      writeFile(
        join(runtimeManifestsDirectory, asset.manifest),
        canonicalJSONStringify({
          platform: asset.platform,
          arch: asset.arch,
          source_commit: runtimeDocument.source_commit,
        }),
      ),
    ),
  );
  await Promise.all(
    INTERNAL_BETA_ARTIFACTS.map((artifact, index) =>
      writeFile(
        join(artifactsDirectory, artifact.name),
        Buffer.alloc(128 + index, index + 1),
      ),
    ),
  );
  await writeFile(sbom, '{"spdxVersion":"SPDX-2.3"}\n');
  const macArtifacts = await Promise.all(
    INTERNAL_BETA_ARTIFACTS.slice(0, 2).map(async (artifact, index) => ({
      name: artifact.name,
      platform: artifact.platform,
      arch: artifact.arch,
      kind: index === 0 ? "macos_dmg" : "macos_zip",
      ...(await hashArtifact(join(artifactsDirectory, artifact.name))),
    })),
  );
  const darwinManifest = runtimeDocument.assets["darwin-arm64"].manifest;
  const darwinManifestDigest = await hashArtifact(
    join(runtimeManifestsDirectory, darwinManifest),
  );
  await writeFile(
    macosEvidence,
    canonicalJSONStringify({
      arch: "arm64",
      signingIdentity: "Developer ID Application: Aera Test (AERA123456)",
      teamId: "AERA123456",
      codesignVerified: true,
      gatekeeperAccepted: true,
      appStapled: true,
      dmgStapled: true,
      notarizations: macArtifacts.map(({ name }, index) => ({
        artifact: name,
        id: `00000000-0000-4000-8000-00000000000${index}`,
        status: "Accepted",
      })),
      runtimeSeedVerifiedArtifacts: macArtifacts.map(({ name }) => name),
      nativeModuleArchitecture: "arm64",
      runtimeSeedManifest: {
        manifest: darwinManifest,
        manifestSha256: darwinManifestDigest.sha256,
      },
      artifacts: macArtifacts,
    }),
  );
  const windowsArtifacts = await Promise.all(
    INTERNAL_BETA_ARTIFACTS.slice(2, 4).map(async (artifact, index) => ({
      name: artifact.name,
      platform: artifact.platform,
      arch: artifact.arch,
      kind: index === 0 ? "windows_setup" : "windows_portable",
      ...(await hashArtifact(join(artifactsDirectory, artifact.name))),
    })),
  );
  const windowsManifest = runtimeDocument.assets["windows-x64"].manifest;
  const windowsManifestDigest = await hashArtifact(
    join(runtimeManifestsDirectory, windowsManifest),
  );
  await writeFile(
    windowsEvidence,
    canonicalJSONStringify({
      arch: "x64",
      signerSubject: "CN=Aera Test Code Signing",
      signerThumbprint: "A".repeat(40),
      authenticodeVerifiedArtifacts: windowsArtifacts.map(({ name }) => name),
      timestampVerifiedArtifacts: windowsArtifacts.map(({ name }) => name),
      runtimeSeedVerifiedArtifacts: windowsArtifacts.map(({ name }) => name),
      nativeModuleArchitecture: "x64",
      runtimeSeedManifest: {
        manifest: windowsManifest,
        manifestSha256: windowsManifestDigest.sha256,
      },
      artifacts: windowsArtifacts,
    }),
  );

  const inventoryByPlatform = new Map();
  for (let index = 0; index < INTERNAL_BETA_ARTIFACTS.length; index += 1) {
    const artifact = INTERNAL_BETA_ARTIFACTS[index];
    const digest = await hashArtifact(join(artifactsDirectory, artifact.name));
    const isMacos = artifact.platform === "macos";
    const modules = [
      {
        abi: "145",
        architecture: isMacos ? "arm64" : "x64",
        format: isMacos ? "mach-o" : "pe",
        path: "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
        sha256: (isMacos ? "1" : "2").repeat(64),
      },
    ];
    const inventorySha256 = createHash("sha256")
      .update(canonicalJSONStringify(modules))
      .digest("hex");
    const platformKey = isMacos ? "macos" : "windows";
    if (!inventoryByPlatform.has(platformKey)) {
      inventoryByPlatform.set(platformKey, {
        inventorySha256,
        payloadSha256: (isMacos ? "3" : "4").repeat(64),
      });
    }
    const shared = inventoryByPlatform.get(platformKey);
    const kinds = [
      "macos_dmg",
      "macos_zip",
      "windows_setup",
      "windows_portable",
      "windows_app_zip",
    ];
    await writeFile(
      join(evidenceDirectory, NATIVE_EVIDENCE_NAMES[index]),
      canonicalJSONStringify({
        schemaVersion: 1,
        sourceSha: SOURCE_SHA,
        version: VERSION,
        platform: isMacos ? "darwin" : "win32",
        architecture: isMacos ? "arm64" : "x64",
        kind: kinds[index],
        electronAbi: "145",
        artifact: {
          name: artifact.name,
          size: digest.size,
          sha256: digest.sha256,
          sha512: digest.sha512,
        },
        payload: { sha256: shared.payloadSha256 },
        inventory: { sha256: shared.inventorySha256, modules },
      }),
    );
  }

  for (const [platform, architecture, output] of [
    ["darwin", "arm64", "packaged-startup-macos.json"],
    ["win32", "x64", "packaged-startup-windows.json"],
  ]) {
    const renderer = {
      readyState: "complete",
      visibilityState: "visible",
      locationProtocol: "file:",
      bodyTextLength: 14,
      rendererReadyAccepted: true,
      appVersion: VERSION,
    };
    await writeFile(
      join(evidenceDirectory, output),
      canonicalJSONStringify(
        buildPackagedStartupEvidence({
          sourceSha: SOURCE_SHA,
          version: VERSION,
          platform,
          architecture,
          executableSha256: "5".repeat(64),
          appAsarSha256: "6".repeat(64),
          entryHashes: {
            main: "7".repeat(64),
            preload: "8".repeat(64),
            renderer: "9".repeat(64),
          },
          renderer,
        }),
      ),
    );
  }
  await writeFile(
    provenance,
    '{"predicateType":"https://slsa.dev/provenance/v1"}\n',
  );

  const options = {
    artifactsDirectory,
    buildRunUrl: BUILD_RUN_URL,
    ciRunUrl: CI_RUN_URL,
    createdAt: "2026-07-24T02:00:00Z",
    macosEvidence,
    nativeEvidenceDirectory: evidenceDirectory,
    offlineKeyId: KEY_ID,
    offlinePublicKey: PUBLIC_KEY,
    origin: ORIGIN,
    packageJson,
    provenance,
    repository: "Ablankpaper/aera",
    runtimeLock,
    runtimeManifestsDirectory,
    sbom,
    sourceSha: SOURCE_SHA,
    trustIssuer: ORIGIN,
    version: VERSION,
    windowsEvidence,
  };
  return { root, options };
}

// @lat: [[agentera-post-official-delivery#Production readiness and release#Platform-signed internal-Beta candidate boundary]]
test("builds one canonical internal-Beta manifest with exact identities and hashes", async () => {
  const { options } = await createFixture();
  const document = await buildInternalBetaManifest(options);

  assert.equal(document.repository, "Ablankpaper/aera");
  assert.equal(document.sourceSha, SOURCE_SHA);
  assert.equal(document.version, VERSION);
  assert.equal(document.build.ciRunUrl, CI_RUN_URL);
  assert.equal(document.build.runUrl, BUILD_RUN_URL);
  assert.equal(document.origin, ORIGIN);
  assert.deepEqual(document.offlineTrust, {
    algorithm: "Ed25519",
    issuer: ORIGIN,
    keyId: KEY_ID,
    publicKey: PUBLIC_KEY,
  });
  assert.equal(document.schemaVersion, 3);
  assert.equal(
    INTERNAL_BETA_SIGNING_STATUS,
    "macos_developer_id_notarized_windows_authenticode",
  );
  assert.equal(document.signingStatus, INTERNAL_BETA_SIGNING_STATUS);
  assert.equal(document.supplyChain.macosEvidence.name, "macos-evidence.json");
  assert.match(document.supplyChain.macosEvidence.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    document.supplyChain.windowsEvidence.name,
    "windows-evidence.json",
  );
  assert.match(document.supplyChain.windowsEvidence.sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(
    document.supplyChain.nativeEvidence.map(({ name }) => name),
    NATIVE_EVIDENCE_NAMES,
  );
  assert.deepEqual(
    document.supplyChain.packagedStartupEvidence.map(({ name }) => name),
    ["packaged-startup-macos.json", "packaged-startup-windows.json"],
  );
  assert.match(document.runtimeSeed.lockSha256, /^[0-9a-f]{64}$/u);
  assert.equal(document.runtimeSeed.sourceCommit, RUNTIME_SHA);
  assert.equal(document.runtimeSeed.channel, "candidate");
  assert.deepEqual(
    document.runtimeSeed.targets.map(({ platform, arch }) => ({
      platform,
      arch,
    })),
    [
      { platform: "darwin", arch: "arm64" },
      { platform: "windows", arch: "x64" },
    ],
  );
  assert.equal(document.artifacts.length, 5);
  assert.deepEqual(document.artifacts.slice(-1)[0], {
    name: `Aera-Internal-Beta-${VERSION}-windows-x64-app.zip`,
    platform: "windows",
    arch: "x64",
    kind: "app_zip",
    sha256: document.artifacts.at(-1).sha256,
    size: document.artifacts.at(-1).size,
  });
  assert.deepEqual(
    document.artifacts.map(({ name }) => name),
    INTERNAL_BETA_ARTIFACTS.map(({ name }) => name),
  );
  for (const artifact of document.artifacts) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(artifact.size > 0);
  }
  assert.match(document.supplyChain.sbom.sha256, /^[0-9a-f]{64}$/u);
  assert.match(document.supplyChain.provenance.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    canonicalJSONStringify(document),
    canonicalJSONStringify(validateInternalBetaManifest(document)),
  );
  await verifyInternalBetaManifestFiles(document, options);
});

test("rejects mutable package names, duplicates, missing platforms, mismatched trust, and unknown fields", async () => {
  const { options } = await createFixture();
  const valid = await buildInternalBetaManifest(options);
  const cases = [
    {
      name: "mutable filename",
      mutate(document) {
        document.artifacts[0].name = "Aera-Internal-Beta-latest.dmg";
      },
    },
    {
      name: "duplicate artifact",
      mutate(document) {
        document.artifacts.push({ ...document.artifacts[0] });
      },
    },
    {
      name: "missing platform",
      mutate(document) {
        document.artifacts = document.artifacts.filter(
          ({ platform }) => platform !== "windows",
        );
      },
    },
    {
      name: "mismatched issuer",
      mutate(document) {
        document.offlineTrust.issuer = "https://203.0.113.11";
      },
    },
    {
      name: "unknown field",
      mutate(document) {
        document.unreviewed = true;
      },
    },
  ];

  for (const entry of cases) {
    const changed = structuredClone(valid);
    entry.mutate(changed);
    assert.throws(
      () => validateInternalBetaManifest(changed),
      /artifact|platform|issuer|field|schema|origin/iu,
      entry.name,
    );
  }
});

test("rejects an unapproved Runtime commit or non-candidate channel", async () => {
  for (const runtimePatch of [
    { source_commit: "b".repeat(40) },
    { channel: "stable" },
  ]) {
    const { options } = await createFixture(runtimePatch);
    await assert.rejects(
      () => buildInternalBetaManifest(options),
      /runtime.*(commit|channel)|approved/iu,
    );
  }
});

test("rejects differing build origin and trust issuer", async () => {
  const { options } = await createFixture();
  await assert.rejects(
    () =>
      buildInternalBetaManifest({
        ...options,
        trustIssuer: "https://203.0.113.11",
      }),
    /issuer|origin/iu,
  );
});

test("rejects noncanonical manifest JSON and changed artifact bytes", async () => {
  const { options } = await createFixture();
  const document = await buildInternalBetaManifest(options);
  const noncanonical = JSON.stringify(document, null, 2);

  assert.throws(
    () => parseAndValidateInternalBetaManifest(noncanonical),
    /canonical/iu,
  );

  const firstArtifact = join(
    options.artifactsDirectory,
    INTERNAL_BETA_ARTIFACTS[0].name,
  );
  const before = await readFile(firstArtifact);
  await writeFile(
    firstArtifact,
    Buffer.concat([before, Buffer.from("changed")]),
  );
  await assert.rejects(
    () => verifyInternalBetaManifestFiles(document, options),
    /differs|digest|size/iu,
  );
});

test("rejects changed macOS signing evidence bytes", async () => {
  const { options } = await createFixture();
  const document = await buildInternalBetaManifest(options);
  await writeFile(options.macosEvidence, '{"codesignVerified":false}');

  await assert.rejects(
    () => verifyInternalBetaManifestFiles(document, options),
    /differs|digest|evidence/iu,
  );
});

test("rejects semantic macOS evidence that is unsigned or mismatched", async () => {
  for (const mutate of [
    (evidence) => {
      evidence.codesignVerified = false;
    },
    (evidence) => {
      evidence.notarizations[0].status = "Invalid";
    },
    (evidence) => {
      evidence.artifacts[0].sha256 = "f".repeat(64);
    },
    (evidence) => {
      evidence.runtimeSeedManifest.manifestSha256 = "e".repeat(64);
    },
  ]) {
    const { options } = await createFixture();
    const evidence = JSON.parse(await readFile(options.macosEvidence, "utf8"));
    mutate(evidence);
    await writeFile(options.macosEvidence, canonicalJSONStringify(evidence));

    await assert.rejects(
      () => buildInternalBetaManifest(options),
      /macOS.*(evidence|bytes|Seed|notarization|codesign|Gatekeeper)/u,
    );
  }
});

test("rejects unsigned, untimestamped, or byte-mismatched Windows evidence", async () => {
  for (const mutate of [
    (evidence) => {
      evidence.signerThumbprint = "not-a-thumbprint";
    },
    (evidence) => {
      evidence.timestampVerifiedArtifacts = [];
    },
    (evidence) => {
      evidence.artifacts[0].sha256 = "f".repeat(64);
    },
  ]) {
    const { options } = await createFixture();
    const evidence = JSON.parse(
      await readFile(options.windowsEvidence, "utf8"),
    );
    mutate(evidence);
    await writeFile(options.windowsEvidence, canonicalJSONStringify(evidence));

    await assert.rejects(
      () => buildInternalBetaManifest(options),
      /Windows.*(Authenticode|timestamp|evidence|bytes)/u,
    );
  }
});

test("rejects a missing or substituted final-container native inventory", async () => {
  {
    const { options } = await createFixture();
    await unlink(
      join(
        options.nativeEvidenceDirectory,
        "native-inventory-windows-app-zip.json",
      ),
    );
    await assert.rejects(
      () => buildInternalBetaManifest(options),
      /native.*(JSON|missing|inventory)/iu,
    );
  }
  {
    const { options } = await createFixture();
    const substituted = await readFile(
      join(options.nativeEvidenceDirectory, "native-inventory-macos-zip.json"),
    );
    await writeFile(
      join(options.nativeEvidenceDirectory, "native-inventory-macos-dmg.json"),
      substituted,
    );
    await assert.rejects(
      () => buildInternalBetaManifest(options),
      /native.*(artifact|bytes|identity)|differs from final artifact/iu,
    );
  }
});

test("rejects missing or unhealthy packaged startup evidence", async () => {
  {
    const { options } = await createFixture();
    await unlink(
      join(options.nativeEvidenceDirectory, "packaged-startup-windows.json"),
    );
    await assert.rejects(
      () => buildInternalBetaManifest(options),
      /packaged.*startup.*(JSON|missing)/iu,
    );
  }
  {
    const { options } = await createFixture();
    const path = join(
      options.nativeEvidenceDirectory,
      "packaged-startup-macos.json",
    );
    const evidence = JSON.parse(await readFile(path, "utf8"));
    evidence.renderer.bodyTextLength = 0;
    await writeFile(path, canonicalJSONStringify(evidence));
    await assert.rejects(
      () => buildInternalBetaManifest(options),
      /packaged.*startup|Renderer body/iu,
    );
  }
});
