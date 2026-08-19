#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { extract as extractZip } from "@electron-internal/extract-zip";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalJSONStringify, hashArtifact } from "./candidate-manifest.mjs";
import {
  inspectNativeModuleBytes,
  resolveElectronAbi,
  scanUnpackedNativeModules,
} from "./native-module-abi.mjs";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^0\.7\.4-internal-beta\.\d+$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SHA512_PATTERN = /^[0-9a-f]{128}$/u;
const KINDS = new Set([
  "macos_dmg",
  "macos_zip",
  "windows_setup",
  "windows_portable",
  "windows_app_zip",
]);
const BETTER_SQLITE_PATH = posix.join(
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);

function fail(message) {
  throw new Error(`Final artifact native inventory failed: ${message}`);
}

function required(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value))
    fail(`${label} is invalid`);
  return value;
}

function normalizePlatform(value) {
  if (value === "darwin" || value === "win32") return value;
  fail("platform is invalid");
}

function normalizeArchitecture(value) {
  if (value === "arm64" || value === "x64") return value;
  fail("architecture is invalid");
}

function normalizeKind(value, platform) {
  if (!KINDS.has(value)) fail("artifact kind is invalid");
  if (
    (platform === "darwin" && !value.startsWith("macos_")) ||
    (platform === "win32" && !value.startsWith("windows_"))
  ) {
    fail("artifact kind differs from platform");
  }
  return value;
}

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    fail(`${label} fields are invalid`);
  }
  return value;
}

export function validateFinalArtifactNativeInventoryDocument(
  evidence,
  expected = {},
) {
  exactKeys(
    evidence,
    [
      "architecture",
      "artifact",
      "electronAbi",
      "inventory",
      "kind",
      "payload",
      "platform",
      "schemaVersion",
      "sourceSha",
      "version",
    ],
    "evidence",
  );
  if (evidence.schemaVersion !== 1) fail("schema version is invalid");
  required(evidence.sourceSha, SHA_PATTERN, "source SHA");
  required(evidence.version, VERSION_PATTERN, "desktop version");
  const platform = normalizePlatform(evidence.platform);
  normalizeArchitecture(evidence.architecture);
  normalizeKind(evidence.kind, platform);
  required(String(evidence.electronAbi), /^\d+$/u, "Electron ABI");
  exactKeys(
    evidence.artifact,
    ["name", "sha256", "sha512", "size"],
    "artifact",
  );
  if (
    typeof evidence.artifact.name !== "string" ||
    basename(evidence.artifact.name) !== evidence.artifact.name ||
    !Number.isSafeInteger(evidence.artifact.size) ||
    evidence.artifact.size <= 0 ||
    !SHA256_PATTERN.test(evidence.artifact.sha256) ||
    !SHA512_PATTERN.test(evidence.artifact.sha512)
  ) {
    fail("artifact identity is invalid");
  }
  exactKeys(evidence.payload, ["sha256"], "payload");
  if (!SHA256_PATTERN.test(evidence.payload.sha256))
    fail("payload digest is invalid");
  exactKeys(evidence.inventory, ["modules", "sha256"], "inventory");
  if (
    !Array.isArray(evidence.inventory.modules) ||
    evidence.inventory.modules.length === 0
  ) {
    fail("native inventory is empty");
  }
  let previous = "";
  for (const module of evidence.inventory.modules) {
    const keys = ["abi", "architecture", "format", "path", "sha256"];
    if (Object.hasOwn(module, "architectures")) keys.push("architectures");
    exactKeys(module, keys, "native module");
    if (
      typeof module.path !== "string" ||
      module.path <= previous ||
      !module.path.endsWith(".node") ||
      !SHA256_PATTERN.test(module.sha256) ||
      module.architecture !== evidence.architecture ||
      !["mach-o", "pe"].includes(module.format) ||
      !/^(?:\d+|napi-v1)$/u.test(module.abi)
    ) {
      fail("native module identity is invalid");
    }
    if (
      module.architectures !== undefined &&
      (!Array.isArray(module.architectures) ||
        !module.architectures.includes(evidence.architecture))
    ) {
      fail("native module architecture set is invalid");
    }
    previous = module.path;
  }
  const inventorySha256 = createHash("sha256")
    .update(canonicalJSONStringify(evidence.inventory.modules))
    .digest("hex");
  if (evidence.inventory.sha256 !== inventorySha256) {
    fail("inventory digest differs from modules");
  }
  for (const [field, value] of Object.entries(expected)) {
    if (field === "artifact") {
      for (const [artifactField, artifactValue] of Object.entries(value)) {
        if (evidence.artifact[artifactField] !== artifactValue) {
          fail("evidence differs from final artifact bytes");
        }
      }
    } else if (evidence[field] !== value) {
      fail(`${field} differs from expected identity`);
    }
  }
  return evidence;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function isPathInside(root, candidate) {
  const value = relative(root, candidate);
  return (
    value === "" ||
    (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  );
}

async function applicationSurface(root) {
  const canonicalRoot = await realpath(root);
  const entries = [];
  async function visit(directory, prefix) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath = posix.join(prefix, child.name);
      const status = await lstat(path);
      if (status.isSymbolicLink()) {
        const canonicalTarget = await realpath(path);
        if (!isPathInside(canonicalRoot, canonicalTarget)) {
          fail(`application symlink escapes payload: ${relativePath}`);
        }
        entries.push({
          path: relativePath,
          type: "symlink",
          target: await readlink(path),
        });
      } else if (status.isDirectory()) {
        await visit(path, relativePath);
      } else if (status.isFile()) {
        entries.push({
          path: relativePath,
          type: "file",
          size: status.size,
          sha256: await sha256File(path),
        });
      } else {
        fail(`application contains unsupported entry: ${relativePath}`);
      }
    }
  }
  await visit(canonicalRoot, "");
  if (entries.length === 0) fail("extracted application is empty");
  return entries;
}

function resourcesRoot(applicationRoot, platform) {
  return platform === "darwin"
    ? join(applicationRoot, "Contents", "Resources")
    : join(applicationRoot, "resources");
}

async function nativeInventory(
  applicationRoot,
  platform,
  architecture,
  electronAbi,
) {
  const unpackedRoot = join(
    resourcesRoot(applicationRoot, platform),
    "app.asar.unpacked",
  );
  const scan = await scanUnpackedNativeModules(unpackedRoot);
  if (
    !scan.modules.some((entry) => entry.relativePath === BETTER_SQLITE_PATH)
  ) {
    fail("better-sqlite3 is missing from extracted application");
  }
  const modules = [];
  for (const entry of scan.modules) {
    const inspected = inspectNativeModuleBytes(
      await readFile(entry.absolutePath),
      {
        label: entry.relativePath,
        expectedElectronAbi: electronAbi,
        expectedArchitecture: architecture,
        expectedPlatform: platform,
      },
    );
    const value = {
      path: entry.relativePath,
      sha256: inspected.sha256,
      abi: inspected.abi,
      architecture: inspected.architecture,
      format: inspected.format,
    };
    if (inspected.architectures.length > 1)
      value.architectures = inspected.architectures;
    modules.push(value);
  }
  modules.sort((left, right) => left.path.localeCompare(right.path));
  return modules;
}

export async function buildFinalArtifactNativeInventory(options) {
  const artifactPath = resolve(options.artifactPath);
  const applicationRoot = resolve(options.applicationRoot);
  if (!(await stat(artifactPath)).isFile()) fail("artifact is not a file");
  if (!(await stat(applicationRoot)).isDirectory())
    fail("application root is not a directory");
  const platform = normalizePlatform(options.platform);
  const architecture = normalizeArchitecture(options.architecture);
  const kind = normalizeKind(options.kind, platform);
  const sourceSha = required(options.sourceSha, SHA_PATTERN, "source SHA");
  const version = required(options.version, VERSION_PATTERN, "desktop version");
  const electronAbi = required(
    String(options.electronAbi),
    /^\d+$/u,
    "Electron ABI",
  );
  const [artifact, surface, modules] = await Promise.all([
    hashArtifact(artifactPath),
    applicationSurface(applicationRoot),
    nativeInventory(applicationRoot, platform, architecture, electronAbi),
  ]);
  const payloadSha256 = createHash("sha256")
    .update(canonicalJSONStringify(surface))
    .digest("hex");
  const inventorySha256 = createHash("sha256")
    .update(canonicalJSONStringify(modules))
    .digest("hex");
  return validateFinalArtifactNativeInventoryDocument({
    schemaVersion: 1,
    sourceSha,
    version,
    platform,
    architecture,
    kind,
    electronAbi,
    artifact: { name: basename(artifactPath), ...artifact },
    payload: { sha256: payloadSha256 },
    inventory: { sha256: inventorySha256, modules },
  });
}

export async function verifyFinalArtifactNativeInventory(evidence, options) {
  const rebuilt = await buildFinalArtifactNativeInventory(options);
  if (
    canonicalJSONStringify(evidence?.artifact) !==
    canonicalJSONStringify(rebuilt.artifact)
  ) {
    fail("evidence differs from final artifact bytes");
  }
  if (canonicalJSONStringify(evidence) !== canonicalJSONStringify(rebuilt)) {
    fail("evidence differs from extracted application bytes");
  }
  return evidence;
}

async function allFiles(root, predicate) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && predicate(entry.name, path))
        matches.push(path);
    }
  }
  await visit(root);
  return matches;
}

async function locateApplicationRoot(root, platform) {
  const asars = await allFiles(root, (name) => name === "app.asar");
  const roots = asars
    .map((path) => {
      const resources = dirname(path);
      return platform === "darwin"
        ? resolve(resources, "..", "..")
        : dirname(resources);
    })
    .filter((value, index, values) => values.indexOf(value) === index);
  if (roots.length !== 1)
    fail("artifact must contain exactly one application payload");
  return roots[0];
}

async function extractSevenZipArtifact(artifactPath, root) {
  await execFileAsync("7z", ["x", "-y", `-o${root}`, artifactPath], {
    maxBuffer: 16 * 1024 * 1024,
  });
  for (let round = 0; round < 3; round += 1) {
    try {
      return await locateApplicationRoot(root, "win32");
    } catch {
      const archives = await allFiles(root, (name) => name.endsWith(".7z"));
      if (archives.length === 0 || archives.length > 20) break;
      let extracted = false;
      for (const archive of archives) {
        const destination = `${archive}.unpacked`;
        try {
          await stat(destination);
        } catch {
          await execFileAsync("7z", ["x", "-y", `-o${destination}`, archive], {
            maxBuffer: 16 * 1024 * 1024,
          });
          extracted = true;
        }
      }
      if (!extracted) break;
    }
  }
  return locateApplicationRoot(root, "win32");
}

async function withExtractedApplication(
  artifactPath,
  kind,
  platform,
  callback,
) {
  const root = await mkdtemp(join(tmpdir(), "aera-final-artifact-"));
  let mounted = false;
  try {
    let applicationRoot;
    if (kind === "macos_dmg") {
      await execFileAsync("hdiutil", [
        "attach",
        "-nobrowse",
        "-readonly",
        "-mountpoint",
        root,
        artifactPath,
      ]);
      mounted = true;
      applicationRoot = await locateApplicationRoot(root, platform);
    } else if (kind === "macos_zip") {
      await execFileAsync("ditto", ["-x", "-k", artifactPath, root]);
      applicationRoot = await locateApplicationRoot(root, platform);
    } else if (kind === "windows_app_zip") {
      await extractZip(artifactPath, { dir: root });
      applicationRoot = await locateApplicationRoot(root, platform);
    } else {
      applicationRoot = await extractSevenZipArtifact(artifactPath, root);
    }
    return await callback(applicationRoot);
  } finally {
    if (mounted) {
      await execFileAsync("hdiutil", ["detach", root]).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
}

function parseArguments(values) {
  if (values.length === 0 || values.length % 2 !== 0)
    fail("arguments are invalid");
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    if (!flag?.startsWith("--") || values[index + 1] === undefined)
      fail("arguments are invalid");
    const key = flag.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(parsed, key)) fail(`duplicate option ${flag}`);
    parsed[key] = values[index + 1];
  }
  return parsed;
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const artifactPath = resolve(values.artifact);
  const platform = normalizePlatform(values.platform);
  const kind = normalizeKind(values.kind, platform);
  const electronAbi = await resolveElectronAbi(
    values.project_directory ?? process.cwd(),
  );
  const evidence = await withExtractedApplication(
    artifactPath,
    kind,
    platform,
    (applicationRoot) =>
      buildFinalArtifactNativeInventory({
        artifactPath,
        applicationRoot,
        kind,
        platform,
        architecture: values.architecture,
        sourceSha: values.source_sha,
        version: values.desktop_version,
        electronAbi,
      }),
  );
  await writeFile(resolve(values.output), canonicalJSONStringify(evidence), {
    flag: "wx",
    mode: 0o600,
  });
}

const isEntry =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
