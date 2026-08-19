/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, join, normalize, resolve } from "node:path";

import { runBoundedCommand } from "./aera-diagnostic-core.mjs";

const SHA256 = /^[0-9a-f]{64}$/iu;

export function windowsFileVersion(
  executable,
  commandRunner = runBoundedCommand,
  hostPlatform = process.platform,
) {
  if (hostPlatform !== "win32") return null;
  const literal = `'${String(executable).replaceAll("'", "''")}'`;
  const result = commandRunner(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `(Get-Item -LiteralPath ${literal}).VersionInfo.FileVersion`,
    ],
    { timeoutMs: 5_000, maximumBytes: 8 * 1024 },
  );
  if (result.code !== 0) return null;
  const version = result.stdout.trim().split(/\r?\n/u).at(-1)?.trim() || "";
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(version) ? version : null;
}

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
    const preferred = entries.filter((path) =>
      /(?:aera|agentera)/iu.test(basename(path)),
    );
    if (preferred.length > 1)
      throw new Error("target app has ambiguous executables");
    return preferred[0] || entries[0];
  }
  if (platform !== "darwin" && platform !== "win32")
    throw new Error("target platform is unsupported");
  if (platform === "win32") {
    let stat;
    try {
      stat = lstatSync(resolved);
    } catch {
      throw new Error("target executable is unavailable");
    }
    if (stat.isDirectory()) {
      const executables = readdirSync(resolved)
        .filter((name) => /\.exe$/iu.test(name) && !/uninstall/iu.test(name))
        .map((name) => join(resolved, name));
      if (executables.length !== 1)
        throw new Error("target Windows executable is ambiguous");
      return executables[0];
    }
  }
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
      if (stat.isSymbolicLink())
        throw new Error("target package contains symlink");
      digest.update(`${relativeName}\0${stat.isDirectory() ? "d" : "f"}\0`);
      if (stat.isDirectory()) visit(path, relativeName);
      else if (stat.isFile()) digest.update(readFileSync(path));
      else
        throw new Error(
          `target package contains unsupported entry: ${relativeName}`,
        );
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

export function inspectTargetIdentity({
  appPath,
  platform,
  version = null,
  applicationId = null,
}) {
  if (!appPath || typeof appPath !== "string")
    throw new Error("target app path is required");
  if (!new Set(["darwin", "win32"]).has(platform))
    throw new Error("target platform is unsupported");
  const resolvedApp = canonicalPath(appPath);
  const executable = resolveTargetExecutable(resolvedApp, platform);
  const executableSha256 = hashFile(executable);
  const appAsarPath =
    platform === "darwin"
      ? join(resolvedApp, "Contents", "Resources", "app.asar")
      : lstatSync(resolvedApp).isDirectory()
        ? join(resolvedApp, "resources", "app.asar")
        : join(resolve(resolvedApp, ".."), "resources", "app.asar");
  let packageSha256;
  try {
    packageSha256 = hashFile(appAsarPath);
  } catch {
    throw new Error("target package app.asar is unavailable");
  }
  const bundleId =
    platform === "darwin"
      ? plistValue(resolvedApp, "CFBundleIdentifier")
      : null;
  const detectedVersion =
    platform === "darwin"
      ? plistValue(resolvedApp, "CFBundleShortVersionString")
      : windowsFileVersion(executable);
  if (version && detectedVersion && version !== detectedVersion)
    throw new Error("target installed version differs from expected version");
  const identity =
    bundleId || applicationId || (platform === "win32" ? "unknown" : null);
  if (!identity) throw new Error("target application identity is unavailable");
  return {
    platform,
    version: detectedVersion || version || "unknown",
    bundleId,
    applicationId: platform === "win32" ? identity : null,
    architecture: detectArchitecture(executable, platform),
    executable,
    executableSha256,
    executablePathSha256: createHash("sha256")
      .update(
        `aera-diagnostic-executable-path-v1\0${normalize(
          platform === "darwin" && String(appPath).endsWith(".app")
            ? join(resolve(appPath), "Contents", "MacOS", basename(executable))
            : resolve(appPath),
        )}`,
      )
      .digest("hex"),
    packageSha256,
    packagePath: resolvedApp,
  };
}

export function assertTargetMatches(identity, target) {
  const mismatches = [];
  for (const field of [
    "platform",
    "version",
    "architecture",
    "executableSha256",
    "packageSha256",
  ]) {
    if (target[field] !== identity[field]) mismatches.push(field);
  }
  const expectedIdentity = target.bundleId || target.applicationId;
  const actualIdentity = identity.bundleId || identity.applicationId;
  if (
    expectedIdentity &&
    actualIdentity &&
    expectedIdentity !== "unknown" &&
    actualIdentity !== "unknown" &&
    expectedIdentity !== actualIdentity
  ) {
    mismatches.push("application identity");
  }
  if (mismatches.length)
    throw new Error(`target identity mismatch: ${mismatches.join(",")}`);
  return identity;
}

export function isProcessIdentityStable(before, after) {
  if (!before || !after) return false;
  return (
    Number.isInteger(before.pid) &&
    before.pid === after.pid &&
    typeof before.startTime === "string" &&
    before.startTime === after.startTime &&
    SHA256.test(before.executableSha256 || "") &&
    before.executableSha256 === after.executableSha256
  );
}

export function processIdentityFromRow(row, executableSha256) {
  if (!row || !Number.isInteger(row.pid) || row.pid <= 0)
    throw new Error("process pid is invalid");
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
    applicationIdentity:
      identity.bundleId || identity.applicationId || "unknown",
  };
}
