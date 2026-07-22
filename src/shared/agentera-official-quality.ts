export const AGENTERA_OFFICIAL_QUALITY_PROTOCOL_VERSION = 1 as const;

export const OFFICIAL_QUALITY_PURPOSES = [
  "official_quality_metrics",
  "official_explicit_feedback",
] as const;

export const OFFICIAL_QUALITY_EVENT_KINDS = [
  "metric",
  "explicit_feedback",
] as const;

export const OFFICIAL_QUALITY_RESULTS = [
  "success",
  "user_cancelled",
  "model_error",
  "tool_error",
  "runtime_crash",
  "timeout",
] as const;

export const OFFICIAL_QUALITY_LATENCY_BUCKETS = [
  "lt_1s",
  "1s_5s",
  "5s_15s",
  "15s_60s",
  "60s_180s",
  "gte_180s",
] as const;

export const OFFICIAL_QUALITY_TOKEN_BUCKETS = [
  "0",
  "1_1k",
  "1k_4k",
  "4k_16k",
  "16k_64k",
  "gte_64k",
] as const;

export const OFFICIAL_QUALITY_CRASH_CODES = [
  "gateway_unavailable",
  "runtime_process_exit",
  "runtime_protocol_failure",
  "unclassified_runtime_failure",
] as const;

export const OFFICIAL_QUALITY_FEEDBACK_RATINGS = [
  "helpful",
  "not_helpful",
] as const;

export const OFFICIAL_QUALITY_FEEDBACK_REASON_CODES = [
  "incorrect",
  "incomplete",
  "tool_failed",
  "too_slow",
  "unsafe_or_inappropriate",
  "other_without_text",
] as const;

export type OfficialQualityPurpose = (typeof OFFICIAL_QUALITY_PURPOSES)[number];
export type OfficialQualityEventKind =
  (typeof OFFICIAL_QUALITY_EVENT_KINDS)[number];
export type OfficialQualityResult = (typeof OFFICIAL_QUALITY_RESULTS)[number];
export type OfficialQualityLatencyBucket =
  (typeof OFFICIAL_QUALITY_LATENCY_BUCKETS)[number];
export type OfficialQualityTokenBucket =
  (typeof OFFICIAL_QUALITY_TOKEN_BUCKETS)[number];
export type OfficialQualityCrashCode =
  (typeof OFFICIAL_QUALITY_CRASH_CODES)[number];
export type OfficialQualityFeedbackRating =
  (typeof OFFICIAL_QUALITY_FEEDBACK_RATINGS)[number];
export type OfficialQualityFeedbackReasonCode =
  (typeof OFFICIAL_QUALITY_FEEDBACK_REASON_CODES)[number];

export interface OfficialQualityConsentSettings {
  passive: boolean;
  explicitFeedback: boolean;
}

export interface OfficialQualityConsentReceipt {
  purpose: OfficialQualityPurpose;
  enabled: boolean;
  version: number;
  updatedAt: string | null;
}

export interface OfficialQualityEnvelope {
  protocol_version: typeof AGENTERA_OFFICIAL_QUALITY_PROTOCOL_VERSION;
  consent_version: number;
  event_id: string;
  platform_id: string;
  definition_id: string;
  version_id: string;
  release_id: string;
  release_revision_id: string;
  desktop_version: string;
  runtime_version: string;
  event_day: string;
  kind: OfficialQualityEventKind;
  result: OfficialQualityResult;
  latency_bucket: OfficialQualityLatencyBucket;
  total_token_bucket: OfficialQualityTokenBucket;
  crash_code: OfficialQualityCrashCode | null;
  feedback_rating: OfficialQualityFeedbackRating | null;
  feedback_reason_codes: OfficialQualityFeedbackReasonCode[];
  binding_proof: string;
  device_signature: string;
}
