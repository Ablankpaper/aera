// @vitest-environment node

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { OfficialQualityEnvelope } from "../../shared/agentera-official-quality";
import {
  AGENTERA_OFFICIAL_QUALITY_SCHEMA_VERSION,
  openAgenteraOfficialQualityDatabase,
  resolveAgenteraOfficialQualityPaths,
  type AgenteraOfficialQualityDatabase,
  type AgenteraOfficialQualitySqliteDatabase,
} from "./db";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const DEVICE_ID = "20000000-0000-4000-8000-000000000001";
const UPDATED_AT = new Date("2026-07-23T12:00:00.000Z");
const roots: string[] = [];
const databases: AgenteraOfficialQualityDatabase[] = [];
const originalHermesHome = process.env.HERMES_HOME;

function temporaryUserData(): string {
  const root = mkdtempSync(join(tmpdir(), "agentera-official-quality-db-"));
  roots.push(root);
  return join(root, "user-data");
}

function databaseFor(
  userDataPath = temporaryUserData(),
): AgenteraOfficialQualityDatabase {
  const database = openAgenteraOfficialQualityDatabase(userDataPath, {
    databaseFactory: (path) =>
      new DatabaseSync(
        path,
      ) as unknown as AgenteraOfficialQualitySqliteDatabase,
  });
  databases.push(database);
  return database;
}

afterEach(() => {
  delete process.env.HERMES_HOME;
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  if (originalHermesHome !== undefined) {
    process.env.HERMES_HOME = originalHermesHome;
  }
});

describe("AgenteraOfficialQualityDatabase", () => {
  it("opens the exact restrictive userData database outside HERMES_HOME", () => {
    expect(() => resolveAgenteraOfficialQualityPaths("relative/path")).toThrow(
      "absolute",
    );
    const userDataPath = temporaryUserData();
    expect(resolveAgenteraOfficialQualityPaths(userDataPath)).toEqual({
      rootPath: join(userDataPath, "agentera-official-quality"),
      databasePath: join(
        userDataPath,
        "agentera-official-quality",
        "quality.db",
      ),
    });
    process.env.HERMES_HOME = join(userDataPath, "agentera-official-quality");
    expect(() => databaseFor(userDataPath)).toThrow("outside HERMES_HOME");
    delete process.env.HERMES_HOME;

    const database = databaseFor(userDataPath);
    // Node's POSIX mode projection is not Windows DACL evidence; the DACL
    // remains part of the physical-Windows release gate.
    if (process.platform !== "win32") {
      expect(statSync(database.paths.rootPath).mode & 0o777).toBe(0o700);
      expect(statSync(database.paths.databasePath).mode & 0o777).toBe(0o600);
    }
  });

  it("initializes versioned consent disabled for both independent purposes", () => {
    const database = databaseFor();
    expect(database.readConsent(ACCOUNT_ID, DEVICE_ID)).toEqual({
      passive: false,
      explicitFeedback: false,
    });
    expect(
      database.readConsentReceipt(
        ACCOUNT_ID,
        DEVICE_ID,
        "official_quality_metrics",
      ),
    ).toEqual({
      purpose: "official_quality_metrics",
      enabled: false,
      version: 0,
      updatedAt: null,
    });
    expect(
      database.readConsentReceipt(
        ACCOUNT_ID,
        DEVICE_ID,
        "official_explicit_feedback",
      ),
    ).toEqual({
      purpose: "official_explicit_feedback",
      enabled: false,
      version: 0,
      updatedAt: null,
    });
  });

  it("creates only a consent table and content-free outbox schema", () => {
    const database = databaseFor();
    const version = database.sqlite.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(AGENTERA_OFFICIAL_QUALITY_SCHEMA_VERSION);
    const tables = database.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "official_quality_consent",
      "official_quality_outbox",
    ]);
    const columns = database.sqlite
      .prepare("PRAGMA table_info(official_quality_outbox)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual([
      "event_id",
      "account_id",
      "device_id",
      "purpose",
      "consent_version",
      "event_day",
      "envelope_json",
      "attempt_count",
      "next_attempt_at",
      "created_at",
      "expires_at",
    ]);
    const normalized = columns.join(" ").toLowerCase();
    for (const forbidden of [
      "prompt",
      "response",
      "error",
      "path",
      "session",
      "conversation",
      "profile",
      "installation",
      "runtime_binding",
      "memory",
      "skill",
      "curator",
      "attachment",
    ]) {
      expect(normalized).not.toContain(forbidden);
    }
  });

  it("persists only a canonical public envelope after active exact consent", () => {
    const database = databaseFor();
    const consent = database.setConsent(
      ACCOUNT_ID,
      DEVICE_ID,
      "official_quality_metrics",
      true,
      UPDATED_AT,
    );
    const envelope = {
      protocol_version: 1,
      consent_version: consent.version,
      event_id: "019f0000-0000-7000-8000-000000000001",
      platform_id: "30000000-0000-4000-8000-000000000001",
      definition_id: "40000000-0000-4000-8000-000000000001",
      version_id: "50000000-0000-4000-8000-000000000001",
      release_id: "60000000-0000-4000-8000-000000000001",
      release_revision_id: "70000000-0000-4000-8000-000000000001",
      desktop_version: "1.8.0",
      runtime_version: "1.2.0",
      event_day: "2026-07-23",
      kind: "metric",
      result: "success",
      latency_bucket: "lt_1s",
      total_token_bucket: "1_1k",
      crash_code: null,
      feedback_rating: null,
      feedback_reason_codes: [],
      binding_proof: "80000000-0000-4000-8000-000000000001",
      device_signature: "A".repeat(86),
    };
    database.enqueue({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      purpose: "official_quality_metrics",
      envelope,
      now: UPDATED_AT,
    });
    const row = database.sqlite
      .prepare(
        "SELECT envelope_json, attempt_count, next_attempt_at FROM official_quality_outbox WHERE event_id = ?",
      )
      .get(envelope.event_id) as {
      envelope_json: string;
      attempt_count: number;
      next_attempt_at: string;
    };
    expect(JSON.parse(row.envelope_json)).toEqual(envelope);
    expect(row.attempt_count).toBe(0);
    expect(row.next_attempt_at).toBe(UPDATED_AT.toISOString());

    expect(() =>
      database.enqueue({
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        purpose: "official_quality_metrics",
        envelope: { ...envelope, note: "private-canary" },
        now: UPDATED_AT,
      }),
    ).toThrow("quality envelope");
    const count = database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM official_quality_outbox")
      .get() as { count: number };
    expect(count.count).toBe(1);
  });

  it("rejects future schemas without modifying them", () => {
    const userDataPath = temporaryUserData();
    const paths = resolveAgenteraOfficialQualityPaths(userDataPath);
    const first = databaseFor(userDataPath);
    first.sqlite.exec("PRAGMA user_version = 99");
    first.close();
    databases.splice(databases.indexOf(first), 1);
    expect(() => databaseFor(userDataPath)).toThrow("Unsupported");
    const probe = new DatabaseSync(paths.databasePath);
    expect(
      (probe.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(99);
    probe.close();
  });

  it("bounds, retries, expires, and purges the account-scoped outbox", () => {
    const database = databaseFor();
    const passive = database.setConsent(
      ACCOUNT_ID,
      DEVICE_ID,
      "official_quality_metrics",
      true,
      UPDATED_AT,
    );
    const explicit = database.setConsent(
      ACCOUNT_ID,
      DEVICE_ID,
      "official_explicit_feedback",
      true,
      UPDATED_AT,
    );
    const makeEnvelope = (
      suffix: string,
      kind: "metric" | "explicit_feedback",
    ): OfficialQualityEnvelope => ({
      protocol_version: 1,
      consent_version: kind === "metric" ? passive.version : explicit.version,
      event_id: `019f0000-0000-7000-8000-${suffix.padStart(12, "0")}`,
      platform_id: "30000000-0000-4000-8000-000000000001",
      definition_id: "40000000-0000-4000-8000-000000000001",
      version_id: "50000000-0000-4000-8000-000000000001",
      release_id: "60000000-0000-4000-8000-000000000001",
      release_revision_id: "70000000-0000-4000-8000-000000000001",
      desktop_version: "1.8.0",
      runtime_version: "1.2.0",
      event_day: "2026-07-23",
      kind,
      result: "success",
      latency_bucket: "lt_1s",
      total_token_bucket: "1_1k",
      crash_code: null,
      feedback_rating: kind === "metric" ? null : "helpful",
      feedback_reason_codes: [],
      binding_proof: "80000000-0000-4000-8000-000000000001",
      device_signature: "A".repeat(86),
    });

    database.enqueue({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      purpose: "official_explicit_feedback",
      envelope: makeEnvelope("1", "explicit_feedback"),
      now: UPDATED_AT,
    });
    for (let index = 2; index <= 1_000; index += 1) {
      database.enqueue({
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        purpose: "official_quality_metrics",
        envelope: makeEnvelope(index.toString(16), "metric"),
        now: new Date(UPDATED_AT.getTime() + index),
      });
    }
    database.enqueue({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      purpose: "official_explicit_feedback",
      envelope: makeEnvelope("fff", "explicit_feedback"),
      now: new Date(UPDATED_AT.getTime() + 2_000),
    });
    expect(database.countOutbox(ACCOUNT_ID, DEVICE_ID)).toBe(1_000);
    expect(
      database.sqlite
        .prepare(
          "SELECT purpose FROM official_quality_outbox WHERE event_id = ?",
        )
        .get("019f0000-0000-7000-8000-000000000001"),
    ).toEqual({ purpose: "official_explicit_feedback" });
    expect(
      database.sqlite
        .prepare(
          "SELECT purpose FROM official_quality_outbox WHERE event_id = ?",
        )
        .get("019f0000-0000-7000-8000-000000000fff"),
    ).toEqual({ purpose: "official_explicit_feedback" });

    const due = database.listDue(
      ACCOUNT_ID,
      DEVICE_ID,
      new Date(UPDATED_AT.getTime() + 3_000),
      1,
    );
    expect(due).toHaveLength(1);
    const nextAttempt = new Date(UPDATED_AT.getTime() + 60_000);
    database.recordRetry(ACCOUNT_ID, DEVICE_ID, due[0].eventId, nextAttempt);
    expect(
      database.listDue(
        ACCOUNT_ID,
        DEVICE_ID,
        new Date(UPDATED_AT.getTime() + 30_000),
        10,
      ),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventId: due[0].eventId }),
      ]),
    );

    database.purgePurpose(ACCOUNT_ID, DEVICE_ID, "official_quality_metrics");
    expect(database.countOutbox(ACCOUNT_ID, DEVICE_ID)).toBe(2);
    database.purgeAccount(ACCOUNT_ID);
    expect(database.countOutbox(ACCOUNT_ID, DEVICE_ID)).toBe(0);
  }, 90_000);
});
