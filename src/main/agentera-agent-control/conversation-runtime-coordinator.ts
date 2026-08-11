import { randomUUID as nodeRandomUUID } from "node:crypto";
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
import {
  ConversationThreadStore,
  ConversationThreadStoreError,
  type ConversationSegment,
  type ConversationThread,
  type ConversationThreadSnapshot,
  type FailConversationSegmentInput,
  type PrepareConversationSegmentInput as ThreadPrepareConversationSegmentInput,
} from "./conversation-thread-store";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ConversationRuntimeCoordinatorOptions {
  database: AgenteraControlPlaneDatabase;
  bindingStore: RuntimeBindingStore;
  boundaryStore: ConversationBoundaryStore;
  threadStore?: ConversationThreadStore;
  randomUUID?: () => string;
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

export interface PrepareConversationSegmentInput {
  rootConversationKey: string;
  context: AgentAssetContext;
  bindingInput: CreateLocalRuntimeBindingInput;
  historyBoundaryCount: number;
}

export interface PreparedConversationSegment {
  thread: ConversationThread;
  segment: ConversationSegment;
  runtimeBinding: LocalRuntimeBinding;
  boundary: ConversationBoundary;
}

export interface AttachConversationSegmentSessionInput {
  segmentId: string;
  runtimeBindingId: string;
  boundaryId: string;
  sessionId: string;
}

export class ConversationRuntimeCoordinator {
  private readonly database: AgenteraControlPlaneDatabase;
  private readonly bindingStore: RuntimeBindingStore;
  private readonly boundaryStore: ConversationBoundaryStore;
  private readonly threadStore: ConversationThreadStore | null;
  private readonly randomUUID: () => string;

  constructor(options: ConversationRuntimeCoordinatorOptions) {
    this.database = options.database;
    this.bindingStore = options.bindingStore;
    this.boundaryStore = options.boundaryStore;
    this.threadStore = options.threadStore ?? null;
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  prepareSegment(
    input: PrepareConversationSegmentInput,
  ): PreparedConversationSegment {
    return this.withTransaction(() => this.prepareSegmentInTransaction(input));
  }

  prepareSegmentInTransaction(
    input: PrepareConversationSegmentInput,
  ): PreparedConversationSegment {
    const threadStore = this.requireThreadStore();
    const thread = threadStore.getByRootConversationKey(
      input.rootConversationKey,
    )?.thread;
    if (thread === undefined) {
      throw new ConversationThreadStoreError("model_switch_thread_required");
    }
    const segmentId = this.validatedUuid(this.randomUUID());
    const segmentConversationKey = `aera-segment:${thread.id}:${segmentId}`;
    if (
      segmentConversationKey.length > 256 ||
      /[\0\r\n]/.test(segmentConversationKey)
    ) {
      throw new ConversationThreadStoreError("invalid_model_switch_segment");
    }
    const bindingInput: CreateLocalRuntimeBindingInput = {
      ...input.bindingInput,
      conversationKey: segmentConversationKey,
    };
    const runtimeBinding =
      this.bindingStore.getOrCreateForConversationInTransaction(bindingInput);
    const boundary = this.boundaryStore.prepareInTransaction({
      conversationKey: segmentConversationKey,
      resumeSessionId: null,
      context: input.context,
      runtimeBinding,
    });
    this.assertMatchingPair(runtimeBinding, boundary);
    if (runtimeBinding.modelRoute === null) {
      throw new ConversationThreadStoreError("model_switch_segment_conflict");
    }
    const segments = threadStore.listSegments(thread.id);
    const candidateInput: ThreadPrepareConversationSegmentInput = {
      threadId: thread.id,
      segmentId,
      expectedThreadRevision: thread.revision,
      ordinal: Math.max(...segments.map((segment) => segment.ordinal), 0) + 1,
      segmentConversationKey,
      runtimeBindingId: runtimeBinding.id,
      conversationBoundaryId: boundary.id,
      modelRoute: runtimeBinding.modelRoute,
      historyBoundaryCount: input.historyBoundaryCount,
    };
    const prepared = threadStore.prepareCandidateInTransaction(candidateInput);
    return {
      thread: prepared.thread,
      segment: prepared.segment,
      runtimeBinding,
      boundary,
    };
  }

  attachSegmentSession(
    input: AttachConversationSegmentSessionInput,
  ): PreparedConversationSegment {
    return this.withTransaction(() =>
      this.attachSegmentSessionInTransaction(input),
    );
  }

  attachSegmentSessionInTransaction(
    input: AttachConversationSegmentSessionInput,
  ): PreparedConversationSegment {
    const threadStore = this.requireThreadStore();
    const segment = threadStore.getSegment(input.segmentId);
    if (
      segment === null ||
      segment.runtimeBindingId !== input.runtimeBindingId ||
      segment.conversationBoundaryId !== input.boundaryId
    ) {
      throw new ConversationBoundaryStoreError("boundary_conflict");
    }
    const currentBoundary = this.boundaryStore.getById(input.boundaryId);
    if (
      currentBoundary === null ||
      currentBoundary.runtimeBindingId !== input.runtimeBindingId
    ) {
      throw new ConversationBoundaryStoreError("boundary_conflict");
    }
    const runtimeBinding = this.bindingStore.attachHermesSessionInTransaction(
      input.runtimeBindingId,
      input.sessionId,
    );
    const boundary = this.boundaryStore.attachHermesSessionInTransaction(
      input.boundaryId,
      input.sessionId,
    );
    const attachedSegment = threadStore.attachSessionInTransaction(
      input.segmentId,
      input.sessionId,
    );
    if (
      runtimeBinding.hermesSessionId !== input.sessionId ||
      boundary.hermesSessionId !== input.sessionId ||
      attachedSegment.hermesSessionId !== input.sessionId
    ) {
      throw new ConversationBoundaryStoreError("boundary_conflict");
    }
    const thread = threadStore.getThread(attachedSegment.threadId);
    if (thread === null) {
      throw new ConversationThreadStoreError("model_switch_segment_corrupt");
    }
    return {
      thread,
      segment: attachedSegment,
      runtimeBinding,
      boundary,
    };
  }

  activateSegment(
    input: Parameters<ConversationThreadStore["activate"]>[0],
  ): ConversationThreadSnapshot {
    return this.withTransaction(() =>
      this.requireThreadStore().activateInTransaction(input),
    );
  }

  failSegment(input: FailConversationSegmentInput): ConversationThreadSnapshot {
    return this.withTransaction(() =>
      this.requireThreadStore().failInTransaction(input),
    );
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

  private requireThreadStore(): ConversationThreadStore {
    if (this.threadStore === null) {
      throw new ConversationThreadStoreError("model_switch_thread_required");
    }
    return this.threadStore;
  }

  private validatedUuid(value: string): string {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new ConversationThreadStoreError("invalid_model_switch_segment");
    }
    return value.toLowerCase();
  }

  private withTransaction<T>(operation: () => T): T {
    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the original bounded store error.
      }
      throw error;
    }
  }
}
