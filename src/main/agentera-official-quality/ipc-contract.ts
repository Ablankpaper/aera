import {
  OFFICIAL_QUALITY_FEEDBACK_RATINGS,
  OFFICIAL_QUALITY_FEEDBACK_REASON_CODES,
  type OfficialQualityFeedbackSubmission,
} from "../../shared/agentera-official-quality";

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid(): never {
  throw Object.assign(new Error("Invalid official quality request."), {
    code: "invalid_request",
  });
}

function exactObject(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== fields.length ||
    !fields.every((field) => Object.hasOwn(record, field))
  ) {
    return invalid();
  }
  return record;
}

export function parseOfficialQualityConsentInput(value: unknown): {
  enabled: boolean;
} {
  const record = exactObject(value, ["enabled"]);
  if (typeof record.enabled !== "boolean") return invalid();
  return { enabled: record.enabled };
}

export function parseOfficialQualityFeedbackInput(
  value: unknown,
): OfficialQualityFeedbackSubmission {
  const record = exactObject(value, ["eventId", "rating", "reasonCodes"]);
  if (
    typeof record.eventId !== "string" ||
    !UUID_V7_PATTERN.test(record.eventId) ||
    !OFFICIAL_QUALITY_FEEDBACK_RATINGS.includes(record.rating as never) ||
    !Array.isArray(record.reasonCodes) ||
    record.reasonCodes.length > OFFICIAL_QUALITY_FEEDBACK_REASON_CODES.length
  ) {
    return invalid();
  }
  const reasons = record.reasonCodes;
  if (
    reasons.some(
      (reason) =>
        typeof reason !== "string" ||
        !OFFICIAL_QUALITY_FEEDBACK_REASON_CODES.includes(reason as never),
    ) ||
    new Set(reasons).size !== reasons.length
  ) {
    return invalid();
  }
  return {
    eventId: record.eventId,
    rating: record.rating as OfficialQualityFeedbackSubmission["rating"],
    reasonCodes: reasons as OfficialQualityFeedbackSubmission["reasonCodes"],
  };
}
