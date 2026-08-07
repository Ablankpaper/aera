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
        descendantPids: () => [101],
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
        descendantPids: () => [101],
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
});
