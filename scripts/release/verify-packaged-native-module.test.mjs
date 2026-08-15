/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { verifyPackagedNativeModule } from "./verify-packaged-native-module.mjs";

async function createPackagedApp(abi) {
  const root = await mkdtemp(join(tmpdir(), "aera-packaged-native-"));
  const nativeModule = join(
    root,
    "out",
    "Aera.app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  await mkdir(join(nativeModule, ".."), { recursive: true });
  await writeFile(
    nativeModule,
    Buffer.from(`binary-prefix\0node_register_module_v${abi}\0binary-suffix`),
  );
  return { root, appOutDir: join(root, "out") };
}

test("packaged macOS native module rejects a mismatched Electron ABI", async () => {
  const fixture = await createPackagedApp("137");
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        {
          appOutDir: fixture.appOutDir,
          electronPlatformName: "darwin",
          packager: { projectDir: fixture.root },
        },
        { resolveElectronAbi: async () => "145" },
      ),
      /better-sqlite3 ABI 137 differs from Electron ABI 145/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("packaged macOS native module accepts the target Electron ABI", async () => {
  const fixture = await createPackagedApp("145");
  try {
    const result = await verifyPackagedNativeModule(
      {
        appOutDir: fixture.appOutDir,
        electronPlatformName: "darwin",
        packager: { projectDir: fixture.root },
      },
      { resolveElectronAbi: async () => "145" },
    );
    assert.equal(result.electronAbi, "145");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
