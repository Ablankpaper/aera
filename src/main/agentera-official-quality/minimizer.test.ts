// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  bucketOfficialQualityLatency,
  bucketOfficialQualityTotalTokens,
  minimizeOfficialQualityCrashCode,
  parseOfficialQualityResult,
} from "./minimizer";

describe("official quality minimizer", () => {
  it.each([
    [0, "lt_1s"],
    [999, "lt_1s"],
    [1_000, "1s_5s"],
    [4_999, "1s_5s"],
    [5_000, "5s_15s"],
    [14_999, "5s_15s"],
    [15_000, "15s_60s"],
    [59_999, "15s_60s"],
    [60_000, "60s_180s"],
    [179_999, "60s_180s"],
    [180_000, "gte_180s"],
  ])("buckets %dms as %s", (milliseconds, expected) => {
    expect(bucketOfficialQualityLatency(milliseconds)).toBe(expected);
  });

  it.each([
    [0, "0"],
    [1, "1_1k"],
    [999, "1_1k"],
    [1_000, "1k_4k"],
    [3_999, "1k_4k"],
    [4_000, "4k_16k"],
    [15_999, "4k_16k"],
    [16_000, "16k_64k"],
    [63_999, "16k_64k"],
    [64_000, "gte_64k"],
  ])("buckets %d total tokens as %s", (tokens, expected) => {
    expect(bucketOfficialQualityTotalTokens(tokens)).toBe(expected);
  });

  it("pins terminal results and crash codes without retaining raw errors", () => {
    for (const result of [
      "success",
      "user_cancelled",
      "model_error",
      "tool_error",
      "runtime_crash",
      "timeout",
    ]) {
      expect(parseOfficialQualityResult(result)).toBe(result);
    }
    expect(() => parseOfficialQualityResult("private-canary")).toThrow(
      "result",
    );
    for (const code of [
      "gateway_unavailable",
      "runtime_process_exit",
      "runtime_protocol_failure",
      "unclassified_runtime_failure",
    ]) {
      expect(minimizeOfficialQualityCrashCode(code)).toBe(code);
    }
    expect(minimizeOfficialQualityCrashCode(new Error("private-canary"))).toBe(
      "unclassified_runtime_failure",
    );
  });

  it("rejects malformed counters before bucketing", () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => bucketOfficialQualityLatency(value)).toThrow("latency");
      expect(() => bucketOfficialQualityTotalTokens(value)).toThrow("tokens");
    }
  });
});
