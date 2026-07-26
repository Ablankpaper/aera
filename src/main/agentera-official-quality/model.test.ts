// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseOfficialQualityEnvelope,
  serializeOfficialQualityEnvelope,
} from "./model";

const NOW = new Date("2026-07-23T12:00:00.000Z");

function validEnvelope(): Record<string, unknown> {
  return {
    protocol_version: 1,
    consent_version: 3,
    event_id: "019f0000-0000-7000-8000-000000000001",
    platform_id: "10000000-0000-4000-8000-000000000001",
    definition_id: "20000000-0000-4000-8000-000000000001",
    version_id: "30000000-0000-4000-8000-000000000001",
    release_id: "40000000-0000-4000-8000-000000000001",
    release_revision_id: "50000000-0000-4000-8000-000000000001",
    desktop_version: "1.8.0",
    runtime_version: "1.2.0",
    event_day: "2026-07-22",
    kind: "metric",
    result: "success",
    latency_bucket: "1s_5s",
    total_token_bucket: "1k_4k",
    crash_code: null,
    feedback_rating: null,
    feedback_reason_codes: [],
    binding_proof: "60000000-0000-4000-8000-000000000001",
    device_signature: "A".repeat(86),
  };
}

describe("official quality envelope model", () => {
  it("accepts and canonically serializes only the exact public envelope", () => {
    const parsed = parseOfficialQualityEnvelope(validEnvelope(), NOW);
    expect(parsed.feedback_reason_codes).toEqual([]);
    const serialized = serializeOfficialQualityEnvelope(parsed, NOW);
    expect(Object.keys(JSON.parse(serialized) as object)).toEqual([
      "protocol_version",
      "consent_version",
      "event_id",
      "platform_id",
      "definition_id",
      "version_id",
      "release_id",
      "release_revision_id",
      "desktop_version",
      "runtime_version",
      "event_day",
      "kind",
      "result",
      "latency_bucket",
      "total_token_bucket",
      "crash_code",
      "feedback_rating",
      "feedback_reason_codes",
      "binding_proof",
      "device_signature",
    ]);
  });

  it("rejects unknown, missing, malformed, and free-text fields", () => {
    const cases: unknown[] = [
      { ...validEnvelope(), note: "private-canary" },
      { ...validEnvelope(), response: "private-canary" },
      { ...validEnvelope(), event_id: "10000000-0000-4000-8000-000000000001" },
      { ...validEnvelope(), result: "unknown" },
      { ...validEnvelope(), feedback_reason_codes: null },
      { ...validEnvelope(), device_signature: "not-a-signature" },
      Object.fromEntries(
        Object.entries(validEnvelope()).filter(([key]) => key !== "event_day"),
      ),
    ];
    for (const value of cases) {
      expect(() => parseOfficialQualityEnvelope(value, NOW)).toThrow(
        "quality envelope",
      );
    }
  });

  it("enforces event variants, fixed reasons, and the 30-day UTC window", () => {
    expect(() =>
      parseOfficialQualityEnvelope(
        { ...validEnvelope(), event_day: "2026-06-22" },
        NOW,
      ),
    ).toThrow("quality envelope");
    expect(() =>
      parseOfficialQualityEnvelope(
        { ...validEnvelope(), event_day: "2026-07-24" },
        NOW,
      ),
    ).toThrow("quality envelope");
    expect(() =>
      parseOfficialQualityEnvelope(
        { ...validEnvelope(), crash_code: "runtime_process_exit" },
        NOW,
      ),
    ).toThrow("quality envelope");
    const feedback = parseOfficialQualityEnvelope(
      {
        ...validEnvelope(),
        kind: "explicit_feedback",
        feedback_rating: "not_helpful",
        feedback_reason_codes: ["incorrect", "too_slow"],
      },
      NOW,
    );
    expect(feedback.feedback_rating).toBe("not_helpful");
    expect(() =>
      parseOfficialQualityEnvelope(
        {
          ...validEnvelope(),
          kind: "explicit_feedback",
          feedback_rating: "not_helpful",
          feedback_reason_codes: ["incorrect", "incorrect"],
        },
        NOW,
      ),
    ).toThrow("quality envelope");
    expect(() =>
      parseOfficialQualityEnvelope(
        {
          ...validEnvelope(),
          kind: "explicit_feedback",
          feedback_rating: "not_helpful",
          feedback_reason_codes: ["private-canary"],
        },
        NOW,
      ),
    ).toThrow("quality envelope");
  });
});
