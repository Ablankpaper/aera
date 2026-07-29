import { act, render, waitFor } from "@testing-library/react";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { DashboardRpcEvent } from "../dashboardGatewayClient";
import {
  attachOfficialQualityEligibility,
  useDashboardChatTransport,
} from "./useDashboardChatTransport";
import type { ActiveTurn, ChatMessage, UsageState } from "../types";

type SetUsageMock = Mock<(value: SetStateAction<UsageState | null>) => void>;

const dashboardMock = vi.hoisted(() => ({
  close: vi.fn(),
  connect: vi.fn(async () => undefined),
  instances: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    connected: boolean;
    request: ReturnType<typeof vi.fn>;
  }>,
  onEvent: null as ((event: DashboardRpcEvent) => void) | null,
  request: vi.fn(),
}));

vi.mock("../dashboardGatewayClient", () => ({
  DashboardGatewayClient: class MockDashboardGatewayClient {
    close = dashboardMock.close;
    connect = dashboardMock.connect;
    connected = true;
    request = dashboardMock.request;

    constructor(
      options: { onEvent?: (event: DashboardRpcEvent) => void } = {},
    ) {
      dashboardMock.onEvent = options.onEvent ?? null;
      dashboardMock.instances.push(this);
    }
  },
}));

interface HarnessApi {
  activeTurnRef?: MutableRefObject<ActiveTurn | null>;
  messages?: ChatMessage[];
  send?: (text: string) => Promise<boolean>;
  setConnectionMode?: Dispatch<SetStateAction<"local" | "remote" | "ssh">>;
  setMessages?: Dispatch<SetStateAction<ChatMessage[]>>;
  setModel?: Dispatch<SetStateAction<string>>;
  setProvider?: Dispatch<SetStateAction<string>>;
  setRuntimeConnectionRevision?: Dispatch<SetStateAction<number>>;
}

const activeBadTurn: ActiveTurn = {
  startIndex: 0,
  status: "running",
  turnId: "turn-bad",
  userId: "u-bad",
};

const activeRecoveryTurn: ActiveTurn = {
  startIndex: 2,
  status: "running",
  turnId: "turn-recovery",
  userId: "u-recovery",
};

function Harness({
  api,
  fallbackOnUnavailable = false,
  hermesSessionId = null,
  initialConnectionMode = "local",
  initialModel = "bad-model",
  initialProvider = "bad-provider",
  modelBaseUrl,
  onDashboardUnavailable,
  setUsage = vi.fn() as SetUsageMock,
}: {
  api: HarnessApi;
  fallbackOnUnavailable?: boolean;
  hermesSessionId?: string | null;
  initialConnectionMode?: "local" | "remote" | "ssh";
  initialModel?: string;
  initialProvider?: string;
  modelBaseUrl?: string;
  onDashboardUnavailable?: (reason: string) => void;
  setUsage?: SetUsageMock;
}): null {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "u-bad",
      role: "user",
      content: "bad provider turn",
      turnId: "turn-bad",
    },
  ]);
  const [model, setModel] = useState(initialModel);
  const [provider, setProvider] = useState(initialProvider);
  const [connectionMode, setConnectionMode] = useState<
    "local" | "remote" | "ssh"
  >(initialConnectionMode);
  const [runtimeConnectionRevision, setRuntimeConnectionRevision] = useState(0);
  const activeTurnRef = useRef<ActiveTurn | null>({ ...activeBadTurn });
  const transport = useDashboardChatTransport({
    activeTurnRef,
    contextFolder: null,
    connectionMode,
    runtimeConnectionRevision,
    enabled: true,
    fallbackOnUnavailable,
    hermesSessionId,
    messages,
    model,
    modelBaseUrl,
    profile: undefined,
    provider,
    setHermesSessionId: vi.fn(),
    setIsLoading: vi.fn(),
    setMessages,
    setToolProgress: vi.fn(),
    setUsage,
    onDashboardUnavailable,
  });

  useEffect(() => {
    // Bridge the hook's live values out to the test via the shared `api`
    // object. Object.assign mutates it in place (same reference the test
    // holds) without per-prop assignment, which the immutability rule rejects.
    Object.assign(api, {
      activeTurnRef,
      messages,
      send: transport.sendMessage,
      setConnectionMode,
      setMessages,
      setModel,
      setProvider,
      setRuntimeConnectionRevision,
    });
  }, [
    activeTurnRef,
    api,
    messages,
    setConnectionMode,
    setMessages,
    setRuntimeConnectionRevision,
    transport.sendMessage,
  ]);

  return null;
}

describe("useDashboardChatTransport recovery", () => {
  beforeEach(() => {
    dashboardMock.close.mockClear();
    dashboardMock.connect.mockClear();
    dashboardMock.instances.length = 0;
    dashboardMock.onEvent = null;
    dashboardMock.request.mockReset();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        freshDashboardWsUrl: vi.fn(async () => "ws://fresh-dashboard"),
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });
  });

  it("requests a fresh WebSocket URL immediately before connecting", async () => {
    dashboardMock.request.mockImplementation(async (method) => {
      if (method === "session.create") {
        return { session_id: "live", stored_session_id: "stored" };
      }
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} initialConnectionMode="remote" />);

    await act(async () => {
      await api.send?.("hello");
    });

    expect(window.hermesAPI.freshDashboardWsUrl).toHaveBeenCalledTimes(1);
    expect(dashboardMock.connect).toHaveBeenCalledWith("ws://fresh-dashboard");
  });

  it("submits the first prompt without loading the remote model inventory", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return { session_id: "live", stored_session_id: "stored" };
      }
      if (method === "model.options") {
        throw new Error(
          "cold model inventory must not block first prompt submission",
        );
      }
      return {};
    });
    const api: HarnessApi = {};
    render(
      <Harness
        api={api}
        initialModel="gpt-5.6-sol"
        initialProvider="custom"
        modelBaseUrl="https://custom.example/v1"
      />,
    );

    let handled: boolean | undefined;
    await act(async () => {
      handled = await api.send?.("hello from a clean install");
    });

    expect(handled).toBe(true);
    expect(requests).toContainEqual({
      method: "session.create",
      params: {
        cols: 96,
        model: "gpt-5.6-sol",
        provider: "custom",
        base_url: "https://custom.example/v1",
      },
    });
    expect(
      requests.filter((request) => request.method === "model.options"),
    ).toHaveLength(0);
    expect(requests).toContainEqual({
      method: "prompt.submit",
      params: {
        session_id: "live",
        text: "hello from a clean install",
      },
    });
  });

  it("reconnects once when model setup times out before prompt submission", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    let modelOptionsCalls = 0;
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.resume") {
        return {
          session_id: modelOptionsCalls === 0 ? "live-first" : "live-recovered",
          resumed: "stored-chat",
        };
      }
      if (method === "model.options") {
        modelOptionsCalls += 1;
        if (modelOptionsCalls === 1) {
          throw new Error(
            "AgentEra Runtime dashboard request timed out: model.options",
          );
        }
        return {
          model: "bad-model",
          provider: "bad-provider",
          providers: [],
        };
      }
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} hermesSessionId="stored-chat" />);

    let handled: boolean | undefined;
    await act(async () => {
      handled = await api.send?.("hello after a stalled picker");
    });

    expect(handled).toBe(true);
    expect(window.hermesAPI.startDashboard).toHaveBeenCalledTimes(2);
    expect(dashboardMock.connect).toHaveBeenCalledTimes(2);
    expect(dashboardMock.close).toHaveBeenCalledTimes(1);
    expect(
      requests.filter((request) => request.method === "model.options"),
    ).toHaveLength(3);
    expect(
      requests.filter((request) => request.method === "session.resume"),
    ).toHaveLength(2);
    expect(requests).toContainEqual({
      method: "session.resume",
      params: { session_id: "stored-chat", cols: 96 },
    });
    expect(requests).toContainEqual({
      method: "prompt.submit",
      params: {
        session_id: "live-recovered",
        text: "hello after a stalled picker",
      },
    });
  });

  it("reconnects once when the initial session.create request times out", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    let createCalls = 0;
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        createCalls += 1;
        if (createCalls === 1) {
          throw new Error(
            "AgentEra Runtime dashboard request timed out: session.create",
          );
        }
        return {
          session_id: "live-recovered",
          stored_session_id: "stored-new",
        };
      }
      if (method === "model.options") {
        return {
          model: "bad-model",
          provider: "bad-provider",
          providers: [],
        };
      }
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);

    let handled: boolean | undefined;
    await act(async () => {
      handled = await api.send?.("hello after a stalled create");
    });

    expect(handled).toBe(true);
    expect(window.hermesAPI.startDashboard).toHaveBeenCalledTimes(2);
    expect(dashboardMock.connect).toHaveBeenCalledTimes(2);
    expect(dashboardMock.close).toHaveBeenCalledTimes(1);
    expect(
      requests.filter((request) => request.method === "session.create"),
    ).toHaveLength(2);
    expect(requests).toContainEqual({
      method: "prompt.submit",
      params: {
        session_id: "live-recovered",
        text: "hello after a stalled create",
      },
    });
  });

  it("surfaces OAuth login requirements without legacy fallback", async () => {
    // @lat: [[remote-dashboard-oauth#Test specifications#OAuth no-fallback]]
    const onUnavailable = vi.fn();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          running: false,
          needsOAuthLogin: true,
          error: "Sign in with your browser.",
          connection: { authMode: "oauth", wsUrl: "" },
        })),
      },
    });
    const api: HarnessApi = {};
    render(
      <Harness
        api={api}
        initialConnectionMode="remote"
        fallbackOnUnavailable
        onDashboardUnavailable={onUnavailable}
      />,
    );

    let handled: boolean | undefined;
    await act(async () => {
      handled = await api.send?.("hello");
    });

    expect(handled).toBe(true);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps a failed provider turn in the same runtime conversation", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    let liveModel = "bad-model";
    let liveProvider = "bad-provider";
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return { session_id: "live-bad", stored_session_id: "stored-chat" };
      }
      if (method === "session.resume") {
        return { session_id: "live-recovery", resumed: "stored-chat" };
      }
      if (method === "slash.exec") {
        const command =
          params && typeof params === "object" && "command" in params
            ? String(params.command)
            : "";
        const match = command.match(/^\/model\s+(.+?)\s+--provider\s+(.+)$/);
        if (match) {
          liveModel = match[1];
          liveProvider = match[2];
        }
        return {};
      }
      if (method === "model.options") {
        return { model: liveModel, provider: liveProvider, providers: [] };
      }
      return {};
    });

    const api: HarnessApi = {};
    render(<Harness api={api} />);

    await act(async () => {
      await api.send?.("bad provider turn");
    });

    await act(async () => {
      dashboardMock.onEvent?.({
        payload: {
          error: "Invalid API Key",
          status: "error",
        },
        session_id: "live-bad",
        type: "message.complete",
      });
    });

    const badSend = api.send;
    await act(async () => {
      api.setProvider?.("good-provider");
      api.setModel?.("good-model");
      api.activeTurnRef!.current = { ...activeRecoveryTurn };
      api.setMessages?.((prev) => [
        ...prev,
        {
          id: "u-recovery",
          role: "user",
          content: "recovery turn",
          turnId: "turn-recovery",
        },
      ]);
    });
    await waitFor(() => expect(api.send).not.toBe(badSend));

    await act(async () => {
      await api.send?.("recovery turn");
    });

    expect(requests).not.toContainEqual({
      method: "session.resume",
      params: { session_id: "stored-chat", cols: 96 },
    });
    expect(
      requests.filter((request) => request.method === "session.create"),
    ).toEqual([
      {
        method: "session.create",
        params: {
          cols: 96,
          model: "bad-model",
          provider: "bad-provider",
        },
      },
    ]);
    expect(requests).not.toContainEqual({
      method: "session.close",
      params: {
        session_id: "live-bad",
      },
    });
    expect(requests).toContainEqual({
      method: "prompt.submit",
      params: {
        session_id: "live-bad",
        text: "recovery turn",
      },
    });
    expect(window.hermesAPI.recordSessionLocalError).toHaveBeenCalledWith(
      "stored-chat",
      {
        error: "Invalid API Key",
        userContent: "bad provider turn",
      },
    );
    expect(window.hermesAPI.recordSessionContinuation).not.toHaveBeenCalled();
  });

  it("rebinds the stored conversation after a synchronous provider failure instead of force-creating a chat", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    let submitCalls = 0;
    let resumeCalls = 0;
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.resume") {
        resumeCalls += 1;
        return {
          session_id: resumeCalls === 1 ? "live-bad" : "live-recovered",
          resumed: "stored-chat",
        };
      }
      if (method === "session.create") {
        return {
          session_id: "unexpected-new-chat",
          stored_session_id: "unexpected-new-chat",
        };
      }
      if (method === "model.options") {
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      }
      if (method === "prompt.submit") {
        submitCalls += 1;
        if (submitCalls === 1) throw new Error("HTTP 401: Invalid API key");
      }
      return {};
    });

    const api: HarnessApi = {};
    render(<Harness api={api} hermesSessionId="stored-chat" />);

    await act(async () => {
      await api.send?.("bad provider turn");
    });

    await act(async () => {
      api.activeTurnRef!.current = { ...activeRecoveryTurn };
      api.setMessages?.((prev) => [
        ...prev,
        {
          id: "u-recovery",
          role: "user",
          content: "recovery turn",
          turnId: "turn-recovery",
        },
      ]);
    });

    await act(async () => {
      await api.send?.("recovery turn");
    });

    expect(
      requests.filter((request) => request.method === "session.create"),
    ).toHaveLength(0);
    expect(
      requests.filter((request) => request.method === "session.resume"),
    ).toEqual([
      {
        method: "session.resume",
        params: { session_id: "stored-chat", cols: 96 },
      },
      {
        method: "session.resume",
        params: { session_id: "stored-chat", cols: 96 },
      },
    ]);
    expect(requests).not.toContainEqual({
      method: "session.close",
      params: { session_id: "live-bad" },
    });
    expect(requests).toContainEqual({
      method: "prompt.submit",
      params: { session_id: "live-recovered", text: "recovery turn" },
    });
  });

  it("retires a stale dashboard snapshot and resumes the same stored conversation", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    let resumeCalls = 0;
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.resume") {
        resumeCalls += 1;
        return {
          session_id:
            resumeCalls === 1 ? "live-before-restart" : "live-after-restart",
          resumed: "stored-chat",
        };
      }
      if (method === "session.create") {
        return {
          session_id: "unexpected-new-chat",
          stored_session_id: "unexpected-new-chat",
        };
      }
      if (method === "model.options") {
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      }
      return {};
    });

    const api: HarnessApi = {};
    render(<Harness api={api} hermesSessionId="stored-chat" />);

    await act(async () => {
      await api.send?.("turn before credential change");
    });

    await act(async () => {
      api.setRuntimeConnectionRevision?.((revision) => revision + 1);
    });
    await waitFor(() => expect(dashboardMock.close).toHaveBeenCalled());

    await act(async () => {
      api.activeTurnRef!.current = {
        startIndex: api.messages?.length ?? 0,
        status: "running",
        turnId: "turn-after-restart",
        userId: "u-after-restart",
      };
      api.setMessages?.((prev) => [
        ...prev,
        {
          id: "u-after-restart",
          role: "user",
          content: "turn after credential change",
          turnId: "turn-after-restart",
        },
      ]);
    });

    await act(async () => {
      await api.send?.("turn after credential change");
    });

    expect(dashboardMock.connect).toHaveBeenCalledTimes(2);
    expect(
      requests.filter((request) => request.method === "session.create"),
    ).toHaveLength(0);
    expect(
      requests.filter((request) => request.method === "session.resume"),
    ).toEqual([
      {
        method: "session.resume",
        params: { session_id: "stored-chat", cols: 96 },
      },
      {
        method: "session.resume",
        params: { session_id: "stored-chat", cols: 96 },
      },
    ]);
    expect(requests).toContainEqual({
      method: "prompt.submit",
      params: {
        session_id: "live-after-restart",
        text: "turn after credential change",
      },
    });
  });

  it("discards an in-flight dashboard client after the connection mode changes", async () => {
    let releaseFirstConnect: (() => void) | null = null;
    const requests: Array<{ method: string; params: unknown }> = [];

    dashboardMock.connect
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseFirstConnect = () => resolve(undefined);
          }),
      )
      .mockImplementation(async () => undefined);
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return { session_id: "live-new", stored_session_id: "stored-new" };
      }
      if (method === "model.options") {
        return { model: "bad-model", provider: "bad-provider", providers: [] };
      }
      return {};
    });

    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi
          .fn()
          .mockResolvedValueOnce({
            connection: { wsUrl: "ws://old-dashboard" },
            running: true,
          })
          .mockResolvedValue({
            connection: { wsUrl: "ws://new-dashboard" },
            running: true,
          }),
      },
    });

    const api: HarnessApi = {};
    render(<Harness api={api} />);

    let firstSend: Promise<boolean> | null = null;
    await act(async () => {
      firstSend = api.send?.("first prompt") ?? null;
    });
    await waitFor(() =>
      expect(window.hermesAPI.startDashboard).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      api.setConnectionMode?.("remote");
    });

    await act(async () => {
      releaseFirstConnect?.();
      await firstSend;
    });

    expect(dashboardMock.close).toHaveBeenCalled();

    await act(async () => {
      api.activeTurnRef!.current = {
        startIndex: api.messages?.length ?? 0,
        status: "running",
        turnId: "turn-new",
        userId: "u-new",
      };
      api.setMessages?.((prev) => [
        ...prev,
        {
          id: "u-new",
          role: "user",
          content: "new prompt",
          turnId: "turn-new",
        },
      ]);
    });

    await act(async () => {
      await api.send?.("new prompt");
    });

    expect(dashboardMock.connect).toHaveBeenNthCalledWith(
      1,
      "ws://old-dashboard",
    );
    expect(dashboardMock.connect).toHaveBeenNthCalledWith(
      2,
      "ws://new-dashboard",
    );
    expect(requests.map((request) => request.method)).toContain(
      "prompt.submit",
    );
  });
});

describe("official quality feedback eligibility", () => {
  const eligibility = {
    eventId: "019f0000-0000-7000-8000-000000000001",
    result: "success" as const,
    latencyBucket: "1s_5s" as const,
    totalTokenBucket: "1_1k" as const,
    crashCode: null,
  };
  const messages: ChatMessage[] = [
    {
      id: "user-1",
      role: "user",
      content: "private prompt",
      turnId: "turn-1",
    },
    {
      id: "agent-1",
      role: "agent",
      content: "private response",
      turnId: "turn-1",
      pending: false,
    },
  ];

  it("attaches trusted eligibility only to a completed successful agent turn", () => {
    expect(
      attachOfficialQualityEligibility(
        messages,
        {
          startIndex: 0,
          status: "running",
          turnId: "turn-1",
          userId: "user-1",
        },
        eligibility,
      ),
    ).toBe(messages);

    const attached = attachOfficialQualityEligibility(
      messages,
      {
        startIndex: 0,
        status: "completed",
        turnId: "turn-1",
        userId: "user-1",
      },
      eligibility,
    );
    expect(attached).not.toBe(messages);
    expect(attached[1]).toMatchObject({
      officialQualityEligibility: eligibility,
    });
    expect(JSON.stringify(attached[1])).not.toContain("runtimeBindingId");
  });

  it("does not fabricate controls without a trusted main-process eligibility event", () => {
    expect(
      attachOfficialQualityEligibility(
        messages,
        {
          startIndex: 0,
          status: "completed",
          turnId: "turn-1",
          userId: "user-1",
        },
        null,
      ),
    ).toBe(messages);
  });
});

describe("useDashboardChatTransport unavailable fallback (issue #667)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function mockStartDashboard(): ReturnType<typeof vi.fn> {
    const startDashboard = vi.fn(async () => ({
      running: false,
      error: "Hermes dashboard chat WebSocket is unavailable (404)",
    }));
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard,
      },
    });
    return startDashboard;
  }

  it("latches unavailable on SSH and fails fast on later sends, notifying once", async () => {
    const startDashboard = mockStartDashboard();
    const onUnavailable = vi.fn();
    const api: HarnessApi = {};
    render(
      <Harness
        api={api}
        initialConnectionMode="ssh"
        fallbackOnUnavailable
        onDashboardUnavailable={onUnavailable}
      />,
    );

    let first: boolean | undefined;
    await act(async () => {
      first = await api.send?.("hello");
    });
    // Dashboard unavailable → caller falls back to legacy (returns false).
    expect(first).toBe(false);
    expect(startDashboard).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledTimes(1);

    let second: boolean | undefined;
    await act(async () => {
      second = await api.send?.("again");
    });
    expect(second).toBe(false);
    // Fast path: no second status/probe round-trip, no duplicate notice.
    expect(startDashboard).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the connection changes", async () => {
    const startDashboard = mockStartDashboard();
    const api: HarnessApi = {};
    render(
      <Harness api={api} initialConnectionMode="ssh" fallbackOnUnavailable />,
    );

    await act(async () => {
      await api.send?.("hello");
    });
    expect(startDashboard).toHaveBeenCalledTimes(1);

    // Switching connection clears the sticky flag → the dashboard is retried.
    await act(async () => {
      api.setConnectionMode?.("remote");
    });
    await act(async () => {
      await api.send?.("after change");
    });
    expect(startDashboard).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying on local (does not latch)", async () => {
    const startDashboard = mockStartDashboard();
    const api: HarnessApi = {};
    render(
      <Harness api={api} initialConnectionMode="local" fallbackOnUnavailable />,
    );

    await act(async () => {
      await api.send?.("hello");
    });
    await act(async () => {
      await api.send?.("again");
    });
    // Local dashboard may still be spawning, so each send re-checks.
    expect(startDashboard).toHaveBeenCalledTimes(2);
  });
});

describe("useDashboardChatTransport messagesRef sync", () => {
  beforeEach(() => {
    dashboardMock.close.mockClear();
    dashboardMock.connect.mockClear();
    dashboardMock.instances.length = 0;
    dashboardMock.onEvent = null;
    dashboardMock.request.mockReset();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // `background.complete` appends an agent bubble built from `messagesRef.current`,
  // so it reads exactly the array the sync effect maintains — a clean probe for
  // whether the ref adopted an external Chat-state change. It requires a live
  // gateway client, so every test connects with one `send` first (which does not
  // append a user bubble — Chat owns that).
  const connect = async (api: HarnessApi): Promise<void> => {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create") {
        return { session_id: "live-1", stored_session_id: "stored-1" };
      }
      return {};
    });
    await act(async () => {
      await api.send?.("hello");
    });
    expect(dashboardMock.onEvent).toBeTypeOf("function");
  };

  const backgroundComplete = async (): Promise<void> => {
    await act(async () => {
      dashboardMock.onEvent?.({
        payload: { task_id: "t1", text: "bg answer" },
        type: "background.complete",
      });
    });
  };

  it("adopts an external clear so a new turn does not resurrect deleted messages (#757)", async () => {
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await connect(api);

    // Chat's `handleClear` empties the list without unmounting <Chat>. A length
    // guard (`messages.length > ref.length`) would skip this and leave the ref
    // pointing at the deleted turn, so the next event would append onto it.
    await act(async () => {
      api.setMessages?.([]);
    });
    await backgroundComplete();

    expect(api.messages).toHaveLength(1);
    expect(api.messages?.[0]?.id).toBe("bg-t1");
  });

  it("adopts a same-length in-place replacement (clarify resolve / edit)", async () => {
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await connect(api);

    // Same length, different content — mirrors `handleClarifyResolved` mapping a
    // clarify card to resolved before the gateway resumes the turn.
    await act(async () => {
      api.setMessages?.([
        { id: "u-edited", role: "user", content: "edited turn" },
      ]);
    });
    await backgroundComplete();

    expect(api.messages).toHaveLength(2);
    expect(api.messages?.[0]?.id).toBe("u-edited");
    expect(api.messages?.[1]?.id).toBe("bg-t1");
  });
});

describe("useDashboardChatTransport context gauge estimate (no usage payload)", () => {
  beforeEach(() => {
    dashboardMock.close.mockClear();
    dashboardMock.connect.mockClear();
    dashboardMock.instances.length = 0;
    dashboardMock.onEvent = null;
    dashboardMock.request.mockReset();
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create") {
        return { session_id: "live-1", stored_session_id: "stored-1" };
      }
      return {};
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Resolve the final usage object a setUsage((prev) => next) call produces.
  const lastUsage = (setUsage: SetUsageMock): UsageState | null => {
    expect(setUsage).toHaveBeenCalled();
    const updater = setUsage.mock.calls.at(-1)?.[0];
    if (typeof updater !== "function") {
      throw new Error("setUsage was not called with an updater function");
    }
    return updater(null);
  };

  it("sets an estimated contextTokens when a successful completion has no usage", async () => {
    const setUsage = vi.fn() as SetUsageMock;
    const api: HarnessApi = {};
    render(<Harness api={api} setUsage={setUsage} />);
    await act(async () => {
      await api.send?.("hello");
    });

    // Provider omitted usage entirely → usageFromPayload returns null. The
    // gauge only renders when contextTokens is set, so the estimate must fill
    // it in — this was the case the gauge went blank on (#789).
    await act(async () => {
      dashboardMock.onEvent?.({
        payload: { status: "completed", final_response: "hi there" },
        session_id: "live-1",
        type: "message.complete",
      });
    });

    const usage = lastUsage(setUsage);
    expect(usage?.contextTokens).toBeGreaterThan(0);
  });

  it("prefers exact payload usage over the estimate", async () => {
    const setUsage = vi.fn() as SetUsageMock;
    const api: HarnessApi = {};
    render(<Harness api={api} setUsage={setUsage} />);
    await act(async () => {
      await api.send?.("hello");
    });

    await act(async () => {
      dashboardMock.onEvent?.({
        payload: {
          status: "completed",
          final_response: "hi there",
          usage: { input: 5000, output: 200, context_used: 45000 },
        },
        session_id: "live-1",
        type: "message.complete",
      });
    });

    const usage = lastUsage(setUsage);
    expect(usage?.contextTokens).toBe(45000);
  });

  it("does not fabricate usage for a failed turn without usage", async () => {
    const setUsage = vi.fn() as SetUsageMock;
    const api: HarnessApi = {};
    render(<Harness api={api} setUsage={setUsage} />);
    await act(async () => {
      await api.send?.("hello");
    });

    await act(async () => {
      dashboardMock.onEvent?.({
        payload: { status: "error", error: "Invalid API Key" },
        session_id: "live-1",
        type: "message.complete",
      });
    });

    expect(setUsage).not.toHaveBeenCalled();
  });
});
