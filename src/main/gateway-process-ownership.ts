import { randomUUID as nodeRandomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const OWNERSHIP_FILE = "gateway-process-ownership.json";
const OWNERSHIP_PENDING_FILE = "gateway-process-ownership.pending.json";
const OWNERSHIP_BACKUP_FILE = "gateway-process-ownership.previous.json";
const PROFILE_PATTERN = /^(?:default|[a-z0-9_][a-z0-9_-]{0,63})$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type GatewayProcessOwnershipErrorCode =
  | "invalid_ownership"
  | "ownership_conflict"
  | "ownership_persistence_failed";

export class GatewayProcessOwnershipError extends Error {
  readonly code: GatewayProcessOwnershipErrorCode;

  constructor(code: GatewayProcessOwnershipErrorCode) {
    super(`Aera gateway ownership failed: ${code}.`);
    this.name = "GatewayProcessOwnershipError";
    this.code = code;
  }
}

export interface GatewayLaunchOwnershipRecord {
  launchId: string;
  desktopInstanceId: string;
  desktopPid: number;
  profileId: string;
  preLaunchPid: number | null;
  spawnedPid: number | null;
  createdAt: string;
}

interface GatewayProcessOwnershipState {
  version: 1;
  entries: GatewayLaunchOwnershipRecord[];
}

export interface GatewayProcessOwnershipLedgerOptions {
  userDataPath: string;
  desktopPid?: number;
  now?: () => Date;
  randomUUID?: () => string;
}

export interface BeginGatewayLaunchInput {
  profileId: string;
  preLaunchPid: number | null;
}

export interface MarkGatewaySpawnedInput {
  profileId: string;
  launchId: string;
  spawnedPid: number;
}

export interface GatewayColdStartRecoveryInput {
  readCurrentPid: (profileId: string) => number | null;
  isAlive: (pid: number) => boolean;
}

export interface GatewayColdStartRecovery {
  ownedProfiles: string[];
  ambiguousProfiles: string[];
}

function exactKeys(value: object, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function profileId(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_PATTERN.test(value)) {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  return value.toLowerCase();
}

function pid(value: unknown, nullable: false): number;
function pid(value: unknown, nullable: true): number | null;
function pid(value: unknown, nullable: boolean): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  return value;
}

function parseRecord(value: unknown): GatewayLaunchOwnershipRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "launchId",
      "desktopInstanceId",
      "desktopPid",
      "profileId",
      "preLaunchPid",
      "spawnedPid",
      "createdAt",
    ])
  ) {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  const record = value as Record<string, unknown>;
  return {
    launchId: uuid(record.launchId),
    desktopInstanceId: uuid(record.desktopInstanceId),
    desktopPid: pid(record.desktopPid, false),
    profileId: profileId(record.profileId),
    preLaunchPid: pid(record.preLaunchPid, true),
    spawnedPid: pid(record.spawnedPid, true),
    createdAt: timestamp(record.createdAt),
  };
}

function parseState(value: unknown): GatewayProcessOwnershipState {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, ["version", "entries"])
  ) {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || !Array.isArray(state.entries)) {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  const entries = state.entries.map(parseRecord);
  if (
    new Set(entries.map((entry) => entry.profileId)).size !== entries.length
  ) {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  return { version: 1, entries };
}

function createdAt(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  return value.toISOString();
}

export class GatewayProcessOwnershipLedger {
  private readonly path: string;
  private readonly pendingPath: string;
  private readonly backupPath: string;
  private readonly desktopPid: number;
  private readonly desktopInstanceId: string;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private state: GatewayProcessOwnershipState;
  private loadIssue: GatewayProcessOwnershipErrorCode | null = null;

  constructor(options: GatewayProcessOwnershipLedgerOptions) {
    if (
      typeof options.userDataPath !== "string" ||
      !isAbsolute(options.userDataPath)
    ) {
      throw new GatewayProcessOwnershipError("invalid_ownership");
    }
    this.desktopPid = pid(options.desktopPid ?? process.pid, false);
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.desktopInstanceId = uuid(this.randomUUID());
    const root = resolve(options.userDataPath);
    this.path = join(root, OWNERSHIP_FILE);
    this.pendingPath = join(root, OWNERSHIP_PENDING_FILE);
    this.backupPath = join(root, OWNERSHIP_BACKUP_FILE);
    this.state = this.readState();
  }

  beginLaunch(input: BeginGatewayLaunchInput): GatewayLaunchOwnershipRecord {
    const normalizedProfileId = profileId(input.profileId);
    const preLaunchPid = pid(input.preLaunchPid, true);
    if (
      this.state.entries.some(
        (entry) => entry.profileId === normalizedProfileId,
      )
    ) {
      throw new GatewayProcessOwnershipError("ownership_conflict");
    }
    const record: GatewayLaunchOwnershipRecord = {
      launchId: uuid(this.randomUUID()),
      desktopInstanceId: this.desktopInstanceId,
      desktopPid: this.desktopPid,
      profileId: normalizedProfileId,
      preLaunchPid,
      spawnedPid: null,
      createdAt: createdAt(this.now),
    };
    this.replaceState({
      version: 1,
      entries: [...this.state.entries, record],
    });
    return { ...record };
  }

  markSpawned(input: MarkGatewaySpawnedInput): GatewayLaunchOwnershipRecord {
    const normalizedProfileId = profileId(input.profileId);
    const launchId = uuid(input.launchId);
    const spawnedPid = pid(input.spawnedPid, false);
    const index = this.state.entries.findIndex(
      (entry) => entry.profileId === normalizedProfileId,
    );
    const current = this.state.entries[index];
    if (
      !current ||
      current.launchId !== launchId ||
      current.desktopInstanceId !== this.desktopInstanceId ||
      (current.spawnedPid !== null && current.spawnedPid !== spawnedPid)
    ) {
      throw new GatewayProcessOwnershipError("ownership_conflict");
    }
    const updated = { ...current, spawnedPid };
    const entries = [...this.state.entries];
    entries[index] = updated;
    this.replaceState({ version: 1, entries });
    return { ...updated };
  }

  clearLaunch(profileIdValue: string, launchIdValue?: string): void {
    const normalizedProfileId = profileId(profileIdValue);
    const launchId =
      launchIdValue === undefined ? undefined : uuid(launchIdValue);
    const existing = this.state.entries.find(
      (entry) => entry.profileId === normalizedProfileId,
    );
    if (
      !existing ||
      (launchId !== undefined && existing.launchId !== launchId)
    ) {
      return;
    }
    this.replaceState({
      version: 1,
      entries: this.state.entries.filter(
        (entry) => entry.profileId !== normalizedProfileId,
      ),
    });
  }

  get(profileIdValue: string): GatewayLaunchOwnershipRecord | null {
    const normalizedProfileId = profileId(profileIdValue);
    const record = this.state.entries.find(
      (entry) => entry.profileId === normalizedProfileId,
    );
    return record ? { ...record } : null;
  }

  listCurrentProcessProfiles(): string[] {
    return this.state.entries
      .filter((entry) => entry.desktopInstanceId === this.desktopInstanceId)
      .map((entry) => entry.profileId)
      .sort();
  }

  listProfiles(): string[] {
    return this.state.entries.map((entry) => entry.profileId).sort();
  }

  getLoadIssue(): GatewayProcessOwnershipErrorCode | null {
    return this.loadIssue;
  }

  reconcileColdStart(
    input: GatewayColdStartRecoveryInput,
  ): GatewayColdStartRecovery {
    const ownedProfiles: string[] = [];
    const ambiguousProfiles: string[] = [];
    const remove = new Set<string>();
    for (const entry of this.state.entries) {
      if (entry.desktopInstanceId === this.desktopInstanceId) continue;
      let currentPid: number | null;
      try {
        currentPid = pid(input.readCurrentPid(entry.profileId), true);
      } catch {
        ambiguousProfiles.push(entry.profileId);
        continue;
      }
      if (currentPid === null) {
        if (entry.spawnedPid === null) {
          remove.add(entry.profileId);
          continue;
        }
        try {
          if (input.isAlive(entry.spawnedPid)) {
            ambiguousProfiles.push(entry.profileId);
          } else {
            remove.add(entry.profileId);
          }
        } catch {
          ambiguousProfiles.push(entry.profileId);
        }
        continue;
      }
      let alive: boolean;
      try {
        alive = input.isAlive(currentPid);
      } catch {
        ambiguousProfiles.push(entry.profileId);
        continue;
      }
      if (!alive) {
        remove.add(entry.profileId);
        continue;
      }
      if (currentPid === entry.preLaunchPid) {
        remove.add(entry.profileId);
        continue;
      }
      if (entry.spawnedPid !== null && currentPid === entry.spawnedPid) {
        ownedProfiles.push(entry.profileId);
        continue;
      }
      ambiguousProfiles.push(entry.profileId);
    }
    if (remove.size > 0) {
      this.replaceState({
        version: 1,
        entries: this.state.entries.filter(
          (entry) => !remove.has(entry.profileId),
        ),
      });
    }
    return {
      ownedProfiles: ownedProfiles.sort(),
      ambiguousProfiles: ambiguousProfiles.sort(),
    };
  }

  private readState(): GatewayProcessOwnershipState {
    const pendingExists = existsSync(this.pendingPath);
    const pending = this.readCandidate(this.pendingPath);
    if (pending !== null) {
      try {
        this.promotePending();
      } catch {
        this.loadIssue = "ownership_persistence_failed";
      }
      return pending;
    }
    if (pendingExists) {
      this.loadIssue = "ownership_persistence_failed";
      try {
        unlinkSync(this.pendingPath);
      } catch {
        // Keep the invalid pending artifact observable and fail future writes.
      }
    }

    const canonical = this.readCandidate(this.path);
    if (canonical !== null) return canonical;

    const backup = this.readCandidate(this.backupPath);
    if (backup !== null) {
      this.loadIssue = "ownership_persistence_failed";
      return backup;
    }

    if (
      existsSync(this.path) ||
      existsSync(this.pendingPath) ||
      existsSync(this.backupPath)
    ) {
      this.loadIssue = "invalid_ownership";
    }
    return { version: 1, entries: [] };
  }

  private readCandidate(path: string): GatewayProcessOwnershipState | null {
    if (!existsSync(path)) return null;
    try {
      return parseState(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return null;
    }
  }

  private replaceState(nextState: GatewayProcessOwnershipState): void {
    this.persist(nextState);
    this.state = nextState;
  }

  private persist(nextState: GatewayProcessOwnershipState): void {
    const root = dirname(this.path);
    let descriptor: number | null = null;
    let pendingIsDurable = false;
    let createdPending = false;
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      if (existsSync(this.pendingPath)) {
        this.promotePending();
      }
      descriptor = openSync(this.pendingPath, "wx", 0o600);
      createdPending = true;
      writeFileSync(descriptor, JSON.stringify(nextState), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      chmodSync(this.pendingPath, 0o600);
      pendingIsDurable = true;
      try {
        this.promotePending();
        this.loadIssue = null;
      } catch {
        // The fully fsynced pending file is the commit point. A cold restart
        // reads it before the canonical/backup files and retries promotion.
        this.loadIssue = "ownership_persistence_failed";
      }
    } catch {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the bounded persistence failure.
        }
      }
      if (!pendingIsDurable && createdPending) {
        try {
          unlinkSync(this.pendingPath);
        } catch {
          // Preserve the bounded persistence failure.
        }
      }
      throw new GatewayProcessOwnershipError("ownership_persistence_failed");
    }
  }

  private promotePending(): void {
    if (!existsSync(this.pendingPath)) return;
    if (this.readCandidate(this.pendingPath) === null) {
      throw new GatewayProcessOwnershipError("invalid_ownership");
    }
    try {
      renameSync(this.pendingPath, this.path);
      this.fsyncRootBestEffort();
      this.removeBackupBestEffort();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code !== "EACCES" &&
        code !== "EBUSY" &&
        code !== "EEXIST" &&
        code !== "EPERM"
      ) {
        throw error;
      }
    }

    this.removeBackupBestEffort();
    let canonicalMoved = false;
    if (existsSync(this.path)) {
      renameSync(this.path, this.backupPath);
      canonicalMoved = true;
    }
    try {
      renameSync(this.pendingPath, this.path);
    } catch (error) {
      if (canonicalMoved && !existsSync(this.path)) {
        try {
          renameSync(this.backupPath, this.path);
        } catch {
          // The valid pending and previous files remain recoverable.
        }
      }
      throw error;
    }
    this.fsyncRootBestEffort();
    this.removeBackupBestEffort();
  }

  private removeBackupBestEffort(): void {
    if (!existsSync(this.backupPath)) return;
    try {
      unlinkSync(this.backupPath);
    } catch {
      // A valid canonical or pending file remains authoritative.
    }
  }

  private fsyncRootBestEffort(): void {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(dirname(this.path), "r");
      fsyncSync(descriptor);
    } catch {
      // File bytes are already fsynced; some platforms reject directory fsync.
    } finally {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {
          // best-effort
        }
      }
    }
  }
}
