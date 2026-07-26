import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalBehaviorProfile } from "./GlobalBehaviorProfile";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string): string => key,
  }),
}));

describe("GlobalBehaviorProfile", () => {
  let setEntry: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const emptyProfile = {
      schemaVersion: 1 as const,
      profileVersion: 0,
      updatedAt: null,
      entries: [],
    };
    setEntry = vi.fn().mockResolvedValue({
      success: true,
      value: {
        ...emptyProfile,
        profileVersion: 1,
        updatedAt: "2026-07-26T08:00:00.000Z",
        entries: [
          {
            id: "communication_style.response_order",
            category: "communication_style",
            content: "Lead with the conclusion.",
            source: "user_explicit",
            confidence: 1,
            createdAt: "2026-07-26T08:00:00.000Z",
            updatedAt: "2026-07-26T08:00:00.000Z",
          },
        ],
      },
    });
    Object.defineProperty(window, "agenteraGlobalProfile", {
      configurable: true,
      value: {
        get: vi.fn().mockResolvedValue({ success: true, value: emptyProfile }),
        setEntry,
        removeEntry: vi.fn(),
        listHistory: vi.fn().mockResolvedValue({ success: true, value: [] }),
        rollback: vi.fn(),
        onChanged: vi.fn(() => vi.fn()),
      },
    });
  });

  it("persists only a category-keyed preference after an explicit click", async () => {
    render(<GlobalBehaviorProfile />);

    expect(
      await screen.findByText("memory.globalProfileHint"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("memory.globalProfileKey"), {
      target: { value: "response_order" },
    });
    fireEvent.change(screen.getByLabelText("memory.globalProfileContent"), {
      target: { value: "Lead with the conclusion." },
    });
    expect(setEntry).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "memory.globalProfileAdd" }),
    );

    await waitFor(() =>
      expect(setEntry).toHaveBeenCalledWith({
        id: "communication_style.response_order",
        category: "communication_style",
        content: "Lead with the conclusion.",
      }),
    );
  });
});
