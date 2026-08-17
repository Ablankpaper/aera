/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(
  new URL("./verify-release-source.mjs", import.meta.url),
);
const repository = "Ablankpaper/aera";
const workflowRef =
  "Ablankpaper/aera/.github/workflows/release-candidate.yml@refs/heads/main";

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

async function createFixture(remoteUrl) {
  const root = await mkdtemp(join(tmpdir(), "aera-release-source-"));
  const checkout = join(root, "checkout");
  runGit(root, ["init", "--initial-branch=main", checkout]);
  await writeFile(join(checkout, "tracked.txt"), "reviewed source\n", "utf8");
  runGit(checkout, ["add", "tracked.txt"]);
  runGit(checkout, [
    "-c",
    "user.name=Aera Fixture",
    "-c",
    "user.email=fixture@invalid.example",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "fixture source",
  ]);
  const sourceSha = runGit(checkout, ["rev-parse", "HEAD"]);
  runGit(checkout, ["remote", "add", "origin", remoteUrl]);
  runGit(checkout, ["switch", "--detach", sourceSha]);
  return { root, checkout, sourceSha };
}

function verify(fixture, overrides = {}) {
  const sourceSha = overrides.sourceSha ?? fixture.sourceSha;
  const expectedRepository = overrides.repository ?? repository;
  const expectedWorkflowRef = overrides.workflowRef ?? workflowRef;
  return spawnSync(
    process.execPath,
    [
      scriptPath,
      "--checkout",
      overrides.checkout ?? fixture.checkout,
      "--repository",
      expectedRepository,
      "--source-sha",
      sourceSha,
      "--workflow-ref",
      expectedWorkflowRef,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fixture.root,
        XDG_CONFIG_HOME: join(fixture.root, "xdg"),
        ...(overrides.gitEnv ?? {}),
        GITHUB_REF: overrides.githubRef ?? "refs/heads/main",
        GITHUB_REPOSITORY: overrides.githubRepository ?? expectedRepository,
        GITHUB_SHA: overrides.githubSha ?? sourceSha,
        GITHUB_WORKFLOW_REF: overrides.githubWorkflowRef ?? expectedWorkflowRef,
      },
    },
  );
}

function canonicalJSONStringify(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, sort(input[key])]),
      );
    }
    return input;
  };
  return `${JSON.stringify(sort(value))}\n`;
}

for (const fixtureCase of [
  {
    name: "macOS SSH alias",
    remoteUrl: "git@github-ablankpaper:Ablankpaper/aera.git",
  },
  {
    name: "Linux GitHub HTTPS",
    remoteUrl: "https://github.com/Ablankpaper/aera.git",
  },
]) {
  // @lat: [[release-source-governance#Release Source Governance#Accepted macOS and Linux Git fixtures]]
  test(`accepts an exact clean detached ${fixtureCase.name} checkout`, async () => {
    const fixture = await createFixture(fixtureCase.remoteUrl);
    try {
      const result = verify(fixture);
      assert.equal(result.status, 0, result.stderr);
      const evidence = JSON.parse(result.stdout);
      assert.equal(result.stdout, canonicalJSONStringify(evidence));
      assert.deepEqual(evidence, {
        checkout: {
          clean: true,
          detached: true,
          headSha: fixture.sourceSha,
        },
        remotes: [
          {
            fetchRepositories: [repository],
            name: "origin",
            pushRepositories: [repository],
          },
        ],
        repository,
        schemaVersion: 1,
        sourceSha: fixture.sourceSha,
        workflow: {
          githubRef: "refs/heads/main",
          githubSha: fixture.sourceSha,
          workflowRef,
        },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

// @lat: [[release-source-governance#Release Source Governance#Retired remote rejection]]
test("rejects the retired repository in either a fetch or push remote", async () => {
  for (const direction of ["fetch", "push", "rewrite"]) {
    const fixture = await createFixture(
      "https://github.com/Ablankpaper/aera.git",
    );
    try {
      if (direction === "fetch") {
        runGit(fixture.checkout, [
          "remote",
          "add",
          "legacy",
          "git@github.com:bignormal/aera.git",
        ]);
      } else if (direction === "push") {
        runGit(fixture.checkout, [
          "remote",
          "set-url",
          "--add",
          "--push",
          "origin",
          "https://github.com/bignormal/aera.git",
        ]);
      } else {
        runGit(fixture.checkout, [
          "config",
          "url.https://github.com/bignormal/aera.git.insteadOf",
          "https://github.com/Ablankpaper/aera.git",
        ]);
      }

      const result = verify(fixture);
      assert.notEqual(result.status, 0, `${direction} remote was accepted`);
      assert.match(result.stderr, /retired repository identity/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

// @lat: [[release-source-governance#Release Source Governance#Non-authoritative remote rejection]]
test("rejects a non-authoritative remote without disclosing its URL", async () => {
  for (const remoteUrl of [
    "https://release-secret@example.invalid/Ablankpaper/aera.git",
    "https://github.com/Ablankpaper/other.git",
    "ssh://git@github.com:2222/Ablankpaper/aera.git",
  ]) {
    const fixture = await createFixture(
      "https://github.com/Ablankpaper/aera.git",
    );
    try {
      runGit(fixture.checkout, ["remote", "set-url", "origin", remoteUrl]);
      const result = verify(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not an allowed.*Ablankpaper\/aera/u);
      assert.doesNotMatch(
        `${result.stdout}${result.stderr}`,
        /release-secret/u,
      );
      assert.doesNotMatch(
        `${result.stdout}${result.stderr}`,
        /example\.invalid/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

// @lat: [[release-source-governance#Release Source Governance#Authoritative GitHub workflow context]]
test("rejects repository, main-ref, SHA, or workflow-ref context drift", async () => {
  const cases = [
    { repository: "bignormal/aera" },
    { githubRepository: "bignormal/aera" },
    { githubRef: "refs/heads/release-candidate" },
    { githubSha: "b".repeat(40) },
    {
      githubWorkflowRef:
        "Ablankpaper/aera/.github/workflows/release-candidate.yml@refs/heads/release-candidate",
    },
  ];

  for (const overrides of cases) {
    const fixture = await createFixture(
      "https://github.com/Ablankpaper/aera.git",
    );
    try {
      const result = verify(fixture, overrides);
      assert.notEqual(result.status, 0, JSON.stringify(overrides));
      assert.match(result.stderr, /GitHub|workflow|source SHA|repository/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

// @lat: [[release-source-governance#Release Source Governance#Exact source commit]]
test("rejects an expected source SHA different from checkout HEAD", async () => {
  const fixture = await createFixture(
    "https://github.com/Ablankpaper/aera.git",
  );
  try {
    const result = verify(fixture, { sourceSha: "c".repeat(40) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HEAD.*source SHA|source SHA.*HEAD/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// @lat: [[release-source-governance#Release Source Governance#Detached release checkout]]
test("rejects an attached branch checkout", async () => {
  const fixture = await createFixture(
    "https://github.com/Ablankpaper/aera.git",
  );
  try {
    runGit(fixture.checkout, ["switch", "main"]);
    const result = verify(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /detached/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// @lat: [[release-source-governance#Release Source Governance#Clean release checkout]]
test("rejects tracked and untracked checkout changes", async () => {
  for (const dirt of ["tracked", "untracked"]) {
    const fixture = await createFixture(
      "https://github.com/Ablankpaper/aera.git",
    );
    try {
      const path = join(
        fixture.checkout,
        dirt === "tracked" ? "tracked.txt" : "untracked.txt",
      );
      await writeFile(path, `${dirt} change\n`, "utf8");
      const result = verify(fixture);
      assert.notEqual(result.status, 0, `${dirt} change was accepted`);
      assert.match(result.stderr, /clean/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

// @lat: [[release-source-governance#Release Source Governance#Required origin identity]]
test("rejects a checkout without origin or a usable push URL", async () => {
  for (const variant of ["missing-origin", "empty-push-url"]) {
    const fixture = await createFixture(
      "https://github.com/Ablankpaper/aera.git",
    );
    try {
      if (variant === "missing-origin") {
        runGit(fixture.checkout, ["remote", "rename", "origin", "mirror"]);
      } else {
        runGit(fixture.checkout, ["config", "remote.origin.pushurl", ""]);
      }
      const result = verify(fixture);
      assert.notEqual(result.status, 0, `${variant} was accepted`);
      assert.match(result.stderr, /origin|fetch|push URL/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

// @lat: [[release-source-governance#Release Source Governance#Untrusted Git environment]]
test("does not let Git environment overrides redirect checkout inspection", async () => {
  const authoritative = await createFixture(
    "https://github.com/Ablankpaper/aera.git",
  );
  const challenged = await createFixture(
    "https://github.com/Ablankpaper/aera.git",
  );
  try {
    runGit(challenged.checkout, [
      "remote",
      "add",
      "legacy",
      "https://github.com/bignormal/aera.git",
    ]);
    const result = verify(challenged, {
      sourceSha: authoritative.sourceSha,
      gitEnv: {
        GIT_DIR: join(authoritative.checkout, ".git"),
        GIT_WORK_TREE: authoritative.checkout,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /retired repository identity|checkout HEAD/u);
  } finally {
    await Promise.all([
      rm(authoritative.root, { recursive: true, force: true }),
      rm(challenged.root, { recursive: true, force: true }),
    ]);
  }
});

// @lat: [[release-source-governance#Release Source Governance#Canonical redacted evidence]]
test("emits canonical evidence without checkout paths or raw remote URLs", async () => {
  const fixture = await createFixture(
    "git@github-ablankpaper:Ablankpaper/aera.git",
  );
  try {
    const result = verify(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      canonicalJSONStringify(JSON.parse(result.stdout)),
    );
    assert.doesNotMatch(result.stdout, new RegExp(fixture.checkout, "u"));
    assert.doesNotMatch(result.stdout, /github(?:\.com|-ablankpaper)/u);
    assert.doesNotMatch(result.stdout, /git@|https:\/\//u);

    const privateMissingPath = join(fixture.root, "private-token-checkout");
    const invalid = verify(fixture, { checkout: privateMissingPath });
    assert.notEqual(invalid.status, 0);
    assert.doesNotMatch(
      `${invalid.stdout}${invalid.stderr}`,
      /private-token-checkout/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
