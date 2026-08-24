import { describe, expect, it } from "vitest";

import {
  classifyRendererChatError,
  rendererChatErrorRejection,
  rendererChatErrorNotificationBody,
} from "./chat-error-contract";

describe("renderer chat error contract", () => {
  // @lat: [[model-selection#Renderer chat error contract]]
  it("classifies provider authentication without exposing provider text", () => {
    const raw =
      "provider_authentication_rejected: Incorrect API key sk-private at /Users/alice/.hermes/.env";

    const event = classifyRendererChatError(raw);

    expect(event).toEqual({ code: "provider_authentication_rejected" });
    expect(JSON.stringify(event)).not.toContain("sk-private");
    expect(JSON.stringify(event)).not.toContain("/Users/alice");
    expect(rendererChatErrorNotificationBody(event)).toBe(
      "The model provider rejected the current credential.",
    );
  });

  it("keeps invoke rejection safe while preserving the stable code", () => {
    const rejection = rendererChatErrorRejection({
      code: "provider_authentication_rejected",
    });
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toBe("provider_authentication_rejected");
    expect(rejection.code).toBe("provider_authentication_rejected");
    expect(JSON.stringify(rejection)).not.toContain("api-key");
  });

  it("keeps runtime contract failures distinct from transport failures", () => {
    expect(
      classifyRendererChatError(
        Object.assign(new Error("runtime detail"), {
          code: "model_switch_runtime_route_unsupported",
        }),
      ),
    ).toEqual({ code: "model_switch_runtime_route_unsupported" });
    expect(
      classifyRendererChatError("API request failed: connect ECONNRESET"),
    ).toEqual({ code: "chat_transport_unavailable" });
  });

  it("collapses unknown runtime text to a stable generic code", () => {
    const event = classifyRendererChatError(
      "sqlite failed at /Users/alice/private.db with token secret-value",
    );

    expect(event).toEqual({ code: "chat_runtime_failed" });
    expect(rendererChatErrorNotificationBody(event)).toBe(
      "The chat request failed.",
    );
  });
});
