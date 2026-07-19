import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => join(tmpdir(), "agentera-runtime-electron-user-data"),
    getVersion: () => "0.7.3",
    isPackaged: false,
  },
}));

import {
  configureRuntimeInvocationContext,
  getRuntimeInvocation,
  resetRuntimeInvocationContext,
  selectExternalRuntime,
  selectManagedRuntime,
} from "../src/main/agentera-runtime-distribution/invocation";
import {
  persistRuntimeSelection,
  readRuntimeSelection,
} from "../src/main/agentera-runtime-distribution/selection-store";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentera-external-runtime-"));
  temporaryDirectories.push(root);
  return root;
}

function createExternalRuntime(hermesHome: string): string {
  const checkout = join(hermesHome, "hermes-agent");
  mkdirSync(join(checkout, "venv", "bin"), { recursive: true });
  mkdirSync(join(checkout, "hermes_cli", "web_dist"), { recursive: true });
  mkdirSync(join(checkout, "skills"), { recursive: true });
  writeFileSync(join(checkout, "venv", "bin", "python"), "external-python");
  writeFileSync(join(checkout, "hermes_cli", "main.py"), "# external\n");
  writeFileSync(join(checkout, "local-learning.txt"), "never mutate me\n");
  return checkout;
}

function createManagedRuntime(userDataPath: string): void {
  const runtimeRoot = join(userDataPath, "runtime");
  const versionDirectory = "0.18.2-agentera.1-abcdef123456";
  const root = join(runtimeRoot, "versions", versionDirectory);
  const sitePackages = join(
    root,
    "python",
    "lib",
    "python3.11",
    "site-packages",
  );
  mkdirSync(join(root, "python", "bin"), { recursive: true });
  mkdirSync(join(root, "python", "skills"), { recursive: true });
  mkdirSync(join(sitePackages, "hermes_cli", "web_dist"), {
    recursive: true,
  });
  writeFileSync(join(root, "python", "bin", "python3"), "managed-python");
  writeFileSync(
    join(runtimeRoot, "current.json"),
    JSON.stringify({
      schemaVersion: 1,
      runtimeVersion: "0.18.2-agentera.1",
      sourceCommit: "a".repeat(40),
      versionDirectory,
      manifestSha256: "b".repeat(64),
      installedAt: "2026-07-18T12:00:00.000Z",
    }),
  );
}

function checkoutSnapshot(checkout: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else {
        result[path.slice(checkout.length + 1)] = readFileSync(path, "utf8");
      }
    }
  };
  visit(checkout);
  return result;
}

afterEach(() => {
  resetRuntimeInvocationContext();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("explicit external Runtime compatibility", () => {
  it("migrates the legacy Hermes-home override to explicit external mode", () => {
    const root = temporaryRoot();
    const hermesHome = join(root, "hermes-home");
    const selectionFile = join(root, "runtime-selection.json");
    mkdirSync(hermesHome, { recursive: true });
    writeFileSync(selectionFile, JSON.stringify({ hermesHome }));

    expect(readRuntimeSelection(selectionFile)).toEqual({
      mode: "external",
      hermesHome,
    });
  });

  it("rejects ambiguous legacy selection records", () => {
    const root = temporaryRoot();
    const hermesHome = join(root, "hermes-home");
    const selectionFile = join(root, "runtime-selection.json");
    mkdirSync(hermesHome, { recursive: true });
    writeFileSync(
      selectionFile,
      JSON.stringify({ hermesHome, unexpected: "external" }),
    );

    expect(readRuntimeSelection(selectionFile)).toBeNull();
  });

  it("persists external and managed choices without removing the selected Hermes home", () => {
    const root = temporaryRoot();
    const hermesHome = join(root, "hermes-home");
    const selectionFile = join(root, "runtime-selection.json");
    mkdirSync(hermesHome, { recursive: true });

    persistRuntimeSelection(selectionFile, {
      mode: "external",
      hermesHome,
    });
    expect(readRuntimeSelection(selectionFile)).toEqual({
      mode: "external",
      hermesHome,
    });

    persistRuntimeSelection(selectionFile, {
      mode: "managed",
      hermesHome,
    });
    expect(readRuntimeSelection(selectionFile)).toEqual({
      mode: "managed",
      hermesHome,
    });
  });

  it("switches invocation modes without modifying the legacy checkout", () => {
    const root = temporaryRoot();
    const hermesHome = join(root, "hermes-home");
    const userDataPath = join(root, "user-data");
    mkdirSync(hermesHome, { recursive: true });
    mkdirSync(userDataPath, { recursive: true });
    const checkout = createExternalRuntime(hermesHome);
    createManagedRuntime(userDataPath);
    const before = checkoutSnapshot(checkout);
    configureRuntimeInvocationContext({
      hermesHome,
      userDataPath,
      platform: "darwin",
    });

    selectExternalRuntime(hermesHome);
    expect(getRuntimeInvocation()?.source).toBe("external");
    selectManagedRuntime();
    expect(getRuntimeInvocation()?.source).toBe("managed");
    selectExternalRuntime(hermesHome);
    expect(getRuntimeInvocation()?.source).toBe("external");

    expect(checkoutSnapshot(checkout)).toEqual(before);
  });

  it("runs an unmanaged update only through the selected checkout's local CLI", async () => {
    const root = temporaryRoot();
    const hermesHome = join(root, "hermes-home");
    const userDataPath = join(root, "user-data");
    mkdirSync(hermesHome, { recursive: true });
    mkdirSync(userDataPath, { recursive: true });
    const checkout = createExternalRuntime(hermesHome);
    const before = checkoutSnapshot(checkout);
    const { runHermesUpdate } = await import("../src/main/installer");
    configureRuntimeInvocationContext({
      hermesHome,
      userDataPath,
      platform: "darwin",
    });
    selectExternalRuntime(hermesHome);

    const processEvents = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const spawnRuntime = vi.fn(
      () => processEvents,
    ) as unknown as typeof import("node:child_process").spawn;

    const update = runHermesUpdate(() => undefined, spawnRuntime);
    processEvents.emit("close", 0);
    await update;

    expect(spawnRuntime).toHaveBeenCalledOnce();
    expect(spawnRuntime).toHaveBeenCalledWith(
      join(checkout, "venv", "bin", "python"),
      ["-m", "hermes_cli.main", "update"],
      expect.objectContaining({
        cwd: checkout,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(checkoutSnapshot(checkout)).toEqual(before);
  });
});
