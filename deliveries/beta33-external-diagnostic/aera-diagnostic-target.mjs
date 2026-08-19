/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { runBoundedCommand } from "./aera-diagnostic-core.mjs";

const SHA256 = /^[0-9a-f]{64}$/iu;
const ARCHITECTURES = new Set(["arm64", "x64"]);

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function plistValue(appPath, key) {
  try {
    const text = readFileSync(join(appPath, "Contents", "Info.plist"), "utf8");
    const match = text.match(
      new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, "iu"),
    );
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

export function resolveTargetExecutable(appPath, platform) {
  const resolved = canonicalPath(appPath);
  if (platform === "darwin" && resolved.endsWith(".app")) {
    const directory = join(resolved, "Contents", "MacOS");
    const entries = readdirSync(directory)
      .filter((name) => !name.startsWith("."))
      .map((name) => join(directory, name))
      .filter((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      });
    if (entries.length === 0) throw new Error("target app has no executable");
    const preferred = entries.filter((path) => /(?:aera|agentera)/iu.test(basename(path)));
    if (preferred.length > 1) throw new Error("target app has ambiguous executables");
    return preferred[0] || entries[0];
  }
  if (platform !== "darwin" && platform !== "win32")
    throw new Error("target platform is unsupported");
  return resolved;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function hashDirectory(root) {
  const canonicalRoot = canonicalPath(root);
  const digest = createHash("sha256");
  const visit = (directory, prefix = "") => {
    const names = readdirSync(directory).sort();
    for (const name of names) {
      if (name === ".DS_Store") continue;
      const path = join(directory, name);
      const relativeName = `${prefix}/${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("target package contains symlink");
      digest.update(`${relativeName}\0${stat.isDirectory() ? "d" : "f"}\0`);
      if (stat.isDirectory()) visit(path, relativeName);
      else if (stat.isFile()) digest.update(readFileSync(path));
      else throw new Error(`target package contains unsupported entry: ${relativeName}`);
    }
  };
  visit(canonicalRoot);
  return digest.digest("hex");
}

function detectArchitecture(executable, platform) {
  if (platform === "darwin") {
    const result = runBoundedCommand("file", [executable], {
      timeoutMs: 5_000,
      maximumBytes: 16 * 1024,
    });
    if (/arm64|aarch64/iu.test(result.stdout)) return "arm64";
    if (/x86_64|amd64/iu.test(result.stdout)) return "x64";
  }
  return process.arch === "arm64" ? "arm64" : "x64";
}

export function inspectTargetIdentity({ appPath, platform, version = null, applicationId = null }) {
  if (!appPath || typeof appPath !== "string") throw new Error("target app path is required");
  if (!new Set(["darwin", "win32"]).has(platform)) throw new Error("target platform is unsupported");
  const resolvedApp = canonicalPath(appPath);
  const executable = resolveTargetExecutable(resolvedApp, platform);
  const executableSha256 = hashFile(executable);
  const packageSha256 = lstatSync(resolvedApp).isDirectory()
    ? hashDirectory(resolvedApp)
    : executableSha256;
  const bundleId = platform === "darwin" ? plistValue(resolvedApp, "CFBundleIdentifier") : null;
  const detectedVersion = platform === "darwin" ? plistValue(resolvedApp, "CFBundleShortVersionString") : null;
  const identity = bundleId || applicationId || (platform === "win32" ? "unknown" : null);
  if (!identity) throw new Error("target application identity is unavailable");
  return {
    platform,
    version: version || detectedVersion || "unknown",
    bundleId,
    applicationId: platform === "win32" ? identity : null,
    architecture: detectArchitecture(executable, platform),
    executable,
    executableSha256,
    packageSha256,
    packagePath: resolvedApp,
  };
}

export function assertTargetMatches(identity, target) {
  const mismatches = [];
  for (const field of ["platform", "version", "architecture", "executableSha256", "packageSha256"]) {
    if (target[field] !== identity[field]) mismatches.push(field);
  }
  const expectedIdentity = target.bundleId || target.applicationId;
  const actualIdentity = identity.bundleId || identity.applicationId;
  if (expectedIdentity && expectedIdentity !== actualIdentity) mismatches.push("application identity");
  if (mismatches.length) throw new Error(`target identity mismatch: ${mismatches.join(",")}`);
  return identity;
}

export function isProcessIdentityStable(before, after) {
  if (!before || !after) return false;
  return Number.isInteger(before.pid) && before.pid === after.pid &&
    typeof before.startTime === "string" && before.startTime === after.startTime &&
    SHA256.test(before.executableSha256 || "") && before.executableSha256 === after.executableSha256;
}

export function processIdentityFromRow(row, executableSha256) {
  if (!row || !Number.isInteger(row.pid) || row.pid <= 0) throw new Error("process pid is invalid");
  return {
    pid: row.pid,
    startTime: String(row.startTime || "unknown"),
    executableSha256,
  };
}

export function descriptorIdentitySummary(identity) {
  return {
    platform: identity.platform,
    version: identity.version,
    architecture: identity.architecture,
    executableSha256: identity.executableSha256,
    packageSha256: identity.packageSha256,
    applicationIdentity: identity.bundleId || identity.applicationId || "unknown",
  };
}
