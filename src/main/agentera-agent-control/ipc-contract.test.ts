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
const MODEL_LIBRARY_ID = "44444444-4444-4444-8444-444444444444";
const CACHE_FAILURES = [
  ["cache_conflict", "publication_cache_conflict"],
  ["cache_corrupt", "publication_cache_corrupt"],
  ["cache_permissions_invalid", "publication_cache_permissions_invalid"],
  ["cache_filesystem_denied", "publication_cache_filesystem_denied"],
  ["cache_filesystem_failed", "publication_cache_filesystem_failed"],
  ["cache_database_failed", "publication_cache_database_failed"],
  ["cache_recovery_failed", "publication_cache_recovery_failed"],
] as const;

describe("Agent control IPC operation scope", () => {
  it.each([
    ["signature_invalid", "signature_verification_failed"],
    ["signature_verification_failed", "signature_verification_failed"],
    ["digest_mismatch", "published_content_mismatch"],
    ["published_content_mismatch", "published_content_mismatch"],
    ["publication_cache_failed", "publication_cache_failed"],
  ] as const)(
    "maps %s to the exact safe publication failure %s",
    async (code, expected) => {
      const result = await executeAgentControlIpc(() => {
        throw Object.assign(new Error("private failure details"), { code });
      });
      expect(result).toEqual({ ok: false, errorCode: expected });
    },
  );

  it.each(CACHE_FAILURES)(
    "maps lower cache failure %s and public failure %s to the same safe code",
    async (lowerCode, publicCode) => {
      for (const code of [lowerCode, publicCode]) {
        const result = await executeAgentControlIpc(() => {
          throw Object.assign(new Error("private cache and SQLite details"), {
            code,
          });
        });
        expect(result).toEqual({ ok: false, errorCode: publicCode });
      }
    },
  );

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

  it("accepts an exact local model-library route and rejects ambiguous model sources", () => {
    const modelSelection = {
      sourceProfileId: "configured-source",
      modelLibraryId: MODEL_LIBRARY_ID,
    };
    expect(
      parseInstallVersionInput({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profileName: "fresh-agent",
        modelSelection,
      }),
    ).toEqual({
      definitionId: DEFINITION_ID,
      versionId: VERSION_ID,
      profileName: "fresh-agent",
      modelSelection,
    });
    expect(
      parseRepairInstallationModelInput({
        id: INSTALLATION_ID,
        localProfileId: "installed-agent",
        modelSelection,
      }),
    ).toEqual({
      id: INSTALLATION_ID,
      localProfileId: "installed-agent",
      modelSelection,
    });
    expect(() =>
      parseInstallVersionInput({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profileName: "fresh-agent",
        modelProfileId: "configured-source",
        modelSelection,
      }),
    ).toThrow("Aera Agent control request is invalid.");
  });
});
