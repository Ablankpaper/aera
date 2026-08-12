import { describe, expect, it, vi } from "vitest";
import { deleteConversationSessions } from "./conversation-session-deletion";

describe("conversation thread session deletion", () => {
  it("deletes every expanded Hermes segment before thread and boundary metadata", async () => {
    const events: string[] = [];
    const projection = {
      expandDeletes: vi.fn(() => ["s1", "s2", "s3"]),
    };

    const result = await deleteConversationSessions({
      sessionIds: ["s2"],
      projection,
      metadataDeletionAvailable: true,
      deleteHermesSessions: (ids) => {
        events.push(`hermes:${ids.join(",")}`);
        return { requested: ids.length, deleted: ids.length };
      },
      deleteThreadMetadata: (ids) => {
        events.push(`thread:${ids.join(",")}`);
      },
      deleteBoundaryMetadata: (ids) => {
        events.push(`boundary:${ids.join(",")}`);
      },
    });

    expect(projection.expandDeletes).toHaveBeenCalledWith(["s2"]);
    expect(events).toEqual([
      "hermes:s1,s2,s3",
      "thread:s1,s2,s3",
      "boundary:s1,s2,s3",
    ]);
    expect(result).toEqual({ requested: 3, deleted: 3 });
  });

  it("keeps all control metadata when Hermes deletion fails", async () => {
    const deleteThreadMetadata = vi.fn();
    const deleteBoundaryMetadata = vi.fn();

    await expect(
      deleteConversationSessions({
        sessionIds: ["s1"],
        projection: null,
        metadataDeletionAvailable: true,
        deleteHermesSessions: () => {
          throw new Error("Hermes unavailable");
        },
        deleteThreadMetadata,
        deleteBoundaryMetadata,
      }),
    ).rejects.toThrow("Hermes unavailable");
    expect(deleteThreadMetadata).not.toHaveBeenCalled();
    expect(deleteBoundaryMetadata).not.toHaveBeenCalled();
  });

  it("does not delete foreign-key boundary metadata after thread cleanup fails", async () => {
    const deleteBoundaryMetadata = vi.fn();
    const onMetadataError = vi.fn();

    await expect(
      deleteConversationSessions({
        sessionIds: ["s1"],
        projection: null,
        metadataDeletionAvailable: true,
        deleteHermesSessions: () => undefined,
        deleteThreadMetadata: () => {
          throw new Error("thread conflict");
        },
        deleteBoundaryMetadata,
        onMetadataError,
      }),
    ).resolves.toBeUndefined();
    expect(deleteBoundaryMetadata).not.toHaveBeenCalled();
    expect(onMetadataError).toHaveBeenCalledWith("thread", expect.any(Error));
  });

  it("keeps control metadata when the local Hermes database is unavailable", async () => {
    const deleteThreadMetadata = vi.fn();
    const deleteBoundaryMetadata = vi.fn();

    await deleteConversationSessions({
      sessionIds: ["s1"],
      projection: null,
      metadataDeletionAvailable: false,
      deleteHermesSessions: () => undefined,
      deleteThreadMetadata,
      deleteBoundaryMetadata,
    });

    expect(deleteThreadMetadata).not.toHaveBeenCalled();
    expect(deleteBoundaryMetadata).not.toHaveBeenCalled();
  });
});
