import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DesktopControlStatusCard from "./DesktopControlStatusCard";

vi.mock("../useI18n", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    setLocale: vi.fn(),
    t: (key: string): string => key,
  }),
}));

describe("DesktopControlStatusCard", () => {
  it("uses the existing Settings card and shows only sanitized connection state", () => {
    render(
      <DesktopControlStatusCard
        state={{
          status: "online",
          lastHeartbeatAt: "2026-08-11T00:00:00.000Z",
          lastErrorCode: null,
          lastHealth: {
            state: "succeeded",
            code: "HEALTHY",
            completedAt: "2026-08-11T00:00:01.000Z",
          },
        }}
      />,
    );

    const title = screen.getByText("auth.account.desktopControl.title");
    expect(title.closest("section")).toHaveClass("settings-card");
    expect(
      screen.getByText("auth.account.desktopControl.status.online"),
    ).toBeInTheDocument();
    expect(screen.getByText("HEALTHY")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /user id|device id|token|path|log/i,
    );
  });
});
