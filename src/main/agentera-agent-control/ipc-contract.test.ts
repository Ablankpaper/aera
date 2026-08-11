// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AGENTERA_IPC_CHANNEL_POLICY } from "../ipc/auth-guard";
import {
  executeAgentControlIpc,
  parseDisconnectOrganizationSubmissionReferenceInput,
  parseAgentOperationScope,
  parseInstallVersionInput,
  parseRepairInstallationModelInput,
  parseRetryPendingInstallationInput,
  publicOrganizationSubmissionList,
} from "./ipc-contract";

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const MODEL_LIBRARY_ID = "44444444-4444-4444-8444-444444444444";
const ORGANIZATION_ID = "55555555-5555-4555-8555-555555555555";
const SUBMISSION_ID = "66666666-6666-4666-8666-666666666666";
const USER_ID = "77777777-7777-4777-8777-777777777777";
const DRAFT_ID = "88888888-8888-4888-8888-888888888888";
const LOCAL_DIGEST = "b".repeat(64);
const CLOUD_DIGEST = "a".repeat(64);
const DATABASE_PATH = "/Users/private/control-plane.db";
const CACHE_FAILURES = [
  ["cache_conflict", "publication_cache_conflict"],
  ["cache_corrupt", "publication_cache_corrupt"],
  ["cache_permissions_invalid", "publication_cache_permissions_invalid"],
  ["cache_filesystem_denied", "publication_cache_filesystem_denied"],
  ["cache_filesystem_failed", "publication_cache_filesystem_failed"],
  ["cache_database_failed", "publication_cache_database_failed"],
  ["cache_recovery_failed", "publication_cache_recovery_failed"],
] as const;
const CAPABILITY_FAILURES = [
  "capability_profile_unavailable",
  "capability_source_unsafe",
  "capability_dlp_blocked",
  "capability_handle_invalid",
  "capability_handle_expired",
  "capability_requirement_invalid",
] as const;

describe("Agent control IPC operation scope", () => {
  it("serializes a quarantined reference without conflicting local bytes", () => {
    const unsafeList = {
      submissions: [
        {
          id: SUBMISSION_ID,
          organizationId: ORGANIZATION_ID,
          kind: "initial" as const,
          definitionId: DEFINITION_ID,
          baseVersionId: null,
          publishedVersionId: null,
          localDraftId: DRAFT_ID,
          localDraftRevision: 2,
          submittedByUserId: USER_ID,
          contentDigest: CLOUD_DIGEST,
          status: "pending" as const,
          revision: 3,
          submittedAt: "2026-08-11T00:00:00.000Z",
          terminalAt: null,
          review: null,
          referenceState: {
            kind: "quarantined" as const,
            stage: "content_digest" as const,
          },
          localContentDigest: LOCAL_DIGEST,
          databasePath: DATABASE_PATH,
        },
      ],
      issues: [],
    };

    const output = publicOrganizationSubmissionList(unsafeList);

    expect(output.submissions[0]).toMatchObject({
      localDraftId: null,
      localDraftRevision: null,
      referenceState: {
        kind: "quarantined",
        stage: "content_digest",
      },
    });
    expect(JSON.stringify(output)).not.toContain(LOCAL_DIGEST);
    expect(JSON.stringify(output)).not.toContain(DATABASE_PATH);
  });

  it("accepts only the exact confirmed submission-reference detach payload", async () => {
    expect(
      parseDisconnectOrganizationSubmissionReferenceInput({
        submissionId: SUBMISSION_ID,
        confirmation: "disconnect-local-draft-link",
      }),
    ).toEqual({
      submissionId: SUBMISSION_ID,
      confirmation: "disconnect-local-draft-link",
    });
    expect(() =>
      parseDisconnectOrganizationSubmissionReferenceInput({
        submissionId: SUBMISSION_ID,
        confirmation: "disconnect",
      }),
    ).toThrow("Aera Agent control request is invalid.");
    expect(() =>
      parseDisconnectOrganizationSubmissionReferenceInput({
        submissionId: SUBMISSION_ID,
        confirmation: "disconnect-local-draft-link",
        organizationId: ORGANIZATION_ID,
      }),
    ).toThrow("Aera Agent control request is invalid.");

    const result = await executeAgentControlIpc(() => {
      throw Object.assign(new Error("private SQLite compare-and-set details"), {
        code: "organization_submission_reference_detach_failed",
      });
    });
    expect(result).toEqual({
      ok: false,
      errorCode: "organization_submission_reference_detach_failed",
    });
  });

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

  it.each(CAPABILITY_FAILURES)(
    "preserves the bounded capability failure %s without private details",
    async (code) => {
      const result = await executeAgentControlIpc(() => {
        throw Object.assign(new Error("private capability path and details"), {
          code,
        });
      });

      expect(result).toEqual({ ok: false, errorCode: code });
    },
  );

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
      catalogRevision: "a".repeat(64),
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

  it("rejects a Beta.26 two-field model selection from new IPC callers", () => {
    expect(() =>
      parseInstallVersionInput({
        definitionId: DEFINITION_ID,
        versionId: VERSION_ID,
        profileName: "fresh-agent",
        modelSelection: {
          sourceProfileId: "configured-source",
          modelLibraryId: MODEL_LIBRARY_ID,
        },
      }),
    ).toThrow("Aera Agent control request is invalid.");
  });
});
