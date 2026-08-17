#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runBoundedCommand } from "./aera-diagnostic-core.mjs";

const SOURCE_DIR = dirname(new URL(import.meta.url).pathname);
const SHARED_FILES = [
  "aera-diagnostic.mjs",
  "aera-diagnostic-core.mjs",
  "aera-diagnostic-events.mjs",
  "aera-diagnostic-model.mjs",
  "aera-diagnostic-sqlite.mjs",
  "aera-diagnostic-platform.mjs",
  "aera-diagnostic-platform-macos.mjs",
  "aera-diagnostic-platform-windows.mjs",
  "aera-diagnostic-redaction.mjs",
  "aera-diagnostic-environment.mjs",
  "aera-diagnostic-schema.mjs",
  "aera-diagnostic-bundle-v4.schema.json",
  "aera-diagnostic-target-v1.schema.json",
  "README.txt",
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeSums(staging, destination) {
  const rows = readdirSync(staging)
    .sort()
    .filter((name) => name !== "SHASUMS.txt")
    .map((name) => `${sha256(join(staging, name))}  ${name}`);
  const text = `${rows.join("\n")}\n`;
  writeFileSync(join(staging, "SHASUMS.txt"), text, "utf8");
  writeFileSync(join(destination, "SHASUMS.txt"), text, "utf8");
}

export function packageCollector({ platform, outputDir, targetPath = null }) {
  if (!new Set(["darwin", "win32"]).has(platform))
    throw new Error("collector platform must be darwin or win32");
  const destination = resolve(outputDir);
  const staging = join(destination, "staging");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const name of SHARED_FILES) {
    const source = join(SOURCE_DIR, name);
    if (!existsSync(source))
      throw new Error(`collector source missing: ${name}`);
    cpSync(source, join(staging, name), { force: true });
  }
  const launcher = platform === "darwin" ? "run-macos.sh" : "run-windows.ps1";
  cpSync(join(SOURCE_DIR, launcher), join(staging, launcher), { force: true });
  if (platform === "win32")
    cpSync(
      join(SOURCE_DIR, "run-windows.bat"),
      join(staging, "run-windows.bat"),
      { force: true },
    );
  if (targetPath)
    cpSync(resolve(targetPath), join(staging, "target.json"), { force: true });
  writeSums(staging, destination);
  const captureName = `Aera-Beta33-External-Diagnostic-${platform === "darwin" ? "macos" : "windows"}.zip`;
  const zipPath = join(destination, captureName);
  // Use the host-native archiver so one release host can build both customer
  // bundles. Windows users still receive the PowerShell launcher inside the
  // ZIP; macOS/Linux hosts do not need powershell.exe to package it.
  const command =
    process.platform === "win32"
      ? runBoundedCommand(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Compress-Archive -LiteralPath ${staging}\\* -DestinationPath ${zipPath} -Force`,
          ],
          { timeoutMs: 30_000, maximumBytes: 64 * 1024 },
        )
      : runBoundedCommand("zip", ["-X", "-q", "-r", zipPath, "."], {
          cwd: staging,
          timeoutMs: 30_000,
          maximumBytes: 64 * 1024,
        });
  if (command.code !== 0 || !existsSync(zipPath))
    throw new Error("collector artifact packaging failed");
  return { platform, staging, zipPath, files: readdirSync(staging).sort() };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  const platform = process.argv.includes("--windows") ? "win32" : "darwin";
  const outputIndex = process.argv.indexOf("--output");
  const outputDir =
    outputIndex >= 0
      ? process.argv[outputIndex + 1]
      : join(SOURCE_DIR, "artifacts");
  const targetIndex = process.argv.indexOf("--target");
  const targetPath = targetIndex >= 0 ? process.argv[targetIndex + 1] : null;
  try {
    console.log(
      JSON.stringify(
        packageCollector({ platform, outputDir, targetPath }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error?.message || "collector packaging failed");
    process.exitCode = 1;
  }
}
