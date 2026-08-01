import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const translate = (key: string): string => key;

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: translate,
  }),
}));

import Kanban from "./Kanban";

describe("Kanban board creation", () => {
  const kanbanCreateBoard = vi.fn();

  beforeEach(() => {
    kanbanCreateBoard.mockReset();
    kanbanCreateBoard.mockResolvedValue({ success: true });
    window.localStorage.clear();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        kanbanListBoards: vi.fn().mockResolvedValue({
          success: true,
          data: [
            {
              slug: "default",
              name: "Default",
              is_current: true,
              archived: false,
              total: 0,
              counts: {},
            },
          ],
        }),
        kanbanListTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
        kanbanListClaw3dHqTasks: vi
          .fn()
          .mockResolvedValue({ success: false, error: "not configured" }),
        kanbanCreateBoard,
      },
    });
  });

  it("keeps an invalid localized slug in the modal and never reports success", async () => {
    render(<Kanban visible={false} />);

    await screen.findByText("Default");
    fireEvent.click(screen.getByRole("button", { name: "kanban.newBoard" }));
    fireEvent.change(screen.getByPlaceholderText("kanban.slugPlaceholder"), {
      target: { value: "测试看板" },
    });
    fireEvent.click(screen.getByRole("button", { name: "kanban.createBoard" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "kanban.errInvalidBoardSlug",
    );
    expect(kanbanCreateBoard).not.toHaveBeenCalled();
    expect(screen.getByText("kanban.newBoardTitle")).toBeVisible();
  });

  it("normalizes a valid slug and waits for the verified create result", async () => {
    render(<Kanban visible={false} />);

    await screen.findByText("Default");
    fireEvent.click(screen.getByRole("button", { name: "kanban.newBoard" }));
    fireEvent.change(screen.getByPlaceholderText("kanban.slugPlaceholder"), {
      target: { value: "Release-Board" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("kanban.displayNamePlaceholder"),
      { target: { value: "Release Board" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "kanban.createBoard" }));

    await waitFor(() => {
      expect(kanbanCreateBoard).toHaveBeenCalledWith(
        "release-board",
        "Release Board",
        true,
        undefined,
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("kanban.newBoardTitle")).toBeNull();
    });
  });
});
