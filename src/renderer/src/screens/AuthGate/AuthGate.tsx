import { useEffect, useRef, useState } from "react";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import HermesLogo from "../../components/common/HermesLogo";
import { useI18n } from "../../components/useI18n";

interface AuthGateProps {
  state: AgenteraAuthPublicState;
  onOpenBrowser: () => Promise<void>;
  onCancel: () => Promise<void>;
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
  onCancel,
  onRetry,
}: AuthGateProps): React.JSX.Element {
  const { t } = useI18n();
  const [pending, setPending] = useState<PendingAction>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const cancelRequested = useRef(false);
  const openBrowserRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const secureStorageUnavailable =
    state.status === "blocked" && state.reason === "secure_storage_unavailable";

  useEffect(() => {
    if (pending === "browser") {
      cancelRef.current?.focus();
      return;
    }
    if (secureStorageUnavailable || errorKey) {
      retryRef.current?.focus();
      return;
    }
    if (state.status !== "checking") openBrowserRef.current?.focus();
  }, [errorKey, pending, secureStorageUnavailable, state.status]);

  async function handleOpenBrowser(): Promise<void> {
    if (pending) return;
    cancelRequested.current = false;
    setErrorKey(null);
    setPending("browser");
    try {
      await onOpenBrowser();
    } catch {
      setErrorKey(
        cancelRequested.current
          ? "auth.gate.cancelled"
          : "auth.gate.loginFailed",
      );
    } finally {
      setPending(null);
    }
  }

  async function handleCancel(): Promise<void> {
    cancelRequested.current = true;
    await onCancel().catch(() => undefined);
  }

  async function handleRetry(): Promise<void> {
    if (pending) return;
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
      className="screen agentera-gate-screen"
      data-testid="screen-auth"
      aria-labelledby="agentera-auth-title"
    >
      <section className="agentera-gate-card">
        <div className="agentera-gate-brand" aria-label="AgentEra">
          <HermesLogo size={52} />
          <span>AgentEra</span>
        </div>
        <h1 id="agentera-auth-title" className="agentera-gate-title">
          {secureStorageUnavailable
            ? t("auth.gate.secureStorageTitle")
            : t("auth.gate.title")}
        </h1>
        <p className="agentera-gate-description">
          {secureStorageUnavailable
            ? t("auth.gate.secureStorageDescription")
            : t(stateMessageKey(state))}
        </p>
        <p className="agentera-gate-privacy">{t("auth.gate.browserNote")}</p>

        <div className="agentera-gate-actions" aria-live="polite">
          {!secureStorageUnavailable && (
            <button
              ref={openBrowserRef}
              type="button"
              className="btn btn-primary agentera-gate-primary"
              onClick={() => void handleOpenBrowser()}
              disabled={pending !== null || state.status === "checking"}
              autoFocus={state.status !== "checking"}
            >
              {pending === "browser"
                ? t("auth.gate.waitingForBrowser")
                : t("auth.gate.openBrowser")}
            </button>
          )}

          {pending === "browser" && (
            <button
              ref={cancelRef}
              type="button"
              className="btn btn-secondary"
              onClick={() => void handleCancel()}
            >
              {t("auth.gate.cancel")}
            </button>
          )}

          {(secureStorageUnavailable || errorKey) && pending !== "browser" && (
            <button
              ref={retryRef}
              type="button"
              className="btn btn-secondary"
              onClick={() => void handleRetry()}
              disabled={pending !== null}
              autoFocus={secureStorageUnavailable}
            >
              {pending === "retry"
                ? t("auth.gate.retrying")
                : t("auth.gate.retry")}
            </button>
          )}
        </div>

        {errorKey && (
          <p className="agentera-gate-error" role="alert">
            {t(errorKey)}
          </p>
        )}
      </section>
    </main>
  );
}

export default AuthGate;
