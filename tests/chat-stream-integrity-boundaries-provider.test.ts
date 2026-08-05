import { describe, expect, it } from "vitest";

import {
  BOUNDARY_TOOL_CALL_ID,
  classifyStreamIntegrityBoundaryRequest,
  streamIntegrityBoundaryReply,
  streamIntegrityBoundaryToolCall,
} from "./e2e/support/chat-stream-integrity-boundaries-provider";

describe("chat stream integrity supplemental boundary provider", () => {
  it("requires one real terminal tool result before the tool scenario can finish", () => {
    expect(
      classifyStreamIntegrityBoundaryRequest({
        stream: true,
        messages: [
          { role: "user", content: "AERA_STREAM_INTEGRITY_BOUNDARY_TOOL" },
        ],
      }),
    ).toEqual({ kind: "tool", phase: "call" });

    expect(
      classifyStreamIntegrityBoundaryRequest({
        stream: true,
        messages: [
          { role: "user", content: "AERA_STREAM_INTEGRITY_BOUNDARY_TOOL" },
          {
            role: "assistant",
            content: "",
            tool_calls: [streamIntegrityBoundaryToolCall()],
          },
          {
            role: "tool",
            tool_call_id: BOUNDARY_TOOL_CALL_ID,
            content: "AERA_TOOL_BOUNDARY_OK",
          },
        ],
      }),
    ).toEqual({ kind: "tool", phase: "final" });

    expect(streamIntegrityBoundaryToolCall()).toMatchObject({
      id: BOUNDARY_TOOL_CALL_ID,
      type: "function",
      function: {
        name: "terminal",
        arguments: JSON.stringify({
          command: "printf AERA_TOOL_BOUNDARY_OK",
          timeout: 30,
        }),
      },
    });
  });

  it("classifies reconnect and cold-restart continuations without renumbering auxiliary calls", () => {
    expect(
      classifyStreamIntegrityBoundaryRequest({
        stream: true,
        messages: [
          {
            role: "user",
            content: "AERA_STREAM_INTEGRITY_BOUNDARY_RECONNECT",
          },
        ],
      }),
    ).toEqual({ kind: "reconnect" });
    expect(
      classifyStreamIntegrityBoundaryRequest({
        stream: true,
        messages: [
          {
            role: "user",
            content: "AERA_STREAM_INTEGRITY_BOUNDARY_AFTER_RESTART",
          },
        ],
      }),
    ).toEqual({ kind: "after-restart" });
    expect(
      classifyStreamIntegrityBoundaryRequest({
        stream: false,
        messages: [{ role: "user", content: "background title" }],
      }),
    ).toEqual({ kind: "auxiliary" });
    expect(
      classifyStreamIntegrityBoundaryRequest({
        stream: true,
        messages: [{ role: "user", content: "unknown stream" }],
      }),
    ).toEqual({ kind: "invalid" });
  });

  it("builds distinct long Unicode replies for all three supplemental inputs", () => {
    const replies = [
      streamIntegrityBoundaryReply("tool"),
      streamIntegrityBoundaryReply("reconnect"),
      streamIntegrityBoundaryReply("after-restart"),
    ];
    expect(new Set(replies).size).toBe(3);
    for (const reply of replies) {
      expect(Buffer.byteLength(reply, "utf8")).toBeGreaterThan(512);
      expect(reply).toContain("重复短语，重复短语");
      expect(reply).toContain("🙂👨‍👩‍👧‍👦e\u0301");
    }
  });
});
