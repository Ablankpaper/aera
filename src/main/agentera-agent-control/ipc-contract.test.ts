// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AGENTERA_IPC_CHANNEL_POLICY } from "../ipc/auth-guard";
import {
  executeAgentControlIpc,
  parseAgentOperationScope,
  parseInstallVersionInput,
  parseRepairInstallationModelInput,
  parseRetryPendingInstallationInput,
  parseSelectInstallationVersionInput,
} from "./ipc-contract";

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";

describe("Agent control IPC operation scope", () => {
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

  it("accepts the canonical UUIDv7 identifiers the control plane actually issues", () => {
    const definitionId = "0199e6c2-4b3e-7a91-8f2d-1c4b7e9a3d55";
    const versionId = "0199e6c2-4b3e-7c10-b0d4-2f8a5c1e6b77";
    const installationId = "0199e6c2-4b3e-7de2-9c31-7a0b4d2e8f91";

    expect(
      parseInstallVersionInput({
        definitionId,
        versionId,
        profileName: "fresh-agent",
        modelProfileId: "configured-source",
      }),
    ).toEqual({
      definitionId,
      versionId,
      profileName: "fresh-agent",
      modelProfileId: "configured-source",
    });
    expect(
      parseSelectInstallationVersionInput({
        id: installationId,
        versionId,
        localProfileId: "installed-agent",
      }),
    ).toEqual({
      id: installationId,
      versionId,
      localProfileId: "installed-agent",
    });
    expect(() =>
      parseInstallVersionInput({
        definitionId,
        versionId: "0199e6c2-4b3e-7c10-b0d4-2f8a5c1e6b7",
        profileName: "fresh-agent",
        modelProfileId: "configured-source",
      }),
    ).toThrow("Aera Agent control request is invalid.");
  });

  it("reports every trust-store fault as a verification failure", async () => {
    const codes = [
      "unknown_signing_key",
      "issuer_mismatch",
      "signing_purpose_mismatch",
      "invalid_signing_keys",
      "invalid_trust_cache",
      "signature_invalid",
      "digest_mismatch",
    ] as const;

    for (const code of codes) {
      const failure = Object.assign(new Error(code), { code });
      await expect(
        executeAgentControlIpc(() => {
          throw failure;
        }),
      ).resolves.toEqual({ ok: false, errorCode: "verification_failed" });
    }
  });
});
