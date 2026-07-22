import { parseAgenteraCloudOrigin } from "../agentera-auth/config";
import {
  OFFICIAL_QUALITY_PURPOSES,
  type OfficialQualityPurpose,
} from "../../shared/agentera-official-quality";
import { serializeOfficialQualityEnvelope } from "./model";

const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const MAXIMUM_RESPONSE_BYTES = 8 * 1024;
const EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALLOWED_ERROR_CODES = new Set([
  "invalid_request",
  "session_revoked",
  "consent_required",
  "not_eligible",
  "rate_limited",
  "privacy_rejected",
  "event_conflict",
  "service_unavailable",
]);

export interface OfficialQualityEventReceipt {
  eventId: string;
  status: "accepted" | "replayed";
}

export interface OfficialQualityCloudConsentReceipt {
  purpose: OfficialQualityPurpose;
  consentVersion: number;
  state: "granted" | "revoked";
  revision: number;
  recordedAt: string;
  replayed: boolean;
}

export interface OfficialQualityClient {
  uploadEvent(envelopeJson: string): Promise<OfficialQualityEventReceipt>;
  setConsent(
    purpose: OfficialQualityPurpose,
    enabled: boolean,
    consentVersion: number,
  ): Promise<OfficialQualityCloudConsentReceipt>;
}

export interface AgenteraOfficialQualityClientOptions {
  origin: string;
  getAccessToken: () => string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export class AgenteraOfficialQualityClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, retryable: boolean) {
    super(`AgentEra official quality request failed: ${code}.`);
    this.name = "AgenteraOfficialQualityClientError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function boundedJSON(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) ||
      Number(declared) > MAXIMUM_RESPONSE_BYTES)
  ) {
    throw new AgenteraOfficialQualityClientError(
      response.status,
      "invalid_response",
      false,
    );
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_RESPONSE_BYTES) {
    throw new AgenteraOfficialQualityClientError(
      response.status,
      "invalid_response",
      false,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AgenteraOfficialQualityClientError(
      response.status,
      "invalid_response",
      false,
    );
  }
}

function mappedServerError(status: number, payload: unknown): never {
  const candidate =
    isObject(payload) &&
    typeof payload.error === "string" &&
    ALLOWED_ERROR_CODES.has(payload.error)
      ? payload.error
      : status === 401
        ? "session_revoked"
        : status === 429
          ? "rate_limited"
          : status >= 500
            ? "service_unavailable"
            : "request_rejected";
  const retryable =
    status === 401 ||
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    candidate === "service_unavailable" ||
    candidate === "rate_limited";
  throw new AgenteraOfficialQualityClientError(status, candidate, retryable);
}

function validPurpose(value: unknown): value is OfficialQualityPurpose {
  return (
    typeof value === "string" &&
    OFFICIAL_QUALITY_PURPOSES.includes(value as OfficialQualityPurpose)
  );
}

export class AgenteraOfficialQualityClient implements OfficialQualityClient {
  readonly origin: string;
  private readonly getAccessToken: () => string | null;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: AgenteraOfficialQualityClientOptions) {
    this.origin = parseAgenteraCloudOrigin(options.origin);
    this.getAccessToken = options.getAccessToken;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MILLISECONDS;
    this.now = options.now ?? (() => new Date());
    if (
      typeof this.getAccessToken !== "function" ||
      typeof this.fetcher !== "function" ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000
    ) {
      throw new Error(
        "Invalid AgentEra official quality client configuration.",
      );
    }
  }

  async uploadEvent(
    envelopeJsonValue: string,
  ): Promise<OfficialQualityEventReceipt> {
    let envelopeJson: string;
    try {
      if (typeof envelopeJsonValue !== "string") throw new Error();
      envelopeJson = serializeOfficialQualityEnvelope(
        JSON.parse(envelopeJsonValue),
        this.now(),
      );
      if (envelopeJson !== envelopeJsonValue) throw new Error();
    } catch {
      throw new AgenteraOfficialQualityClientError(0, "invalid_request", false);
    }
    const payload = await this.request(
      "/api/v1/official-agent-quality/events",
      envelopeJson,
      202,
    );
    if (
      !isObject(payload) ||
      Object.keys(payload).length !== 2 ||
      !EVENT_ID_PATTERN.test(String(payload.event_id)) ||
      (payload.status !== "accepted" && payload.status !== "replayed")
    ) {
      throw new AgenteraOfficialQualityClientError(
        202,
        "invalid_response",
        false,
      );
    }
    return {
      eventId: payload.event_id as string,
      status: payload.status,
    };
  }

  async setConsent(
    purpose: OfficialQualityPurpose,
    enabled: boolean,
    consentVersion: number,
  ): Promise<OfficialQualityCloudConsentReceipt> {
    if (
      !validPurpose(purpose) ||
      typeof enabled !== "boolean" ||
      !Number.isSafeInteger(consentVersion) ||
      consentVersion < 1
    ) {
      throw new AgenteraOfficialQualityClientError(0, "invalid_request", false);
    }
    const payload = await this.request(
      `/api/v1/official-agent-quality/consents/${purpose}/${enabled ? "grant" : "revoke"}`,
      JSON.stringify({ consent_version: consentVersion }),
      200,
    );
    if (
      !isObject(payload) ||
      payload.purpose !== purpose ||
      payload.consent_version !== consentVersion ||
      (payload.state !== "granted" && payload.state !== "revoked") ||
      payload.state !== (enabled ? "granted" : "revoked") ||
      typeof payload.revision !== "number" ||
      !Number.isSafeInteger(payload.revision) ||
      payload.revision < 1 ||
      typeof payload.recorded_at !== "string" ||
      !Number.isFinite(new Date(payload.recorded_at).getTime()) ||
      typeof payload.replayed !== "boolean"
    ) {
      throw new AgenteraOfficialQualityClientError(
        200,
        "invalid_response",
        false,
      );
    }
    return {
      purpose,
      consentVersion,
      state: payload.state,
      revision: payload.revision,
      recordedAt: payload.recorded_at,
      replayed: payload.replayed,
    };
  }

  private async request(
    path: string,
    body: string,
    expectedStatus: number,
  ): Promise<unknown> {
    const token = this.getAccessToken();
    if (
      typeof token !== "string" ||
      token.length < 1 ||
      token.trim() !== token ||
      /[\s\0]/.test(token)
    ) {
      throw new AgenteraOfficialQualityClientError(
        0,
        "authentication_required",
        true,
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, `${this.origin}/`), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
        signal: controller.signal,
      });
    } catch {
      throw new AgenteraOfficialQualityClientError(
        0,
        "service_unavailable",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
    const payload = await boundedJSON(response);
    if (response.status !== expectedStatus) {
      return mappedServerError(response.status, payload);
    }
    return payload;
  }
}
