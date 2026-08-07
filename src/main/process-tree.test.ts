import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

import { terminateProcessTree } from "./process-tree";

interface FakeProcess {
  child: ChildProcess;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChildProcess(pid: number, alive: Set<number>): FakeProcess {
  const kill = vi.fn((signal: NodeJS.Signals) => {
    if (signal === "SIGKILL") alive.delete(pid);
    return true;
  });
  return {
    child: {
      pid,
      exitCode: null,
      signalCode: null,
      kill,
    } as unknown as ChildProcess,
    kill,
  };
}

describe("terminateProcessTree", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("stops the exact captured tree with SIGTERM when it exits in time", async () => {
    const alive = new Set([100, 101, 999]);
    const root = fakeChildProcess(100, alive);
    const signalPid = vi.fn((pid: number, signal: NodeJS.Signals) => {
      if (pid === 101 && (signal === "SIGTERM" || signal === "SIGKILL")) {
        alive.delete(101);
      }
    });
    root.kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") alive.delete(100);
      return true;
    });

    const result = await terminateProcessTree(root.child, {
      detachedProcessGroup: false,
      forceAfterMs: 100,
      pollIntervalMs: 10,
      operations: {
        descendantProcesses: () => [{ pid: 101, identity: "child-start" }],
        processIdentity: (pid) => (pid === 100 ? "root-start" : "child-start"),
        pidIsAlive: (pid) => alive.has(pid),
        signalPid,
      },
    });

    expect(result).toEqual({ forced: false, remainingPids: [] });
    expect(root.kill).toHaveBeenCalledWith("SIGTERM");
    expect(root.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(signalPid).toHaveBeenCalledWith(101, "SIGTERM");
    expect(signalPid).not.toHaveBeenCalledWith(101, "SIGKILL");
    expect(signalPid).not.toHaveBeenCalledWith(999, "SIGTERM");
    expect(signalPid).not.toHaveBeenCalledWith(999, "SIGKILL");
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Bounded force escalation]]
  it("forces only the captured live tree after the grace window", async () => {
    vi.useFakeTimers();
    const alive = new Set([100, 101, 999]);
    const root = fakeChildProcess(100, alive);
    const signalPid = vi.fn((pid: number, signal: NodeJS.Signals) => {
      if (pid === 101 && signal === "SIGKILL") alive.delete(101);
    });

    const stopping = terminateProcessTree(root.child, {
      detachedProcessGroup: false,
      forceAfterMs: 100,
      pollIntervalMs: 10,
      forceSettleMs: 50,
      operations: {
        descendantProcesses: () => [{ pid: 101, identity: "child-start" }],
        processIdentity: (pid) => (pid === 100 ? "root-start" : "child-start"),
        pidIsAlive: (pid) => alive.has(pid),
        signalPid,
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    await expect(stopping).resolves.toEqual({
      forced: true,
      remainingPids: [],
    });
    expect(root.kill.mock.calls.map(([signal]) => signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(signalPid).toHaveBeenCalledWith(101, "SIGTERM");
    expect(signalPid).toHaveBeenCalledWith(101, "SIGKILL");
    expect(signalPid).not.toHaveBeenCalledWith(999, "SIGTERM");
    expect(signalPid).not.toHaveBeenCalledWith(999, "SIGKILL");
    vi.useRealTimers();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("does not signal a descendant after its PID is reused", async () => {
    const alive = new Set([100, 101]);
    const root = fakeChildProcess(100, alive);
    const signalPid = vi.fn();
    let childIdentityChecks = 0;
    const processIdentity = vi.fn((pid: number) => {
      if (pid === 100) return "root-start";
      childIdentityChecks += 1;
      return childIdentityChecks === 1 ? "child-start" : "different-process";
    });

    const result = await terminateProcessTree(root.child, {
      detachedProcessGroup: false,
      forceAfterMs: 0,
      operations: {
        descendantProcesses: () => [{ pid: 101, identity: "child-start" }],
        pidIsAlive: (pid) => alive.has(pid),
        processIdentity,
        signalPid,
      },
    });

    expect(result.forced).toBe(true);
    expect(signalPid).toHaveBeenCalledWith(101, "SIGTERM");
    expect(signalPid).not.toHaveBeenCalledWith(101, "SIGKILL");
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Bounded force escalation]]
  it("force-cleans captured Windows descendants after the root exits", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    const alive = new Set([100, 101]);
    const root = fakeChildProcess(100, alive);
    const gracefulWindowsTree = vi.fn(() => {
      alive.delete(100);
      Object.defineProperty(root.child, "exitCode", {
        configurable: true,
        value: 0,
      });
    });
    const signalPid = vi.fn((pid: number, signal: NodeJS.Signals) => {
      if (pid === 101 && signal === "SIGKILL") alive.delete(pid);
    });
    const forceWindowsTree = vi.fn();

    try {
      const result = await terminateProcessTree(root.child, {
        detachedProcessGroup: false,
        forceAfterMs: 0,
        operations: {
          descendantProcesses: () => [{ pid: 101, identity: "child-start" }],
          pidIsAlive: (pid) => alive.has(pid),
          processIdentity: () => "child-start",
          signalPid,
          gracefulWindowsTree,
          forceWindowsTree,
        },
      });

      expect(result).toEqual({ forced: true, remainingPids: [] });
      expect(gracefulWindowsTree).toHaveBeenCalledWith(100);
      expect(forceWindowsTree).not.toHaveBeenCalled();
      expect(signalPid).toHaveBeenCalledWith(101, "SIGKILL");
    } finally {
      platform.mockRestore();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Bounded force escalation]]
  it("escalates the exact live Windows root tree after the grace window", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    const alive = new Set([100, 101]);
    const root = fakeChildProcess(100, alive);
    const gracefulWindowsTree = vi.fn();
    const forceWindowsTree = vi.fn(() => {
      alive.clear();
      Object.defineProperty(root.child, "exitCode", {
        configurable: true,
        value: 0,
      });
    });

    try {
      const result = await terminateProcessTree(root.child, {
        detachedProcessGroup: false,
        forceAfterMs: 0,
        operations: {
          descendantProcesses: () => [{ pid: 101, identity: "child-start" }],
          pidIsAlive: (pid) => alive.has(pid),
          processIdentity: (pid) =>
            pid === 100 ? "root-start" : "child-start",
          signalPid: vi.fn(),
          gracefulWindowsTree,
          forceWindowsTree,
        },
      });

      expect(result).toEqual({ forced: true, remainingPids: [] });
      expect(gracefulWindowsTree).toHaveBeenCalledWith(100);
      expect(forceWindowsTree).toHaveBeenCalledWith(100);
    } finally {
      platform.mockRestore();
    }
  });
});
