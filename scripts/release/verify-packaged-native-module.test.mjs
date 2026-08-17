/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { verifyPackagedNativeModule } from "./verify-packaged-native-module.mjs";

const MACH_O_CPU = {
  arm64: 0x0100000c,
  x64: 0x01000007,
};

const PE_MACHINE = {
  arm64: 0xaa64,
  x64: 0x8664,
};

function abiMarkers(...abis) {
  return Buffer.from(
    abis.map((abi) => `\0node_register_module_v${abi}\0`).join(""),
    "latin1",
  );
}

function thinMachO(architecture, ...abis) {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(MACH_O_CPU[architecture], 4);
  return Buffer.concat([header, abiMarkers(...abis)]);
}

function fatMachO(architectures, ...abis) {
  const header = Buffer.alloc(8 + architectures.length * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(architectures.length, 4);
  architectures.forEach((architecture, index) => {
    header.writeUInt32BE(MACH_O_CPU[architecture], 8 + index * 20);
  });
  return Buffer.concat([header, abiMarkers(...abis)]);
}

function peModule(architecture, ...abis) {
  const header = Buffer.alloc(0x58);
  header.write("MZ", 0, "ascii");
  header.writeUInt32LE(0x40, 0x3c);
  header.write("PE\0\0", 0x40, "binary");
  header.writeUInt16LE(PE_MACHINE[architecture], 0x44);
  return Buffer.concat([header, abiMarkers(...abis)]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createPackage({
  platform = "darwin",
  architecture = platform === "darwin" ? "arm64" : "x64",
  abi = "145",
  includeBetterSqlite = true,
  betterBytes = platform === "darwin"
    ? thinMachO(architecture, abi)
    : peModule(architecture, abi),
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "aera-packaged-native-"));
  const appOutDir =
    platform === "darwin"
      ? join(root, "out")
      : join(root, "out", "win-unpacked");
  const unpackedRoot =
    platform === "darwin"
      ? join(
          appOutDir,
          "Aera.app",
          "Contents",
          "Resources",
          "app.asar.unpacked",
        )
      : join(appOutDir, "resources", "app.asar.unpacked");
  await mkdir(unpackedRoot, { recursive: true });
  const betterRelative = join(
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  if (includeBetterSqlite) {
    const betterPath = join(unpackedRoot, betterRelative);
    await mkdir(dirname(betterPath), { recursive: true });
    await writeFile(betterPath, betterBytes);
  }
  return {
    root,
    appOutDir,
    unpackedRoot,
    platform,
    architecture,
    abi,
    betterRelative,
    betterBytes,
  };
}

async function addNativeModule(fixture, relativePath, bytes) {
  const modulePath = join(fixture.unpackedRoot, relativePath);
  await mkdir(dirname(modulePath), { recursive: true });
  await writeFile(modulePath, bytes);
  return modulePath;
}

function context(fixture) {
  return {
    appOutDir: fixture.appOutDir,
    electronPlatformName: fixture.platform,
    arch: fixture.architecture === "arm64" ? 3 : 1,
    packager: { projectDir: fixture.root },
  };
}

function verificationOptions(fixture, overrides = {}) {
  return {
    resolveElectronAbi: async () => fixture.abi,
    ...overrides,
  };
}

async function removeFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}

test("rejects a mismatched Electron ABI", async () => {
  const fixture = await createPackage({ abi: "137" });
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture, {
          resolveElectronAbi: async () => "145",
        }),
      ),
      /better_sqlite3\.node.*ABI 137 differs from Electron ABI 145/su,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects an ABI-matched native module for the wrong architecture", async () => {
  const fixture = await createPackage({
    architecture: "arm64",
    betterBytes: thinMachO("x64", "145"),
  });
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture),
      ),
      /better_sqlite3\.node.*architecture x64 differs from target arm64/su,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects a mixed fat Mach-O in a single-architecture package", async () => {
  const fixture = await createPackage({
    betterBytes: fatMachO(["arm64", "x64"], "145"),
  });
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture),
      ),
      /better_sqlite3\.node.*mixed architectures arm64,x64/su,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects a second packaged module with a stale ABI", async () => {
  const fixture = await createPackage();
  const otherRelative = join(
    "node_modules",
    "other-native",
    "build",
    "Release",
    "other_native.node",
  );
  await addNativeModule(fixture, otherRelative, thinMachO("arm64", "137"));
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture),
      ),
      /other_native\.node.*ABI 137 differs from Electron ABI 145/su,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects a module with multiple ABI markers", async () => {
  const fixture = await createPackage();
  await addNativeModule(
    fixture,
    join("node_modules", "ambiguous", "ambiguous.node"),
    thinMachO("arm64", "137", "145"),
  );
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture),
      ),
      /ambiguous\.node.*multiple ABI markers/su,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects an unsupported native binary format", async () => {
  const fixture = await createPackage();
  await addNativeModule(
    fixture,
    join("node_modules", "unknown", "unknown.node"),
    Buffer.concat([Buffer.from("not-a-native-binary"), abiMarkers("145")]),
  );
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture),
      ),
      /unknown\.node.*format is unsupported/su,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects symbolic links inside the native inventory tree", async () => {
  const fixture = await createPackage();
  const target = await addNativeModule(
    fixture,
    join("outside", "linked-target.node"),
    thinMachO("arm64", "145"),
  );
  const link = join(fixture.unpackedRoot, "node_modules", "linked.node");
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link);
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture),
      ),
      /symbolic link/u,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects an unreadable nested inventory directory", async () => {
  const fixture = await createPackage();
  const blocked = join(fixture.unpackedRoot, "blocked");
  await mkdir(blocked, { recursive: true });
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture, {
          readdir: async (directory, options) => {
            if (directory === blocked) {
              throw Object.assign(new Error("injected unreadable directory"), {
                code: "EACCES",
              });
            }
            return readdir(directory, options);
          },
        }),
      ),
      /unreadable directory/u,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("requires better-sqlite3 in the final unpacked native surface", async () => {
  const fixture = await createPackage({ includeBetterSqlite: false });
  await addNativeModule(
    fixture,
    join("node_modules", "other-native", "other.node"),
    thinMachO("arm64", "145"),
  );
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture),
      ),
      /better-sqlite3.*missing/u,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("persists a sorted hashed macOS inventory and reads each module once", async () => {
  const fixture = await createPackage();
  const otherRelative = join(
    "node_modules",
    "aaa-native",
    "build",
    "Release",
    "aaa_native.node",
  );
  const otherBytes = thinMachO("arm64", "145");
  await addNativeModule(fixture, otherRelative, otherBytes);
  const reads = new Map();
  try {
    const result = await verifyPackagedNativeModule(
      context(fixture),
      verificationOptions(fixture, {
        readFile: async (...args) => {
          const path = String(args[0]);
          reads.set(path, (reads.get(path) ?? 0) + 1);
          return readFile(...args);
        },
      }),
    );

    const betterPath = fixture.betterRelative.split("\\").join(posix.sep);
    const otherPath = otherRelative.split("\\").join(posix.sep);
    assert.deepEqual(result.inventory, [
      {
        path: otherPath,
        sha256: sha256(otherBytes),
        abi: "145",
        architecture: "arm64",
      },
      {
        path: betterPath,
        sha256: sha256(fixture.betterBytes),
        abi: "145",
        architecture: "arm64",
      },
    ]);
    assert.equal(
      result.inventoryPath.endsWith(
        "native-module-inventory-darwin-arm64.json",
      ),
      true,
    );
    assert.deepEqual([...reads.values()], [1, 1]);

    const persisted = JSON.parse(await readFile(result.inventoryPath, "utf8"));
    assert.deepEqual(persisted, {
      schemaVersion: 1,
      platform: "darwin",
      targetArchitecture: "arm64",
      electronAbi: "145",
      modules: result.inventory,
    });
  } finally {
    await removeFixture(fixture);
  }
});

test("parses and persists a Windows PE x64 inventory", async () => {
  const fixture = await createPackage({
    platform: "win32",
    architecture: "x64",
  });
  try {
    const result = await verifyPackagedNativeModule(
      context(fixture),
      verificationOptions(fixture),
    );
    assert.deepEqual(result.inventory, [
      {
        path: fixture.betterRelative.split("\\").join(posix.sep),
        sha256: sha256(fixture.betterBytes),
        abi: "145",
        architecture: "x64",
      },
    ]);
    assert.equal(
      result.inventoryPath.endsWith("native-module-inventory-win32-x64.json"),
      true,
    );
  } finally {
    await removeFixture(fixture);
  }
});
