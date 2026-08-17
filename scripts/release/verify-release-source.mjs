#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

const AUTHORITATIVE_REPOSITORY = "Ablankpaper/aera";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const WORKFLOW_REF_PATTERN =
  /^Ablankpaper\/aera\/\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml@refs\/heads\/main$/u;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function fail(message) {
  throw new Error(`Release source verification failed: ${message}`);
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      ![
        "--checkout",
        "--repository",
        "--source-sha",
        "--workflow-ref",
      ].includes(flag) ||
      value === undefined ||
      value === ""
    ) {
      fail(
        "usage: verify-release-source.mjs --checkout PATH --repository REPOSITORY --source-sha SHA --workflow-ref REF",
      );
    }
    if (parsed[flag] !== undefined) fail(`duplicate argument ${flag}`);
    parsed[flag] = value;
  }
  for (const flag of ["--repository", "--source-sha", "--workflow-ref"]) {
    if (parsed[flag] === undefined) fail(`missing required argument ${flag}`);
  }
  let checkout;
  try {
    checkout = realpathSync(parsed["--checkout"] ?? process.cwd());
  } catch {
    fail("checkout path is unavailable");
  }
  return {
    checkout,
    repository: parsed["--repository"],
    sourceSha: parsed["--source-sha"],
    workflowRef: parsed["--workflow-ref"],
  };
}

function git(checkout, args, { allowMissing = false } = {}) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const result = spawnSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    env: {
      ...environment,
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    },
  });
  if (allowMissing && result.status === 1) return null;
  if (result.status !== 0) fail("cannot inspect the Git checkout");
  return result.stdout;
}

function lines(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function repositoryFromRemote(url, name, direction) {
  if (url.toLowerCase().includes("bignormal")) {
    fail(`remote ${name} ${direction} uses the retired repository identity`);
  }
  const allowed = [
    /^git@(github\.com|github-ablankpaper):Ablankpaper\/aera(?:\.git)?$/u,
    /^https:\/\/github\.com\/Ablankpaper\/aera(?:\.git)?$/u,
    /^ssh:\/\/git@github\.com\/Ablankpaper\/aera(?:\.git)?$/u,
  ];
  if (!allowed.some((pattern) => pattern.test(url))) {
    fail(
      `remote ${name} ${direction} is not an allowed ${AUTHORITATIVE_REPOSITORY} GitHub URL`,
    );
  }
  return AUTHORITATIVE_REPOSITORY;
}

function remoteEvidence(checkout) {
  const names = lines(git(checkout, ["remote"])).sort();
  if (!names.includes("origin")) {
    fail("the checkout must have an origin remote");
  }
  return names.map((name) => {
    if (!REMOTE_NAME_PATTERN.test(name)) {
      fail("the checkout has an invalid remote name");
    }
    const fetchUrls = lines(
      git(checkout, ["config", "--get-all", `remote.${name}.url`]),
    );
    const configuredPush = git(
      checkout,
      ["config", "--get-all", `remote.${name}.pushurl`],
      { allowMissing: true },
    );
    const pushUrls =
      configuredPush === null ? fetchUrls : lines(configuredPush);
    if (fetchUrls.length === 0) {
      fail(`remote ${name} has no fetch URL`);
    }
    if (pushUrls.length === 0) {
      fail(`remote ${name} has no push URL`);
    }
    const effectiveFetchUrls = lines(
      git(checkout, ["remote", "get-url", "--all", name]),
    );
    const effectivePushUrls = lines(
      git(checkout, ["remote", "get-url", "--all", "--push", name]),
    );
    if (effectiveFetchUrls.length === 0 || effectivePushUrls.length === 0) {
      fail(`remote ${name} has no effective fetch or push URL`);
    }
    for (const url of effectiveFetchUrls) {
      repositoryFromRemote(url, name, "effective fetch URL");
    }
    for (const url of effectivePushUrls) {
      repositoryFromRemote(url, name, "effective push URL");
    }
    return {
      fetchRepositories: fetchUrls
        .map((url) => repositoryFromRemote(url, name, "fetch URL"))
        .sort(),
      name,
      pushRepositories: pushUrls
        .map((url) => repositoryFromRemote(url, name, "push URL"))
        .sort(),
    };
  });
}

function sortJSON(value) {
  if (Array.isArray(value)) return value.map(sortJSON);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJSON(value[key])]),
    );
  }
  return value;
}

function canonicalJSONStringify(value) {
  return `${JSON.stringify(sortJSON(value))}\n`;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.repository !== AUTHORITATIVE_REPOSITORY) {
    fail(`repository must be ${AUTHORITATIVE_REPOSITORY}`);
  }
  if (!SHA_PATTERN.test(options.sourceSha)) fail("source SHA is invalid");
  if (!WORKFLOW_REF_PATTERN.test(options.workflowRef)) {
    fail("workflow ref must identify an authoritative main-branch workflow");
  }
  if (process.env.GITHUB_REPOSITORY !== options.repository) {
    fail("GitHub repository differs from the authoritative repository");
  }
  if (process.env.GITHUB_REF !== "refs/heads/main") {
    fail("GitHub ref must be refs/heads/main");
  }
  if (process.env.GITHUB_SHA !== options.sourceSha) {
    fail("GitHub source SHA differs from the expected source SHA");
  }
  if (process.env.GITHUB_WORKFLOW_REF !== options.workflowRef) {
    fail("GitHub workflow ref differs from the expected workflow ref");
  }

  const headSha = git(options.checkout, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]).trim();
  const detached =
    git(options.checkout, ["symbolic-ref", "-q", "HEAD"], {
      allowMissing: true,
    }) === null;
  const clean =
    git(options.checkout, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]).length === 0;
  const remotes = remoteEvidence(options.checkout);

  if (!SHA_PATTERN.test(headSha) || headSha !== options.sourceSha) {
    fail("checkout HEAD differs from the expected source SHA");
  }
  if (!detached) fail("release checkout must use a detached HEAD");
  if (!clean) fail("release checkout must be clean");

  const evidence = {
    checkout: { clean, detached, headSha },
    remotes,
    repository: options.repository,
    schemaVersion: 1,
    sourceSha: options.sourceSha,
    workflow: {
      githubRef: process.env.GITHUB_REF,
      githubSha: process.env.GITHUB_SHA,
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
    },
  };
  process.stdout.write(canonicalJSONStringify(evidence));
}

try {
  main();
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Release source verification failed: unknown error",
  );
  process.exitCode = 1;
}
