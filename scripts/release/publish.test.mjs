/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import { parse as parseYAML } from "yaml";

import {
  buildUpdateMetadata,
  canonicalJSONStringify,
  hashArtifact,
} from "./candidate-manifest.mjs";
import {
  promoteDesktopRelease,
  validateProductionDeploymentEvidence,
  validateProductionGateDocument,
  validateProductionRunSequence,
} from "./publish.mjs";

const SOURCE_SHA = "a".repeat(40);
const CLOUD_SHA = "b".repeat(40);
const ADMIN_SHA = "c".repeat(40);
const VERSION = "0.7.3";
const CLOUD_DIGEST = `sha256:${"d".repeat(64)}`;
const ADMIN_DIGEST = `sha256:${"e".repeat(64)}`;
const CLOUD_MANIFEST_SHA256 = "1".repeat(64);
const ADMIN_MANIFEST_SHA256 = "2".repeat(64);

test("downloads, verifies, tags, and publishes exact candidate bytes", async () => {
  const fixture = await promotionFixture();
  const calls = [];
  const github = fakeGitHub({
    fixture,
    calls,
    resolvedTag: null,
    existingRelease: null,
  });

  const result = await promoteDesktopRelease(fixture.options, {
    github,
    verifyDeviceEvidenceFile: async (context) => {
      calls.push(["verify-device", context.candidateManifestSha256]);
    },
    verifyStagingEvidenceFile: async (context) => {
      calls.push(["verify-staging", context.desktopCandidateManifestSha256]);
    },
  });

  assert.equal(result.status, "published");
  assert.equal(result.tag, `v${VERSION}`);
  assert.deepEqual(
    calls.filter(([name]) => name === "download-candidate"),
    [["download-candidate", "1234", `desktop-candidate-${SOURCE_SHA}`]],
  );
  assert.ok(calls.some(([name]) => name === "verify-device"));
  assert.ok(calls.some(([name]) => name === "verify-staging"));

  const mutationIndex = calls.findIndex(([name]) => name === "create-tag");
  assert.ok(mutationIndex > 0);
  for (const required of [
    "verify-attestation",
    "verify-device",
    "verify-staging",
    "validate-production-gate",
  ]) {
    assert.ok(
      calls.findIndex(([name]) => name === required) < mutationIndex,
      `${required} must complete before the first mutation`,
    );
  }
  assert.deepEqual(calls[mutationIndex], [
    "create-tag",
    `v${VERSION}`,
    SOURCE_SHA,
  ]);

  const uploads = calls
    .filter(([name]) => name === "upload")
    .map(([, path]) => basename(path))
    .sort();
  assert.deepEqual(uploads, fixture.expectedReleaseAssets);
  assert.equal(calls.at(-1)[0], "publish-release");
  assert.equal(
    calls.some(([name]) =>
      ["build", "electron-builder", "prepare-runtime-seed"].includes(name),
    ),
    false,
  );
});

test("rejects an existing tag that resolves to another source commit", async () => {
  const fixture = await promotionFixture();
  const calls = [];
  const github = fakeGitHub({
    fixture,
    calls,
    resolvedTag: "f".repeat(40),
    existingRelease: null,
  });

  await assert.rejects(
    promoteDesktopRelease(fixture.options, {
      github,
      verifyDeviceEvidenceFile: async () => {},
      verifyStagingEvidenceFile: async () => {},
    }),
    /tag.*different source commit/iu,
  );
  assert.equal(
    calls.some(([name]) =>
      ["create-tag", "create-release", "upload", "publish-release"].includes(
        name,
      ),
    ),
    false,
  );
});

test("rejects changed candidate bytes before any GitHub mutation", async () => {
  const fixture = await promotionFixture();
  await writeFile(
    join(fixture.candidateSource, "artifacts", fixture.targetArtifact),
    "tampered bytes\n",
  );
  const calls = [];
  const github = fakeGitHub({
    fixture,
    calls,
    resolvedTag: null,
    existingRelease: null,
  });

  await assert.rejects(
    promoteDesktopRelease(fixture.options, {
      github,
      verifyDeviceEvidenceFile: async () => {},
      verifyStagingEvidenceFile: async () => {},
    }),
    /hash differs|checksum/iu,
  );
  assert.equal(
    calls.some(([name]) =>
      ["create-tag", "create-release", "upload", "publish-release"].includes(
        name,
      ),
    ),
    false,
  );
});

test("requires exact legal, provider, domain, rollout, and approval gates", () => {
  const gate = productionGate({
    candidateManifestSha256: "3".repeat(64),
    deviceEvidenceSha256: "4".repeat(64),
    stagingEvidenceSha256: "5".repeat(64),
    stagingSignatureSha256: "6".repeat(64),
  });
  const expected = gateExpectations(gate);
  assert.doesNotThrow(() => validateProductionGateDocument(gate, expected));

  for (const mutate of [
    (document) => {
      document.legal.privacyPolicyApproved = false;
    },
    (document) => {
      document.providers.objectStorageReady = false;
    },
    (document) => {
      document.domain.productionOrigin = "https://127.0.0.1";
    },
    (document) => {
      document.approval.publicDesktopReleaseApproved = false;
    },
  ]) {
    const malformed = structuredClone(gate);
    mutate(malformed);
    assert.throws(
      () => validateProductionGateDocument(malformed, expected),
      /legal|provider|domain|origin|approval/iu,
    );
  }
});

test("requires disabled Cloud, disabled Admin, enabled Cloud, enabled Admin order", () => {
  const sequence = {
    cloudDisabled: productionRun({
      repository: "Ablankpaper/aera-cloud",
      workflowName: "Promote Cloud candidate to production",
      sourceSha: CLOUD_SHA,
      runId: "2101",
      startedAt: "2026-07-23T10:00:00Z",
      completedAt: "2026-07-23T10:10:00Z",
      enableName: "Apply separately approved production cohort",
      enableConclusion: "skipped",
    }),
    adminDisabled: productionRun({
      repository: "Ablankpaper/aera-admin",
      workflowName: "Promote Admin candidate to production",
      sourceSha: ADMIN_SHA,
      runId: "2102",
      startedAt: "2026-07-23T10:11:00Z",
      completedAt: "2026-07-23T10:21:00Z",
      enableName: "Enable mutations only after separate production approval",
      enableConclusion: "skipped",
    }),
    cloudEnabled: productionRun({
      repository: "Ablankpaper/aera-cloud",
      workflowName: "Promote Cloud candidate to production",
      sourceSha: CLOUD_SHA,
      runId: "2103",
      startedAt: "2026-07-23T10:22:00Z",
      completedAt: "2026-07-23T10:32:00Z",
      enableName: "Apply separately approved production cohort",
      enableConclusion: "success",
    }),
    adminEnabled: productionRun({
      repository: "Ablankpaper/aera-admin",
      workflowName: "Promote Admin candidate to production",
      sourceSha: ADMIN_SHA,
      runId: "2104",
      startedAt: "2026-07-23T10:33:00Z",
      completedAt: "2026-07-23T10:43:00Z",
      enableName: "Enable mutations only after separate production approval",
      enableConclusion: "success",
    }),
  };
  const expected = {
    cloudSourceSha: CLOUD_SHA,
    adminSourceSha: ADMIN_SHA,
    cloudDisabledRunId: "2101",
    adminDisabledRunId: "2102",
    cloudEnabledRunId: "2103",
    adminEnabledRunId: "2104",
  };
  assert.doesNotThrow(() => validateProductionRunSequence(sequence, expected));

  const outOfOrder = structuredClone(sequence);
  outOfOrder.adminDisabled.startedTime = "2026-07-23T10:09:00Z";
  assert.throws(
    () => validateProductionRunSequence(outOfOrder, expected),
    /order/iu,
  );
});

test("requires exact disabled and enabled deployment state artifacts", () => {
  const gate = productionGate({
    candidateManifestSha256: "3".repeat(64),
    deviceEvidenceSha256: "4".repeat(64),
    stagingEvidenceSha256: "5".repeat(64),
    stagingSignatureSha256: "6".repeat(64),
  });
  const fixture = productionDeploymentEvidence();
  const evidence = fixture.evidence;
  assert.doesNotThrow(() =>
    validateProductionDeploymentEvidence(evidence, {
      cloudSourceSha: CLOUD_SHA,
      cloudImageDigest: CLOUD_DIGEST,
      cloudCandidateManifestSha256: fixture.cloudManifestSha256,
      adminSourceSha: ADMIN_SHA,
      adminImageDigest: ADMIN_DIGEST,
      adminCandidateManifestSha256: fixture.adminManifestSha256,
      rollout: gate.rollout,
    }),
  );

  const tampered = structuredClone(evidence);
  const state = JSON.parse(tampered.cloudEnabled.stateRaw);
  state.features.encryptedBackup = false;
  tampered.cloudEnabled.stateRaw = canonicalJSONStringify(state);
  assert.throws(
    () =>
      validateProductionDeploymentEvidence(tampered, {
        cloudSourceSha: CLOUD_SHA,
        cloudImageDigest: CLOUD_DIGEST,
        cloudCandidateManifestSha256: fixture.cloudManifestSha256,
        adminSourceSha: ADMIN_SHA,
        adminImageDigest: ADMIN_DIGEST,
        adminCandidateManifestSha256: fixture.adminManifestSha256,
        rollout: gate.rollout,
      }),
    /feature|rollout/iu,
  );
});

test("production workflow is protected and never rebuilds candidate bytes", async () => {
  const workflowPath = join(
    import.meta.dirname,
    "..",
    "..",
    ".github",
    "workflows",
    "promote-release.yml",
  );
  const raw = await readFile(workflowPath, "utf8");
  const workflow = parseYAML(raw);
  assert.equal(Object.keys(workflow.on.workflow_dispatch.inputs).length, 10);
  assert.equal(workflow.jobs.promote.environment, "production");
  assert.equal(workflow.permissions.contents, "write");
  assert.match(raw, /gh run download/u);
  assert.match(raw, /validateProductionRunSequence/u);
  assert.match(raw, /validateProductionDeploymentEvidence/u);
  assert.match(raw, /cloud-production-enabled-/u);
  assert.match(raw, /admin-production-enabled-/u);
  assert.match(raw, /scripts\/release\/publish\.mjs/u);
  assert.doesNotMatch(
    raw,
    /\bnpm\s+(?:run\s+)?build\b|\belectron-builder\b|prepare:runtime-seed/iu,
  );
  const order = [
    "cloud-disabled.json",
    "admin-disabled.json",
    "cloud-enabled.json",
    "admin-enabled.json",
  ].map((marker) => raw.indexOf(marker));
  assert.ok(order.every((position) => position >= 0));
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
  );
});

function fakeGitHub({ fixture, calls, resolvedTag, existingRelease }) {
  return {
    async getWorkflowRun({ runId }) {
      calls.push(["view-run", runId]);
      return {
        workflowName: "Desktop signed candidate",
        conclusion: "success",
        headSha: SOURCE_SHA,
        url: "https://github.com/Ablankpaper/aera/actions/runs/1234",
        jobs: Array.from({ length: 3 }, () => ({
          conclusion: "success",
          steps: [{ conclusion: "success" }],
        })),
      };
    },
    async downloadWorkflowArtifact({ runId, artifactName, destination }) {
      calls.push(["download-candidate", runId, artifactName]);
      await cp(fixture.candidateSource, destination, { recursive: true });
    },
    async verifyAttestation({ path }) {
      calls.push(["verify-attestation", basename(path)]);
    },
    async resolveTag() {
      calls.push(["resolve-tag"]);
      return resolvedTag;
    },
    async createAnnotatedTag({ tag, sourceSha }) {
      calls.push(["create-tag", tag, sourceSha]);
    },
    async getReleaseByTag() {
      calls.push(["get-release"]);
      return existingRelease;
    },
    async createDraftRelease({ tag }) {
      calls.push(["create-release", tag]);
      return { id: 9876, draft: true };
    },
    async uploadReleaseAsset({ path }) {
      calls.push(["upload", path]);
    },
    async publishRelease({ releaseId }) {
      calls.push(["publish-release", releaseId]);
      return {
        id: releaseId,
        url: `https://github.com/Ablankpaper/aera/releases/tag/v${VERSION}`,
      };
    },
    markProductionGateValidated() {
      calls.push(["validate-production-gate"]);
    },
  };
}

function productionRun({
  repository,
  workflowName,
  sourceSha,
  runId,
  startedAt,
  completedAt,
  enableName,
  enableConclusion,
}) {
  return {
    workflowName,
    conclusion: "success",
    headSha: sourceSha,
    url: `https://github.com/${repository}/actions/runs/${runId}`,
    startedTime: startedAt,
    updatedAt: completedAt,
    jobs: [
      {
        name:
          repository === "Ablankpaper/aera-cloud"
            ? "Deploy exact digest with every new feature disabled"
            : "Deploy exact digest with mutations disabled",
        conclusion: "success",
        steps: [{ conclusion: "success" }],
      },
      {
        name: enableName,
        conclusion: enableConclusion,
        steps:
          enableConclusion === "success"
            ? [{ conclusion: "success" }]
            : [{ conclusion: "skipped" }],
      },
    ],
  };
}

async function promotionFixture() {
  const root = await mkdtemp(join(tmpdir(), "aera-publish-test-"));
  const candidateSource = join(root, "candidate-source");
  const artifactsDirectory = join(candidateSource, "artifacts");
  const evidenceDirectory = join(candidateSource, "evidence");
  await mkdir(artifactsDirectory, { recursive: true });
  await mkdir(evidenceDirectory, { recursive: true });

  const artifactPaths = {
    macDmg: join(artifactsDirectory, `Aera-${VERSION}-arm64.dmg`),
    macZip: join(
      artifactsDirectory,
      `Aera-${VERSION}-arm64-mac.zip`,
    ),
    windowsSetup: join(
      artifactsDirectory,
      `Aera-${VERSION}-setup.exe`,
    ),
    windowsPortable: join(
      artifactsDirectory,
      `Aera-${VERSION}-portable.exe`,
    ),
    latestMac: join(artifactsDirectory, "latest-mac.yml"),
    latestWindows: join(artifactsDirectory, "latest.yml"),
  };
  await Promise.all([
    writeFile(artifactPaths.macDmg, "signed macOS DMG\n"),
    writeFile(artifactPaths.macZip, "signed macOS ZIP\n"),
    writeFile(artifactPaths.windowsSetup, "signed Windows setup\n"),
    writeFile(artifactPaths.windowsPortable, "signed Windows portable\n"),
  ]);
  const macZipHash = await hashArtifact(artifactPaths.macZip);
  const windowsSetupHash = await hashArtifact(artifactPaths.windowsSetup);
  await Promise.all([
    writeFile(
      artifactPaths.latestMac,
      buildUpdateMetadata({
        version: VERSION,
        target: {
          name: basename(artifactPaths.macZip),
          size: macZipHash.size,
          sha512: Buffer.from(macZipHash.sha512, "hex").toString("base64"),
        },
        releaseDate: "2026-07-23T09:00:00Z",
      }),
    ),
    writeFile(
      artifactPaths.latestWindows,
      buildUpdateMetadata({
        version: VERSION,
        target: {
          name: basename(artifactPaths.windowsSetup),
          size: windowsSetupHash.size,
          sha512: Buffer.from(windowsSetupHash.sha512, "hex").toString(
            "base64",
          ),
        },
        releaseDate: "2026-07-23T09:00:00Z",
      }),
    ),
  ]);

  const [
    macDmg,
    macZip,
    windowsSetup,
    windowsPortable,
    latestMac,
    latestWindows,
  ] = await Promise.all(
    Object.entries(artifactPaths).map(async ([key, path]) => ({
      key,
      ...(await hashArtifact(path)),
      name: basename(path),
    })),
  );
  const runtimeLockPath = join(
    evidenceDirectory,
    "agentera-runtime-seed.lock.json",
  );
  const sbomPath = join(evidenceDirectory, "sbom.spdx.json");
  const provenancePath = join(evidenceDirectory, "provenance.json");
  await Promise.all([
    writeFile(
      runtimeLockPath,
      `${JSON.stringify({
        source_commit: "7".repeat(40),
        runtime_version: "0.18.2-agentera.1",
      })}\n`,
    ),
    writeFile(sbomPath, '{"spdxVersion":"SPDX-2.3"}\n'),
    writeFile(provenancePath, '{"schemaVersion":1}\n'),
    writeFile(
      join(evidenceDirectory, "github-attestation.json"),
      '{"bundle":"test-only"}\n',
    ),
  ]);
  const [runtimeLock, sbom, provenance] = await Promise.all([
    hashArtifact(runtimeLockPath),
    hashArtifact(sbomPath),
    hashArtifact(provenancePath),
  ]);

  const candidate = {
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
      lockSha256: runtimeLock.sha256,
      sourceCommit: "7".repeat(40),
      runtimeVersion: "0.18.2-agentera.1",
      targets: [
        {
          platform: "macos",
          arch: "arm64",
          manifest:
            "agentera-runtime-0.18.2-agentera.1-darwin-arm64.manifest.json",
          manifestSha256: "8".repeat(64),
        },
        {
          platform: "windows",
          arch: "x64",
          manifest:
            "agentera-runtime-0.18.2-agentera.1-windows-x64.manifest.json",
          manifestSha256: "9".repeat(64),
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
      releaseArtifact(macDmg, "macos", "arm64", "macos_dmg"),
      releaseArtifact(macZip, "macos", "arm64", "macos_zip"),
      releaseArtifact(windowsSetup, "windows", "x64", "windows_setup"),
      releaseArtifact(windowsPortable, "windows", "x64", "windows_portable"),
      releaseArtifact(latestMac, "macos", "arm64", "update_metadata"),
      releaseArtifact(latestWindows, "windows", "x64", "update_metadata"),
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
      sbom: { name: "sbom.spdx.json", sha256: sbom.sha256 },
      provenance: { name: "provenance.json", sha256: provenance.sha256 },
      githubAttestation: {
        required: true,
        signerWorkflow:
          "github.com/Ablankpaper/aera/.github/workflows/release-candidate.yml",
      },
    },
    linuxReleasable: false,
    createdAt: "2026-07-23T09:00:00Z",
  };
  const candidateManifestPath = join(
    candidateSource,
    "candidate-manifest.json",
  );
  await writeFile(candidateManifestPath, canonicalJSONStringify(candidate));
  const candidateManifestRaw = await readFile(candidateManifestPath);
  const candidateManifestSha256 = sha256(candidateManifestRaw);

  const checksummedPaths = [
    ...Object.values(artifactPaths),
    runtimeLockPath,
    sbomPath,
    provenancePath,
    candidateManifestPath,
  ];
  const checksumLines = [];
  for (const path of checksummedPaths) {
    const relative = path.slice(candidateSource.length + 1);
    checksumLines.push(`${sha256(await readFile(path))}  ${relative}`);
  }
  checksumLines.sort();
  await writeFile(
    join(evidenceDirectory, "SHA256SUMS"),
    `${checksumLines.join("\n")}\n`,
  );

  const deviceEvidencePath = join(root, "device-evidence.json");
  const stagingEvidencePath = join(root, "staging-evidence.json");
  const stagingSignaturePath = join(root, "staging-evidence.sig");
  const stagingPublicKeyPath = join(root, "staging-public.pem");
  for (const [path, contents] of [
    [deviceEvidencePath, '{"schemaVersion":1}\n'],
    [stagingEvidencePath, '{"schemaVersion":1}\n'],
    [stagingSignaturePath, Buffer.alloc(64, 1)],
    [stagingPublicKeyPath, "test public key\n"],
  ]) {
    await writeFile(path, contents);
  }
  const [deviceEvidenceSha256, stagingEvidenceSha256, stagingSignatureSha256] =
    await Promise.all([
      fileSha256(deviceEvidencePath),
      fileSha256(stagingEvidencePath),
      fileSha256(stagingSignaturePath),
    ]);
  const gate = productionGate({
    candidateManifestSha256,
    deviceEvidenceSha256,
    stagingEvidenceSha256,
    stagingSignatureSha256,
  });
  const productionGatePath = join(root, "production-gate.json");
  await writeFile(productionGatePath, canonicalJSONStringify(gate));
  const productionGateSha256 = await fileSha256(productionGatePath);

  const workspace = join(root, "workspace");
  return {
    candidateSource,
    targetArtifact: macDmg.name,
    expectedReleaseAssets: [
      "SHA256SUMS",
      "candidate-manifest.json",
      macDmg.name,
      macZip.name,
      windowsPortable.name,
      windowsSetup.name,
      latestMac.name,
      latestWindows.name,
      "provenance.json",
      "sbom.spdx.json",
    ].sort(),
    options: {
      repository: "Ablankpaper/aera",
      candidateRunId: "1234",
      sourceSha: SOURCE_SHA,
      candidateManifestSha256,
      cloudSourceSha: CLOUD_SHA,
      cloudImageDigest: CLOUD_DIGEST,
      cloudCandidateManifestSha256: CLOUD_MANIFEST_SHA256,
      cloudDisabledRunId: "2101",
      cloudEnabledRunId: "2103",
      adminSourceSha: ADMIN_SHA,
      adminImageDigest: ADMIN_DIGEST,
      adminCandidateManifestSha256: ADMIN_MANIFEST_SHA256,
      adminDisabledRunId: "2102",
      adminEnabledRunId: "2104",
      deviceEvidencePath,
      deviceEvidenceSha256,
      stagingEvidencePath,
      stagingEvidenceSha256,
      stagingSignaturePath,
      stagingSignatureSha256,
      stagingPublicKeyPath,
      productionGatePath,
      productionGateSha256,
      releaseTag: `v${VERSION}`,
      workspace,
    },
  };
}

function releaseArtifact(hash, platform, arch, kind) {
  return {
    name: hash.name,
    platform,
    arch,
    kind,
    size: hash.size,
    sha256: hash.sha256,
    sha512: hash.sha512,
    releasable: true,
  };
}

function productionGate({
  candidateManifestSha256,
  deviceEvidenceSha256,
  stagingEvidenceSha256,
  stagingSignatureSha256,
}) {
  return {
    schemaVersion: 1,
    decision: "approved",
    desktop: {
      repository: "Ablankpaper/aera",
      sourceSha: SOURCE_SHA,
      version: VERSION,
      candidateManifestSha256,
    },
    cloud: {
      repository: "Ablankpaper/aera-cloud",
      sourceSha: CLOUD_SHA,
      imageDigest: CLOUD_DIGEST,
      candidateManifestSha256: CLOUD_MANIFEST_SHA256,
    },
    admin: {
      repository: "Ablankpaper/aera-admin",
      sourceSha: ADMIN_SHA,
      imageDigest: ADMIN_DIGEST,
      candidateManifestSha256: ADMIN_MANIFEST_SHA256,
    },
    evidence: {
      deviceEvidenceSha256,
      stagingEvidenceSha256,
      stagingSignatureSha256,
    },
    deploymentRuns: {
      cloudDisabledRunId: "2101",
      adminDisabledRunId: "2102",
      cloudEnabledRunId: "2103",
      adminEnabledRunId: "2104",
    },
    legal: {
      privacyPolicyApproved: true,
      termsApproved: true,
      dataProcessingApproved: true,
      evidenceUrl:
        "https://github.com/Ablankpaper/aera/actions/runs/1300/artifacts/1400",
      evidenceSha256: "a".repeat(64),
    },
    providers: {
      identityReady: true,
      emailReady: true,
      paymentsReady: true,
      objectStorageReady: true,
      observabilityReady: true,
      productionCredentialsVerified: true,
      evidenceUrl:
        "https://github.com/Ablankpaper/aera/actions/runs/1300/artifacts/1401",
      evidenceSha256: "b".repeat(64),
    },
    domain: {
      productionOrigin: "https://api.aera.example",
      identityIssuer: "https://identity.aera.example",
      dnsApproved: true,
      tlsValidated: true,
      evidenceUrl:
        "https://github.com/Ablankpaper/aera/actions/runs/1300/artifacts/1402",
      evidenceSha256: "c".repeat(64),
    },
    rollout: {
      cloudCanaryPercent: 5,
      cloudMonitoringMinutes: 30,
      desktopCanaryPercent: 5,
      desktopMonitoringMinutes: 60,
      publicRegistrationEnabled: false,
      officialAgentsEnabled: true,
      officialQualityEnabled: true,
      encryptedBackupEnabled: true,
      adminMutationsEnabled: true,
    },
    approval: {
      approverIdentityRef: "employee:release-owner",
      responsibility: "release_approver",
      approvedAt: "2026-07-23T10:00:00Z",
      changeTicketUrl: "https://github.com/Ablankpaper/aera/actions/runs/1300",
      productionDeployApproved: true,
      publicDesktopReleaseApproved: true,
    },
  };
}

function gateExpectations(gate) {
  return {
    desktopSourceSha: gate.desktop.sourceSha,
    desktopVersion: gate.desktop.version,
    desktopCandidateManifestSha256: gate.desktop.candidateManifestSha256,
    cloudSourceSha: gate.cloud.sourceSha,
    cloudImageDigest: gate.cloud.imageDigest,
    cloudCandidateManifestSha256: gate.cloud.candidateManifestSha256,
    adminSourceSha: gate.admin.sourceSha,
    adminImageDigest: gate.admin.imageDigest,
    adminCandidateManifestSha256: gate.admin.candidateManifestSha256,
    deviceEvidenceSha256: gate.evidence.deviceEvidenceSha256,
    stagingEvidenceSha256: gate.evidence.stagingEvidenceSha256,
    stagingSignatureSha256: gate.evidence.stagingSignatureSha256,
    cloudDisabledRunId: gate.deploymentRuns.cloudDisabledRunId,
    adminDisabledRunId: gate.deploymentRuns.adminDisabledRunId,
    cloudEnabledRunId: gate.deploymentRuns.cloudEnabledRunId,
    adminEnabledRunId: gate.deploymentRuns.adminEnabledRunId,
    now: new Date("2026-07-23T10:05:00Z"),
  };
}

function productionDeploymentEvidence() {
  const cloudManifest = canonicalJSONStringify({
    schemaVersion: 1,
    repository: "Ablankpaper/aera-cloud",
    commitSha: CLOUD_SHA,
    image: {
      reference: `ghcr.io/ablankpaper/aera-cloud@${CLOUD_DIGEST}`,
      digest: CLOUD_DIGEST,
    },
  });
  const adminManifest = canonicalJSONStringify({
    schemaVersion: 1,
    repository: "Ablankpaper/aera-admin",
    commitSha: ADMIN_SHA,
    image: {
      reference: `ghcr.io/ablankpaper/aera-admin@${ADMIN_DIGEST}`,
      digest: ADMIN_DIGEST,
    },
  });
  const cloudState = (features) =>
    canonicalJSONStringify({
      environment: "production",
      current: {
        commitSha: CLOUD_SHA,
        imageReference: `ghcr.io/ablankpaper/aera-cloud@${CLOUD_DIGEST}`,
        imageDigest: CLOUD_DIGEST,
        deployedAt: "2026-07-23T10:30:00Z",
      },
      previousImageDigest: null,
      features,
    });
  const adminState = (mutationsEnabled) =>
    canonicalJSONStringify({
      environment: "production",
      current: {
        commitSha: ADMIN_SHA,
        imageReference: `ghcr.io/ablankpaper/aera-admin@${ADMIN_DIGEST}`,
        imageDigest: ADMIN_DIGEST,
        deployedAt: "2026-07-23T10:40:00Z",
      },
      previousImageDigest: null,
      mutationsEnabled,
      cloudDualAuthentication: "passed",
      cloudCompatibility: "passed",
      restoreVerification: "passed",
    });
  const disabledCloudFeatures = {
    publicRegistration: false,
    officialAgents: false,
    officialQuality: false,
    encryptedBackup: false,
  };
  const enabledCloudFeatures = {
    publicRegistration: false,
    officialAgents: true,
    officialQuality: true,
    encryptedBackup: true,
  };
  return {
    cloudManifestSha256: sha256(cloudManifest),
    adminManifestSha256: sha256(adminManifest),
    evidence: {
      cloudDisabled: {
        stateRaw: cloudState(disabledCloudFeatures),
        manifestRaw: cloudManifest,
      },
      adminDisabled: {
        stateRaw: adminState(false),
        manifestRaw: adminManifest,
      },
      cloudEnabled: {
        stateRaw: cloudState(enabledCloudFeatures),
        manifestRaw: cloudManifest,
      },
      adminEnabled: {
        stateRaw: adminState(true),
        manifestRaw: adminManifest,
      },
    },
  };
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
