import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import Layout from "./Layout";

const testState = vi.hoisted(() => ({
  openSettings: vi.fn(),
  chatConnectionAccess: [] as boolean[],
  chatProps: [] as Array<{
    profile?: string;
    agentAppearance?: { displayName?: string | null };
  }>,
  identityListener: null as
    | null
    | ((identity: {
        profileId: string;
        displayName: string;
        revision: number;
        updatedAt: string;
      }) => void),
  chatProfiles: [] as string[],
}));

vi.mock("../Chat/Chat", () => ({
  default: ({
    allowAccountConnection,
    onOpenMyAgents,
    profile,
    agentAppearance,
  }: {
    allowAccountConnection?: boolean;
    onOpenMyAgents?: () => void;
    profile?: string;
    agentAppearance?: { displayName?: string | null };
  }) => {
    testState.chatConnectionAccess.push(allowAccountConnection ?? true);
    testState.chatProps.push({ profile, agentAppearance });
    if (profile) testState.chatProfiles.push(profile);
    return (
      <div data-testid="chat-surface">
        <button type="button" onClick={onOpenMyAgents}>
          open-my-agents
        </button>
      </div>
    );
  },
}));
vi.mock("./ActiveSessionsBar", () => ({
  ActiveSessionsBar: () => <div data-testid="active-sessions" />,
}));
vi.mock("../Sessions/Sessions", () => ({ default: () => null }));
vi.mock("../Agents/Agents", () => ({
  default: ({ onConfigureModels }: { onConfigureModels?: () => void }) => (
    <div data-testid="agents-surface">
      <button type="button" onClick={onConfigureModels}>
        configure-agent-model
      </button>
    </div>
  ),
}));
vi.mock("../Discover/Discover", () => ({ default: () => null }));
vi.mock("./ProductSpaceSwitcher", () => ({ default: () => null }));
vi.mock("./WorkspaceManagementDialog", () => ({ default: () => null }));
vi.mock("./OrganizationManagementDialog", () => ({ default: () => null }));
vi.mock("./SidebarRecentSessions", () => ({ default: () => null }));
vi.mock("../Skills/Skills", () => ({ default: () => null }));
vi.mock("../Office/Office", () => ({ default: () => null }));
vi.mock("../Schedules/Schedules", () => ({ default: () => null }));
vi.mock("../Kanban/Kanban", () => ({ default: () => null }));
vi.mock("../../components/RemoteNotice", () => ({ default: () => null }));
vi.mock("../../components/VerifyWarningBanner", () => ({
  default: () => null,
}));
vi.mock("../../components/AgenteraAccountMenu", () => ({
  default: () => null,
}));
vi.mock("../../components/AgenteraOfflineBanner", () => ({
  default: () => null,
}));
vi.mock("../../components/settings/SettingsModalContext", () => ({
  useSettingsModal: () => ({
    openSettings: testState.openSettings,
    closeSettings: vi.fn(),
  }),
}));
vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string): string => key,
  }),
}));

const authenticated: AgenteraAuthPublicState = {
  status: "authenticated",
  userId: "10000000-0000-4000-8000-000000000001",
  personalSpaceId: "20000000-0000-4000-8000-000000000002",
  deviceId: "30000000-0000-4000-8000-000000000003",
  offlineExpiresAt: "2026-07-28T00:00:00.000Z",
  cloudAvailable: true,
};

const guest: AgenteraAuthPublicState = {
  status: "unauthenticated",
  reason: "sign_in_required",
};

type HermesAPIMockName =
  | "listProfiles"
  | "getModelConfig"
  | "isRemoteOnlyMode"
  | "onUpdateAvailable"
  | "onUpdateDownloadProgress"
  | "onUpdateDownloaded"
  | "onUpdateError"
  | "onMenuNewChat"
  | "onMenuSearchSessions"
  | "onAgentIdentityChanged"
  | "abortChat"
  | "getSessionMessages";

type InstalledHermesAPI = Record<HermesAPIMockName, ReturnType<typeof vi.fn>>;

function installHermesAPI(model = "", provider = "auto"): InstalledHermesAPI {
  const api = {
    listProfiles: vi.fn().mockResolvedValue([
      {
        id: "default",
        name: "Default",
        isActive: true,
        color: "#666666",
        avatar: null,
      },
    ]),
    getModelConfig: vi.fn().mockResolvedValue({
      provider,
      model,
      baseUrl: model ? "https://api.example.com/v1" : "",
    }),
    isRemoteOnlyMode: vi.fn().mockResolvedValue(false),
    onUpdateAvailable: vi.fn(() => vi.fn()),
    onUpdateDownloadProgress: vi.fn(() => vi.fn()),
    onUpdateDownloaded: vi.fn(() => vi.fn()),
    onUpdateError: vi.fn(() => vi.fn()),
    onMenuNewChat: vi.fn(() => vi.fn()),
    onMenuSearchSessions: vi.fn(() => vi.fn()),
    onAgentIdentityChanged: vi.fn(
      (listener: NonNullable<typeof testState.identityListener>) => {
        testState.identityListener = listener;
        return vi.fn();
      },
    ),
    abortChat: vi.fn(),
    getSessionMessages: vi.fn().mockResolvedValue([]),
  };
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: api,
  });
  return api;
}

describe("startup model setup prompt", () => {
  afterEach(async () => {
    // Radix FocusScope defers its unmount autofocus event with setTimeout(0).
    // Drain it before Vitest tears down this jsdom realm; otherwise a later
    // worker environment can supply the CustomEvent for an element created by
    // this realm and jsdom rejects it as the wrong Event type.
    cleanup();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    testState.openSettings.mockReset();
    testState.chatConnectionAccess.length = 0;
    testState.chatProps.length = 0;
    testState.identityListener = null;
    testState.chatProfiles.length = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {
          return undefined;
        }
        disconnect(): void {
          return undefined;
        }
      },
    );
  });

  it("shows after login when the startup profile has no configured model", async () => {
    const api = installHermesAPI();

    render(<Layout authState={authenticated} />);

    const dialog = await screen.findByRole("dialog", {
      name: "providers.setupPrompt.title",
    });
    expect(dialog).toBeInTheDocument();
    expect(
      within(dialog).getByText("providers.setupPrompt.description"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", {
        name: "providers.setupPrompt.later",
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", {
        name: "providers.setupPrompt.configure",
      }),
    ).toBeInTheDocument();
    expect(api.getModelConfig).toHaveBeenCalledWith("default");
  });

  it("does not mount Chat against the placeholder default before restoring the active profile", async () => {
    let resolveProfiles!: (
      profiles: Array<{
        id: string;
        name: string;
        isActive: boolean;
        color: string;
        avatar: null;
      }>,
    ) => void;
    const api = installHermesAPI("gpt-5.6-sol", "custom");
    api.listProfiles.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProfiles = resolve;
        }),
    );

    render(<Layout authState={authenticated} />);

    await waitFor(() => expect(testState.chatProfiles).toEqual([]));
    resolveProfiles([
      {
        id: "work",
        name: "Work",
        isActive: true,
        color: "#666666",
        avatar: null,
      },
    ]);

    await waitFor(() => expect(testState.chatProfiles).toEqual(["work"]));
    expect(testState.chatProfiles).not.toContain("default");
  });

  it("does not interrupt users whose startup profile already has a model", async () => {
    const api = installHermesAPI("gpt-5.6-sol", "custom");

    render(<Layout authState={authenticated} />);

    await waitFor(() =>
      expect(api.getModelConfig).toHaveBeenCalledWith("default"),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("mounts the lazy Agents surface when chat opens My Agents", async () => {
    installHermesAPI("gpt-5.6-sol", "custom");
    render(<Layout authState={authenticated} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "open-my-agents" }),
    );

    expect(await screen.findByTestId("agents-surface")).toBeVisible();
  });

  it("shows only once per app session and returns after a fresh session", async () => {
    const api = installHermesAPI();
    const first = render(<Layout authState={authenticated} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "providers.setupPrompt.later",
      }),
    );
    first.unmount();

    const second = render(<Layout authState={authenticated} />);
    await waitFor(() => expect(api.listProfiles).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.getModelConfig).toHaveBeenCalledTimes(1);
    second.unmount();

    sessionStorage.clear();
    render(<Layout authState={authenticated} />);
    expect(
      await screen.findByRole("dialog", {
        name: "providers.setupPrompt.title",
      }),
    ).toBeInTheDocument();
    expect(api.getModelConfig).toHaveBeenCalledTimes(2);
  });

  it("opens the model settings page for the startup profile", async () => {
    installHermesAPI();
    render(<Layout authState={authenticated} />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "providers.setupPrompt.configure",
      }),
    );

    expect(testState.openSettings).toHaveBeenCalledWith("providers", {
      profile: "default",
    });
  });

  it("opens model settings for the active Agent user without exposing profile choices", async () => {
    installHermesAPI("gpt-5.6-sol", "custom");
    render(<Layout authState={authenticated} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "navigation.agents" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "configure-agent-model" }),
    );

    expect(testState.openSettings).toHaveBeenCalledWith("providers", {
      profile: "default",
    });
  });

  it("waits for the restored active profile before checking configuration", async () => {
    const api = installHermesAPI();
    api.listProfiles.mockResolvedValue([
      {
        id: "assistant",
        name: "Assistant",
        isActive: true,
        color: "#777777",
        avatar: null,
      },
    ]);

    render(<Layout authState={authenticated} />);

    expect(
      await screen.findByRole("dialog", {
        name: "providers.setupPrompt.title",
      }),
    ).toBeInTheDocument();
    expect(api.getModelConfig).toHaveBeenCalledWith("assistant");
    expect(api.getModelConfig).not.toHaveBeenCalledWith("default");
  });

  it("refreshes the active conversation display name without changing its Profile id", async () => {
    const api = installHermesAPI("gpt-5.6-sol", "custom");
    api.listProfiles.mockResolvedValue([
      {
        id: "video-agent",
        name: "智能短视频分析",
        displayName: "智能短视频分析",
        isActive: true,
        color: "#777777",
        avatar: null,
      },
    ]);

    render(<Layout authState={authenticated} />);

    await waitFor(() =>
      expect(testState.chatProps).toContainEqual(
        expect.objectContaining({
          profile: "video-agent",
          agentAppearance: expect.objectContaining({
            displayName: "智能短视频分析",
          }),
        }),
      ),
    );
    expect(testState.identityListener).not.toBeNull();

    act(() => {
      testState.identityListener?.({
        profileId: "video-agent",
        displayName: "短视频增长分析",
        revision: 2,
        updatedAt: "2026-08-13T00:00:00.000Z",
      });
    });

    await waitFor(() =>
      expect(testState.chatProps.at(-1)).toEqual(
        expect.objectContaining({
          profile: "video-agent",
          agentAppearance: expect.objectContaining({
            displayName: "短视频增长分析",
          }),
        }),
      ),
    );
  });

  it("stays quiet when model configuration cannot be inspected safely", async () => {
    const api = installHermesAPI();
    api.getModelConfig.mockRejectedValue(new Error("profile unavailable"));

    render(<Layout authState={authenticated} />);

    await waitFor(() => expect(api.getModelConfig).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // @lat: [[lat.md/agentera-app-authentication#AgentEra application authentication#Startup gate#Account-required routing#Layout connection privacy]]
  it("keeps guest startup local without reading account connection state", async () => {
    const api = installHermesAPI();

    render(<Layout authState={guest} />);

    expect(await screen.findByTestId("chat-surface")).toBeInTheDocument();
    await waitFor(() => expect(api.listProfiles).toHaveBeenCalled());
    expect(api.isRemoteOnlyMode).not.toHaveBeenCalled();
    expect(testState.chatConnectionAccess).toContain(false);
  });

  // @lat: [[lat.md/agentera-app-authentication#AgentEra application authentication#Startup gate#Account-required routing#Layout connection privacy#Account connection lookup fallback]]
  it("falls back to local presentation when account connection state is unavailable", async () => {
    const api = installHermesAPI();
    api.isRemoteOnlyMode.mockRejectedValue(
      new Error("temporarily unavailable"),
    );

    render(<Layout authState={authenticated} />);

    expect(await screen.findByTestId("chat-surface")).toBeInTheDocument();
    await waitFor(() => expect(api.isRemoteOnlyMode).toHaveBeenCalled());
  });
});
