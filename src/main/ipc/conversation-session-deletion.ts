export interface ConversationSessionDeletionProjection {
  expandDeletes(sessionIds: ReadonlyArray<string>): string[];
}

export interface DeleteConversationSessionsInput<Result> {
  sessionIds: ReadonlyArray<string>;
  projection: ConversationSessionDeletionProjection | null;
  metadataDeletionAvailable: boolean;
  deleteHermesSessions: (sessionIds: string[]) => Result | Promise<Result>;
  deleteThreadMetadata: (sessionIds: string[]) => unknown;
  deleteBoundaryMetadata: (sessionIds: string[]) => unknown;
  onMetadataError?: (kind: "thread" | "boundary", error: unknown) => void;
}

export async function deleteConversationSessions<Result>(
  input: DeleteConversationSessionsInput<Result>,
): Promise<Result> {
  const requestedIds = [...input.sessionIds];
  const resolvedIds = input.projection
    ? input.projection.expandDeletes(requestedIds)
    : requestedIds;
  const result = await input.deleteHermesSessions([...resolvedIds]);
  if (!input.metadataDeletionAvailable) return result;

  try {
    input.deleteThreadMetadata([...resolvedIds]);
  } catch (error) {
    input.onMetadataError?.("thread", error);
    return result;
  }

  try {
    input.deleteBoundaryMetadata([...resolvedIds]);
  } catch (error) {
    input.onMetadataError?.("boundary", error);
  }
  return result;
}
