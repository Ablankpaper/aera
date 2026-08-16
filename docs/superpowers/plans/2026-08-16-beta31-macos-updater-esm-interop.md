# Beta.31 macOS Packaged Updater ESM Interop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Beta.31 with a callable packaged macOS ZIP extractor and a candidate gate that makes the compiled updater inside `app.asar` extract the exact final release ZIP before publication.

**Architecture:** Bind the documented `extract` named export, expose the existing updater module as a stable Electron Vite main entry, and invoke that compiled entry through an isolated Electron probe. A separate release verifier validates the extracted application identity, architecture, `app.asar`, and signature; the Internal Beta workflow runs it before final container submission.

**Tech Stack:** TypeScript, Electron 41.10.5, Electron Vite/Rollup CommonJS output, Node.js 22 test runner, Vitest, GitHub Actions, macOS `plutil`/`lipo`/`codesign`, lat.md.

---

## File map

- Modify `src/main/app/internal-beta-updater.ts`: bind `@electron-internal/extract-zip` through its named `extract` export while preserving the injectable function and `noAsar` boundary.
- Modify `electron.vite.config.ts`: emit a stable `out/main/internal-beta-updater.js` entry from the same production updater module.
- Create `scripts/internal-beta/packaged-updater-extraction-probe.cjs`: run the compiled updater export in an isolated Electron process without starting Aera.
- Create `scripts/internal-beta/packaged-updater-build-boundary.test.mjs`: lock the named import and stable compiled-entry configuration.
- Create `scripts/internal-beta/verify-packaged-updater-extraction.mjs`: orchestrate the probe and validate the app extracted from the exact final ZIP.
- Create `scripts/internal-beta/verify-packaged-updater-extraction.test.mjs`: cover identity, architecture, `app.asar`, signature, and fail-closed validation.
- Modify `.github/workflows/internal-beta.yml`: run the packaged extraction gate before final container notarization submission and advance release identity/notes.
- Modify `.github/workflows/internal-beta-promote.yml`: advance the exact promotion version guard.
- Modify `scripts/internal-beta/workflow-policy.test.mjs`: require the new gate, its ordering, Beta.31 identity, and release notes.
- Modify `package.json` and `package-lock.json`: advance Desktop identity to `0.7.4-internal-beta.31`.
- Modify `scripts/internal-beta/manifest.mjs`: advance the immutable Internal Beta identity.
- Modify `scripts/internal-beta/manifest.test.mjs`, `scripts/internal-beta/desktop-update.test.mjs`, and `scripts/internal-beta/publish-desktop-update.test.mjs`: advance exact-version fixtures.
- Modify `tests/secure-zip-extractor.test.ts`: prove a valid ZIP succeeds through the real default extractor, rather than accepting any rejection.
- Modify `lat.md/desktop-updates.md`: document the Beta.29/Beta.30 manual bridge and the packaged updater gate.

### Task 1: Reproduce and repair the compiled extractor boundary

**Files:**

- Create: `scripts/internal-beta/packaged-updater-build-boundary.test.mjs`
- Create: `scripts/internal-beta/packaged-updater-extraction-probe.cjs`
- Modify: `electron.vite.config.ts:1-16`
- Modify: `src/main/app/internal-beta-updater.ts:24`
- Modify: `tests/secure-zip-extractor.test.ts`

- [ ] **Step 1: Write the failing build-boundary policy test**

Create `scripts/internal-beta/packaged-updater-build-boundary.test.mjs`:

```js
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const configPath = new URL("../../electron.vite.config.ts", import.meta.url);
const updaterPath = new URL(
  "../../src/main/app/internal-beta-updater.ts",
  import.meta.url,
);

test("the packaged updater entry binds the extractor named export", async () => {
  // @lat: [[desktop-updates#Desktop Updates#Internal Beta signed update channel#Test specifications]]
  const [config, updater] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(updaterPath, "utf8"),
  ]);

  assert.match(
    config,
    /["']internal-beta-updater["']:\s*resolve\(\s*["']src\/main\/app\/internal-beta-updater\.ts["']\s*,?\s*\)/u,
  );
  assert.match(
    updater,
    /import\s*\{\s*extract\s+as\s+extractZip\s*\}\s*from\s*["']@electron-internal\/extract-zip["'];/u,
  );
  assert.doesNotMatch(
    updater,
    /import\s+extractZip\s+from\s+["']@electron-internal\/extract-zip["']/u,
  );
});
```

- [ ] **Step 2: Run the test and verify the current Beta.30 source fails**

Run:

```bash
node --test scripts/internal-beta/packaged-updater-build-boundary.test.mjs
```

Expected: FAIL because no stable updater entry exists and the source still uses the default import.

- [ ] **Step 3: Add the stable compiled entry without changing the broken import**

Change the `main.build.rollupOptions` block in `electron.vite.config.ts` to:

```ts
rollupOptions: {
  external: ["better-sqlite3"],
  input: {
    index: resolve("src/main/index.ts"),
    "internal-beta-updater": resolve(
      "src/main/app/internal-beta-updater.ts",
    ),
  },
},
```

Create `scripts/internal-beta/packaged-updater-extraction-probe.cjs`:

```js
"use strict";

const { mkdir } = require("node:fs/promises");
const { isAbsolute, resolve } = require("node:path");
const { app } = require("electron");

const SUCCESS_MARKER = "AERA_PACKAGED_UPDATER_EXTRACTION_OK";

function requiredPath(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

async function run() {
  const updaterEntry = requiredPath("AERA_PACKAGED_UPDATER_ENTRY");
  const archive = requiredPath("AERA_PACKAGED_UPDATER_ARCHIVE");
  const staging = requiredPath("AERA_PACKAGED_UPDATER_STAGING");
  const userData = requiredPath("AERA_PACKAGED_UPDATER_USER_DATA");

  app.commandLine.appendSwitch("disable-gpu");
  app.setPath("userData", userData);
  await Promise.all([
    mkdir(staging, { recursive: true }),
    mkdir(userData, { recursive: true }),
  ]);
  await app.whenReady();

  const updater = require(updaterEntry);
  if (typeof updater.extractDesktopUpdateZip !== "function") {
    throw new Error("packaged extractDesktopUpdateZip export is unavailable");
  }
  const previousNoAsar = process.noAsar;
  await updater.extractDesktopUpdateZip(archive, staging);
  if (process.noAsar !== previousNoAsar) {
    throw new Error("packaged extractor did not restore process.noAsar");
  }
  process.stdout.write(`${SUCCESS_MARKER}\n`);
}

run().then(
  () => app.exit(0),
  (error) => {
    process.stderr.write(
      `Packaged updater extraction probe failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    app.exit(1);
  },
);
```

- [ ] **Step 4: Build the still-broken boundary and reproduce the production error**

Run:

```bash
npx electron-vite build
probe_root=$(mktemp -d -t aera-updater-red)
/usr/bin/ditto -c -k --keepParent package.json "$probe_root/fixture.zip"
mkdir -p "$probe_root/staging" "$probe_root/user-data"
AERA_PACKAGED_UPDATER_ENTRY="$PWD/out/main/internal-beta-updater.js" \
AERA_PACKAGED_UPDATER_ARCHIVE="$probe_root/fixture.zip" \
AERA_PACKAGED_UPDATER_STAGING="$probe_root/staging" \
AERA_PACKAGED_UPDATER_USER_DATA="$probe_root/user-data" \
npx electron scripts/internal-beta/packaged-updater-extraction-probe.cjs
```

Expected: FAIL with `Packaged updater extraction probe failed: extractor is not a function`. Remove only the printed `probe_root` directory after preserving the RED output in the task notes.

- [ ] **Step 5: Apply the minimal named-export repair**

Replace the import in `src/main/app/internal-beta-updater.ts` with:

```ts
import { extract as extractZip } from "@electron-internal/extract-zip";
```

- [ ] **Step 6: Add a valid default-extractor regression**

Change the fixture entry type and central-directory mode calculation to:

```ts
interface Entry {
  name: string;
  body: Buffer;
  mode: number;
  type: "file" | "symlink";
}

// Inside zipBuffer(), immediately before writeUInt32LE(..., 38):
const fileType = entry.type === "symlink" ? 0o120000 : 0o100000;
central.writeUInt32LE(((fileType | entry.mode) << 16) >>> 0, 38);
```

Delete the old hard-coded `0o120000` write. Add `type: "symlink"` to the existing malicious entry, add `readFile` to the existing `node:fs/promises` import, and add this valid regular-file case:

```ts
it("extracts a valid archive through the production default extractor", async () => {
  const root = await mkdtemp(join(tmpdir(), "aera-safe-zip-test-"));
  workspaces.push(root);
  const archive = join(root, "valid.zip");
  const destination = join(root, "destination");
  await mkdir(destination);
  await writeFile(
    archive,
    zipBuffer([
      {
        name: "Aera.app/Contents/Resources/app.asar",
        body: Buffer.from("asar"),
        mode: 0o644,
        type: "file",
      },
    ]),
  );

  await expect(
    extractDesktopUpdateZip(archive, destination),
  ).resolves.toBeUndefined();
  await expect(
    readFile(
      join(destination, "Aera.app", "Contents", "Resources", "app.asar"),
      "utf8",
    ),
  ).resolves.toBe("asar");
});
```

- [ ] **Step 7: Rebuild and verify the same compiled call now passes**

Run:

```bash
node --test scripts/internal-beta/packaged-updater-build-boundary.test.mjs
npx electron-vite build
AERA_PACKAGED_UPDATER_ENTRY="$PWD/out/main/internal-beta-updater.js" \
AERA_PACKAGED_UPDATER_ARCHIVE="$probe_root/fixture.zip" \
AERA_PACKAGED_UPDATER_STAGING="$probe_root/staging-green" \
AERA_PACKAGED_UPDATER_USER_DATA="$probe_root/user-data-green" \
npx electron scripts/internal-beta/packaged-updater-extraction-probe.cjs
npx vitest run tests/secure-zip-extractor.test.ts tests/internal-beta-updater.test.ts
```

Expected: the probe prints `AERA_PACKAGED_UPDATER_EXTRACTION_OK`; both test files pass.

- [ ] **Step 8: Commit the compiled-boundary repair**

```bash
git add electron.vite.config.ts src/main/app/internal-beta-updater.ts \
  tests/secure-zip-extractor.test.ts \
  scripts/internal-beta/packaged-updater-build-boundary.test.mjs \
  scripts/internal-beta/packaged-updater-extraction-probe.cjs
git commit -m "fix(updater): bind packaged zip extractor export"
```

### Task 2: Verify the exact final ZIP through the packaged updater

**Files:**

- Create: `scripts/internal-beta/verify-packaged-updater-extraction.mjs`
- Create: `scripts/internal-beta/verify-packaged-updater-extraction.test.mjs`

- [ ] **Step 1: Write failing extracted-app validation tests**

Create `scripts/internal-beta/verify-packaged-updater-extraction.test.mjs`:

```js
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateExtractedMacApp } from "./verify-packaged-updater-extraction.mjs";

const VERSION = "0.7.4-internal-beta.31";

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
      : [writeFile(join(resources, "app.asar"), "fixture asar")]),
  ]);
  return { root, staging, app };
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
```

- [ ] **Step 2: Run the tests and verify the module is missing**

Run:

```bash
node --test scripts/internal-beta/verify-packaged-updater-extraction.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `verify-packaged-updater-extraction.mjs`.

- [ ] **Step 3: Implement the fail-closed verifier**

Create `scripts/internal-beta/verify-packaged-updater-extraction.mjs`:

```js
#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import electronPath from "electron";

const execFileAsync = promisify(execFile);
const PROBE_PATH = fileURLToPath(
  new URL("./packaged-updater-extraction-probe.cjs", import.meta.url),
);
const SUCCESS_MARKER = "AERA_PACKAGED_UPDATER_EXTRACTION_OK";
const VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+-internal-beta\.[1-9][0-9]*(?:\.[1-9][0-9]*)?$/u;

async function run(command, arguments_, options = {}) {
  try {
    return await execFileAsync(command, arguments_, {
      encoding: "utf8",
      env: options.env ?? process.env,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const detail =
      typeof error?.stderr === "string" && error.stderr.trim() !== ""
        ? error.stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`${basename(command)} failed: ${detail}`);
  }
}

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

async function plistValue(infoPlist, key, runCommand) {
  const result = await runCommand("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    infoPlist,
  ]);
  return result.stdout.trim();
}

export async function validateExtractedMacApp(
  stagingDirectory,
  desktopVersion,
  runCommand = run,
) {
  const entries = await readdir(stagingDirectory, { withFileTypes: true });
  const apps = entries.filter(
    (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
  );
  if (entries.length !== 1 || apps.length !== 1) {
    throw new Error("Packaged updater must extract exactly one app");
  }
  const app = join(stagingDirectory, apps[0].name);
  const appInfo = await lstat(app);
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) {
    throw new Error("Packaged updater app bundle is invalid");
  }

  const infoPlist = join(app, "Contents", "Info.plist");
  const [version, bundleIdentifier, executableName] = await Promise.all([
    plistValue(infoPlist, "CFBundleShortVersionString", runCommand),
    plistValue(infoPlist, "CFBundleIdentifier", runCommand),
    plistValue(infoPlist, "CFBundleExecutable", runCommand),
  ]);
  if (
    version !== desktopVersion ||
    bundleIdentifier !== "com.bignormal.agentera.studio"
  ) {
    throw new Error("Packaged updater app identity differs");
  }
  if (
    executableName.length === 0 ||
    executableName.includes("/") ||
    executableName.includes("\\")
  ) {
    throw new Error("Packaged updater executable name is invalid");
  }

  const executable = join(app, "Contents", "MacOS", executableName);
  const executableInfo = await lstat(executable);
  if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) {
    throw new Error("Packaged updater executable is invalid");
  }
  const architectures = await runCommand("/usr/bin/lipo", [
    "-archs",
    executable,
  ]);
  if (!architectures.stdout.trim().split(/\s+/u).includes("arm64")) {
    throw new Error("Packaged updater app is not Apple Silicon");
  }

  const appAsar = join(app, "Contents", "Resources", "app.asar");
  let appAsarInfo;
  try {
    appAsarInfo = await stat(appAsar);
  } catch {
    throw new Error("Packaged updater app.asar is missing or empty");
  }
  if (!appAsarInfo.isFile() || appAsarInfo.size === 0) {
    throw new Error("Packaged updater app.asar is missing or empty");
  }
  await runCommand("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    app,
  ]);
  return app;
}

async function executeProbe(options) {
  const result = await run(electronPath, [PROBE_PATH], {
    env: {
      ...process.env,
      AERA_PACKAGED_UPDATER_ENTRY: options.updaterEntry,
      AERA_PACKAGED_UPDATER_ARCHIVE: options.zip,
      AERA_PACKAGED_UPDATER_STAGING: options.staging,
      AERA_PACKAGED_UPDATER_USER_DATA: options.userData,
    },
    timeout: 120_000,
  });
  if (!result.stdout.split(/\r?\n/u).includes(SUCCESS_MARKER)) {
    throw new Error(
      "Packaged updater extraction probe did not confirm success",
    );
  }
}

export async function verifyPackagedUpdaterExtraction(
  options,
  dependencies = {},
) {
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new Error("Packaged updater extraction requires macOS");
  }
  const app = resolve(required(options.app, "packaged app"));
  const zip = resolve(required(options.zip, "update ZIP"));
  const desktopVersion = required(options.desktopVersion, "desktop version");
  if (!VERSION_PATTERN.test(desktopVersion)) {
    throw new Error("Packaged updater desktop version is invalid");
  }
  if (
    basename(zip) !== `Aera-Internal-Beta-${desktopVersion}-macos-arm64.zip`
  ) {
    throw new Error("Packaged updater ZIP identity differs");
  }
  const [appInfo, zipInfo] = await Promise.all([lstat(app), lstat(zip)]);
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) {
    throw new Error("Packaged updater source app is invalid");
  }
  if (!zipInfo.isFile() || zipInfo.isSymbolicLink()) {
    throw new Error("Packaged updater source ZIP is invalid");
  }
  const appAsar = join(app, "Contents", "Resources", "app.asar");
  const appAsarInfo = await stat(appAsar);
  if (!appAsarInfo.isFile() || appAsarInfo.size === 0) {
    throw new Error("Packaged updater source app.asar is missing or empty");
  }

  const root = await mkdtemp(join(tmpdir(), "aera-packaged-updater-"));
  const staging = join(root, "staging");
  const userData = join(root, "user-data");
  await Promise.all([
    mkdir(staging, { recursive: true }),
    mkdir(userData, { recursive: true }),
  ]);
  try {
    await (dependencies.executeProbe ?? executeProbe)({
      updaterEntry: join(appAsar, "out", "main", "internal-beta-updater.js"),
      zip,
      staging,
      userData,
    });
    await validateExtractedMacApp(
      staging,
      desktopVersion,
      dependencies.runCommand ?? run,
    );
    return { version: desktopVersion, archive: basename(zip) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parseOptions(arguments_) {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw new Error("Packaged updater options must be flag/value pairs");
  }
  const allowed = new Set(["app", "zip", "desktop_version"]);
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error("Packaged updater options must be flag/value pairs");
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (!allowed.has(key)) throw new Error(`Unknown option: ${flag}`);
    if (Object.hasOwn(values, key))
      throw new Error(`Duplicate option: ${flag}`);
    values[key] = value;
  }
  return values;
}

async function runCli(arguments_) {
  const values = parseOptions(arguments_);
  await verifyPackagedUpdaterExtraction({
    app: values.app,
    zip: values.zip,
    desktopVersion: values.desktop_version,
  });
  process.stdout.write("packaged macOS updater extracted the final ZIP\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Packaged macOS updater verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run verifier tests**

Run:

```bash
node --test scripts/internal-beta/verify-packaged-updater-extraction.test.mjs
```

Expected: all app-identity, architecture, `app.asar`, and signature-command tests pass.

- [ ] **Step 5: Commit the candidate verifier**

```bash
git add scripts/internal-beta/verify-packaged-updater-extraction.mjs \
  scripts/internal-beta/verify-packaged-updater-extraction.test.mjs
git commit -m "test(release): exercise packaged updater extraction"
```

### Task 3: Make the packaged gate mandatory in the macOS candidate workflow

**Files:**

- Modify: `scripts/internal-beta/workflow-policy.test.mjs`
- Modify: `.github/workflows/internal-beta.yml:338-358`

- [ ] **Step 1: Add failing workflow ordering assertions**

In `scripts/internal-beta/workflow-policy.test.mjs`, load `scripts/internal-beta/verify-packaged-updater-extraction.mjs` and add:

```js
const packagedUpdaterVerifierPath = new URL(
  "./verify-packaged-updater-extraction.mjs",
  import.meta.url,
);
```

Inside the candidate policy test, require the exact invocation and ordering:

```js
assert.match(
  raw,
  /node scripts\/internal-beta\/verify-packaged-updater-extraction\.mjs\s+--app "\$\{\{ steps\.mac_paths\.outputs\.app \}\}"\s+--zip "\$\{\{ steps\.mac_paths\.outputs\.zip \}\}"\s+--desktop-version "\$VERSION"/u,
);
const packagedGate = raw.indexOf(
  "Exercise packaged updater against final macOS ZIP",
);
const containerSubmission = raw.indexOf(
  "Submit final DMG and ZIP exactly once",
);
assert.ok(packagedGate >= 0 && packagedGate < containerSubmission);
assert.match(
  await readFile(packagedUpdaterVerifierPath, "utf8"),
  /AERA_PACKAGED_UPDATER_EXTRACTION_OK/u,
);
```

- [ ] **Step 2: Run the policy test and verify it fails**

Run:

```bash
node --test scripts/internal-beta/workflow-policy.test.mjs
```

Expected: FAIL because the workflow has no packaged updater step.

- [ ] **Step 3: Add the candidate gate before container submission**

Insert after `Resolve final signed and stapled macOS bytes` and before `Submit final DMG and ZIP exactly once`:

```yaml
- name: Exercise packaged updater against final macOS ZIP
  shell: bash
  env:
    VERSION: ${{ needs.validate.outputs.version }}
  run: >-
    node scripts/internal-beta/verify-packaged-updater-extraction.mjs
    --app "${{ steps.mac_paths.outputs.app }}"
    --zip "${{ steps.mac_paths.outputs.zip }}"
    --desktop-version "$VERSION"
```

- [ ] **Step 4: Run workflow and script tests**

Run:

```bash
node --test scripts/internal-beta/workflow-policy.test.mjs \
  scripts/internal-beta/verify-packaged-updater-extraction.test.mjs \
  scripts/internal-beta/packaged-updater-build-boundary.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Commit the mandatory workflow gate**

```bash
git add .github/workflows/internal-beta.yml \
  scripts/internal-beta/workflow-policy.test.mjs
git commit -m "ci(release): gate packaged updater on final zip"
```

### Task 4: Advance every exact release identity to Beta.31

**Files:**

- Modify: `package.json:3`
- Modify: `package-lock.json:3,9`
- Modify: `scripts/internal-beta/manifest.mjs:17`
- Modify: `scripts/internal-beta/manifest.test.mjs:21`
- Modify: `scripts/internal-beta/desktop-update.test.mjs:16`
- Modify: `scripts/internal-beta/publish-desktop-update.test.mjs:28`
- Modify: `scripts/internal-beta/workflow-policy.test.mjs`
- Modify: `.github/workflows/internal-beta.yml:61-62,769`
- Modify: `.github/workflows/internal-beta-promote.yml:58-60`

- [ ] **Step 1: Change test expectations to Beta.31 first**

Update the exact-version constants in the four `*.test.mjs` files and both version assertions in `workflow-policy.test.mjs` to `0.7.4-internal-beta.31`. Replace the release-note regex with the escaped form of:

```text
Beta.31 修复 macOS 在线更新在下载完成后的打包模块兼容错误，并新增 app.asar updater 解压最终 ZIP 的发布门禁；Beta.29 和 Beta.30 的 macOS 用户需手动覆盖安装一次 Beta.31，之后恢复在线升级。Beta.30 的模型配置自愈修复继续保留；Runtime 仍为 0.20.0-agentera.2 签名候选，Windows 提供内测包。
```

- [ ] **Step 2: Run exact-identity tests and verify they fail**

Run:

```bash
node --test scripts/internal-beta/manifest.test.mjs \
  scripts/internal-beta/desktop-update.test.mjs \
  scripts/internal-beta/publish-desktop-update.test.mjs \
  scripts/internal-beta/workflow-policy.test.mjs
```

Expected: FAIL because production metadata and workflow guards still say Beta.30.

- [ ] **Step 3: Advance production identity and workflow guards**

Change only the root package versions in `package.json` and `package-lock.json`, `INTERNAL_BETA_VERSION` in `manifest.mjs`, and the candidate/promotion workflow guards to `0.7.4-internal-beta.31`. Put the exact release-note text above into the candidate manifest build command.

- [ ] **Step 4: Prove no active Beta.30 identity remains**

Run:

```bash
rg --hidden -n "0\.7\.4-internal-beta\.30|Beta\.30 修复异常模型" \
  --glob '!.git/**' \
  --glob '!docs/superpowers/specs/**' \
  --glob '!docs/superpowers/plans/**' .
```

Expected: no output. Historical design/plan prose may retain Beta.30 references; executable release identity may not.

- [ ] **Step 5: Run all Internal Beta script tests**

```bash
node --test scripts/internal-beta/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit Beta.31 release identity**

```bash
git add package.json package-lock.json \
  .github/workflows/internal-beta.yml \
  .github/workflows/internal-beta-promote.yml \
  scripts/internal-beta/manifest.mjs \
  scripts/internal-beta/manifest.test.mjs \
  scripts/internal-beta/desktop-update.test.mjs \
  scripts/internal-beta/publish-desktop-update.test.mjs \
  scripts/internal-beta/workflow-policy.test.mjs
git commit -m "release: prepare internal beta 31 candidate"
```

### Task 5: Record the bridge and packaged gate in lat.md

**Files:**

- Modify: `lat.md/desktop-updates.md:23-50`

- [ ] **Step 1: Correct the historical bridge statement**

Replace the sentence beginning `Every later reviewed Internal Beta` with:

```markdown
Beta.9 restored online updates after the earlier ASAR-interception bridge. Beta.29 and Beta.30 introduced a separate packaged-module regression: they download and verify correctly, but their CommonJS output binds the ESM extractor namespace object as a callable default. Those macOS versions require one manual installation of Beta.31; Beta.31 binds the named `extract` export and restores later online transitions.
```

- [ ] **Step 2: Document the final-ZIP packaged gate**

Add this paragraph immediately after the paragraph describing both Internal Beta Electron Builder overlays:

```markdown
The macOS candidate also loads the stable compiled updater entry from candidate `app.asar` under Electron 41.10.5 and invokes its default production extractor against the exact final ZIP before container submission. This gate detects ESM/CommonJS call-shape drift that source transforms or injected extractors cannot exercise.
```

Add this test-spec bullet:

```markdown
- The compiled updater entry inside candidate `app.asar` must use its default production extractor to unpack the exact final macOS ZIP before container submission; source-transform or injected-extractor success is insufficient.
```

- [ ] **Step 3: Validate the knowledge graph**

Run:

```bash
lat check
git diff --check
```

Expected: both checks pass.

- [ ] **Step 4: Commit the architecture record**

```bash
git add lat.md/desktop-updates.md
git commit -m "docs: record beta31 updater bridge gate"
```

### Task 6: Run proportionate full verification and prepare the evidence ledger

**Files:**

- Verify only; no planned source edits.

- [ ] **Step 1: Run focused packaged-boundary tests**

```bash
node --test scripts/internal-beta/packaged-updater-build-boundary.test.mjs \
  scripts/internal-beta/verify-packaged-updater-extraction.test.mjs \
  scripts/internal-beta/workflow-policy.test.mjs
npx vitest run tests/secure-zip-extractor.test.ts tests/internal-beta-updater.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run type checks and the real production compiler**

```bash
npm run typecheck
npm run build
```

Expected: both commands pass and `out/main/internal-beta-updater.js` exists.

- [ ] **Step 3: Re-run the compiled default-extractor probe**

Run:

```bash
probe_root=$(mktemp -d -t aera-updater-final)
/usr/bin/ditto -c -k --keepParent package.json "$probe_root/fixture.zip"
AERA_PACKAGED_UPDATER_ENTRY="$PWD/out/main/internal-beta-updater.js" \
AERA_PACKAGED_UPDATER_ARCHIVE="$probe_root/fixture.zip" \
AERA_PACKAGED_UPDATER_STAGING="$probe_root/staging" \
AERA_PACKAGED_UPDATER_USER_DATA="$probe_root/user-data" \
npx electron scripts/internal-beta/packaged-updater-extraction-probe.cjs
```

Expected: `AERA_PACKAGED_UPDATER_EXTRACTION_OK`; remove only the new temporary root.

- [ ] **Step 4: Run the full local gates**

```bash
npm test
node --test scripts/internal-beta/*.test.mjs
npm audit --omit=dev --audit-level=high
git diff --check
lat check
```

Expected: all commands pass with no high/critical production advisory.

- [ ] **Step 5: Verify branch scope and commit state**

```bash
git status --short --branch
git diff --name-status origin/main...HEAD
git log --oneline --decorate origin/main..HEAD
```

Expected: only the design, plan, updater repair, packaged gate, Beta.31 release wiring, tests, and `lat.md` changes are present; the worktree is clean.

- [ ] **Step 6: Record explicit non-claims before external actions**

The handoff must state separately:

```text
Local source and compiled-boundary verification: pending/green with command evidence.
GitHub exact-head CI: not run until push is separately authorized.
Signed/notarized Beta.31 candidate: not built until merge and candidate dispatch.
Fault-machine manual DMG acceptance: not run until immutable candidate exists.
Live promotion: not authorized by implementation approval.
Beta.31-to-Beta.32 online restart: cannot be claimed before a higher reviewed version exists.
```

### Task 7: External release stages after explicit authorization

**Files:**

- No additional planned code changes; operate exact immutable commits and artifacts only.

- [ ] **Step 1: Push and create the PR only after the user authorizes repository writes**

Push only `aera/beta31-macos-updater-esm-interop` to `Ablankpaper/aera`, create the PR against `main`, and record exact branch SHA and PR URL. Do not use the legacy `bignormal` remote.

- [ ] **Step 2: Require exact-head CI and reviewed merge**

Require the full platform matrix for the exact branch head, review all changed files, merge only the reviewed SHA, and confirm merged `origin/main` contains the same commits.

- [ ] **Step 3: Build the immutable Beta.31 candidate**

Dispatch `.github/workflows/internal-beta.yml` with the merged source SHA and its successful exact-SHA CI run. Require the packaged updater final-ZIP gate, Developer ID signing, application and container notarization, stapling, Gatekeeper, Runtime Seed, native ABI, signed metadata, hashes, provenance, and candidate upload to pass.

- [ ] **Step 4: Perform the one-time fault-machine DMG acceptance**

Install the immutable Beta.31 DMG manually over Beta.29 while preserving Electron user data. Verify version, signature, notarization, Gatekeeper, login, model save, and the packaged updater extraction probe. Do not claim a live online restart to a nonexistent higher version.

- [ ] **Step 5: Promote only after a separate explicit promotion authorization**

Dispatch `.github/workflows/internal-beta-promote.yml` with the exact successful candidate run and merged source SHA. Verify live manifest bytes, versioned DMG/ZIP bytes, signed metadata, and live hashes before reporting Beta.31 as published.
