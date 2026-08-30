// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PackagedSeedInstallDiagnostic } from "../src/main/agentera-runtime-distribution/seed-installer";

const temporaryDirectories: string[] = [];
const originalDiagnostics = process.env.AGENTERA_E2E_DIAGNOSTICS;
const originalOutput =
  process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT;

afterEach(async () => {
  if (originalDiagnostics === undefined) {
    delete process.env.AGENTERA_E2E_DIAGNOSTICS;
  } else {
    process.env.AGENTERA_E2E_DIAGNOSTICS = originalDiagnostics;
  }
  if (originalOutput === undefined) {
    delete process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT;
  } else {
    process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT =
      originalOutput;
  }
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function outputPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aera-runtime-install-diag-"));
  temporaryDirectories.push(root);
  const output = join(root, "events.jsonl");
  await writeFile(output, "", { flag: "wx", mode: 0o600 });
  return output;
}

async function events(output: string): Promise<Record<string, unknown>[]> {
  return (await readFile(output, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function loadDiagnosticFactory(): Promise<{
  createPackagedSeedInstallDiagnostic: () =>
    | PackagedSeedInstallDiagnostic
    | undefined;
}> {
  return import("../src/main/runtime-install-lifecycle-diagnostics");
}

describe("packaged Runtime install lifecycle diagnostics", () => {
  it("writes nothing unless diagnostics and an absolute output are both explicit", async () => {
    const output = await outputPath();
    const { createPackagedSeedInstallDiagnostic } =
      await loadDiagnosticFactory();

    process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT = output;
    expect(createPackagedSeedInstallDiagnostic()).toBeUndefined();

    process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
    process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT =
      "relative-events.jsonl";
    expect(createPackagedSeedInstallDiagnostic()).toBeUndefined();
    expect(isAbsolute("relative-events.jsonl")).toBe(false);
    expect(await readFile(output, "utf8")).toBe("");
  });

  it("appends path-free lifecycle evidence with safe bounded fields", async () => {
    const output = await outputPath();
    process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
    process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT = output;
    const { createPackagedSeedInstallDiagnostic } =
      await loadDiagnosticFactory();
    const diagnostic = createPackagedSeedInstallDiagnostic();

    expect(diagnostic).toEqual(expect.any(Function));
    diagnostic?.("health-failed", {
      runtimeVersion: "0.20.0-agentera.5",
      requiredDiskBytes: 1234,
    });

    const recorded = await events(output);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      schemaVersion: 1,
      event: "runtime-install-health-failed",
      elapsedMs: expect.any(Number),
      runtimeVersion: "0.20.0-agentera.5",
      requiredDiskBytes: 1234,
    });
    expect(recorded[0]).not.toHaveProperty("path");
    expect(recorded[0]).not.toHaveProperty("error");
    expect(Object.keys(recorded[0])).toEqual([
      "schemaVersion",
      "event",
      "elapsedMs",
      "runtimeVersion",
      "requiredDiskBytes",
    ]);
  });

  it("swallows an unwritable diagnostic sink", async () => {
    const output = await mkdtemp(
      join(tmpdir(), "aera-runtime-install-diag-unwritable-"),
    );
    temporaryDirectories.push(output);
    process.env.AGENTERA_E2E_DIAGNOSTICS = "1";
    process.env.AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT = output;
    const { createPackagedSeedInstallDiagnostic } =
      await loadDiagnosticFactory();

    expect(() =>
      createPackagedSeedInstallDiagnostic()?.("transaction-cleanup-start"),
    ).not.toThrow();
  });
});
