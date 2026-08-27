// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const { execFileSyncRef } = vi.hoisted(() => ({
  execFileSyncRef: { value: vi.fn() },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) =>
      execFileSyncRef.value(...args),
  };
});

import { readProcessIdentityEvidence } from "./process-identity";

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
