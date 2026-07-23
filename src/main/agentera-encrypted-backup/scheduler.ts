import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAXIMUM_SCHEDULE_BYTES = 1024 * 1024;
const DEFAULT_INTERVAL_MILLISECONDS = 15 * 60 * 1000;

export interface EncryptedBackupDailySchedule {
  accountId: string;
  installationId: string;
  profileLineageId: string;
  enabled: boolean;
  lastAttemptDay: string | null;
  updatedAt: string;
}

export interface EncryptedBackupScheduleStoreLike {
  list(): EncryptedBackupDailySchedule[];
  set(input: {
    accountId: string;
    installationId: string;
    profileLineageId: string;
    enabled: boolean;
    updatedAt: Date;
  }): EncryptedBackupDailySchedule;
  markAttempt(
    accountId: string,
    profileLineageId: string,
    day: string,
    updatedAt: Date,
  ): void;
}

export interface EncryptedBackupSchedulerReadiness {
  authenticatedAccountId: string | null;
  online: boolean;
  idle: boolean;
}

export interface AgenteraEncryptedBackupSchedulerOptions {
  store: EncryptedBackupScheduleStoreLike;
  getReadiness: () => EncryptedBackupSchedulerReadiness;
  createBackup: (installationId: string) => Promise<unknown>;
  now?: () => Date;
  intervalMs?: number;
  onFailure?: (failure: { installationId: string; code: string }) => void;
}

interface ScheduleFile {
  version: 1;
  schedules: EncryptedBackupDailySchedule[];
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    throw new Error(`Invalid encrypted backup ${label}.`);
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Encrypted backup schedule timestamp is invalid.");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Encrypted backup schedule timestamp is invalid.");
  }
  return value;
}

function exactObject(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Encrypted backup schedule is invalid.");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  const expected = [...fields].sort();
  if (
    keys.length !== expected.length ||
    keys.some((field, index) => field !== expected[index])
  ) {
    throw new Error("Encrypted backup schedule is invalid.");
  }
  return object;
}

function validateSchedule(value: unknown): EncryptedBackupDailySchedule {
  const schedule = exactObject(value, [
    "accountId",
    "installationId",
    "profileLineageId",
    "enabled",
    "lastAttemptDay",
    "updatedAt",
  ]);
  if (
    typeof schedule.enabled !== "boolean" ||
    (schedule.lastAttemptDay !== null &&
      (typeof schedule.lastAttemptDay !== "string" ||
        !DAY_PATTERN.test(schedule.lastAttemptDay)))
  ) {
    throw new Error("Encrypted backup schedule is invalid.");
  }
  return {
    accountId: identifier(schedule.accountId, "account ID"),
    installationId: identifier(schedule.installationId, "Installation ID"),
    profileLineageId: identifier(
      schedule.profileLineageId,
      "Profile lineage ID",
    ),
    enabled: schedule.enabled,
    lastAttemptDay: schedule.lastAttemptDay,
    updatedAt: timestamp(schedule.updatedAt),
  };
}

function failureCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
  ) {
    return error.code;
  }
  return "backup_failed";
}

export class EncryptedBackupScheduleStore implements EncryptedBackupScheduleStoreLike {
  readonly path: string;

  constructor(path: string) {
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new Error("Encrypted backup schedule path must be absolute.");
    }
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(this.path));
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw new Error("Encrypted backup schedule directory is unsafe.");
    }
    chmodSync(dirname(this.path), 0o700);
  }

  list(): EncryptedBackupDailySchedule[] {
    return this.read().schedules.map((schedule) => ({ ...schedule }));
  }

  set(input: {
    accountId: string;
    installationId: string;
    profileLineageId: string;
    enabled: boolean;
    updatedAt: Date;
  }): EncryptedBackupDailySchedule {
    const accountId = identifier(input.accountId, "account ID");
    const installationId = identifier(input.installationId, "Installation ID");
    const profileLineageId = identifier(
      input.profileLineageId,
      "Profile lineage ID",
    );
    if (typeof input.enabled !== "boolean") {
      throw new Error("Invalid encrypted backup schedule state.");
    }
    const schedules = this.read().schedules;
    const existing = schedules.find(
      (schedule) =>
        schedule.accountId === accountId &&
        schedule.profileLineageId === profileLineageId,
    );
    const next: EncryptedBackupDailySchedule = {
      accountId,
      installationId,
      profileLineageId,
      enabled: input.enabled,
      lastAttemptDay: existing?.lastAttemptDay ?? null,
      updatedAt: input.updatedAt.toISOString(),
    };
    const retained = schedules.filter(
      (schedule) =>
        schedule.accountId !== accountId ||
        schedule.profileLineageId !== profileLineageId,
    );
    retained.push(next);
    this.write({ version: 1, schedules: retained });
    return { ...next };
  }

  markAttempt(
    accountIdValue: string,
    profileLineageIdValue: string,
    day: string,
    updatedAt: Date,
  ): void {
    const accountId = identifier(accountIdValue, "account ID");
    const profileLineageId = identifier(
      profileLineageIdValue,
      "Profile lineage ID",
    );
    if (!DAY_PATTERN.test(day)) {
      throw new Error("Invalid encrypted backup schedule day.");
    }
    const file = this.read();
    const schedule = file.schedules.find(
      (value) =>
        value.accountId === accountId &&
        value.profileLineageId === profileLineageId,
    );
    if (!schedule) {
      throw new Error("Encrypted backup schedule is unavailable.");
    }
    schedule.lastAttemptDay = day;
    schedule.updatedAt = updatedAt.toISOString();
    this.write(file);
  }

  private read(): ScheduleFile {
    if (!existsSync(this.path)) return { version: 1, schedules: [] };
    const stats = lstatSync(this.path);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.size < 2 ||
      stats.size > MAXIMUM_SCHEDULE_BYTES
    ) {
      throw new Error("Encrypted backup schedule file is unsafe.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      throw new Error("Encrypted backup schedule file is invalid.");
    }
    const file = exactObject(parsed, ["version", "schedules"]);
    if (file.version !== 1 || !Array.isArray(file.schedules)) {
      throw new Error("Encrypted backup schedule file is invalid.");
    }
    const schedules = file.schedules.map(validateSchedule);
    const identities = new Set<string>();
    for (const schedule of schedules) {
      const identity = `${schedule.accountId}\0${schedule.profileLineageId}`;
      if (identities.has(identity)) {
        throw new Error("Encrypted backup schedule is duplicated.");
      }
      identities.add(identity);
    }
    return { version: 1, schedules };
  }

  private write(file: ScheduleFile): void {
    const validated = {
      version: 1 as const,
      schedules: file.schedules.map(validateSchedule).sort((left, right) => {
        const leftKey = `${left.accountId}/${left.profileLineageId}`;
        const rightKey = `${right.accountId}/${right.profileLineageId}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
    };
    const payload = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
    if (payload.byteLength > MAXIMUM_SCHEDULE_BYTES) {
      payload.fill(0);
      throw new Error("Encrypted backup schedule file is too large.");
    }
    const temporaryPath = `${this.path}.tmp`;
    rmSync(temporaryPath, { force: true });
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, payload);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporaryPath, this.path);
      chmodSync(this.path, 0o600);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      payload.fill(0);
      rmSync(temporaryPath, { force: true });
    }
  }
}

export class AgenteraEncryptedBackupScheduler {
  private readonly store: EncryptedBackupScheduleStoreLike;
  private readonly getReadiness: () => EncryptedBackupSchedulerReadiness;
  private readonly createBackup: (installationId: string) => Promise<unknown>;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly onFailure:
    | ((failure: { installationId: string; code: string }) => void)
    | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: AgenteraEncryptedBackupSchedulerOptions) {
    this.store = options.store;
    this.getReadiness = options.getReadiness;
    this.createBackup = options.createBackup;
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MILLISECONDS;
    this.onFailure = options.onFailure;
    if (
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 60_000 ||
      this.intervalMs > 24 * 60 * 60 * 1000
    ) {
      throw new Error("Invalid encrypted backup scheduler interval.");
    }
  }

  setDailySchedule(input: {
    accountId: string;
    installationId: string;
    profileLineageId: string;
    enabled: boolean;
  }): EncryptedBackupDailySchedule {
    return this.store.set({ ...input, updatedAt: this.now() });
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const readiness = this.getReadiness();
      if (
        readiness.authenticatedAccountId === null ||
        !readiness.online ||
        !readiness.idle
      ) {
        return;
      }
      const now = this.now();
      const day = now.toISOString().slice(0, 10);
      const due = this.store
        .list()
        .filter(
          (schedule) =>
            schedule.enabled &&
            schedule.accountId === readiness.authenticatedAccountId &&
            schedule.lastAttemptDay !== day,
        );
      for (const schedule of due) {
        this.store.markAttempt(
          schedule.accountId,
          schedule.profileLineageId,
          day,
          now,
        );
        try {
          await this.createBackup(schedule.installationId);
        } catch (error) {
          try {
            this.onFailure?.({
              installationId: schedule.installationId,
              code: failureCode(error),
            });
          } catch {
            // Scheduler failures never affect the chat/runtime path.
          }
        }
      }
    } catch {
      // Readiness and local schedule failures stay isolated from chat.
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
