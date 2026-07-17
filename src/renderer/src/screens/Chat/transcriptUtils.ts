import type { ChatMessage } from "./types";
import {
  displayTextForTranscript,
  shouldCopyToTranscript,
} from "./chatMessages";

export type TranscriptFormat = "text" | "markdown";

/**
 * Serialise a conversation into a clipboard-ready transcript (issue #298).
 *
 * - `text`     → plain `You: …` / `AgentEra: …` blocks.
 * - `markdown` → `**You:**` / `**AgentEra:**` headed blocks.
 *
 * Blocks are separated by a blank line. Exported for unit testing.
 */
export function buildChatTranscript(
  messages: ChatMessage[],
  format: TranscriptFormat,
): string {
  return messages
    .filter(shouldCopyToTranscript)
    .map((m) => {
      const speaker = m.role === "user" ? "You" : "AgentEra";
      const content = displayTextForTranscript(m);
      return format === "markdown"
        ? `**${speaker}:**\n\n${content}`
        : `${speaker}: ${content}`;
    })
    .join("\n\n");
}
