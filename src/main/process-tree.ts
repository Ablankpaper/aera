import { execFileSync, type ChildProcess } from "child_process";

export interface KillProcessTreeOptions {
  /** POSIX children must have been spawned with `detached: true` before their
   *  negative PID can safely identify a dedicated process group. */
  detachedProcessGroup?: boolean;
  forceAfterMs?: number;
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
