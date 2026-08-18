#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
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

function napiMarkers(bytes, imageRanges) {
  const matches = new Set();
  for (const { offset, end } of imageRanges) {
    for (const match of bytes
      .subarray(offset, end)
      .toString("latin1")
      .matchAll(/napi_register_module_v(\d+)/gu)) {
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

function filesystemIdentity(status) {
  return {
    dev: status.dev,
    ino: status.ino,
    mode: status.mode,
    size: status.size,
  };
}

function hasDirectoryIdentity(status, identity) {
  return (
    status.isDirectory() &&
    status.dev === identity.dev &&
    status.ino === identity.ino &&
    status.size === identity.size &&
    (status.mode & constants.S_IFMT) === (identity.mode & constants.S_IFMT)
  );
}

function rootChangedError() {
  return new Error("native module inventory root changed during validation");
}

function directoryChangedError(relativePath) {
  return new Error(
    `native module inventory directory${relativePath ? ` ${relativePath}` : ""} changed after validation`,
  );
}

function entryChangedError(relativePath) {
  return new Error(
    `native module inventory entry changed during validation ${relativePath}`,
  );
}

function unreadableDirectoryError(relativePath) {
  return new Error(
    `native module inventory found an unreadable directory${relativePath ? ` ${relativePath}` : ""}`,
  );
}

function sameChildSurface(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.name === right[index].name && entry.type === right[index].type,
    )
  );
}

async function assertRootIdentity(path, identity, inspectPath) {
  let status;
  try {
    status = await inspectPath(path);
  } catch {
    throw rootChangedError();
  }
  if (!hasDirectoryIdentity(status, identity)) {
    throw rootChangedError();
  }
}

async function readInventoryDirectory(directory, relativePath, readDirectory) {
  try {
    return await readDirectory(directory, { withFileTypes: true });
  } catch {
    throw unreadableDirectoryError(relativePath);
  }
}

async function inspectInventoryEntry(path, relativePath, inspectPath) {
  try {
    return await inspectPath(path);
  } catch {
    throw entryChangedError(relativePath);
  }
}

async function resolveInventoryEntry(path, relativePath, resolveCanonicalPath) {
  try {
    return await resolveCanonicalPath(path);
  } catch {
    throw entryChangedError(relativePath);
  }
}

async function collectNativeSurface(
  directory,
  prefix,
  canonicalRoot,
  directoryStatus,
  canonicalDirectory,
  modules,
  surface,
  directorySnapshots,
  readDirectory,
  inspectPath,
  resolveCanonicalPath,
) {
  const directoryIdentity = filesystemIdentity(directoryStatus);
  const canonicalStatus = await inspectInventoryEntry(
    canonicalDirectory,
    prefix,
    inspectPath,
  );
  if (!hasDirectoryIdentity(canonicalStatus, directoryIdentity)) {
    throw directoryChangedError(prefix);
  }
  surface.push({
    relativePath: prefix,
    canonicalPath: canonicalDirectory,
    identity: directoryIdentity,
  });
  const entries = await readInventoryDirectory(
    directory,
    prefix,
    readDirectory,
  );
  const children = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const relativePath = prefix ? posix.join(prefix, entry.name) : entry.name;
    const status = await inspectInventoryEntry(
      absolutePath,
      relativePath,
      inspectPath,
    );
    children.push({
      name: entry.name,
      type: status.mode & constants.S_IFMT,
    });
    if (status.isSymbolicLink()) {
      throw new Error(
        `native module inventory cannot traverse symbolic link ${relativePath}`,
      );
    }
    const canonicalPath = await resolveInventoryEntry(
      absolutePath,
      relativePath,
      resolveCanonicalPath,
    );
    if (!isCanonicalPathInside(canonicalRoot, canonicalPath)) {
      throw new Error(
        `native module inventory path escapes canonical root ${relativePath}`,
      );
    }
    if (status.isDirectory()) {
      await collectNativeSurface(
        absolutePath,
        relativePath,
        canonicalRoot,
        status,
        canonicalPath,
        modules,
        surface,
        directorySnapshots,
        readDirectory,
        inspectPath,
        resolveCanonicalPath,
      );
      continue;
    }
    if (status.isFile()) {
      const identity = filesystemIdentity(status);
      surface.push({ relativePath, canonicalPath, identity });
      if (entry.name.endsWith(".node")) {
        modules.push({
          absolutePath: canonicalPath,
          relativePath,
          identity,
        });
      }
      continue;
    }
    throw new Error(
      `native module inventory found an unsupported filesystem entry ${relativePath}`,
    );
  }
  children.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  directorySnapshots.push({
    absolutePath: directory,
    relativePath: prefix,
    canonicalPath: canonicalDirectory,
    identity: directoryIdentity,
    canonicalIdentity: filesystemIdentity(canonicalStatus),
    children,
  });
}

async function revalidateDirectorySnapshot(
  snapshot,
  readDirectory,
  inspectPath,
  resolveCanonicalPath,
) {
  let status;
  let canonicalPath;
  let canonicalStatus;
  try {
    status = await inspectPath(snapshot.absolutePath);
    canonicalPath = await resolveCanonicalPath(snapshot.absolutePath);
    canonicalStatus = await inspectPath(canonicalPath);
  } catch {
    throw directoryChangedError(snapshot.relativePath);
  }
  if (
    !hasDirectoryIdentity(status, snapshot.identity) ||
    canonicalPath !== snapshot.canonicalPath ||
    !hasDirectoryIdentity(canonicalStatus, snapshot.canonicalIdentity)
  ) {
    throw directoryChangedError(snapshot.relativePath);
  }
  let entries;
  try {
    entries = await readDirectory(snapshot.absolutePath, {
      withFileTypes: true,
    });
  } catch {
    throw directoryChangedError(snapshot.relativePath);
  }
  const children = [];
  for (const entry of entries) {
    let childStatus;
    try {
      childStatus = await inspectPath(join(snapshot.absolutePath, entry.name));
    } catch {
      throw directoryChangedError(snapshot.relativePath);
    }
    children.push({
      name: entry.name,
      type: childStatus.mode & constants.S_IFMT,
    });
  }
  children.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  if (!sameChildSurface(children, snapshot.children)) {
    throw directoryChangedError(snapshot.relativePath);
  }
}

export async function scanUnpackedNativeModules(unpackedRoot, options = {}) {
  const inspectPath = options.lstat ?? lstat;
  const resolveCanonicalPath = options.realpath ?? realpath;
  const readDirectory = options.readdir ?? readdir;
  let rootStatus;
  try {
    rootStatus = await inspectPath(unpackedRoot);
  } catch {
    throw rootChangedError();
  }
  if (rootStatus.isSymbolicLink()) {
    throw new Error("native module inventory root cannot be a symbolic link");
  }
  if (!rootStatus.isDirectory()) {
    throw new Error("native module inventory root must be a directory");
  }
  const rootIdentity = filesystemIdentity(rootStatus);
  let canonicalRoot;
  try {
    canonicalRoot = await resolveCanonicalPath(unpackedRoot);
  } catch {
    throw rootChangedError();
  }
  await assertRootIdentity(canonicalRoot, rootIdentity, inspectPath);
  await assertRootIdentity(unpackedRoot, rootIdentity, inspectPath);
  const modules = [];
  const surface = [];
  const directorySnapshots = [];
  try {
    await collectNativeSurface(
      unpackedRoot,
      "",
      canonicalRoot,
      rootStatus,
      canonicalRoot,
      modules,
      surface,
      directorySnapshots,
      readDirectory,
      inspectPath,
      resolveCanonicalPath,
    );
    for (const snapshot of directorySnapshots) {
      await revalidateDirectorySnapshot(
        snapshot,
        readDirectory,
        inspectPath,
        resolveCanonicalPath,
      );
    }
  } catch (error) {
    await assertRootIdentity(unpackedRoot, rootIdentity, inspectPath);
    throw error;
  }
  await assertRootIdentity(unpackedRoot, rootIdentity, inspectPath);
  modules.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0,
  );
  surface.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0,
  );
  return { modules, surface };
}

export async function listUnpackedNativeModules(unpackedRoot, options = {}) {
  return (await scanUnpackedNativeModules(unpackedRoot, options)).modules;
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

function readMachOSafeUInt64(bytes, offset, endian, limit, label, field) {
  requireMachORange(bytes, offset, 8, limit, label, `segment ${field}`);
  const value =
    endian === "le"
      ? bytes.readBigUInt64LE(offset)
      : bytes.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `native module ${label} Mach-O segment ${field} is not a safe integer`,
    );
  }
  return Number(value);
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
  if (fileType !== 6 && fileType !== 8) {
    throw new Error(
      `native module ${label} Mach-O bundle or dynamic library file type is required`,
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
  const imageRanges = [];
  const textSegments = [];
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
    const command = readMachOUInt32(
      bytes,
      cursor,
      format.endian,
      commandsEnd,
      label,
      "load command",
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
    if (command === 0x19) {
      if (commandSize < 72) {
        throw new Error(
          `native module ${label} Mach-O segment command size is invalid`,
        );
      }
      const sectionCount = readMachOUInt32(
        bytes,
        cursor + 64,
        format.endian,
        cursor + commandSize,
        label,
        "segment section count",
      );
      if (commandSize !== 72 + sectionCount * 80) {
        throw new Error(
          `native module ${label} Mach-O segment section count and command size are inconsistent`,
        );
      }
      const nameBytes = bytes.subarray(cursor + 8, cursor + 24);
      const terminator = nameBytes.indexOf(0);
      const name = nameBytes
        .subarray(0, terminator === -1 ? nameBytes.length : terminator)
        .toString("ascii");
      const fileOffset = readMachOSafeUInt64(
        bytes,
        cursor + 40,
        format.endian,
        cursor + commandSize,
        label,
        "file offset",
      );
      const fileSize = readMachOSafeUInt64(
        bytes,
        cursor + 48,
        format.endian,
        cursor + commandSize,
        label,
        "file size",
      );
      const maximumProtection = readMachOUInt32(
        bytes,
        cursor + 56,
        format.endian,
        cursor + commandSize,
        label,
        "segment maximum protection",
      );
      const initialProtection = readMachOUInt32(
        bytes,
        cursor + 60,
        format.endian,
        cursor + commandSize,
        label,
        "segment initial protection",
      );
      if (fileOffset > size || fileSize > size - fileOffset) {
        throw new Error(
          `native module ${label} Mach-O segment file range is outside its slice`,
        );
      }
      if (fileSize > 0) {
        const segment = {
          name,
          fileOffset,
          fileSize,
          maximumProtection,
          initialProtection,
          offset: offset + fileOffset,
          end: offset + fileOffset + fileSize,
        };
        imageRanges.push({ offset: segment.offset, end: segment.end });
        if (name === "__TEXT") textSegments.push(segment);
      }
    }
    cursor += commandSize;
  }
  if (cursor !== commandsEnd) {
    throw new Error(
      `native module ${label} Mach-O load command boundaries are invalid`,
    );
  }
  if (textSegments.length !== 1) {
    throw new Error(
      `native module ${label} Mach-O must contain exactly one non-empty __TEXT segment`,
    );
  }
  const textSegment = textSegments[0];
  if (
    textSegment.fileOffset !== 0 ||
    textSegment.fileSize < commandsEnd - offset
  ) {
    throw new Error(
      `native module ${label} Mach-O __TEXT segment must cover the header and load commands`,
    );
  }
  const readExecuteProtection = 1 | 4;
  if (
    (textSegment.maximumProtection & readExecuteProtection) !==
      readExecuteProtection ||
    (textSegment.initialProtection & readExecuteProtection) !==
      readExecuteProtection
  ) {
    throw new Error(
      `native module ${label} Mach-O __TEXT segment protections must be readable and executable`,
    );
  }
  const orderedRanges = [...imageRanges].sort(
    (left, right) => left.offset - right.offset,
  );
  for (let index = 1; index < orderedRanges.length; index += 1) {
    if (orderedRanges[index].offset < orderedRanges[index - 1].end) {
      throw new Error(
        `native module ${label} Mach-O mapped segment ranges overlap`,
      );
    }
  }
  return { architecture, cpuType, fileType, imageRanges };
}

function parseMachOImage(bytes, magic, label) {
  const format = MACH_O_MAGICS.get(magic);
  if (!format) return null;
  if (format.kind === "thin64") {
    const parsed = parseThinMachO(bytes, 0, bytes.length, format, label);
    return {
      architectures: [parsed.architecture],
      fileTypes: [parsed.fileType],
      imageRanges: parsed.imageRanges,
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
  const fileTypes = [];
  const imageRanges = [];
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
    if (!fileTypes.includes(parsed.fileType)) fileTypes.push(parsed.fileType);
    imageRanges.push(...parsed.imageRanges);
  }
  return {
    architectures,
    fileTypes,
    imageRanges,
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

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

function alignUp(value, alignment) {
  const remainder = value % alignment;
  return remainder === 0 ? value : value + alignment - remainder;
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
  const sectionAlignment = bytes.readUInt32LE(optionalHeaderOffset + 32);
  const fileAlignment = bytes.readUInt32LE(optionalHeaderOffset + 36);
  if (
    !isPowerOfTwo(sectionAlignment) ||
    !isPowerOfTwo(fileAlignment) ||
    sectionAlignment < fileAlignment
  ) {
    throw new Error(`native module ${label} PE alignment values are invalid`);
  }
  const sizeOfImage = bytes.readUInt32LE(optionalHeaderOffset + 56);
  const sizeOfHeaders = bytes.readUInt32LE(optionalHeaderOffset + 60);
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
  if (
    sizeOfHeaders < sectionTableEnd ||
    sizeOfHeaders > bytes.length ||
    sizeOfHeaders % fileAlignment !== 0
  ) {
    throw new Error(
      `native module ${label} PE headers size or alignment is invalid`,
    );
  }
  const firstSectionAddress = alignUp(sizeOfHeaders, sectionAlignment);
  if (
    sizeOfImage === 0 ||
    sizeOfImage % sectionAlignment !== 0 ||
    sizeOfImage < firstSectionAddress
  ) {
    throw new Error(
      `native module ${label} PE image size or alignment is invalid`,
    );
  }
  const imageRanges = [];
  const virtualRanges = [];
  let hasExecutableCode = false;
  for (let index = 0; index < sectionCount; index += 1) {
    const sectionOffset = sectionTableOffset + index * 40;
    const virtualSize = bytes.readUInt32LE(sectionOffset + 8);
    const virtualAddress = bytes.readUInt32LE(sectionOffset + 12);
    const rawSize = bytes.readUInt32LE(sectionOffset + 16);
    const rawOffset = bytes.readUInt32LE(sectionOffset + 20);
    const sectionCharacteristics = bytes.readUInt32LE(sectionOffset + 36);
    if (virtualSize === 0 && rawSize === 0) continue;
    const virtualSpan = Math.max(virtualSize, rawSize);
    if (
      virtualAddress % sectionAlignment !== 0 ||
      virtualAddress < firstSectionAddress ||
      virtualAddress > sizeOfImage ||
      virtualSpan > sizeOfImage - virtualAddress
    ) {
      throw new Error(
        `native module ${label} PE section virtual range or alignment is invalid`,
      );
    }
    virtualRanges.push({
      offset: virtualAddress,
      end: virtualAddress + virtualSpan,
    });
    if (rawSize > 0) {
      if (
        rawOffset < sizeOfHeaders ||
        rawOffset % fileAlignment !== 0 ||
        rawSize % fileAlignment !== 0
      ) {
        throw new Error(
          `native module ${label} PE section data range or alignment is invalid`,
        );
      }
      requirePeRange(bytes, rawOffset, rawSize, label, "section data");
      imageRanges.push({ offset: rawOffset, end: rawOffset + rawSize });
      const requiredCodeCharacteristics = 0x20 | 0x20000000 | 0x40000000;
      if (
        (sectionCharacteristics & requiredCodeCharacteristics) ===
        requiredCodeCharacteristics
      ) {
        hasExecutableCode = true;
      }
    }
  }
  const orderedRanges = [...imageRanges].sort(
    (left, right) => left.offset - right.offset,
  );
  for (let index = 1; index < orderedRanges.length; index += 1) {
    if (orderedRanges[index].offset < orderedRanges[index - 1].end) {
      throw new Error(`native module ${label} PE section data overlaps`);
    }
  }
  const orderedVirtualRanges = [...virtualRanges].sort(
    (left, right) => left.offset - right.offset,
  );
  for (let index = 1; index < orderedVirtualRanges.length; index += 1) {
    if (
      orderedVirtualRanges[index].offset < orderedVirtualRanges[index - 1].end
    ) {
      throw new Error(
        `native module ${label} PE section virtual ranges overlap`,
      );
    }
  }
  if (!hasExecutableCode) {
    throw new Error(
      `native module ${label} PE must contain a non-empty executable readable code section`,
    );
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
  const napiVersions = napiMarkers(bytes, parsed.imageRanges);
  if (abi !== null && napiVersions.size > 0) {
    throw new Error(
      `native module ${label} has mixed Node-ABI and N-API registration markers`,
    );
  }
  if (napiVersions.size > 1) {
    throw new Error(
      `native module ${label} has multiple N-API registration markers`,
    );
  }
  const architectures = parsed.architectures;
  if (abi !== null) {
    if (
      parsed.format === "mach-o" &&
      parsed.fileTypes?.some((value) => value !== 8)
    ) {
      throw new Error(
        `native module ${label} Mach-O bundle file type is required for Node-ABI modules`,
      );
    }
    if (abi !== expectedElectronAbi) {
      throw new Error(
        `native module ${label} ABI ${abi} differs from Electron ABI ${expectedElectronAbi}`,
      );
    }
    if (architectures.length !== 1) {
      throw new Error(
        `native module ${label} has mixed architectures ${architectures.join(",")}`,
      );
    }
  } else if (napiVersions.size === 0) {
    throw new Error(`native module ${label} ABI marker is missing`);
  } else if (![...napiVersions].every((value) => value === "1")) {
    throw new Error(
      `native module ${label} N-API registration version is unsupported`,
    );
  }
  if (!architectures.includes(expectedArchitecture)) {
    if (architectures.length === 1) {
      throw new Error(
        `native module ${label} architecture ${architectures[0]} differs from target ${expectedArchitecture}`,
      );
    }
    throw new Error(
      `native module ${label} architectures ${architectures.join(",")} do not include target ${expectedArchitecture}`,
    );
  }

  const registrationAbi = abi ?? `napi-v${[...napiVersions][0]}`;

  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    abi: registrationAbi,
    architecture: expectedArchitecture,
    architectures,
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
