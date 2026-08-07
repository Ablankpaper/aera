import { execFileSync, type ChildProcess } from "node:child_process";

export interface KillProcessTreeOptions {
  /** POSIX children must have been spawned with `detached: true` before their
   *  negative PID can safely identify a dedicated process group. */
  detachedProcessGroup?: boolean;
  forceAfterMs?: number;
}

export interface TerminateProcessTreeOptions extends KillProcessTreeOptions {
  pollIntervalMs?: number;
  forceSettleMs?: number;
  /** Deterministic process seams used by focused lifecycle tests. */
  operations?: Partial<ProcessTreeTerminationOperations>;
}

export interface ProcessTreeTerminationResult {
  forced: boolean;
  remainingPids: number[];
}

export interface ProcessTreeTerminationOperations {
  descendantPids(rootPid: number): number[];
  pidIsAlive(pid: number): boolean;
  signalPid(pid: number, signal: NodeJS.Signals): void;
  wait(delayMs: number): Promise<void>;
}

function descendantPids(rootPid: number): number[] {
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const children = new Map<number, number[]>();
    for (const line of rows.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const siblings = children.get(parentPid) ?? [];
      siblings.push(pid);
      children.set(parentPid, siblings);
    }

    const result: number[] = [];
    const visit = (parentPid: number): void => {
      for (const childPid of children.get(parentPid) ?? []) {
        visit(childPid);
        result.push(childPid);
      }
    };
    visit(rootPid);
    return result;
  } catch {
    return [];
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already dead.
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function childProcessIsAlive(
  proc: ChildProcess,
  isPidAlive: (pid: number) => boolean,
): boolean {
  return (
    typeof proc.pid === "number" &&
    proc.exitCode === null &&
    proc.signalCode === null &&
    isPidAlive(proc.pid)
  );
}

function remainingOwnedPids(
  proc: ChildProcess,
  descendants: readonly number[],
  isPidAlive: (pid: number) => boolean,
): number[] {
  const remaining = descendants.filter(isPidAlive);
  if (childProcessIsAlive(proc, isPidAlive) && proc.pid) {
    remaining.push(proc.pid);
  }
  return remaining;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForOwnedTreeExit(
  proc: ChildProcess,
  descendants: readonly number[],
  timeoutMs: number,
  pollIntervalMs: number,
  operations: ProcessTreeTerminationOperations,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = remainingOwnedPids(proc, descendants, operations.pidIsAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await operations.wait(
      Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
    );
    remaining = remainingOwnedPids(proc, descendants, operations.pidIsAlive);
  }
  return remaining;
}

function signalOwnedRoot(
  proc: ChildProcess,
  signal: NodeJS.Signals,
  detachedProcessGroup: boolean,
): void {
  if (!proc.pid) return;
  try {
    if (detachedProcessGroup) {
      process.kill(-proc.pid, signal);
    } else {
      proc.kill(signal);
    }
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // Already dead.
    }
  }
}

/**
 * Gracefully terminate one exact Desktop-owned child tree, then force only
 * the still-live PIDs captured from that root. Callers must opt in explicitly
 * before a POSIX process group can be signalled.
 */
export async function terminateProcessTree(
  proc: ChildProcess,
  options: TerminateProcessTreeOptions = {},
): Promise<ProcessTreeTerminationResult> {
  if (!proc.pid) return { forced: false, remainingPids: [] };

  const rootPid = proc.pid;
  const operations: ProcessTreeTerminationOperations = {
    descendantPids,
    pidIsAlive,
    signalPid,
    wait,
    ...options.operations,
  };
  const descendants = operations.descendantPids(rootPid);
  const detachedProcessGroup = options.detachedProcessGroup ?? false;
  const forceAfterMs = Math.max(0, options.forceAfterMs ?? 3000);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 50);
  const forceSettleMs = Math.max(0, options.forceSettleMs ?? 500);

  for (const childPid of descendants) {
    operations.signalPid(childPid, "SIGTERM");
  }
  signalOwnedRoot(proc, "SIGTERM", detachedProcessGroup);

  let remaining = await waitForOwnedTreeExit(
    proc,
    descendants,
    forceAfterMs,
    pollIntervalMs,
    operations,
  );
  if (remaining.length === 0) {
    return { forced: false, remainingPids: [] };
  }

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(rootPid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      signalOwnedRoot(proc, "SIGKILL", false);
    }
  } else {
    const remainingSet = new Set(remaining);
    for (const childPid of descendants) {
      if (remainingSet.has(childPid)) {
        operations.signalPid(childPid, "SIGKILL");
      }
    }
    if (remainingSet.has(rootPid)) {
      signalOwnedRoot(proc, "SIGKILL", detachedProcessGroup);
    }
  }

  remaining = await waitForOwnedTreeExit(
    proc,
    descendants,
    forceSettleMs,
    pollIntervalMs,
    operations,
  );
  return { forced: true, remainingPids: remaining };
}

/**
 * Terminate one managed child and all subprocesses it launched.
 *
 * Windows has no POSIX process groups, so taskkill /T is the canonical tree
 * operation. On POSIX, managed long-lived children are spawned in a detached
 * process group; SIGTERM gives them a brief cleanup window and SIGKILL prevents
 * a stuck server or worker from surviving the desktop.
 */
export function killProcessTree(
  proc: ChildProcess,
  options: KillProcessTreeOptions = {},
): void {
  if (!proc.pid) return;

  const pid = proc.pid;
  const detachedProcessGroup = options.detachedProcessGroup ?? true;
  const forceAfterMs = options.forceAfterMs ?? 3000;

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (err) {
      console.error(`[killProcessTree] taskkill failed for PID ${pid}:`, err);
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already dead.
      }
    }
    return;
  }

  // Some Runtime workers create their own process group. Capture the complete
  // parent/child tree before signalling the dashboard, otherwise those workers
  // are re-parented to PID 1 and escape a later group-only kill.
  const descendants = descendantPids(pid);
  for (const childPid of descendants) signalPid(childPid, "SIGTERM");

  try {
    if (detachedProcessGroup) {
      process.kill(-pid, "SIGTERM");
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already dead.
    }
  }

  const forceKill = (): void => {
    for (const childPid of descendants) signalPid(childPid, "SIGKILL");
    try {
      if (detachedProcessGroup) {
        process.kill(-pid, "SIGKILL");
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead.
      }
    }
  };

  if (forceAfterMs <= 0) {
    forceKill();
    return;
  }
  setTimeout(forceKill, forceAfterMs);
}
