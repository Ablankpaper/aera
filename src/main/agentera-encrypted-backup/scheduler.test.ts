// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgenteraEncryptedBackupScheduler,
  EncryptedBackupScheduleStore,
  type EncryptedBackupDailySchedule,
  type EncryptedBackupScheduleStoreLike,
} from "./scheduler";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "10000000-0000-4000-8000-000000000002";
const LINEAGE_ID = "30000000-0000-4000-8000-000000000001";
const INSTALLATION_ID = "40000000-0000-4000-8000-000000000001";

class MemoryScheduleStore implements EncryptedBackupScheduleStoreLike {
  records: EncryptedBackupDailySchedule[] = [];

  list(): EncryptedBackupDailySchedule[] {
    return structuredClone(this.records);
  }

  set(input: {
    accountId: string;
    installationId: string;
    profileLineageId: string;
    enabled: boolean;
    updatedAt: Date;
  }): EncryptedBackupDailySchedule {
    const existing = this.records.find(
      (record) =>
        record.accountId === input.accountId &&
        record.profileLineageId === input.profileLineageId,
    );
    const next = {
      accountId: input.accountId,
      installationId: input.installationId,
      profileLineageId: input.profileLineageId,
      enabled: input.enabled,
      lastAttemptDay: existing?.lastAttemptDay ?? null,
      updatedAt: input.updatedAt.toISOString(),
    };
    this.records = this.records.filter(
      (record) =>
        record.accountId !== input.accountId ||
        record.profileLineageId !== input.profileLineageId,
    );
    this.records.push(next);
    return structuredClone(next);
  }

  markAttempt(
    accountId: string,
    profileLineageId: string,
    day: string,
    updatedAt: Date,
  ): void {
    const record = this.records.find(
      (value) =>
        value.accountId === accountId &&
        value.profileLineageId === profileLineageId,
    );
    if (!record) throw new Error("missing schedule");
    record.lastAttemptDay = day;
    record.updatedAt = updatedAt.toISOString();
  }
}

describe("AgenteraEncryptedBackupScheduler", () => {
  it("persists an opt-in schedule in a private local file", () => {
    const root = mkdtempSync(join(tmpdir(), "agentera-schedule-"));
    try {
      const path = join(root, "backup", "schedule.json");
      const store = new EncryptedBackupScheduleStore(path);
      expect(store.list()).toEqual([]);
      store.set({
        accountId: ACCOUNT_ID,
        installationId: INSTALLATION_ID,
        profileLineageId: LINEAGE_ID,
        enabled: true,
        updatedAt: new Date("2026-07-23T12:00:00.000Z"),
      });
      expect(new EncryptedBackupScheduleStore(path).list()).toEqual([
        expect.objectContaining({
          accountId: ACCOUNT_ID,
          installationId: INSTALLATION_ID,
          profileLineageId: LINEAGE_ID,
          enabled: true,
          lastAttemptDay: null,
        }),
      ]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is off by default and runs at most once per UTC day when authenticated, online, and idle", async () => {
    const store = new MemoryScheduleStore();
    const createBackup = vi.fn(async () => undefined);
    let readiness = {
      authenticatedAccountId: ACCOUNT_ID as string | null,
      online: true,
      idle: true,
    };
    let now = new Date("2026-07-23T12:00:00.000Z");
    const scheduler = new AgenteraEncryptedBackupScheduler({
      store,
      getReadiness: () => readiness,
      createBackup,
      now: () => now,
    });

    await scheduler.tick();
    expect(createBackup).not.toHaveBeenCalled();

    scheduler.setDailySchedule({
      accountId: ACCOUNT_ID,
      installationId: INSTALLATION_ID,
      profileLineageId: LINEAGE_ID,
      enabled: true,
    });
    for (const blocked of [
      { authenticatedAccountId: null, online: true, idle: true },
      {
        authenticatedAccountId: OTHER_ACCOUNT_ID,
        online: true,
        idle: true,
      },
      {
        authenticatedAccountId: ACCOUNT_ID,
        online: false,
        idle: true,
      },
      {
        authenticatedAccountId: ACCOUNT_ID,
        online: true,
        idle: false,
      },
    ]) {
      readiness = blocked;
      await scheduler.tick();
    }
    expect(createBackup).not.toHaveBeenCalled();

    readiness = {
      authenticatedAccountId: ACCOUNT_ID,
      online: true,
      idle: true,
    };
    await scheduler.tick();
    await scheduler.tick();
    expect(createBackup).toHaveBeenCalledTimes(1);

    now = new Date("2026-07-24T00:01:00.000Z");
    await scheduler.tick();
    expect(createBackup).toHaveBeenCalledTimes(2);
  });

  it("marks the daily attempt before execution and swallows failure without a catch-up storm", async () => {
    const store = new MemoryScheduleStore();
    store.set({
      accountId: ACCOUNT_ID,
      installationId: INSTALLATION_ID,
      profileLineageId: LINEAGE_ID,
      enabled: true,
      updatedAt: new Date("2026-07-23T00:00:00.000Z"),
    });
    const createBackup = vi.fn(async () => {
      throw new Error("offline after start");
    });
    const onFailure = vi.fn();
    const scheduler = new AgenteraEncryptedBackupScheduler({
      store,
      getReadiness: () => ({
        authenticatedAccountId: ACCOUNT_ID,
        online: true,
        idle: true,
      }),
      createBackup,
      onFailure,
      now: () => new Date("2026-07-23T12:00:00.000Z"),
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({
      installationId: INSTALLATION_ID,
      code: "backup_failed",
    });
    expect(store.records[0].lastAttemptDay).toBe("2026-07-23");
  });
});
