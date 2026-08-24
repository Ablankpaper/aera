import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { verifyExtractedRuntimeInventoryInProcess } from "../src/main/agentera-runtime-distribution/inventory";
import { createFixtureManifest } from "./fixtures/runtime-distribution/fixture";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function digest(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

// @lat: [[agentera-runtime-distribution#Release gate#Windows Seed install timing diagnostic]]
it("reports the walk and hash boundaries of the final Runtime inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "aera-inventory-diagnostic-"));
  roots.push(root);
  const destination = join(root, "runtime");
  const body = Buffer.from("runtime-diagnostic\n", "utf8");
  await mkdir(join(destination, "bin"), { recursive: true });
  await writeFile(join(destination, "bin", "runtime.exe"), body);

  const manifest = createFixtureManifest({
    platform: "windows",
    arch: "x64",
    archive_name: "agentera-runtime-test-windows-x64.zip",
    files: [
      {
        path: "bin",
        kind: "directory",
        size: 0,
        sha256: null,
        mode: 0o755,
        link_target: null,
      },
      {
        path: "bin/runtime.exe",
        kind: "file",
        size: body.length,
        sha256: digest(body),
        mode: 0o755,
        link_target: null,
      },
    ],
  });
  const events: string[] = [];

  await expect(
    verifyExtractedRuntimeInventoryInProcess(
      destination,
      manifest,
      body.length,
      undefined,
      "win32",
      (event) => events.push(event),
    ),
  ).resolves.toEqual({ fileCount: 1, extractedBytes: body.length });
  expect(events).toEqual([
    "inventory-walk-start",
    "inventory-walk-complete",
    "inventory-hash-start",
    "inventory-hash-complete",
  ]);
});
