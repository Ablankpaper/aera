// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  parseOfficialQualityConsentInput,
  parseOfficialQualityFeedbackInput,
} from "./ipc-contract";
import { AGENTERA_IPC_CHANNEL_POLICY } from "../ipc/auth-guard";

const EVENT_ID = "019f0000-0000-7000-8000-000000000001";

describe("official quality IPC contract", () => {
  it("keeps local reads preflight-safe and mutations authenticated/offline", () => {
    expect(
      AGENTERA_IPC_CHANNEL_POLICY["agentera-official-quality-get-consent"],
    ).toBe("preflight");
    for (const channel of [
      "agentera-official-quality-set-passive-consent",
      "agentera-official-quality-set-explicit-feedback-consent",
      "agentera-official-quality-submit-feedback",
    ]) {
      expect(AGENTERA_IPC_CHANNEL_POLICY[channel], channel).toBe(
        "authenticated",
      );
    }
  });

  it("accepts only the exact consent switch shape", () => {
    expect(parseOfficialQualityConsentInput({ enabled: true })).toEqual({
      enabled: true,
    });
    expect(() =>
      parseOfficialQualityConsentInput({ enabled: true, note: "private" }),
    ).toThrow(/invalid/i);
    expect(() => parseOfficialQualityConsentInput({ enabled: 1 })).toThrow(
      /invalid/i,
    );
  });

  it("accepts only canonical event IDs, fixed ratings, and fixed unique reasons", () => {
    expect(
      parseOfficialQualityFeedbackInput({
        eventId: EVENT_ID,
        rating: "not_helpful",
        reasonCodes: ["incorrect", "too_slow"],
      }),
    ).toEqual({
      eventId: EVENT_ID,
      rating: "not_helpful",
      reasonCodes: ["incorrect", "too_slow"],
    });

    for (const input of [
      { eventId: "not-a-uuid", rating: "helpful", reasonCodes: [] },
      { eventId: EVENT_ID, rating: "bad", reasonCodes: [] },
      { eventId: EVENT_ID, rating: "helpful", reasonCodes: ["write_note"] },
      {
        eventId: EVENT_ID,
        rating: "helpful",
        reasonCodes: ["incorrect", "incorrect"],
      },
    ]) {
      expect(() => parseOfficialQualityFeedbackInput(input)).toThrow(
        /invalid/i,
      );
    }
  });

  it("rejects every free-text or private runtime field before dispatch", () => {
    const valid = {
      eventId: EVENT_ID,
      rating: "helpful",
      reasonCodes: [] as string[],
    };
    for (const forbidden of [
      "note",
      "error",
      "response",
      "sessionId",
      "conversationId",
      "profileId",
      "runtimeBindingId",
    ]) {
      expect(() =>
        parseOfficialQualityFeedbackInput({
          ...valid,
          [forbidden]: "private-canary",
        }),
      ).toThrow(/invalid/i);
    }
  });
});
