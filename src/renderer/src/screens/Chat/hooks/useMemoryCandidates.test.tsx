import {
  act,
  renderHook,
  waitFor,
  type RenderHookResult,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgenteraMemoryCandidateBatch } from "../../../../../shared/agentera-memory-candidate";
import type { ChatMessage } from "../types";
import { useMemoryCandidates } from "./useMemoryCandidates";

const batch: AgenteraMemoryCandidateBatch = {
  id: "22222222-2222-4222-8222-222222222222",
  decision: "pending",
  createdAt: "2026-07-26T09:00:00.000Z",
  expiresAt: "2026-08-25T09:00:00.000Z",
  proposals: [
    {
      kind: "agent_identity",
      profileId: "vertical-agent-one",
      proposedDisplayName: "星港",
      summary: "将当前 Agent 命名为“星港”",
      confidence: 1,
    },
  ],
};

interface CandidateApiMock {
  extractCandidates: ReturnType<typeof vi.fn>;
  confirmCandidates: ReturnType<typeof vi.fn>;
  rejectCandidates: ReturnType<typeof vi.fn>;
}

interface CandidateHookProps {
  busy: boolean;
  activeProfile: string;
}

type CandidateHookValue = ReturnType<typeof useMemoryCandidates> & {
  messages: ChatMessage[];
  startNaturalMessage: ReturnType<
    typeof useMemoryCandidates
  >["onNaturalLanguageMessageStarted"];
  replaceHermesSnapshot: (next: ChatMessage[]) => void;
  appendAgentReply: (content: string, turnId?: string, error?: string) => void;
};

function installApi(): CandidateApiMock {
  const api = {
    extractCandidates: vi.fn(async () => ({
      success: true as const,
      value: batch,
    })),
    confirmCandidates: vi.fn(async () => ({
      success: true as const,
      value: {
        batch: { ...batch, decision: "confirmed" as const },
        identity: null,
        globalProfile: null,
      },
    })),
    rejectCandidates: vi.fn(async () => ({
      success: true as const,
      value: { ...batch, decision: "rejected" as const },
    })),
  };
  Object.defineProperty(window, "agenteraGlobalProfile", {
    configurable: true,
    value: api,
  });
  return api;
}

function renderCandidateHook(
  isAgentBusy: boolean,
  profile = "vertical-agent-one",
): RenderHookResult<CandidateHookValue, CandidateHookProps> {
  return renderHook(
    ({ busy, activeProfile }) => {
      const [messages, setMessages] = useState<ChatMessage[]>([]);
      const memoryCandidates = useMemoryCandidates({
        profile: activeProfile,
        isAgentBusy: busy,
        messages,
      });
      return {
        messages: [...messages, ...memoryCandidates.candidateMessages],
        startNaturalMessage: memoryCandidates.onNaturalLanguageMessageStarted,
        replaceHermesSnapshot: (next: ChatMessage[]) => setMessages(next),
        appendAgentReply: (content: string, turnId?: string, error?: string) =>
          setMessages((current) => [
            ...current,
            {
              id: `agent-${current.length}`,
              kind: "assistant" as const,
              role: "agent" as const,
              content,
              ...(turnId ? { turnId } : {}),
              ...(error ? { error } : {}),
            },
          ]),
        ...memoryCandidates,
      };
    },
    { initialProps: { busy: isAgentBusy, activeProfile: profile } },
  );
}

afterEach(() => {
  Reflect.deleteProperty(window, "agenteraGlobalProfile");
});

describe("useMemoryCandidates", () => {
  it("extracts asynchronously and adds one renderer-local card per batch after Hermes finishes", async () => {
    const api = installApi();
    const { result, rerender } = renderCandidateHook(true);

    let returned: unknown;
    act(() => {
      returned = result.current.startNaturalMessage(
        "你的名字是星港。",
        "turn-one",
      );
    });
    expect(returned).toBeUndefined();
    await waitFor(() => expect(api.extractCandidates).toHaveBeenCalledTimes(1));
    expect(result.current.messages).toHaveLength(0);

    act(() => {
      result.current.appendAgentReply("已经记下了，我们继续吧。", "turn-one");
    });
    rerender({ busy: false, activeProfile: "vertical-agent-one" });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages[0]).toMatchObject({
      kind: "assistant",
      role: "agent",
      content: "已经记下了，我们继续吧。",
    });
    expect(result.current.messages[1]).toMatchObject({
      kind: "memory_candidate",
      role: "agent",
      status: "pending",
      batch: { id: batch.id },
    });

    act(() => {
      result.current.startNaturalMessage("你的名字是星港。", "turn-two");
    });
    await waitFor(() => expect(api.extractCandidates).toHaveBeenCalledTimes(2));
    expect(result.current.messages).toHaveLength(2);
    expect(api.extractCandidates).toHaveBeenCalledWith(
      "你的名字是星港。",
      "vertical-agent-one",
    );
  });

  it("discards a queued candidate instead of showing it in another Agent", async () => {
    const api = installApi();
    const { result, rerender } = renderCandidateHook(true);

    act(() => {
      result.current.startNaturalMessage("你的名字是星港。", "turn-one");
    });
    await waitFor(() => expect(api.extractCandidates).toHaveBeenCalledTimes(1));
    expect(result.current.messages).toHaveLength(0);

    rerender({ busy: false, activeProfile: "vertical-agent-two" });

    await act(async () => Promise.resolve());
    expect(result.current.messages).toHaveLength(0);
  });

  it("removes a displayed confirmation card when the active Agent changes", async () => {
    const api = installApi();
    const { result, rerender } = renderCandidateHook(true);

    act(() => {
      result.current.startNaturalMessage("你的名字是星港。", "turn-one");
    });
    await waitFor(() => expect(api.extractCandidates).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.appendAgentReply("回复完成。", "turn-one");
    });
    rerender({ busy: false, activeProfile: "vertical-agent-one" });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    rerender({ busy: false, activeProfile: "vertical-agent-two" });
    await act(async () => Promise.resolve());

    expect(
      result.current.messages.filter(
        (message) => message.kind === "memory_candidate",
      ),
    ).toHaveLength(0);
  });

  it("keeps a renderer-only confirmation card when a later Hermes event replaces its message snapshot", async () => {
    const api = installApi();
    const { result, rerender } = renderCandidateHook(true);

    act(() => {
      result.current.startNaturalMessage("你的名字是星港。", "turn-one");
    });
    await waitFor(() => expect(api.extractCandidates).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.appendAgentReply("已经记下了，我们继续吧。", "turn-one");
    });
    rerender({ busy: false, activeProfile: "vertical-agent-one" });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    act(() => {
      result.current.replaceHermesSnapshot([
        {
          id: "agent-final",
          kind: "assistant",
          role: "agent",
          content: "已经记下了，我们继续吧。",
          turnId: "turn-one",
        },
      ]);
    });

    expect(result.current.messages.map((message) => message.kind)).toEqual([
      "assistant",
      "memory_candidate",
    ]);
  });

  it("does not show a confirmation card when the matching Hermes turn fails", async () => {
    const api = installApi();
    const { result, rerender } = renderCandidateHook(true);

    act(() => {
      result.current.startNaturalMessage("你的名字是星港。", "turn-failed");
    });
    await waitFor(() => expect(api.extractCandidates).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.appendAgentReply(
        "模型请求失败。",
        "turn-failed",
        "provider unavailable",
      );
    });

    rerender({ busy: false, activeProfile: "vertical-agent-one" });
    await act(async () => Promise.resolve());

    expect(
      result.current.messages.filter(
        (message) => message.kind === "memory_candidate",
      ),
    ).toHaveLength(0);
  });

  it("waits for the Hermes busy cycle when extraction wins the loading-render race", async () => {
    const api = installApi();
    const { result, rerender } = renderCandidateHook(false);

    act(() => {
      result.current.startNaturalMessage("你的名字是星港。", "turn-one");
    });
    await waitFor(() => expect(api.extractCandidates).toHaveBeenCalledTimes(1));
    expect(result.current.messages).toHaveLength(0);

    rerender({ busy: true, activeProfile: "vertical-agent-one" });
    act(() => {
      result.current.appendAgentReply("这条回复已经生成完成。", "turn-one");
    });
    expect(result.current.messages).toHaveLength(1);

    rerender({ busy: false, activeProfile: "vertical-agent-one" });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages.map((message) => message.kind)).toEqual([
      "assistant",
      "memory_candidate",
    ]);
  });

  it("does not confirm an identity revision while Hermes is generating", async () => {
    const api = installApi();
    const { result, rerender } = renderCandidateHook(true);
    act(() =>
      result.current.startNaturalMessage("你的名字是星港。", "turn-one"),
    );
    await waitFor(() => expect(api.extractCandidates).toHaveBeenCalledTimes(1));
    expect(result.current.messages).toHaveLength(0);

    act(() => {
      result.current.appendAgentReply("回复完成。", "turn-one");
    });
    rerender({ busy: false, activeProfile: "vertical-agent-one" });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    rerender({ busy: true, activeProfile: "vertical-agent-one" });

    await act(async () => {
      await result.current.confirm(batch.id);
    });
    expect(api.confirmCandidates).not.toHaveBeenCalled();
    expect(result.current.messages[1]).toMatchObject({ status: "pending" });
  });

  it("records confirmed and rejected receipts without putting either into Hermes history", async () => {
    const api = installApi();
    const { result, rerender } = renderCandidateHook(true);
    act(() =>
      result.current.startNaturalMessage("你的名字是星港。", "turn-one"),
    );
    await waitFor(() => expect(api.extractCandidates).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.appendAgentReply("回复完成。", "turn-one");
    });
    rerender({ busy: false, activeProfile: "vertical-agent-one" });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    await act(async () => {
      await result.current.confirm(batch.id);
    });
    expect(api.confirmCandidates).toHaveBeenCalledWith(
      batch.id,
      "vertical-agent-one",
    );
    expect(result.current.messages[1]).toMatchObject({ status: "confirmed" });

    api.extractCandidates.mockResolvedValueOnce({
      success: true,
      value: { ...batch, id: "33333333-3333-4333-8333-333333333333" },
    });
    rerender({ busy: true, activeProfile: "vertical-agent-one" });
    act(() =>
      result.current.startNaturalMessage("请称呼我为领航员。", "turn-two"),
    );
    await waitFor(() => expect(api.extractCandidates).toHaveBeenCalledTimes(2));
    act(() => {
      result.current.appendAgentReply("第二条回复完成。", "turn-two");
    });
    rerender({ busy: false, activeProfile: "vertical-agent-one" });
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    const secondId = "33333333-3333-4333-8333-333333333333";
    await act(async () => {
      await result.current.reject(secondId);
    });
    expect(api.rejectCandidates).toHaveBeenCalledWith(
      secondId,
      "vertical-agent-one",
    );
    expect(result.current.messages[3]).toMatchObject({ status: "rejected" });
  });
});
