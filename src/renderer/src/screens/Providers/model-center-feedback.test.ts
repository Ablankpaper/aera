import { describe, expect, it } from "vitest";
import type { ModelConfigurationFailureCode } from "../../../../shared/model-configuration";
import { modelConfigurationFeedback } from "./model-center-feedback";

const cases: Array<[ModelConfigurationFailureCode, string]> = [
  [
    "native_module_abi_mismatch",
    "providers.center.errors.nativeModuleAbiMismatch",
  ],
  [
    "native_module_architecture_mismatch",
    "providers.center.errors.nativeModuleArchitectureMismatch",
  ],
  [
    "native_module_dependency_missing",
    "providers.center.errors.nativeModuleDependencyMissing",
  ],
  [
    "native_module_load_denied",
    "providers.center.errors.nativeModuleLoadDenied",
  ],
  [
    "native_module_load_failed",
    "providers.center.errors.nativeModuleLoadFailed",
  ],
  [
    "model_configuration_database_unavailable",
    "providers.center.errors.databaseUnavailable",
  ],
  [
    "model_configuration_schema_unsupported",
    "providers.center.errors.schemaUnsupported",
  ],
  [
    "route_catalog_repair_required",
    "providers.center.errors.routeCatalogRepairRequired",
  ],
  [
    "model_configuration_recovery_required",
    "providers.center.errors.recoveryRequired",
  ],
  ["model_configuration_auth_required", "providers.center.errors.authRequired"],
  [
    "model_save_stale_catalog_revision",
    "providers.center.errors.staleCatalogRevision",
  ],
  [
    "model_owner_transition_in_progress",
    "providers.center.errors.ownerTransitionInProgress",
  ],
  ["model_owner_changed", "providers.center.errors.ownerChanged"],
  [
    "owner_transition_timeout",
    "providers.center.errors.ownerTransitionTimeout",
  ],
  ["owner_transition_failed", "providers.center.errors.ownerTransitionFailed"],
  ["model_save_validation_failed", "providers.center.errors.validation"],
  ["model_save_credential_failed", "providers.center.errors.credential"],
  ["model_save_provider_failed", "providers.center.errors.provider"],
  ["model_save_model_library_failed", "providers.center.errors.modelLibrary"],
  ["model_save_native_route_failed", "providers.center.errors.route"],
  ["model_save_activation_failed", "providers.center.errors.activation"],
  ["model_save_verification_failed", "providers.center.errors.verification"],
  ["model_save_rollback_failed", "providers.center.errors.rollback"],
  ["model_rollback_refresh_failed", "providers.center.errors.refreshFailed"],
];

describe("model configuration feedback", () => {
  it.each(cases)(
    "maps %s without relabeling it as recovery",
    (code, messageKey) => {
      expect(modelConfigurationFeedback(code, "not_retryable")).toMatchObject({
        messageKey,
      });
    },
  );

  it("uses an honest fallback for a future code", () => {
    expect(
      modelConfigurationFeedback(
        "future_failure" as ModelConfigurationFailureCode,
        "not_retryable",
      ),
    ).toMatchObject({ messageKey: "providers.center.errors.unknownFailure" });
  });
});
