import { randomUUID as nodeRandomUUID } from "node:crypto";
import type { PublicModelRouteIdentity } from "../../shared/model-configuration";
import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type { AgenteraControlPlaneDatabase } from "./db";
import {
  parseFrozenAgentModelRoute,
  serializeFrozenAgentModelRoute,
  type FrozenAgentModelRoute,
} from "./frozen-agent-model-route";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEGMENT_STATES = ["preparing", "active", "superseded", "failed"] as const;

export type ConversationSegmentState = (typeof SEGMENT_STATES)[number];

export interface ConversationThread {
  id: string;
  rootConversationKey: string;
  activeSegmentId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSegment {
  id: string;
  threadId: string;
  ordinal: number;
  segmentConversationKey: string;
  state: ConversationSegmentState;
  route: PublicModelRouteIdentity;
  sourceProfileId: string | null;
  modelLibraryId: string | null;
  runtimeBindingId: string;
  conversationBoundaryId: string;
  hermesSessionId: string | null;
  historyBoundaryCount: number;
  createdAt: string;
  activatedAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
}

export interface ConversationThreadSnapshot {
  thread: ConversationThread;
  segment: ConversationSegment;
}

export interface AdoptConversationSegmentInput {
  rootConversationKey: string;
  runtimeBindingId: string;
  conversationBoundaryId: string;
  hermesSessionId: string | null;
  modelRoute: FrozenAgentModelRoute;
  historyBoundaryCount: number;
}

export interface PrepareConversationSegmentInput {
  threadId: string;
  segmentId?: string;
  expectedThreadRevision: number;
  ordinal: number;
  segmentConversationKey: string;
  runtimeBindingId: string;
  conversationBoundaryId: string;
  modelRoute: FrozenAgentModelRoute;
  historyBoundaryCount: number;
}

export interface ActivateConversationSegmentInput {
  threadId: string;
  segmentId: string;
  expectedThreadRevision: number;
}

export interface FailConversationSegmentInput extends ActivateConversationSegmentInput {
  code: string;
}

export type ConversationThreadStoreErrorCode =
  | "invalid_model_switch_segment"
  | "model_switch_thread_required"
  | "model_switch_segment_required"
  | "model_switch_segment_conflict"
  | "model_switch_segment_corrupt";

export class ConversationThreadStoreError extends Error {
  readonly code: ConversationThreadStoreErrorCode;

  constructor(code: ConversationThreadStoreErrorCode) {
    super(`Aera conversation segment failed: ${code}.`);
    this.name = "ConversationThreadStoreError";
    this.code = code;
  }
}

export interface ConversationThreadStoreOptions {
  database: AgenteraControlPlaneDatabase;
  owner: AgenteraRuntimeOwner;
  now?: () => Date;
  randomUUID?: () => string;
}

interface ThreadRow {
  id?: unknown;
  tenant_id?: unknown;
  owner_id?: unknown;
  device_installation_id?: unknown;
  root_conversation_key?: unknown;
  active_segment_id?: unknown;
  revision?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface SegmentRow {
  id?: unknown;
  thread_id?: unknown;
  ordinal?: unknown;
  segment_conversation_key?: unknown;
  state?: unknown;
  route_json?: unknown;
  source_profile_id?: unknown;
  source_model_id?: unknown;
  runtime_binding_id?: unknown;
  conversation_boundary_id?: unknown;
  hermes_session_id?: unknown;
  history_boundary_count?: unknown;
  created_at?: unknown;
  activated_at?: unknown;
  failed_at?: unknown;
  failure_code?: unknown;
  thread_tenant_id?: unknown;
  thread_owner_id?: unknown;
  thread_device_installation_id?: unknown;
}

interface RuntimePairRow {
  binding_conversation_key?: unknown;
  binding_session_id?: unknown;
  binding_json?: unknown;
  boundary_conversation_key?: unknown;
  boundary_session_id?: unknown;
  boundary_runtime_binding_id?: unknown;
}

const SELECT_THREAD = `
  SELECT id, tenant_id, owner_id, device_installation_id,
         root_conversation_key, active_segment_id, revision,
         created_at, updated_at
  FROM conversation_threads
`;

const SELECT_SEGMENT = `
  SELECT segment.id, segment.thread_id, segment.ordinal,
         segment.segment_conversation_key, segment.state,
         segment.route_json, segment.source_profile_id,
         segment.source_model_id, segment.runtime_binding_id,
         segment.conversation_boundary_id, segment.hermes_session_id,
         segment.history_boundary_count, segment.created_at,
         segment.activated_at, segment.failed_at, segment.failure_code,
         thread.tenant_id AS thread_tenant_id,
         thread.owner_id AS thread_owner_id,
         thread.device_installation_id AS thread_device_installation_id
  FROM conversation_segments AS segment
  INNER JOIN conversation_threads AS thread ON thread.id = segment.thread_id
`;

function storeError(
  code: ConversationThreadStoreErrorCode,
): ConversationThreadStoreError {
  return new ConversationThreadStoreError(code);
}

function uuid(value: unknown, code: ConversationThreadStoreErrorCode): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw storeError(code);
  }
  return value.toLowerCase();
}

function boundedText(
  value: unknown,
  maximum: number,
  code: ConversationThreadStoreErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\0\r\n]/.test(value)
  ) {
    throw storeError(code);
  }
  return value;
}

function nullableText(
  value: unknown,
  maximum: number,
  code: ConversationThreadStoreErrorCode,
): string | null {
  return value === null ? null : boundedText(value, maximum, code);
}

function positiveInteger(
  value: unknown,
  code: ConversationThreadStoreErrorCode,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw storeError(code);
  }
  return Number(value);
}

function nonnegativeInteger(
  value: unknown,
  code: ConversationThreadStoreErrorCode,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw storeError(code);
  }
  return Number(value);
}

function timestamp(
  value: unknown,
  code: ConversationThreadStoreErrorCode,
): string {
  if (typeof value !== "string") throw storeError(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw storeError(code);
  }
  return value;
}

function nullableTimestamp(
  value: unknown,
  code: ConversationThreadStoreErrorCode,
): string | null {
  return value === null ? null : timestamp(value, code);
}

function currentTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw storeError("invalid_model_switch_segment");
  }
  return value.toISOString();
}

function revision(
  value: unknown,
  code: ConversationThreadStoreErrorCode,
): number {
  return positiveInteger(value, code);
}

function segmentState(value: unknown): ConversationSegmentState {
  if (
    typeof value !== "string" ||
    !SEGMENT_STATES.includes(value as ConversationSegmentState)
  ) {
    throw storeError("model_switch_segment_corrupt");
  }
  return value as ConversationSegmentState;
}

function failureCode(
  value: unknown,
  code: ConversationThreadStoreErrorCode,
): string {
  const normalized = boundedText(value, 128, code);
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(normalized)) {
    throw storeError(code);
  }
  return normalized;
}

function parseFrozenRoute(
  value: unknown,
  code: ConversationThreadStoreErrorCode,
): FrozenAgentModelRoute {
  try {
    return parseFrozenAgentModelRoute(value);
  } catch {
    throw storeError(code);
  }
}

function frozenRouteJson(
  route: FrozenAgentModelRoute,
  code: ConversationThreadStoreErrorCode,
): string {
  try {
    return serializeFrozenAgentModelRoute(route);
  } catch {
    throw storeError(code);
  }
}

function publicRoute(route: FrozenAgentModelRoute): PublicModelRouteIdentity {
  return {
    provider: route.provider,
    model: route.model,
    baseUrl: route.baseUrl,
    apiMode: route.apiMode,
  };
}

function parseThread(
  row: ThreadRow,
  owner: AgenteraRuntimeOwner,
): ConversationThread {
  if (
    row.tenant_id !== owner.tenantId ||
    row.owner_id !== owner.ownerId ||
    row.device_installation_id !== owner.deviceInstallationId
  ) {
    throw storeError("model_switch_segment_corrupt");
  }
  return {
    id: uuid(row.id, "model_switch_segment_corrupt"),
    rootConversationKey: boundedText(
      row.root_conversation_key,
      256,
      "model_switch_segment_corrupt",
    ),
    activeSegmentId: uuid(
      row.active_segment_id,
      "model_switch_segment_corrupt",
    ),
    revision: revision(row.revision, "model_switch_segment_corrupt"),
    createdAt: timestamp(row.created_at, "model_switch_segment_corrupt"),
    updatedAt: timestamp(row.updated_at, "model_switch_segment_corrupt"),
  };
}

function parseSegment(
  row: SegmentRow,
  owner: AgenteraRuntimeOwner,
): ConversationSegment {
  if (
    row.thread_tenant_id !== owner.tenantId ||
    row.thread_owner_id !== owner.ownerId ||
    row.thread_device_installation_id !== owner.deviceInstallationId ||
    typeof row.route_json !== "string"
  ) {
    throw storeError("model_switch_segment_corrupt");
  }
  let routeValue: unknown;
  try {
    routeValue = JSON.parse(row.route_json);
  } catch {
    throw storeError("model_switch_segment_corrupt");
  }
  const frozen = parseFrozenRoute(routeValue, "model_switch_segment_corrupt");
  const sourceProfileId = nullableText(
    row.source_profile_id,
    64,
    "model_switch_segment_corrupt",
  );
  const modelLibraryId = nullableText(
    row.source_model_id,
    512,
    "model_switch_segment_corrupt",
  );
  if (
    sourceProfileId !== frozen.sourceProfileId ||
    modelLibraryId !== frozen.modelLibraryId
  ) {
    throw storeError("model_switch_segment_corrupt");
  }
  const state = segmentState(row.state);
  const activatedAt = nullableTimestamp(
    row.activated_at,
    "model_switch_segment_corrupt",
  );
  const failedAt = nullableTimestamp(
    row.failed_at,
    "model_switch_segment_corrupt",
  );
  const parsedFailureCode =
    row.failure_code === null
      ? null
      : failureCode(row.failure_code, "model_switch_segment_corrupt");
  if (
    (state === "preparing" &&
      (activatedAt !== null ||
        failedAt !== null ||
        parsedFailureCode !== null)) ||
    ((state === "active" || state === "superseded") &&
      (activatedAt === null ||
        failedAt !== null ||
        parsedFailureCode !== null)) ||
    (state === "failed" &&
      (activatedAt !== null || failedAt === null || parsedFailureCode === null))
  ) {
    throw storeError("model_switch_segment_corrupt");
  }
  return {
    id: uuid(row.id, "model_switch_segment_corrupt"),
    threadId: uuid(row.thread_id, "model_switch_segment_corrupt"),
    ordinal: positiveInteger(row.ordinal, "model_switch_segment_corrupt"),
    segmentConversationKey: boundedText(
      row.segment_conversation_key,
      256,
      "model_switch_segment_corrupt",
    ),
    state,
    route: publicRoute(frozen),
    sourceProfileId,
    modelLibraryId,
    runtimeBindingId: uuid(
      row.runtime_binding_id,
      "model_switch_segment_corrupt",
    ),
    conversationBoundaryId: uuid(
      row.conversation_boundary_id,
      "model_switch_segment_corrupt",
    ),
    hermesSessionId: nullableText(
      row.hermes_session_id,
      512,
      "model_switch_segment_corrupt",
    ),
    historyBoundaryCount: nonnegativeInteger(
      row.history_boundary_count,
      "model_switch_segment_corrupt",
    ),
    createdAt: timestamp(row.created_at, "model_switch_segment_corrupt"),
    activatedAt,
    failedAt,
    failureCode: parsedFailureCode,
  };
}

export class ConversationThreadStore {
  private readonly database: AgenteraControlPlaneDatabase;
  private readonly owner: AgenteraRuntimeOwner;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(options: ConversationThreadStoreOptions) {
    this.database = options.database;
    this.owner = {
      tenantId: uuid(options.owner?.tenantId, "invalid_model_switch_segment"),
      ownerId: uuid(options.owner?.ownerId, "invalid_model_switch_segment"),
      deviceInstallationId: uuid(
        options.owner?.deviceInstallationId,
        "invalid_model_switch_segment",
      ),
    };
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  adopt(input: AdoptConversationSegmentInput): ConversationThreadSnapshot {
    return this.transaction(
      () => this.adoptInTransaction(input),
      "model_switch_segment_conflict",
    );
  }

  adoptInTransaction(
    input: AdoptConversationSegmentInput,
  ): ConversationThreadSnapshot {
    const rootConversationKey = boundedText(
      input?.rootConversationKey,
      256,
      "invalid_model_switch_segment",
    );
    const runtimeBindingId = uuid(
      input?.runtimeBindingId,
      "invalid_model_switch_segment",
    );
    const conversationBoundaryId = uuid(
      input?.conversationBoundaryId,
      "invalid_model_switch_segment",
    );
    const hermesSessionId = nullableText(
      input?.hermesSessionId,
      512,
      "invalid_model_switch_segment",
    );
    const modelRoute = parseFrozenRoute(
      input?.modelRoute,
      "invalid_model_switch_segment",
    );
    const historyBoundaryCount = nonnegativeInteger(
      input?.historyBoundaryCount,
      "invalid_model_switch_segment",
    );
    this.assertRuntimePair({
      runtimeBindingId,
      conversationBoundaryId,
      conversationKey: rootConversationKey,
      hermesSessionId,
      modelRoute,
    });

    const existing = this.getByRootConversationKey(rootConversationKey);
    if (existing !== null) {
      const existingRoute = this.frozenRouteForSegment(existing.segment.id);
      if (
        existing.segment.ordinal !== 1 ||
        existing.segment.state !== "active" ||
        existing.segment.segmentConversationKey !== rootConversationKey ||
        existing.segment.runtimeBindingId !== runtimeBindingId ||
        existing.segment.conversationBoundaryId !== conversationBoundaryId ||
        existing.segment.hermesSessionId !== hermesSessionId ||
        existing.segment.historyBoundaryCount !== historyBoundaryCount ||
        frozenRouteJson(existingRoute, "model_switch_segment_corrupt") !==
          frozenRouteJson(modelRoute, "invalid_model_switch_segment")
      ) {
        throw storeError("model_switch_segment_conflict");
      }
      return existing;
    }

    const threadId = uuid(this.randomUUID(), "invalid_model_switch_segment");
    const segmentId = uuid(this.randomUUID(), "invalid_model_switch_segment");
    const createdAt = currentTimestamp(this.now);
    try {
      this.database.sqlite
        .prepare(
          `INSERT INTO conversation_threads (
             id, tenant_id, owner_id, device_installation_id,
             root_conversation_key, active_segment_id, revision,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
        )
        .run(
          threadId,
          this.owner.tenantId,
          this.owner.ownerId,
          this.owner.deviceInstallationId,
          rootConversationKey,
          createdAt,
          createdAt,
        );
      this.database.sqlite
        .prepare(
          `INSERT INTO conversation_segments (
             id, thread_id, ordinal, segment_conversation_key, state,
             route_json, source_profile_id, source_model_id,
             runtime_binding_id, conversation_boundary_id, hermes_session_id,
             history_boundary_count, created_at, activated_at,
             failed_at, failure_code
           ) VALUES (?, ?, 1, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          segmentId,
          threadId,
          rootConversationKey,
          frozenRouteJson(modelRoute, "invalid_model_switch_segment"),
          modelRoute.sourceProfileId,
          modelRoute.modelLibraryId,
          runtimeBindingId,
          conversationBoundaryId,
          hermesSessionId,
          historyBoundaryCount,
          createdAt,
          createdAt,
        );
      const updated = this.database.sqlite
        .prepare(
          `UPDATE conversation_threads
           SET active_segment_id = ?
           WHERE id = ? AND tenant_id = ? AND owner_id = ?
             AND device_installation_id = ? AND active_segment_id IS NULL`,
        )
        .run(
          segmentId,
          threadId,
          this.owner.tenantId,
          this.owner.ownerId,
          this.owner.deviceInstallationId,
        );
      if (Number(updated.changes) !== 1) {
        throw storeError("model_switch_segment_conflict");
      }
    } catch (error) {
      if (error instanceof ConversationThreadStoreError) throw error;
      throw storeError("model_switch_segment_conflict");
    }
    return this.requiredSnapshot(threadId, segmentId);
  }

  prepareCandidate(
    input: PrepareConversationSegmentInput,
  ): ConversationThreadSnapshot {
    return this.transaction(
      () => this.prepareCandidateInTransaction(input),
      "model_switch_segment_conflict",
    );
  }

  prepareCandidateInTransaction(
    input: PrepareConversationSegmentInput,
  ): ConversationThreadSnapshot {
    const threadId = uuid(input?.threadId, "invalid_model_switch_segment");
    const expectedThreadRevision = revision(
      input?.expectedThreadRevision,
      "invalid_model_switch_segment",
    );
    const ordinal = positiveInteger(
      input?.ordinal,
      "invalid_model_switch_segment",
    );
    const segmentConversationKey = boundedText(
      input?.segmentConversationKey,
      256,
      "invalid_model_switch_segment",
    );
    if (!segmentConversationKey.startsWith("aera-segment:")) {
      throw storeError("invalid_model_switch_segment");
    }
    const runtimeBindingId = uuid(
      input?.runtimeBindingId,
      "invalid_model_switch_segment",
    );
    const conversationBoundaryId = uuid(
      input?.conversationBoundaryId,
      "invalid_model_switch_segment",
    );
    const modelRoute = parseFrozenRoute(
      input?.modelRoute,
      "invalid_model_switch_segment",
    );
    if (
      modelRoute.legacy ||
      modelRoute.sourceProfileId === null ||
      modelRoute.modelLibraryId === null
    ) {
      throw storeError("model_switch_segment_conflict");
    }
    const historyBoundaryCount = nonnegativeInteger(
      input?.historyBoundaryCount,
      "invalid_model_switch_segment",
    );
    const thread = this.getThread(threadId);
    if (
      thread === null ||
      thread.revision !== expectedThreadRevision ||
      thread.rootConversationKey === segmentConversationKey
    ) {
      throw storeError("model_switch_segment_conflict");
    }
    const latest = this.database.sqlite
      .prepare(
        `SELECT COALESCE(MAX(ordinal), 0) AS ordinal,
                SUM(CASE WHEN state = 'preparing' THEN 1 ELSE 0 END) AS preparing
         FROM conversation_segments WHERE thread_id = ?`,
      )
      .get(threadId) as { ordinal?: unknown; preparing?: unknown } | undefined;
    if (
      latest === undefined ||
      !Number.isSafeInteger(latest.ordinal) ||
      !Number.isSafeInteger(latest.preparing) ||
      ordinal !== Number(latest.ordinal) + 1 ||
      Number(latest.preparing) !== 0
    ) {
      throw storeError("model_switch_segment_conflict");
    }
    this.assertRuntimePair({
      runtimeBindingId,
      conversationBoundaryId,
      conversationKey: segmentConversationKey,
      hermesSessionId: null,
      modelRoute,
    });
    const segmentId = uuid(
      input?.segmentId ?? this.randomUUID(),
      "invalid_model_switch_segment",
    );
    const createdAt = currentTimestamp(this.now);
    try {
      this.database.sqlite
        .prepare(
          `INSERT INTO conversation_segments (
             id, thread_id, ordinal, segment_conversation_key, state,
             route_json, source_profile_id, source_model_id,
             runtime_binding_id, conversation_boundary_id, hermes_session_id,
             history_boundary_count, created_at, activated_at,
             failed_at, failure_code
           ) VALUES (?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          segmentId,
          threadId,
          ordinal,
          segmentConversationKey,
          frozenRouteJson(modelRoute, "invalid_model_switch_segment"),
          modelRoute.sourceProfileId,
          modelRoute.modelLibraryId,
          runtimeBindingId,
          conversationBoundaryId,
          historyBoundaryCount,
          createdAt,
        );
    } catch {
      throw storeError("model_switch_segment_conflict");
    }
    return this.requiredSnapshot(threadId, segmentId);
  }

  attachSession(
    segmentIdValue: string,
    sessionIdValue: string,
  ): ConversationSegment {
    return this.transaction(
      () => this.attachSessionInTransaction(segmentIdValue, sessionIdValue),
      "model_switch_segment_conflict",
    );
  }

  attachSessionInTransaction(
    segmentIdValue: string,
    sessionIdValue: string,
  ): ConversationSegment {
    const segmentId = uuid(segmentIdValue, "invalid_model_switch_segment");
    const sessionId = boundedText(
      sessionIdValue,
      512,
      "invalid_model_switch_segment",
    );
    const segment = this.getSegment(segmentId);
    if (
      segment === null ||
      (segment.state !== "preparing" && segment.state !== "active")
    ) {
      throw storeError("model_switch_segment_conflict");
    }
    const modelRoute = this.frozenRouteForSegment(segmentId);
    this.assertRuntimePair({
      runtimeBindingId: segment.runtimeBindingId,
      conversationBoundaryId: segment.conversationBoundaryId,
      conversationKey: segment.segmentConversationKey,
      hermesSessionId: sessionId,
      modelRoute,
    });
    if (segment.hermesSessionId === sessionId) return segment;
    if (segment.hermesSessionId !== null) {
      throw storeError("model_switch_segment_conflict");
    }
    let result;
    try {
      result = this.database.sqlite
        .prepare(
          `UPDATE conversation_segments
           SET hermes_session_id = ?
           WHERE id = ? AND thread_id = ? AND hermes_session_id IS NULL`,
        )
        .run(sessionId, segmentId, segment.threadId);
    } catch {
      throw storeError("model_switch_segment_conflict");
    }
    if (Number(result.changes) !== 1) {
      throw storeError("model_switch_segment_conflict");
    }
    return this.getSegment(segmentId) ?? segment;
  }

  activate(
    input: ActivateConversationSegmentInput,
  ): ConversationThreadSnapshot {
    return this.transaction(
      () => this.activateInTransaction(input),
      "model_switch_segment_conflict",
    );
  }

  activateInTransaction(
    input: ActivateConversationSegmentInput,
  ): ConversationThreadSnapshot {
    const threadId = uuid(input?.threadId, "invalid_model_switch_segment");
    const segmentId = uuid(input?.segmentId, "invalid_model_switch_segment");
    const expectedThreadRevision = revision(
      input?.expectedThreadRevision,
      "invalid_model_switch_segment",
    );
    const thread = this.getThread(threadId);
    const segment = this.getSegment(segmentId);
    if (
      thread === null ||
      segment === null ||
      segment.threadId !== thread.id ||
      thread.revision !== expectedThreadRevision ||
      segment.state !== "preparing" ||
      segment.hermesSessionId === null ||
      thread.activeSegmentId === segment.id
    ) {
      throw storeError("model_switch_segment_conflict");
    }
    const active = this.getSegment(thread.activeSegmentId);
    if (
      active === null ||
      active.threadId !== thread.id ||
      active.state !== "active" ||
      active.ordinal >= segment.ordinal
    ) {
      throw storeError("model_switch_segment_conflict");
    }
    this.assertRuntimePair({
      runtimeBindingId: segment.runtimeBindingId,
      conversationBoundaryId: segment.conversationBoundaryId,
      conversationKey: segment.segmentConversationKey,
      hermesSessionId: segment.hermesSessionId,
      modelRoute: this.frozenRouteForSegment(segment.id),
    });
    const activatedAt = currentTimestamp(this.now);
    try {
      const superseded = this.database.sqlite
        .prepare(
          `UPDATE conversation_segments SET state = 'superseded'
           WHERE id = ? AND thread_id = ? AND state = 'active'`,
        )
        .run(active.id, thread.id);
      const activated = this.database.sqlite
        .prepare(
          `UPDATE conversation_segments
           SET state = 'active', activated_at = ?
           WHERE id = ? AND thread_id = ? AND state = 'preparing'
             AND hermes_session_id = ?`,
        )
        .run(activatedAt, segment.id, thread.id, segment.hermesSessionId);
      const advanced = this.database.sqlite
        .prepare(
          `UPDATE conversation_threads
           SET active_segment_id = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND owner_id = ?
             AND device_installation_id = ? AND active_segment_id = ?
             AND revision = ?`,
        )
        .run(
          segment.id,
          activatedAt,
          thread.id,
          this.owner.tenantId,
          this.owner.ownerId,
          this.owner.deviceInstallationId,
          active.id,
          expectedThreadRevision,
        );
      if (
        Number(superseded.changes) !== 1 ||
        Number(activated.changes) !== 1 ||
        Number(advanced.changes) !== 1
      ) {
        throw storeError("model_switch_segment_conflict");
      }
    } catch (error) {
      if (error instanceof ConversationThreadStoreError) throw error;
      throw storeError("model_switch_segment_conflict");
    }
    return this.requiredSnapshot(thread.id, segment.id);
  }

  fail(input: FailConversationSegmentInput): ConversationThreadSnapshot {
    return this.transaction(
      () => this.failInTransaction(input),
      "model_switch_segment_conflict",
    );
  }

  failInTransaction(
    input: FailConversationSegmentInput,
  ): ConversationThreadSnapshot {
    const threadId = uuid(input?.threadId, "invalid_model_switch_segment");
    const segmentId = uuid(input?.segmentId, "invalid_model_switch_segment");
    const expectedThreadRevision = revision(
      input?.expectedThreadRevision,
      "invalid_model_switch_segment",
    );
    const code = failureCode(input?.code, "invalid_model_switch_segment");
    const thread = this.getThread(threadId);
    const segment = this.getSegment(segmentId);
    if (
      thread === null ||
      segment === null ||
      segment.threadId !== thread.id ||
      thread.revision !== expectedThreadRevision ||
      thread.activeSegmentId === segment.id
    ) {
      throw storeError("model_switch_segment_conflict");
    }
    if (segment.state === "failed" && segment.failureCode === code) {
      return { thread, segment };
    }
    if (segment.state !== "preparing") {
      throw storeError("model_switch_segment_conflict");
    }
    const failedAt = currentTimestamp(this.now);
    const result = this.database.sqlite
      .prepare(
        `UPDATE conversation_segments
         SET state = 'failed', failed_at = ?, failure_code = ?
         WHERE id = ? AND thread_id = ? AND state = 'preparing'`,
      )
      .run(failedAt, code, segment.id, thread.id);
    if (Number(result.changes) !== 1) {
      throw storeError("model_switch_segment_conflict");
    }
    return this.requiredSnapshot(thread.id, segment.id);
  }

  getThread(threadIdValue: string): ConversationThread | null {
    const threadId = uuid(threadIdValue, "invalid_model_switch_segment");
    const row = this.database.sqlite
      .prepare(
        `${SELECT_THREAD}
         WHERE id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ?`,
      )
      .get(
        threadId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      ) as ThreadRow | undefined;
    return row === undefined ? null : parseThread(row, this.owner);
  }

  getSegment(segmentIdValue: string): ConversationSegment | null {
    const segmentId = uuid(segmentIdValue, "invalid_model_switch_segment");
    const row = this.database.sqlite
      .prepare(
        `${SELECT_SEGMENT}
         WHERE segment.id = ? AND thread.tenant_id = ?
           AND thread.owner_id = ? AND thread.device_installation_id = ?`,
      )
      .get(
        segmentId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      ) as SegmentRow | undefined;
    return row === undefined ? null : parseSegment(row, this.owner);
  }

  getByRootConversationKey(
    keyValue: string,
  ): ConversationThreadSnapshot | null {
    const key = boundedText(keyValue, 256, "invalid_model_switch_segment");
    const row = this.database.sqlite
      .prepare(
        `${SELECT_THREAD}
         WHERE root_conversation_key = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ?`,
      )
      .get(
        key,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      ) as ThreadRow | undefined;
    if (row === undefined) return null;
    const thread = parseThread(row, this.owner);
    const segment = this.getSegment(thread.activeSegmentId);
    if (segment === null || segment.threadId !== thread.id) {
      throw storeError("model_switch_segment_corrupt");
    }
    return { thread, segment };
  }

  getByHermesSessionId(
    sessionIdValue: string,
  ): ConversationThreadSnapshot | null {
    const sessionId = boundedText(
      sessionIdValue,
      512,
      "invalid_model_switch_segment",
    );
    const row = this.database.sqlite
      .prepare(
        `${SELECT_SEGMENT}
         WHERE segment.hermes_session_id = ? AND thread.tenant_id = ?
           AND thread.owner_id = ? AND thread.device_installation_id = ?`,
      )
      .get(
        sessionId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      ) as SegmentRow | undefined;
    if (row === undefined) return null;
    const segment = parseSegment(row, this.owner);
    const thread = this.getThread(segment.threadId);
    if (thread === null) throw storeError("model_switch_segment_corrupt");
    return { thread, segment };
  }

  listSegments(threadIdValue: string): ConversationSegment[] {
    const threadId = uuid(threadIdValue, "invalid_model_switch_segment");
    if (this.getThread(threadId) === null) return [];
    const rows = this.database.sqlite
      .prepare(
        `${SELECT_SEGMENT}
         WHERE segment.thread_id = ? AND thread.tenant_id = ?
           AND thread.owner_id = ? AND thread.device_installation_id = ?
         ORDER BY segment.ordinal ASC`,
      )
      .all(
        threadId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      ) as SegmentRow[];
    return rows.map((row) => parseSegment(row, this.owner));
  }

  private requiredSnapshot(
    threadId: string,
    segmentId: string,
  ): ConversationThreadSnapshot {
    const thread = this.getThread(threadId);
    const segment = this.getSegment(segmentId);
    if (thread === null || segment === null || segment.threadId !== thread.id) {
      throw storeError("model_switch_segment_corrupt");
    }
    return { thread, segment };
  }

  private frozenRouteForSegment(segmentId: string): FrozenAgentModelRoute {
    const row = this.database.sqlite
      .prepare(
        `SELECT segment.route_json, segment.source_profile_id,
                segment.source_model_id
         FROM conversation_segments AS segment
         INNER JOIN conversation_threads AS thread ON thread.id = segment.thread_id
         WHERE segment.id = ? AND thread.tenant_id = ?
           AND thread.owner_id = ? AND thread.device_installation_id = ?`,
      )
      .get(
        segmentId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      ) as
      | {
          route_json?: unknown;
          source_profile_id?: unknown;
          source_model_id?: unknown;
        }
      | undefined;
    if (row === undefined || typeof row.route_json !== "string") {
      throw storeError("model_switch_segment_corrupt");
    }
    let value: unknown;
    try {
      value = JSON.parse(row.route_json);
    } catch {
      throw storeError("model_switch_segment_corrupt");
    }
    const route = parseFrozenRoute(value, "model_switch_segment_corrupt");
    if (
      row.source_profile_id !== route.sourceProfileId ||
      row.source_model_id !== route.modelLibraryId
    ) {
      throw storeError("model_switch_segment_corrupt");
    }
    return route;
  }

  private assertRuntimePair(input: {
    runtimeBindingId: string;
    conversationBoundaryId: string;
    conversationKey: string;
    hermesSessionId: string | null;
    modelRoute: FrozenAgentModelRoute;
  }): void {
    const row = this.database.sqlite
      .prepare(
        `SELECT binding.conversation_key AS binding_conversation_key,
                binding.hermes_session_id AS binding_session_id,
                binding.binding_json AS binding_json,
                boundary.conversation_key AS boundary_conversation_key,
                boundary.hermes_session_id AS boundary_session_id,
                boundary.runtime_binding_id AS boundary_runtime_binding_id
         FROM runtime_bindings AS binding
         INNER JOIN conversation_boundaries AS boundary
           ON boundary.id = ?
          AND boundary.tenant_id = ?
          AND boundary.actor_user_id = ?
          AND boundary.device_installation_id = ?
         WHERE binding.id = ? AND binding.tenant_id = ?
           AND binding.owner_id = ? AND binding.device_installation_id = ?`,
      )
      .get(
        input.conversationBoundaryId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
        input.runtimeBindingId,
        this.owner.tenantId,
        this.owner.ownerId,
        this.owner.deviceInstallationId,
      ) as RuntimePairRow | undefined;
    if (
      row === undefined ||
      row.binding_conversation_key !== input.conversationKey ||
      row.boundary_conversation_key !== input.conversationKey ||
      row.binding_session_id !== input.hermesSessionId ||
      row.boundary_session_id !== input.hermesSessionId ||
      row.boundary_runtime_binding_id !== input.runtimeBindingId ||
      typeof row.binding_json !== "string"
    ) {
      throw storeError("model_switch_segment_conflict");
    }
    let bindingValue: unknown;
    try {
      bindingValue = JSON.parse(row.binding_json);
    } catch {
      throw storeError("model_switch_segment_conflict");
    }
    if (
      bindingValue === null ||
      typeof bindingValue !== "object" ||
      Array.isArray(bindingValue) ||
      !("modelRoute" in bindingValue) ||
      (bindingValue as { modelRoute?: unknown }).modelRoute === null
    ) {
      throw storeError("model_switch_segment_conflict");
    }
    const bindingRoute = parseFrozenRoute(
      (bindingValue as { modelRoute: unknown }).modelRoute,
      "model_switch_segment_conflict",
    );
    if (
      frozenRouteJson(bindingRoute, "model_switch_segment_conflict") !==
      frozenRouteJson(input.modelRoute, "model_switch_segment_conflict")
    ) {
      throw storeError("model_switch_segment_conflict");
    }
  }

  private transaction<T>(
    operation: () => T,
    fallback: ConversationThreadStoreErrorCode,
  ): T {
    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the bounded store or SQLite failure.
      }
      if (error instanceof ConversationThreadStoreError) throw error;
      throw storeError(fallback);
    }
  }
}
