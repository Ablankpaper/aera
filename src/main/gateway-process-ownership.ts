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
import {
  normalizeProcessImage,
  processEvidenceMatches,
  type ProcessIdentityEvidence,
} from "./process-identity";

const OWNERSHIP_FILE = "gateway-process-ownership.json";
const OWNERSHIP_PENDING_FILE = "gateway-process-ownership.pending.json";
const OWNERSHIP_BACKUP_FILE = "gateway-process-ownership.previous.json";
// Version 3 keeps the short-lived spawn wrapper and the daemonized listener
// as two separate identity records.  Versions 1/2 remain readable so a
// desktop upgrade never turns a durable file into an unknown blob; callers
// treat records without explicit listener evidence as legacy/ambiguous when
// the PID file points at a different process.
const OWNERSHIP_SCHEMA_VERSION = 3 as const;
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
  /** OS creation identity captured for the currently owned PID. */
  spawnedIdentity: string | null;
  /** Normalized executable image captured with `spawnedIdentity`. */
  spawnedImage: string | null;
  /** Long-lived daemon PID published by gateway.pid, when adopted. */
  listenerPid: number | null;
  /** Creation identity captured for the daemonized listener. */
  listenerIdentity: string | null;
  /** Normalized executable image captured for the daemonized listener. */
  listenerImage: string | null;
  createdAt: string;
}

interface GatewayProcessOwnershipState {
  version: typeof OWNERSHIP_SCHEMA_VERSION;
  entries: GatewayLaunchOwnershipRecord[];
}

interface ParsedGatewayProcessOwnershipState {
  state: GatewayProcessOwnershipState;
  sourceVersion: 1 | 2 | typeof OWNERSHIP_SCHEMA_VERSION;
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

export interface BeginGatewayRestartInput {
  profileId: string;
  preLaunchPid: number | null;
}

export interface BeginGatewayRestartResult {
  record: GatewayLaunchOwnershipRecord;
  previous: GatewayLaunchOwnershipRecord;
}

export interface MarkGatewaySpawnedInput {
  profileId: string;
  launchId: string;
  spawnedPid: number;
  spawnedIdentity?: string | null;
  spawnedImage?: string | null;
}

export interface AdoptGatewaySpawnedPidInput extends MarkGatewaySpawnedInput {
  previousSpawnedPid: number;
  previousSpawnedIdentity?: string | null;
  previousSpawnedImage?: string | null;
  /** A restart may replace the listener while retaining the prior proof. */
  replaceExistingListener?: boolean;
}

export interface GatewayColdStartRecoveryInput {
  readCurrentPid: (profileId: string) => number | null;
  isAlive: (pid: number) => boolean;
  /** Fresh identity/image evidence for the PID currently in gateway.pid. */
  readEvidence?: (pid: number) => ProcessIdentityEvidence | null;
  /** Remove a PID marker only after the exact durable listener is proven dead. */
  clearDeadListenerPid?: (profileId: string, pid: number) => boolean;
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

function normalizedIdentity(value: unknown, nullable = true): string | null {
  if (value === undefined && nullable) return null;
  if (value === null && nullable) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  return value.trim();
}

function normalizedImage(value: unknown, nullable = true): string | null {
  if (value === undefined && nullable) return null;
  if (value === null && nullable) return null;
  const image = normalizeProcessImage(value);
  if (image === null) {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  return image;
}

function normalizedPidField(value: unknown): number | null {
  // Listener fields were introduced after the original ownership format.
  // Missing fields are represented as null; present fields still receive the
  // same strict validation as spawned/pre-launch PIDs.
  if (value === undefined) return null;
  return pid(value, true);
}

function parseRecord(value: unknown): GatewayLaunchOwnershipRecord {
  const legacyFields = [
    "launchId",
    "desktopInstanceId",
    "desktopPid",
    "profileId",
    "preLaunchPid",
    "spawnedPid",
    "createdAt",
  ] as const;
  const evidenceFields = [
    ...legacyFields.slice(0, -1),
    "spawnedIdentity",
    "spawnedImage",
    "createdAt",
  ] as const;
  const listenerFields = [
    ...evidenceFields.slice(0, -1),
    "listenerPid",
    "listenerIdentity",
    "listenerImage",
    "createdAt",
  ] as const;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (!exactKeys(value, legacyFields) &&
      !exactKeys(value, evidenceFields) &&
      !exactKeys(value, listenerFields))
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
    // Version-1 ledgers did not capture process evidence. They remain
    // readable for upgrade/recovery, but the caller must treat their null
    // evidence as ambiguous and never signal the PID.
    spawnedIdentity: normalizedIdentity(record.spawnedIdentity),
    spawnedImage: normalizedImage(record.spawnedImage),
    // Legacy records have no separate listener identity.  Keep these null so
    // recovery can distinguish them from a v3 adoption and only use the
    // same-PID compatibility case when the PID file proves it exactly.
    listenerPid: normalizedPidField(record.listenerPid),
    listenerIdentity: normalizedIdentity(record.listenerIdentity),
    listenerImage: normalizedImage(record.listenerImage),
    createdAt: timestamp(record.createdAt),
  };
}

function parseStateWithVersion(
  value: unknown,
): ParsedGatewayProcessOwnershipState {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, ["version", "entries"])
  ) {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  const state = value as Record<string, unknown>;
  if (
    (state.version !== 1 &&
      state.version !== 2 &&
      state.version !== OWNERSHIP_SCHEMA_VERSION) ||
    !Array.isArray(state.entries)
  ) {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  const entries = state.entries.map(parseRecord);
  if (
    new Set(entries.map((entry) => entry.profileId)).size !== entries.length
  ) {
    throw new GatewayProcessOwnershipError("invalid_ownership");
  }
  return {
    state: { version: OWNERSHIP_SCHEMA_VERSION, entries },
    sourceVersion:
      state.version as ParsedGatewayProcessOwnershipState["sourceVersion"],
  };
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
      spawnedIdentity: null,
      spawnedImage: null,
      listenerPid: null,
      listenerIdentity: null,
      listenerImage: null,
      createdAt: createdAt(this.now),
    };
    this.replaceState({
      version: OWNERSHIP_SCHEMA_VERSION,
      entries: [...this.state.entries, record],
    });
    return { ...record };
  }

  markSpawned(input: MarkGatewaySpawnedInput): GatewayLaunchOwnershipRecord {
    const normalizedProfileId = profileId(input.profileId);
    const launchId = uuid(input.launchId);
    const spawnedPid = pid(input.spawnedPid, false);
    const spawnedIdentity = normalizedIdentity(input.spawnedIdentity);
    const spawnedImage = normalizedImage(input.spawnedImage);
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
    if (
      current.spawnedPid === spawnedPid &&
      ((current.spawnedIdentity !== null &&
        current.spawnedIdentity !== spawnedIdentity) ||
        (current.spawnedImage !== null &&
          current.spawnedImage !== spawnedImage))
    ) {
      throw new GatewayProcessOwnershipError("ownership_conflict");
    }
    const updated = {
      ...current,
      spawnedPid,
      spawnedIdentity,
      spawnedImage,
    };
    const entries = [...this.state.entries];
    entries[index] = updated;
    this.replaceState({ version: OWNERSHIP_SCHEMA_VERSION, entries });
    return { ...updated };
  }

  /**
   * Reserve a new launch transaction for an already-owned Profile.  The
   * previous listener evidence stays in the durable record until the new
   * listener is authenticated and adopted, so a failed restart can be
   * restored without ever creating an unowned live process window.
   */
  beginRestart(input: BeginGatewayRestartInput): BeginGatewayRestartResult {
    const normalizedProfileId = profileId(input.profileId);
    const preLaunchPid = pid(input.preLaunchPid, true);
    const index = this.state.entries.findIndex(
      (entry) => entry.profileId === normalizedProfileId,
    );
    const previous = this.state.entries[index];
    if (!previous || previous.desktopInstanceId !== this.desktopInstanceId) {
      throw new GatewayProcessOwnershipError("ownership_conflict");
    }
    const record: GatewayLaunchOwnershipRecord = {
      ...previous,
      launchId: uuid(this.randomUUID()),
      preLaunchPid,
      // The restart command gets a fresh short-lived wrapper. Keep the prior
      // listener fields as a rollback/ownership guard until adoption.
      spawnedPid: null,
      spawnedIdentity: null,
      spawnedImage: null,
      createdAt: createdAt(this.now),
    };
    const entries = [...this.state.entries];
    entries[index] = record;
    this.replaceState({ version: OWNERSHIP_SCHEMA_VERSION, entries });
    return { record: { ...record }, previous: { ...previous } };
  }

  /** Restore the exact prior record only if the restart transaction is still
   * the current durable owner.  A concurrent launch must win rather than be
   * overwritten by a stale failure callback.
   */
  restoreRestart(
    restartLaunchId: string,
    previous: GatewayLaunchOwnershipRecord,
  ): void {
    const launchId = uuid(restartLaunchId);
    const normalizedProfileId = profileId(previous.profileId);
    const index = this.state.entries.findIndex(
      (entry) => entry.profileId === normalizedProfileId,
    );
    const current = this.state.entries[index];
    if (
      !current ||
      current.launchId !== launchId ||
      current.desktopInstanceId !== this.desktopInstanceId
    ) {
      throw new GatewayProcessOwnershipError("ownership_conflict");
    }
    const entries = [...this.state.entries];
    entries[index] = { ...previous };
    this.replaceState({ version: OWNERSHIP_SCHEMA_VERSION, entries });
  }

  /**
   * Atomically transfer one current launch from its short-lived CLI wrapper to
   * the daemonized listener published by gateway.pid. The caller must name the
   * exact wrapper PID it previously recorded; stale or concurrent transitions
   * fail closed instead of adopting a replacement process.
   */
  adoptSpawnedPid(
    input: AdoptGatewaySpawnedPidInput,
  ): GatewayLaunchOwnershipRecord {
    const normalizedProfileId = profileId(input.profileId);
    const launchId = uuid(input.launchId);
    const previousSpawnedPid = pid(input.previousSpawnedPid, false);
    const spawnedPid = pid(input.spawnedPid, false);
    const listenerIdentity = normalizedIdentity(input.spawnedIdentity, false);
    const listenerImage = normalizedImage(input.spawnedImage, false);
    const index = this.state.entries.findIndex(
      (entry) => entry.profileId === normalizedProfileId,
    );
    const current = this.state.entries[index];
    if (
      !current ||
      current.launchId !== launchId ||
      current.desktopInstanceId !== this.desktopInstanceId ||
      current.spawnedPid !== previousSpawnedPid ||
      spawnedPid === current.preLaunchPid ||
      (current.spawnedIdentity !== null &&
        (normalizedIdentity(input.previousSpawnedIdentity) !==
          current.spawnedIdentity ||
          normalizedImage(input.previousSpawnedImage) !== current.spawnedImage))
    ) {
      throw new GatewayProcessOwnershipError("ownership_conflict");
    }
    if (
      !input.replaceExistingListener &&
      current.listenerPid !== null &&
      (current.listenerPid !== spawnedPid ||
        current.listenerIdentity !== listenerIdentity ||
        current.listenerImage !== listenerImage)
    ) {
      throw new GatewayProcessOwnershipError("ownership_conflict");
    }
    const updated = {
      ...current,
      listenerPid: spawnedPid,
      listenerIdentity,
      listenerImage,
    };
    const entries = [...this.state.entries];
    entries[index] = updated;
    this.replaceState({ version: OWNERSHIP_SCHEMA_VERSION, entries });
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
      version: OWNERSHIP_SCHEMA_VERSION,
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
    // A pending artifact can be created (or become unusable) after this
    // ledger instance was constructed, for example while another process is
    // committing a launch record.  Refresh the on-disk guard before callers
    // authorize a start/TERM/KILL; a directory, truncated file, or malformed
    // pending payload is a persistence ambiguity, never an empty ledger.
    if (this.loadIssue === null && existsSync(this.pendingPath)) {
      if (this.readCandidateWithVersion(this.pendingPath) === null) {
        this.loadIssue = "ownership_persistence_failed";
      }
    }
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
      // A v1 record has no creation identity or executable image.  It is
      // intentionally retained as an ambiguous durable guard even when its
      // PID file is gone or the old process is no longer alive: treating that
      // absence as proof of ownership would make a later PID reuse eligible
      // for an automatic TERM/KILL.  A future explicit launch can replace
      // the record after an operator has resolved the ambiguity.
      const hasListenerOwnership = entry.listenerPid !== null;
      if (
        (hasListenerOwnership &&
          (entry.listenerIdentity === null || entry.listenerImage === null)) ||
        (!hasListenerOwnership &&
          (entry.spawnedIdentity === null || entry.spawnedImage === null))
      ) {
        ambiguousProfiles.push(entry.profileId);
        continue;
      }
      let currentPid: number | null;
      try {
        currentPid = pid(input.readCurrentPid(entry.profileId), true);
      } catch {
        ambiguousProfiles.push(entry.profileId);
        continue;
      }
      if (currentPid === null) {
        const knownPids = [entry.listenerPid, entry.spawnedPid].filter(
          (value, index, values): value is number =>
            value !== null && values.indexOf(value) === index,
        );
        if (knownPids.length === 0) {
          remove.add(entry.profileId);
          continue;
        }
        try {
          if (knownPids.some((knownPid) => input.isAlive(knownPid))) {
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
        // A stale PID file may coexist with a still-live wrapper/listener.
        // Only discard the durable intent after every known identity is gone.
        const knownPids = [entry.listenerPid, entry.spawnedPid].filter(
          (value, index, values): value is number =>
            value !== null && values.indexOf(value) === index,
        );
        try {
          if (knownPids.some((knownPid) => input.isAlive(knownPid))) {
            ambiguousProfiles.push(entry.profileId);
          } else {
            const listenerPid =
              entry.listenerPid ??
              (entry.spawnedPid === currentPid ? entry.spawnedPid : null);
            if (
              listenerPid === currentPid &&
              input.clearDeadListenerPid !== undefined &&
              !input.clearDeadListenerPid(entry.profileId, currentPid)
            ) {
              ambiguousProfiles.push(entry.profileId);
              continue;
            }
            remove.add(entry.profileId);
          }
        } catch {
          ambiguousProfiles.push(entry.profileId);
        }
        continue;
      }
      if (currentPid === entry.preLaunchPid) {
        // The pre-launch PID is explicitly not ours, but it may still occupy
        // gateway.pid while this launch's wrapper/listener remains live. Do
        // not let that stale marker erase the only durable ownership proof.
        const otherKnownPids = [entry.listenerPid, entry.spawnedPid].filter(
          (knownPid, index, values): knownPid is number =>
            knownPid !== null &&
            knownPid !== currentPid &&
            values.indexOf(knownPid) === index,
        );
        try {
          if (otherKnownPids.some((knownPid) => input.isAlive(knownPid))) {
            ambiguousProfiles.push(entry.profileId);
            continue;
          }
        } catch {
          ambiguousProfiles.push(entry.profileId);
          continue;
        }
        remove.add(entry.profileId);
        continue;
      }
      // A v3 record names the daemon listener explicitly.  For v1/v2 records
      // there is no listener field; the only safe compatibility case is when
      // the PID file still names the exact spawned PID (no daemon hand-off).
      const listenerPid =
        entry.listenerPid !== null
          ? entry.listenerPid
          : entry.spawnedPid === currentPid
            ? entry.spawnedPid
            : null;
      const listenerIdentity =
        entry.listenerPid !== null
          ? entry.listenerIdentity
          : entry.spawnedIdentity;
      const listenerImage =
        entry.listenerPid !== null ? entry.listenerImage : entry.spawnedImage;
      if (
        listenerPid === null ||
        currentPid !== listenerPid ||
        listenerIdentity === null ||
        listenerImage === null
      ) {
        ambiguousProfiles.push(entry.profileId);
        continue;
      }
      // A live matching PID is not enough. A v1/partially-written record or
      // an unavailable identity probe is deliberately ambiguous and remains
      // durable for a later, better-evidenced recovery attempt.
      if (input.readEvidence === undefined) {
        ambiguousProfiles.push(entry.profileId);
        continue;
      }
      let evidence: ProcessIdentityEvidence | null;
      try {
        evidence = input.readEvidence(currentPid);
      } catch {
        evidence = null;
      }
      if (
        !processEvidenceMatches(evidence, {
          identity: listenerIdentity,
          image: listenerImage,
        })
      ) {
        ambiguousProfiles.push(entry.profileId);
        continue;
      }
      ownedProfiles.push(entry.profileId);
    }
    if (remove.size > 0) {
      this.replaceState({
        version: OWNERSHIP_SCHEMA_VERSION,
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
    const pending = this.readCandidateWithVersion(this.pendingPath);
    if (pending !== null) {
      if (pending.sourceVersion !== OWNERSHIP_SCHEMA_VERSION) {
        try {
          // Normalize legacy bytes through the same new-pending + fsync +
          // atomic-promotion transaction used by ordinary writes.  Never
          // open the only legacy pending file with `w`: an interrupted
          // migration must leave a complete v1/v2 record recoverable.
          this.persist(pending.state);
        } catch {
          this.loadIssue = "ownership_persistence_failed";
          return pending.state;
        }
      }
      try {
        this.promotePending();
      } catch {
        this.loadIssue = "ownership_persistence_failed";
      }
      return pending.state;
    }
    if (pendingExists) {
      this.loadIssue = "ownership_persistence_failed";
      try {
        unlinkSync(this.pendingPath);
      } catch {
        // Keep the invalid pending artifact observable and fail future writes.
      }
    }

    const canonical = this.readCandidateWithVersion(this.path);
    if (canonical !== null) {
      if (canonical.sourceVersion !== OWNERSHIP_SCHEMA_VERSION) {
        try {
          // Rewrite the normalized v3 bytes through the same fsynced pending
          // commit path used by ordinary ledger transitions.  If the rewrite
          // is unavailable, keep the parsed legacy record and surface the
          // persistence issue; never discard the durable v1 intent.
          this.persist(canonical.state);
        } catch {
          this.loadIssue = "ownership_persistence_failed";
        }
      }
      return canonical.state;
    }

    const backup = this.readCandidateWithVersion(this.backupPath);
    if (backup !== null) {
      this.loadIssue = "ownership_persistence_failed";
      return backup.state;
    }

    if (
      existsSync(this.path) ||
      existsSync(this.pendingPath) ||
      existsSync(this.backupPath)
    ) {
      this.loadIssue = "invalid_ownership";
    }
    return { version: OWNERSHIP_SCHEMA_VERSION, entries: [] };
  }

  private readCandidate(path: string): GatewayProcessOwnershipState | null {
    return this.readCandidateWithVersion(path)?.state ?? null;
  }

  private readCandidateWithVersion(
    path: string,
  ): ParsedGatewayProcessOwnershipState | null {
    if (!existsSync(path)) return null;
    try {
      return parseStateWithVersion(JSON.parse(readFileSync(path, "utf8")));
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
