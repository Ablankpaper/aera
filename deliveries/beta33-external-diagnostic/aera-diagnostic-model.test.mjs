/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
