#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function resolveProjectNativeModule(projectDirectory) {
  return join(
    projectDirectory,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
}

export function resolvePackagedNativeModule(app) {
  return join(
    app,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
}

function abiMarkers(bytes, imageRanges) {
  const matches = new Set();
  for (const { offset, end } of imageRanges) {
    for (const match of bytes
      .subarray(offset, end)
      .toString("latin1")
      .matchAll(/node_register_module_v(\d+)/gu)) {
      matches.add(match[1]);
    }
  }
  return matches;
}

export function parseNativeModuleAbi(
  bytes,
  label = "binary",
  imageRanges = [{ offset: 0, end: bytes.length }],
) {
  const matches = abiMarkers(bytes, imageRanges);
  if (matches.size > 1) {
    throw new Error(`native module ${label} has multiple ABI markers`);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

export async function readNativeModuleAbi(nativeModule) {
  return parseNativeModuleAbi(await readFile(nativeModule), nativeModule);
}

function isCanonicalPathInside(root, candidate) {
  const candidateRelative = relative(root, candidate);
  return (
    candidateRelative === "" ||
    (candidateRelative !== ".." &&
      !candidateRelative.startsWith(`..${sep}`) &&
      !isAbsolute(candidateRelative))
  );
}

async function collectNativeModules(
  directory,
  prefix,
  canonicalRoot,
  out,
  readDirectory,
  inspectPath,
  resolveCanonicalPath,
) {
  const entries = await readDirectory(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const relativePath = prefix ? posix.join(prefix, entry.name) : entry.name;
    const status = await inspectPath(absolutePath);
    if (status.isSymbolicLink()) {
      throw new Error(
        `native module inventory cannot traverse symbolic link ${relativePath}`,
      );
    }
    const canonicalPath = await resolveCanonicalPath(absolutePath);
    if (!isCanonicalPathInside(canonicalRoot, canonicalPath)) {
      throw new Error(
        `native module inventory path escapes canonical root ${relativePath}`,
      );
    }
    if (status.isDirectory()) {
      await collectNativeModules(
        absolutePath,
        relativePath,
        canonicalRoot,
        out,
        readDirectory,
        inspectPath,
        resolveCanonicalPath,
      );
      continue;
    }
    if (status.isFile()) {
      if (entry.name.endsWith(".node")) {
        out.push({
          absolutePath: canonicalPath,
          relativePath,
          identity: {
            dev: status.dev,
            ino: status.ino,
            mode: status.mode,
            size: status.size,
          },
        });
      }
      continue;
    }
    throw new Error(
      `native module inventory found an unsupported filesystem entry ${relativePath}`,
    );
  }
}

export async function listUnpackedNativeModules(unpackedRoot, options = {}) {
  const inspectPath = options.lstat ?? lstat;
  const resolveCanonicalPath = options.realpath ?? realpath;
  const rootStatus = await inspectPath(unpackedRoot);
  if (rootStatus.isSymbolicLink()) {
    throw new Error("native module inventory root cannot be a symbolic link");
  }
  if (!rootStatus.isDirectory()) {
    throw new Error("native module inventory root must be a directory");
  }
  const canonicalRoot = await resolveCanonicalPath(unpackedRoot);
  const found = [];
  await collectNativeModules(
    unpackedRoot,
    "",
    canonicalRoot,
    found,
    options.readdir ?? readdir,
    inspectPath,
    resolveCanonicalPath,
  );
  found.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0,
  );
  return found;
}

const MACH_O_MAGICS = new Map([
  [0xfeedfacf, { kind: "thin64", endian: "be" }],
  [0xcffaedfe, { kind: "thin64", endian: "le" }],
  [0xcafebabe, { kind: "fat32", endian: "be" }],
  [0xcafebabf, { kind: "fat64", endian: "be" }],
  [0xbebafeca, { kind: "fat32", endian: "le" }],
  [0xbfbafeca, { kind: "fat64", endian: "le" }],
]);

const MACH_O_CPU_ARCHITECTURES = new Map([
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);

const PE_MACHINE_ARCHITECTURES = new Map([
  [0x8664, "x64"],
  [0xaa64, "arm64"],
]);

function requireRange(bytes, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.length
  ) {
    throw new Error(`native module ${label} header is truncated`);
  }
}

function readUInt32(bytes, offset, endian, label) {
  requireRange(bytes, offset, 4, label);
  return endian === "le"
    ? bytes.readUInt32LE(offset)
    : bytes.readUInt32BE(offset);
}

function readSafeUInt64(bytes, offset, endian, label, field) {
  requireRange(bytes, offset, 8, label);
  const value =
    endian === "le"
      ? bytes.readBigUInt64LE(offset)
      : bytes.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `native module ${label} Mach-O fat slice ${field} is not a safe integer`,
    );
  }
  return Number(value);
}

function architectureForCpuType(cpuType, label) {
  const architecture = MACH_O_CPU_ARCHITECTURES.get(cpuType);
  if (!architecture) {
    throw new Error(
      `native module ${label} has unsupported Mach-O CPU type 0x${cpuType.toString(16)}`,
    );
  }
  return architecture;
}

function requireMachORange(bytes, offset, length, limit, label, part) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > limit ||
    offset + length > bytes.length
  ) {
    throw new Error(`native module ${label} Mach-O ${part} is truncated`);
  }
}

function readMachOUInt32(bytes, offset, endian, limit, label, part) {
  requireMachORange(bytes, offset, 4, limit, label, part);
  return endian === "le"
    ? bytes.readUInt32LE(offset)
    : bytes.readUInt32BE(offset);
}

function parseThinMachO(bytes, offset, size, format, label) {
  const limit = offset + size;
  requireMachORange(bytes, offset, 32, limit, label, "64-bit header");
  const cpuType = readMachOUInt32(
    bytes,
    offset + 4,
    format.endian,
    limit,
    label,
    "CPU type",
  );
  const architecture = architectureForCpuType(cpuType, label);
  const fileType = readMachOUInt32(
    bytes,
    offset + 12,
    format.endian,
    limit,
    label,
    "file type",
  );
  if (fileType !== 8) {
    throw new Error(
      `native module ${label} Mach-O bundle file type is required`,
    );
  }
  const commandCount = readMachOUInt32(
    bytes,
    offset + 16,
    format.endian,
    limit,
    label,
    "load command count",
  );
  const commandBytes = readMachOUInt32(
    bytes,
    offset + 20,
    format.endian,
    limit,
    label,
    "load command size",
  );
  const commandsStart = offset + 32;
  requireMachORange(
    bytes,
    commandsStart,
    commandBytes,
    limit,
    label,
    "load command region",
  );
  if (commandCount > Math.floor(commandBytes / 8)) {
    throw new Error(
      `native module ${label} Mach-O load command count is invalid`,
    );
  }
  const commandsEnd = commandsStart + commandBytes;
  let cursor = commandsStart;
  for (let index = 0; index < commandCount; index += 1) {
    requireMachORange(
      bytes,
      cursor,
      8,
      commandsEnd,
      label,
      "load command header",
    );
    const commandSize = readMachOUInt32(
      bytes,
      cursor + 4,
      format.endian,
      commandsEnd,
      label,
      "load command size",
    );
    if (commandSize < 8) {
      throw new Error(
        `native module ${label} Mach-O load command size is invalid`,
      );
    }
    requireMachORange(
      bytes,
      cursor,
      commandSize,
      commandsEnd,
      label,
      "load command",
    );
    cursor += commandSize;
  }
  if (cursor !== commandsEnd) {
    throw new Error(
      `native module ${label} Mach-O load command boundaries are invalid`,
    );
  }
  return { architecture, cpuType };
}

function parseMachOImage(bytes, magic, label) {
  const format = MACH_O_MAGICS.get(magic);
  if (!format) return null;
  if (format.kind === "thin64") {
    return {
      architectures: [
        parseThinMachO(bytes, 0, bytes.length, format, label).architecture,
      ],
      imageRanges: [{ offset: 0, end: bytes.length }],
    };
  }

  const count = readUInt32(bytes, 4, format.endian, label);
  if (count < 1 || count > 64) {
    throw new Error(
      `native module ${label} has invalid Mach-O fat slice count`,
    );
  }
  const entrySize = format.kind === "fat64" ? 32 : 20;
  requireRange(bytes, 8, count * entrySize, label);
  const tableEnd = 8 + count * entrySize;
  const slices = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 8 + index * entrySize;
    const cpuType = readUInt32(bytes, entryOffset, format.endian, label);
    const offset =
      format.kind === "fat64"
        ? readSafeUInt64(bytes, entryOffset + 8, format.endian, label, "offset")
        : readUInt32(bytes, entryOffset + 8, format.endian, label);
    const size =
      format.kind === "fat64"
        ? readSafeUInt64(bytes, entryOffset + 16, format.endian, label, "size")
        : readUInt32(bytes, entryOffset + 12, format.endian, label);
    if (size === 0) {
      throw new Error(`native module ${label} Mach-O fat slice size is zero`);
    }
    if (offset < tableEnd) {
      throw new Error(
        `native module ${label} Mach-O fat slice overlaps the fat table`,
      );
    }
    if (offset > bytes.length || size > bytes.length - offset) {
      throw new Error(
        `native module ${label} Mach-O fat slice offset and size are out of range`,
      );
    }
    slices.push({ cpuType, offset, size, end: offset + size });
  }
  const orderedSlices = [...slices].sort(
    (left, right) => left.offset - right.offset,
  );
  for (let index = 1; index < orderedSlices.length; index += 1) {
    if (orderedSlices[index].offset < orderedSlices[index - 1].end) {
      throw new Error(`native module ${label} Mach-O fat slices overlap`);
    }
  }

  const architectures = [];
  for (const slice of slices) {
    const sliceMagic = readUInt32(bytes, slice.offset, "be", label);
    const sliceFormat = MACH_O_MAGICS.get(sliceMagic);
    if (sliceFormat?.kind !== "thin64") {
      throw new Error(
        `native module ${label} Mach-O fat slice does not contain a 64-bit Mach-O image`,
      );
    }
    const parsed = parseThinMachO(
      bytes,
      slice.offset,
      slice.size,
      sliceFormat,
      label,
    );
    if (parsed.cpuType !== slice.cpuType) {
      throw new Error(
        `native module ${label} Mach-O fat table CPU does not match embedded slice CPU`,
      );
    }
    const architecture = architectureForCpuType(slice.cpuType, label);
    if (!architectures.includes(architecture)) architectures.push(architecture);
  }
  return {
    architectures,
    imageRanges: slices.map(({ offset, end }) => ({ offset, end })),
  };
}

function requirePeRange(bytes, offset, length, label, part) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.length
  ) {
    throw new Error(`native module ${label} PE ${part} is truncated`);
  }
}

function parsePeImage(bytes, label) {
  if (bytes.length < 2 || bytes.toString("ascii", 0, 2) !== "MZ") return null;
  requirePeRange(bytes, 0x3c, 4, label, "DOS header");
  const peOffset = bytes.readUInt32LE(0x3c);
  requirePeRange(bytes, peOffset, 4, label, "signature");
  if (bytes.toString("binary", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error(`native module ${label} has an invalid PE signature`);
  }
  const coffOffset = peOffset + 4;
  requirePeRange(bytes, coffOffset, 20, label, "COFF header");
  const machine = bytes.readUInt16LE(peOffset + 4);
  const architecture = PE_MACHINE_ARCHITECTURES.get(machine);
  if (!architecture) {
    throw new Error(
      `native module ${label} has unsupported PE machine 0x${machine.toString(16)}`,
    );
  }
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  if (sectionCount === 0) {
    throw new Error(`native module ${label} PE section count is invalid`);
  }
  const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20);
  const characteristics = bytes.readUInt16LE(peOffset + 22);
  const requiredCharacteristics = 0x0002 | 0x2000;
  if ((characteristics & requiredCharacteristics) !== requiredCharacteristics) {
    throw new Error(
      `native module ${label} PE characteristics must mark an executable DLL`,
    );
  }

  const optionalHeaderOffset = peOffset + 24;
  if (optionalHeaderSize < 112) {
    throw new Error(
      `native module ${label} PE optional header size is invalid`,
    );
  }
  requirePeRange(
    bytes,
    optionalHeaderOffset,
    optionalHeaderSize,
    label,
    "optional header",
  );
  if (bytes.readUInt16LE(optionalHeaderOffset) !== 0x20b) {
    throw new Error(`native module ${label} PE optional header must be PE32+`);
  }
  const dataDirectoryCount = bytes.readUInt32LE(optionalHeaderOffset + 108);
  const requiredOptionalBytes = 112 + dataDirectoryCount * 8;
  if (
    !Number.isSafeInteger(requiredOptionalBytes) ||
    requiredOptionalBytes > optionalHeaderSize
  ) {
    throw new Error(
      `native module ${label} PE optional header data directories are out of bounds`,
    );
  }

  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
  const sectionTableSize = sectionCount * 40;
  requirePeRange(
    bytes,
    sectionTableOffset,
    sectionTableSize,
    label,
    "section table",
  );
  const sectionTableEnd = sectionTableOffset + sectionTableSize;
  const imageRanges = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const sectionOffset = sectionTableOffset + index * 40;
    const rawSize = bytes.readUInt32LE(sectionOffset + 16);
    const rawOffset = bytes.readUInt32LE(sectionOffset + 20);
    if (rawSize === 0) continue;
    if (rawOffset < sectionTableEnd) {
      throw new Error(
        `native module ${label} PE section overlaps the header table`,
      );
    }
    requirePeRange(bytes, rawOffset, rawSize, label, "section data");
    imageRanges.push({ offset: rawOffset, end: rawOffset + rawSize });
  }
  const orderedRanges = [...imageRanges].sort(
    (left, right) => left.offset - right.offset,
  );
  for (let index = 1; index < orderedRanges.length; index += 1) {
    if (orderedRanges[index].offset < orderedRanges[index - 1].end) {
      throw new Error(`native module ${label} PE section data overlaps`);
    }
  }
  return { architectures: [architecture], imageRanges };
}

export function parseNativeModule(bytes, label = "binary") {
  requireRange(bytes, 0, 4, label);
  const machO = parseMachOImage(bytes, bytes.readUInt32BE(0), label);
  if (machO) return { format: "mach-o", ...machO };
  const pe = parsePeImage(bytes, label);
  if (pe) return { format: "pe", ...pe };
  throw new Error(`native module ${label} format is unsupported`);
}

export function parseNativeModuleArchitectures(bytes, label = "binary") {
  return parseNativeModule(bytes, label).architectures;
}

export function inspectNativeModuleBytes(
  bytes,
  {
    label = "binary",
    expectedElectronAbi,
    expectedArchitecture,
    expectedPlatform,
  },
) {
  const parsed = parseNativeModule(bytes, label);
  const expectedFormat =
    expectedPlatform === "darwin"
      ? "mach-o"
      : expectedPlatform === "win32"
        ? "pe"
        : null;
  if (expectedFormat !== null && parsed.format !== expectedFormat) {
    const requiredName = expectedFormat === "mach-o" ? "Mach-O" : "PE";
    const actualName = parsed.format === "mach-o" ? "Mach-O" : "PE";
    throw new Error(
      `native module ${label} must be ${requiredName} for ${expectedPlatform} packages (found ${actualName})`,
    );
  }
  const abi = parseNativeModuleAbi(bytes, label, parsed.imageRanges);
  if (abi === null) {
    throw new Error(`native module ${label} ABI marker is missing`);
  }
  if (abi !== expectedElectronAbi) {
    throw new Error(
      `native module ${label} ABI ${abi} differs from Electron ABI ${expectedElectronAbi}`,
    );
  }

  const architectures = parsed.architectures;
  if (architectures.length !== 1) {
    throw new Error(
      `native module ${label} has mixed architectures ${architectures.join(",")}`,
    );
  }
  const architecture = architectures[0];
  if (architecture !== expectedArchitecture) {
    throw new Error(
      `native module ${label} architecture ${architecture} differs from target ${expectedArchitecture}`,
    );
  }

  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    abi,
    architecture,
    format: parsed.format,
  };
}

export async function readNativeModuleArchitectures(
  nativeModule,
  label = nativeModule,
) {
  return parseNativeModuleArchitectures(await readFile(nativeModule), label);
}

export async function verifyNativeModuleArchitecture(
  nativeModule,
  expectedArchitecture,
  label = nativeModule,
) {
  const architectures = await readNativeModuleArchitectures(
    nativeModule,
    label,
  );
  if (architectures.length !== 1) {
    throw new Error(
      `native module ${label} has mixed architectures ${architectures.join(",")}`,
    );
  }
  const architecture = architectures[0];
  if (architecture !== expectedArchitecture) {
    throw new Error(
      `native module ${label} architecture ${architecture} differs from target ${expectedArchitecture}`,
    );
  }
  return architecture;
}

export async function verifyNativeModuleAbi(
  nativeModule,
  expectedElectronAbi,
  label = "better-sqlite3",
) {
  const actualAbi = await readNativeModuleAbi(nativeModule);
  if (actualAbi !== expectedElectronAbi) {
    throw new Error(
      `native module ${label} ABI ${actualAbi ?? "unknown"} differs from Electron ABI ${expectedElectronAbi}`,
    );
  }
  return actualAbi;
}

export async function resolveElectronAbi(projectDirectory) {
  const projectRequire = createRequire(
    resolve(projectDirectory, "package.json"),
  );
  const electronExecutable = projectRequire("electron");
  const { stdout } = await execFileAsync(
    electronExecutable,
    ["-p", "process.versions.modules"],
    {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  const abi = stdout.trim();
  if (!/^\d+$/u.test(abi)) {
    throw new Error("Electron ABI could not be resolved");
  }
  return abi;
}
