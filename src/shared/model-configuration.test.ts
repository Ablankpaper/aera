import { describe, expect, it } from "vitest";
import {
  canonicalPublicRouteKey,
  isSafeToRetryStaleRevision,
  type LegacyModelConfigurationMutationFailure,
  type ModelConfigurationStage,
  type ModelConfigurationStartupFailureCode,
  type OwnerModelRouteCatalogSnapshot,
} from "./model-configuration";

describe("model configuration contract", () => {
  it("keeps legacy adapters from inventing a recovery-stage save code", () => {
    const failure: LegacyModelConfigurationMutationFailure = {
      status: "rejected",
      stage: "recovery",
      // @ts-expect-error Recovery has one stable public identity.
      code: "model_save_recovery_failed",
      rollback: "recovery_required",
    };

    expect(failure.code).toBe("model_save_recovery_failed");
  });

  it("uses API mode in public identity without exposing credentials", () => {
    expect(
      canonicalPublicRouteKey({
        provider: "custom:petoi",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1/",
        apiMode: "codex_responses",
      }),
    ).not.toBe(
      canonicalPublicRouteKey({
        provider: "custom:petoi",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "chat_completions",
      }),
    );

    const snapshot: OwnerModelRouteCatalogSnapshot = {
      revision: "revision-1",
      targetProfileId: "default",
      routes: [],
    };
    expect(JSON.stringify(snapshot)).not.toMatch(
      /apiKey|credentialRef|secret/i,
    );
  });

  it("emits the versioned route identity used by new journal rows", () => {
    expect(
      canonicalPublicRouteKey({
        provider: "Custom:Petoi",
        model: "gpt-5.6-sol",
        baseUrl: "HTTPS://API.Example.COM:443/v1/",
        apiMode: "Codex_Responses",
      }),
    ).toBe(
      [
        "v2",
        "custom:petoi",
        "gpt-5.6-sol",
        "https://api.example.com/v1",
        "codex_responses",
      ].join("\0"),
    );
  });

  it("keeps startup failures distinct from a replayable stale revision", () => {
    const startupCodes: ModelConfigurationStartupFailureCode[] = [
      "native_module_abi_mismatch",
      "native_module_architecture_mismatch",
      "native_module_dependency_missing",
      "native_module_load_denied",
      "native_module_load_failed",
      "model_configuration_database_unavailable",
      "model_configuration_schema_unsupported",
      "route_catalog_repair_required",
      "model_configuration_recovery_required",
    ];
    for (const code of startupCodes) {
      expect(
        isSafeToRetryStaleRevision({
          status: "rejected",
          stage: "validation",
          code,
          rollback: "not_needed",
        }),
      ).toBe(false);
    }
  });
});

/**
 * A save rejected for a stale catalog revision wrote nothing, so replaying it
 * against a fresh catalog is safe. Every other rejection has already entered a
 * write stage and must never be replayed.
 *
 * @lat: [[legacy-model-config-migration#Stale catalog retry policy]]
 */
describe("stale catalog revision retry policy", () => {
  const rejected = (
    stage: ModelConfigurationStage,
    rollback: "not_needed" | "restored" | "recovery_required",
    reason?: "stale_catalog_revision",
  ): LegacyModelConfigurationMutationFailure => ({
    status: "rejected",
    stage,
    code:
      stage === "recovery"
        ? "model_configuration_recovery_required"
        : (`model_save_${stage}_failed` as Exclude<
            LegacyModelConfigurationMutationFailure["code"],
            "model_configuration_recovery_required"
          >),
    rollback,
    ...(reason ? { reason } : {}),
  });

  // @lat: [[legacy-model-config-migration#Stale catalog retry policy#Retries a pre-write validation rejection]]
  it("permits a retry only when the rejection names a stale revision", () => {
    expect(
      isSafeToRetryStaleRevision(
        rejected("validation", "not_needed", "stale_catalog_revision"),
      ),
    ).toBe(true);
    // The stage/rollback pair alone is shared with refusals a replay cannot fix.
    expect(
      isSafeToRetryStaleRevision(rejected("validation", "not_needed")),
    ).toBe(false);
  });

  // @lat: [[legacy-model-config-migration#Stale catalog retry policy#Never retries a stage that already wrote]]
  it("refuses to replay any stage that already touched disk", () => {
    const writeStages: ModelConfigurationStage[] = [
      "credential",
      "provider",
      "model_library",
      "native_route",
      "activation",
    ];
    // Each case carries the stale-revision reason, so only the stage and
    // rollback checks can be what refuses the replay.
    const stale = "stale_catalog_revision" as const;
    for (const stage of writeStages) {
      expect(
        isSafeToRetryStaleRevision(rejected(stage, "restored", stale)),
      ).toBe(false);
      expect(
        isSafeToRetryStaleRevision(rejected(stage, "not_needed", stale)),
      ).toBe(false);
    }
    // A validation rejection that did roll back a write is also off limits.
    expect(
      isSafeToRetryStaleRevision(rejected("validation", "restored", stale)),
    ).toBe(false);
    expect(
      isSafeToRetryStaleRevision(
        rejected("validation", "recovery_required", stale),
      ),
    ).toBe(false);
  });

  // @lat: [[legacy-model-config-migration#Stale catalog retry policy#Never retries a committed save]]
  it("never retries a committed save", () => {
    const catalog: OwnerModelRouteCatalogSnapshot = {
      revision: "revision-2",
      targetProfileId: "default",
      routes: [],
    };
    expect(isSafeToRetryStaleRevision({ status: "committed", catalog })).toBe(
      false,
    );
    expect(
      isSafeToRetryStaleRevision({
        status: "committed_refresh_warning",
        catalog,
        warning: "model_save_refresh_failed",
      }),
    ).toBe(false);
  });
});
