import type {
  ManagedModelConfigurationWritePlan,
  ManagedModelConfigurationWriteResult,
  ModelConfigurationCommitStage,
  ModelConfigurationOwnerGuard,
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
    ownerGuard?: ModelConfigurationOwnerGuard,
  ): Promise<ManagedModelConfigurationWriteResult<T>>;
}

export interface ManagedModelMutationOwnerLease {
  guard: ModelConfigurationOwnerGuard;
  finish(): void;
}

export type ManagedModelMutationOwnerGuardFactory = () =>
  | ManagedModelMutationOwnerLease
  | Promise<ManagedModelMutationOwnerLease>;

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
  ownerGuardFactory?: ManagedModelMutationOwnerGuardFactory,
): ManagedModelMutationPort {
  return {
    async mutate<T>(input: ManagedModelMutationInput<T>) {
      const operation = input.operation.trim();
      const profileIds = [...new Set(input.profileIds.map((id) => id.trim()))]
        .filter(Boolean)
        .sort();
      if (!operation || profileIds.length !== 1) {
        throw new TypeError("Managed model mutation input is invalid.");
      }
      const request = {
        requestedProfileId: profileIds[0],
        scope: input.globalCatalog ? ("global" as const) : ("profile" as const),
        stage: input.stage,
      };
      if (!ownerGuardFactory) {
        return coordinator.runManagedWrite<T>(request, input.prepare);
      }
      const ownerLease = await ownerGuardFactory();
      try {
        return await coordinator.runManagedWrite<T>(
          request,
          input.prepare,
          ownerLease.guard,
        );
      } finally {
        ownerLease.finish();
      }
    },
  };
}
