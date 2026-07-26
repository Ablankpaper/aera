import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageRow } from "./MessageRow";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string): string => key,
  }),
}));

vi.mock("../../components/AgentMarkdown", () => ({
  AgentMarkdown: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

describe("MessageRow official quality feedback", () => {
  const submitFeedback = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    submitFeedback.mockResolvedValue({ accepted: true });
    Object.defineProperty(window, "agenteraOfficialQuality", {
      configurable: true,
      value: {
        getConsent: vi.fn(),
        setPassiveConsent: vi.fn(),
        setExplicitFeedbackConsent: vi.fn(),
        submitFeedback,
        onEligible: vi.fn(() => () => undefined),
      },
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: { copyToClipboard: vi.fn() },
    });
  });

  it("submits only the event ID, fixed rating, and fixed reason codes", async () => {
    render(
      <MessageRow
        msg={{
          id: "agent-1",
          role: "agent",
          content: "private response stays rendered locally",
          turnId: "turn-1",
          officialQualityEligibility: {
            eventId: "019f0000-0000-7000-8000-000000000001",
            result: "success",
            latencyBucket: "1s_5s",
            totalTokenBucket: "1_1k",
            crashCode: null,
          },
        }}
        isLast
        isLoading={false}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "chat.officialQuality.notHelpful" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "chat.officialQuality.incorrect" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "chat.officialQuality.submit" }),
    );

    await waitFor(() =>
      expect(submitFeedback).toHaveBeenCalledWith({
        eventId: "019f0000-0000-7000-8000-000000000001",
        rating: "not_helpful",
        reasonCodes: ["incorrect"],
      }),
    );
    const serialized = JSON.stringify(submitFeedback.mock.calls);
    expect(serialized).not.toContain("private response");
    expect(serialized).not.toContain("turn-1");
  });

  it("shows no controls for a non-eligible or failed turn", () => {
    const { rerender } = render(
      <MessageRow
        msg={{ id: "agent-1", role: "agent", content: "answer" }}
        isLast
        isLoading={false}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "chat.officialQuality.helpful" }),
    ).not.toBeInTheDocument();

    rerender(
      <MessageRow
        msg={{
          id: "agent-1",
          role: "agent",
          content: "answer",
          error: "local error",
          officialQualityEligibility: {
            eventId: "019f0000-0000-7000-8000-000000000001",
            result: "success",
            latencyBucket: "1s_5s",
            totalTokenBucket: "1_1k",
            crashCode: null,
          },
        }}
        isLast
        isLoading={false}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "chat.officialQuality.helpful" }),
    ).not.toBeInTheDocument();
  });
});
