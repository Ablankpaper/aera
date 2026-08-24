import { describe, expect, it } from "vitest";
import {
  modelSwitchErrorCode,
  modelSwitchErrorKey,
} from "./agentModelSwitchError";

describe("Agent model-switch error presentation", () => {
  it("maps stable Main error codes to specific localized copy", () => {
    expect(modelSwitchErrorKey("model_switch_credential_unavailable")).toBe(
      "chat.modelSwitch.credentialUnavailable",
    );
    expect(modelSwitchErrorKey("model_switch_runtime_route_unsupported")).toBe(
      "chat.modelSwitch.runtimeRouteUnsupported",
    );
    expect(modelSwitchErrorKey("model_switch_route_ambiguous")).toBe(
      "chat.modelSwitch.routeAmbiguous",
    );
  });

  it("does not expose arbitrary Main error text to the Renderer", () => {
    expect(modelSwitchErrorCode({ code: "model_switch_owner_changed" })).toBe(
      "model_switch_owner_changed",
    );
    expect(
      modelSwitchErrorCode(new Error("/Users/private/api-key=secret")),
    ).toBe(null);
    expect(modelSwitchErrorKey("unexpected_internal_detail")).toBe(
      "chat.modelSwitch.failedKeepsCurrent",
    );
  });

  it("extracts only an allow-listed code from Electron's invoke wrapper", () => {
    const wrapped = new Error(
      "Error invoking remote method 'send-message': Error: provider_authentication_rejected",
    );
    expect(modelSwitchErrorCode(wrapped)).toBe(
      "provider_authentication_rejected",
    );
    expect(
      modelSwitchErrorCode(
        new Error(
          "Error invoking remote method 'send-message': Error: provider_authentication_rejected sk-private /Users/alice/.hermes/.env",
        ),
      ),
    ).toBe("provider_authentication_rejected");
  });
});
