/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseExistingAeraProcessRows } from "./aera-diagnostic.mjs";
import { createDiagnosticSessionFixture } from "./fixtures/session-fixture.mjs";
import { DatabaseSync } from "node:sqlite";

const cli = fileURLToPath(new URL("./aera-diagnostic.mjs", import.meta.url));

test("existing-process detection ignores tools that only mention Aera paths", () => {
  const rows = parseExistingAeraProcessRows(
    [
      "100 /usr/bin/codesign",
      "101 /Applications/Aera.app/Contents/MacOS/Aera",
      "102 /Applications/Aera.app/Contents/Frameworks/Aera Helper.app/Contents/MacOS/Aera Helper",
      "103 /usr/bin/spctl",
    ].join("\n"),
  );
  assert.deepEqual(rows, [
    { pid: 101, executable: "/Applications/Aera.app/Contents/MacOS/Aera" },
  ]);
});

function createFixture(root) {
  const app = join(root, "Aera.app");
  const executable = join(app, "Contents", "MacOS", "Aera");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(app, "Contents", "resources"), { recursive: true });
  mkdirSync(join(app, "Contents", "MacOS", "resources"), { recursive: true });
  writeFileSync(executable, "fixture executable");
  chmodSync(executable, 0o755);
  writeFileSync(join(app, "Contents", "Resources", "app.asar"), "fixture asar");
  writeFileSync(
    join(app, "Contents", "resources", "app.asar"),
    "fixture windows asar",
  );
  writeFileSync(
    join(app, "Contents", "MacOS", "resources", "app.asar"),
    "fixture windows asar",
  );
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.example.aera</string><key>CFBundleShortVersionString</key><string>0.7.4-internal-beta.32</string><key>CFBundleExecutable</key><string>Aera</string></dict></plist>`,
  );

  const hermesHome = join(root, "hermes");
  const profileRoot = join(hermesHome, "profiles", "fault-profile");
  const userData = join(root, "user-data");
  mkdirSync(join(profileRoot, "logs"), { recursive: true });
  mkdirSync(join(userData, "agentera-auth"), { recursive: true });
  mkdirSync(join(userData, "model-configuration"), { recursive: true });
  writeFileSync(join(hermesHome, "active_profile"), "fault-profile\n");
  writeFileSync(join(profileRoot, ".env"), "DEMO_API_KEY=fixture-api-key\n");
  writeFileSync(
    join(profileRoot, "providers.json"),
    JSON.stringify({
      providers: [
        { id: "demo", name: "Demo", baseUrl: "https://new.example/v1" },
      ],
    }),
  );
  writeFileSync(
    join(hermesHome, "models.json"),
    JSON.stringify([
      {
        id: "one",
        provider: "custom:demo",
        model: "gpt-demo",
        baseUrl: "https://new.example/v1",
        apiMode: "chat_completions",
      },
    ]),
  );
  writeFileSync(
    join(hermesHome, "model-definitions.json"),
    JSON.stringify({ "gpt-demo": { contextLength: 1000000 } }),
  );
  writeFileSync(
    join(profileRoot, "config.yaml"),
    'model:\n  default: "gpt-demo"\n  provider: "custom:demo"\n  base_url: "https://new.example/v1"\n',
  );
  writeFileSync(
    join(profileRoot, "logs", "runtime.log"),
    "[AGENTERA_RUNTIME] runtime_started pid=1\n",
  );
  writeFileSync(
    join(userData, "agentera-auth", "state.json"),
    JSON.stringify({
      installation: { installationId: "installation-secret" },
      productSession: {
        personalSpaceId: "tenant-secret",
        userId: "owner-secret",
        encryptedRefreshToken: "refresh-secret",
      },
    }),
  );
  const db = join(userData, "model-configuration", "model-configuration.db");
  const database = new DatabaseSync(db);
  database.exec(
    "CREATE TABLE desktop_model_configuration_operations (operation_id TEXT, profile_id TEXT, state TEXT, stage TEXT, owner_handle TEXT, old_route_key TEXT, new_route_key TEXT, created_at TEXT, updated_at TEXT);",
  );
  database.close();
  return { app, hermesHome, userData };
}

// @lat: [[lat.md/beta27-reliability-plan#Beta.27 Reliability Plan#Acceptance and release boundary#Beta.33 external diagnostic collector V4#Evidence contract]]
test("fixed session fixture contains one complete safe reproduction chain", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-fixed-session-fixture-"));
  try {
    const created = createDiagnosticSessionFixture(root);
    assert.equal(created.version, "0.7.4-internal-beta.33");
    assert.equal(created.events.length, 5);
    assert.deepEqual(
      created.events.map((entry) => entry.family),
      ["main", "owner", "model_configuration", "runtime", "updater"],
    );
    assert.doesNotMatch(
      JSON.stringify(created),
      /api[_-]?key|authorization|bearer/iu,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates a V4 bundle with all chain sections and explicit missing evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-v4-capture-test-"));
  try {
    const fixture = createFixture(root);
    const output = join(root, "output");
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "--platform",
        "macos",
        "--app",
        fixture.app,
        "--hermes-home",
        fixture.hermesHome,
        "--user-data",
        fixture.userData,
        "--output",
        output,
        "--version",
        "0.7.4-internal-beta.32",
        "--no-launch",
        "--timeout-seconds",
        "10",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HERMES_HOME: fixture.hermesHome },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const zip = readdirSync(output).find((name) => name.endsWith(".zip"));
    assert.ok(zip, "capture ZIP missing");
    const quarantine = join(output, `${zip}.quarantine`);
    const manifest = JSON.parse(
      readFileSync(join(quarantine, "manifest.json"), "utf8"),
    );
    const identity = JSON.parse(
      readFileSync(join(quarantine, "app-identity.json"), "utf8"),
    );
    const platformDiagnostics = JSON.parse(
      readFileSync(join(quarantine, "platform-diagnostics.json"), "utf8"),
    );
    assert.equal(manifest.schemaVersion, 4);
    assert.equal(manifest.internal_stage_visibility, "external_only");
    assert.deepEqual(manifest.redaction, {
      schemaVersion: 1,
      finalScan: "passed",
      replacements: manifest.redaction.replacements,
      dropped: manifest.redaction.dropped,
      truncated: manifest.redaction.truncated,
    });
    for (const name of [
      "signature",
      "quarantine",
      "open_files",
      "environment",
      "dns_routes",
      "cloud_origin",
      "backups",
      "managed_files",
      "model_comparison",
      "main_events",
      "preload_events",
      "renderer_events",
      "runtime_events",
      "owner_events",
      "updater_events",
      "redaction",
    ]) {
      assert.ok(
        manifest.sections.some((entry) => entry.name === name),
        `missing required section: ${name}`,
      );
    }
    assert.deepEqual(
      manifest.missingEvidence.sort(),
      manifest.sections
        .filter((entry) => entry.status !== "collected")
        .map((entry) => entry.name)
        .sort(),
    );
    assert.ok(manifest.target.executableSha256);
    assert.equal(
      identity.installed.executablePathSha256,
      createHash("sha256")
        .update(
          `aera-diagnostic-executable-path-v1\0${normalize(join(fixture.app, "Contents", "MacOS", "Aera"))}`,
        )
        .digest("hex"),
    );
    assert.ok(
      manifest.sections.some((section) => section.name === "runtime_logs"),
    );
    assert.ok(
      manifest.sections.some((section) => section.name === "model_chain"),
    );
    assert.ok(Array.isArray(manifest.missingEvidence));
    const unifiedSection = manifest.sections.find(
      (section) => section.name === "unified_log",
    );
    assert.ok(unifiedSection);
    if (unifiedSection.status !== "collected")
      assert.ok(manifest.missingEvidence.includes("unified_log"));
    assert.deepEqual(
      platformDiagnostics.unifiedLog.map((request) => request.name),
      ["aera_processes", "macos_policy"],
    );
    assert.equal(
      platformDiagnostics.unifiedLog.every(
        (request) =>
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(request.start) &&
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(request.end),
      ),
      true,
    );
    const eventSection = manifest.sections.find(
      (section) => section.name === "main_renderer_ipc",
    );
    assert.deepEqual(eventSection, {
      name: "main_renderer_ipc",
      status: "missing",
      reason: "real_model_configuration_event_unavailable",
    });
    assert.ok(manifest.missingEvidence.includes("main_renderer_ipc"));
    assert.deepEqual(
      manifest.sections.find((section) => section.name === "owner_events"),
      {
        name: "owner_events",
        status: "missing",
        reason: "real_owner_transition_event_unavailable",
      },
    );
    assert.deepEqual(
      manifest.sections.find((section) => section.name === "updater_events"),
      {
        name: "updater_events",
        status: "missing",
        reason: "real_runtime_update_event_unavailable",
      },
    );
    assert.ok(manifest.files.some((entry) => entry.name === "journal.json"));
    assert.ok(
      manifest.files.some((entry) => entry.name === "macos-unified-log.txt"),
    );
    const all = readdirSync(quarantine)
      .map((name) => readFileSync(join(quarantine, name)))
      .join("\n");
    assert.doesNotMatch(
      all,
      /fixture-api-key|refresh-secret|owner-secret|tenant-secret|installation-secret/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsupported platform/version before launching", () => {
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--platform",
      "linux",
      "--app",
      "/tmp/Aera.app",
      "--version",
      "0.7.4-internal-beta.32",
      "--no-launch",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /platform|macos|windows/i);
});

test("keeps an unbound Windows capture usable when ProductVersion is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "aera-windows-v4-capture-test-"));
  try {
    const fixture = createFixture(root);
    const executable = join(fixture.app, "Contents", "MacOS", "Aera");
    const output = join(root, "output");
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "--platform",
        "windows",
        "--app",
        executable,
        "--hermes-home",
        fixture.hermesHome,
        "--user-data",
        fixture.userData,
        "--output",
        output,
        "--no-launch",
        "--timeout-seconds",
        "10",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HERMES_HOME: fixture.hermesHome },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const zip = readdirSync(output).find((name) => name.endsWith(".zip"));
    const manifest = JSON.parse(
      readFileSync(join(output, `${zip}.quarantine`, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.platform, "win32");
    assert.equal(manifest.target.version, "unknown");
    const nativeSection = manifest.sections.find(
      (section) => section.name === "native_abi",
    );
    assert.deepEqual(nativeSection, {
      name: "native_abi",
      status: "missing",
      reason: "process_not_launched",
    });
    assert.ok(manifest.missingEvidence.includes("native_abi"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps live PID open-file evidence after the observed process exits", () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "aera-v4-live-process-test-"));
  try {
    const fixture = createFixture(root);
    const executable = join(fixture.app, "Contents", "MacOS", "Aera");
    const liveLogRoot = join(root, "observed-runtime");
    const liveLog = join(liveLogRoot, "runtime-live.log");
    mkdirSync(liveLogRoot, { recursive: true });
    const source = join(root, "fixture.c");
    writeFileSync(
      source,
      `#include <fcntl.h>\n#include <stdio.h>\n#include <unistd.h>\nint main(void){int fd=open("${liveLog.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}",O_CREAT|O_WRONLY|O_APPEND,0600);dprintf(fd,"runtime-live-marker CHAT user: my private conversation\\n");printf("CHAT user: my private conversation\\n");printf("[MODEL_CONFIGURATION] unavailable 0123456789ab model_configuration_database_unavailable\\n");printf("[AGENTERA_RUNTIME_UPDATE] source=github stage=manifest code=transport_failed\\n");fflush(stdout);usleep(1200000);close(fd);return 0;}\n`,
    );
    const compile = spawnSync("cc", [source, "-o", executable], {
      encoding: "utf8",
    });
    assert.equal(compile.status, 0, compile.stderr);
    chmodSync(executable, 0o755);
    const output = join(root, "output");
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "--platform",
        "macos",
        "--app",
        fixture.app,
        "--hermes-home",
        fixture.hermesHome,
        "--user-data",
        fixture.userData,
        "--output",
        output,
        "--timeout-seconds",
        "10",
      ],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, HERMES_HOME: fixture.hermesHome },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const zip = readdirSync(output).find((name) => name.endsWith(".zip"));
    const runtime = JSON.parse(
      readFileSync(
        join(output, `${zip}.quarantine`, "runtime-evidence.json"),
        "utf8",
      ),
    );
    assert.equal(
      runtime.logs.some((entry) => entry.source === "observed_open_file"),
      true,
    );
    assert.doesNotMatch(
      JSON.stringify(runtime),
      new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    const quarantine = join(output, `${zip}.quarantine`);
    const logs = readFileSync(join(quarantine, "logs.txt"), "utf8");
    assert.doesNotMatch(logs, /runtime-live-marker|my private conversation/);
    const events = JSON.parse(
      readFileSync(join(quarantine, "events.json"), "utf8"),
    );
    assert.equal(
      events.events.some(
        (event) =>
          event.code === "model_configuration_database_unavailable" &&
          event.diagnosticId === "0123456789ab",
      ),
      true,
    );
    assert.equal(
      events.events.some(
        (event) =>
          event.code === "transport_failed" && event.stage === "manifest",
      ),
      true,
    );
    const allFiles = readdirSync(quarantine)
      .map((name) => readFileSync(join(quarantine, name), "utf8"))
      .join("\n");
    assert.doesNotMatch(allFiles, /CHAT user: my private conversation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
