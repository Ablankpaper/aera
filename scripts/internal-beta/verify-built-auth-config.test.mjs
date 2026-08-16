/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import verifyBuiltPackage, {
  verifyBuiltAuthConfig,
} from "./verify-built-auth-config.mjs";

const verifierPath = fileURLToPath(
  new URL("./verify-built-auth-config.mjs", import.meta.url),
);
const testOrigin = "https://203.0.113.10";
const otherTestOrigin = "https://203.0.113.11";
const testPublicKey = Buffer.alloc(32, 73).toString("base64url");

test("internal-Beta packaging rejects a build without a baked Cloud origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "aera-beta-auth-build-"));
  const mainDirectory = join(root, "out", "main");
  await mkdir(mainDirectory, { recursive: true });
  await writeFile(
    join(mainDirectory, "start.js"),
    `function getAgenteraCloudOrigin() {
      return resolveAgenteraCloudOrigin({
        runtimePublicUrl: process.env.AGENTERA_CLOUD_PUBLIC_URL,
        buildPublicUrl: void 0,
      });
}\n`,
    "utf8",
  );

  try {
    const result = spawnSync(process.execPath, [verifierPath, mainDirectory], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Internal Beta packaged auth config failed: baked Cloud origin is missing/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("internal-Beta packaging rejects a build without baked offline trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "aera-beta-auth-build-"));
  const mainDirectory = join(root, "out", "main");
  await mkdir(mainDirectory, { recursive: true });
  await writeFile(
    join(mainDirectory, "start.js"),
    `function getAgenteraCloudOrigin() {
      return resolveAgenteraCloudOrigin({
        runtimePublicUrl: process.env.AGENTERA_CLOUD_PUBLIC_URL,
        buildPublicUrl: "${testOrigin}"?.trim(),
      });
}\n`,
    "utf8",
  );

  try {
    const result = spawnSync(process.execPath, [verifierPath, mainDirectory], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Internal Beta packaged auth config failed: baked offline trust is missing/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("internal-Beta packaging rejects offline trust for a different issuer", async () => {
  const root = await mkdtemp(join(tmpdir(), "aera-beta-auth-build-"));
  const mainDirectory = join(root, "out", "main");
  await mkdir(mainDirectory, { recursive: true });
  await writeFile(
    join(mainDirectory, "start.js"),
    `const BUNDLED_AGENTERA_OFFLINE_PUBLIC_KEYS = resolveBundledAgenteraOfflinePublicKeys({
      buildOfflinePublicKeysJson: '{"issuer":"${otherTestOrigin}","keys":[{"keyId":"offline-internal-beta-v1","publicKey":"${testPublicKey}"}]}',
      buildPublicUrl: "${otherTestOrigin}"
    });
    function getAgenteraCloudOrigin() {
      return resolveAgenteraCloudOrigin({
        runtimePublicUrl: process.env.AGENTERA_CLOUD_PUBLIC_URL,
        buildPublicUrl: "${testOrigin}"?.trim(),
      });
}\n`,
    "utf8",
  );

  try {
    const result = spawnSync(process.execPath, [verifierPath, mainDirectory], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Internal Beta packaged auth config failed: baked offline trust differs from the Cloud origin/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("internal-Beta packaging accepts the exact baked Cloud and trust pair", async () => {
  const root = await mkdtemp(join(tmpdir(), "aera-beta-auth-build-"));
  const mainDirectory = join(root, "out", "main");
  await mkdir(mainDirectory, { recursive: true });
  await writeFile(
    join(mainDirectory, "start.js"),
    `const BUNDLED_AGENTERA_OFFLINE_PUBLIC_KEYS = resolveBundledAgenteraOfflinePublicKeys({
      buildOfflinePublicKeysJson: '{"issuer":"${testOrigin}","keys":[{"keyId":"offline-internal-beta-v1","publicKey":"${testPublicKey}"}]}',
      buildPublicUrl: "${testOrigin}"
    });
    function getAgenteraCloudOrigin() {
      return resolveAgenteraCloudOrigin({
        runtimePublicUrl: process.env.AGENTERA_CLOUD_PUBLIC_URL,
        buildPublicUrl: "${testOrigin}"?.trim(),
      });
}\n`,
    "utf8",
  );

  try {
    const result = spawnSync(process.execPath, [verifierPath, mainDirectory], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("internal-Beta packaging accepts baked auth config from a nested main chunk", async () => {
  const root = await mkdtemp(join(tmpdir(), "aera-beta-auth-build-"));
  const mainDirectory = join(root, "out", "main");
  const chunksDirectory = join(mainDirectory, "chunks");
  await mkdir(chunksDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      join(mainDirectory, "internal-beta-updater.js"),
      'export { startInternalBetaUpdate } from "./chunks/start.js";\n',
      "utf8",
    ),
    writeFile(
      join(chunksDirectory, "start.js"),
      `const BUNDLED_AGENTERA_OFFLINE_PUBLIC_KEYS = resolveBundledAgenteraOfflinePublicKeys({
      buildOfflinePublicKeysJson: '{"issuer":"${testOrigin}","keys":[{"keyId":"offline-internal-beta-v1","publicKey":"${testPublicKey}"}]}',
      buildPublicUrl: "${testOrigin}"
    });
    function getAgenteraCloudOrigin() {
      return resolveAgenteraCloudOrigin({
        runtimePublicUrl: process.env.AGENTERA_CLOUD_PUBLIC_URL,
        buildPublicUrl: "${testOrigin}"?.trim(),
      });
}\n`,
      "utf8",
    ),
  ]);

  try {
    const result = spawnSync(process.execPath, [verifierPath, mainDirectory], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("internal-Beta packaging rejects a native module built for a different Electron ABI", async () => {
  const root = await mkdtemp(join(tmpdir(), "aera-beta-native-build-"));
  const mainDirectory = join(root, "out", "main");
  const nativeModuleDirectory = join(
    root,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
  );
  await Promise.all([
    mkdir(mainDirectory, { recursive: true }),
    mkdir(nativeModuleDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(mainDirectory, "start.js"),
      `const BUNDLED_AGENTERA_OFFLINE_PUBLIC_KEYS = resolveBundledAgenteraOfflinePublicKeys({
      buildOfflinePublicKeysJson: '{"issuer":"${testOrigin}","keys":[{"keyId":"offline-internal-beta-v1","publicKey":"${testPublicKey}"}]}',
      buildPublicUrl: "${testOrigin}"
    });
    function getAgenteraCloudOrigin() {
      return resolveAgenteraCloudOrigin({
        runtimePublicUrl: process.env.AGENTERA_CLOUD_PUBLIC_URL,
        buildPublicUrl: "${testOrigin}"?.trim(),
      });
}\n`,
      "utf8",
    ),
    writeFile(
      join(nativeModuleDirectory, "better_sqlite3.node"),
      Buffer.from("binary-prefix\0node_register_module_v137\0binary-suffix"),
    ),
  ]);

  try {
    await assert.rejects(
      verifyBuiltAuthConfig(mainDirectory, {
        projectDirectory: root,
        expectedElectronAbi: "145",
      }),
      /better-sqlite3 ABI 137 differs from Electron ABI 145/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("internal-Beta beforePack automatically applies the native module ABI gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "aera-beta-before-pack-"));
  const mainDirectory = join(root, "out", "main");
  const nativeModuleDirectory = join(
    root,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
  );
  await Promise.all([
    mkdir(mainDirectory, { recursive: true }),
    mkdir(nativeModuleDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(mainDirectory, "start.js"),
      `const BUNDLED_AGENTERA_OFFLINE_PUBLIC_KEYS = resolveBundledAgenteraOfflinePublicKeys({
      buildOfflinePublicKeysJson: '{"issuer":"${testOrigin}","keys":[{"keyId":"offline-internal-beta-v1","publicKey":"${testPublicKey}"}]}',
      buildPublicUrl: "${testOrigin}"
    });
    function getAgenteraCloudOrigin() {
      return resolveAgenteraCloudOrigin({
        runtimePublicUrl: process.env.AGENTERA_CLOUD_PUBLIC_URL,
        buildPublicUrl: "${testOrigin}"?.trim(),
      });
}\n`,
      "utf8",
    ),
    writeFile(
      join(nativeModuleDirectory, "better_sqlite3.node"),
      Buffer.from("binary-prefix\0node_register_module_v137\0binary-suffix"),
    ),
  ]);

  try {
    await assert.rejects(
      verifyBuiltPackage(
        { packager: { projectDir: root } },
        { resolveElectronAbi: async () => "145" },
      ),
      /better-sqlite3 ABI 137 differs from Electron ABI 145/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
