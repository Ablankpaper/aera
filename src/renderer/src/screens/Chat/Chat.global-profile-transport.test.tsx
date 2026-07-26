import { act, cleanup, render, waitFor } from "@testing-library/react";
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
vi.mock("./hooks/useChatIPC", () => ({ useChatIPC: vi.fn() }));
vi.mock("./hooks/useChatActions", () => ({
  parseBackgroundCommand: () => null,
  useChatActions: () => chatActions,
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
  ChatInput: () => <div data-testid="input" />,
}));
vi.mock("./ChatEmptyState", () => ({ ChatEmptyState: () => <div /> }));
vi.mock("./MessageList", () => ({ MessageList: () => <div /> }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => <div /> }));
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
    emitIdentityChanged = null;
    emitGlobalProfileChanged = null;
    prepareConversationContext = vi.fn(async () => ({
      globalProfileVersion: 3,
      requiresBoundApiTransport: true,
      degraded: false,
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

    expect(emitGlobalProfileChanged).toBeNull();
  });

  it("prepares a new identity-scoped context immediately after an Agent rename", async () => {
    prepareConversationContext
      .mockResolvedValueOnce({
        globalProfileVersion: 0,
        requiresBoundApiTransport: false,
        degraded: false,
      })
      .mockResolvedValueOnce({
        globalProfileVersion: 4,
        requiresBoundApiTransport: true,
        degraded: false,
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
});
