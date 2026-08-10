import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  DesktopHealthCode,
  DesktopHealthSummary,
} from "../../shared/agentera-desktop-control";

const MAX_RECORDS = 32;
const MAX_FILE_BYTES = 256 * 1024;

export interface DesktopControlPrincipalKey {
  userId: string;
  deviceId: string;
}

export interface DesktopControlTerminalResult {
  state: "succeeded" | "failed";
  code: DesktopHealthCode;
  summary: DesktopHealthSummary;
  completedAt: string;
}

export interface DesktopControlJournalRecord {
  userId: string;
  deviceId: string;
  commandId: string;
  state: "running" | "terminal";
  result?: DesktopControlTerminalResult;
  createdAt: string;
  updatedAt: string;
}

interface JournalFile {
  version: 1;
  records: DesktopControlJournalRecord[];
}

export class DesktopControlJournal {
  private readonly directory: string;
  private readonly file: string;
  private records: DesktopControlJournalRecord[];

  constructor(userDataPath: string) {
    this.directory = join(userDataPath, "agentera-desktop-control");
    this.file = join(this.directory, "state.json");
    this.records = this.read();
  }

  get(
    principal: DesktopControlPrincipalKey,
    commandId: string,
  ): DesktopControlJournalRecord | null {
    return (
      this.records.find((record) =>
        this.matches(record, principal, commandId),
      ) ?? null
    );
  }

  listPending(
    principal: DesktopControlPrincipalKey,
  ): DesktopControlJournalRecord[] {
    return this.records.filter(
      (record) =>
        record.userId === principal.userId &&
        record.deviceId === principal.deviceId,
    );
  }

  markRunning(principal: DesktopControlPrincipalKey, commandId: string): void {
    const now = new Date().toISOString();
    const existing = this.get(principal, commandId);
    if (existing) {
      existing.state = "running";
      delete existing.result;
      existing.updatedAt = now;
    } else {
      this.records.unshift({
        userId: principal.userId,
        deviceId: principal.deviceId,
        commandId,
        state: "running",
        createdAt: now,
        updatedAt: now,
      });
    }
    this.trimAndWrite();
  }

  saveTerminal(
    principal: DesktopControlPrincipalKey,
    commandId: string,
    result: DesktopControlTerminalResult,
  ): void {
    const now = new Date().toISOString();
    const existing = this.get(principal, commandId);
    if (existing) {
      existing.state = "terminal";
      existing.result = result;
      existing.updatedAt = now;
    } else {
      this.records.unshift({
        userId: principal.userId,
        deviceId: principal.deviceId,
        commandId,
        state: "terminal",
        result,
        createdAt: now,
        updatedAt: now,
      });
    }
    this.trimAndWrite();
  }

  markDelivered(
    principal: DesktopControlPrincipalKey,
    commandId: string,
  ): void {
    this.records = this.records.filter(
      (record) => !this.matches(record, principal, commandId),
    );
    this.trimAndWrite();
  }

  close(): void {
    this.trimAndWrite();
  }

  private matches(
    record: DesktopControlJournalRecord,
    principal: DesktopControlPrincipalKey,
    commandId: string,
  ): boolean {
    return (
      record.userId === principal.userId &&
      record.deviceId === principal.deviceId &&
      record.commandId === commandId
    );
  }

  private trimAndWrite(): void {
    this.records = this.records.slice(0, MAX_RECORDS);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp-${process.pid}`;
    const serialized = JSON.stringify({
      version: 1,
      records: this.records,
    } satisfies JournalFile);
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
    chmodSync(this.file, 0o600);
  }

  private read(): DesktopControlJournalRecord[] {
    try {
      if (!existsSync(this.file) || statSync(this.file).size > MAX_FILE_BYTES)
        return [];
      const parsed = JSON.parse(
        readFileSync(this.file, "utf8"),
      ) as Partial<JournalFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) return [];
      return parsed.records
        .filter((record): record is DesktopControlJournalRecord => {
          if (!record || typeof record !== "object") return false;
          return (
            typeof record.userId === "string" &&
            typeof record.deviceId === "string" &&
            typeof record.commandId === "string" &&
            (record.state === "running" || record.state === "terminal") &&
            typeof record.createdAt === "string" &&
            typeof record.updatedAt === "string" &&
            (record.state === "running" || Boolean(record.result))
          );
        })
        .slice(0, MAX_RECORDS);
    } catch {
      return [];
    }
  }
}
