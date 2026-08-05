import { describe, expect, it } from "vitest";

import { classifyStreamIntegrityProviderRequest } from "./e2e/support/chat-stream-integrity-provider";

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
});
