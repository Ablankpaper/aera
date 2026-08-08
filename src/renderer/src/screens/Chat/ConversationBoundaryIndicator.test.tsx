import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationBoundaryIndicator } from "./ConversationBoundaryIndicator";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => (key === "chat.boundary.agent" ? "智能体：" : key),
  }),
}));

describe("ConversationBoundaryIndicator", () => {
  it("shows the pinned organization name independently from private visibility", () => {
    render(
      <ConversationBoundaryIndicator
        agentName="水鱼"
        boundary={{
          scope: "ORGANIZATION",
          scopeId: "10000000-0000-4000-8000-000000000001",
          scopeDisplayName: "Acme",
          visibility: "PRIVATE",
          origin: "NEW_CONVERSATION",
        }}
      />,
    );

    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("智能体：")).toBeInTheDocument();
    expect(screen.getByText("水鱼")).toBeInTheDocument();
    expect(
      screen.getByText("chat.boundary.visibilityValue.PRIVATE"),
    ).toBeInTheDocument();
  });

  it("uses My for a legacy session that defaults safely to USER", () => {
    render(
      <ConversationBoundaryIndicator
        agentName=""
        boundary={{
          scope: "USER",
          scopeId: "10000000-0000-4000-8000-000000000001",
          scopeDisplayName: null,
          visibility: "PRIVATE",
          origin: "LEGACY_DEFAULT",
        }}
      />,
    );

    expect(screen.getByText("chat.boundary.scope.USER")).toBeInTheDocument();
    expect(screen.getByText("default")).toBeInTheDocument();
  });
});
