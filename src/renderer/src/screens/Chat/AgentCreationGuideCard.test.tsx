import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentCreationGuideCard } from "./AgentCreationGuideCard";
import type { AgentCreationGuideMessage } from "./types";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.name ? `${key}:${String(values.name)}` : key,
  }),
}));

const pending: AgentCreationGuideMessage = {
  id: "agent-creation-guide-turn-one",
  kind: "agent_creation_guide",
  role: "agent",
  turnId: "turn-one",
  suggestedName: "林二",
  suggestedPurpose: "整理客户资料",
  target: { scope: "USER" },
  status: "pending",
};

describe("AgentCreationGuideCard", () => {
  it("asks for missing details and submits the editable defaults", () => {
    const onConfirm = vi.fn();
    render(
      <AgentCreationGuideCard
        message={pending}
        onConfirm={onConfirm}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      screen.getByText("chat.agentCreation.target.USER"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("chat.agentCreation.name"), {
      target: { value: "林二助手" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "chat.agentCreation.createDraft",
      }),
    );

    expect(onConfirm).toHaveBeenCalledWith(pending.id, {
      name: "林二助手",
      purpose: "整理客户资料",
    });
  });

  it("links a created product draft to My Agents", () => {
    const onOpenMyAgents = vi.fn();
    render(
      <AgentCreationGuideCard
        message={{
          ...pending,
          status: "created",
          draftId: "draft-one",
          createdName: "林二",
        }}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
        onOpenMyAgents={onOpenMyAgents}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "chat.agentCreation.openMyAgents",
      }),
    );
    expect(onOpenMyAgents).toHaveBeenCalledOnce();
  });
});
