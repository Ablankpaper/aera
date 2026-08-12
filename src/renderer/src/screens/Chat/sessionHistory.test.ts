import { describe, expect, it } from "vitest";
import type { AgentConversationModelSwitchMarker } from "../../../../shared/model-configuration";
import {
  buildConversationThreadResume,
  dbItemsToChatMessages,
  mergeConversationThreadMarkers,
} from "./sessionHistory";

const markers: AgentConversationModelSwitchMarker[] = [
  {
    threadId: "thread-1",
    segmentId: "segment-2",
    from: {
      provider: "openai",
      model: "gpt-5.6",
      baseUrl: "https://api.openai.com/v1",
      apiMode: "responses",
    },
    to: {
      provider: "custom:petoi",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.petoi.cn/v1",
      apiMode: "codex_responses",
    },
    historyBoundaryCount: 2,
  },
];

describe("cold Agent conversation history markers", () => {
  it("inserts markers after the counted prompt bubbles rather than reasoning rows", () => {
    const messages = dbItemsToChatMessages([
      { kind: "user", id: 1, content: "one" },
      { kind: "reasoning", id: 2, text: "thinking" },
      { kind: "assistant", id: 3, content: "answer" },
      { kind: "user", id: 4, content: "continue" },
    ]);

    const merged = mergeConversationThreadMarkers(messages, markers);

    expect(merged.map((message) => message.id)).toEqual([
      "db-1",
      "db-r-2",
      "db-3",
      "switch-segment-2",
      "db-4",
    ]);
  });

  it("deduplicates a marker already present in renderer state", () => {
    const once = mergeConversationThreadMarkers(
      dbItemsToChatMessages([
        { kind: "user", id: 1, content: "one" },
        { kind: "assistant", id: 2, content: "answer" },
      ]),
      markers,
    );

    expect(mergeConversationThreadMarkers(once, markers)).toEqual(once);
  });

  it("builds a resumed run with the active session id instead of the requested old segment", () => {
    const resumed = buildConversationThreadResume(
      "s1",
      [
        { kind: "user", id: 1, content: "one" },
        { kind: "assistant", id: 2, content: "answer" },
      ],
      {
        activeSessionId: "s3",
        threadId: "thread-1",
        markers,
      },
    );

    expect(resumed.sessionId).toBe("s3");
    expect(
      resumed.messages.some((message) => message.kind === "model_switch"),
    ).toBe(true);
  });
});
