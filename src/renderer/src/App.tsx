import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "react-hot-toast";
import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  AgenteraConnectionClaimPublicState,
  AgenteraProfileClaimPublicState,
  AgenteraStartupPreflightPublicResult,
} from "../../shared/agentera-runtime-access";
import ErrorBoundary from "./components/ErrorBoundary";
import { FontProvider } from "./components/FontProvider";
import { ProfileModalProvider } from "./components/profile/ProfileModalProvider";
import { SettingsModalProvider } from "./components/settings/SettingsModalProvider";
import { ThemeProvider } from "./components/ThemeProvider";
import AuthGate from "./screens/AuthGate/AuthGate";
import Install from "./screens/Install/Install";
import Layout from "./screens/Layout/Layout";
import ProfileClaim from "./screens/ProfileClaim/ProfileClaim";
import SplashScreen from "./screens/SplashScreen/SplashScreen";
import { captureScreenView } from "./utils/analytics";

type Screen = "splash" | "auth" | "profile-claim" | "installing" | "main";

type OwnershipClaim =
  | AgenteraProfileClaimPublicState
  | AgenteraConnectionClaimPublicState;
type AuthorizedAuthState = Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
>;

const SPLASH_MIN_MS = 3000;

function hasProductAccess(
  state: AgenteraAuthPublicState,
): state is AuthorizedAuthState {
  return state.status === "authenticated" || state.status === "offline";
}

function isSameAuthorizedSession(
  previous: AgenteraAuthPublicState,
  next: AgenteraAuthPublicState,
): boolean {
  return (
    hasProductAccess(previous) &&
    hasProductAccess(next) &&
    previous.userId === next.userId &&
    previous.personalSpaceId === next.personalSpaceId &&
    previous.deviceId === next.deviceId
  );
}

function warmRuntimeAfterOwnership(
  preflight: AgenteraStartupPreflightPublicResult,
): void {
  if (preflight.postAuthTarget !== "main") return;
  if (preflight.connectionMode === "ssh") {
    void window.hermesAPI.startSshTunnel().catch(() => {
      console.warn("SSH tunnel did not start after ownership check.");
    });
    return;
  }
  if (preflight.connectionMode !== "local") return;

  // These calls may read active Runtime configuration, so they are warmed only
  // after the main process has confirmed the current owner's Profile binding.
  void Promise.race([
    Promise.all([
      window.hermesAPI.getConfigHealth().catch(() => null),
      window.hermesAPI.gatewayStatus().catch(() => null),
    ]),
    new Promise<void>((resolve) => setTimeout(resolve, 800)),
  ]);
}

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>("splash");
  const [connectionMode, setConnectionMode] = useState<
    "local" | "remote" | "ssh"
  >("local");
  const [authState, setAuthState] = useState<AgenteraAuthPublicState>({
    status: "checking",
  });
  const [ownershipClaim, setOwnershipClaim] = useState<OwnershipClaim | null>(
    null,
  );
  const [ownershipInspectionError, setOwnershipInspectionError] =
    useState(false);
  const [runtimeAccessReady, setRuntimeAccessReady] = useState(false);
  const [verifyWarning, setVerifyWarning] = useState(false);
  const [splashStatus, setSplashStatus] = useState<string | undefined>();
  const isMac = window.electron?.process?.platform === "darwin";

  const runIdRef = useRef(0);
  const routeIdRef = useRef(0);
  const preflightRef = useRef<AgenteraStartupPreflightPublicResult | null>(
    null,
  );
  const authStateRef = useRef<AgenteraAuthPublicState>(authState);
  const pendingSwitchToLocalRef = useRef(false);
  const forceAccountSelectionRef = useRef(false);
  const visibleScreen: Screen =
    screen !== "splash" && !hasProductAccess(authState)
      ? "auth"
      : screen === "main" && !runtimeAccessReady
        ? "profile-claim"
        : screen;

  const routeAfterAuthentication = useCallback(
    async (
      state: AgenteraAuthPublicState,
      initialPreflight: AgenteraStartupPreflightPublicResult,
    ): Promise<void> => {
      const routeId = ++routeIdRef.current;
      authStateRef.current = state;
      setAuthState(state);
      setOwnershipClaim(null);
      setOwnershipInspectionError(false);
      setRuntimeAccessReady(false);

      if (!hasProductAccess(state)) {
        setScreen("auth");
        return;
      }

      let preflight = initialPreflight;
      if (pendingSwitchToLocalRef.current) {
        pendingSwitchToLocalRef.current = false;
        if (preflight.connectionMode !== "local") {
          try {
            await window.agenteraRuntimeAccess.switchToLocal();
            preflight =
              await window.agenteraRuntimeAccess.runStartupPreflight();
          } catch {
            // Keep the authenticated user on the existing connection. The
            // ownership gate below still prevents mounting somebody else's
            // context, and the splash action can be retried on the next pass.
          }
        }
      }
      if (routeId !== routeIdRef.current) return;

      preflightRef.current = preflight;
      setConnectionMode(preflight.connectionMode);
      setVerifyWarning(preflight.verifyWarning);

      if (preflight.postAuthTarget === "welcome") {
        // A missing Runtime is not a user choice: authenticated users proceed
        // directly to the signed Seed bundled with the desktop app.
        setScreen("installing");
        return;
      }

      setScreen("profile-claim");
      try {
        const claim =
          preflight.connectionMode === "local"
            ? await window.agenteraRuntimeAccess.inspectActiveProfile()
            : await window.agenteraRuntimeAccess.inspectCurrentConnection();
        if (routeId !== routeIdRef.current) return;
        if (claim.status === "owned" && claim.isCurrentOwner) {
          warmRuntimeAfterOwnership(preflight);
          setRuntimeAccessReady(true);
          // Provider/model selection is an in-desktop choice. Normalize the
          // retired `setup` target from older installs to the main desktop.
          setScreen("main");
          return;
        }
        setOwnershipClaim(claim);
      } catch {
        if (routeId !== routeIdRef.current) return;
        setOwnershipInspectionError(true);
      }
    },
    [],
  );

  const runInstallCheck = useCallback(async (): Promise<void> => {
    const myRun = ++runIdRef.current;
    ++routeIdRef.current;
    preflightRef.current = null;
    const startedAt = Date.now();
    setSplashStatus("Checking connection…");

    let preflight: AgenteraStartupPreflightPublicResult = {
      connectionMode: "local",
      postAuthTarget: "welcome",
      verifyWarning: false,
    };
    let nextAuthState: AgenteraAuthPublicState = {
      status: "unauthenticated",
      reason: "sign_in_required",
    };

    try {
      preflight = await window.agenteraRuntimeAccess.runStartupPreflight();
      if (myRun !== runIdRef.current) return;
      setConnectionMode(preflight.connectionMode);
      setSplashStatus(
        preflight.connectionMode === "local"
          ? "Checking local install…"
          : preflight.connectionMode === "ssh"
            ? "Checking SSH connection…"
            : "Checking remote connection…",
      );
    } catch {
      // A failed readiness probe must not bypass product authentication. The
      // safe fallback is the authenticated welcome/install path.
    }

    try {
      nextAuthState = await window.agenteraAuth.getState();
    } catch {
      nextAuthState = {
        status: "blocked",
        reason: "secure_storage_unavailable",
      };
    }

    if (myRun !== runIdRef.current) return;
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - startedAt));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (myRun !== runIdRef.current) return;

    setSplashStatus(undefined);
    preflightRef.current = preflight;
    setVerifyWarning(preflight.verifyWarning);
    await routeAfterAuthentication(nextAuthState, preflight);
  }, [routeAfterAuthentication]);

  useEffect(() => {
    return window.agenteraAuth.onStateChanged((state) => {
      const previous = authStateRef.current;
      authStateRef.current = state;
      setAuthState(state);
      const preflight = preflightRef.current;
      if (preflight && !isSameAuthorizedSession(previous, state)) {
        void routeAfterAuthentication(state, preflight);
      }
    });
  }, [routeAfterAuthentication]);

  useEffect(() => {
    const startupRuns = runIdRef;
    const ownershipRoutes = routeIdRef;
    void runInstallCheck();
    return () => {
      ++startupRuns.current;
      ++ownershipRoutes.current;
    };
  }, [runInstallCheck]);

  useEffect(() => {
    captureScreenView(visibleScreen);
  }, [visibleScreen]);

  const handleSplashFinished = useCallback(() => {
    // The preflight and three-second minimum drive the transition.
  }, []);

  async function handleOpenBrowser(): Promise<void> {
    const forceAccountSelection = forceAccountSelectionRef.current;
    await window.agenteraAuth.startLogin(
      forceAccountSelection ? { forceAccountSelection: true } : undefined,
    );
    forceAccountSelectionRef.current = false;
  }

  async function handleRetryAuth(): Promise<void> {
    const state = await window.agenteraAuth.retryOnline();
    authStateRef.current = state;
    setAuthState(state);
    const preflight = preflightRef.current;
    if (preflight) await routeAfterAuthentication(state, preflight);
  }

  async function handleUseDifferentAccount(): Promise<void> {
    forceAccountSelectionRef.current = true;
    await window.agenteraAuth.logout();
    const state: AgenteraAuthPublicState = {
      status: "unauthenticated",
      reason: "sign_in_required",
    };
    authStateRef.current = state;
    setAuthState(state);
    setOwnershipClaim(null);
    setRuntimeAccessReady(false);
    setScreen("auth");
  }

  async function operationSessionIsStillCurrent(
    startedWith: AgenteraAuthPublicState,
  ): Promise<boolean> {
    const current = authStateRef.current;
    if (isSameAuthorizedSession(startedWith, current)) return true;
    const preflight = preflightRef.current;
    if (preflight) {
      await routeAfterAuthentication(current, preflight);
    } else {
      setScreen("auth");
    }
    return false;
  }

  async function handleUseExistingProfile(): Promise<void> {
    const startedWith = authStateRef.current;
    await window.agenteraRuntimeAccess.bindActiveProfile();
    if (!(await operationSessionIsStillCurrent(startedWith))) return;
    const preflight = preflightRef.current;
    if (preflight) warmRuntimeAfterOwnership(preflight);
    setOwnershipClaim(null);
    setRuntimeAccessReady(true);
    setScreen("main");
  }

  async function handleCreateFreshProfile(): Promise<void> {
    const startedWith = authStateRef.current;
    await window.agenteraRuntimeAccess.createFreshProfile(
      `AgentEra Space ${Date.now().toString(36)}`,
    );
    if (!(await operationSessionIsStillCurrent(startedWith))) return;
    const currentPreflight = preflightRef.current;
    if (currentPreflight) {
      preflightRef.current = {
        ...currentPreflight,
        connectionMode: "local",
        postAuthTarget: "main",
      };
    }
    setConnectionMode("local");
    setOwnershipClaim(null);
    setRuntimeAccessReady(true);
    setScreen("main");
  }

  async function handleBindConnection(): Promise<void> {
    const startedWith = authStateRef.current;
    await window.agenteraRuntimeAccess.bindCurrentConnection();
    if (!(await operationSessionIsStillCurrent(startedWith))) return;
    const preflight = preflightRef.current;
    if (preflight) warmRuntimeAfterOwnership(preflight);
    setOwnershipClaim(null);
    setRuntimeAccessReady(true);
    setScreen("main");
  }

  async function handleRetryOwnership(): Promise<void> {
    const preflight = preflightRef.current;
    if (!preflight) {
      setScreen("splash");
      await runInstallCheck();
      return;
    }
    await routeAfterAuthentication(authStateRef.current, preflight);
  }

  const handleInstallComplete = useCallback((): void => {
    const nextPreflight: AgenteraStartupPreflightPublicResult = {
      connectionMode: "local",
      postAuthTarget: "main",
      verifyWarning: false,
    };
    preflightRef.current = nextPreflight;
    setConnectionMode("local");
    void routeAfterAuthentication(authStateRef.current, nextPreflight);
  }, [routeAfterAuthentication]);

  function handleSwitchToLocal(): void {
    pendingSwitchToLocalRef.current = true;
    setSplashStatus("Local mode will open after sign-in…");
    const preflight = preflightRef.current;
    if (preflight && hasProductAccess(authStateRef.current)) {
      void routeAfterAuthentication(authStateRef.current, preflight);
    }
  }

  function handleVerifyReinstall(): void {
    setVerifyWarning(false);
    setRuntimeAccessReady(false);
    setScreen("installing");
  }

  function handleDismissVerifyWarning(): void {
    setVerifyWarning(false);
  }

  function renderScreen(): React.JSX.Element {
    switch (visibleScreen) {
      case "splash":
        return (
          <SplashScreen
            onFinished={handleSplashFinished}
            status={splashStatus}
            onSwitchToLocal={
              connectionMode !== "local" ? handleSwitchToLocal : undefined
            }
          />
        );
      case "auth":
        return (
          <AuthGate
            state={authState}
            onOpenBrowser={handleOpenBrowser}
            onCancel={() => window.agenteraAuth.cancelLogin()}
            onRetry={handleRetryAuth}
          />
        );
      case "profile-claim":
        return (
          <ProfileClaim
            mode={connectionMode}
            claim={ownershipClaim}
            inspectionError={ownershipInspectionError}
            onUseExisting={handleUseExistingProfile}
            onCreateNew={handleCreateFreshProfile}
            onBindConnection={handleBindConnection}
            onUseDifferentAccount={handleUseDifferentAccount}
            onRetry={handleRetryOwnership}
          />
        );
      case "installing":
        return <Install onComplete={handleInstallComplete} />;
      case "main":
        return (
          <Layout
            authState={authState as AuthorizedAuthState}
            verifyWarning={verifyWarning}
            onReinstall={handleVerifyReinstall}
            onDismissVerifyWarning={handleDismissVerifyWarning}
          />
        );
    }
  }

  return (
    <ThemeProvider>
      <FontProvider>
        <ProfileModalProvider>
          <SettingsModalProvider>
            <ErrorBoundary>
              <div className={`app${isMac ? " is-mac" : ""}`}>
                {isMac && <div className="drag-region" />}
                <div className="app-content">{renderScreen()}</div>
              </div>
              <Toaster
                position="bottom-right"
                reverseOrder={false}
                toastOptions={{
                  style: {
                    background: "var(--bg-elevated)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-bright)",
                    fontSize: 13,
                  },
                }}
              />
            </ErrorBoundary>
          </SettingsModalProvider>
        </ProfileModalProvider>
      </FontProvider>
    </ThemeProvider>
  );
}

export default App;
