/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

import { validateExtractedMacApp } from "./verify-packaged-updater-extraction.mjs";

const VERSION = "0.7.4-internal-beta.31";
const probePath = fileURLToPath(
  new URL("./packaged-updater-extraction-probe.cjs", import.meta.url),
);

async function createFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "aera-updater-extracted-app-"));
  const staging = join(root, "staging");
  const app = join(staging, "Aera.app");
  const macos = join(app, "Contents", "MacOS");
  const resources = join(app, "Contents", "Resources");
  await Promise.all([
    mkdir(macos, { recursive: true }),
    mkdir(resources, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(app, "Contents", "Info.plist"), "fixture plist"),
    writeFile(join(macos, "Aera"), "fixture executable"),
    ...(options.appAsar === false
      ? []
      : [
          writeFile(
            join(resources, "app.asar"),
            options.appAsarBody ?? "fixture asar",
          ),
        ]),
  ]);
  if (options.secondApp === true) {
    await mkdir(join(staging, "Other.app"));
  }
  return { root, staging, app };
}

async function createProbeFixture(entrySource) {
  const root = await mkdtemp(join(tmpdir(), "aera-updater-probe-test-"));
  const updaterEntry = join(root, "internal-beta-updater.cjs");
  const archive = join(root, "fixture.zip");
  const staging = join(root, "staging");
  const userData = join(root, "user-data");
  await Promise.all([
    writeFile(archive, "fixture archive"),
    mkdir(staging),
    mkdir(userData),
    ...(entrySource === null ? [] : [writeFile(updaterEntry, entrySource)]),
  ]);
  return { root, updaterEntry, archive, staging, userData };
}

function runProbe(fixture) {
  return spawnSync(electronPath, [probePath], {
    encoding: "utf8",
    env: {
      ...process.env,
      AERA_PACKAGED_UPDATER_ENTRY: fixture.updaterEntry,
      AERA_PACKAGED_UPDATER_ARCHIVE: fixture.archive,
      AERA_PACKAGED_UPDATER_STAGING: fixture.staging,
      AERA_PACKAGED_UPDATER_USER_DATA: fixture.userData,
    },
    timeout: 30_000,
  });
}

function commandRunner(options = {}) {
  const values = {
    version: options.version ?? VERSION,
    bundleIdentifier:
      options.bundleIdentifier ?? "com.bignormal.agentera.studio",
    executable: options.executable ?? "Aera",
    architectures: options.architectures ?? "arm64",
  };
  return async (command, arguments_) => {
    if (command === "/usr/bin/plutil") {
      const key = arguments_[1];
      const value =
        key === "CFBundleShortVersionString"
          ? values.version
          : key === "CFBundleIdentifier"
            ? values.bundleIdentifier
            : key === "CFBundleExecutable"
              ? values.executable
              : null;
      if (value === null) throw new Error(`Unexpected plist key: ${key}`);
      return { stdout: `${value}\n`, stderr: "" };
    }
    if (command === "/usr/bin/lipo") {
      return { stdout: `${values.architectures}\n`, stderr: "" };
    }
    if (command === "/usr/bin/codesign") {
      if (options.signatureError) throw options.signatureError;
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected command: ${command}`);
  };
}

test("accepts one signed arm64 Beta.31 app with app.asar", async () => {
  const fixture = await createFixture();
  try {
    const app = await validateExtractedMacApp(
      fixture.staging,
      VERSION,
      commandRunner(),
    );
    assert.equal(app, fixture.app);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a missing packaged app.asar", async () => {
  const fixture = await createFixture({ appAsar: false });
  try {
    await assert.rejects(
      validateExtractedMacApp(fixture.staging, VERSION, commandRunner()),
      /app\.asar is missing or empty/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an empty packaged app.asar", async () => {
  const fixture = await createFixture({ appAsarBody: "" });
  try {
    await assert.rejects(
      validateExtractedMacApp(fixture.staging, VERSION, commandRunner()),
      /app\.asar is missing or empty/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an archive that does not contain exactly one app", async () => {
  const fixture = await createFixture({ secondApp: true });
  try {
    await assert.rejects(
      validateExtractedMacApp(fixture.staging, VERSION, commandRunner()),
      /exactly one app/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a different bundle identity", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      validateExtractedMacApp(
        fixture.staging,
        VERSION,
        commandRunner({ bundleIdentifier: "invalid.example" }),
      ),
      /identity differs/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a non-arm64 executable", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      validateExtractedMacApp(
        fixture.staging,
        VERSION,
        commandRunner({ architectures: "x86_64" }),
      ),
      /not Apple Silicon/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a failed strict code-signature check", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      validateExtractedMacApp(
        fixture.staging,
        VERSION,
        commandRunner({ signatureError: new Error("invalid signature") }),
      ),
      /invalid signature/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test(
  "probe rejects a missing compiled updater entry",
  { skip: process.platform !== "darwin" },
  async () => {
    const fixture = await createProbeFixture(null);
    try {
      const result = runProbe(fixture);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Cannot find module/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "probe rejects a non-callable updater export",
  { skip: process.platform !== "darwin" },
  async () => {
    const fixture = await createProbeFixture("module.exports = {};\n");
    try {
      const result = runProbe(fixture);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /extractDesktopUpdateZip export is unavailable/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "probe reports a compiled updater extraction failure",
  { skip: process.platform !== "darwin" },
  async () => {
    const fixture = await createProbeFixture(
      `module.exports = {
        extractDesktopUpdateZip: async () => {
          throw new Error("fixture extraction failed");
        },
      };\n`,
    );
    try {
      const result = runProbe(fixture);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /fixture extraction failed/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);
