import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { createPackage } from "@electron/asar";

import {
  validateWindowsAppAsarEntries,
  validateWindowsAppRootEntries,
  verifyPackagedWindowsAppZip,
} from "./verify-packaged-windows-app-zip.mjs";

const execFile = promisify(execFileCallback);
const VERSION = "0.7.4-internal-beta.33";

test("accepts an app ZIP whose root is the Windows application directory", () => {
  assert.deepEqual(
    validateWindowsAppRootEntries([
      { name: "Aera.exe", type: "file" },
      { name: "resources", type: "directory" },
    ]),
    { executable: "Aera.exe", resources: "resources" },
  );
});

test("rejects an app ZIP with a wrapper directory or missing resources", () => {
  assert.throws(
    () =>
      validateWindowsAppRootEntries([
        { name: "win-unpacked", type: "directory" },
      ]),
    /root|Aera\.exe|resources/u,
  );
});

test("requires the packaged Main, Preload, Renderer, and package identity", () => {
  assert.doesNotThrow(() =>
    validateWindowsAppAsarEntries(
      [
        "out/main/index.js",
        "out/preload/index.js",
        "out/renderer/index.html",
        "package.json",
      ],
      { name: "agentera-studio", version: "0.7.4-internal-beta.33" },
      "0.7.4-internal-beta.33",
    ),
  );
});

test("rejects a packaged app with a missing Renderer entry or wrong version", () => {
  assert.throws(
    () =>
      validateWindowsAppAsarEntries(
        ["out/main/index.js", "out/preload/index.js", "package.json"],
        { name: "agentera-studio", version: "0.7.4-internal-beta.31" },
        "0.7.4-internal-beta.33",
      ),
    /renderer|identity|version/u,
  );
});

test("extracts an actual Windows app ZIP and verifies the unpacked native boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "aera-windows-app-zip-test-"));
  try {
    const app = join(root, "win-unpacked");
    const asarSource = join(root, "asar-source");
    await Promise.all([
      mkdir(join(app, "resources"), { recursive: true }),
      mkdir(join(asarSource, "out", "main"), { recursive: true }),
      mkdir(join(asarSource, "out", "preload"), { recursive: true }),
      mkdir(join(asarSource, "out", "renderer"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(asarSource, "out", "main", "index.js"), "main"),
      writeFile(join(asarSource, "out", "preload", "index.js"), "preload"),
      writeFile(join(asarSource, "out", "renderer", "index.html"), "renderer"),
      writeFile(
        join(asarSource, "package.json"),
        JSON.stringify({ name: "agentera-studio", version: VERSION }),
      ),
    ]);
    await createPackage(asarSource, join(app, "resources", "app.asar"));
    const executable = Buffer.alloc(512);
    executable.writeUInt16LE(0x5a4d, 0);
    executable.writeUInt32LE(0x80, 0x3c);
    executable.writeUInt32LE(0x00004550, 0x80);
    executable.writeUInt16LE(0x8664, 0x84);
    await writeFile(join(app, "Aera.exe"), executable);

    const archive = join(
      root,
      `Aera-Internal-Beta-${VERSION}-windows-x64-app.zip`,
    );
    await execFile("zip", ["-q", "-r", archive, "."], { cwd: app });
    let verifiedNative = false;
    const result = await verifyPackagedWindowsAppZip(
      { zip: archive, desktopVersion: VERSION },
      {
        verifyNative: async (context) => {
          verifiedNative = true;
          assert.equal(context.electronPlatformName, "win32");
          assert.equal(context.arch, 1);
        },
      },
    );

    assert.deepEqual(result, {
      version: VERSION,
      archive: `Aera-Internal-Beta-${VERSION}-windows-x64-app.zip`,
    });
    assert.equal(verifiedNative, true);

    await assert.rejects(
      verifyPackagedWindowsAppZip(
        {
          zip: archive,
          desktopVersion: VERSION,
          expectedCloudOrigin: "https://203.0.113.10",
        },
        { verifyNative: async () => {} },
      ),
      /baked Cloud origin is missing/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
