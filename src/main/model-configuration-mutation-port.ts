import type {
  ManagedModelConfigurationWritePlan,
  ManagedModelConfigurationWriteResult,
  ModelConfigurationCommitStage,
} from "./model-configuration-coordinator";

export interface ManagedModelMutationInput<T> {
  readonly operation: string;
  readonly globalCatalog: boolean;
  readonly profileIds: readonly string[];
  readonly stage: ModelConfigurationCommitStage;
  readonly prepare: () =>
    | ManagedModelConfigurationWritePlan<T>
    | Promise<ManagedModelConfigurationWritePlan<T>>;
}

/**
 * Narrow dependency injected into feature services that need to change one of
 * the five managed model files. The feature never receives the coordinator or
 * a constructible write permit directly.
 */
export interface ManagedModelMutationPort {
  mutate<T>(
    input: ManagedModelMutationInput<T>,
  ): Promise<ManagedModelConfigurationWriteResult<T>>;
}

export interface ManagedModelMutationCoordinator {
  runManagedWrite<T>(
    request: {
      requestedProfileId: string;
      scope: "profile" | "global";
      stage: ModelConfigurationCommitStage;
    },
    prepare: ManagedModelMutationInput<T>["prepare"],
  ): Promise<ManagedModelConfigurationWriteResult<T>>;
}

export function requireManagedModelMutationValue<T>(
  result: ManagedModelConfigurationWriteResult<T>,
): T {
  if (result.status === "executed") return result.value;
  throw Object.assign(new Error(result.code), {
    code: result.code,
    stage: result.stage,
    rollback: result.rollback,
    ...(result.diagnosticId ? { diagnosticId: result.diagnosticId } : {}),
  });
}

export function createManagedModelMutationPort(
  coordinator: ManagedModelMutationCoordinator,
): ManagedModelMutationPort {
  return {
    mutate<T>(input: ManagedModelMutationInput<T>) {
      const operation = input.operation.trim();
      const profileIds = [...new Set(input.profileIds.map((id) => id.trim()))]
        .filter(Boolean)
        .sort();
      if (!operation || profileIds.length !== 1) {
        throw new TypeError("Managed model mutation input is invalid.");
      }
      return coordinator.runManagedWrite<T>(
        {
          requestedProfileId: profileIds[0],
          scope: input.globalCatalog ? "global" : "profile",
          stage: input.stage,
        },
        input.prepare,
      );
    },
  };
}
