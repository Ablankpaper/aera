import { describe, expect, it, vi } from "vitest";

const execFileSpy = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, "[]", ""),
  ),
);

vi.mock("child_process", () => ({
  execFile: execFileSpy,
  default: { execFile: execFileSpy },
}));

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: "/tmp/hermes-home",
  getEnhancedPath: () => process.env.PATH || "",
}));

vi.mock("../src/main/agentera-runtime-distribution/invocation", () => ({
  getRuntimeInvocation: () => ({
    source: "managed",
    version: "test",
    sourceCommit: "0".repeat(40),
    root: "/tmp/runtime/test",
    python: "/tmp/runtime/test/python/bin/python3",
    workingDirectory: "/tmp/runtime/test/python/lib/python3.11/site-packages",
    bundledSkillsDirectory: "/tmp/runtime/test/python/skills",
    webDistDirectory:
      "/tmp/runtime/test/python/lib/python3.11/site-packages/hermes_cli/web_dist",
    cliArgs: (args: string[] = []) => ["-m", "hermes_cli.main", ...args],
    environment: (base: Record<string, string> = {}) => ({ ...base }),
  }),
}));

vi.mock("../src/main/hermes", () => ({
  isRemoteOnlyMode: () => false,
}));

vi.mock("../src/main/config", () => ({
  getConnectionConfig: () => ({ mode: "local" }),
}));

vi.mock("../src/main/ssh-remote", () => ({
  sshRunKanban: vi.fn(),
  sshListClaw3dHqTasks: vi.fn(),
}));

import { listBoards } from "../src/main/kanban";

describe("Kanban Runtime invocation", () => {
  it("runs local board listing through the managed Runtime", async () => {
    execFileSpy.mockClear();

    await expect(listBoards(false, "work")).resolves.toEqual({
      success: true,
      data: [],
    });
    expect(execFileSpy).toHaveBeenCalledWith(
      "/tmp/runtime/test/python/bin/python3",
      [
        "-m",
        "hermes_cli.main",
        "-p",
        "work",
        "kanban",
        "boards",
        "list",
        "--json",
      ],
      expect.objectContaining({
        cwd: "/tmp/runtime/test/python/lib/python3.11/site-packages",
      }),
      expect.any(Function),
    );
  });
});
