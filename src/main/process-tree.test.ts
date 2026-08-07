import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

import * as processTree from "./process-tree";
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
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    vi.useFakeTimers();
    const alive = new Set([100, 101, 999]);
    const root = fakeChildProcess(100, alive);
    const signalPid = vi.fn((pid: number, signal: NodeJS.Signals) => {
      if (pid === 101 && signal === "SIGKILL") alive.delete(101);
    });

    try {
      const stopping = terminateProcessTree(root.child, {
        detachedProcessGroup: false,
        forceAfterMs: 100,
        pollIntervalMs: 10,
        forceSettleMs: 50,
        operations: {
          descendantProcesses: () => [{ pid: 101, identity: "child-start" }],
          processIdentity: (pid) =>
            pid === 100 ? "root-start" : "child-start",
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
    } finally {
      platform.mockRestore();
      vi.useRealTimers();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("terminates a dedicated POSIX process group without reading process environments", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    vi.useFakeTimers();
    const alive = { value: true };
    const root = fakeChildProcess(100, new Set([100]));
    Object.defineProperty(root.child, "exitCode", {
      configurable: true,
      value: 0,
    });
    const captureSnapshot = vi.fn(async () => {
      throw new Error("a dedicated process group must not use PID snapshots");
    });
    const signalProcessGroup = vi.fn(
      (_processGroupId: number, signal: NodeJS.Signals) => {
        if (signal === "SIGKILL") alive.value = false;
      },
    );

    try {
      const stopping = terminateProcessTree(root.child, {
        detachedProcessGroup: true,
        forceAfterMs: 20,
        forceSettleMs: 0,
        pollIntervalMs: 5,
        operations: {
          captureSnapshot,
          processGroupIsAlive: () => alive.value,
          processGroupPids: vi.fn(async () => (alive.value ? [101] : [])),
          signalProcessGroup,
        } as never,
      });
      await vi.advanceTimersByTimeAsync(20);
      await vi.runAllTimersAsync();

      await expect(stopping).resolves.toEqual({
        forced: true,
        remainingPids: [],
      });
      expect(signalProcessGroup.mock.calls).toEqual([
        [100, "SIGTERM"],
        [100, "SIGKILL"],
      ]);
      expect(captureSnapshot).not.toHaveBeenCalled();
      expect(root.kill).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
      vi.useRealTimers();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Bounded force escalation]]
  it("does not force a dedicated POSIX group that exits during the grace window", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    let groupAlive = true;
    const root = fakeChildProcess(100, new Set([100]));
    const signalProcessGroup = vi.fn(
      (_processGroupId: number, signal: NodeJS.Signals) => {
        if (signal === "SIGTERM") groupAlive = false;
      },
    );

    try {
      await expect(
        terminateProcessTree(root.child, {
          detachedProcessGroup: true,
          forceAfterMs: 3_000,
          operations: {
            pidIsAlive: () => groupAlive,
            processGroupIsAlive: () => groupAlive,
            processGroupPids: vi.fn(async () => [100]),
            signalProcessGroup,
          } as never,
        }),
      ).resolves.toEqual({ forced: false, remainingPids: [] });
      expect(signalProcessGroup.mock.calls).toEqual([[100, "SIGTERM"]]);
    } finally {
      platform.mockRestore();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("fails closed when a dedicated process group cannot be verified", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    const root = fakeChildProcess(100, new Set([100]));
    const signalProcessGroup = vi.fn();

    try {
      await expect(
        terminateProcessTree(root.child, {
          detachedProcessGroup: true,
          operations: {
            processGroupIsAlive: () => true,
            processGroupPids: vi.fn(async () => null),
            signalProcessGroup,
          } as never,
        }),
      ).rejects.toThrow(/process group.*verif/i);
      expect(signalProcessGroup).not.toHaveBeenCalled();
      expect(root.kill).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("accepts a dedicated group that exits between the liveness check and membership query", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    const root = fakeChildProcess(100, new Set<number>());
    Object.defineProperty(root.child, "exitCode", {
      configurable: true,
      value: 0,
    });
    const processGroupIsAlive = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const signalProcessGroup = vi.fn();

    try {
      await expect(
        terminateProcessTree(root.child, {
          detachedProcessGroup: true,
          operations: {
            processGroupIsAlive,
            processGroupPids: vi.fn(async () => []),
            signalProcessGroup,
          } as never,
        }),
      ).resolves.toEqual({ forced: false, remainingPids: [] });
      expect(processGroupIsAlive).toHaveBeenCalledTimes(2);
      expect(signalProcessGroup).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Bounded force escalation]]
  it("accepts a forced group that exits before the final membership query", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    let groupAlive = true;
    const root = fakeChildProcess(100, new Set([100]));
    const processGroupPids = vi
      .fn()
      .mockResolvedValueOnce([100])
      .mockImplementationOnce(async () => {
        groupAlive = false;
        (root.child as unknown as { exitCode: number | null }).exitCode = 0;
        return [];
      });
    const signalProcessGroup = vi.fn();

    try {
      await expect(
        terminateProcessTree(root.child, {
          detachedProcessGroup: true,
          forceAfterMs: 0,
          forceSettleMs: 0,
          operations: {
            pidIsAlive: () => groupAlive,
            processGroupIsAlive: () => groupAlive,
            processGroupPids,
            signalProcessGroup,
          } as never,
        }),
      ).resolves.toEqual({ forced: true, remainingPids: [] });
      expect(signalProcessGroup.mock.calls).toEqual([
        [100, "SIGTERM"],
        [100, "SIGKILL"],
      ]);
    } finally {
      platform.mockRestore();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("fails closed when the owned child is alive without its dedicated process group", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    const root = fakeChildProcess(100, new Set([100]));
    const signalProcessGroup = vi.fn();

    try {
      await expect(
        terminateProcessTree(root.child, {
          detachedProcessGroup: true,
          operations: {
            processGroupIsAlive: () => false,
            processGroupPids: vi.fn(async () => []),
            signalProcessGroup,
            pidIsAlive: (pid) => pid === 100,
          } as never,
        }),
      ).rejects.toThrow(/process group.*unavailable/i);
      expect(signalProcessGroup).not.toHaveBeenCalled();
      expect(root.kill).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("does not signal a numeric group that no longer contains the live owned child", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    const root = fakeChildProcess(100, new Set([100]));
    const signalProcessGroup = vi.fn();

    try {
      await expect(
        terminateProcessTree(root.child, {
          detachedProcessGroup: true,
          operations: {
            processGroupIsAlive: () => true,
            processGroupPids: vi.fn(async () => [101]),
            signalProcessGroup,
            pidIsAlive: (pid) => pid === 100,
          } as never,
        }),
      ).rejects.toThrow(/owned child.*process group/i);
      expect(signalProcessGroup).not.toHaveBeenCalled();
      expect(root.kill).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
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
      expect(gracefulWindowsTree).toHaveBeenCalledWith(100, expect.any(Number));
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
      expect(gracefulWindowsTree).toHaveBeenCalledWith(100, expect.any(Number));
      expect(forceWindowsTree).toHaveBeenCalledWith(100, expect.any(Number));
    } finally {
      platform.mockRestore();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("uses one bounded snapshot per verification phase instead of per-PID commands", async () => {
    const alive = new Set([100]);
    const root = fakeChildProcess(100, alive);
    const captureSnapshot = vi.fn(async () => [
      { pid: 100, parentPid: 1, identity: "root@boot:42" },
    ]);
    const processIdentity = vi.fn(() => "root@boot:42");
    root.kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") alive.delete(100);
      return true;
    });

    const result = await terminateProcessTree(root.child, {
      detachedProcessGroup: false,
      forceAfterMs: 100,
      operations: {
        captureSnapshot,
        processIdentity,
        descendantProcesses: () => [],
        pidIsAlive: (pid) => alive.has(pid),
      } as never,
    });

    expect(result).toEqual({ forced: false, remainingPids: [] });
    expect(captureSnapshot).toHaveBeenCalledOnce();
    expect(processIdentity).not.toHaveBeenCalled();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("fails closed when ownership snapshot capture is unavailable", async () => {
    const alive = new Set([100, 101]);
    const root = fakeChildProcess(100, alive);
    const signalPid = vi.fn();
    const captureSnapshot = vi.fn(async () => null);

    const result = await terminateProcessTree(root.child, {
      detachedProcessGroup: false,
      forceAfterMs: 0,
      forceSettleMs: 0,
      operations: {
        captureSnapshot,
        descendantProcesses: () => [{ pid: 101, identity: "child@boot:43" }],
        processIdentity: (pid) =>
          pid === 100 ? "root@boot:42" : "child@boot:43",
        pidIsAlive: (pid) => alive.has(pid),
        signalPid,
      } as never,
    });

    expect(captureSnapshot).toHaveBeenCalledOnce();
    expect(signalPid).not.toHaveBeenCalled();
    expect(root.kill).not.toHaveBeenCalled();
    expect(result.remainingPids).toContain(100);
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("fails closed when the captured root has no usable identity", async () => {
    const alive = new Set([100]);
    const root = fakeChildProcess(100, alive);
    const signalPid = vi.fn();
    const captureSnapshot = vi.fn(async () => [
      { pid: 100, parentPid: 1, identity: "" },
    ]);

    const result = await terminateProcessTree(root.child, {
      detachedProcessGroup: false,
      forceAfterMs: 0,
      operations: {
        captureSnapshot,
        pidIsAlive: (pid) => alive.has(pid),
        signalPid,
      } as never,
    });

    expect(result.remainingPids).toContain(100);
    expect(signalPid).not.toHaveBeenCalled();
    expect(root.kill).not.toHaveBeenCalled();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("fails closed when a reachable descendant has no usable identity", async () => {
    const alive = new Set([100, 101]);
    const root = fakeChildProcess(100, alive);
    const signalPid = vi.fn();
    const captureSnapshot = vi.fn(async () => [
      { pid: 100, parentPid: 1, identity: "root@boot:42" },
      { pid: 101, parentPid: 100, identity: "" },
    ]);

    const result = await terminateProcessTree(root.child, {
      detachedProcessGroup: false,
      forceAfterMs: 0,
      operations: {
        captureSnapshot,
        pidIsAlive: (pid) => alive.has(pid),
        signalPid,
      } as never,
    });

    expect(result).toEqual({ forced: false, remainingPids: [101, 100] });
    expect(signalPid).not.toHaveBeenCalled();
    expect(root.kill).not.toHaveBeenCalled();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("bounds a hanging ownership snapshot and never falls back to PID-only force", async () => {
    vi.useFakeTimers();
    const alive = new Set([100]);
    const root = fakeChildProcess(100, alive);
    const captureSnapshot = vi.fn(() => new Promise<never>(() => undefined));
    const signalPid = vi.fn();
    const stopping = terminateProcessTree(root.child, {
      detachedProcessGroup: false,
      snapshotTimeoutMs: 25,
      operations: {
        captureSnapshot,
        pidIsAlive: (pid) => alive.has(pid),
        signalPid,
      } as never,
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(stopping).resolves.toEqual({
      forced: false,
      remainingPids: [100],
    });
    expect(signalPid).not.toHaveBeenCalled();
    expect(root.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Bounded force escalation]]
  it("fails closed when the escalation identity refresh times out", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    vi.useFakeTimers();
    const alive = new Set([100, 101]);
    const root = fakeChildProcess(100, alive);
    const captureSnapshot = vi
      .fn()
      .mockResolvedValueOnce([
        { pid: 100, parentPid: 1, identity: "root@boot:42" },
        { pid: 101, parentPid: 100, identity: "child@boot:43" },
      ])
      .mockImplementationOnce(() => new Promise<never>(() => undefined));
    const signalPid = vi.fn();
    try {
      const stopping = terminateProcessTree(root.child, {
        detachedProcessGroup: false,
        forceAfterMs: 10,
        forceSettleMs: 0,
        pollIntervalMs: 5,
        snapshotTimeoutMs: 25,
        operations: {
          captureSnapshot,
          pidIsAlive: (pid) => alive.has(pid),
          signalPid,
        } as never,
      });

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(25);
      await expect(stopping).resolves.toEqual({
        forced: false,
        remainingPids: [101, 100],
      });
      expect(root.kill).toHaveBeenCalledWith("SIGTERM");
      expect(root.kill).not.toHaveBeenCalledWith("SIGKILL");
      expect(signalPid).toHaveBeenCalledWith(101, "SIGTERM");
      expect(signalPid).not.toHaveBeenCalledWith(101, "SIGKILL");
    } finally {
      platform.mockRestore();
      vi.useRealTimers();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Bounded force escalation]]
  it("does not force a reused Windows root tree", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    const alive = new Set([100, 101]);
    const root = fakeChildProcess(100, alive);
    const captureSnapshot = vi
      .fn()
      .mockResolvedValueOnce([
        { pid: 100, parentPid: 1, identity: "windows:root-1" },
        { pid: 101, parentPid: 100, identity: "windows:child-1" },
      ])
      .mockResolvedValueOnce([
        { pid: 100, parentPid: 1, identity: "windows:root-2" },
        { pid: 101, parentPid: 100, identity: "windows:child-1" },
      ]);
    const gracefulWindowsTree = vi.fn();
    const forceWindowsTree = vi.fn();
    const signalPid = vi.fn();

    try {
      const result = await terminateProcessTree(root.child, {
        detachedProcessGroup: false,
        forceAfterMs: 0,
        forceSettleMs: 0,
        operations: {
          captureSnapshot,
          forceWindowsTree,
          gracefulWindowsTree,
          pidIsAlive: (pid) => alive.has(pid),
          signalPid,
        } as never,
      });

      expect(result.remainingPids).toContain(100);
      expect(gracefulWindowsTree).toHaveBeenCalledOnce();
      expect(forceWindowsTree).not.toHaveBeenCalled();
      expect(root.kill).not.toHaveBeenCalledWith("SIGKILL");
    } finally {
      platform.mockRestore();
    }
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
  it("does not force a PID whose identity changes before escalation", async () => {
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    vi.useFakeTimers();
    const alive = new Set([100, 101]);
    const root = fakeChildProcess(100, alive);
    const captureSnapshot = vi
      .fn()
      .mockResolvedValueOnce([
        { pid: 100, parentPid: 1, identity: "root@boot:42" },
        { pid: 101, parentPid: 100, identity: "child@boot:43" },
      ])
      .mockResolvedValueOnce([
        { pid: 100, parentPid: 1, identity: "root@boot:42" },
        { pid: 101, parentPid: 100, identity: "child@boot:44" },
      ]);
    const signalPid = vi.fn();

    try {
      const stopping = terminateProcessTree(root.child, {
        detachedProcessGroup: false,
        forceAfterMs: 10,
        forceSettleMs: 0,
        pollIntervalMs: 5,
        operations: {
          captureSnapshot,
          descendantProcesses: () => [],
          processIdentity: vi.fn(() => "legacy"),
          pidIsAlive: (pid) => alive.has(pid),
          signalPid,
        } as never,
      });
      await vi.advanceTimersByTimeAsync(10);
      await vi.runAllTimersAsync();
      const result = await stopping;

      expect(captureSnapshot).toHaveBeenCalledTimes(2);
      expect(signalPid).not.toHaveBeenCalledWith(101, "SIGKILL");
      expect(result.remainingPids).toContain(101);
    } finally {
      platform.mockRestore();
      vi.useRealTimers();
    }
  });

  it("parses invariant Windows process identities", () => {
    const parseWindowsSnapshot = (
      processTree as unknown as {
        parseWindowsSnapshot?: (raw: string) => Array<{
          pid: number;
          parentPid: number;
          identity: string;
        }> | null;
      }
    ).parseWindowsSnapshot;
    expect(parseWindowsSnapshot).toBeTypeOf("function");
    expect(
      parseWindowsSnapshot?.(
        JSON.stringify({
          ProcessId: 456,
          ParentProcessId: 123,
          CreationFileTimeUtc: "134146437120000000",
        }),
      ),
    ).toEqual([
      {
        pid: 456,
        parentPid: 123,
        identity: "windows:134146437120000000",
      },
    ]);
  });
});
