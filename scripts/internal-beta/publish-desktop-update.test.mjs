/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, test } from "node:test";

import {
  buildDesktopUpdateManifest,
  canonicalDesktopUpdateJSONStringify,
  signDesktopUpdateManifest,
} from "./desktop-update.mjs";

const executeFile = promisify(execFile);
const VERSION = "0.7.4-internal-beta.24";
const BASE_URL = "https://47.100.169.193/desktop-updates/internal-beta";
const SCRIPT = resolve("scripts/internal-beta/publish-desktop-update.sh");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture({ tamperArtifact = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "aera-update-publisher-"));
  temporaryRoots.push(root);
  const artifactsDirectory = join(root, "artifacts");
  const publishDirectory = join(root, "publish");
  const releaseDirectory = join(publishDirectory, "releases", VERSION);
  const channelRoot = join(root, "channel");
  await Promise.all([
    mkdir(artifactsDirectory, { recursive: true }),
    mkdir(releaseDirectory, { recursive: true }),
  ]);
  const names = [
    `Aera-Internal-Beta-${VERSION}-macos-arm64.zip`,
    `Aera-Internal-Beta-${VERSION}-windows-x64-setup.exe`,
  ];
  await Promise.all(
    names.map((name, index) =>
      writeFile(
        join(artifactsDirectory, name),
        Buffer.alloc(1024 + index, index + 1),
      ),
    ),
  );
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = await buildDesktopUpdateManifest({
    artifactsDirectory,
    baseUrl: BASE_URL,
    publishedAt: "2026-07-29T12:00:00Z",
    releaseNotes: "在线更新发布测试",
    version: VERSION,
  });
  const manifestBytes = Buffer.from(
    canonicalDesktopUpdateJSONStringify(manifest),
  );
  const envelope = signDesktopUpdateManifest(
    manifestBytes,
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  const publicKeyPath = join(root, "public.pem");
  await Promise.all([
    writeFile(join(publishDirectory, "manifest.json"), manifestBytes),
    writeFile(
      join(publishDirectory, "manifest.sig"),
      canonicalDesktopUpdateJSONStringify(envelope),
    ),
    writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" })),
    ...names.map(async (name) =>
      writeFile(
        join(releaseDirectory, name),
        await readFile(join(artifactsDirectory, name)),
      ),
    ),
  ]);
  if (tamperArtifact) {
    await writeFile(join(releaseDirectory, names[0]), Buffer.from("tampered"));
  }
  const bundle = join(root, "bundle.tar");
  await executeFile("tar", [
    "-cf",
    bundle,
    "-C",
    publishDirectory,
    "manifest.json",
    "manifest.sig",
    `releases/${VERSION}/${names[0]}`,
    `releases/${VERSION}/${names[1]}`,
  ]);
  return {
    artifactsDirectory,
    bundle,
    channelRoot,
    names,
    publicKeyPath,
  };
}

async function publish(input) {
  const bytes = await readFile(input.bundle);
  return new Promise((resolvePromise) => {
    const child = spawn("bash", [SCRIPT], {
      env: {
        ...process.env,
        AERA_DESKTOP_UPDATE_ROOT: input.channelRoot,
        AERA_DESKTOP_UPDATE_PUBLIC_KEY: input.publicKeyPath,
        AERA_DESKTOP_UPDATE_BASE_URL: BASE_URL,
        AERA_DESKTOP_UPDATE_MAXIMUM_BYTES: String(8 * 1024 * 1024),
        SSH_ORIGINAL_COMMAND: "publish",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("close", (code) => {
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(bytes);
  });
}

test("publishes one verified update atomically and accepts an exact rerun", async () => {
  const input = await fixture();
  const first = await publish(input);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /desktop update published/u);
  assert.equal(
    await readlink(join(input.channelRoot, "current")),
    `versions/${VERSION}`,
  );
  assert.equal(
    (await lstat(join(input.channelRoot, "current"))).isSymbolicLink(),
    true,
  );
  for (const name of input.names) {
    assert.deepEqual(
      await readFile(join(input.channelRoot, "releases", VERSION, name)),
      await readFile(join(input.artifactsDirectory, name)),
    );
  }

  const second = await publish(input);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /already published/u);
});

test("rejects artifact bytes that differ from signed metadata", async () => {
  const input = await fixture({ tamperArtifact: true });
  const result = await publish(input);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /artifact bytes differ/iu);
  await assert.rejects(
    () => lstat(join(input.channelRoot, "current")),
    /ENOENT/u,
  );
});
