/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./verify-ci-checkpoint.mjs", import.meta.url);
const sha = (fill) => fill.repeat(40);
const completedAt = "2026-07-23T08:30:00.000Z";
const committedAt = "2026-07-23T08:00:00.000Z";

function checkpoint(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: completedAt,
    repositories: [
      {
        repository: "Ablankpaper/aera",
        commitSha: sha("a"),
        commitCommittedAt: committedAt,
        workflowName: "CI",
        runUrl: "https://github.com/Ablankpaper/aera/actions/runs/1001",
        conclusion: "success",
        completedAt,
        jobs: [
          {
            name: "check (ubuntu-latest)",
            platform: "ubuntu-latest",
            conclusion: "success",
            stepsExecuted: 9,
          },
          {
            name: "check (macos-latest)",
            platform: "macos-latest",
            conclusion: "success",
            stepsExecuted: 8,
          },
          {
            name: "check (windows-latest)",
            platform: "windows-latest",
            conclusion: "success",
            stepsExecuted: 8,
          },
        ],
      },
      {
        repository: "Ablankpaper/aera-cloud",
        commitSha: sha("b"),
        commitCommittedAt: committedAt,
        workflowName: "Aera cloud CI",
        runUrl: "https://github.com/Ablankpaper/aera-cloud/actions/runs/1002",
        conclusion: "success",
        completedAt,
        jobs: [
          {
            name: "verify",
            platform: "ubuntu-24.04",
            conclusion: "success",
            stepsExecuted: 10,
          },
        ],
      },
      {
        repository: "Ablankpaper/aera-admin",
        commitSha: sha("c"),
        commitCommittedAt: committedAt,
        workflowName: "Aera Admin CI",
        runUrl: "https://github.com/Ablankpaper/aera-admin/actions/runs/1003",
        conclusion: "success",
        completedAt,
        jobs: [
          {
            name: "verify",
            platform: "ubuntu-24.04",
            conclusion: "success",
            stepsExecuted: 12,
          },
        ],
      },
    ],
    ...overrides,
  };
}

async function verify(manifest, expected = {}) {
  const root = await mkdtemp(join(tmpdir(), "aera-ci-checkpoint-"));
  const path = join(root, "checkpoint.json");
  await writeFile(path, `${JSON.stringify(manifest)}\n`, "utf8");
  const args = [
    script.pathname,
    path,
    "--expect",
    `Ablankpaper/aera=${expected.desktop ?? sha("a")}`,
    "--expect",
    `Ablankpaper/aera-cloud=${expected.cloud ?? sha("b")}`,
    "--expect",
    `Ablankpaper/aera-admin=${expected.admin ?? sha("c")}`,
  ];
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

test("accepts successful exact-SHA checkpoints with every required platform", async () => {
  const result = await verify(checkpoint());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 repositories and 5 executed jobs/u);
});

test("rejects a checkpoint for a different commit", async () => {
  const result = await verify(checkpoint(), { desktop: sha("d") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /commit SHA/u);
});

test("rejects skipped, cancelled, failed, or zero-step jobs", async () => {
  for (const conclusion of ["skipped", "cancelled", "failure"]) {
    const manifest = checkpoint();
    manifest.repositories[0].jobs[0].conclusion = conclusion;
    const result = await verify(manifest);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /job conclusion/u);
  }

  const manifest = checkpoint();
  manifest.repositories[0].jobs[0].stepsExecuted = 0;
  const result = await verify(manifest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /executed no steps/u);
});

test("rejects a missing Desktop matrix platform", async () => {
  const manifest = checkpoint();
  manifest.repositories[0].jobs = manifest.repositories[0].jobs.filter(
    (job) => job.platform !== "windows-latest",
  );
  const result = await verify(manifest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /windows-latest/u);
});

test("rejects runs completed before the source commit", async () => {
  const manifest = checkpoint();
  manifest.repositories[1].completedAt = "2026-07-23T07:59:59.000Z";
  const result = await verify(manifest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /older than its commit/u);
});

test("rejects malformed run URLs and duplicate repository records", async () => {
  const malformed = checkpoint();
  malformed.repositories[2].runUrl =
    "https://example.invalid/Ablankpaper/aera-admin/actions/runs/1003";
  let result = await verify(malformed);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run URL/u);

  const duplicate = checkpoint();
  duplicate.repositories.push(duplicate.repositories[0]);
  result = await verify(duplicate);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate repository/u);
});
