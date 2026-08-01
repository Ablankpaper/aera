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

import { createBoard, listBoards } from "../src/main/kanban";

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

  it("rejects an invalid board identifier before invoking Runtime", async () => {
    execFileSpy.mockClear();

    await expect(createBoard("测试看板", "测试看板", true)).resolves.toEqual({
      success: false,
      error: expect.stringContaining("Board identifier"),
    });
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it("verifies a newly created board was durably persisted and selected", async () => {
    execFileSpy
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _options: Record<string, unknown>,
          callback: (
            error: Error | null,
            stdout: string,
            stderr: string,
          ) => void,
        ) => callback(null, "Board created.", ""),
      )
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _options: Record<string, unknown>,
          callback: (
            error: Error | null,
            stdout: string,
            stderr: string,
          ) => void,
        ) =>
          callback(
            null,
            JSON.stringify([
              {
                slug: "release-board",
                name: "Release Board",
                is_current: true,
                archived: false,
                total: 0,
                counts: {},
              },
            ]),
            "",
          ),
      );

    await expect(
      createBoard("Release-Board", "Release Board", true, "work"),
    ).resolves.toEqual({ success: true });
    expect(execFileSpy).toHaveBeenNthCalledWith(
      1,
      "/tmp/runtime/test/python/bin/python3",
      [
        "-m",
        "hermes_cli.main",
        "-p",
        "work",
        "kanban",
        "boards",
        "create",
        "release-board",
        "--name",
        "Release Board",
        "--switch",
      ],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("does not report success when an older Runtime drops an error exit code", async () => {
    execFileSpy
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _options: Record<string, unknown>,
          callback: (
            error: Error | null,
            stdout: string,
            stderr: string,
          ) => void,
        ) => callback(null, "kanban boards create: storage is unavailable", ""),
      )
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _options: Record<string, unknown>,
          callback: (
            error: Error | null,
            stdout: string,
            stderr: string,
          ) => void,
        ) => callback(null, "[]", ""),
      );

    await expect(createBoard("missing-board")).resolves.toEqual({
      success: false,
      error: "kanban boards create: storage is unavailable",
    });
  });
});
