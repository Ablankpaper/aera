/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { INTERNAL_BETA_ARTIFACTS } from "./manifest.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_PATH = join(
  REPO_ROOT,
  ".github",
  "workflows",
  "internal-beta.yml",
);

const COLLECTOR_TARGETS = [
  { platform: "macos", variable: "mac" },
  { platform: "windows", variable: "windows" },
];

const FIND_PATTERN =
  /entry\.platform === "(?<platform>[a-z0-9_]+)" && entry\.kind === "(?<kind>[a-z0-9_]+)"/gu;

function canonicalKinds() {
  const kinds = new Map();
  for (const artifact of INTERNAL_BETA_ARTIFACTS) {
    if (!kinds.has(artifact.platform)) kinds.set(artifact.platform, new Set());
    kinds.get(artifact.platform).add(artifact.kind);
  }
  return kinds;
}

// @lat: [[release-source-governance#Release Source Governance#Internal Beta collector artifact kinds#Collector artifact kinds match manifest]]
test("collector lookups only use artifact kinds declared by manifest.mjs", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");
  const kinds = canonicalKinds();
  const matches = [...workflow.matchAll(FIND_PATTERN)];

  assert.equal(
    matches.length,
    COLLECTOR_TARGETS.length,
    "internal-beta.yml must resolve exactly one collector target per platform",
  );

  for (const match of matches) {
    const { platform, kind } = match.groups;
    const declared = kinds.get(platform);
    assert.ok(
      declared,
      `internal-beta.yml queries unknown artifact platform "${platform}"`,
    );
    assert.ok(
      declared.has(kind),
      `internal-beta.yml queries artifact kind "${kind}" for platform "${platform}", ` +
        `but manifest.mjs only declares: ${[...declared].sort().join(", ")}`,
    );
  }
});

// @lat: [[release-source-governance#Release Source Governance#Internal Beta collector artifact kinds#Collector targets resolve to a single artifact]]
test("each collector target resolves to exactly one manifest artifact", async () => {
  const workflow = await readFile(WORKFLOW_PATH, "utf8");

  for (const { platform, variable } of COLLECTOR_TARGETS) {
    const pattern = new RegExp(
      `const ${variable} = manifest\\.artifacts\\.find\\(\\(entry\\) => ` +
        `entry\\.platform === "${platform}" && entry\\.kind === "(?<kind>[a-z0-9_]+)"\\)`,
      "u",
    );
    const match = workflow.match(pattern);
    assert.ok(
      match,
      `internal-beta.yml is missing the ${platform} collector target lookup`,
    );

    const resolved = INTERNAL_BETA_ARTIFACTS.filter(
      (artifact) =>
        artifact.platform === platform && artifact.kind === match.groups.kind,
    );
    assert.equal(
      resolved.length,
      1,
      `${platform}/${match.groups.kind} must match exactly one manifest artifact`,
    );
  }
});
