import { describe, expect, it } from "vitest";

import {
  appendBoundedInvalidRequestEvidence,
  buildInvalidRequestEvidence,
  classifyStreamIntegrityProviderRequest,
  classifyStreamIntegrityProviderRequestDetailed,
} from "./e2e/support/chat-stream-integrity-provider";

describe("chat stream integrity provider request classification", () => {
  it("keeps automatic title generation outside deterministic chat turns", () => {
    expect(
      classifyStreamIntegrityProviderRequest({
        stream: true,
        messages: [{ role: "user", content: "AERA_STREAM_INTEGRITY_CASE_02" }],
      }),
    ).toEqual({ kind: "chat", turn: 2 });

    expect(
      classifyStreamIntegrityProviderRequest({
        stream: false,
        messages: [
          {
            role: "user",
            content:
              "User: AERA_STREAM_INTEGRITY_CASE_01\n\nAssistant: synthetic reply",
          },
        ],
      }),
    ).toEqual({ kind: "auxiliary" });
  });

  it("fails closed for non-streaming chat cases and unknown streams", () => {
    expect(
      classifyStreamIntegrityProviderRequest({
        stream: false,
        messages: [{ role: "user", content: "AERA_STREAM_INTEGRITY_CASE_01" }],
      }),
    ).toEqual({ kind: "invalid" });
    expect(
      classifyStreamIntegrityProviderRequest({
        stream: true,
        messages: [{ role: "user", content: "unrelated" }],
      }),
    ).toEqual({ kind: "invalid" });
  });

  it("retains only bounded, redacted invalid-request evidence", () => {
    const evidence = buildInvalidRequestEvidence({
      requestId: "stream-invalid-0001",
      receivedAt: "2026-08-07T16:44:00.000Z",
      method: "POST",
      url: "/v1/chat/completions?token=must-not-persist",
      body: '{"secret":"must-not-persist"}',
      classificationRule: "unknown-stream",
      headers: {
        accept: "application/json",
        authorization: "Bearer must-not-persist",
        "content-type": "application/json",
        cookie: "session=must-not-persist",
        "user-agent": "aera-test",
      },
    });

    expect(evidence).toEqual({
      requestId: "stream-invalid-0001",
      receivedAt: "2026-08-07T16:44:00.000Z",
      method: "POST",
      url: "/v1/chat/completions",
      bodyBytes: 29,
      bodySha256:
        "c139bc3e7081ecd2afae2fa59289f57f230a693737cafaa3dc9b70a86bb91cf9",
      classificationRule: "unknown-stream",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "aera-test",
      },
    });
    expect(JSON.stringify(evidence)).not.toContain("must-not-persist");
  });

  it("exposes the exact invalid classification rule and caps retained evidence", () => {
    expect(
      classifyStreamIntegrityProviderRequestDetailed({
        stream: true,
        messages: [{ role: "user", content: "unknown" }],
      }),
    ).toEqual({ kind: "invalid", rule: "unknown-stream" });

    const retained: ReturnType<typeof buildInvalidRequestEvidence>[] = [];
    for (let index = 0; index < 20; index += 1) {
      appendBoundedInvalidRequestEvidence(retained, {
        requestId: `stream-invalid-${String(index + 1).padStart(4, "0")}`,
        receivedAt: "2026-08-07T16:44:00.000Z",
        method: "POST",
        url: "/v1/chat/completions",
        bodyBytes: 0,
        bodySha256: "0".repeat(64),
        classificationRule: "unknown-stream",
        headers: {},
      });
    }
    expect(retained).toHaveLength(8);
  });
});
