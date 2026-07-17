import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgenteraConnectionClaimPublicState,
  AgenteraConnectionMode,
  AgenteraProfileClaimPublicState,
} from "../../../../shared/agentera-runtime-access";
import HermesLogo from "../../components/common/HermesLogo";
import { useI18n } from "../../components/useI18n";

type ClaimState =
  | AgenteraProfileClaimPublicState
  | AgenteraConnectionClaimPublicState;

interface ProfileClaimProps {
  mode: AgenteraConnectionMode;
  claim: ClaimState | null;
  inspectionError?: boolean;
  onUseExisting: () => Promise<void>;
  onCreateNew: () => Promise<void>;
  onBindConnection: () => Promise<void>;
  onUseDifferentAccount: () => Promise<void>;
  onRetry: () => Promise<void>;
}

type Operation = "binding" | "creating" | "switching-account" | null;

function ProfileClaim({
  mode,
  claim,
  inspectionError = false,
  onUseExisting,
  onCreateNew,
  onBindConnection,
  onUseDifferentAccount,
  onRetry,
}: ProfileClaimProps): React.JSX.Element {
  const { t } = useI18n();
  const [operation, setOperation] = useState<Operation>(null);
  const [operationError, setOperationError] = useState(false);
  const autoBindingKey = useRef<string | null>(null);
  const isLocal = mode === "local";
  const localClaim = isLocal
    ? (claim as AgenteraProfileClaimPublicState | null)
    : null;
  const connectionClaim = !isLocal
    ? (claim as AgenteraConnectionClaimPublicState | null)
    : null;

  const runOperation = useCallback(
    async (
      next: Exclude<Operation, null>,
      operationFn: () => Promise<void>,
    ): Promise<void> => {
      if (operation) return;
      setOperationError(false);
      setOperation(next);
      try {
        await operationFn();
      } catch {
        setOperationError(true);
      } finally {
        setOperation(null);
      }
    },
    [operation],
  );

  const shouldAutoBindLocal =
    localClaim?.status === "unbound" && !localClaim.meaningfulData;
  const shouldAutoBindConnection = connectionClaim?.status === "unbound";

  useEffect(() => {
    const key = shouldAutoBindLocal
      ? "local"
      : shouldAutoBindConnection
        ? `connection:${mode}`
        : null;
    if (!key || autoBindingKey.current === key) return;
    autoBindingKey.current = key;
    void runOperation(
      "binding",
      shouldAutoBindLocal ? onUseExisting : onBindConnection,
    );
  }, [
    mode,
    onBindConnection,
    onUseExisting,
    runOperation,
    shouldAutoBindConnection,
    shouldAutoBindLocal,
  ]);

  const anotherLocalOwner =
    localClaim?.status === "owned" && !localClaim.isCurrentOwner;
  const anotherConnectionOwner =
    connectionClaim?.status === "owned" && !connectionClaim.isCurrentOwner;
  const meaningfulUnbound =
    localClaim?.status === "unbound" && localClaim.meaningfulData;

  let titleKey = "auth.profile.checkingTitle";
  let descriptionKey = "auth.profile.checkingDescription";
  if (inspectionError || operationError) {
    titleKey = "auth.profile.failedTitle";
    descriptionKey = "auth.profile.failedDescription";
  } else if (anotherLocalOwner) {
    titleKey = "auth.profile.otherOwnerTitle";
    descriptionKey = "auth.profile.otherOwnerDescription";
  } else if (anotherConnectionOwner) {
    titleKey = "auth.profile.remoteOtherOwnerTitle";
    descriptionKey = "auth.profile.remoteOtherOwnerDescription";
  } else if (meaningfulUnbound) {
    titleKey = "auth.profile.title";
    descriptionKey = "auth.profile.existingDescription";
  } else if (shouldAutoBindConnection) {
    titleKey = "auth.profile.connectionBindingTitle";
    descriptionKey = "auth.profile.connectionBindingDescription";
  } else if (shouldAutoBindLocal) {
    titleKey = "auth.profile.emptyBindingTitle";
    descriptionKey = "auth.profile.emptyBindingDescription";
  }

  return (
    <main
      className="screen agentera-gate-screen"
      data-testid="screen-profile-claim"
      aria-labelledby="agentera-profile-claim-title"
    >
      <section className="agentera-gate-card agentera-profile-card">
        <div className="agentera-gate-brand" aria-label="AgentEra">
          <HermesLogo size={48} />
          <span>AgentEra</span>
        </div>
        <h1 id="agentera-profile-claim-title" className="agentera-gate-title">
          {t(titleKey)}
        </h1>
        <p className="agentera-gate-description">{t(descriptionKey)}</p>

        {(meaningfulUnbound || anotherLocalOwner) && !operationError && (
          <p className="agentera-profile-privacy">
            {t("auth.profile.noUpload")}
          </p>
        )}

        <div className="agentera-profile-actions" aria-live="polite">
          {meaningfulUnbound && !operationError && (
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void runOperation("binding", onUseExisting)}
                disabled={operation !== null}
                autoFocus
              >
                {operation === "binding"
                  ? t("auth.profile.binding")
                  : t("auth.profile.useExisting")}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void runOperation("creating", onCreateNew)}
                disabled={operation !== null}
              >
                {operation === "creating"
                  ? t("auth.profile.creating")
                  : t("auth.profile.createNew")}
              </button>
            </>
          )}

          {anotherLocalOwner && !operationError && (
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void runOperation("creating", onCreateNew)}
                disabled={operation !== null}
                autoFocus
              >
                {operation === "creating"
                  ? t("auth.profile.creating")
                  : t("auth.profile.createNew")}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  void runOperation("switching-account", onUseDifferentAccount)
                }
                disabled={operation !== null}
              >
                {t("auth.profile.differentAccount")}
              </button>
            </>
          )}

          {anotherConnectionOwner && !operationError && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                void runOperation("switching-account", onUseDifferentAccount)
              }
              disabled={operation !== null}
              autoFocus
            >
              {t("auth.profile.differentAccount")}
            </button>
          )}

          {(inspectionError || operationError) && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void runOperation("binding", onRetry)}
              disabled={operation !== null}
              autoFocus
            >
              {operation ? t("auth.profile.binding") : t("auth.profile.retry")}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}

export default ProfileClaim;
