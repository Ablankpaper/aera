import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";
import type { ChatMessage } from "./types";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe("MessageList memory-candidate row", () => {
  it("renders the renderer-local batch as one card", () => {
    const messages: ChatMessage[] = [
      {
        id: "memory-candidate-one",
        kind: "memory_candidate",
        role: "agent",
        status: "pending",
        batch: {
          id: "22222222-2222-4222-8222-222222222222",
          decision: "pending",
          createdAt: "2026-07-26T09:00:00.000Z",
          expiresAt: "2026-08-25T09:00:00.000Z",
          proposals: [
            {
              kind: "agent_identity",
              profileId: "vertical-agent-one",
              proposedDisplayName: "星港",
              summary: "将当前 Agent 命名为“星港”",
              confidence: 1,
            },
          ],
        },
      },
    ];

    render(
      <MessageList
        messages={messages}
        isLoading={false}
        toolProgress={null}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onClarifyResolved={vi.fn()}
        onMemoryCandidateConfirm={vi.fn()}
        onMemoryCandidateReject={vi.fn()}
        onAgentCreationConfirm={vi.fn()}
        onAgentCreationDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText("星港")).toBeInTheDocument();
    expect(screen.getAllByText("chat.memoryCandidate.title")).toHaveLength(1);
  });
});
