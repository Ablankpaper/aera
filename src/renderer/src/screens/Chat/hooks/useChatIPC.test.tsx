import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { useChatIPC } from "./useChatIPC";
import type { ActiveTurn, ChatMessage, UsageState } from "../types";
import type { OfficialQualityFeedbackEligibility } from "../../../../../shared/agentera-official-quality";

type Callback<T extends unknown[]> = (...args: T) => void;

interface ChatIpcCallbacks {
  sessionStarted?: Callback<[string, string]>;
  chunk?: Callback<[string, string]>;
  reasoning?: Callback<[string, string]>;
  done?: Callback<[string, string]>;
  error?: Callback<[string, string]>;
  toolProgress?: Callback<[string, string]>;
  toolEvent?: Callback<[string, unknown]>;
  usage?: Callback<[string, UsageState]>;
  quality?: Callback<[string, OfficialQualityFeedbackEligibility]>;
  agentSegment?: Callback<[string, unknown]>;
}

function installHermesApi(callbacks: ChatIpcCallbacks): {
  getSessionMessages: ReturnType<typeof vi.fn>;
} {
  const getSessionMessages = vi.fn(async (sessionId: string) => {
    if (sessionId === "old-session") {
      return [
        { kind: "user", id: 1, content: "old prompt" },
        { kind: "assistant", id: 2, content: "old answer" },
      ];
    }
    return [];
  });

  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: {
      getSessionMessages,
      onChatSessionStarted: (cb: Callback<[string, string]>) => {
        callbacks.sessionStarted = cb;
        return vi.fn();
      },
      onChatChunk: (cb: Callback<[string, string]>) => {
        callbacks.chunk = cb;
        return vi.fn();
      },
      onChatReasoningChunk: (cb: Callback<[string, string]>) => {
        callbacks.reasoning = cb;
        return vi.fn();
      },
      onChatDone: (cb: Callback<[string, string]>) => {
        callbacks.done = cb;
        return vi.fn();
      },
      onChatError: (cb: Callback<[string, string]>) => {
        callbacks.error = cb;
        return vi.fn();
      },
      onChatAgentSegment: (cb: Callback<[string, unknown]>) => {
        callbacks.agentSegment = cb;
        return vi.fn();
      },
      onChatToolProgress: (cb: Callback<[string, string]>) => {
        callbacks.toolProgress = cb;
        return vi.fn();
      },
      onChatToolEvent: (cb: Callback<[string, unknown]>) => {
        callbacks.toolEvent = cb;
        return vi.fn();
      },
      onClarifyRequest: vi.fn(() => vi.fn()),
      onChatUsage: (cb: Callback<[string, UsageState]>) => {
        callbacks.usage = cb;
        return vi.fn();
      },
    },
  });
  Object.defineProperty(window, "agenteraOfficialQuality", {
    configurable: true,
    value: {
      onEligible: (
        cb: Callback<[string, OfficialQualityFeedbackEligibility]>,
      ) => {
        callbacks.quality = cb;
        return vi.fn();
      },
    },
  });

  return { getSessionMessages };
}

function QualityHarness(): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "user-live",
      role: "user",
      content: "private prompt",
      turnId: "turn-live",
    },
    {
      id: "agent-live",
      role: "agent",
      content: "private answer",
      turnId: "turn-live",
      pending: true,
    },
  ]);
  const [, setHermesSessionId] = useState<string | null>("new-session");
  const [, setToolProgress] = useState<string | null>(null);
  const [, setIsLoading] = useState(true);
  const [, setUsage] = useState<UsageState | null>(null);
  const activeTurnRef = useRef<ActiveTurn | null>({
    startIndex: 0,
    status: "running",
    turnId: "turn-live",
    userId: "user-live",
  });

  useChatIPC({
    runId: "run-1",
    sessionScopeId: "new-session",
    setMessages,
    setHermesSessionId,
    setToolProgress,
    setIsLoading,
    setUsage,
    activeTurnRef,
  });

  return <output data-testid="quality">{JSON.stringify(messages)}</output>;
}

function SegmentHarness({
  onEvent,
}: {
  onEvent: (event: unknown) => void;
}): React.JSX.Element {
  const [, setMessages] = useState<ChatMessage[]>([]);
  const [, setHermesSessionId] = useState<string | null>(null);
  const [, setToolProgress] = useState<string | null>(null);
  const [, setIsLoading] = useState(false);
  const [, setUsage] = useState<UsageState | null>(null);
  const activeTurnRef = useRef<ActiveTurn | null>({
    startIndex: 0,
    status: "running",
    turnId: "turn-1",
    userId: "u-1",
  });
  useChatIPC({
    runId: "run-1",
    sessionScopeId: null,
    setMessages,
    setHermesSessionId,
    setToolProgress,
    setIsLoading,
    setUsage,
    activeTurnRef,
    onAgentSegment: (_runId, event) => onEvent(event),
  });
  return <output data-testid="segment" />;
}

function Harness({
  sessionScopeId,
}: {
  sessionScopeId: string | null;
}): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [, setHermesSessionId] = useState<string | null>(sessionScopeId);
  const [, setToolProgress] = useState<string | null>(null);
  const [, setIsLoading] = useState(false);
  const [, setUsage] = useState<UsageState | null>(null);
  const activeTurnRef = useRef<ActiveTurn | null>(null);

  useChatIPC({
    runId: "run-1",
    sessionScopeId,
    setMessages,
    setHermesSessionId,
    setToolProgress,
    setIsLoading,
    setUsage,
    activeTurnRef,
  });

  return (
    <output data-testid="ids">
      {JSON.stringify(messages.map((message) => message.id))}
    </output>
  );
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "hermesAPI");
  Reflect.deleteProperty(window, "agenteraOfficialQuality");
});

describe("useChatIPC session scoping", () => {
  it("ignores late DB refreshes from an old session after the visible chat is cleared", async () => {
    const callbacks: ChatIpcCallbacks = {};
    const api = installHermesApi(callbacks);
    const view = render(<Harness sessionScopeId="old-session" />);

    view.rerender(<Harness sessionScopeId={null} />);

    await act(async () => {
      callbacks.done?.("run-1", "old-session");
    });

    expect(api.getSessionMessages).not.toHaveBeenCalled();
    expect(screen.getByTestId("ids")).toHaveTextContent("[]");
  });

  it("accepts DB refreshes for the visible session", async () => {
    const callbacks: ChatIpcCallbacks = {};
    const api = installHermesApi(callbacks);
    render(<Harness sessionScopeId="old-session" />);

    await act(async () => {
      callbacks.done?.("run-1", "old-session");
    });

    expect(api.getSessionMessages).toHaveBeenCalledWith("old-session");
    expect(screen.getByTestId("ids")).toHaveTextContent(
      JSON.stringify(["db-1", "db-2"]),
    );
  });
});

describe("useChatIPC official quality eligibility", () => {
  it("attaches only the trusted main-process event after the matching turn completes", async () => {
    const callbacks: ChatIpcCallbacks = {};
    installHermesApi(callbacks);
    render(<QualityHarness />);
    const eligibility = {
      eventId: "019f0000-0000-7000-8000-000000000001",
      result: "success" as const,
      latencyBucket: "1s_5s" as const,
      totalTokenBucket: "1_1k" as const,
      crashCode: null,
    };

    await act(async () => {
      callbacks.quality?.("other-run", eligibility);
      callbacks.quality?.("run-1", eligibility);
      callbacks.done?.("run-1", "new-session");
    });

    const rendered = screen.getByTestId("quality").textContent ?? "";
    expect(rendered).toContain(eligibility.eventId);
    expect(rendered).not.toContain("runtimeBindingId");
  });
});

describe("useChatIPC Agent segment events", () => {
  it("forwards only matching-run segment lifecycle events", async () => {
    const callbacks: ChatIpcCallbacks = {};
    installHermesApi(callbacks);
    const onEvent = vi.fn();
    render(<SegmentHarness onEvent={onEvent} />);

    await act(async () => {
      callbacks.agentSegment?.("other-run", { state: "active" });
      callbacks.agentSegment?.("run-1", { state: "preparing" });
    });

    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({ state: "preparing" });
  });
});
