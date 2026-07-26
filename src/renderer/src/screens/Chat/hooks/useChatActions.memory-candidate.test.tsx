import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatActions } from "./useChatActions";

describe("useChatActions memory-candidate ordering", () => {
  it("starts Hermes first and triggers candidate extraction without awaiting it", async () => {
    const order: string[] = [];
    let finishHermes!: (handled: boolean) => void;
    const hermesPending = new Promise<boolean>((resolve) => {
      finishHermes = resolve;
    });
    const sendViaDashboard = vi.fn(() => {
      order.push("hermes");
      return hermesPending;
    });
    const onNaturalLanguageMessageStarted = vi.fn(() => {
      order.push("candidate");
    });
    const setMessages = vi.fn();
    const setIsLoading = vi.fn();
    const activeTurnRef = { current: null };

    const { result } = renderHook(() =>
      useChatActions({
        runId: "run-one",
        profile: "vertical-agent-one",
        hermesSessionId: null,
        messages: [],
        isLoading: false,
        setIsLoading,
        setMessages,
        chatInputRef: { current: null },
        localCommands: { executeLocal: vi.fn(async () => false) },
        slashCatalog: {} as never,
        activeTurnRef,
        contextFolder: null,
        sendViaDashboard,
        onNaturalLanguageMessageStarted,
      }),
    );

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.handleSend("你的名字是星港。");
    });

    await waitFor(() =>
      expect(onNaturalLanguageMessageStarted).toHaveBeenCalledTimes(1),
    );
    expect(order).toEqual(["hermes", "candidate"]);
    expect(setIsLoading).toHaveBeenCalledWith(true);

    finishHermes(true);
    await act(async () => sendPromise);
  });
});
