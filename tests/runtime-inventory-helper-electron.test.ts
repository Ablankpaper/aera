import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createFixtureManifest } from "./fixtures/runtime-distribution/fixture";

const enabled = process.env.AGENTERA_RUNTIME_HELPER_ELECTRON_TEST === "1";
const electronTest = enabled ? it : it.skip;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function digest(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

electronTest(
  "runs the built inventory helper through Electron Node mode",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aera-inventory-helper-live-"));
    roots.push(root);
    const destination = join(root, "runtime");
    const python = Buffer.from("python-runtime\n", "utf8");
    const hermes = Buffer.from("hermes-runtime\n", "utf8");
    await Promise.all([
      mkdir(join(destination, "python", "bin"), { recursive: true }),
      mkdir(join(destination, "runtime"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(destination, "python", "bin", "python3"), python),
      writeFile(join(destination, "runtime", "hermes"), hermes),
    ]);
    const manifest = createFixtureManifest({
      platform: "windows",
      arch: "x64",
      archive_name: "agentera-runtime-test-windows-x64.zip",
      entrypoints: {
        python: "python/bin/python3",
        hermes: "runtime/hermes",
        module: "hermes_cli.main",
      },
      files: [
        {
          path: "python",
          kind: "directory",
          size: 0,
          sha256: null,
          mode: 0o755,
          link_target: null,
        },
        {
          path: "python/bin",
          kind: "directory",
          size: 0,
          sha256: null,
          mode: 0o755,
          link_target: null,
        },
        {
          path: "python/bin/python3",
          kind: "file",
          size: python.length,
          sha256: digest(python),
          mode: 0o755,
          link_target: null,
        },
        {
          path: "runtime",
          kind: "directory",
          size: 0,
          sha256: null,
          mode: 0o755,
          link_target: null,
        },
        {
          path: "runtime/hermes",
          kind: "file",
          size: hermes.length,
          sha256: digest(hermes),
          mode: 0o755,
          link_target: null,
        },
      ],
    });
    const requestPath = join(root, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        schemaVersion: 1,
        destination,
        manifest,
        maxExtractedBytes: python.length + hermes.length,
        hostPlatform: "win32",
      }),
    );
    const helper = resolve(
      process.env.AGENTERA_RUNTIME_HELPER_PATH ??
        "out/main/runtime-inventory-helper.js",
    );
    const require = createRequire(import.meta.url);
    const electronExecutable = require("electron") as string;

    const result = await new Promise<{ stdout: string; stderr: string }>(
      (resolvePromise, rejectPromise) => {
        execFile(
          electronExecutable,
          [helper, requestPath],
          {
            encoding: "utf8",
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              AGENTERA_RUNTIME_INVENTORY_HELPER: "1",
            },
            maxBuffer: 64 * 1024,
          },
          (error, stdout, stderr) => {
            if (error) rejectPromise(error);
            else resolvePromise({ stdout, stderr });
          },
        );
      },
    );

    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      fileCount: 2,
      extractedBytes: python.length + hermes.length,
    });
    expect(result.stderr).toBe("");
  },
);
