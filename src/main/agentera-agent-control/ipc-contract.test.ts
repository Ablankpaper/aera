// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AGENTERA_IPC_CHANNEL_POLICY } from "../ipc/auth-guard";
import {
  executeAgentControlIpc,
  parseAgentOperationScope,
  parseInstallVersionInput,
  parseRepairInstallationModelInput,
  parseRetryPendingInstallationInput,
} from "./ipc-contract";

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";

describe("Agent control IPC operation scope", () => {
  it("preserves a signed model compatibility failure for an actionable renderer error", async () => {
    const result = await executeAgentControlIpc(() => {
      throw Object.assign(new Error("model route mismatch"), {
        code: "profile_model_configuration_failed",
      });
    });

    expect(result).toEqual({
      ok: false,
      errorCode: "profile_model_configuration_failed",
    });
  });

  it("accepts only the private USER override and never arbitrary tenant input", () => {
    expect(parseAgentOperationScope(undefined)).toBeUndefined();
    expect(parseAgentOperationScope("USER")).toBe("USER");
    expect(() => parseAgentOperationScope("ORGANIZATION")).toThrow(
      "Aera Agent control request is invalid.",
    );
    expect(() =>
      parseAgentOperationScope({
        scope: "ORGANIZATION",
        organizationId: "99999999-9999-4999-8999-999999999999",
      }),
    ).toThrow("Aera Agent control request is invalid.");
  });

  it("accepts one bounded model source Profile for fresh installation and retry", () => {
    expect(
      parseInstallVersionInput({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profileName: "fresh-agent",
        modelProfileId: "configured-source",
      }),
    ).toEqual({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profileName: "fresh-agent",
      modelProfileId: "configured-source",
    });
    expect(
      parseRetryPendingInstallationInput({
        id: INSTALLATION_ID,
        target: {
          kind: "fresh",
          profileName: "fresh-agent",
          modelProfileId: "configured-source",
        },
      }),
    ).toEqual({
      id: INSTALLATION_ID,
      target: {
        kind: "fresh",
        profileName: "fresh-agent",
        modelProfileId: "configured-source",
      },
    });
    expect(() =>
      parseInstallVersionInput({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profileName: "fresh-agent",
        modelProfileId: "../another-owner",
      }),
    ).toThrow("Aera Agent control request is invalid.");
  });

  it("accepts only the exact active-installation model repair payload", () => {
    expect(
      AGENTERA_IPC_CHANNEL_POLICY["agentera-agents-repair-installation-model"],
    ).toBe("online");
    expect(
      parseRepairInstallationModelInput({
        id: INSTALLATION_ID,
        localProfileId: "installed-agent",
        modelProfileId: "configured-source",
      }),
    ).toEqual({
      id: INSTALLATION_ID,
      localProfileId: "installed-agent",
      modelProfileId: "configured-source",
    });
    expect(() =>
      parseRepairInstallationModelInput({
        id: INSTALLATION_ID,
        localProfileId: "installed-agent",
        modelProfileId: "configured-source",
        organizationId: "99999999-9999-4999-8999-999999999999",
      }),
    ).toThrow("Aera Agent control request is invalid.");
    expect(() =>
      parseRepairInstallationModelInput({
        id: INSTALLATION_ID,
        localProfileId: "../installed-agent",
        modelProfileId: "configured-source",
      }),
    ).toThrow("Aera Agent control request is invalid.");
  });
});
