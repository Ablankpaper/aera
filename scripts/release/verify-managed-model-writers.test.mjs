/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyManagedModelWriters } from "./verify-managed-model-writers.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "aera-writer-gate-"));
  return {
    root,
    write(name, source) {
      const path = resolve(root, name);
      writeFileSync(path, source);
      return path;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("rejects an unregistered writer that resolves config.yaml", () => {
  const f = fixture();
  try {
    f.write(
      "bypass.ts",
      [
        'import { join } from "node:path";',
        'import { safeWriteFile } from "./utils";',
        'const target = join("/tmp/aera-fixture", "config.yaml");',
        'safeWriteFile(target, "model: {}\\n");',
      ].join("\n"),
    );
    const report = verifyManagedModelWriters({ root: f.root, includeRoot: "" });
    assert.equal(report.ok, false);
    assert.equal(report.issues.length, 1);
    assert.equal(report.issues[0].role, "config");
    assert.equal(report.issues[0].kind, "raw_managed_writer");
  } finally {
    f.cleanup();
  }
});

// @lat: [[lat.md/beta27-reliability-plan#Beta.27 Reliability Plan#Recoverable model configuration#Profile deletion shares the managed write authority]]
test("rejects an unregistered remover that resolves a managed file", () => {
  const f = fixture();
  try {
    f.write(
      "delete-bypass.ts",
      [
        'import { rmSync } from "node:fs";',
        'import { join } from "node:path";',
        'const target = join("/tmp/aera-fixture", "config.yaml");',
        "rmSync(target, { force: true });",
      ].join("\n"),
    );
    const report = verifyManagedModelWriters({ root: f.root, includeRoot: "" });
    assert.equal(report.ok, false);
    assert.equal(report.issues.length, 1);
    assert.equal(report.issues[0].role, "config");
    assert.equal(report.issues[0].kind, "raw_managed_writer");
  } finally {
    f.cleanup();
  }
});

test("accepts a managed raw writer only at an explicit boundary function", () => {
  const f = fixture();
  try {
    f.write(
      "storage.ts",
      [
        'import { join } from "node:path";',
        'import { safeWriteFile } from "./utils";',
        "export function persist() {",
        '  const target = join("/tmp/aera-fixture", "config.yaml");',
        '  safeWriteFile(target, "model: {}\\n");',
        "}",
      ].join("\n"),
    );
    const report = verifyManagedModelWriters({
      root: f.root,
      includeRoot: "",
      capabilities: {
        "storage.ts": {
          capability: "test-managed-file-boundary",
          rawWriters: {
            persist: { roles: ["config"] },
          },
        },
      },
    });
    assert.equal(report.ok, true);
    assert.deepEqual(report.issues, []);
  } finally {
    f.cleanup();
  }
});

test("a mutation-port capability cannot hide a dynamic raw managed writer", () => {
  const f = fixture();
  try {
    f.write(
      "feature.ts",
      [
        'import { safeWriteFile } from "./utils";',
        'const managedFilename = "config.yaml";',
        "export function persist(target) {",
        "  safeWriteFile(target, `# ${managedFilename}\\n`);",
        "}",
      ].join("\n"),
    );
    const report = verifyManagedModelWriters({
      root: f.root,
      includeRoot: "",
      capabilities: {
        "feature.ts": {
          capability: "test-mutation-port",
          roles: ["config"],
          allowUnknown: true,
        },
      },
    });
    assert.equal(report.ok, false);
    assert.equal(report.issues.length, 1);
    assert.equal(report.issues[0].kind, "raw_managed_writer");
    assert.match(report.issues[0].reason, /not statically bounded/);
  } finally {
    f.cleanup();
  }
});

test("rejects profile clone subprocesses without staging capability", () => {
  const f = fixture();
  try {
    f.write(
      "clone.ts",
      [
        'import { execFileSync } from "node:child_process";',
        'const command = "profile create agent --clone-from default";',
        'execFileSync("hermes", [command]);',
      ].join("\n"),
    );
    const report = verifyManagedModelWriters({ root: f.root, includeRoot: "" });
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some(
        (issue) => issue.kind === "profile_materialization_subprocess",
      ),
    );
  } finally {
    f.cleanup();
  }
});

// @lat: [[lat.md/beta27-reliability-plan#Beta.27 Reliability Plan#Recoverable model configuration#Profile deletion shares the managed write authority]]
test("rejects profile deletion subprocesses without a serialized deletion capability", () => {
  const f = fixture();
  try {
    f.write(
      "delete-profile.ts",
      [
        'import { execFileSync } from "node:child_process";',
        "export function removeProfile() {",
        '  execFileSync("hermes", ["profile", "delete", "agent"]);',
        "}",
      ].join("\n"),
    );
    const report = verifyManagedModelWriters({ root: f.root, includeRoot: "" });
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some(
        (issue) => issue.kind === "profile_deletion_subprocess",
      ),
      JSON.stringify(report.issues, null, 2),
    );
  } finally {
    f.cleanup();
  }
});

test("does not let a serialized deletion capability hide another delete function", () => {
  const f = fixture();
  try {
    f.write(
      "delete-profile.ts",
      [
        'import { execFileSync } from "node:child_process";',
        "export async function deleteProfile() {",
        "  return { success: true };",
        "}",
        "export function unsafeDelete() {",
        '  execFileSync("hermes", ["profile", "delete", "agent", "--yes"]);',
        "}",
      ].join("\n"),
    );
    const report = verifyManagedModelWriters({
      root: f.root,
      includeRoot: "",
      capabilities: {
        "delete-profile.ts": {
          capability: "test-serialized-profile-deletion",
          profileDeletionFunctions: ["deleteProfile"],
        },
      },
    });
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.kind === "profile_deletion_subprocess" &&
          issue.functionName === "unsafeDelete",
      ),
      JSON.stringify(report.issues, null, 2),
    );
  } finally {
    f.cleanup();
  }
});

test("rejects a managed target passed through aliased raw-writer wrappers", () => {
  const f = fixture();
  try {
    f.write(
      "storage.ts",
      [
        'import { writeFileSync as rawWrite } from "node:fs";',
        "export function forward(target) {",
        '  rawWrite(target, "model: {}\\n");',
        "}",
      ].join("\n"),
    );
    f.write(
      "feature.ts",
      [
        'import { resolve } from "node:path";',
        'import { forward as persist } from "./storage";',
        "export function saveModelConfiguration() {",
        '  persist(resolve("/tmp/aera-fixture", "config.yaml"));',
        "}",
      ].join("\n"),
    );

    const report = verifyManagedModelWriters({
      root: f.root,
      includeRoot: "",
      capabilities: {
        "feature.ts": {
          capability: "test-mutation-port",
          managedRoles: ["config"],
        },
      },
    });

    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.kind === "indirect_raw_managed_writer" &&
          issue.role === "config" &&
          issue.functionName === "saveModelConfiguration",
      ),
      JSON.stringify(report.issues, null, 2),
    );
  } finally {
    f.cleanup();
  }
});

test("accepts profile clone only inside the exact registered staging function", () => {
  const f = fixture();
  try {
    f.write(
      "clone.ts",
      [
        'import { execFileSync as run } from "node:child_process";',
        "export function prepareProfile() {",
        '  const args = ["profile", "create", "agent", "--clone-from", "default"];',
        '  run("hermes", args);',
        "}",
      ].join("\n"),
    );
    const report = verifyManagedModelWriters({
      root: f.root,
      includeRoot: "",
      capabilities: {
        "clone.ts": {
          capability: "test-profile-staging",
          profileMaterializationFunctions: ["prepareProfile"],
        },
      },
    });
    assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  } finally {
    f.cleanup();
  }
});

test("rejects profile clone outside the exact registered staging function", () => {
  const f = fixture();
  try {
    f.write(
      "clone.ts",
      [
        'import { execFileSync as run } from "node:child_process";',
        "export function prepareProfile() {",
        '  run("hermes", ["profile", "list"]);',
        "}",
        "export function unsafeClone() {",
        '  const args = ["profile", "create", "agent", "--clone-from", "default"];',
        '  run("hermes", args);',
        "}",
      ].join("\n"),
    );
    const report = verifyManagedModelWriters({
      root: f.root,
      includeRoot: "",
      capabilities: {
        "clone.ts": {
          capability: "test-profile-staging",
          profileMaterializationFunctions: ["prepareProfile"],
        },
      },
    });
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.kind === "profile_materialization_subprocess" &&
          issue.functionName === "unsafeClone",
      ),
      JSON.stringify(report.issues, null, 2),
    );
  } finally {
    f.cleanup();
  }
});

test("the current production source tree has no unregistered managed writer", () => {
  const report = verifyManagedModelWriters({ root: repoRoot });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  assert.ok(report.filesScanned > 0);
});
