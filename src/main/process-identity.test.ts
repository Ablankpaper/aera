// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const { execFileRef, execFileSyncRef } = vi.hoisted(() => ({
  execFileRef: { value: vi.fn() },
  execFileSyncRef: { value: vi.fn() },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: Parameters<typeof actual.execFile>) =>
      execFileRef.value(...args),
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) =>
      execFileSyncRef.value(...args),
  };
});

import {
  readProcessIdentityEvidence,
  readProcessIdentityEvidenceAsync,
} from "./process-identity";

describe("readProcessIdentityEvidence", () => {
  it("gives the Windows CIM query enough budget for a cold packaged Runtime", () => {
    execFileSyncRef.value.mockReturnValue(
      JSON.stringify({
        CreationFileTimeUtc: "133000000000000000",
        Name: "python.exe",
      }),
    );

    expect(
      readProcessIdentityEvidence(6608, {
        platform: "win32",
        execFileSync: execFileSyncRef.value,
      }),
    ).toEqual({
      identity: "windows:133000000000000000",
      image: "python.exe",
    });
    expect(execFileSyncRef.value).toHaveBeenCalledWith(
      "powershell.exe",
      expect.any(Array),
      expect.objectContaining({ timeout: 5_000 }),
    );
  });
});

describe("readProcessIdentityEvidenceAsync", () => {
  it("reads a cold Windows process without blocking the Electron event loop", async () => {
    execFileSyncRef.value.mockClear();
    execFileRef.value.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        setTimeout(
          () =>
            callback(
              null,
              JSON.stringify({
                CreationFileTimeUtc: "133000000000000000",
                Name: "python.exe",
              }),
            ),
          20,
        );
        return {};
      },
    );

    const evidence = await readProcessIdentityEvidenceAsync(6608, {
      platform: "win32",
      execFile: execFileRef.value,
      timeoutMs: 100,
    });

    expect(evidence).toEqual({
      identity: "windows:133000000000000000",
      image: "python.exe",
    });
    expect(execFileRef.value).toHaveBeenCalledWith(
      "powershell.exe",
      expect.any(Array),
      expect.objectContaining({ timeout: 100 }),
      expect.any(Function),
    );
    expect(execFileSyncRef.value).not.toHaveBeenCalled();
  });

  it("returns unavailable evidence when the bounded Windows query times out", async () => {
    execFileRef.value.mockImplementation(() => ({}));

    await expect(
      readProcessIdentityEvidenceAsync(6608, {
        platform: "win32",
        execFile: execFileRef.value,
        timeoutMs: 10,
      }),
    ).resolves.toBeNull();
  });
});
