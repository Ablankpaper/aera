import {
  OFFICIAL_QUALITY_CRASH_CODES,
  OFFICIAL_QUALITY_RESULTS,
  type OfficialQualityCrashCode,
  type OfficialQualityLatencyBucket,
  type OfficialQualityResult,
  type OfficialQualityTokenBucket,
} from "../../shared/agentera-official-quality";

function requireCounter(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid official quality ${label}.`);
  }
  return value;
}

export function bucketOfficialQualityLatency(
  millisecondsValue: unknown,
): OfficialQualityLatencyBucket {
  const milliseconds = requireCounter(millisecondsValue, "latency");
  if (milliseconds < 1_000) return "lt_1s";
  if (milliseconds < 5_000) return "1s_5s";
  if (milliseconds < 15_000) return "5s_15s";
  if (milliseconds < 60_000) return "15s_60s";
  if (milliseconds < 180_000) return "60s_180s";
  return "gte_180s";
}

export function bucketOfficialQualityTotalTokens(
  totalTokensValue: unknown,
): OfficialQualityTokenBucket {
  const totalTokens = requireCounter(totalTokensValue, "tokens");
  if (totalTokens === 0) return "0";
  if (totalTokens < 1_000) return "1_1k";
  if (totalTokens < 4_000) return "1k_4k";
  if (totalTokens < 16_000) return "4k_16k";
  if (totalTokens < 64_000) return "16k_64k";
  return "gte_64k";
}

export function parseOfficialQualityResult(
  value: unknown,
): OfficialQualityResult {
  if (
    typeof value !== "string" ||
    !OFFICIAL_QUALITY_RESULTS.includes(value as OfficialQualityResult)
  ) {
    throw new Error("Invalid official quality result.");
  }
  return value as OfficialQualityResult;
}

export function minimizeOfficialQualityCrashCode(
  value: unknown,
): OfficialQualityCrashCode {
  if (
    typeof value === "string" &&
    OFFICIAL_QUALITY_CRASH_CODES.includes(value as OfficialQualityCrashCode)
  ) {
    return value as OfficialQualityCrashCode;
  }
  return "unclassified_runtime_failure";
}
