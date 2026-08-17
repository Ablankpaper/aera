// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileRef } = vi.hoisted(() => ({
  execFileRef: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => execFileRef(...args),
  };
});

import * as processTree from "./process-tree";

interface SnapshotDiagnostic {
  phase: string;
  attempt: number;
  elapsedMs: number;
  outcome: string;
  profileKey: string;
  rootPid: number;
}

interface WindowsSnapshotRequest {
  rootPid: number;
  timeoutMs: number;
  phase: string;
  attempt: number;
  strategy: "cim" | "wmi";
  profileKey: string;
  onDiagnostic: (diagnostic: SnapshotDiagnostic) => void;
}

type CaptureWindowsSnapshot = (
  request: WindowsSnapshotRequest,
) => Promise<readonly processTree.ProcessSnapshotRecord[] | null>;

function captureWindowsSnapshot(): CaptureWindowsSnapshot | undefined {
  return (
    processTree as unknown as {
      captureWindowsSnapshot?: CaptureWindowsSnapshot;
    }
  ).captureWindowsSnapshot;
}

afterEach(() => {
  execFileRef.mockReset();
  vi.useRealTimers();
});

describe("captureWindowsSnapshot diagnostics", () => {
  it("reports a bounded command timeout with only sanitized stage fields", async () => {
    const capture = captureWindowsSnapshot();
    expect(capture).toBeTypeOf("function");
    if (!capture) return;

    vi.useFakeTimers();
    execFileRef.mockImplementation(
      (
        _command: string,
        _args: string[],
        options: { timeout: number },
        callback: (error: Error, stdout: string) => void,
      ) => {
        setTimeout(() => {
          callback(
            Object.assign(new Error("snapshot timed out"), { killed: true }),
            "",
          );
        }, options.timeout);
        return {};
      },
    );
    const diagnostics: SnapshotDiagnostic[] = [];

    const stopping = capture({
      rootPid: 100,
      timeoutMs: 25,
      phase: "initial-snapshot",
      attempt: 1,
      strategy: "cim",
      profileKey: "work",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(stopping).resolves.toBeNull();
    expect(diagnostics).toEqual([
      {
        phase: "initial-snapshot",
        attempt: 1,
        elapsedMs: 25,
        outcome: "timeout",
        profileKey: "work",
        rootPid: 100,
      },
    ]);
    expect(Object.keys(diagnostics[0] ?? {}).sort()).toEqual(
      [
        "attempt",
        "elapsedMs",
        "outcome",
        "phase",
        "profileKey",
        "rootPid",
      ].sort(),
    );
  });

  it("reports a command failure without command output", async () => {
    const capture = captureWindowsSnapshot();
    expect(capture).toBeTypeOf("function");
    if (!capture) return;

    execFileRef.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: { timeout: number },
        callback: (error: Error, stdout: string) => void,
      ) => {
        callback(
          Object.assign(new Error("not available"), { code: "ENOENT" }),
          "",
        );
        return {};
      },
    );
    const diagnostics: SnapshotDiagnostic[] = [];

    await expect(
      capture({
        rootPid: 101,
        timeoutMs: 25,
        phase: "initial-snapshot",
        attempt: 2,
        strategy: "wmi",
        profileKey: "default",
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toBeNull();
    expect(diagnostics).toEqual([
      expect.objectContaining({
        phase: "initial-snapshot",
        attempt: 2,
        outcome: "error",
        profileKey: "default",
        rootPid: 101,
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("not available");
  });

  it("fails closed when a fallback row has no creation identity", async () => {
    const capture = captureWindowsSnapshot();
    expect(capture).toBeTypeOf("function");
    if (!capture) return;

    execFileRef.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: { timeout: number },
        callback: (error: null, stdout: string) => void,
      ) => {
        callback(
          null,
          JSON.stringify({
            ProcessId: 102,
            ParentProcessId: 1,
            CreationFileTimeUtc: null,
          }),
        );
        return {};
      },
    );
    const diagnostics: SnapshotDiagnostic[] = [];

    await expect(
      capture({
        rootPid: 102,
        timeoutMs: 25,
        phase: "initial-snapshot",
        attempt: 2,
        strategy: "wmi",
        profileKey: "work",
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toBeNull();
    expect(diagnostics).toEqual([
      expect.objectContaining({
        attempt: 2,
        outcome: "invalid",
        rootPid: 102,
      }),
    ]);
  });

  it("fails closed when output contains a malformed partial row", async () => {
    const capture = captureWindowsSnapshot();
    expect(capture).toBeTypeOf("function");
    if (!capture) return;

    execFileRef.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: { timeout: number },
        callback: (error: null, stdout: string) => void,
      ) => {
        callback(
          null,
          JSON.stringify([
            {
              ProcessId: 103,
              ParentProcessId: 1,
              CreationFileTimeUtc: "134146437120000000",
            },
            {
              ProcessId: "not-a-pid",
              ParentProcessId: 103,
              CreationFileTimeUtc: "134146437120000001",
            },
          ]),
        );
        return {};
      },
    );
    const diagnostics: SnapshotDiagnostic[] = [];

    await expect(
      capture({
        rootPid: 103,
        timeoutMs: 25,
        phase: "initial-snapshot",
        attempt: 1,
        strategy: "cim",
        profileKey: "private/profile with spaces",
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toBeNull();
    expect(diagnostics).toEqual([
      expect.objectContaining({
        outcome: "invalid",
        profileKey: "private_profile_with_spaces",
        rootPid: 103,
      }),
    ]);
  });
});
