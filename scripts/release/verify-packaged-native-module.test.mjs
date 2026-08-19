/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { listUnpackedNativeModules } from "./native-module-abi.mjs";
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

function uuidOnlyThinMachO(architecture, ...abis) {
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

const MACH_O_HEADER_SIZE = 32;
const MACH_O_SEGMENT_COMMAND_SIZE = 72;

function machOSegmentCommand({
  name,
  fileOffset,
  fileSize,
  maximumProtection = 5,
  initialProtection = 5,
}) {
  const command = Buffer.alloc(MACH_O_SEGMENT_COMMAND_SIZE);
  command.writeUInt32LE(0x19, 0);
  command.writeUInt32LE(command.length, 4);
  command.write(name, 8, 16, "ascii");
  command.writeBigUInt64LE(BigInt(fileSize), 32);
  command.writeBigUInt64LE(BigInt(fileOffset), 40);
  command.writeBigUInt64LE(BigInt(fileSize), 48);
  command.writeUInt32LE(maximumProtection, 56);
  command.writeUInt32LE(initialProtection, 60);
  return command;
}

function segmentedThinMachO(
  architecture,
  segmentCount,
  segmentFactory,
  ...abis
) {
  const payload = abiMarkers(...abis);
  const commandsEnd =
    MACH_O_HEADER_SIZE + segmentCount * MACH_O_SEGMENT_COMMAND_SIZE;
  const imageSize = commandsEnd + payload.length;
  const loadCommands = segmentFactory({ commandsEnd, imageSize }).map(
    machOSegmentCommand,
  );
  const header = Buffer.alloc(MACH_O_HEADER_SIZE);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(MACH_O_CPU[architecture], 4);
  header.writeUInt32LE(architecture === "x64" ? 3 : 0, 8);
  header.writeUInt32LE(8, 12);
  header.writeUInt32LE(loadCommands.length, 16);
  header.writeUInt32LE(loadCommands.length * MACH_O_SEGMENT_COMMAND_SIZE, 20);
  return Buffer.concat([header, ...loadCommands, payload]);
}

function thinMachO(architecture, ...abis) {
  return segmentedThinMachO(
    architecture,
    1,
    ({ imageSize }) => [{ name: "__TEXT", fileOffset: 0, fileSize: imageSize }],
    ...abis,
  );
}

function twoSegmentThinMachO(architecture, ...abis) {
  return segmentedThinMachO(
    architecture,
    2,
    ({ commandsEnd, imageSize }) => [
      { name: "__TEXT", fileOffset: 0, fileSize: commandsEnd },
      {
        name: "__LINKEDIT",
        fileOffset: commandsEnd,
        fileSize: imageSize - commandsEnd,
      },
    ],
    ...abis,
  );
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

function napiUniversalDylib(architectures) {
  const bytes = Buffer.from(fatMachO(architectures, "145"));
  const nodeMarker = Buffer.from("node_register_module_v145", "latin1");
  const napiMarker = Buffer.from("napi_register_module_v1", "latin1");
  for (let index = 0; index < architectures.length; index += 1) {
    const sliceOffset = bytes.readUInt32BE(8 + index * 20 + 8);
    bytes.writeUInt32LE(6, sliceOffset + 12);
    const markerOffset = bytes.indexOf(nodeMarker, sliceOffset);
    assert.notEqual(markerOffset, -1);
    bytes.fill(0, markerOffset, markerOffset + nodeMarker.length);
    napiMarker.copy(bytes, markerOffset);
  }
  return bytes;
}

function fat64MachO(architectures, ...abis) {
  return fatMachOWithKind("fat64", architectures, abis);
}

function peModule(architecture, ...abis) {
  const rawOffset = 0x200;
  const rawSize = 0x200;
  const payload = Buffer.concat([Buffer.from([0]), abiMarkers(...abis)]);
  const image = Buffer.alloc(rawOffset + rawSize);
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
  image.writeUInt32LE(0x200, PE_OPTIONAL_HEADER_OFFSET + 60);
  image.writeUInt16LE(2, PE_OPTIONAL_HEADER_OFFSET + 68);
  image.writeUInt32LE(16, PE_OPTIONAL_HEADER_OFFSET + 108);
  image.write(".text", PE_SECTION_TABLE_OFFSET, "ascii");
  image.writeUInt32LE(payload.length, PE_SECTION_TABLE_OFFSET + 8);
  image.writeUInt32LE(0x1000, PE_SECTION_TABLE_OFFSET + 12);
  image.writeUInt32LE(rawSize, PE_SECTION_TABLE_OFFSET + 16);
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

test("rejects a Mach-O bundle with only LC_UUID and an ABI marker", async () => {
  const fixture = await createPackage({
    betterBytes: uuidOnlyThinMachO("arm64", "145"),
  });
  try {
    await assert.rejects(
      verifyPackagedNativeModule(
        context(fixture),
        verificationOptions(fixture),
      ),
      /better_sqlite3\.node.*Mach-O.*__TEXT/su,
    );
  } finally {
    await removeFixture(fixture);
  }
});

for (const { name, createBytes } of [
  {
    name: "LC_SEGMENT_64 section count and command size mismatch",
    createBytes: () => {
      const bytes = Buffer.from(thinMachO("arm64", "145"));
      bytes.writeUInt32LE(1, MACH_O_HEADER_SIZE + 64);
      return bytes;
    },
  },
  {
    name: "segment range outside its thin slice",
    createBytes: () => {
      const bytes = Buffer.from(thinMachO("arm64", "145"));
      bytes.writeBigUInt64LE(BigInt(bytes.length + 1), MACH_O_HEADER_SIZE + 48);
      return bytes;
    },
  },
  {
    name: "overlapping mapped segment ranges",
    createBytes: () => {
      const bytes = Buffer.from(twoSegmentThinMachO("arm64", "145"));
      const secondSegment = MACH_O_HEADER_SIZE + MACH_O_SEGMENT_COMMAND_SIZE;
      bytes.writeBigUInt64LE(
        BigInt(MACH_O_HEADER_SIZE + 2 * MACH_O_SEGMENT_COMMAND_SIZE - 1),
        secondSegment + 40,
      );
      return bytes;
    },
  },
  {
    name: "non-executable __TEXT protections",
    createBytes: () => {
      const bytes = Buffer.from(thinMachO("arm64", "145"));
      bytes.writeUInt32LE(1, MACH_O_HEADER_SIZE + 56);
      bytes.writeUInt32LE(1, MACH_O_HEADER_SIZE + 60);
      return bytes;
    },
  },
  {
    name: "__TEXT that does not cover the load commands",
    createBytes: () => {
      const bytes = Buffer.from(thinMachO("arm64", "145"));
      bytes.writeBigUInt64LE(
        BigInt(MACH_O_HEADER_SIZE + MACH_O_SEGMENT_COMMAND_SIZE - 1),
        MACH_O_HEADER_SIZE + 48,
      );
      return bytes;
    },
  },
  {
    name: "duplicate non-empty __TEXT segments",
    createBytes: () => {
      const bytes = Buffer.from(twoSegmentThinMachO("arm64", "145"));
      const secondSegment = MACH_O_HEADER_SIZE + MACH_O_SEGMENT_COMMAND_SIZE;
      bytes.fill(0, secondSegment + 8, secondSegment + 24);
      bytes.write("__TEXT", secondSegment + 8, 16, "ascii");
      return bytes;
    },
  },
]) {
  test(`rejects a Mach-O bundle with ${name}`, async () => {
    const fixture = await createPackage({ betterBytes: createBytes() });
    try {
      await assert.rejects(
        verifyPackagedNativeModule(
          context(fixture),
          verificationOptions(fixture),
        ),
        /better_sqlite3\.node.*Mach-O.*(?:segment|__TEXT|protection)/su,
      );
    } finally {
      await removeFixture(fixture);
    }
  });
}

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

test("accepts a universal N-API dylib when it contains the packaged target", async () => {
  const fixture = await createPackage();
  const relativePath = join(
    "node_modules",
    "@electron-internal",
    "extract-zip",
    "index.darwin-universal.node",
  );
  await addNativeModule(
    fixture,
    relativePath,
    napiUniversalDylib(["x64", "arm64"]),
  );
  try {
    const result = await verifyPackagedNativeModule(
      context(fixture),
      verificationOptions(fixture),
    );
    const napiModule = result.inventory.find(
      (entry) => entry.path === relativePath,
    );
    assert.equal(napiModule.abi, "napi-v1");
    assert.equal(napiModule.architecture, "arm64");
    assert.deepEqual(napiModule.architectures, ["x64", "arm64"]);
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

for (const { name, mutate } of [
  {
    name: "zero section alignment",
    mutate: (bytes) => bytes.writeUInt32LE(0, PE_OPTIONAL_HEADER_OFFSET + 32),
  },
  {
    name: "non-power-of-two file alignment",
    mutate: (bytes) =>
      bytes.writeUInt32LE(0x180, PE_OPTIONAL_HEADER_OFFSET + 36),
  },
  {
    name: "undersized headers",
    mutate: (bytes) => bytes.writeUInt32LE(1, PE_OPTIONAL_HEADER_OFFSET + 60),
  },
  {
    name: "zero image size",
    mutate: (bytes) => bytes.writeUInt32LE(0, PE_OPTIONAL_HEADER_OFFSET + 56),
  },
  {
    name: "unaligned section virtual address",
    mutate: (bytes) => bytes.writeUInt32LE(1, PE_SECTION_TABLE_OFFSET + 12),
  },
  {
    name: "no executable code section",
    mutate: (bytes) =>
      bytes.writeUInt32LE(0x40000040, PE_SECTION_TABLE_OFFSET + 36),
  },
]) {
  test(`rejects a PE32+ shell with ${name}`, async () => {
    const betterBytes = Buffer.from(peModule("x64", "145"));
    mutate(betterBytes);
    const fixture = await createPackage({
      platform: "win32",
      architecture: "x64",
      betterBytes,
    });
    try {
      await assert.rejects(
        verifyPackagedNativeModule(
          context(fixture),
          verificationOptions(fixture),
        ),
        /better_sqlite3\.node.*PE.*(?:alignment|headers|image|section|executable)/su,
      );
    } finally {
      await removeFixture(fixture);
    }
  });
}

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

test("rejects an unpacked root replaced after its first lstat", async () => {
  const fixture = await createPackage();
  const externalRoot = join(fixture.root, "external-unpacked-root");
  const injectedPath = join(externalRoot, "injected.node");
  const originalRoot = join(fixture.root, "initially-validated-unpacked-root");
  await mkdir(externalRoot, { recursive: true });
  await writeFile(injectedPath, thinMachO("arm64", "145"));
  let replaced = false;
  try {
    await assert.rejects(
      async () => {
        const modules = await listUnpackedNativeModules(fixture.unpackedRoot, {
          lstat: async (path) => {
            const status = await lstat(path);
            if (path === fixture.unpackedRoot && !replaced) {
              await rename(fixture.unpackedRoot, originalRoot);
              await symlink(externalRoot, fixture.unpackedRoot, "dir");
              replaced = true;
            }
            return status;
          },
        });
        assert.equal(
          modules.some(({ relativePath }) => relativePath === "injected.node"),
          false,
          "inventory accepted a native module from the replacement root",
        );
      },
      (error) => {
        const message =
          error instanceof Error ? error.message : String(error ?? "");
        assert.match(message, /inventory root changed during validation/u);
        assert.equal(message.includes(fixture.root), false);
        assert.equal(replaced, true);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects an unpacked root replaced after realpath", async () => {
  const fixture = await createPackage();
  const externalRoot = join(fixture.root, "post-realpath-external-root");
  const originalRoot = join(fixture.root, "post-realpath-original-root");
  await mkdir(externalRoot, { recursive: true });
  let replaced = false;
  try {
    await assert.rejects(
      listUnpackedNativeModules(fixture.unpackedRoot, {
        realpath: async (path) => {
          const canonicalPath = await realpath(path);
          if (path === fixture.unpackedRoot && !replaced) {
            await rename(fixture.unpackedRoot, originalRoot);
            await symlink(externalRoot, fixture.unpackedRoot, "dir");
            replaced = true;
          }
          return canonicalPath;
        },
      }),
      (error) => {
        const message =
          error instanceof Error ? error.message : String(error ?? "");
        assert.match(message, /inventory root changed during validation/u);
        assert.equal(message.includes(fixture.root), false);
        assert.equal(replaced, true);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects an unpacked root replaced during traversal", async () => {
  const fixture = await createPackage();
  const externalRoot = join(fixture.root, "mid-traversal-external-root");
  const originalRoot = join(fixture.root, "mid-traversal-original-root");
  const verifiedModulePath = join(fixture.unpackedRoot, fixture.betterRelative);
  await mkdir(externalRoot, { recursive: true });
  let replaced = false;
  try {
    await assert.rejects(
      listUnpackedNativeModules(fixture.unpackedRoot, {
        realpath: async (path) => {
          const canonicalPath = await realpath(path);
          if (path === verifiedModulePath && !replaced) {
            await rename(fixture.unpackedRoot, originalRoot);
            await symlink(externalRoot, fixture.unpackedRoot, "dir");
            replaced = true;
          }
          return canonicalPath;
        },
      }),
      (error) => {
        const message =
          error instanceof Error ? error.message : String(error ?? "");
        assert.match(message, /inventory root changed during validation/u);
        assert.equal(message.includes(fixture.root), false);
        assert.equal(replaced, true);
        return true;
      },
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

test("rejects a final native module replaced after realpath validation", async () => {
  const fixture = await createPackage();
  const verifiedModulePath = join(fixture.unpackedRoot, fixture.betterRelative);
  const originalModulePath = join(fixture.root, "validated-original.node");
  const replacementModulePath = join(
    fixture.root,
    "post-realpath-replacement.node",
  );
  const replacementBytes = thinMachO("arm64", "145", "145");
  await writeFile(replacementModulePath, replacementBytes);
  let replaced = false;
  try {
    await assert.rejects(
      async () => {
        const result = await verifyPackagedNativeModule(
          context(fixture),
          verificationOptions(fixture, {
            realpath: async (path) => {
              const canonicalPath = await realpath(path);
              if (path === verifiedModulePath && !replaced) {
                await rename(verifiedModulePath, originalModulePath);
                await symlink(replacementModulePath, verifiedModulePath);
                replaced = true;
              }
              return canonicalPath;
            },
          }),
        );
        assert.notEqual(
          result.inventory[0].sha256,
          sha256(replacementBytes),
          "verification recorded post-realpath replacement bytes",
        );
      },
      (error) => {
        const message =
          error instanceof Error ? error.message : String(error ?? "");
        assert.match(message, /native module .* changed after validation/u);
        assert.equal(message.includes(fixture.root), false);
        assert.equal(replaced, true);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects a native module added after its leaf readdir snapshot", async () => {
  const fixture = await createPackage();
  const leafDirectory = dirname(
    join(fixture.unpackedRoot, fixture.betterRelative),
  );
  const lateRelative = join(dirname(fixture.betterRelative), "late.node");
  const latePath = join(fixture.unpackedRoot, lateRelative);
  let added = false;
  try {
    await assert.rejects(
      async () => {
        const result = await verifyPackagedNativeModule(
          context(fixture),
          verificationOptions(fixture, {
            readdir: async (directory, options) => {
              const entries = await readdir(directory, options);
              if (directory === leafDirectory && !added) {
                await writeFile(latePath, thinMachO("arm64", "145"));
                added = true;
              }
              return entries;
            },
          }),
        );
        assert.equal(
          result.inventory.some(
            ({ path }) => path === lateRelative.split("\\").join(posix.sep),
          ),
          false,
          "verification silently omitted a module added after leaf readdir",
        );
      },
      (error) => {
        const message =
          error instanceof Error ? error.message : String(error ?? "");
        assert.match(message, /native module inventory .*changed/u);
        assert.equal(message.includes(fixture.root), false);
        assert.equal(added, true);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects a descendant directory replaced after the first scan", async () => {
  const fixture = await createPackage();
  const modulePath = join(fixture.unpackedRoot, fixture.betterRelative);
  const releaseDirectory = dirname(modulePath);
  const originalDirectory = join(fixture.root, "first-scan-release");
  let replaced = false;
  try {
    await assert.rejects(
      async () => {
        const result = await verifyPackagedNativeModule(
          context(fixture),
          verificationOptions(fixture, {
            resolveElectronAbi: async () => {
              await rename(releaseDirectory, originalDirectory);
              await mkdir(releaseDirectory);
              await rename(
                join(originalDirectory, "better_sqlite3.node"),
                modulePath,
              );
              replaced = true;
              return fixture.abi;
            },
          }),
        );
        assert.equal(result.inventory.length, 1);
      },
      (error) => {
        const message =
          error instanceof Error ? error.message : String(error ?? "");
        assert.match(message, /native module inventory .*changed/u);
        assert.equal(message.includes(fixture.root), false);
        assert.equal(replaced, true);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rescans the stable native surface after reads and before inventory write", async () => {
  const fixture = await createPackage();
  let moduleReads = 0;
  let rootReadsAfterModules = 0;
  let inventoryWrites = 0;
  let inventoryWritten = false;
  try {
    const result = await verifyPackagedNativeModule(
      context(fixture),
      verificationOptions(fixture, {
        open: async (...args) => {
          const handle = await openFile(...args);
          return new Proxy(handle, {
            get(target, property) {
              if (property === "readFile") {
                return async (...readArgs) => {
                  const bytes = await target.readFile(...readArgs);
                  moduleReads += 1;
                  return bytes;
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
        readdir: async (directory, options) => {
          const entries = await readdir(directory, options);
          if (directory === fixture.unpackedRoot && moduleReads === 1) {
            assert.equal(inventoryWritten, false);
            rootReadsAfterModules += 1;
          }
          return entries;
        },
        writeFile: async (...args) => {
          const path = String(args[0]);
          if (path.endsWith("native-module-inventory-darwin-arm64.json")) {
            assert.equal(moduleReads, 1);
            assert.ok(rootReadsAfterModules >= 1);
            inventoryWrites += 1;
            inventoryWritten = true;
          }
          return writeFile(...args);
        },
      }),
    );

    assert.equal(result.inventory.length, 1);
    assert.equal(moduleReads, 1);
    assert.ok(rootReadsAfterModules >= 1);
    assert.equal(inventoryWrites, 1);
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
test("persists a sorted hashed macOS inventory and handle-reads each module once", async () => {
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
  const opens = new Map();
  const handleReads = new Map();
  try {
    const result = await verifyPackagedNativeModule(
      context(fixture),
      verificationOptions(fixture, {
        open: async (...args) => {
          const path = String(args[0]);
          opens.set(path, (opens.get(path) ?? 0) + 1);
          const handle = await openFile(...args);
          return new Proxy(handle, {
            get(target, property) {
              if (property === "readFile") {
                return async (...readArgs) => {
                  handleReads.set(path, (handleReads.get(path) ?? 0) + 1);
                  return target.readFile(...readArgs);
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
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
        format: "mach-o",
      },
      {
        path: betterPath,
        sha256: sha256(fixture.betterBytes),
        abi: "145",
        architecture: "arm64",
        format: "mach-o",
      },
    ]);
    assert.equal(
      result.inventoryPath.endsWith(
        "native-module-inventory-darwin-arm64.json",
      ),
      true,
    );
    assert.deepEqual([...opens.values()], [1, 1]);
    assert.deepEqual([...handleReads.values()], [1, 1]);

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
        format: "pe",
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
