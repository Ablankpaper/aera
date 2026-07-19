import { useEffect, useState, useRef } from "react";
import { Copy } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";

interface InstallProgress {
  step: number;
  totalSteps: number;
  title: string;
  detail: string;
  log: string;
}

interface InstallProps {
  onComplete: () => void;
}

function Install({ onComplete }: InstallProps): React.JSX.Element {
  const { t } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState<InstallProgress>({
    step: 0,
    totalSteps: 5,
    title: t("install.preparingRuntime"),
    detail: t("install.verifyingPackagedRuntime"),
    log: "",
  });
  const [failed, setFailed] = useState<string | null>(null);
  const [repairAction, setRepairAction] = useState<
    "reinstall-desktop" | "free-disk-space" | "retry" | null
  >(null);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const onCompleteRef = useRef(onComplete);
  const translationRef = useRef(t);

  useEffect(() => {
    onCompleteRef.current = onComplete;
    translationRef.current = t;
  }, [onComplete, t]);

  // The packaged Runtime is part of the product. Once authentication has
  // succeeded there is no source/path decision for the user: verify, prepare,
  // and continue automatically from local installer bytes.
  useEffect(() => {
    let isMounted = true;
    const cleanup = window.hermesAPI.onInstallProgress((p) => {
      if (isMounted) setProgress(p);
    });

    window.hermesAPI
      .startInstall()
      .then((result) => {
        if (!isMounted) return;
        if (result.success) {
          onCompleteRef.current();
        } else {
          setRepairAction(result.action ?? "retry");
          setFailed(
            result.action === "reinstall-desktop"
              ? translationRef.current("install.packagedRuntimeInvalid")
              : result.action === "free-disk-space"
                ? translationRef.current("install.insufficientDiskSpace")
                : result.error ||
                  translationRef.current("install.preparationFailedHint"),
          );
        }
      })
      .catch((err) => {
        if (!isMounted) return;
        setRepairAction("retry");
        const message =
          typeof err === "object" &&
          err !== null &&
          "message" in err &&
          typeof err.message === "string" &&
          err.message.trim()
            ? err.message
            : translationRef.current("install.preparationFailedHint");
        setFailed(message);
      });

    return () => {
      isMounted = false;
      cleanup();
    };
  }, [attempt]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [progress.log]);

  function handleCopyLogs(): void {
    const text = `Installation Error:\n${failed}\n\n--- Full Log ---\n${progress.log}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const percent =
    progress.totalSteps > 0
      ? Math.round((progress.step / progress.totalSteps) * 100)
      : 0;

  return (
    <div className="screen install-screen">
      <h1 className="install-title">
        {failed
          ? t("install.installationFailed")
          : t("install.preparingRuntime")}
      </h1>

      <div className="install-progress-container">
        <div className="install-progress-bar">
          <div
            className={`install-progress-fill ${failed ? "install-progress-fill--error" : ""}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="install-percent">{percent}%</div>
      </div>

      {failed && (
        <div className="install-error-banner">
          <p className="install-error-text">{failed}</p>
          <div className="install-error-actions">
            {repairAction !== "reinstall-desktop" && (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setFailed(null);
                  setRepairAction(null);
                  setProgress({
                    step: 0,
                    totalSteps: 5,
                    title: t("install.preparingRuntime"),
                    detail: t("install.verifyingPackagedRuntime"),
                    log: "",
                  });
                  setAttempt((value) => value + 1);
                }}
              >
                {t("install.retryPreparation")}
              </button>
            )}
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleCopyLogs}
            >
              <Copy size={13} />
              {copied ? t("install.copied") : t("install.copyLogs")}
            </button>
          </div>
        </div>
      )}

      {!failed && (
        <div className="install-step-info">
          <div className="install-step-title">
            {t("install.stepLabel", {
              step: progress.step,
              total: progress.totalSteps,
              title: progress.title,
            })}
          </div>
          <div className="install-step-detail">{progress.detail}</div>
        </div>
      )}

      <div className="install-log" ref={logRef}>
        {progress.log || t("install.waitingToStart")}
      </div>
    </div>
  );
}

export default Install;
