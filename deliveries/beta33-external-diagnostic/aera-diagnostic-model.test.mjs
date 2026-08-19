/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  compareModelSnapshots,
  collectModelChain,
  managedModelPaths,
  snapshotManagedModelFiles,
} from "./aera-diagnostic-model.mjs";

function fixture(root) {
  const hermesHome = join(root, "hermes");
  const userData = join(root, "user-data");
  const profile = "fault-profile";
  const profileRoot = join(hermesHome, "profiles", profile);
  mkdirSync(profileRoot, { recursive: true });
  mkdirSync(join(userData, "agentera-auth"), { recursive: true });
  writeFileSync(join(hermesHome, "active_profile"), `${profile}\n`);
  writeFileSync(
    join(profileRoot, ".env"),
    "DEMO_API_KEY=fixture-super-secret\n",
  );
  writeFileSync(
    join(profileRoot, "providers.json"),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: "provider-demo",
          name: "Demo",
          baseUrl: "https://new.example/v1",
        },
      ],
    }),
  );
  writeFileSync(
    join(hermesHome, "models.json"),
    JSON.stringify([
      {
        id: "one",
        provider: "custom:provider-demo",
        model: "gpt-demo",
        baseUrl: "https://old.example/v1",
        apiMode: "chat_completions",
      },
      {
        id: "two",
        provider: "custom:provider-demo",
        model: "gpt-demo",
        baseUrl: "https://new.example/v1",
        apiMode: "chat_completions",
      },
    ]),
  );
  writeFileSync(
    join(hermesHome, "model-definitions.json"),
    JSON.stringify({
      "gpt-demo": { model: "gpt-demo", contextLength: 1000000 },
    }),
  );
  writeFileSync(
    join(profileRoot, "config.yaml"),
    [
      "model:",
      '  default: "gpt-demo"',
      '  provider: "custom:provider-demo"',
      '  base_url: "https://new.example/v1"',
      '  api_mode: "chat_completions"',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(userData, "agentera-auth", "state.json"),
    JSON.stringify({
      installation: { installationId: "installation-secret" },
      productSession: {
        personalSpaceId: "tenant-secret",
        userId: "owner-secret",
        encryptedRefreshToken: "refresh-secret",
      },
    }),
  );
  return { hermesHome, userData, profile, profileRoot };
}

test("captures all five managed files and dirty route relations without raw bodies", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-model-chain-test-"));
  try {
    const setup = fixture(root);
    const result = collectModelChain(setup);
    assert.equal(result.status, "collected");
    assert.deepEqual(result.requiredRoles, [
      "env",
      "providers",
      "models",
      "modelDefinitions",
      "config",
    ]);
    assert.deepEqual(
      result.files.map((entry) => entry.role).sort(),
      [...result.requiredRoles].sort(),
    );
    assert.equal(result.routeCatalog.duplicateEndpointGroups.length, 1);
    assert.equal(
      result.routeCatalog.duplicateEndpointGroups[0].endpointCount,
      2,
    );
    assert.equal(result.routeCatalog.currentCandidates.length, 2);
    assert.equal(result.owner.available, true);
    assert.match(result.owner.ownerSha256, /^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(
      serialized,
      /fixture-super-secret|refresh-secret|owner-secret|tenant-secret|installation-secret/,
    );
    assert.doesNotMatch(serialized, /https:\/\/(?:old|new)\.example/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not collect a missing or invalid route JSON catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-route-catalog-state-test-"));
  try {
    const missing = collectModelChain({
      hermesHome: join(root, "missing-hermes"),
      userData: join(root, "missing-user-data"),
      profile: "default",
    });
    assert.equal(missing.routeCatalog.status, "missing");
    assert.equal(missing.routeCatalog.reason, "route_catalog_source_missing");

    const setup = fixture(root);
    writeFileSync(join(setup.hermesHome, "models.json"), "{not-json");
    const invalid = collectModelChain(setup);
    assert.equal(invalid.routeCatalog.status, "failed");
    assert.equal(invalid.routeCatalog.reason, "route_catalog_source_invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marks an unreadable route JSON source failed", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-route-catalog-unreadable-test-"));
  try {
    const setup = fixture(root);
    const providers = join(setup.profileRoot, "providers.json");
    rmSync(providers);
    mkdirSync(providers);
    const result = collectModelChain(setup);
    assert.equal(result.routeCatalog.status, "failed");
    assert.equal(
      result.routeCatalog.reason,
      "route_catalog_source_unreadable",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("records backup directory traversal failures instead of an empty collection", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-backup-traversal-test-"));
  try {
    const setup = fixture(root);
    const result = collectModelChain({
      ...setup,
      readDirectory() {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      },
    });
    assert.deepEqual(result.backups, []);
    assert.equal(result.backupEvidence?.status, "failed");
    assert.equal(result.backupEvidence?.reason, "backup_traversal_failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compares before and after snapshots and records exact changed roles", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-model-compare-test-"));
  try {
    const setup = fixture(root);
    const paths = managedModelPaths(setup.hermesHome, setup.profile);
    const before = snapshotManagedModelFiles(paths, "before");
    writeFileSync(paths.models, "[]\n");
    const after = snapshotManagedModelFiles(paths, "after");
    assert.deepEqual(compareModelSnapshots(before, after).changedRoles, [
      "models",
    ]);
    assert.equal(compareModelSnapshots(before, after).unchangedRoles.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ships one fixed five-file model-chain replay fixture", () => {
  const fixtureRoot = new URL("fixtures/model-chain/", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(new URL("fixture-manifest.json", fixtureRoot), "utf8"),
  );
  const before = JSON.parse(
    readFileSync(new URL("redacted-before.json", fixtureRoot), "utf8"),
  );
  const after = JSON.parse(
    readFileSync(new URL("redacted-after.json", fixtureRoot), "utf8"),
  );
  assert.deepEqual(manifest.requiredRoles, [
    "env",
    "providers",
    "models",
    "modelDefinitions",
    "config",
  ]);
  assert.deepEqual(before.files.map((entry) => entry.role), manifest.requiredRoles);
  assert.deepEqual(after.files.map((entry) => entry.role), manifest.requiredRoles);
  assert.equal(before.journal.state, "recovery_required");
  assert.equal(after.journal.state, "rolled_back");
  assert.equal(after.route.authoritativeEndpointCount, 1);
  assert.doesNotMatch(JSON.stringify({ manifest, before, after }), /api[_-]?key|authorization|bearer|https?:\/\//iu);
});
