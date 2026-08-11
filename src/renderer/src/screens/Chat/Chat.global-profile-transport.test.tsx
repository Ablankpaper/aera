import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Chat from "./Chat";

const dashboard = vi.hoisted(() => ({
  enabledValues: [] as boolean[],
  getCommandCatalog: vi.fn(async () => ({ commands: [] })),
}));

const modelConfig = vi.hoisted(() => ({
  currentModel: "",
  currentProvider: "",
  currentBaseUrl: "",
  displayModel: "",
  modelGroups: [],
  reload: vi.fn(async () => undefined),
  selectModel: vi.fn(async () => undefined),
}));

const chatActions = vi.hoisted(() => ({
  handleSend: vi.fn(async () => undefined),
  handleBackground: vi.fn(async () => undefined),
  handleApprove: vi.fn(),
  handleDeny: vi.fn(),
  handleQuickAsk: vi.fn(),
  handleAbort: vi.fn(),
}));

interface CapturedChatIpcArgs {
  onSessionStarted?: (runId: string, sessionId: string) => void;
  onAgentSegment?: (runId: string, event: unknown) => void;
}

interface CapturedModelPickerProps {
  agentConversation?: {
    activeRoute?: { model?: string };
    activeSegmentOrdinal?: number;
  } | null;
  agentSwitchState?: string;
  onSelectAgentModel?: (selection: unknown) => void;
}

interface CapturedMessageListProps {
  messages?: Array<{ kind?: string; segmentId?: string }>;
}

const chatHarness = vi.hoisted(() => ({
  ipcArgs: [] as CapturedChatIpcArgs[],
  actionArgs: [] as Array<Record<string, unknown>>,
  modelPickerProps: [] as CapturedModelPickerProps[],
  messageListProps: [] as CapturedMessageListProps[],
}));

vi.mock("./hooks/useDashboardChatTransport", () => ({
  dashboardChatEnabledForConnection: () => true,
  useDashboardChatTransport: (input: { enabled: boolean }) => {
    dashboard.enabledValues.push(input.enabled);
    return {
      enabled: input.enabled,
      getCommandCatalog: dashboard.getCommandCatalog,
      sendMessage: vi.fn(async () => false),
      execSlash: vi.fn(async () => false),
      runBackground: vi.fn(async () => null),
      abort: vi.fn(),
    };
  },
}));

vi.mock("./hooks/useModelConfig", () => ({
  effectiveOverrideBaseUrl: () => "",
  useModelConfig: () => modelConfig,
}));
vi.mock("./hooks/useChatIPC", () => ({
  useChatIPC: (input: CapturedChatIpcArgs) => {
    chatHarness.ipcArgs.push(input);
  },
}));
vi.mock("./hooks/useChatActions", () => ({
  parseBackgroundCommand: () => null,
  useChatActions: (input: Record<string, unknown>) => {
    chatHarness.actionArgs.push(input);
    return chatActions;
  },
}));
vi.mock("./hooks/useChatScroll", () => ({
  useChatScroll: () => ({
    containerRef: { current: null },
    bottomRef: { current: null },
  }),
}));
vi.mock("./hooks/useFastMode", () => ({
  useFastMode: () => ({ fastMode: false, toggle: vi.fn(), set: vi.fn() }),
}));
vi.mock("./hooks/useReasoningEffort", () => ({
  useReasoningEffort: () => ({
    reasoningEffort: null,
    setReasoningEffort: vi.fn(),
  }),
}));
vi.mock("./hooks/useLocalCommands", () => ({ useLocalCommands: () => ({}) }));
vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("react-hot-toast", () => ({ default: vi.fn() }));

vi.mock("./ChatInput", () => ({
  ChatInput: ({ toolbarExtras }: { toolbarExtras?: React.ReactNode }) => (
    <div data-testid="input">{toolbarExtras}</div>
  ),
}));
vi.mock("./ChatEmptyState", () => ({ ChatEmptyState: () => <div /> }));
vi.mock("./MessageList", () => ({
  MessageList: (props: CapturedMessageListProps) => {
    chatHarness.messageListProps.push(props);
    return <div data-testid="message-list" />;
  },
}));
vi.mock("./ModelPicker", () => ({
  ModelPicker: (props: CapturedModelPickerProps) => {
    chatHarness.modelPickerProps.push(props);
    return <div data-testid="model-picker" />;
  },
}));
vi.mock("./ReasoningEffortPicker", () => ({
  ReasoningEffortPicker: () => <div />,
}));
vi.mock("./ContextFolderChip", () => ({ ContextFolderChip: () => <div /> }));
vi.mock("./WorktreePanel", () => ({ WorktreePanel: () => <div /> }));
vi.mock("./RemoteFolderPicker", () => ({ RemoteFolderPicker: () => <div /> }));
vi.mock("./WebPreviewPanel", () => ({ WebPreviewPanel: () => <div /> }));
vi.mock("./QueuedMessages", () => ({ QueuedMessages: () => <div /> }));
vi.mock("../../components/ConfigHealthBanner", () => ({
  ConfigHealthBanner: () => <div />,
}));

describe("Chat global-profile transport freeze", () => {
  let emitIdentityChanged: ((identity: { profileId: string }) => void) | null;
  let emitGlobalProfileChanged: (() => void) | null;
  let prepareConversationContext: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dashboard.enabledValues.length = 0;
    dashboard.getCommandCatalog.mockClear();
    chatHarness.ipcArgs.length = 0;
    chatHarness.actionArgs.length = 0;
    chatHarness.modelPickerProps.length = 0;
    chatHarness.messageListProps.length = 0;
    emitIdentityChanged = null;
    emitGlobalProfileChanged = null;
    prepareConversationContext = vi.fn(async () => ({
      globalProfileVersion: 3,
      requiresBoundApiTransport: true,
      degraded: false,
      conversationBoundary: {
        scope: "ORGANIZATION",
        scopeId: "10000000-0000-4000-8000-000000000001",
        scopeDisplayName: "Acme",
        visibility: "PRIVATE",
        origin: "NEW_CONVERSATION",
      },
    }));

    Object.defineProperty(window, "agenteraGlobalProfile", {
      configurable: true,
      value: {
        prepareConversationContext,
        get: vi.fn(async () => ({
          success: true,
          value: {
            schemaVersion: 1,
            profileVersion: 3,
            updatedAt: "2026-07-26T08:00:00.000Z",
            entries: [{ id: "communication_style.answer_order" }],
          },
        })),
        onChanged: vi.fn((callback: () => void) => {
          emitGlobalProfileChanged = callback;
          return vi.fn();
        }),
      },
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        onAgentIdentityChanged: vi.fn(
          (callback: (identity: { profileId: string }) => void) => {
            emitIdentityChanged = callback;
            return vi.fn();
          },
        ),
        getConnectionConfig: vi.fn(async () => ({ mode: "local" })),
        onConnectionConfigChanged: vi.fn(() => vi.fn()),
        validateChatReadiness: vi.fn(async () => ({ ok: true })),
        getModelContextWindow: vi.fn(async () => null),
        getSessionContextFolder: vi.fn(async () => null),
        getSessionModelOverride: vi.fn(async () => null),
        setSessionContextFolder: vi.fn(async () => true),
        setSessionModelOverride: vi.fn(async () => true),
        onContextMenuCopyChat: vi.fn(() => vi.fn()),
        onContextMenuSelectBubble: vi.fn(() => vi.fn()),
      },
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "agenteraGlobalProfile");
    Reflect.deleteProperty(window, "hermesAPI");
  });

  it("keeps one conversation on its prepared transport after the account profile changes", async () => {
    render(<Chat runId="conversation-one" profile="agent-one" />);

    await waitFor(() => {
      expect(prepareConversationContext).toHaveBeenCalledWith({
        runId: "conversation-one",
        profile: "agent-one",
        resumeSessionId: null,
      });
      expect(dashboard.enabledValues.at(-1)).toBe(false);
    });

    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(
      screen.getByText("chat.boundary.visibilityValue.PRIVATE"),
    ).toBeInTheDocument();
    expect(emitGlobalProfileChanged).toBeNull();
  });

  it("prepares a new identity-scoped context immediately after an Agent rename", async () => {
    prepareConversationContext
      .mockResolvedValueOnce({
        globalProfileVersion: 0,
        requiresBoundApiTransport: false,
        degraded: false,
        conversationBoundary: null,
      })
      .mockResolvedValueOnce({
        globalProfileVersion: 4,
        requiresBoundApiTransport: true,
        degraded: false,
        conversationBoundary: null,
      });
    const onSessionIdChange = vi.fn();
    render(
      <Chat
        runId="conversation-two"
        profile="agent-two"
        initialSessionId="hermes-session-old"
        onSessionIdChange={onSessionIdChange}
      />,
    );

    await waitFor(() => {
      expect(prepareConversationContext).toHaveBeenNthCalledWith(1, {
        runId: "conversation-two",
        profile: "agent-two",
        resumeSessionId: "hermes-session-old",
      });
      expect(dashboard.enabledValues.at(-1)).toBe(true);
    });

    await act(async () => {
      emitIdentityChanged?.({ profileId: "agent-two" });
    });

    await waitFor(() => {
      expect(prepareConversationContext).toHaveBeenNthCalledWith(2, {
        runId: "conversation-two",
        profile: "agent-two",
        resumeSessionId: null,
      });
      expect(onSessionIdChange).toHaveBeenLastCalledWith(
        "conversation-two",
        null,
      );
      expect(dashboard.enabledValues.at(-1)).toBe(false);
    });
  });

  it("fails closed when immutable conversation context preparation fails", async () => {
    prepareConversationContext.mockRejectedValueOnce(
      new Error("boundary_conflict"),
    );

    render(<Chat runId="conflicted-run" profile="published-agent" />);

    await waitFor(() => {
      expect(prepareConversationContext).toHaveBeenCalledWith({
        runId: "conflicted-run",
        profile: "published-agent",
        resumeSessionId: null,
      });
      expect(dashboard.enabledValues.at(-1)).toBe(false);
    });
  });

  // @lat: [[model-selection#Installed-Agent switch policy and immutable resume#Authoritative resume context]]
  it("waits for authoritative Agent context before reading an ordinary session override and keeps it visible during refresh", async () => {
    let resolveInitial!: (value: Record<string, unknown>) => void;
    let resolveRefresh!: (value: Record<string, unknown>) => void;
    const agentConversation = {
      threadId: "thread-1",
      policyMode: "user_select",
      activeRoute: {
        provider: "openai",
        model: "gpt-5.6",
        baseUrl: "https://api.openai.com/v1",
        apiMode: "responses",
      },
      activeSegmentOrdinal: 1,
      catalog: {
        revision: "a".repeat(64),
        targetProfileId: "account",
        routes: [],
      },
      switchDisabledCode: null,
    };
    prepareConversationContext
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const getSessionModelOverride = window.hermesAPI
      .getSessionModelOverride as ReturnType<typeof vi.fn>;

    render(
      <Chat
        runId="agent-resume"
        profile="installed-agent"
        initialSessionId="segment-old"
      />,
    );

    await waitFor(() => expect(prepareConversationContext).toHaveBeenCalled());
    expect(getSessionModelOverride).not.toHaveBeenCalled();

    await act(async () => {
      resolveInitial({
        globalProfileVersion: 3,
        requiresBoundApiTransport: true,
        degraded: false,
        conversationBoundary: null,
        agentConversation,
      });
    });
    await waitFor(() =>
      expect(chatHarness.modelPickerProps.at(-1)?.agentConversation).toEqual(
        agentConversation,
      ),
    );
    expect(getSessionModelOverride).not.toHaveBeenCalled();

    await act(async () => {
      chatHarness.ipcArgs
        .at(-1)
        ?.onSessionStarted?.("agent-resume", "segment-active");
    });
    await waitFor(() =>
      expect(prepareConversationContext).toHaveBeenLastCalledWith({
        runId: "agent-resume",
        profile: "installed-agent",
        resumeSessionId: "segment-active",
      }),
    );
    expect(chatHarness.modelPickerProps.at(-1)?.agentConversation).toEqual(
      agentConversation,
    );
    expect(getSessionModelOverride).not.toHaveBeenCalled();

    await act(async () => {
      resolveRefresh({
        globalProfileVersion: 3,
        requiresBoundApiTransport: true,
        degraded: false,
        conversationBoundary: null,
        agentConversation,
      });
    });
  });

  // @lat: [[model-selection#Installed-Agent switch policy and immutable resume#Main-acknowledged local marker]]
  it("inserts and deduplicates a marker only after Main activates the staged route", async () => {
    const selection = {
      sourceProfileId: "account",
      modelLibraryId: "petoi-gpt",
      catalogRevision: "a".repeat(64),
    };
    const agentConversation = {
      threadId: "thread-1",
      policyMode: "user_select",
      activeRoute: {
        provider: "openai",
        model: "gpt-5.6",
        baseUrl: "https://api.openai.com/v1",
        apiMode: "responses",
      },
      activeSegmentOrdinal: 1,
      catalog: {
        revision: "a".repeat(64),
        targetProfileId: "account",
        routes: [],
      },
      switchDisabledCode: null,
    };
    prepareConversationContext.mockResolvedValueOnce({
      globalProfileVersion: 3,
      requiresBoundApiTransport: true,
      degraded: false,
      conversationBoundary: null,
      agentConversation,
    });
    render(
      <Chat
        runId="agent-switch"
        profile="installed-agent"
        initialMessages={[
          { id: "u1", role: "user", content: "hello" },
          { id: "a1", role: "agent", content: "hi" },
        ]}
      />,
    );

    await waitFor(() =>
      expect(chatHarness.modelPickerProps.at(-1)?.agentConversation).toEqual(
        agentConversation,
      ),
    );
    await act(async () => {
      chatHarness.modelPickerProps.at(-1)?.onSelectAgentModel?.(selection);
    });
    await waitFor(() =>
      expect(chatHarness.actionArgs.at(-1)?.agentModelSelection).toEqual(
        selection,
      ),
    );
    expect(
      chatHarness.messageListProps
        .at(-1)
        ?.messages?.filter((message) => message.kind === "model_switch"),
    ).toHaveLength(0);

    const activeEvent = {
      state: "active",
      threadId: "thread-1",
      segmentId: "segment-2",
      from: agentConversation.activeRoute,
      to: {
        provider: "custom:petoi",
        model: "gpt-5.6-sol",
        baseUrl: "https://api.petoi.cn/v1",
        apiMode: "codex_responses",
      },
      historyBoundaryCount: 2,
      code: null,
    };
    await act(async () => {
      chatHarness.ipcArgs.at(-1)?.onAgentSegment?.("agent-switch", activeEvent);
      chatHarness.ipcArgs.at(-1)?.onAgentSegment?.("agent-switch", activeEvent);
    });

    expect(
      chatHarness.messageListProps
        .at(-1)
        ?.messages?.filter((message) => message.kind === "model_switch"),
    ).toEqual([expect.objectContaining({ segmentId: "segment-2" })]);
    expect(chatHarness.actionArgs.at(-1)?.agentModelSelection).toBeUndefined();
    expect(
      chatHarness.modelPickerProps.at(-1)?.agentConversation
        ?.activeSegmentOrdinal,
    ).toBe(2);
  });

  // @lat: [[lat.md/agentera-app-authentication#AgentEra application authentication#Startup gate#Account-required routing#Chat transport privacy]]
  it("does not read account-owned connection configuration for a guest chat", async () => {
    const getConnectionConfig = window.hermesAPI
      .getConnectionConfig as ReturnType<typeof vi.fn>;
    const onConnectionConfigChanged = window.hermesAPI
      .onConnectionConfigChanged as ReturnType<typeof vi.fn>;

    render(
      <Chat
        runId="guest-conversation"
        profile="guest-profile"
        allowAccountConnection={false}
      />,
    );

    await waitFor(() => {
      expect(prepareConversationContext).toHaveBeenCalled();
      expect(getConnectionConfig).not.toHaveBeenCalled();
      expect(onConnectionConfigChanged).not.toHaveBeenCalled();
    });
  });
});
