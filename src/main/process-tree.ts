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

export interface CapturedProcessIdentity {
  pid: number;
  identity: string;
}

export interface ProcessTreeTerminationResult {
  forced: boolean;
  remainingPids: number[];
}

export interface ProcessTreeTerminationOperations {
  descendantPids(rootPid: number): number[];
  descendantProcesses(rootPid: number): CapturedProcessIdentity[];
  processIdentity(pid: number): string | null;
  pidIsAlive(pid: number): boolean;
  signalPid(pid: number, signal: NodeJS.Signals): void;
  gracefulWindowsTree(rootPid: number): void;
  forceWindowsTree(rootPid: number): void;
  wait(delayMs: number): Promise<void>;
}

interface ProcessRecord extends CapturedProcessIdentity {
  parentPid: number;
}

function processRecords(): ProcessRecord[] {
  if (process.platform === "win32") {
    try {
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; " +
            "Get-CimInstance Win32_Process | " +
            "Select-Object ProcessId,ParentProcessId,CreationDate | " +
            "ConvertTo-Json -Compress",
        ],
        {
          encoding: "utf8",
          timeout: 1500,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const parsed: unknown = JSON.parse(output);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.flatMap((row): ProcessRecord[] => {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          return [];
        }
        const value = row as Record<string, unknown>;
        const pid = Number(value.ProcessId);
        const parentPid = Number(value.ParentProcessId);
        if (
          !Number.isSafeInteger(pid) ||
          pid <= 0 ||
          !Number.isSafeInteger(parentPid) ||
          parentPid < 0
        ) {
          return [];
        }
        const identity =
          typeof value.CreationDate === "string"
            ? value.CreationDate.trim()
            : "";
        return [{ pid, parentPid, identity }];
      });
    } catch {
      return [];
    }
  }

  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const records: ProcessRecord[] = [];
    for (const line of rows.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      records.push({
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        identity: match[3].trim(),
      });
    }
    return records;
  } catch {
    return [];
  }
}

function descendantProcesses(rootPid: number): CapturedProcessIdentity[] {
  const children = new Map<number, ProcessRecord[]>();
  for (const record of processRecords()) {
    const siblings = children.get(record.parentPid) ?? [];
    siblings.push(record);
    children.set(record.parentPid, siblings);
  }

  const result: CapturedProcessIdentity[] = [];
  const visit = (parentPid: number): void => {
    for (const child of children.get(parentPid) ?? []) {
      visit(child.pid);
      if (child.identity) result.push({ ...child });
    }
  };
  visit(rootPid);
  return result;
}

function descendantPids(rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const record of processRecords()) {
    const siblings = children.get(record.parentPid) ?? [];
    siblings.push(record.pid);
    children.set(record.parentPid, siblings);
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
}

function processIdentity(pid: number): string | null {
  return (
    processRecords().find((record) => record.pid === pid)?.identity || null
  );
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
  rootIdentity: string | null,
  descendants: readonly CapturedProcessIdentity[],
  operations: ProcessTreeTerminationOperations,
  verifyIdentity: boolean,
): number[] {
  const remaining = descendants
    .filter((captured) =>
      capturedProcessIsAlive(captured, operations, verifyIdentity),
    )
    .map(({ pid }) => pid);
  const rootAlive = childProcessIsAlive(proc, operations.pidIsAlive);
  const rootOwned =
    rootAlive &&
    (!verifyIdentity ||
      !rootIdentity ||
      operations.processIdentity(proc.pid!) === rootIdentity);
  if (rootOwned && proc.pid) {
    remaining.push(proc.pid);
  }
  return remaining;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function forceWindowsTree(rootPid: number): void {
  execFileSync("taskkill", ["/F", "/T", "/PID", String(rootPid)], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function gracefulWindowsTree(rootPid: number): void {
  execFileSync("taskkill", ["/T", "/PID", String(rootPid)], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function capturedProcessIsAlive(
  captured: CapturedProcessIdentity,
  operations: ProcessTreeTerminationOperations,
  verifyIdentity: boolean,
): boolean {
  if (!operations.pidIsAlive(captured.pid)) return false;
  if (!verifyIdentity) return true;
  return operations.processIdentity(captured.pid) === captured.identity;
}

function rootProcessIsOwnedAlive(
  proc: ChildProcess,
  rootIdentity: string | null,
  operations: ProcessTreeTerminationOperations,
): boolean {
  if (!childProcessIsAlive(proc, operations.pidIsAlive)) return false;
  return (
    !rootIdentity || operations.processIdentity(proc.pid!) === rootIdentity
  );
}

async function waitForOwnedTreeExit(
  proc: ChildProcess,
  rootIdentity: string | null,
  descendants: readonly CapturedProcessIdentity[],
  timeoutMs: number,
  pollIntervalMs: number,
  operations: ProcessTreeTerminationOperations,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = remainingOwnedPids(
    proc,
    rootIdentity,
    descendants,
    operations,
    true,
  );
  while (remaining.length > 0 && Date.now() < deadline) {
    await operations.wait(
      Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
    );
    remaining = remainingOwnedPids(
      proc,
      rootIdentity,
      descendants,
      operations,
      false,
    );
  }
  return remainingOwnedPids(proc, rootIdentity, descendants, operations, true);
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
    descendantProcesses,
    processIdentity,
    pidIsAlive,
    signalPid,
    gracefulWindowsTree,
    forceWindowsTree,
    wait,
    ...options.operations,
  };
  const customOperations = options.operations;
  const descendants = customOperations?.descendantProcesses
    ? customOperations.descendantProcesses(rootPid)
    : customOperations?.descendantPids
      ? customOperations.descendantPids(rootPid).map((pid) => ({
          pid,
          identity: operations.processIdentity(pid) ?? "",
        }))
      : operations.descendantProcesses(rootPid);
  const rootIdentity = operations.processIdentity(rootPid);
  const detachedProcessGroup = options.detachedProcessGroup ?? false;
  const forceAfterMs = Math.max(0, options.forceAfterMs ?? 3000);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 50);
  const forceSettleMs = Math.max(0, options.forceSettleMs ?? 500);

  const rootOwned = rootProcessIsOwnedAlive(proc, rootIdentity, operations);
  let windowsTreeSignalled = false;
  if (process.platform === "win32" && rootOwned) {
    try {
      operations.gracefulWindowsTree(rootPid);
      windowsTreeSignalled = true;
    } catch {
      // Fall through to exact captured PID signalling.
    }
  }
  if (!windowsTreeSignalled) {
    for (const child of descendants) {
      if (capturedProcessIsAlive(child, operations, true)) {
        operations.signalPid(child.pid, "SIGTERM");
      }
    }
  }
  if (rootOwned && !windowsTreeSignalled) {
    signalOwnedRoot(proc, "SIGTERM", detachedProcessGroup);
  }

  let remaining = await waitForOwnedTreeExit(
    proc,
    rootIdentity,
    descendants,
    forceAfterMs,
    pollIntervalMs,
    operations,
  );
  if (remaining.length === 0) {
    return { forced: false, remainingPids: [] };
  }

  const remainingSet = new Set(remaining);
  if (process.platform === "win32") {
    if (
      remainingSet.has(rootPid) &&
      rootProcessIsOwnedAlive(proc, rootIdentity, operations)
    ) {
      try {
        operations.forceWindowsTree(rootPid);
      } catch {
        if (rootProcessIsOwnedAlive(proc, rootIdentity, operations)) {
          signalOwnedRoot(proc, "SIGKILL", false);
        }
      }
    }
  }
  for (const child of descendants) {
    if (
      remainingSet.has(child.pid) &&
      capturedProcessIsAlive(child, operations, true)
    ) {
      operations.signalPid(child.pid, "SIGKILL");
    }
  }
  if (
    process.platform !== "win32" &&
    remainingSet.has(rootPid) &&
    rootProcessIsOwnedAlive(proc, rootIdentity, operations)
  ) {
    signalOwnedRoot(proc, "SIGKILL", detachedProcessGroup);
  }

  remaining = await waitForOwnedTreeExit(
    proc,
    rootIdentity,
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
