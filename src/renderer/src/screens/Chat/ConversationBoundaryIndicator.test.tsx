import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationBoundaryIndicator } from "./ConversationBoundaryIndicator";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      key === "chat.boundary.agent"
        ? "智能体："
        : key === "chat.boundary.unnamedAgent"
          ? "未命名智能体"
          : key,
  }),
}));

describe("ConversationBoundaryIndicator", () => {
  it("shows the pinned organization name independently from private visibility", () => {
    render(
      <ConversationBoundaryIndicator
        profileId="writer"
        agentDisplayName=" 水鱼 "
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

  it("always renders default for the default Profile", () => {
    render(
      <ConversationBoundaryIndicator
        profileId="default"
        agentDisplayName="Renamed Default"
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
    expect(screen.queryByText("Renamed Default")).not.toBeInTheDocument();
  });

  it("uses the localized unnamed fallback instead of a non-default Profile id", () => {
    render(
      <ConversationBoundaryIndicator
        profileId="019ff00d-1234-internal-id"
        agentDisplayName="   "
        boundary={{
          scope: "USER",
          scopeId: "10000000-0000-4000-8000-000000000001",
          scopeDisplayName: null,
          visibility: "PRIVATE",
          origin: "NEW_CONVERSATION",
        }}
      />,
    );

    expect(screen.getByText("未命名智能体")).toBeInTheDocument();
    expect(
      screen.queryByText("019ff00d-1234-internal-id"),
    ).not.toBeInTheDocument();
  });
});
