import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { expect, it } from "vitest";

import {
  runIsolatedRuntimeHealthCheck,
  type RuntimeHealthCommandRunner,
} from "../src/main/agentera-runtime-distribution/health";
import { createRuntimeDistributionPaths } from "../src/main/agentera-runtime-distribution/paths";
import {
  getAvailableRuntimeDiskBytes,
  installPackagedSeed,
} from "../src/main/agentera-runtime-distribution/seed-installer";
import { loadRuntimeTrustFile } from "../src/main/agentera-runtime-distribution/trust";

const enabled = process.env.AGENTERA_RUNTIME_INSTALL_DIAGNOSTIC === "1";
const diagnostic = enabled ? it : it.skip;
const HEALTH_MAX_OUTPUT_BYTES = 1024 * 1024;

function requiredAbsoluteEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}

// @lat: [[agentera-runtime-distribution#Release gate#Windows Seed install timing diagnostic]]
diagnostic(
  "measures the real locked Windows Runtime Seed installation stages",
  async () => {
    const seedDirectory = requiredAbsoluteEnvironment(
      "AGENTERA_RUNTIME_SEED_DIR",
    );
    const output = requiredAbsoluteEnvironment(
      "AGENTERA_RUNTIME_INSTALL_DIAGNOSTIC_OUTPUT",
    );
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, "", { flag: "w", mode: 0o600 });

    const started = performance.now();
    const record = (
      event: string,
      fields: Readonly<Record<string, boolean | number | string | null>> = {},
    ): void => {
      const entry = {
        schemaVersion: 1,
        event,
        elapsedMs: Math.round(performance.now() - started),
        ...fields,
      };
      const line = JSON.stringify(entry);
      appendFileSync(output, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      process.stdout.write(`[RUNTIME_INSTALL_DIAGNOSTIC] ${line}\n`);
    };

    const seedEntries = (await readdir(seedDirectory)).filter(
      (entry) => entry !== ".gitkeep",
    );
    const manifestName = seedEntries.find((entry) =>
      entry.endsWith(".manifest.json"),
    );
    if (!manifestName) throw new Error("Runtime Seed manifest is missing");
    const manifest = JSON.parse(
      await readFile(join(seedDirectory, manifestName), "utf8"),
    ) as {
      archive_size: number;
      files: Array<{ kind: string; size: number }>;
      runtime_version: string;
      source_commit: string;
    };
    record("diagnostic-start", {
      platform: process.platform,
      architecture: process.arch,
      archiveBytes: manifest.archive_size,
      inventoryEntries: manifest.files.length,
      inventoryFiles: manifest.files.filter((entry) => entry.kind === "file")
        .length,
      extractedBytes: manifest.files
        .filter((entry) => entry.kind === "file")
        .reduce((total, entry) => total + entry.size, 0),
    });

    let probe = 0;
    const healthRunner: RuntimeHealthCommandRunner = (
      executable,
      args,
      options,
    ) => {
      const probeNumber = (probe += 1);
      const probeStarted = performance.now();
      record("health-probe-start", {
        probe: probeNumber,
        timeoutMs: options.timeoutMs,
      });
      return new Promise((resolveCommand, rejectCommand) => {
        execFile(
          executable,
          [...args],
          {
            cwd: options.cwd,
            env: options.env,
            timeout: options.timeoutMs,
            maxBuffer: HEALTH_MAX_OUTPUT_BYTES,
            windowsHide: true,
            signal: options.signal,
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            const probeElapsedMs = Math.round(performance.now() - probeStarted);
            if (error) {
              const processError = error as NodeJS.ErrnoException & {
                killed?: boolean;
                signal?: string | null;
              };
              record("health-probe-failed", {
                probe: probeNumber,
                probeElapsedMs,
                code:
                  typeof processError.code === "string"
                    ? processError.code
                    : null,
                killed: processError.killed === true,
                signal: processError.signal ?? null,
              });
              rejectCommand(error);
              return;
            }
            record("health-probe-complete", {
              probe: probeNumber,
              probeElapsedMs,
            });
            resolveCommand({ stdout, stderr });
          },
        );
      });
    };

    const root = await mkdtemp(join(tmpdir(), "aera-runtime-install-live-"));
    const userData = join(root, "user-data");
    const paths = createRuntimeDistributionPaths(userData, seedDirectory);
    const packageDocument = JSON.parse(
      await readFile(join(resolve(process.cwd()), "package.json"), "utf8"),
    ) as { version: string };
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 330_000);
    const heartbeat = setInterval(
      () => record("heartbeat", { lastProgressStep }),
      15_000,
    );
    let lastProgressStep = 0;

    try {
      const result = await installPackagedSeed({
        paths,
        trustedPublicKeys: loadRuntimeTrustFile(
          join(
            resolve(process.cwd()),
            "resources",
            "agentera-runtime-trust.json",
          ),
        ),
        manifestContext: {
          repository: "Ablankpaper/aera-runtime",
          platform: "windows",
          arch: "x64",
          desktopVersion: packageDocument.version,
          allowedChannels: new Set(["candidate", "stable"]),
        },
        availableDiskBytes: getAvailableRuntimeDiskBytes,
        healthCheck: (options) =>
          runIsolatedRuntimeHealthCheck({ ...options, runner: healthRunner }),
        selectManagedRuntime: () => undefined,
        refreshRuntimeInvocation: () => ({}),
        signal: controller.signal,
        onProgress: (progress) => {
          lastProgressStep = progress.step;
          record("install-progress", {
            step: progress.step,
            totalSteps: progress.totalSteps,
            detail: progress.detail,
          });
        },
      });
      record("install-result", {
        status: result.status,
        errorCode: result.errorCode,
        action: result.action,
      });
      expect(result).toMatchObject({
        status: "installed",
        errorCode: null,
        action: null,
      });
    } finally {
      clearTimeout(abortTimer);
      clearInterval(heartbeat);
      record("diagnostic-cleanup-start");
      await rm(root, { recursive: true, force: true });
      record("diagnostic-cleanup-complete");
    }
  },
  420_000,
);
