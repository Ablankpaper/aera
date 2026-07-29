import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  AgenteraConnectionMode,
  AgenteraPostAuthTarget,
} from "../../shared/agentera-runtime-access";
import App from "./App";

vi.mock("./components/useI18n", () => {
  const t = (key: string): string => key;
  return {
    useI18n: () => ({
      locale: "en",
      setLocale: vi.fn(),
      t,
    }),
  };
});
vi.mock("./components/ThemeProvider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/FontProvider", () => ({
  FontProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/profile/ProfileModalProvider", () => ({
  ProfileModalProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/settings/SettingsModalProvider", () => ({
  SettingsModalProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/ErrorBoundary", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("react-hot-toast", () => ({ Toaster: () => null }));
vi.mock("./utils/analytics", () => ({ captureScreenView: vi.fn() }));
vi.mock("./components/common/HermesLogo", () => ({
  default: () => <span aria-label="AgentEra logo" />,
}));
vi.mock("./components/WorkspaceInvitationGate", () => ({
  default: ({ authState }: { authState: AgenteraAuthPublicState }) => (
    <div data-testid="workspace-invitation-gate">{authState.status}</div>
  ),
}));
vi.mock("./components/OrganizationInvitationGate", () => ({
  default: ({ authState }: { authState: AgenteraAuthPublicState }) => (
    <div data-testid="organization-invitation-gate">{authState.status}</div>
  ),
}));
vi.mock("./screens/SplashScreen/SplashScreen", () => ({
  default: ({ onSwitchToLocal }: { onSwitchToLocal?: () => void }) => (
    <div data-testid="screen-splash">
      splash
      {onSwitchToLocal && (
        <button onClick={onSwitchToLocal}>switch-local</button>
      )}
    </div>
  ),
}));
vi.mock("./screens/Install/Install", () => ({
  default: ({ onComplete }: { onComplete: () => void }) => (
    <button data-testid="screen-installing" onClick={onComplete}>
      installing
    </button>
  ),
}));
vi.mock("./screens/Setup/Setup", () => ({
  default: () => <div data-testid="screen-setup">setup</div>,
}));
vi.mock("./screens/Layout/Layout", () => ({
  default: () => <div data-testid="screen-main">main</div>,
}));

const authenticated: AgenteraAuthPublicState = {
  status: "authenticated",
  userId: "11111111-1111-4111-8111-111111111111",
  personalSpaceId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
  offlineExpiresAt: "2026-07-25T00:00:00.000Z",
  cloudAvailable: true,
};

const offline: AgenteraAuthPublicState = {
  ...authenticated,
  status: "offline",
  cloudAvailable: false,
};

type AuthListener = (state: AgenteraAuthPublicState) => void;
type TestMock = ReturnType<typeof vi.fn>;
type RuntimeMockName =
  | "probeInstallFiles"
  | "runStartupPreflight"
  | "resolveAccountProfile"
  | "inspectActiveProfile"
  | "bindActiveProfile"
  | "createFreshProfile"
  | "listUnboundProfiles"
  | "inspectCurrentConnection"
  | "bindCurrentConnection"
  | "switchToLocal";
type AuthMockName =
  | "getState"
  | "startLogin"
  | "restartLogin"
  | "cancelLogin"
  | "copyLoginLink"
  | "retryOnline"
  | "logout"
  | "onStateChanged";
type InstalledWindowMocks = {
  runtime: Record<RuntimeMockName, TestMock>;
  auth: Record<AuthMockName, TestMock>;
};
let authListener: AuthListener | undefined;

function installWindowMocks({
  target,
  mode = "local",
  authState = authenticated,
}: {
  target: AgenteraPostAuthTarget;
  mode?: AgenteraConnectionMode;
  authState?: AgenteraAuthPublicState;
}): InstalledWindowMocks {
  const runtime = {
    probeInstallFiles: vi.fn().mockResolvedValue({ installed: true }),
    runStartupPreflight: vi.fn().mockResolvedValue({
      connectionMode: mode,
      postAuthTarget: target,
      verifyWarning: false,
    }),
    resolveAccountProfile: vi.fn().mockResolvedValue({
      status: "bound",
      profileId: "agentera-space",
      runtimeProfileId: "44444444-4444-4444-8444-444444444444",
    }),
    inspectActiveProfile: vi.fn().mockResolvedValue({
      status: "owned",
      meaningfulData: true,
      isCurrentOwner: true,
      runtimeProfileId: "44444444-4444-4444-8444-444444444444",
    }),
    bindActiveProfile: vi.fn().mockResolvedValue({
      status: "bound",
      runtimeProfileId: "44444444-4444-4444-8444-444444444444",
    }),
    createFreshProfile: vi.fn().mockResolvedValue({
      status: "bound",
      profileId: "agentera-space",
      runtimeProfileId: "55555555-5555-4555-8555-555555555555",
    }),
    listUnboundProfiles: vi.fn().mockResolvedValue([]),
    inspectCurrentConnection: vi
      .fn()
      .mockResolvedValue({ status: "owned", isCurrentOwner: true }),
    bindCurrentConnection: vi.fn().mockResolvedValue({ status: "bound" }),
    switchToLocal: vi.fn().mockResolvedValue(undefined),
  };
  const auth = {
    getState: vi.fn().mockResolvedValue(authState),
    startLogin: vi.fn().mockResolvedValue(undefined),
    restartLogin: vi.fn().mockResolvedValue(undefined),
    cancelLogin: vi.fn().mockResolvedValue(undefined),
    copyLoginLink: vi.fn().mockResolvedValue(undefined),
    retryOnline: vi.fn().mockResolvedValue(authState),
    logout: vi.fn().mockResolvedValue(undefined),
    onStateChanged: vi.fn((listener: AuthListener) => {
      authListener = listener;
      return vi.fn();
    }),
  };

  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { process: { platform: "linux", versions: {} } },
  });
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: {
      getConfigHealth: vi.fn().mockResolvedValue(null),
      gatewayStatus: vi.fn().mockResolvedValue(null),
      startSshTunnel: vi.fn().mockResolvedValue(true),
    },
  });
  Object.defineProperty(window, "agenteraRuntimeAccess", {
    configurable: true,
    value: runtime,
  });
  Object.defineProperty(window, "agenteraAuth", {
    configurable: true,
    value: auth,
  });
  return { runtime, auth };
}

async function finishSplash(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
}

describe("AgentEra startup gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    authListener = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // @lat: [[agentera-app-authentication#Startup gate#Account-required routing]]
  it.each([
    { target: "welcome" as const },
    { target: "setup" as const },
    { target: "main" as const },
  ])(
    "keeps an unauthenticated $target launch behind the account gate",
    async ({ target }) => {
      const { runtime, auth } = installWindowMocks({
        target,
        authState: {
          status: "unauthenticated",
          reason: "sign_in_required",
        },
      });
      render(<App />);
      expect(screen.getByTestId("screen-splash")).toBeInTheDocument();

      await finishSplash();

      expect(screen.getByTestId("screen-auth")).toBeInTheDocument();
      expect(screen.queryByTestId("screen-installing")).toBeNull();
      expect(screen.queryByTestId("screen-main")).toBeNull();
      expect(auth.startLogin).not.toHaveBeenCalled();
      expect(runtime.resolveAccountProfile).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      target: "welcome" as const,
      state: { status: "blocked", reason: "device_revoked" } as const,
    },
    {
      target: "setup" as const,
      state: { status: "blocked", reason: "device_revoked" } as const,
    },
    {
      target: "main" as const,
      state: { status: "blocked", reason: "device_revoked" } as const,
    },
  ])(
    "keeps a blocked account on auth recovery after the splash for $target",
    async ({ state, target }) => {
      const { runtime } = installWindowMocks({
        target,
        authState: state,
      });
      render(<App />);
      expect(screen.getByTestId("screen-splash")).toBeInTheDocument();

      await finishSplash();

      expect(screen.getByTestId("screen-auth")).toBeInTheDocument();
      expect(runtime.resolveAccountProfile).not.toHaveBeenCalled();
    },
  );

  it.each([authenticated, offline])(
    "automatically prepares the bundled Runtime for a valid $status session",
    async (state) => {
      const { runtime } = installWindowMocks({
        target: "welcome",
        authState: state,
      });
      render(<App />);

      await finishSplash();

      expect(screen.getByTestId("screen-installing")).toBeInTheDocument();
      expect(screen.queryByTestId("screen-welcome")).toBeNull();
      expect(runtime.resolveAccountProfile).not.toHaveBeenCalled();
    },
  );

  it("fails closed if main-process account-space resolution remains unresolved", async () => {
    const { runtime } = installWindowMocks({
      target: "setup",
      authState: offline,
    });
    runtime.resolveAccountProfile.mockResolvedValue({
      status: "unbound",
      meaningfulData: true,
    });
    render(<App />);

    await finishSplash();

    expect(screen.getByTestId("screen-profile-claim")).toBeInTheDocument();
    expect(screen.queryByTestId("screen-setup")).toBeNull();
  });

  it("enters main only when the local Profile belongs to the current owner", async () => {
    const { runtime } = installWindowMocks({ target: "main" });
    render(<App />);

    await finishSplash();

    expect(screen.getByTestId("screen-main")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-invitation-gate")).toHaveTextContent(
      "authenticated",
    );
    expect(
      screen.getByTestId("organization-invitation-gate"),
    ).toHaveTextContent("authenticated");
    expect(runtime.resolveAccountProfile).toHaveBeenCalledOnce();
  });

  it("normalizes a legacy setup target to the main desktop", async () => {
    const { runtime } = installWindowMocks({ target: "setup" });
    render(<App />);

    await finishSplash();

    expect(screen.getByTestId("screen-main")).toBeInTheDocument();
    expect(screen.queryByTestId("screen-setup")).toBeNull();
    expect(runtime.resolveAccountProfile).toHaveBeenCalledOnce();
  });

  it.each(["remote", "ssh"] as const)(
    "enters main only when the %s connection belongs to the current owner",
    async (mode) => {
      const { runtime } = installWindowMocks({
        target: "main",
        mode,
        authState: mode === "ssh" ? offline : authenticated,
      });
      render(<App />);

      await finishSplash();

      expect(screen.getByTestId("screen-main")).toBeInTheDocument();
      expect(runtime.inspectCurrentConnection).toHaveBeenCalledOnce();
      expect(runtime.resolveAccountProfile).not.toHaveBeenCalled();
    },
  );

  it.each(["setup", "main"] as const)(
    "automatically resolves an isolated account space for a local %s target",
    async (target) => {
      const { runtime } = installWindowMocks({ target });
      render(<App />);

      await finishSplash();

      expect(runtime.resolveAccountProfile).toHaveBeenCalledOnce();
      expect(screen.getByTestId("screen-main")).toBeInTheDocument();
      expect(screen.queryByTestId("screen-profile-claim")).toBeNull();
    },
  );

  it("runs splash -> account login -> install -> isolated claim -> main", async () => {
    const { runtime, auth } = installWindowMocks({
      target: "welcome",
      authState: {
        status: "unauthenticated",
        reason: "sign_in_required",
      },
    });
    runtime.resolveAccountProfile.mockResolvedValue({
      status: "unbound",
      meaningfulData: false,
    });
    let finishBinding: (() => void) | undefined;
    runtime.bindActiveProfile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishBinding = () =>
            resolve({
              status: "bound",
              runtimeProfileId: "44444444-4444-4444-8444-444444444444",
            });
        }),
    );
    auth.startLogin.mockImplementation(async () => {
      authListener?.(authenticated);
    });
    render(<App />);

    expect(screen.getByTestId("screen-splash")).toBeInTheDocument();
    await finishSplash();
    expect(screen.getByTestId("screen-auth")).toBeInTheDocument();
    expect(auth.startLogin).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "auth.gate.openBrowser" }),
    );
    await act(async () => undefined);
    expect(auth.startLogin).toHaveBeenCalledOnce();
    expect(screen.getByTestId("screen-installing")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("screen-installing"));
    await act(async () => undefined);
    expect(screen.getByTestId("screen-profile-claim")).toBeInTheDocument();
    expect(screen.queryByTestId("screen-setup")).toBeNull();
    expect(runtime.bindActiveProfile).toHaveBeenCalledOnce();

    await act(async () => finishBinding?.());
    expect(screen.getByTestId("screen-main")).toBeInTheDocument();
    expect(screen.queryByTestId("screen-setup")).toBeNull();
  });

  it("creates a fresh non-inherited space and opens the desktop", async () => {
    const { runtime } = installWindowMocks({ target: "main" });
    runtime.resolveAccountProfile.mockResolvedValue({
      status: "unbound",
      meaningfulData: true,
    });
    render(<App />);
    await finishSplash();

    expect(runtime.createFreshProfile).not.toHaveBeenCalled();
    expect(runtime.bindActiveProfile).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "auth.profile.createNew" }),
    );
    await act(async () => undefined);

    expect(runtime.createFreshProfile).toHaveBeenCalledOnce();
    expect(runtime.createFreshProfile.mock.calls[0][0]).toMatch(
      /^AgentEra Space /,
    );
    expect(runtime.bindActiveProfile).not.toHaveBeenCalled();
    expect(screen.getByTestId("screen-main")).toBeInTheDocument();
    expect(screen.queryByTestId("screen-setup")).toBeNull();
  });

  it("queues a remote-to-local switch until account login succeeds", async () => {
    const { runtime, auth } = installWindowMocks({
      target: "main",
      mode: "remote",
      authState: {
        status: "unauthenticated",
        reason: "sign_in_required",
      },
    });
    runtime.runStartupPreflight
      .mockResolvedValueOnce({
        connectionMode: "remote",
        postAuthTarget: "main",
        verifyWarning: false,
      })
      .mockResolvedValueOnce({
        connectionMode: "local",
        postAuthTarget: "welcome",
        verifyWarning: false,
      });
    render(<App />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "switch-local" }));
    expect(runtime.switchToLocal).not.toHaveBeenCalled();

    await finishSplash();
    expect(screen.getByTestId("screen-auth")).toBeInTheDocument();
    expect(runtime.switchToLocal).not.toHaveBeenCalled();
    auth.startLogin.mockImplementation(async () => {
      authListener?.(authenticated);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "auth.gate.openBrowser" }),
    );
    await act(async () => undefined);

    expect(runtime.switchToLocal).toHaveBeenCalledOnce();
    expect(screen.getByTestId("screen-installing")).toBeInTheDocument();
    expect(auth.startLogin).toHaveBeenCalledOnce();
  });

  it("does not interrupt an in-progress screen for a same-owner session refresh", async () => {
    installWindowMocks({ target: "welcome", authState: authenticated });
    render(<App />);
    await finishSplash();

    expect(screen.getByTestId("screen-installing")).toBeInTheDocument();

    await act(async () => authListener?.({ ...authenticated }));
    expect(screen.getByTestId("screen-installing")).toBeInTheDocument();
  });

  it("does not enter a Runtime screen when authorization is revoked during Profile creation", async () => {
    const { runtime } = installWindowMocks({ target: "main" });
    runtime.resolveAccountProfile.mockResolvedValue({
      status: "unbound",
      meaningfulData: true,
    });
    let finishCreation: (() => void) | undefined;
    runtime.createFreshProfile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCreation = () =>
            resolve({
              status: "bound",
              profileId: "agentera-space",
              runtimeProfileId: "55555555-5555-4555-8555-555555555555",
            });
        }),
    );
    render(<App />);
    await finishSplash();

    fireEvent.click(
      screen.getByRole("button", { name: "auth.profile.createNew" }),
    );
    await act(async () =>
      authListener?.({ status: "blocked", reason: "device_revoked" }),
    );
    expect(screen.getByTestId("screen-auth")).toBeInTheDocument();

    await act(async () => finishCreation?.());
    expect(screen.getByTestId("screen-auth")).toBeInTheDocument();
    expect(screen.queryByTestId("screen-setup")).toBeNull();
    expect(screen.queryByTestId("screen-main")).toBeNull();
  });

  it("forces browser account selection for another owner's remote connection", async () => {
    const { runtime, auth } = installWindowMocks({
      target: "main",
      mode: "remote",
    });
    runtime.inspectCurrentConnection.mockResolvedValue({
      status: "owned",
      isCurrentOwner: false,
    });
    render(<App />);
    await finishSplash();

    fireEvent.click(
      screen.getByRole("button", { name: "auth.profile.differentAccount" }),
    );
    await act(async () => undefined);
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(screen.getByTestId("screen-auth")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "auth.gate.openBrowser" }),
    );
    await act(async () => undefined);
    expect(auth.startLogin).toHaveBeenCalledWith({
      forceAccountSelection: true,
    });
  });
});
