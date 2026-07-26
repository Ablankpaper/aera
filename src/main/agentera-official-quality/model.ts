import {
  AGENTERA_OFFICIAL_QUALITY_PROTOCOL_VERSION,
  OFFICIAL_QUALITY_CRASH_CODES,
  OFFICIAL_QUALITY_EVENT_KINDS,
  OFFICIAL_QUALITY_FEEDBACK_RATINGS,
  OFFICIAL_QUALITY_FEEDBACK_REASON_CODES,
  OFFICIAL_QUALITY_LATENCY_BUCKETS,
  OFFICIAL_QUALITY_RESULTS,
  OFFICIAL_QUALITY_TOKEN_BUCKETS,
  type OfficialQualityCrashCode,
  type OfficialQualityEnvelope,
  type OfficialQualityEventKind,
  type OfficialQualityFeedbackRating,
  type OfficialQualityFeedbackReasonCode,
  type OfficialQualityLatencyBucket,
  type OfficialQualityResult,
  type OfficialQualityTokenBucket,
} from "../../shared/agentera-official-quality";

const ENVELOPE_FIELDS = [
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
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BASE64URL_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const MAXIMUM_EVENT_AGE_DAYS = 30;

function invalidEnvelope(): never {
  throw new Error("Invalid official quality envelope.");
}

function exactObject(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalidEnvelope();
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...ENVELOPE_FIELDS].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    return invalidEnvelope();
  }
  return object;
}

function uuid(value: unknown, version7 = false): string {
  if (
    typeof value !== "string" ||
    !(version7 ? UUID_V7_PATTERN : UUID_PATTERN).test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    return invalidEnvelope();
  }
  return value;
}

function boundedToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    })
  ) {
    return invalidEnvelope();
  }
  return value;
}

function member<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    return invalidEnvelope();
  }
  return value as Values[number];
}

function eventDay(value: unknown, now: Date): string {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) {
    return invalidEnvelope();
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    return invalidEnvelope();
  }
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const oldest = today - MAXIMUM_EVENT_AGE_DAYS * 24 * 60 * 60 * 1_000;
  if (parsed.getTime() < oldest || parsed.getTime() > today) {
    return invalidEnvelope();
  }
  return value;
}

function signature(value: unknown): string {
  if (typeof value !== "string" || !BASE64URL_SIGNATURE_PATTERN.test(value)) {
    return invalidEnvelope();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 64 || decoded.toString("base64url") !== value) {
    return invalidEnvelope();
  }
  return value;
}

function reasons(value: unknown): OfficialQualityFeedbackReasonCode[] {
  if (!Array.isArray(value) || value.length > 6) return invalidEnvelope();
  const result = value.map((item) =>
    member(item, OFFICIAL_QUALITY_FEEDBACK_REASON_CODES),
  );
  if (new Set(result).size !== result.length) return invalidEnvelope();
  return result;
}

export function parseOfficialQualityEnvelope(
  value: unknown,
  nowValue = new Date(),
): OfficialQualityEnvelope {
  if (!(nowValue instanceof Date) || !Number.isFinite(nowValue.getTime())) {
    return invalidEnvelope();
  }
  const object = exactObject(value);
  if (
    object.protocol_version !== AGENTERA_OFFICIAL_QUALITY_PROTOCOL_VERSION ||
    typeof object.consent_version !== "number" ||
    !Number.isSafeInteger(object.consent_version) ||
    object.consent_version < 1
  ) {
    return invalidEnvelope();
  }
  const kind = member(
    object.kind,
    OFFICIAL_QUALITY_EVENT_KINDS,
  ) as OfficialQualityEventKind;
  const result = member(
    object.result,
    OFFICIAL_QUALITY_RESULTS,
  ) as OfficialQualityResult;
  const crashCode =
    object.crash_code === null
      ? null
      : (member(
          object.crash_code,
          OFFICIAL_QUALITY_CRASH_CODES,
        ) as OfficialQualityCrashCode);
  const feedbackRating =
    object.feedback_rating === null
      ? null
      : (member(
          object.feedback_rating,
          OFFICIAL_QUALITY_FEEDBACK_RATINGS,
        ) as OfficialQualityFeedbackRating);
  const feedbackReasonCodes = reasons(object.feedback_reason_codes);
  if (
    (result === "runtime_crash") !== (crashCode !== null) ||
    (kind === "metric" &&
      (feedbackRating !== null || feedbackReasonCodes.length !== 0)) ||
    (kind === "explicit_feedback" && feedbackRating === null)
  ) {
    return invalidEnvelope();
  }
  return {
    protocol_version: AGENTERA_OFFICIAL_QUALITY_PROTOCOL_VERSION,
    consent_version: object.consent_version,
    event_id: uuid(object.event_id, true),
    platform_id: uuid(object.platform_id),
    definition_id: uuid(object.definition_id),
    version_id: uuid(object.version_id),
    release_id: uuid(object.release_id),
    release_revision_id: uuid(object.release_revision_id),
    desktop_version: boundedToken(object.desktop_version),
    runtime_version: boundedToken(object.runtime_version),
    event_day: eventDay(object.event_day, nowValue),
    kind,
    result,
    latency_bucket: member(
      object.latency_bucket,
      OFFICIAL_QUALITY_LATENCY_BUCKETS,
    ) as OfficialQualityLatencyBucket,
    total_token_bucket: member(
      object.total_token_bucket,
      OFFICIAL_QUALITY_TOKEN_BUCKETS,
    ) as OfficialQualityTokenBucket,
    crash_code: crashCode,
    feedback_rating: feedbackRating,
    feedback_reason_codes: feedbackReasonCodes,
    binding_proof: uuid(object.binding_proof),
    device_signature: signature(object.device_signature),
  };
}

export function serializeOfficialQualityEnvelope(
  value: unknown,
  now = new Date(),
): string {
  const envelope = parseOfficialQualityEnvelope(value, now);
  return JSON.stringify(envelope);
}
