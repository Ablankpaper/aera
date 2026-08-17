/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
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

const PE_OFFSET = 0x80;
const PE_OPTIONAL_HEADER_SIZE = 0xf0;
const PE_OPTIONAL_HEADER_OFFSET = PE_OFFSET + 24;
const PE_SECTION_TABLE_OFFSET =
  PE_OPTIONAL_HEADER_OFFSET + PE_OPTIONAL_HEADER_SIZE;

function abiMarkers(...abis) {
  return Buffer.from(
    abis.map((abi) => `\0node_register_module_v${abi}\0`).join(""),
    "latin1",
  );
}

function thinMachO(architecture, ...abis) {
  const loadCommand = Buffer.alloc(24);
  loadCommand.writeUInt32LE(0x1b, 0);
  loadCommand.writeUInt32LE(loadCommand.length, 4);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(MACH_O_CPU[architecture], 4);
  header.writeUInt32LE(architecture === "x64" ? 3 : 0, 8);
  header.writeUInt32LE(8, 12);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(loadCommand.length, 20);
  return Buffer.concat([header, loadCommand, abiMarkers(...abis)]);
}

function fatMachOWithKind(kind, architectures, abis) {
  const entrySize = kind === "fat64" ? 32 : 20;
  const slices = architectures.map((architecture) =>
    thinMachO(architecture, ...abis),
  );
  const header = Buffer.alloc(8 + architectures.length * entrySize);
  header.writeUInt32BE(kind === "fat64" ? 0xcafebabf : 0xcafebabe, 0);
  header.writeUInt32BE(architectures.length, 4);
  let sliceOffset = header.length;
  architectures.forEach((architecture, index) => {
    const entryOffset = 8 + index * entrySize;
    header.writeUInt32BE(MACH_O_CPU[architecture], entryOffset);
    header.writeUInt32BE(architecture === "x64" ? 3 : 0, entryOffset + 4);
    if (kind === "fat64") {
      header.writeBigUInt64BE(BigInt(sliceOffset), entryOffset + 8);
      header.writeBigUInt64BE(BigInt(slices[index].length), entryOffset + 16);
    } else {
      header.writeUInt32BE(sliceOffset, entryOffset + 8);
      header.writeUInt32BE(slices[index].length, entryOffset + 12);
    }
    sliceOffset += slices[index].length;
  });
  return Buffer.concat([header, ...slices]);
}

function fatMachO(architectures, ...abis) {
  return fatMachOWithKind("fat32", architectures, abis);
}

function fat64MachO(architectures, ...abis) {
  return fatMachOWithKind("fat64", architectures, abis);
}

function peModule(architecture, ...abis) {
  const rawOffset = PE_SECTION_TABLE_OFFSET + 40;
  const payload = Buffer.concat([Buffer.from([0]), abiMarkers(...abis)]);
  const image = Buffer.alloc(rawOffset + payload.length);
  image.write("MZ", 0, "ascii");
  image.writeUInt32LE(PE_OFFSET, 0x3c);
  image.write("PE\0\0", PE_OFFSET, "binary");
  image.writeUInt16LE(PE_MACHINE[architecture], PE_OFFSET + 4);
  image.writeUInt16LE(1, PE_OFFSET + 6);
  image.writeUInt16LE(PE_OPTIONAL_HEADER_SIZE, PE_OFFSET + 20);
  image.writeUInt16LE(0x2022, PE_OFFSET + 22);
  image.writeUInt16LE(0x20b, PE_OPTIONAL_HEADER_OFFSET);
  image.writeBigUInt64LE(0x140000000n, PE_OPTIONAL_HEADER_OFFSET + 24);
  image.writeUInt32LE(0x1000, PE_OPTIONAL_HEADER_OFFSET + 32);
  image.writeUInt32LE(0x200, PE_OPTIONAL_HEADER_OFFSET + 36);
  image.writeUInt32LE(0x2000, PE_OPTIONAL_HEADER_OFFSET + 56);
  image.writeUInt32LE(rawOffset, PE_OPTIONAL_HEADER_OFFSET + 60);
  image.writeUInt16LE(2, PE_OPTIONAL_HEADER_OFFSET + 68);
  image.writeUInt32LE(16, PE_OPTIONAL_HEADER_OFFSET + 108);
  image.write(".text", PE_SECTION_TABLE_OFFSET, "ascii");
  image.writeUInt32LE(payload.length, PE_SECTION_TABLE_OFFSET + 8);
  image.writeUInt32LE(0x1000, PE_SECTION_TABLE_OFFSET + 12);
  image.writeUInt32LE(payload.length, PE_SECTION_TABLE_OFFSET + 16);
  image.writeUInt32LE(rawOffset, PE_SECTION_TABLE_OFFSET + 20);
  image.writeUInt32LE(0x60000020, PE_SECTION_TABLE_OFFSET + 36);
  payload.copy(image, rawOffset);
  return image;
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

test("rejects a PE module in a macOS package", async () => {
  const fixture = await createPackage({
    platform: "darwin",
    architecture: "arm64",
    betterBytes: peModule("arm64", "145"),
  });
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture),
      ),
      /better_sqlite3\.node.*Mach-O.*darwin/su,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects a Mach-O module in a Windows package", async () => {
  const fixture = await createPackage({
    platform: "win32",
    architecture: "x64",
    betterBytes: thinMachO("x64", "145"),
  });
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture),
      ),
      /better_sqlite3\.node.*PE.*win32/su,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects malformed thin Mach-O bundle structures", async () => {
  const truncatedHeader = Buffer.concat([
    thinMachO("arm64", "145").subarray(0, 20),
    abiMarkers("145"),
  ]);
  const wrongFileType = Buffer.from(thinMachO("arm64", "145"));
  wrongFileType.writeUInt32LE(6, 12);
  const oversizedCommands = Buffer.from(thinMachO("arm64", "145"));
  oversizedCommands.writeUInt32LE(oversizedCommands.length, 20);
  const shortCommand = Buffer.from(thinMachO("arm64", "145"));
  shortCommand.writeUInt32LE(4, 36);
  const cases = [
    truncatedHeader,
    wrongFileType,
    oversizedCommands,
    shortCommand,
  ];
  const fixtures = await Promise.all(
    cases.map((betterBytes) => createPackage({ betterBytes })),
  );
  try {
    for (const fixture of fixtures) {
      await assert.rejects(
        verifyPackagedNativeModule(
          context(fixture),
          verificationOptions(fixture),
        ),
        /better_sqlite3\.node.*Mach-O.*(?:header|bundle|load command)/su,
      );
    }
  } finally {
    await Promise.all(fixtures.map(removeFixture));
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

test("rejects invalid fat Mach-O slice layouts and identities", async () => {
  const zeroSize = Buffer.from(fatMachO(["arm64"], "145"));
  zeroSize.writeUInt32BE(0, 20);
  const outOfRange = Buffer.from(fatMachO(["arm64"], "145"));
  outOfRange.writeUInt32BE(outOfRange.length - 1, 16);
  outOfRange.writeUInt32BE(16, 20);
  const tableOverlap = Buffer.from(fatMachO(["arm64"], "145"));
  tableOverlap.writeUInt32BE(8, 16);
  const sliceOverlap = Buffer.from(fatMachO(["arm64", "arm64"], "145"));
  sliceOverlap.writeUInt32BE(sliceOverlap.readUInt32BE(16), 36);
  const unsafeFat64Offset = Buffer.from(fat64MachO(["arm64"], "145"));
  unsafeFat64Offset.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 16);
  const mismatchedCpu = Buffer.from(fatMachO(["arm64"], "145"));
  mismatchedCpu.writeUInt32BE(MACH_O_CPU.x64, 8);
  const cases = [
    { betterBytes: zeroSize, architecture: "arm64" },
    { betterBytes: outOfRange, architecture: "arm64" },
    { betterBytes: tableOverlap, architecture: "arm64" },
    { betterBytes: sliceOverlap, architecture: "arm64" },
    { betterBytes: unsafeFat64Offset, architecture: "arm64" },
    { betterBytes: mismatchedCpu, architecture: "x64" },
  ];
  const fixtures = await Promise.all(cases.map(createPackage));
  try {
    for (const fixture of fixtures) {
      await assert.rejects(
        verifyPackagedNativeModule(
          context(fixture),
          verificationOptions(fixture),
        ),
        /better_sqlite3\.node.*Mach-O fat.*(?:slice|table|offset|size|CPU)/su,
      );
    }
  } finally {
    await Promise.all(fixtures.map(removeFixture));
  }
});

test("accepts a structurally valid fat64 Mach-O", async () => {
  const fixture = await createPackage({
    betterBytes: fat64MachO(["arm64"], "145"),
  });
  try {
    const result = await verifyPackagedNativeModule(
      context(fixture),
      verificationOptions(fixture),
    );
    assert.equal(result.inventory[0].architecture, "arm64");
    assert.equal(result.inventory[0].abi, "145");
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects an ABI marker outside all validated fat slices", async () => {
  const fixture = await createPackage({
    betterBytes: Buffer.concat([fatMachO(["arm64"]), abiMarkers("145")]),
  });
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture),
      ),
      /better_sqlite3\.node.*ABI marker is missing/su,
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

test("accepts repeated copies of one ABI marker", async () => {
  const fixture = await createPackage({
    betterBytes: thinMachO("arm64", "145", "145"),
  });
  try {
    const result = await verifyPackagedNativeModule(
      context(fixture),
      verificationOptions(fixture),
    );
    assert.equal(result.inventory[0].abi, "145");
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects truncated or invalid PE32+ DLL structures", async () => {
  const truncatedCoffSource = Buffer.from(peModule("x64", "145"));
  abiMarkers("145").copy(truncatedCoffSource, 0x40);
  const truncatedCoff = truncatedCoffSource.subarray(0, PE_OFFSET + 14);
  const truncatedOptional = Buffer.concat([
    peModule("x64", "145").subarray(0, PE_OPTIONAL_HEADER_OFFSET + 16),
    abiMarkers("145"),
  ]);
  const pe32Optional = Buffer.from(peModule("x64", "145"));
  pe32Optional.writeUInt16LE(0x10b, PE_OPTIONAL_HEADER_OFFSET);
  const zeroSections = Buffer.from(peModule("x64", "145"));
  zeroSections.writeUInt16LE(0, PE_OFFSET + 6);
  const nonDll = Buffer.from(peModule("x64", "145"));
  nonDll.writeUInt16LE(0x22, PE_OFFSET + 22);
  const truncatedSectionTable = Buffer.concat([
    peModule("x64", "145").subarray(0, PE_SECTION_TABLE_OFFSET + 8),
    abiMarkers("145"),
  ]);
  const cases = [
    truncatedCoff,
    truncatedOptional,
    pe32Optional,
    zeroSections,
    nonDll,
    truncatedSectionTable,
  ];
  const fixtures = await Promise.all(
    cases.map((betterBytes) =>
      createPackage({
        platform: "win32",
        architecture: "x64",
        betterBytes,
      }),
    ),
  );
  try {
    for (const fixture of fixtures) {
      await assert.rejects(
        verifyPackagedNativeModule(
          context(fixture),
          verificationOptions(fixture),
        ),
        /better_sqlite3\.node.*PE.*(?:COFF|optional header|section|characteristics)/su,
      );
    }
  } finally {
    await Promise.all(fixtures.map(removeFixture));
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

test("rejects a symbolic-link app.asar.unpacked root", async () => {
  const fixture = await createPackage();
  const target = join(fixture.root, "unpacked-root-target");
  await rename(fixture.unpackedRoot, target);
  await symlink(target, fixture.unpackedRoot, "dir");
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture),
      ),
      /inventory root.*symbolic link/su,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects a directory changed to a canonical escape after readdir", async () => {
  const fixture = await createPackage();
  const traversedDirectory = join(fixture.unpackedRoot, "node_modules");
  const escapedDirectory = join(fixture.root, "escaped-node_modules");
  let replaced = false;
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture, {
          readdir: async (directory, options) => {
            const entries = await readdir(directory, options);
            if (directory === fixture.unpackedRoot && !replaced) {
              await rename(traversedDirectory, escapedDirectory);
              await symlink(escapedDirectory, traversedDirectory, "dir");
              replaced = true;
            }
            return entries;
          },
        }),
      ),
      /(?:symbolic link|canonical root)/su,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects a real directory escape introduced after lstat", async () => {
  const fixture = await createPackage();
  const traversedDirectory = join(fixture.unpackedRoot, "node_modules");
  const escapedDirectory = join(fixture.root, "escaped-after-lstat");
  let replaced = false;
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture, {
          lstat: async (path) => {
            const status = await lstat(path);
            if (path === traversedDirectory && !replaced) {
              await rename(traversedDirectory, escapedDirectory);
              await symlink(escapedDirectory, traversedDirectory, "dir");
              replaced = true;
            }
            return status;
          },
        }),
      ),
      /canonical root/su,
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

// @lat: [[beta27-reliability-plan#Acceptance and release boundary#Complete packaged native inventory]]
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
