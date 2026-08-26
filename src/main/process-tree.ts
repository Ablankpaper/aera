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
  /** Total budget shared by the bounded Windows initial-snapshot attempts. */
  snapshotTotalBudgetMs?: number;
  commandTimeoutMs?: number;
  /** Stable, non-secret Profile label included in Windows diagnostics. */
  diagnosticProfileKey?: string;
  /**
   * Optional caller-owned proof checked immediately before a signal can target
   * the root/tree. Gateway lifecycle callers use this to re-read both the
   * persisted creation identity and canonical executable image; a false or
   * throwing verifier is fail-closed and leaves the live tree untouched.
   */
  verifyRootOwnership?: (rootPid: number) => boolean;
  /** Deterministic diagnostic seam used by focused lifecycle tests. */
  onDiagnostic?: (diagnostic: ProcessTreeTerminationDiagnostic) => void;
  /** Deterministic process seams used by focused lifecycle tests. */
  operations?: Partial<ProcessTreeTerminationOperations>;
}

export interface CapturedProcessIdentity {
  pid: number;
  identity: string;
}

/**
 * Opaque ownership for a bounded cleanup retry.  The value is deliberately
 * backed by a WeakMap below rather than exposing a PID list to callers: a
 * retry must revalidate the original process creation identities before it
 * can signal anything.
 */
export interface ProcessTreeRetryOwnership {
  readonly __aeraProcessTreeRetryOwnership: unique symbol;
}

export interface ProcessTreeTerminationResult {
  forced: boolean;
  remainingPids: number[];
  /** Present only when an exact, identity-bound retry is possible. */
  retryOwnership?: ProcessTreeRetryOwnership;
}

export interface ProcessSnapshotRecord extends CapturedProcessIdentity {
  parentPid: number;
}

export interface ProcessSnapshotRequest {
  rootPid: number;
  candidatePids?: readonly number[];
  /** A targeted retry may legitimately observe that every candidate exited. */
  allowEmpty?: boolean;
  timeoutMs: number;
  phase?: ProcessTreeDiagnosticPhase;
  attempt?: number;
  strategy?: WindowsSnapshotStrategy;
  profileKey?: string;
  onDiagnostic?: (diagnostic: ProcessTreeTerminationDiagnostic) => void;
}

export type ProcessTreeDiagnosticPhase =
  | "initial-snapshot"
  | "identity-refresh"
  | "final-snapshot"
  | "graceful-taskkill"
  | "force-taskkill";

export type ProcessTreeDiagnosticOutcome =
  | "captured"
  | "success"
  | "timeout"
  | "error"
  | "invalid"
  | "failed";

export interface ProcessTreeTerminationDiagnostic {
  phase: ProcessTreeDiagnosticPhase;
  attempt: number;
  elapsedMs: number;
  outcome: ProcessTreeDiagnosticOutcome;
  profileKey: string;
  rootPid: number;
}

type WindowsSnapshotStrategy = "cim" | "wmi";

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

/**
 * Parse the bounded Windows process-table payload used by the legacy
 * descendant adapter. Keep the creation token in the same canonical form as
 * `parseWindowsSnapshot()` (`windows:<FILETIME>`); otherwise a real Windows
 * fallback compares a raw WMI DateTime string with a FILETIME snapshot and
 * incorrectly refuses every descendant signal.
 */
export function parseWindowsProcessRecords(raw: string): ProcessRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row): ProcessRecord[] => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const value = row as Record<string, unknown>;
    const processId = Number(value.ProcessId);
    const parentPid = Number(value.ParentProcessId);
    if (
      !Number.isSafeInteger(processId) ||
      processId <= 0 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0
    ) {
      return [];
    }
    const creationFileTime = normalizeWindowsFileTime(
      value.CreationFileTimeUtc,
    );
    return [
      {
        pid: processId,
        parentPid,
        identity:
          creationFileTime === null ? "" : `windows:${creationFileTime}`,
      },
    ];
  });
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
            "Select-Object ProcessId,ParentProcessId," +
            "@{Name='CreationFileTimeUtc';Expression={" +
            "$_.CreationDate.ToFileTimeUtc().ToString(" +
            "[Globalization.CultureInfo]::InvariantCulture)}} | " +
            "ConvertTo-Json -Compress",
        ],
        {
          encoding: "utf8",
          timeout: 1500,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      return parseWindowsProcessRecords(String(output));
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
// CIM is normally fast, but its first provider activation can consume the
// whole timeout on a loaded hosted Windows runner. Reserve most of the shared
// deadline for the explicit WMI fallback instead of letting CIM starve it.
const WINDOWS_PRIMARY_SNAPSHOT_BUDGET_NUMERATOR = 1;
const WINDOWS_PRIMARY_SNAPSHOT_BUDGET_DENOMINATOR = 3;

function sanitizeDiagnosticProfileKey(value: string | undefined): string {
  const normalized = (value ?? "unknown")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 64);
  return normalized || "unknown";
}

function emitDiagnostic(
  request: Pick<
    ProcessSnapshotRequest,
    "rootPid" | "phase" | "attempt" | "profileKey" | "onDiagnostic"
  >,
  elapsedMs: number,
  outcome: ProcessTreeDiagnosticOutcome,
): void {
  if (!request.phase) return;
  const diagnostic: ProcessTreeTerminationDiagnostic = {
    phase: request.phase,
    attempt: Math.max(1, request.attempt ?? 1),
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    outcome,
    profileKey: sanitizeDiagnosticProfileKey(request.profileKey),
    rootPid: request.rootPid,
  };
  const serialized = JSON.stringify(diagnostic);
  try {
    request.onDiagnostic?.({ ...diagnostic });
  } catch {
    // Diagnostics must never change the fail-closed process lifecycle.
  }
  if (process.env.AERA_PROCESS_TREE_DIAGNOSTICS === "1") {
    console.error(`[AERA_PROCESS_TREE_DIAGNOSTIC] ${serialized}`);
  }
}

function emitWindowsTerminationDiagnostic(
  request: Pick<
    ProcessSnapshotRequest,
    "rootPid" | "phase" | "attempt" | "profileKey" | "onDiagnostic"
  >,
  elapsedMs: number,
  outcome: ProcessTreeDiagnosticOutcome,
): void {
  if (process.platform !== "win32") return;
  emitDiagnostic(request, elapsedMs, outcome);
}

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

interface ExecFileTextResult {
  output: string | null;
  outcome: "success" | "timeout" | "error";
}

function execFileTextDetailed(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ExecFileTextResult> {
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
          const details = error as NodeJS.ErrnoException & { killed?: boolean };
          resolve({
            output: null,
            outcome:
              details.killed === true || details.code === "ETIMEDOUT"
                ? "timeout"
                : "error",
          });
          return;
        }
        resolve({
          output: typeof stdout === "string" ? stdout : String(stdout),
          outcome: "success",
        });
      },
    );
  });
}

function execFileText(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  return execFileTextDetailed(command, args, timeoutMs).then(
    ({ output }) => output,
  );
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
  if (
    parsed === null ||
    (typeof parsed !== "object" && !Array.isArray(parsed))
  ) {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const records: ProcessSnapshotRecord[] = [];
  const seenPids = new Set<number>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
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
      return null;
    }
    if (seenPids.has(pid)) return null;
    seenPids.add(pid);
    records.push({
      pid,
      parentPid,
      identity: identity === null ? "" : `windows:${identity}`,
    });
  }
  return records;
}

export function buildWindowsSnapshotScript(
  request: ProcessSnapshotRequest,
): string | null {
  if (!Number.isSafeInteger(request.rootPid) || request.rootPid <= 0) {
    return null;
  }
  const strategy: WindowsSnapshotStrategy = request.strategy ?? "cim";
  const processQuery =
    strategy === "wmi"
      ? "Get-WmiObject -Class Win32_Process"
      : "Get-CimInstance Win32_Process";
  const projection =
    "Select-Object ProcessId,ParentProcessId," +
    "@{Name='CreationFileTimeUtc';Expression={" +
    (strategy === "wmi"
      ? "[System.Management.ManagementDateTimeConverter]::ToDateTime([string]$_.CreationDate).ToUniversalTime().ToFileTimeUtc().ToString("
      : "$_.CreationDate.ToFileTimeUtc().ToString(") +
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
      `$rows = @(${processQuery} ` +
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
    `foreach ($process in @(${processQuery} ` +
    "-Filter $filter -Property ProcessId,ParentProcessId,CreationDate)) { " +
    "$processId = [uint32]$process.ProcessId; " +
    "if ($seen.Add($processId)) { " +
    "$rows.Add($process); " +
    "if ([uint32]$process.ParentProcessId -eq $currentProcessId) { " +
    "$queue.Enqueue($processId) } } } }; " +
    serialize
  );
}

export async function captureWindowsSnapshot(
  request: ProcessSnapshotRequest,
): Promise<readonly ProcessSnapshotRecord[] | null> {
  const startedAt = Date.now();
  const script = buildWindowsSnapshotScript(request);
  if (script === null) {
    emitDiagnostic(request, Date.now() - startedAt, "invalid");
    return null;
  }
  const command = await execFileTextDetailed(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    request.timeoutMs,
  );
  if (command.output === null) {
    emitDiagnostic(request, Date.now() - startedAt, command.outcome);
    return null;
  }
  const records = parseWindowsSnapshot(command.output);
  if (records === null) {
    emitDiagnostic(request, Date.now() - startedAt, "invalid");
    return null;
  }
  const candidates = request.candidatePids
    ? new Set(request.candidatePids)
    : null;
  const result = candidates
    ? records.filter((record) => candidates.has(record.pid))
    : records;
  if (result.length === 0) {
    if (request.allowEmpty && request.candidatePids) {
      emitDiagnostic(request, Date.now() - startedAt, "captured");
      return [];
    }
    emitDiagnostic(request, Date.now() - startedAt, "invalid");
    return null;
  }
  if (result.some((record) => !record.identity.trim())) {
    emitDiagnostic(request, Date.now() - startedAt, "invalid");
    return null;
  }
  emitDiagnostic(request, Date.now() - startedAt, "captured");
  return result;
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

function rootOwnershipVerified(
  rootPid: number,
  verify: TerminateProcessTreeOptions["verifyRootOwnership"],
): boolean {
  if (!verify) return true;
  try {
    return verify(rootPid) === true;
  } catch {
    return false;
  }
}

/**
 * A Windows tree snapshot is only a point-in-time list.  Before falling back
 * from taskkill to per-PID signalling, re-read each captured descendant's
 * creation identity at the signal boundary.  A PID that was reused after the
 * initial snapshot must be left untouched.  Deterministic callers that supply
 * a custom snapshot seam but no identity seam retain the historical generic
 * tree behavior; Gateway callers use the real/default identity reader (or an
 * explicit deterministic seam) and therefore take this fail-closed branch.
 */
function descendantIdentityVerified(
  captured: CapturedProcessIdentity,
  operations: ProcessTreeTerminationOperations,
  _customOperations: Partial<ProcessTreeTerminationOperations> | undefined,
): boolean {
  if (process.platform !== "win32") return true;
  try {
    const observed = operations.processIdentity(captured.pid);
    return (
      typeof observed === "string" &&
      observed.trim().length > 0 &&
      observed.trim() === captured.identity.trim()
    );
  } catch {
    return false;
  }
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

interface RetryOwnershipRecord {
  rootPid: number;
  processes: readonly CapturedProcessIdentity[];
}

const retryOwnershipRecords = new WeakMap<object, RetryOwnershipRecord>();

function createRetryOwnership(
  tree: CapturedProcessTree,
): ProcessTreeRetryOwnership {
  // A null-prototype frozen object is not useful as a PID-shaped target and
  // cannot be manufactured into a valid handle without access to the
  // WeakMap.  Keep the actual identities private to this module.
  const handle = Object.freeze(Object.create(null)) as object;
  retryOwnershipRecords.set(handle, {
    rootPid: tree.root.pid,
    processes: Object.freeze([
      { pid: tree.root.pid, identity: tree.root.identity },
      ...tree.descendants.map((process) => ({ ...process })),
    ]),
  });
  return handle as ProcessTreeRetryOwnership;
}

function attachRetryOwnership(
  forced: boolean,
  remainingPids: readonly number[],
  tree: CapturedProcessTree,
  existing?: ProcessTreeRetryOwnership,
): ProcessTreeTerminationResult {
  const remaining = [...new Set(remainingPids)];
  const result: ProcessTreeTerminationResult = {
    forced,
    remainingPids: remaining,
  };
  if (remaining.length === 0) return result;
  // POSIX callers retain the dedicated process-group leader and can safely
  // retry through terminateProcessTree itself.  The opaque PID/identity
  // handle is specifically for Windows reparenting, where the dead wrapper
  // can no longer be used to rediscover its descendants.
  if (existing === undefined && process.platform !== "win32") return result;
  const ownership =
    existing !== undefined ? existing : createRetryOwnership(tree);
  // Keep the handle non-enumerable so existing diagnostics/results remain
  // JSON-safe while internal callers can still access it directly.
  Object.defineProperty(result, "retryOwnership", {
    configurable: false,
    enumerable: false,
    value: ownership,
    writable: false,
  });
  return result;
}

function retryCapturedTree(record: RetryOwnershipRecord): CapturedProcessTree {
  const root = record.processes.find(
    (process) => process.pid === record.rootPid,
  );
  const rootIdentity = root?.identity ?? "";
  return {
    root: { pid: record.rootPid, parentPid: 0, identity: rootIdentity },
    descendants: record.processes
      .filter((process) => process.pid !== record.rootPid)
      .map((process) => ({ ...process })),
  };
}

function indexRetrySnapshot(
  snapshot: readonly ProcessSnapshotRecord[],
  candidates: readonly number[],
): Map<number, string> | null {
  if (!Array.isArray(snapshot)) return null;
  const candidateSet = new Set(candidates);
  const identities = new Map<number, string>();
  for (const record of snapshot) {
    if (
      !record ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.identity !== "string" ||
      !record.identity.trim()
    ) {
      return null;
    }
    if (!candidateSet.has(record.pid)) continue;
    if (identities.has(record.pid)) return null;
    identities.set(record.pid, record.identity);
  }
  return identities;
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

/**
 * Build the POSIX snapshot needed by the PID-only adapter.
 *
 * `captureProcessSnapshot` intentionally remains Windows-only: ordinary
 * POSIX children are shut down through their verified dedicated process
 * group, which does not need a process-table walk.  A daemonized Gateway is
 * different — its wrapper has exited and only the listener PID remains.  In
 * that case we still need one exact creation-identity observation before
 * signalling the PID, followed by the same identity refreshes used by the
 * regular tree path.  A missing/blank identity is unavailable evidence, not
 * permission to signal.
 */
async function capturePosixPidSnapshot(
  request: ProcessSnapshotRequest,
  processIdentityForPid: (pid: number) => string | null,
  descendantProcessesForRoot: (rootPid: number) => CapturedProcessIdentity[],
  pidIsAliveForPid: (pid: number) => boolean,
): Promise<readonly ProcessSnapshotRecord[] | null> {
  const candidates = request.candidatePids
    ? [...new Set(request.candidatePids)]
    : null;
  if (candidates !== null) {
    if (
      candidates.some(
        (candidate) => !Number.isSafeInteger(candidate) || candidate <= 0,
      )
    ) {
      return null;
    }
    const records: ProcessSnapshotRecord[] = [];
    for (const pid of candidates) {
      // A candidate that has already exited is ordinary lifecycle progress,
      // not an unavailable identity query.  Omit it so the caller can
      // distinguish "gone" from a live PID whose identity could not be read.
      if (!pidIsAliveForPid(pid)) continue;
      const rawIdentity = processIdentityForPid(pid);
      const identity =
        typeof rawIdentity === "string" ? rawIdentity.trim() : "";
      if (!identity) return null;
      records.push({ pid, parentPid: 0, identity });
    }
    if (records.length === 0 && !request.allowEmpty) return null;
    return records;
  }

  const rawRootIdentity = processIdentityForPid(request.rootPid);
  const rootIdentity =
    typeof rawRootIdentity === "string" ? rawRootIdentity.trim() : "";
  if (!rootIdentity) return null;
  const descendants = descendantProcessesForRoot(request.rootPid);
  if (!Array.isArray(descendants)) return null;
  const seen = new Set<number>([request.rootPid]);
  const records: ProcessSnapshotRecord[] = [
    { pid: request.rootPid, parentPid: 0, identity: rootIdentity },
  ];
  for (const descendant of descendants) {
    if (
      !descendant ||
      !Number.isSafeInteger(descendant.pid) ||
      descendant.pid <= 0 ||
      seen.has(descendant.pid) ||
      typeof descendant.identity !== "string"
    ) {
      return null;
    }
    const identity = descendant.identity.trim();
    if (!identity) return null;
    seen.add(descendant.pid);
    records.push({
      pid: descendant.pid,
      parentPid: request.rootPid,
      identity,
    });
  }
  return records;
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
  verifyRootOwnership: TerminateProcessTreeOptions["verifyRootOwnership"],
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

  if (!rootOwnershipVerified(processGroupId, verifyRootOwnership)) {
    return { forced: false, remainingPids: [...initialPids] };
  }
  operations.signalProcessGroup(processGroupId, "SIGTERM");
  let alive = await waitForProcessGroupExit(
    processGroupId,
    forceAfterMs,
    pollIntervalMs,
    operations,
  );
  if (!alive) return { forced: false, remainingPids: [] };

  if (!rootOwnershipVerified(processGroupId, verifyRootOwnership)) {
    const remainingPids = await operations.processGroupPids(
      processGroupId,
      commandTimeoutMs,
    );
    if (remainingPids === null) {
      throw new Error(
        `Desktop-owned process group ${processGroupId} ownership could not be reverified`,
      );
    }
    return { forced: false, remainingPids: [...remainingPids] };
  }
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
  const snapshotTotalBudgetMs = Math.max(
    1,
    Math.min(
      options.snapshotTotalBudgetMs ?? snapshotTimeoutMs * 2,
      snapshotTimeoutMs * 2,
    ),
  );
  const windowsPrimarySnapshotBudgetMs = Math.max(
    1,
    Math.min(
      snapshotTimeoutMs,
      Math.floor(
        (snapshotTotalBudgetMs * WINDOWS_PRIMARY_SNAPSHOT_BUDGET_NUMERATOR) /
          WINDOWS_PRIMARY_SNAPSHOT_BUDGET_DENOMINATOR,
      ),
    ),
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
      options.verifyRootOwnership,
    );
  }

  const initialSnapshotDeadline =
    Date.now() +
    (process.platform === "win32" ? snapshotTotalBudgetMs : snapshotTimeoutMs);
  const captureInitialSnapshot = async (
    attempt: number,
    strategy: WindowsSnapshotStrategy,
  ): Promise<readonly ProcessSnapshotRecord[] | null> => {
    const remainingBudget = initialSnapshotDeadline - Date.now();
    if (remainingBudget <= 0) return null;
    return captureForPhase(
      {
        rootPid,
        timeoutMs: Math.max(
          1,
          Math.min(
            process.platform !== "win32"
              ? snapshotTimeoutMs
              : strategy === "cim" && attempt === 1
                ? windowsPrimarySnapshotBudgetMs
                : snapshotTotalBudgetMs,
            remainingBudget,
          ),
        ),
        phase: "initial-snapshot",
        attempt,
        strategy,
        profileKey: options.diagnosticProfileKey,
        onDiagnostic: options.onDiagnostic,
      },
      operations,
      customOperations,
    );
  };
  let initialSnapshot = await captureInitialSnapshot(1, "cim");
  const primaryTree = initialSnapshot
    ? buildCapturedProcessTree(initialSnapshot, rootPid)
    : null;
  if (
    process.platform === "win32" &&
    (initialSnapshot == null || primaryTree === null)
  ) {
    initialSnapshot = await captureInitialSnapshot(2, "wmi");
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

  // Snapshot identity is necessary to bind the tree, but Gateway callers also
  // persist the executable image. Re-read that complete caller-owned proof at
  // the last boundary before TERM/taskkill can affect the root or descendants.
  if (
    rootAlive &&
    !rootOwnershipVerified(rootPid, options.verifyRootOwnership)
  ) {
    return attachRetryOwnership(
      false,
      capturedPidsAlive(proc, descendants, operations),
      capturedTree,
    );
  }

  let windowsTreeSignalled = false;
  if (process.platform === "win32" && rootAlive) {
    // Descendant inspection and command preparation can yield between the
    // initial ownership check and the platform tree call. Re-read the root's
    // caller-owned proof at this signal boundary as well.
    if (!rootOwnershipVerified(rootPid, options.verifyRootOwnership)) {
      return attachRetryOwnership(
        false,
        capturedPidsAlive(proc, descendants, operations),
        capturedTree,
      );
    }
    // `taskkill /T` can affect every descendant currently attached to the
    // root. Revalidate each captured descendant immediately before invoking it;
    // if any identity has changed, fall back to individually gated signals so
    // a reused PID can never be swept up by the tree command.
    const descendantsVerifiedForGracefulTree = descendants.every(
      (child) =>
        !operations.pidIsAlive(child.pid) ||
        descendantIdentityVerified(child, operations, customOperations),
    );
    if (!descendantsVerifiedForGracefulTree) {
      emitWindowsTerminationDiagnostic(
        {
          rootPid,
          phase: "graceful-taskkill",
          attempt: 1,
          profileKey: options.diagnosticProfileKey,
          onDiagnostic: options.onDiagnostic,
        },
        0,
        "failed",
      );
    }
    if (descendantsVerifiedForGracefulTree) {
      const gracefulStartedAt = Date.now();
      try {
        await operations.gracefulWindowsTree(rootPid, commandTimeoutMs);
        windowsTreeSignalled = true;
        emitWindowsTerminationDiagnostic(
          {
            rootPid,
            phase: "graceful-taskkill",
            attempt: 1,
            profileKey: options.diagnosticProfileKey,
            onDiagnostic: options.onDiagnostic,
          },
          Date.now() - gracefulStartedAt,
          "success",
        );
      } catch {
        emitWindowsTerminationDiagnostic(
          {
            rootPid,
            phase: "graceful-taskkill",
            attempt: 1,
            profileKey: options.diagnosticProfileKey,
            onDiagnostic: options.onDiagnostic,
          },
          Date.now() - gracefulStartedAt,
          "failed",
        );
        // Fall through to exact captured PID signalling.
      }
    }
  }
  if (!windowsTreeSignalled) {
    for (const child of descendants) {
      if (
        operations.pidIsAlive(child.pid) &&
        descendantIdentityVerified(child, operations, customOperations)
      ) {
        operations.signalPid(child.pid, "SIGTERM");
      }
    }
  }
  if (rootAlive && !windowsTreeSignalled) {
    // The descendant loop above performs fresh identity checks and may itself
    // take observable time. Do not use the earlier snapshot proof for the
    // root signal; a reused root PID must remain untouched.
    if (rootOwnershipVerified(rootPid, options.verifyRootOwnership)) {
      signalOwnedRoot(proc, "SIGTERM", detachedProcessGroup);
    }
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
      phase: "identity-refresh",
      attempt: 1,
      strategy: "cim",
      profileKey: options.diagnosticProfileKey,
      onDiagnostic: options.onDiagnostic,
    },
    operations,
    customOperations,
  );
  if (!refreshSnapshot) {
    return attachRetryOwnership(false, remaining, capturedTree);
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
  const rootWillBeForced =
    remainingSet.has(rootPid) &&
    verifiedSet.has(rootPid) &&
    childProcessIsAlive(proc, operations.pidIsAlive);
  if (
    rootWillBeForced &&
    !rootOwnershipVerified(rootPid, options.verifyRootOwnership)
  ) {
    return attachRetryOwnership(false, remaining, capturedTree);
  }
  if (process.platform === "win32") {
    const descendantsVerifiedForForceTree = descendants.every(
      (child) =>
        !remainingSet.has(child.pid) ||
        !operations.pidIsAlive(child.pid) ||
        (verifiedSet.has(child.pid) &&
          descendantIdentityVerified(child, operations, customOperations)),
    );
    if (
      remainingSet.has(rootPid) &&
      verifiedSet.has(rootPid) &&
      childProcessIsAlive(proc, operations.pidIsAlive) &&
      descendantsVerifiedForForceTree &&
      rootOwnershipVerified(rootPid, options.verifyRootOwnership)
    ) {
      const forceStartedAt = Date.now();
      try {
        await operations.forceWindowsTree(rootPid, commandTimeoutMs);
        forced = true;
        for (const pid of verifiedRemaining) forcedPids.add(pid);
        emitWindowsTerminationDiagnostic(
          {
            rootPid,
            phase: "force-taskkill",
            attempt: 1,
            profileKey: options.diagnosticProfileKey,
            onDiagnostic: options.onDiagnostic,
          },
          Date.now() - forceStartedAt,
          "success",
        );
      } catch {
        emitWindowsTerminationDiagnostic(
          {
            rootPid,
            phase: "force-taskkill",
            attempt: 1,
            profileKey: options.diagnosticProfileKey,
            onDiagnostic: options.onDiagnostic,
          },
          Date.now() - forceStartedAt,
          "failed",
        );
        if (
          verifiedSet.has(rootPid) &&
          childProcessIsAlive(proc, operations.pidIsAlive) &&
          rootOwnershipVerified(rootPid, options.verifyRootOwnership)
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
      operations.pidIsAlive(child.pid) &&
      descendantIdentityVerified(child, operations, customOperations)
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
    childProcessIsAlive(proc, operations.pidIsAlive) &&
    rootOwnershipVerified(rootPid, options.verifyRootOwnership)
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
    return attachRetryOwnership(forced, remaining, capturedTree);
  }

  const finalSnapshot = await captureForPhase(
    {
      rootPid,
      candidatePids: remaining,
      timeoutMs: snapshotTimeoutMs,
      phase: "final-snapshot",
      attempt: 1,
      strategy: "cim",
      profileKey: options.diagnosticProfileKey,
      onDiagnostic: options.onDiagnostic,
    },
    operations,
    customOperations,
  );
  if (!finalSnapshot) {
    return attachRetryOwnership(forced, remaining, capturedTree);
  }
  const finalByPid = new Map(
    finalSnapshot.map((record) => [record.pid, record.identity]),
  );
  remaining = remaining.filter((pid) => {
    if (!forcedPids.has(pid)) return true;
    if (!finalByPid.has(pid)) return operations.pidIsAlive(pid);
    const finalIdentity = finalByPid.get(pid);
    return !finalIdentity || finalIdentity === capturedByPid.get(pid);
  });
  return attachRetryOwnership(forced, remaining, capturedTree);
}

/**
 * Retry cleanup using the identities captured by an earlier termination.
 *
 * This path intentionally never re-derives a tree from a dead wrapper/root.
 * Windows descendants can be reparented when that wrapper exits; the only
 * safe operation is to refresh each captured PID's creation identity and then
 * signal that PID only while the identity still matches.  A missing PID or a
 * changed identity means the originally owned process is gone (and the new
 * occupant is left untouched).  An unavailable refresh is fail-closed.
 */
export async function retryCapturedProcessTermination(
  ownership: ProcessTreeRetryOwnership,
  options: TerminateProcessTreeOptions = {},
): Promise<ProcessTreeTerminationResult> {
  const record = retryOwnershipRecords.get(ownership as object);
  if (!record) {
    throw new Error("Invalid Aera process-tree retry ownership.");
  }

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
  const forceAfterMs = Math.max(0, options.forceAfterMs ?? 3_000);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 50);
  const forceSettleMs = Math.max(
    0,
    options.forceSettleMs ?? (process.platform === "win32" ? 3_000 : 500),
  );
  const snapshotTimeoutMs = Math.max(
    1,
    options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS,
  );
  const snapshotTotalBudgetMs = Math.max(
    1,
    Math.min(
      options.snapshotTotalBudgetMs ?? snapshotTimeoutMs * 2,
      snapshotTimeoutMs * 2,
    ),
  );
  const processes = record.processes;

  const refresh = async (
    candidates: readonly number[],
    attempt: number,
  ): Promise<readonly ProcessSnapshotRecord[] | null> => {
    if (candidates.length === 0) return [];
    // A caller that supplies legacy seams (used by POSIX-focused tests and
    // older embedders) cannot query a dead root with the tree helper.  Query
    // exact identities directly in that case; the default Windows path uses
    // one bounded targeted CIM/WMI snapshot instead.
    if (
      customOperations?.captureSnapshot === undefined &&
      (customOperations?.processIdentity ||
        customOperations?.descendantProcesses ||
        customOperations?.descendantPids)
    ) {
      const records: ProcessSnapshotRecord[] = [];
      for (const pid of candidates) {
        const identity = operations.processIdentity(pid);
        // A legacy identity seam cannot distinguish "the process exited"
        // from "the identity query failed".  Treat a missing value as
        // unavailable and retain ownership rather than clearing a live PID
        // on an ambiguous probe.
        if (!identity?.trim()) return null;
        records.push({ pid, parentPid: 0, identity });
      }
      return records;
    }
    return captureForPhase(
      {
        rootPid: record.rootPid,
        candidatePids: candidates,
        allowEmpty: true,
        timeoutMs:
          process.platform === "win32"
            ? Math.min(snapshotTotalBudgetMs, snapshotTimeoutMs)
            : snapshotTimeoutMs,
        phase: "identity-refresh",
        attempt,
        strategy: "cim",
        profileKey: options.diagnosticProfileKey,
        onDiagnostic: options.onDiagnostic,
      },
      operations,
      customOperations,
    );
  };

  const liveCandidates = processes
    .filter((captured) => operations.pidIsAlive(captured.pid))
    .map((captured) => captured.pid);
  if (liveCandidates.length === 0) {
    return { forced: false, remainingPids: [] };
  }

  const capturedByPid = new Map(
    processes.map((captured) => [captured.pid, captured.identity] as const),
  );
  const initial = await refresh(liveCandidates, 1);
  if (initial === null) {
    return attachRetryOwnership(
      false,
      liveCandidates,
      retryCapturedTree(record),
      ownership,
    );
  }
  const initialByPid = indexRetrySnapshot(initial, liveCandidates);
  if (initialByPid === null) {
    return attachRetryOwnership(
      false,
      liveCandidates,
      retryCapturedTree(record),
      ownership,
    );
  }
  // An empty targeted snapshot is unavailable evidence when an independent
  // liveness probe still sees any candidate. Never clear ownership on that
  // contradictory observation.
  if (
    initial.length === 0 &&
    liveCandidates.some((candidate) => operations.pidIsAlive(candidate))
  ) {
    return attachRetryOwnership(
      false,
      liveCandidates,
      retryCapturedTree(record),
      ownership,
    );
  }
  const verified = liveCandidates.filter(
    (pid) => initialByPid.get(pid) === capturedByPid.get(pid),
  );
  // A successful targeted snapshot that omits a PID proves that the original
  // process is gone.  A changed creation identity is likewise a PID reuse;
  // neither case is ever signalled.
  if (verified.length === 0) {
    return { forced: false, remainingPids: [] };
  }

  if (
    verified.includes(record.rootPid) &&
    !rootOwnershipVerified(record.rootPid, options.verifyRootOwnership)
  ) {
    return attachRetryOwnership(
      false,
      verified,
      retryCapturedTree(record),
      ownership,
    );
  }

  let signalError = false;
  for (const pid of verified) {
    try {
      operations.signalPid(pid, "SIGTERM");
    } catch {
      signalError = true;
    }
  }

  let remaining = await waitForRetryPids(
    verified,
    capturedByPid,
    forceAfterMs,
    pollIntervalMs,
    operations,
    refresh,
    2,
  );
  if (remaining.refreshUnavailable) {
    return attachRetryOwnership(
      false,
      remaining.pids,
      retryCapturedTree(record),
      ownership,
    );
  }
  const forceCandidates = remaining.pids;
  if (
    forceCandidates.includes(record.rootPid) &&
    !rootOwnershipVerified(record.rootPid, options.verifyRootOwnership)
  ) {
    return attachRetryOwnership(
      false,
      forceCandidates,
      retryCapturedTree(record),
      ownership,
    );
  }
  let forced = false;
  for (const pid of forceCandidates) {
    try {
      operations.signalPid(pid, "SIGKILL");
      forced = true;
    } catch {
      signalError = true;
    }
  }

  remaining = await waitForRetryPids(
    forceCandidates,
    capturedByPid,
    forceSettleMs,
    pollIntervalMs,
    operations,
    refresh,
    3,
  );
  if (remaining.refreshUnavailable) {
    return attachRetryOwnership(
      forced,
      remaining.pids,
      retryCapturedTree(record),
      ownership,
    );
  }
  // A signal failure is represented as an ownership failure only when the
  // original PID is still live and identity-matching.  Do not manufacture a
  // remaining PID for a process that has already disappeared.
  if (signalError) {
    const liveAfterFailure = remaining.pids.filter((pid) =>
      operations.pidIsAlive(pid),
    );
    return attachRetryOwnership(
      forced,
      liveAfterFailure,
      retryCapturedTree(record),
      ownership,
    );
  }
  return { forced, remainingPids: remaining.pids };
}

interface RetryPidsResult {
  pids: number[];
  refreshUnavailable: boolean;
}

async function waitForRetryPids(
  candidates: readonly number[],
  capturedByPid: ReadonlyMap<number, string>,
  timeoutMs: number,
  pollIntervalMs: number,
  operations: ProcessTreeTerminationOperations,
  refresh: (
    candidates: readonly number[],
    attempt: number,
  ) => Promise<readonly ProcessSnapshotRecord[] | null>,
  attempt: number,
): Promise<RetryPidsResult> {
  const deadline = Date.now() + timeoutMs;
  let live = candidates.filter((pid) => operations.pidIsAlive(pid));
  while (live.length > 0 && Date.now() < deadline) {
    await operations.wait(
      Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
    );
    live = candidates.filter((pid) => operations.pidIsAlive(pid));
  }
  if (live.length === 0) return { pids: [], refreshUnavailable: false };
  const snapshot = await refresh(live, attempt);
  if (snapshot === null) {
    return { pids: live, refreshUnavailable: true };
  }
  if (
    snapshot.length === 0 &&
    live.some((candidate) => operations.pidIsAlive(candidate))
  ) {
    return { pids: live, refreshUnavailable: true };
  }
  const identities = indexRetrySnapshot(snapshot, candidates);
  if (identities === null) {
    return { pids: live, refreshUnavailable: true };
  }
  return {
    pids: live.filter((pid) => identities.get(pid) === capturedByPid.get(pid)),
    refreshUnavailable: false,
  };
}

/**
 * Terminate a verified managed process tree when the durable listener exposes
 * only its PID rather than a Node ChildProcess handle. The adapter deliberately
 * keeps lifecycle fields live and routes root signals through the same injected
 * operations as the snapshot/identity checks, so Windows still reaches taskkill
 * and POSIX signals the exact captured root instead of treating it as exited.
 */
export function terminateProcessTreeByPid(
  pid: number,
  options: TerminateProcessTreeOptions = {},
): Promise<ProcessTreeTerminationResult> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve({ forced: false, remainingPids: [] });
  }
  const rootSignal = options.operations?.signalPid ?? signalPid;
  const target = {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      rootSignal(pid, signal);
      return true;
    },
  } as unknown as ChildProcess;
  // A daemonized POSIX listener is not a dedicated process-group leader, so
  // it cannot use the group path.  `captureProcessSnapshot` is intentionally
  // unavailable on POSIX for ordinary children; provide this PID-only call
  // with a narrow exact-PID identity snapshot instead.  Preserve an explicit
  // caller seam (used by deterministic tests/embedders) when supplied.
  if (
    process.platform !== "win32" &&
    (options.detachedProcessGroup ?? false) === false &&
    options.operations?.captureSnapshot === undefined
  ) {
    const processIdentityForPid =
      options.operations?.processIdentity ?? processIdentity;
    const descendantProcessesForRoot =
      options.operations?.descendantProcesses ?? descendantProcesses;
    return terminateProcessTree(target, {
      ...options,
      operations: {
        ...options.operations,
        captureSnapshot: (request) =>
          capturePosixPidSnapshot(
            request,
            processIdentityForPid,
            descendantProcessesForRoot,
            options.operations?.pidIsAlive ?? pidIsAlive,
          ),
      },
    });
  }
  return terminateProcessTree(target, options);
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
