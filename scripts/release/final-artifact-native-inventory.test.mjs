/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  buildFinalArtifactNativeInventory,
  verifyFinalArtifactNativeInventory,
} from "./final-artifact-native-inventory.mjs";

const roots = [];
const SOURCE_SHA = "a".repeat(40);
const VERSION = "0.7.4-internal-beta.38";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function arm64MachO(abi) {
  const marker = Buffer.from(`\0node_register_module_v${abi}\0`, "latin1");
  const headerSize = 32;
  const commandSize = 72;
  const image = Buffer.alloc(headerSize + commandSize + marker.length);
  image.writeUInt32LE(0xfeedfacf, 0);
  image.writeUInt32LE(0x0100000c, 4);
  image.writeUInt32LE(0, 8);
  image.writeUInt32LE(8, 12);
  image.writeUInt32LE(1, 16);
  image.writeUInt32LE(commandSize, 20);
  image.writeUInt32LE(0x19, headerSize);
  image.writeUInt32LE(commandSize, headerSize + 4);
  image.write("__TEXT", headerSize + 8, 16, "ascii");
  image.writeBigUInt64LE(BigInt(image.length), headerSize + 32);
  image.writeBigUInt64LE(0n, headerSize + 40);
  image.writeBigUInt64LE(BigInt(image.length), headerSize + 48);
  image.writeUInt32LE(5, headerSize + 56);
  image.writeUInt32LE(5, headerSize + 60);
  marker.copy(image, headerSize + commandSize);
  return image;
}

async function fixture(artifactName = "Aera-test.dmg") {
  const root = await mkdtemp(join(tmpdir(), "aera-final-native-"));
  roots.push(root);
  const artifactPath = join(root, artifactName);
  const applicationRoot = join(root, "Aera.app");
  const unpacked = join(
    applicationRoot,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
  );
  await mkdir(unpacked, { recursive: true });
  await writeFile(artifactPath, Buffer.from(`container:${artifactName}`));
  const nativePath = join(unpacked, "better_sqlite3.node");
  await writeFile(nativePath, arm64MachO("145"));
  await writeFile(
    join(applicationRoot, "Contents", "Resources", "app.asar"),
    Buffer.from("test asar"),
  );
  return { root, artifactPath, applicationRoot, nativePath };
}

function options(value) {
  return {
    artifactPath: value.artifactPath,
    applicationRoot: value.applicationRoot,
    kind: "macos_dmg",
    platform: "darwin",
    architecture: "arm64",
    sourceSha: SOURCE_SHA,
    version: VERSION,
    electronAbi: "145",
  };
}

// @lat: [[beta27-reliability-plan#Acceptance and release boundary#Complete packaged native inventory]]
test("binds one final container to its extracted payload and native inventory", async () => {
  const value = await fixture();
  const evidence = await buildFinalArtifactNativeInventory(options(value));

  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.artifact.name, "Aera-test.dmg");
  assert.match(evidence.artifact.sha256, /^[0-9a-f]{64}$/u);
  assert.match(evidence.artifact.sha512, /^[0-9a-f]{128}$/u);
  assert.match(evidence.payload.sha256, /^[0-9a-f]{64}$/u);
  assert.match(evidence.inventory.sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(evidence.inventory.modules, [
    {
      abi: "145",
      architecture: "arm64",
      format: "mach-o",
      path: "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      sha256: evidence.inventory.modules[0].sha256,
    },
  ]);
  await assert.doesNotReject(() =>
    verifyFinalArtifactNativeInventory(evidence, options(value)),
  );
});

test("rejects evidence substituted from another container", async () => {
  const first = await fixture("Aera-first.dmg");
  const second = await fixture("Aera-second.dmg");
  const evidence = await buildFinalArtifactNativeInventory(options(first));

  await assert.rejects(
    () => verifyFinalArtifactNativeInventory(evidence, options(second)),
    /differs from final artifact bytes/u,
  );
});

test("rejects a native module changed after evidence creation", async () => {
  const value = await fixture();
  const evidence = await buildFinalArtifactNativeInventory(options(value));
  await writeFile(value.nativePath, arm64MachO("137"));

  await assert.rejects(
    () => verifyFinalArtifactNativeInventory(evidence, options(value)),
    /ABI 137 differs|differs from extracted application bytes/u,
  );
});
