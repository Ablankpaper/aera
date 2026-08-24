import { describe, expect, it } from "vitest";

import { chatErrorMessageKey } from "./chatErrorPresentation";

describe("chat error presentation", () => {
  it("maps provider authentication to a dedicated user message", () => {
    expect(
      chatErrorMessageKey({ code: "provider_authentication_rejected" }),
    ).toBe("chat.errors.providerAuthenticationRejected");
  });

  it("never turns an untrusted payload into visible text", () => {
    const raw = {
      code: "unknown",
      detail: "sk-private /Users/alice/.hermes/.env",
    };

    const key = chatErrorMessageKey(raw);

    expect(key).toBe("chat.errors.runtimeFailed");
    expect(key).not.toContain("sk-private");
    expect(key).not.toContain("/Users/alice");
  });
});
