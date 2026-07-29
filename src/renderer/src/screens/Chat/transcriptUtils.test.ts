import { describe, it, expect } from "vitest";
import { buildChatTranscript } from "./transcriptUtils";
import type { ChatMessage } from "./types";

function msg(role: "user" | "agent", content: string): ChatMessage {
  return { id: `${role}-${content}`, role, content };
}

describe("buildChatTranscript (issue #298)", () => {
  it("returns an empty string for no messages", () => {
    expect(buildChatTranscript([], "text")).toBe("");
    expect(buildChatTranscript([], "markdown")).toBe("");
  });

  it("formats plain text with You / Aera speakers", () => {
    const out = buildChatTranscript(
      [msg("user", "hi"), msg("agent", "hello there")],
      "text",
    );
    expect(out).toBe("You: hi\n\nAera: hello there");
  });

  it("formats markdown with bold speaker headers", () => {
    const out = buildChatTranscript(
      [msg("user", "hi"), msg("agent", "hello there")],
      "markdown",
    );
    expect(out).toBe("**You:**\n\nhi\n\n**Aera:**\n\nhello there");
  });

  it("trims surrounding whitespace from message content", () => {
    expect(buildChatTranscript([msg("user", "  spaced  ")], "text")).toBe(
      "You: spaced",
    );
  });

  it("maps the agent role to Aera and user to You", () => {
    expect(buildChatTranscript([msg("agent", "x")], "text")).toBe(
      "Aera: x",
    );
    expect(buildChatTranscript([msg("user", "x")], "text")).toBe("You: x");
  });
});
