#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, posix, resolve } from "node:path";
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

function abiMarkers(bytes) {
  return new Set(
    [...bytes.toString("latin1").matchAll(/node_register_module_v(\d+)/gu)].map(
      (match) => match[1],
    ),
  );
}

export function parseNativeModuleAbi(bytes, label = "binary") {
  const matches = abiMarkers(bytes);
  if (matches.size > 1) {
    throw new Error(`native module ${label} has multiple ABI markers`);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

export async function readNativeModuleAbi(nativeModule) {
  return parseNativeModuleAbi(await readFile(nativeModule), nativeModule);
}

async function collectNativeModules(directory, prefix, out, readDirectory) {
  const entries = await readDirectory(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const relativePath = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `native module inventory cannot traverse symbolic link ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      await collectNativeModules(
        absolutePath,
        relativePath,
        out,
        readDirectory,
      );
      continue;
    }
    if (entry.isFile()) {
      if (entry.name.endsWith(".node")) {
        out.push({ absolutePath, relativePath });
      }
      continue;
    }
    throw new Error(
      `native module inventory found an unsupported filesystem entry ${relativePath}`,
    );
  }
}

export async function listUnpackedNativeModules(unpackedRoot, options = {}) {
  const found = [];
  await collectNativeModules(
    unpackedRoot,
    "",
    found,
    options.readdir ?? readdir,
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
  [0xfeedface, { kind: "thin", endian: "be" }],
  [0xfeedfacf, { kind: "thin", endian: "be" }],
  [0xcefaedfe, { kind: "thin", endian: "le" }],
  [0xcffaedfe, { kind: "thin", endian: "le" }],
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

function architectureForCpuType(cpuType, label) {
  const architecture = MACH_O_CPU_ARCHITECTURES.get(cpuType);
  if (!architecture) {
    throw new Error(
      `native module ${label} has unsupported Mach-O CPU type 0x${cpuType.toString(16)}`,
    );
  }
  return architecture;
}

function parseMachOArchitectures(bytes, magic, label) {
  const format = MACH_O_MAGICS.get(magic);
  if (!format) return null;
  if (format.kind === "thin") {
    return [
      architectureForCpuType(readUInt32(bytes, 4, format.endian, label), label),
    ];
  }

  const count = readUInt32(bytes, 4, format.endian, label);
  if (count < 1 || count > 64) {
    throw new Error(`native module ${label} has invalid Mach-O slice count`);
  }
  const entrySize = format.kind === "fat64" ? 32 : 20;
  requireRange(bytes, 8, count * entrySize, label);
  const architectures = [];
  for (let index = 0; index < count; index += 1) {
    const cpuType = readUInt32(
      bytes,
      8 + index * entrySize,
      format.endian,
      label,
    );
    const architecture = architectureForCpuType(cpuType, label);
    if (!architectures.includes(architecture)) architectures.push(architecture);
  }
  return architectures;
}

function parsePeArchitectures(bytes, label) {
  if (bytes.length < 2 || bytes.toString("ascii", 0, 2) !== "MZ") return null;
  requireRange(bytes, 0x3c, 4, label);
  const peOffset = bytes.readUInt32LE(0x3c);
  requireRange(bytes, peOffset, 6, label);
  if (bytes.toString("binary", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error(`native module ${label} has an invalid PE signature`);
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  const architecture = PE_MACHINE_ARCHITECTURES.get(machine);
  if (!architecture) {
    throw new Error(
      `native module ${label} has unsupported PE machine 0x${machine.toString(16)}`,
    );
  }
  return [architecture];
}

export function parseNativeModuleArchitectures(bytes, label = "binary") {
  requireRange(bytes, 0, 4, label);
  const machO = parseMachOArchitectures(bytes, bytes.readUInt32BE(0), label);
  if (machO) return machO;
  const pe = parsePeArchitectures(bytes, label);
  if (pe) return pe;
  throw new Error(`native module ${label} format is unsupported`);
}

export function inspectNativeModuleBytes(
  bytes,
  { label = "binary", expectedElectronAbi, expectedArchitecture },
) {
  const abi = parseNativeModuleAbi(bytes, label);
  if (abi === null) {
    throw new Error(`native module ${label} ABI marker is missing`);
  }
  if (abi !== expectedElectronAbi) {
    throw new Error(
      `native module ${label} ABI ${abi} differs from Electron ABI ${expectedElectronAbi}`,
    );
  }

  const architectures = parseNativeModuleArchitectures(bytes, label);
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
