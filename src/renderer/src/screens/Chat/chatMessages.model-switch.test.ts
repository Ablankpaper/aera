import { describe, expect, it } from "vitest";
import { insertModelSwitchMarker } from "./chatMessages";
import type { ChatMessage } from "./types";

const event = {
  state: "active" as const,
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
  code: null,
};

describe("model switch transcript markers", () => {
  it("inserts one local marker at the visible history boundary and deduplicates it", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "one" },
      { id: "a1", role: "agent", content: "answer" },
      { id: "u2", role: "user", content: "continue" },
    ];

    const inserted = insertModelSwitchMarker(messages, event);
    expect(inserted.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "switch-segment-2",
      "u2",
    ]);
    expect(insertModelSwitchMarker(inserted, event)).toBe(inserted);
    expect(
      inserted.find((message) => message.kind === "model_switch"),
    ).toMatchObject({
      localOnly: true,
      segmentId: "segment-2",
    });
  });
});
