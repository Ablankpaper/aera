import type { AgentAssetContext, AgenteraControlPlaneDatabase } from "./db";
import {
  ConversationBoundaryStore,
  ConversationBoundaryStoreError,
  type ConversationBoundary,
} from "./conversation-boundary-store";
import {
  RuntimeBindingStore,
  type CreateLocalRuntimeBindingInput,
  type LocalRuntimeBinding,
} from "./runtime-binding-store";

export interface ConversationRuntimeCoordinatorOptions {
  database: AgenteraControlPlaneDatabase;
  bindingStore: RuntimeBindingStore;
  boundaryStore: ConversationBoundaryStore;
}

export interface PrepareConversationRuntimeInput {
  conversationKey: string;
  resumeSessionId: string | null;
  context: AgentAssetContext;
  bindingInput: CreateLocalRuntimeBindingInput | null;
}

export interface PreparedConversationRuntime {
  runtimeBinding: LocalRuntimeBinding | null;
  boundary: ConversationBoundary;
}

export interface AttachConversationRuntimeSessionInput {
  runtimeBindingId: string | null;
  boundaryId: string;
  sessionId: string;
}

export class ConversationRuntimeCoordinator {
  private readonly database: AgenteraControlPlaneDatabase;
  private readonly bindingStore: RuntimeBindingStore;
  private readonly boundaryStore: ConversationBoundaryStore;

  constructor(options: ConversationRuntimeCoordinatorOptions) {
    this.database = options.database;
    this.bindingStore = options.bindingStore;
    this.boundaryStore = options.boundaryStore;
  }

  prepare(input: PrepareConversationRuntimeInput): PreparedConversationRuntime {
    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const runtimeBinding =
        input.bindingInput === null
          ? null
          : this.bindingStore.getOrCreateForConversationInTransaction(
              input.bindingInput,
            );
      const boundary = this.boundaryStore.prepareInTransaction({
        conversationKey:
          runtimeBinding?.conversationKey ?? input.conversationKey,
        resumeSessionId: input.resumeSessionId,
        context: input.context,
        runtimeBinding,
      });
      this.assertMatchingPair(runtimeBinding, boundary);
      this.database.sqlite.exec("COMMIT");
      return { runtimeBinding, boundary };
    } catch (error) {
      try {
        this.database.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the primary SQLite or validation failure.
      }
      throw error;
    }
  }

  attachHermesSession(
    input: AttachConversationRuntimeSessionInput,
  ): PreparedConversationRuntime {
    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const currentBoundary = this.boundaryStore.getById(input.boundaryId);
      if (
        currentBoundary === null ||
        currentBoundary.runtimeBindingId !== input.runtimeBindingId
      ) {
        throw new ConversationBoundaryStoreError("boundary_conflict");
      }
      const runtimeBinding =
        input.runtimeBindingId === null
          ? null
          : this.bindingStore.attachHermesSessionInTransaction(
              input.runtimeBindingId,
              input.sessionId,
            );
      const boundary = this.boundaryStore.attachHermesSessionInTransaction(
        input.boundaryId,
        input.sessionId,
      );
      this.assertMatchingPair(runtimeBinding, boundary);
      if (
        boundary.hermesSessionId !== input.sessionId ||
        (runtimeBinding !== null &&
          runtimeBinding.hermesSessionId !== input.sessionId)
      ) {
        throw new ConversationBoundaryStoreError("boundary_conflict");
      }
      this.database.sqlite.exec("COMMIT");
      return { runtimeBinding, boundary };
    } catch (error) {
      try {
        this.database.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the primary SQLite or validation failure.
      }
      throw error;
    }
  }

  private assertMatchingPair(
    runtimeBinding: LocalRuntimeBinding | null,
    boundary: ConversationBoundary,
  ): void {
    if (runtimeBinding === null) {
      if (
        boundary.runtimeBindingId !== null ||
        boundary.agentInstallationId !== null ||
        boundary.agentDefinitionId !== null ||
        boundary.agentVersionId !== null ||
        boundary.runtimeProfileId !== null ||
        boundary.runtimeVersion !== null ||
        boundary.policySnapshotId !== null ||
        boundary.officialReleaseRevisionId !== null ||
        boundary.toolPermissionSnapshot.kind !== "PROFILE_DEFAULT"
      ) {
        throw new ConversationBoundaryStoreError("boundary_conflict");
      }
      return;
    }
    if (
      boundary.runtimeBindingId !== runtimeBinding.id ||
      boundary.conversationKey !== runtimeBinding.conversationKey ||
      boundary.agentInstallationId !== runtimeBinding.agentInstallationId ||
      boundary.agentDefinitionId !== runtimeBinding.agentDefinitionId ||
      boundary.agentVersionId !== runtimeBinding.agentVersionId ||
      boundary.runtimeProfileId !== runtimeBinding.runtimeProfileId ||
      boundary.runtimeVersion !== runtimeBinding.runtimeVersion ||
      boundary.policySnapshotId !== runtimeBinding.policySnapshotId ||
      boundary.officialReleaseRevisionId !==
        runtimeBinding.officialReleaseRevisionId ||
      boundary.toolPermissionSnapshot.kind !== "AGENT_DIGEST" ||
      boundary.toolPermissionSnapshot.digest !==
        runtimeBinding.toolPermissionDigest
    ) {
      throw new ConversationBoundaryStoreError("boundary_conflict");
    }
  }
}
