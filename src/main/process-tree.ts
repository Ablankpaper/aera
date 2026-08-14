import { execFile, execFileSync, type ChildProcess } from "node:child_process";

export interface KillProcessTreeOptions {
  /** POSIX children must have been spawned with `detached: true` before their
   *  negative PID can safely identify a dedicated process group. */
  detachedProcessGroup?: boolean;
  forceAfterMs?: number;
}

export interface TerminateProcessTreeOptions extends KillProcessTreeOptions {
  pollIntervalMs?: number;
  forceSettleMs?: number;
  snapshotTimeoutMs?: number;
  commandTimeoutMs?: number;
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

export interface ProcessSnapshotRecord extends CapturedProcessIdentity {
  parentPid: number;
}

export interface ProcessSnapshotRequest {
  rootPid: number;
  candidatePids?: readonly number[];
  timeoutMs: number;
}

export interface ProcessTreeTerminationOperations {
  captureSnapshot(
    request: ProcessSnapshotRequest,
  ): Promise<readonly ProcessSnapshotRecord[] | null>;
  /** Legacy deterministic seams retained for existing focused unit tests. */
  descendantPids(rootPid: number): number[];
  descendantProcesses(rootPid: number): CapturedProcessIdentity[];
  processIdentity(pid: number): string | null;
  pidIsAlive(pid: number): boolean;
  signalPid(pid: number, signal: NodeJS.Signals): void;
  gracefulWindowsTree(rootPid: number, timeoutMs: number): void | Promise<void>;
  forceWindowsTree(rootPid: number, timeoutMs: number): void | Promise<void>;
  processGroupIsAlive(processGroupId: number): boolean;
  processGroupPids(
    processGroupId: number,
    timeoutMs: number,
  ): Promise<readonly number[] | null>;
  signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void;
  wait(delayMs: number): Promise<void>;
}

type ProcessRecord = ProcessSnapshotRecord;

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

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 750;
const DEFAULT_COMMAND_TIMEOUT_MS = 750;
const MAX_PROCESS_SNAPSHOT_BYTES = 8 * 1024 * 1024;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  const boundedTimeout = Math.max(1, timeoutMs);
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, boundedTimeout);
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function execFileText(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        timeout: Math.max(1, timeoutMs),
        maxBuffer: MAX_PROCESS_SNAPSHOT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(typeof stdout === "string" ? stdout : String(stdout));
      },
    );
  });
}

function treePidsFromRows(
  rows: readonly { pid: number; parentPid: number }[],
  rootPid: number,
): number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = children.get(row.parentPid) ?? [];
    siblings.push(row.pid);
    children.set(row.parentPid, siblings);
  }
  const result: number[] = [];
  const visited = new Set<number>();
  const visit = (parentPid: number): void => {
    for (const childPid of children.get(parentPid) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      visit(childPid);
      result.push(childPid);
    }
  };
  visit(rootPid);
  return result;
}

function normalizeWindowsFileTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^\d{15,20}$/.test(normalized) ? normalized : null;
}

export function parseWindowsSnapshot(
  raw: string,
): ProcessSnapshotRecord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row): ProcessSnapshotRecord[] => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const value = row as Record<string, unknown>;
    const pid = Number(value.ProcessId);
    const parentPid = Number(value.ParentProcessId);
    const identity = normalizeWindowsFileTime(value.CreationFileTimeUtc);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0
    ) {
      return [];
    }
    return [
      {
        pid,
        parentPid,
        identity: identity === null ? "" : `windows:${identity}`,
      },
    ];
  });
}

export function buildWindowsSnapshotScript(
  request: ProcessSnapshotRequest,
): string | null {
  if (!Number.isSafeInteger(request.rootPid) || request.rootPid <= 0) {
    return null;
  }
  const projection =
    "Select-Object ProcessId,ParentProcessId," +
    "@{Name='CreationFileTimeUtc';Expression={" +
    "$_.CreationDate.ToFileTimeUtc().ToString(" +
    "[Globalization.CultureInfo]::InvariantCulture)}}";
  const serialize =
    "if ($rows.Count -eq 0) { Write-Output '[]' } else { " +
    `$rows | ${projection} | ConvertTo-Json -Compress }`;

  if (request.candidatePids) {
    const candidates = [...new Set(request.candidatePids)].sort(
      (left, right) => left - right,
    );
    if (
      candidates.some(
        (candidate) => !Number.isSafeInteger(candidate) || candidate <= 0,
      )
    ) {
      return null;
    }
    if (candidates.length === 0) return "Write-Output '[]'";
    const filter = candidates
      .map((candidate) => `ProcessId = ${candidate}`)
      .join(" OR ");
    return (
      "$ErrorActionPreference='Stop'; " +
      "$rows = @(Get-CimInstance Win32_Process " +
      `-Filter '${filter}' ` +
      "-Property ProcessId,ParentProcessId,CreationDate); " +
      serialize
    );
  }

  return (
    "$ErrorActionPreference='Stop'; " +
    "$rows = [Collections.Generic.List[object]]::new(); " +
    "$seen = [Collections.Generic.HashSet[uint32]]::new(); " +
    "$queue = [Collections.Generic.Queue[uint32]]::new(); " +
    `$queue.Enqueue([uint32]${request.rootPid}); ` +
    "while ($queue.Count -gt 0) { " +
    "$currentProcessId = $queue.Dequeue(); " +
    "$filter = ('ProcessId = {0} OR ParentProcessId = {0}' -f $currentProcessId); " +
    "foreach ($process in @(Get-CimInstance Win32_Process " +
    "-Filter $filter -Property ProcessId,ParentProcessId,CreationDate)) { " +
    "$processId = [uint32]$process.ProcessId; " +
    "if ($seen.Add($processId)) { " +
    "$rows.Add($process); " +
    "if ([uint32]$process.ParentProcessId -eq $currentProcessId) { " +
    "$queue.Enqueue($processId) } } } }; " +
    serialize
  );
}

async function captureWindowsSnapshot(
  request: ProcessSnapshotRequest,
): Promise<readonly ProcessSnapshotRecord[] | null> {
  const script = buildWindowsSnapshotScript(request);
  if (script === null) return null;
  const output = await execFileText(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    request.timeoutMs,
  );
  if (output === null) return null;
  const records = parseWindowsSnapshot(output);
  if (records === null) return null;
  if (!request.candidatePids) return records;
  const candidates = new Set(request.candidatePids);
  return records.filter((record) => candidates.has(record.pid));
}

export async function captureProcessSnapshot(
  request: ProcessSnapshotRequest,
): Promise<readonly ProcessSnapshotRecord[] | null> {
  if (process.platform === "win32") return captureWindowsSnapshot(request);
  return null;
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

function processGroupIsAlive(processGroupId: number): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)
    return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    throw new Error("Invalid Desktop-owned process group");
  }
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function processGroupPids(
  processGroupId: number,
  timeoutMs: number,
): Promise<readonly number[] | null> {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) return null;
  const command = process.platform === "darwin" ? "/bin/ps" : "ps";
  const output = await execFileText(command, ["-axo", "pid=,pgid="], timeoutMs);
  if (output === null) return null;
  const pids: number[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const processGroup = Number(match[2]);
    if (
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      processGroup === processGroupId
    ) {
      pids.push(pid);
    }
  }
  return [...new Set(pids)].sort((left, right) => left - right);
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

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function forceWindowsTree(
  rootPid: number,
  timeoutMs: number,
): Promise<void> {
  const output = await execFileText(
    "taskkill",
    ["/F", "/T", "/PID", String(rootPid)],
    timeoutMs,
  );
  if (output === null) throw new Error("taskkill force timed out or failed");
}

async function gracefulWindowsTree(
  rootPid: number,
  timeoutMs: number,
): Promise<void> {
  const output = await execFileText(
    "taskkill",
    ["/T", "/PID", String(rootPid)],
    timeoutMs,
  );
  if (output === null) {
    throw new Error("taskkill graceful stop timed out or failed");
  }
}

interface CapturedProcessTree {
  root: ProcessSnapshotRecord;
  descendants: CapturedProcessIdentity[];
}

function buildCapturedProcessTree(
  snapshot: readonly ProcessSnapshotRecord[],
  rootPid: number,
): CapturedProcessTree | null {
  const root = snapshot.find(
    (record) => record.pid === rootPid && record.identity.trim().length > 0,
  );
  if (!root) return null;

  const children = new Map<number, ProcessSnapshotRecord[]>();
  for (const record of snapshot) {
    const siblings = children.get(record.parentPid) ?? [];
    siblings.push(record);
    children.set(record.parentPid, siblings);
  }
  const descendants: CapturedProcessIdentity[] = [];
  let unknownDescendant = false;
  const visited = new Set<number>([rootPid]);
  const visit = (parentPid: number): void => {
    for (const child of children.get(parentPid) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      visit(child.pid);
      if (!child.identity.trim()) {
        unknownDescendant = true;
        continue;
      }
      descendants.push({ pid: child.pid, identity: child.identity });
    }
  };
  visit(rootPid);
  if (unknownDescendant) return null;
  return { root, descendants };
}

function legacySnapshot(
  request: ProcessSnapshotRequest,
  operations: ProcessTreeTerminationOperations,
  customOperations: Partial<ProcessTreeTerminationOperations>,
): readonly ProcessSnapshotRecord[] | null {
  const rootIdentity = operations.processIdentity(request.rootPid);
  if (!rootIdentity) return null;
  const capturedByPid = new Map(
    (customOperations.descendantProcesses?.(request.rootPid) ?? []).map(
      (record) => [record.pid, record.identity] as const,
    ),
  );
  const descendantPids = request.candidatePids
    ? [...new Set(request.candidatePids)].filter(
        (pid) => pid !== request.rootPid,
      )
    : customOperations.descendantPids
      ? customOperations.descendantPids(request.rootPid)
      : [...capturedByPid.keys()];
  const records: ProcessSnapshotRecord[] = [
    { pid: request.rootPid, parentPid: 0, identity: rootIdentity },
  ];
  for (const pid of descendantPids) {
    const identity = operations.processIdentity(pid) ?? capturedByPid.get(pid);
    if (identity) records.push({ pid, parentPid: request.rootPid, identity });
  }
  return records;
}

async function captureForPhase(
  request: ProcessSnapshotRequest,
  operations: ProcessTreeTerminationOperations,
  customOperations: Partial<ProcessTreeTerminationOperations> | undefined,
): Promise<readonly ProcessSnapshotRecord[] | null> {
  if (customOperations?.captureSnapshot) {
    return withTimeout(
      customOperations.captureSnapshot(request),
      request.timeoutMs,
    );
  }
  if (
    customOperations?.descendantProcesses ||
    customOperations?.descendantPids ||
    customOperations?.processIdentity
  ) {
    return legacySnapshot(request, operations, customOperations);
  }
  return operations.captureSnapshot(request);
}

function capturedPidsAlive(
  proc: ChildProcess,
  descendants: readonly CapturedProcessIdentity[],
  operations: ProcessTreeTerminationOperations,
): number[] {
  const remaining = descendants
    .filter((captured) => operations.pidIsAlive(captured.pid))
    .map(({ pid }) => pid);
  if (childProcessIsAlive(proc, operations.pidIsAlive) && proc.pid) {
    remaining.push(proc.pid);
  }
  return [...new Set(remaining)];
}

async function waitForCapturedTreeExit(
  proc: ChildProcess,
  descendants: readonly CapturedProcessIdentity[],
  timeoutMs: number,
  pollIntervalMs: number,
  operations: ProcessTreeTerminationOperations,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = capturedPidsAlive(proc, descendants, operations);
  while (remaining.length > 0 && Date.now() < deadline) {
    await operations.wait(
      Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
    );
    remaining = capturedPidsAlive(proc, descendants, operations);
  }
  return capturedPidsAlive(proc, descendants, operations);
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
  pollIntervalMs: number,
  operations: ProcessTreeTerminationOperations,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let alive = operations.processGroupIsAlive(processGroupId);
  while (alive && Date.now() < deadline) {
    await operations.wait(
      Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
    );
    alive = operations.processGroupIsAlive(processGroupId);
  }
  return operations.processGroupIsAlive(processGroupId);
}

async function terminateDedicatedProcessGroup(
  proc: ChildProcess,
  processGroupId: number,
  forceAfterMs: number,
  forceSettleMs: number,
  pollIntervalMs: number,
  commandTimeoutMs: number,
  operations: ProcessTreeTerminationOperations,
): Promise<ProcessTreeTerminationResult> {
  if (!operations.processGroupIsAlive(processGroupId)) {
    if (childProcessIsAlive(proc, operations.pidIsAlive)) {
      throw new Error(
        `Desktop-owned process group ${processGroupId} is unavailable while its child is still alive`,
      );
    }
    return { forced: false, remainingPids: [] };
  }
  const initialPids = await operations.processGroupPids(
    processGroupId,
    commandTimeoutMs,
  );
  if (initialPids === null) {
    throw new Error(
      `Desktop-owned process group ${processGroupId} could not be verified`,
    );
  }
  if (initialPids.length === 0) {
    if (
      !operations.processGroupIsAlive(processGroupId) &&
      !childProcessIsAlive(proc, operations.pidIsAlive)
    ) {
      return { forced: false, remainingPids: [] };
    }
    throw new Error(
      `Desktop-owned process group ${processGroupId} could not be verified`,
    );
  }
  if (
    childProcessIsAlive(proc, operations.pidIsAlive) &&
    !initialPids.includes(processGroupId)
  ) {
    throw new Error(
      `Desktop-owned child ${processGroupId} is not in its dedicated process group`,
    );
  }

  operations.signalProcessGroup(processGroupId, "SIGTERM");
  let alive = await waitForProcessGroupExit(
    processGroupId,
    forceAfterMs,
    pollIntervalMs,
    operations,
  );
  if (!alive) return { forced: false, remainingPids: [] };

  operations.signalProcessGroup(processGroupId, "SIGKILL");
  alive = await waitForProcessGroupExit(
    processGroupId,
    forceSettleMs,
    pollIntervalMs,
    operations,
  );
  if (!alive) return { forced: true, remainingPids: [] };

  const remainingPids = await operations.processGroupPids(
    processGroupId,
    commandTimeoutMs,
  );
  if (remainingPids === null) {
    throw new Error(
      `Desktop-owned process group ${processGroupId} exit could not be verified`,
    );
  }
  if (remainingPids.length === 0) {
    if (
      !operations.processGroupIsAlive(processGroupId) &&
      !childProcessIsAlive(proc, operations.pidIsAlive)
    ) {
      return { forced: true, remainingPids: [] };
    }
    throw new Error(
      `Desktop-owned process group ${processGroupId} exit could not be verified`,
    );
  }
  return { forced: true, remainingPids: [...remainingPids] };
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
    captureSnapshot: captureProcessSnapshot,
    descendantPids,
    descendantProcesses,
    processIdentity,
    pidIsAlive,
    signalPid,
    gracefulWindowsTree,
    forceWindowsTree,
    processGroupIsAlive,
    processGroupPids,
    signalProcessGroup,
    wait,
    ...options.operations,
  };
  const customOperations = options.operations;
  const detachedProcessGroup = options.detachedProcessGroup ?? false;
  const forceAfterMs = Math.max(0, options.forceAfterMs ?? 3000);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 50);
  const forceSettleMs = Math.max(
    0,
    options.forceSettleMs ?? (process.platform === "win32" ? 3_000 : 500),
  );
  const snapshotTimeoutMs = Math.max(
    1,
    options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS,
  );
  const commandTimeoutMs = Math.max(
    1,
    options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  );

  if (detachedProcessGroup && process.platform !== "win32") {
    return terminateDedicatedProcessGroup(
      proc,
      rootPid,
      forceAfterMs,
      forceSettleMs,
      pollIntervalMs,
      commandTimeoutMs,
      operations,
    );
  }

  let initialSnapshot = await captureForPhase(
    {
      rootPid,
      timeoutMs: snapshotTimeoutMs,
    },
    operations,
    customOperations,
  );
  if (initialSnapshot === null && process.platform === "win32") {
    initialSnapshot = await captureForPhase(
      {
        rootPid,
        timeoutMs: snapshotTimeoutMs,
      },
      operations,
      customOperations,
    );
  }
  const capturedTree = initialSnapshot
    ? buildCapturedProcessTree(initialSnapshot, rootPid)
    : null;
  if (!capturedTree) {
    const reachablePids = initialSnapshot
      ? [...treePidsFromRows(initialSnapshot, rootPid), rootPid]
      : [rootPid];
    return {
      forced: false,
      remainingPids: [...new Set(reachablePids)].filter((pid) =>
        pid === rootPid
          ? childProcessIsAlive(proc, operations.pidIsAlive)
          : operations.pidIsAlive(pid),
      ),
    };
  }

  const { root, descendants } = capturedTree;
  const rootAlive = childProcessIsAlive(proc, operations.pidIsAlive);

  let windowsTreeSignalled = false;
  if (process.platform === "win32" && rootAlive) {
    try {
      await operations.gracefulWindowsTree(rootPid, commandTimeoutMs);
      windowsTreeSignalled = true;
    } catch {
      // Fall through to exact captured PID signalling.
    }
  }
  if (!windowsTreeSignalled) {
    for (const child of descendants) {
      if (operations.pidIsAlive(child.pid)) {
        operations.signalPid(child.pid, "SIGTERM");
      }
    }
  }
  if (rootAlive && !windowsTreeSignalled) {
    signalOwnedRoot(proc, "SIGTERM", detachedProcessGroup);
  }

  let remaining = await waitForCapturedTreeExit(
    proc,
    descendants,
    forceAfterMs,
    pollIntervalMs,
    operations,
  );
  if (remaining.length === 0) {
    return { forced: false, remainingPids: [] };
  }

  const refreshSnapshot = await captureForPhase(
    {
      rootPid,
      candidatePids: remaining,
      timeoutMs: snapshotTimeoutMs,
    },
    operations,
    customOperations,
  );
  if (!refreshSnapshot) {
    return { forced: false, remainingPids: remaining };
  }
  const refreshedByPid = new Map(
    refreshSnapshot.map((record) => [record.pid, record.identity]),
  );
  const capturedByPid = new Map([
    [root.pid, root.identity] as const,
    ...descendants.map((record) => [record.pid, record.identity] as const),
  ]);
  const verifiedRemaining = remaining.filter(
    (pid) => refreshedByPid.get(pid) === capturedByPid.get(pid),
  );
  const verifiedSet = new Set(verifiedRemaining);
  let forced = false;
  const forcedPids = new Set<number>();
  const remainingSet = new Set(remaining);
  if (process.platform === "win32") {
    if (
      remainingSet.has(rootPid) &&
      verifiedSet.has(rootPid) &&
      childProcessIsAlive(proc, operations.pidIsAlive)
    ) {
      try {
        await operations.forceWindowsTree(rootPid, commandTimeoutMs);
        forced = true;
        for (const pid of verifiedRemaining) forcedPids.add(pid);
      } catch {
        if (
          verifiedSet.has(rootPid) &&
          childProcessIsAlive(proc, operations.pidIsAlive)
        ) {
          signalOwnedRoot(proc, "SIGKILL", false);
          forced = true;
          forcedPids.add(rootPid);
        }
      }
    }
  }
  for (const child of descendants) {
    if (
      remainingSet.has(child.pid) &&
      verifiedSet.has(child.pid) &&
      operations.pidIsAlive(child.pid)
    ) {
      operations.signalPid(child.pid, "SIGKILL");
      forced = true;
      forcedPids.add(child.pid);
    }
  }
  if (
    process.platform !== "win32" &&
    remainingSet.has(rootPid) &&
    verifiedSet.has(rootPid) &&
    childProcessIsAlive(proc, operations.pidIsAlive)
  ) {
    signalOwnedRoot(proc, "SIGKILL", detachedProcessGroup);
    forced = true;
    forcedPids.add(rootPid);
  }

  remaining = await waitForCapturedTreeExit(
    proc,
    descendants,
    forceSettleMs,
    pollIntervalMs,
    operations,
  );
  if (!forced || remaining.length === 0) {
    return { forced, remainingPids: remaining };
  }

  const finalSnapshot = await captureForPhase(
    {
      rootPid,
      candidatePids: remaining,
      timeoutMs: snapshotTimeoutMs,
    },
    operations,
    customOperations,
  );
  if (!finalSnapshot) return { forced, remainingPids: remaining };
  const finalByPid = new Map(
    finalSnapshot.map((record) => [record.pid, record.identity]),
  );
  remaining = remaining.filter((pid) => {
    if (!forcedPids.has(pid)) return true;
    const finalIdentity = finalByPid.get(pid);
    return !finalIdentity || finalIdentity === capturedByPid.get(pid);
  });
  return { forced, remainingPids: remaining };
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
