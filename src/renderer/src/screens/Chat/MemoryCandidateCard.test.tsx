import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgenteraMemoryCandidateBatch } from "../../../../shared/agentera-memory-candidate";
import { MemoryCandidateCard } from "./MemoryCandidateCard";
import type { MemoryCandidateMessage } from "./types";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const batch: AgenteraMemoryCandidateBatch = {
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
    {
      kind: "global_profile",
      profileId: "vertical-agent-one",
      proposedValue: "领航员",
      entry: {
        id: "communication_style.preferred_address",
        category: "communication_style",
        content: "Address the user as “领航员”.",
      },
      summary: "让所有 Agent 称呼用户为“领航员”",
      confidence: 1,
    },
  ],
};

function message(
  status: MemoryCandidateMessage["status"] = "pending",
): MemoryCandidateMessage {
  return {
    id: `memory-candidate-${batch.id}`,
    kind: "memory_candidate",
    role: "agent",
    batch,
    status,
  };
}

describe("MemoryCandidateCard", () => {
  it("shows one plain-language card for both destinations and confirms once", () => {
    const onConfirm = vi.fn();
    const onReject = vi.fn();
    render(
      <MemoryCandidateCard
        message={message()}
        onConfirm={onConfirm}
        onReject={onReject}
      />,
    );

    expect(screen.getByText("星港")).toBeInTheDocument();
    expect(screen.getByText("领航员")).toBeInTheDocument();
    expect(
      screen.getByText("chat.memoryCandidate.agentName"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("chat.memoryCandidate.userAddress"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "chat.memoryCandidate.confirm" }),
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(batch.id);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("keeps both decisions available once the post-reply card is shown", () => {
    render(
      <MemoryCandidateCard
        message={message()}
        onConfirm={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "chat.memoryCandidate.confirm" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "chat.memoryCandidate.reject" }),
    ).toBeEnabled();
  });

  it("renders nothing after either decision", () => {
    const { rerender } = render(
      <MemoryCandidateCard
        message={message("confirmed")}
        onConfirm={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(document.body.textContent).toBe("");

    rerender(
      <MemoryCandidateCard
        message={message("rejected")}
        onConfirm={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(document.body.textContent).toBe("");
  });
});
