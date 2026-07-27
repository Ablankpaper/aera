import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryProfile } from "./MemoryProfile";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string): string => key,
  }),
}));

describe("MemoryProfile USER.md repair", () => {
  let previewUserMemoryRepair: ReturnType<typeof vi.fn>;
  let applyUserMemoryRepair: ReturnType<typeof vi.fn>;
  let undoUserMemoryRepair: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    previewUserMemoryRepair = vi.fn().mockResolvedValue({
      success: true,
      preview: {
        profileId: "agent-one",
        exists: true,
        content: "Keep user preference. Remove misplaced Agent identity.",
        charCount: 55,
        currentSha256: "a".repeat(64),
      },
    });
    applyUserMemoryRepair = vi.fn().mockResolvedValue({
      success: true,
      operationId: "repair-operation",
      profileId: "agent-one",
    });
    undoUserMemoryRepair = vi.fn().mockResolvedValue({
      success: true,
      profileId: "agent-one",
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        writeUserProfile: vi.fn().mockResolvedValue({ success: true }),
        previewUserMemoryRepair,
        applyUserMemoryRepair,
        undoUserMemoryRepair,
      },
    });
  });

  it("applies only the exact user-reviewed replacement and offers undo", async () => {
    const onRefresh = vi.fn();
    render(
      <MemoryProfile
        content="Keep user preference. Remove misplaced Agent identity."
        charLimit={1375}
        profile="agent-one"
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "memory.reviewRepair" }),
    );
    await waitFor(() =>
      expect(previewUserMemoryRepair).toHaveBeenCalledWith("agent-one"),
    );

    const textareas = screen.getAllByRole("textbox");
    const replacement = textareas[textareas.length - 1];
    fireEvent.change(replacement, {
      target: { value: "Keep user preference." },
    });
    const applyButton = screen.getByRole("button", {
      name: "memory.applyRepair",
    });
    expect(applyButton).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(applyButton).toBeEnabled());
    fireEvent.click(applyButton);

    await waitFor(() =>
      expect(applyUserMemoryRepair).toHaveBeenCalledWith(
        "agent-one",
        "a".repeat(64),
        "Keep user preference.",
        true,
      ),
    );
    expect(screen.getByText("memory.repairApplied")).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "memory.undoRepair" }));
    await waitFor(() =>
      expect(undoUserMemoryRepair).toHaveBeenCalledWith(
        "agent-one",
        "repair-operation",
      ),
    );
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });
});
