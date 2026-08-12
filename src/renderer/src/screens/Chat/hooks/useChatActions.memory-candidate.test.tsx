import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatActions } from "./useChatActions";

describe("useChatActions memory-candidate ordering", () => {
  it("passes an opaque installed-Agent selection only on the next send", async () => {
    const sendMessage = vi.fn(async () => ({ response: "ok" }));
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: { sendMessage },
    });
    const selection = {
      sourceProfileId: "account",
      modelLibraryId: "petoi-gpt",
      catalogRevision: "a".repeat(64),
    };
    const { result } = renderHook(() =>
      useChatActions({
        runId: "run-agent-switch",
        profile: "agent-one",
        hermesSessionId: null,
        messages: [],
        isLoading: false,
        setIsLoading: vi.fn(),
        setMessages: vi.fn(),
        chatInputRef: { current: null },
        localCommands: { executeLocal: vi.fn(async () => false) },
        slashCatalog: {} as never,
        activeTurnRef: { current: null },
        contextFolder: null,
        agentModelSelection: selection,
      }),
    );

    await result.current.handleSend("continue");

    expect(sendMessage).toHaveBeenCalledWith(
      "continue",
      "agent-one",
      undefined,
      [],
      undefined,
      undefined,
      "run-agent-switch",
      undefined,
      selection,
    );
  });

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

  it("lets a strict product guide claim Agent creation before Hermes can create an orphan Profile", async () => {
    const sendViaDashboard = vi.fn(async () => true);
    const interceptNaturalLanguageMessage = vi.fn(() => true);
    const setMessages = vi.fn();
    const setIsLoading = vi.fn();

    const { result } = renderHook(() =>
      useChatActions({
        runId: "run-agent-create",
        profile: "default",
        hermesSessionId: null,
        messages: [],
        isLoading: false,
        setIsLoading,
        setMessages,
        chatInputRef: { current: null },
        localCommands: { executeLocal: vi.fn(async () => false) },
        slashCatalog: {} as never,
        activeTurnRef: { current: null },
        contextFolder: null,
        sendViaDashboard,
        interceptNaturalLanguageMessage,
      }),
    );

    await act(async () => {
      await result.current.handleSend("帮我创建一个客服智能体");
    });

    expect(interceptNaturalLanguageMessage).toHaveBeenCalledOnce();
    expect(sendViaDashboard).not.toHaveBeenCalled();
    expect(setIsLoading).not.toHaveBeenCalledWith(true);
    expect(setMessages).toHaveBeenCalledOnce();
  });
});
