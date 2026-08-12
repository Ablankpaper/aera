import type {
  AgentConversationModelSwitchMarker,
  AgentConversationThreadResumeProjection,
  PublicModelRouteIdentity,
} from "../../shared/model-configuration";

export type ConversationThreadProjectionSegmentState =
  | "preparing"
  | "active"
  | "superseded"
  | "failed";

export interface ConversationThreadProjectionSegment {
  segmentId: string;
  ordinal: number;
  state: ConversationThreadProjectionSegmentState;
  hermesSessionId: string | null;
  route: PublicModelRouteIdentity;
  historyBoundaryCount: number;
}

export interface ConversationThreadProjectionRecord {
  threadId: string;
  activeSegmentId: string;
  segments: ConversationThreadProjectionSegment[];
}

export type ConversationThreadResumeProjection =
  AgentConversationThreadResumeProjection;

interface SessionSummaryLike {
  id: string;
  startedAt: number;
  endedAt: number | null;
  messageCount: number;
  model: string;
  title: string | null;
  preview: string;
}

export type ProjectedSessionSummary<T extends SessionSummaryLike> = T & {
  threadId?: string;
  segmentCount?: number;
};

interface ValidThreadProjection {
  record: ConversationThreadProjectionRecord;
  segments: ConversationThreadProjectionSegment[];
  activatedSegments: ConversationThreadProjectionSegment[];
  activeSegment: ConversationThreadProjectionSegment | null;
}

function orderedSegments(
  record: ConversationThreadProjectionRecord,
): ConversationThreadProjectionSegment[] {
  return [...record.segments].sort(
    (left, right) =>
      left.ordinal - right.ordinal ||
      left.segmentId.localeCompare(right.segmentId),
  );
}

function validProjection(
  record: ConversationThreadProjectionRecord,
): ValidThreadProjection {
  const segments = orderedSegments(record);
  const activatedSegments = segments.filter(
    (segment) => segment.state === "active" || segment.state === "superseded",
  );
  const activeSegment =
    segments.find(
      (segment) =>
        segment.segmentId === record.activeSegmentId &&
        segment.state === "active" &&
        Boolean(segment.hermesSessionId),
    ) ?? null;
  return { record, segments, activatedSegments, activeSegment };
}

function markersForThread(
  projection: ValidThreadProjection,
): AgentConversationModelSwitchMarker[] {
  const markers: AgentConversationModelSwitchMarker[] = [];
  for (let index = 1; index < projection.activatedSegments.length; index++) {
    const previous = projection.activatedSegments[index - 1];
    const current = projection.activatedSegments[index];
    markers.push({
      threadId: projection.record.threadId,
      segmentId: current.segmentId,
      from: previous.route,
      to: current.route,
      historyBoundaryCount: current.historyBoundaryCount,
    });
  }
  return markers;
}

/**
 * Owner scoping is enforced by the store that produces these records. This
 * pure projection intentionally carries no owner ids, credential references,
 * binding bytes, Profile paths, or prompt content.
 */
export class ConversationThreadSessionProjection {
  private readonly projections: ValidThreadProjection[];
  private readonly projectionBySessionId = new Map<
    string,
    ValidThreadProjection
  >();

  constructor(records: ReadonlyArray<ConversationThreadProjectionRecord>) {
    this.projections = records.map(validProjection);
    const collisions = new Set<string>();
    for (const projection of this.projections) {
      for (const segment of projection.segments) {
        const sessionId = segment.hermesSessionId?.trim();
        if (!sessionId || collisions.has(sessionId)) continue;
        const existing = this.projectionBySessionId.get(sessionId);
        if (
          existing &&
          existing.record.threadId !== projection.record.threadId
        ) {
          this.projectionBySessionId.delete(sessionId);
          collisions.add(sessionId);
          continue;
        }
        this.projectionBySessionId.set(sessionId, projection);
      }
    }
  }

  records(): ConversationThreadProjectionRecord[] {
    return this.projections.map((projection) => projection.record);
  }

  resolveResume(
    sessionIdValue: string,
  ): ConversationThreadResumeProjection | null {
    const sessionId = sessionIdValue.trim();
    if (!sessionId) return null;
    const projection = this.projectionBySessionId.get(sessionId);
    const activeSessionId = projection?.activeSegment?.hermesSessionId ?? null;
    if (!projection || !activeSessionId) return null;
    return {
      activeSessionId,
      threadId: projection.record.threadId,
      markers: markersForThread(projection),
    };
  }

  expandDelete(sessionIdValue: string): string[] {
    const sessionId = sessionIdValue.trim();
    if (!sessionId) return [];
    const projection = this.projectionBySessionId.get(sessionId);
    if (!projection) return [sessionId];
    return Array.from(
      new Set(
        projection.segments.flatMap((segment) =>
          segment.hermesSessionId?.trim()
            ? [segment.hermesSessionId.trim()]
            : [],
        ),
      ),
    );
  }

  expandDeletes(sessionIds: ReadonlyArray<string>): string[] {
    const expanded: string[] = [];
    const seen = new Set<string>();
    for (const sessionId of sessionIds) {
      for (const resolved of this.expandDelete(sessionId)) {
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        expanded.push(resolved);
      }
    }
    return expanded;
  }
}

export function projectSessionSummaries<T extends SessionSummaryLike>(input: {
  sessions: ReadonlyArray<T>;
  threads: ReadonlyArray<ConversationThreadProjectionRecord>;
}): Array<ProjectedSessionSummary<T>> {
  const projection = new ConversationThreadSessionProjection(input.threads);
  const summariesById = new Map(input.sessions.map((item) => [item.id, item]));
  const replacedSessionIds = new Set<string>();
  const projectedThreads: Array<ProjectedSessionSummary<T>> = [];

  for (const record of projection.records()) {
    const thread = validProjection(record);
    const activeSessionId = thread.activeSegment?.hermesSessionId ?? null;
    const activeSummary = activeSessionId
      ? summariesById.get(activeSessionId)
      : undefined;
    if (!activeSummary || !thread.activeSegment) continue;

    const visibleSummaries = thread.activatedSegments.flatMap((segment) => {
      const summary = segment.hermesSessionId
        ? summariesById.get(segment.hermesSessionId)
        : undefined;
      return summary ? [summary] : [];
    });
    const latest =
      [...visibleSummaries].sort(
        (left, right) => right.startedAt - left.startedAt,
      )[0] ?? activeSummary;
    const latestTitle = [...visibleSummaries]
      .sort((left, right) => right.startedAt - left.startedAt)
      .find((summary) => Boolean(summary.title?.trim()))?.title;

    for (const segment of thread.segments) {
      if (segment.hermesSessionId) {
        replacedSessionIds.add(segment.hermesSessionId);
      }
    }
    projectedThreads.push({
      ...activeSummary,
      startedAt: latest.startedAt,
      endedAt: latest.endedAt,
      messageCount: latest.messageCount,
      title: latestTitle ?? activeSummary.title,
      preview: latest.preview,
      model: thread.activeSegment.route.model,
      threadId: record.threadId,
      segmentCount: thread.activatedSegments.length,
    });
  }

  const hiddenCandidateSessionIds = new Set(
    input.threads.flatMap((record) =>
      record.segments.flatMap((segment) =>
        (segment.state === "preparing" || segment.state === "failed") &&
        segment.hermesSessionId
          ? [segment.hermesSessionId]
          : [],
      ),
    ),
  );
  return [
    ...input.sessions.filter(
      (session) =>
        !replacedSessionIds.has(session.id) &&
        !hiddenCandidateSessionIds.has(session.id),
    ),
    ...projectedThreads,
  ].sort((left, right) => right.startedAt - left.startedAt);
}
