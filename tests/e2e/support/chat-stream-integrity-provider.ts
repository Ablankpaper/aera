import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export type StreamIntegrityProviderRequest =
  | { kind: "chat"; turn: number }
  | { kind: "auxiliary" }
  | { kind: "invalid" };

export type InvalidRequestRule =
  | "body-not-object"
  | "messages-not-array"
  | "missing-user-string-content"
  | "known-case-stream-not-true"
  | "unknown-stream"
  | "invalid-json";

export type DetailedStreamIntegrityProviderRequest =
  | { kind: "chat"; turn: number }
  | { kind: "auxiliary" }
  | { kind: "invalid"; rule: InvalidRequestRule };

export interface InvalidRequestEvidence {
  requestId: string;
  receivedAt: string;
  method: string;
  url: string;
  bodyBytes: number;
  bodySha256: string;
  classificationRule: InvalidRequestRule;
  headers: Record<string, string>;
}

export const MAX_INVALID_REQUEST_EVIDENCE = 8;

const CHAT_CASE_PATTERN = /^AERA_STREAM_INTEGRITY_CASE_(0[1-9]|1[0-9]|20)$/u;
const ALLOWLISTED_HEADER_NAMES = [
  "accept",
  "content-length",
  "content-type",
  "user-agent",
] as const;
const MAX_HEADER_VALUE_LENGTH = 256;

function invalid(
  rule: InvalidRequestRule,
): DetailedStreamIntegrityProviderRequest {
  return { kind: "invalid", rule };
}

export function classifyStreamIntegrityProviderRequestDetailed(
  value: unknown,
): DetailedStreamIntegrityProviderRequest {
  if (!value || typeof value !== "object") return invalid("body-not-object");
  const payload = value as { messages?: unknown; stream?: unknown };
  if (!Array.isArray(payload.messages)) return invalid("messages-not-array");

  const lastUserMessage = payload.messages.findLast(
    (message): message is { content: unknown; role: "user" } =>
      Boolean(
        message &&
        typeof message === "object" &&
        (message as { role?: unknown }).role === "user",
      ),
  );
  if (typeof lastUserMessage?.content !== "string") {
    return invalid("missing-user-string-content");
  }

  const chatCase = CHAT_CASE_PATTERN.exec(lastUserMessage.content);
  if (chatCase) {
    return payload.stream === true
      ? { kind: "chat", turn: Number(chatCase[1]) }
      : invalid("known-case-stream-not-true");
  }
  return payload.stream === true
    ? invalid("unknown-stream")
    : { kind: "auxiliary" };
}

export function classifyStreamIntegrityProviderRequest(
  value: unknown,
): StreamIntegrityProviderRequest {
  const classified = classifyStreamIntegrityProviderRequestDetailed(value);
  return classified.kind === "invalid" ? { kind: "invalid" } : classified;
}

function boundedHeaderValue(value: string | string[]): string {
  const normalized = Array.isArray(value) ? value.join(",") : value;
  return normalized.length > MAX_HEADER_VALUE_LENGTH
    ? normalized.slice(0, MAX_HEADER_VALUE_LENGTH)
    : normalized;
}

function redactedAllowlistedHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ALLOWLISTED_HEADER_NAMES) {
    const value = headers[name];
    if (typeof value === "string" || Array.isArray(value)) {
      result[name] = boundedHeaderValue(value);
    }
  }
  return result;
}

function safePath(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl || "/", "http://127.0.0.1");
    return parsed.pathname.slice(0, 512) || "/";
  } catch {
    return "/";
  }
}

export function buildInvalidRequestEvidence(input: {
  requestId: string;
  receivedAt: string;
  method: string;
  url: string;
  body: string;
  classificationRule: InvalidRequestRule;
  headers: IncomingHttpHeaders;
}): InvalidRequestEvidence {
  return {
    requestId: input.requestId,
    receivedAt: input.receivedAt,
    method: input.method.toUpperCase().slice(0, 16),
    url: safePath(input.url),
    bodyBytes: Buffer.byteLength(input.body, "utf8"),
    bodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"),
    classificationRule: input.classificationRule,
    headers: redactedAllowlistedHeaders(input.headers),
  };
}

export function appendBoundedInvalidRequestEvidence(
  target: InvalidRequestEvidence[],
  evidence: InvalidRequestEvidence,
): void {
  if (target.length < MAX_INVALID_REQUEST_EVIDENCE) target.push(evidence);
}
