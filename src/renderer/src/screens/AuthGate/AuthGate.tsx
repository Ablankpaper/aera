import { useEffect, useRef, useState } from "react";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import Aila3DModel from "./Aila3DModel";
import { useI18n } from "../../components/useI18n";

interface AuthGateProps {
  state: AgenteraAuthPublicState;
  onOpenBrowser: () => Promise<void>;
  onCopyLoginLink: () => Promise<void>;
  onRestartLogin: () => Promise<void>;
  onRetry: () => Promise<void>;
}

type PendingAction = "browser" | "retry" | null;

function stateMessageKey(state: AgenteraAuthPublicState): string {
  switch (state.status) {
    case "checking":
    case "authenticated":
    case "offline":
      return "auth.gate.checking";
    case "unauthenticated":
    case "blocked":
      return `auth.gate.reasons.${state.reason ?? "sign_in_required"}`;
  }
}

function AuthGate({
  state,
  onOpenBrowser,
  onCopyLoginLink,
  onRestartLogin,
  onRetry,
}: AuthGateProps): React.JSX.Element {
  const { t } = useI18n();
  const [pending, setPending] = useState<PendingAction>(null);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const loginRequestRef = useRef(0);
  const openBrowserRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const secureStorageUnavailable =
    state.status === "blocked" && state.reason === "secure_storage_unavailable";
  const waitingForBrowser = pending === "browser";
  const showStateMessage =
    secureStorageUnavailable ||
    state.status === "blocked" ||
    (state.status === "unauthenticated" &&
      state.reason !== undefined &&
      state.reason !== "sign_in_required");

  useEffect(() => {
    if (waitingForBrowser) return;
    if (secureStorageUnavailable) {
      retryRef.current?.focus({ preventScroll: true });
      return;
    }
    if (state.status !== "checking") {
      openBrowserRef.current?.focus({ preventScroll: true });
    }
  }, [errorKey, secureStorageUnavailable, state.status, waitingForBrowser]);

  async function handleOpenBrowser(): Promise<void> {
    if (pending) return;
    const requestId = ++loginRequestRef.current;
    setErrorKey(null);
    setCopied(false);
    setPending("browser");
    try {
      await onOpenBrowser();
    } catch {
      if (requestId !== loginRequestRef.current) return;
      setErrorKey("auth.gate.loginFailed");
    } finally {
      if (requestId === loginRequestRef.current) setPending(null);
    }
  }

  async function handleCopyLoginLink(): Promise<void> {
    if (!waitingForBrowser || copying) return;
    setCopying(true);
    setErrorKey(null);
    try {
      await onCopyLoginLink();
      setCopied(true);
    } catch {
      setCopied(false);
      setErrorKey("auth.gate.copyFailed");
    } finally {
      setCopying(false);
    }
  }

  async function handleRestartLogin(): Promise<void> {
    if (!waitingForBrowser) return;
    // Invalidate the original startLogin() handler before the main process
    // cancels it. Its expected rejection must not clear this fresh waiting
    // state or show a stale cancellation error.
    const requestId = ++loginRequestRef.current;
    setErrorKey(null);
    setCopied(false);
    try {
      await onRestartLogin();
    } catch {
      if (requestId !== loginRequestRef.current) return;
      setErrorKey("auth.gate.restartFailed");
    } finally {
      if (requestId === loginRequestRef.current) setPending(null);
    }
  }

  async function handleRetry(): Promise<void> {
    if (pending) return;
    ++loginRequestRef.current;
    setErrorKey(null);
    setPending("retry");
    try {
      await onRetry();
    } catch {
      setErrorKey("auth.gate.retryFailed");
    } finally {
      setPending(null);
    }
  }

  return (
    <main
      className="screen agentera-login-screen"
      data-testid="screen-auth"
      aria-labelledby="agentera-auth-title"
    >
      <section className="agentera-login-card">
        <div className="agentera-login-model">
          <Aila3DModel />
        </div>
        <div className="agentera-login-copy">
          <h1 id="agentera-auth-title" className="agentera-login-title">
            {secureStorageUnavailable
              ? t("auth.gate.secureStorageTitle")
              : t("auth.gate.slogan")}
          </h1>
          {showStateMessage ? (
            <p className="agentera-login-description">
              {secureStorageUnavailable
                ? t("auth.gate.secureStorageDescription")
                : t(stateMessageKey(state))}
            </p>
          ) : (
            <p className="sr-only">
              {t(stateMessageKey(state))} {t("auth.gate.browserNote")}
            </p>
          )}

          <div className="agentera-login-actions" aria-live="polite">
            {!secureStorageUnavailable && (
              <button
                ref={openBrowserRef}
                type="button"
                className="btn agentera-login-primary agentera-gate-primary"
                onClick={() => void handleOpenBrowser()}
                disabled={pending !== null || state.status === "checking"}
                aria-busy={waitingForBrowser}
              >
                {waitingForBrowser ? (
                  <>
                    <span
                      className="agentera-login-spinner"
                      aria-hidden="true"
                    />
                    {t("auth.gate.loggingIn")}
                  </>
                ) : state.status === "checking" ? (
                  t("auth.gate.checking")
                ) : (
                  t("auth.gate.openBrowser")
                )}
              </button>
            )}

            {secureStorageUnavailable && !waitingForBrowser && (
              <button
                ref={retryRef}
                type="button"
                className="btn agentera-login-secondary"
                onClick={() => void handleRetry()}
                disabled={pending !== null}
              >
                {pending === "retry"
                  ? t("auth.gate.retrying")
                  : t("auth.gate.retry")}
              </button>
            )}
          </div>

          {waitingForBrowser && (
            <div
              className="agentera-login-browser-help"
              data-testid="browser-login-waiting"
            >
              <p className="agentera-login-browser-help-title">
                {t("auth.gate.browserNotOpened")}
              </p>
              <p className="agentera-login-browser-help-description">
                {t("auth.gate.copyLoginHint")}
              </p>
              <div className="agentera-login-browser-help-actions">
                <button
                  type="button"
                  className="btn agentera-login-browser-help-button"
                  onClick={() => void handleCopyLoginLink()}
                  disabled={copying}
                >
                  {copying
                    ? t("auth.gate.copyingLoginLink")
                    : copied
                      ? t("auth.gate.copiedLoginLink")
                      : t("auth.gate.copyLoginLink")}
                </button>
                <button
                  type="button"
                  className="btn agentera-login-browser-help-button"
                  onClick={() => void handleRestartLogin()}
                >
                  {t("auth.gate.restartLogin")}
                </button>
              </div>
            </div>
          )}

          {errorKey && (
            <p className="agentera-login-error" role="alert">
              {t(errorKey)}
            </p>
          )}
        </div>
      </section>

      <footer className="agentera-login-footer">
        <span className="agentera-login-footer-link">
          {t("auth.gate.privacy")}
        </span>
        <span className="agentera-login-footer-link">
          {t("auth.gate.terms")}
        </span>
      </footer>
    </main>
  );
}

export default AuthGate;
