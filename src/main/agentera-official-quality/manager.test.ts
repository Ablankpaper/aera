// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { OfficialQualityEnvelope } from "../../shared/agentera-official-quality";
import {
  openAgenteraOfficialQualityDatabase,
  type AgenteraOfficialQualityDatabase,
  type AgenteraOfficialQualitySqliteDatabase,
} from "./db";
import {
  AgenteraOfficialQualityClientError,
  type OfficialQualityClient,
} from "./client";
import { AgenteraOfficialQualityManager } from "./manager";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "10000000-0000-4000-8000-000000000002";
const DEVICE_ID = "20000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-23T12:00:00.000Z");
const EVENT_ID = "019f0000-0000-7000-8000-000000000001";

function envelope(consentVersion = 1): OfficialQualityEnvelope {
  return {
    protocol_version: 1 as const,
    consent_version: consentVersion,
    event_id: EVENT_ID,
    platform_id: "30000000-0000-4000-8000-000000000001",
    definition_id: "40000000-0000-4000-8000-000000000001",
    version_id: "50000000-0000-4000-8000-000000000001",
    release_id: "60000000-0000-4000-8000-000000000001",
    release_revision_id: "70000000-0000-4000-8000-000000000001",
    desktop_version: "0.7.3",
    runtime_version: "v0.18.2-agentera.1",
    event_day: "2026-07-23",
    kind: "metric" as const,
    result: "success" as const,
    latency_bucket: "1s_5s" as const,
    total_token_bucket: "1_1k" as const,
    crash_code: null,
    feedback_rating: null,
    feedback_reason_codes: [],
    binding_proof: "90000000-0000-4000-8000-000000000001",
    device_signature: "A".repeat(86),
  };
}

describe("AgenteraOfficialQualityManager", () => {
  let root = "";
  let database: AgenteraOfficialQualityDatabase;
  let client: OfficialQualityClient;
  let uploadEvent: Mock<OfficialQualityClient["uploadEvent"]>;
  let setConsent: Mock<OfficialQualityClient["setConsent"]>;
  let principal: { accountId: string; deviceId: string } | null;
  let now: Date;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-quality-manager-"));
    database = openAgenteraOfficialQualityDatabase(join(root, "user-data"), {
      databaseFactory: (path) =>
        new DatabaseSync(
          path,
        ) as unknown as AgenteraOfficialQualitySqliteDatabase,
    });
    uploadEvent = vi.fn<OfficialQualityClient["uploadEvent"]>(async () => ({
      eventId: EVENT_ID,
      status: "accepted",
    }));
    setConsent = vi.fn<OfficialQualityClient["setConsent"]>(
      async (purpose, enabled, consentVersion) => ({
        purpose,
        consentVersion,
        state: enabled ? "granted" : "revoked",
        revision: consentVersion,
        recordedAt: NOW.toISOString(),
        replayed: false,
      }),
    );
    client = { uploadEvent, setConsent };
    principal = { accountId: ACCOUNT_ID, deviceId: DEVICE_ID };
    now = new Date(NOW);
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function manager(random = 0): AgenteraOfficialQualityManager {
    return new AgenteraOfficialQualityManager({
      database,
      client,
      collector: {
        collectMetric: vi.fn(() => null),
        prepareFeedbackCandidate: vi.fn(() => null),
        collectFeedback: vi.fn(() => null),
      },
      getPrincipal: () => principal,
      now: () => now,
      random: () => random,
    });
  }

  function enqueue(): void {
    const receipt = database.setConsent(
      ACCOUNT_ID,
      DEVICE_ID,
      "official_quality_metrics",
      true,
      NOW,
    );
    database.enqueue({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      purpose: "official_quality_metrics",
      envelope: envelope(receipt.version),
      now: NOW,
    });
  }

  it("syncs active consent before uploading and acknowledges accepted events", async () => {
    enqueue();
    await manager().uploadPending();
    expect(setConsent).toHaveBeenCalledWith(
      "official_quality_metrics",
      true,
      1,
    );
    expect(uploadEvent).toHaveBeenCalledTimes(1);
    expect(database.countOutbox(ACCOUNT_ID, DEVICE_ID)).toBe(0);
  });

  it("uses bounded exponential retry with jitter and never rejects the chat path", async () => {
    enqueue();
    uploadEvent.mockRejectedValueOnce(
      new AgenteraOfficialQualityClientError(503, "service_unavailable", true),
    );
    await expect(manager(0.5).uploadPending()).resolves.toBeUndefined();
    const row = database.sqlite
      .prepare(
        "SELECT attempt_count, next_attempt_at FROM official_quality_outbox WHERE event_id = ?",
      )
      .get(EVENT_ID) as { attempt_count: number; next_attempt_at: string };
    expect(row.attempt_count).toBe(1);
    expect(new Date(row.next_attempt_at).getTime() - NOW.getTime()).toBe(1_250);
  });

  it("drops terminal server rejections without leaking them back to execution", async () => {
    enqueue();
    uploadEvent.mockRejectedValueOnce(
      new AgenteraOfficialQualityClientError(400, "privacy_rejected", false),
    );
    await expect(manager().uploadPending()).resolves.toBeUndefined();
    expect(database.countOutbox(ACCOUNT_ID, DEVICE_ID)).toBe(0);
  });

  it("purges matching unsent events on revocation and all old-account rows on logout", async () => {
    enqueue();
    const quality = manager();
    await quality.setConsent("official_quality_metrics", false);
    expect(database.countOutbox(ACCOUNT_ID, DEVICE_ID)).toBe(0);
    expect(setConsent).toHaveBeenCalledWith(
      "official_quality_metrics",
      false,
      2,
    );

    database.setConsent(
      ACCOUNT_ID,
      DEVICE_ID,
      "official_quality_metrics",
      true,
      new Date(NOW.getTime() + 1_000),
    );
    database.enqueue({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      purpose: "official_quality_metrics",
      envelope: envelope(3),
      now: new Date(NOW.getTime() + 1_000),
    });
    quality.notifyPrincipalChanged(principal);
    principal = null;
    quality.notifyPrincipalChanged(null);
    expect(database.countOutbox(ACCOUNT_ID, DEVICE_ID)).toBe(0);

    principal = { accountId: OTHER_ACCOUNT_ID, deviceId: DEVICE_ID };
    await quality.uploadPending();
    expect(uploadEvent).toHaveBeenCalledTimes(0);
  });

  it("returns local consent and keeps explicit eligibility independent from passive upload", async () => {
    const candidate = {
      candidateId: "019f0000-0000-7000-8000-000000000010",
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      consentVersion: 1,
      preparedAt: NOW.toISOString(),
      platformId: "30000000-0000-4000-8000-000000000001",
      definitionId: "40000000-0000-4000-8000-000000000001",
      versionId: "50000000-0000-4000-8000-000000000001",
      releaseId: "60000000-0000-4000-8000-000000000001",
      releaseRevisionId: "70000000-0000-4000-8000-000000000001",
      desktopVersion: "0.7.3",
      runtimeVersion: "v0.18.2-agentera.1",
      eventDay: "2026-07-23",
      result: "success" as const,
      latencyBucket: "1s_5s" as const,
      totalTokenBucket: "1_1k" as const,
      crashCode: null,
      bindingProof: "90000000-0000-4000-8000-000000000001",
    };
    const explicitEnvelope = {
      ...envelope(),
      event_id: candidate.candidateId,
      kind: "explicit_feedback" as const,
      feedback_rating: "helpful" as const,
    };
    const collector = {
      collectMetric: vi.fn(() => null),
      prepareFeedbackCandidate: vi.fn(() => candidate),
      collectFeedback: vi.fn(() => explicitEnvelope),
    };
    database.setConsent(
      ACCOUNT_ID,
      DEVICE_ID,
      "official_explicit_feedback",
      true,
      NOW,
    );
    const quality = new AgenteraOfficialQualityManager({
      database,
      client,
      collector,
      getPrincipal: () => principal,
      now: () => now,
      random: () => 0,
    });

    expect(quality.getConsent()).toEqual({
      passive: false,
      explicitFeedback: true,
    });
    const eligibility = quality.recordMetric({} as never);
    expect(eligibility).toEqual({
      eventId: candidate.candidateId,
      result: "success",
      latencyBucket: "1s_5s",
      totalTokenBucket: "1_1k",
      crashCode: null,
    });
    await expect(
      quality.submitFeedback({
        eventId: candidate.candidateId,
        rating: "helpful",
        reasonCodes: [],
      }),
    ).resolves.toEqual({ accepted: true });
    expect(collector.collectFeedback).toHaveBeenCalledWith(candidate, {
      rating: "helpful",
      reasonCodes: [],
    });
    await expect(
      quality.submitFeedback({
        eventId: candidate.candidateId,
        rating: "helpful",
        reasonCodes: [],
      }),
    ).rejects.toThrow(/eligible/i);
  });

  it("returns default-off consent without an owner", () => {
    principal = null;
    expect(manager().getConsent()).toEqual({
      passive: false,
      explicitFeedback: false,
    });
  });
});
