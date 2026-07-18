import { useEffect, useState, useRef } from "react";
import { ArrowRight, Copy } from "../../assets/icons";
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
  onFailed: (error: string) => void;
  onCancel: () => void;
}

function Install({
  onComplete,
  onFailed,
  onCancel,
}: InstallProps): React.JSX.Element {
  const { t } = useI18n();
  // Preparing the packaged Runtime remains an explicit post-login action.
  const [phase, setPhase] = useState<"confirm" | "running">("confirm");
  const [useExistingError, setUseExistingError] = useState<string | null>(null);
  // Set once the user adopts an existing install — the new location only
  // applies on the next launch, so we ask them to restart.
  const [adopted, setAdopted] = useState(false);
  const [progress, setProgress] = useState<InstallProgress>({
    step: 0,
    totalSteps: 5,
    title: t("install.preparingRuntime"),
    detail: t("install.verifyingPackagedRuntime"),
    log: "",
  });
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [repairAction, setRepairAction] = useState<
    "reinstall-desktop" | "free-disk-space" | "retry" | null
  >(null);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // The install itself runs only once the user confirms.
  useEffect(() => {
    if (phase !== "running") return;
    let isMounted = true;
    const cleanup = window.hermesAPI.onInstallProgress((p) => {
      if (isMounted) setProgress(p);
    });

    window.hermesAPI
      .startInstall()
      .then((result) => {
        if (!isMounted) return;
        if (result.success) {
          setDone(true);
        } else {
          setRepairAction(result.action ?? "retry");
          setFailed(
            result.action === "reinstall-desktop"
              ? t("install.packagedRuntimeInvalid")
              : result.action === "free-disk-space"
                ? t("install.insufficientDiskSpace")
                : result.error || t("install.preparationFailedHint"),
          );
        }
      })
      .catch((err) => {
        if (!isMounted) return;
        setRepairAction("retry");
        setFailed(err.message || t("install.preparationFailedHint"));
      });

    return () => {
      isMounted = false;
      cleanup();
    };
  }, [phase, t]);

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

  // "Use an existing installation": let the user point the app at a Hermes
  // install it didn't auto-detect. A valid pick is persisted; the app must
  // restart to adopt it (#272).
  async function handleUseExisting(): Promise<void> {
    setUseExistingError(null);
    const dir = await window.hermesAPI.selectFolder();
    if (!dir) return;
    const ok = await window.hermesAPI.validateHermesHome(dir);
    if (!ok) {
      setUseExistingError(t("install.useExistingInvalid"));
      return;
    }
    const saved = await window.hermesAPI.adoptHermesHome(dir);
    if (saved) {
      setAdopted(true);
    } else {
      // Lost a race (dir changed between validate and adopt).
      setUseExistingError(t("install.useExistingInvalid"));
    }
  }

  const percent =
    progress.totalSteps > 0
      ? Math.round((progress.step / progress.totalSteps) * 100)
      : 0;

  if (phase === "confirm") {
    // After adopting an existing install, the choice only applies on the
    // next launch — ask the user to restart.
    if (adopted) {
      return (
        <div className="screen install-screen">
          <h1 className="install-title">{t("install.confirmTitle")}</h1>
          <div className="install-confirm">
            <p className="install-confirm-state">
              {t("install.useExistingDone")}
            </p>
            <div className="install-confirm-actions">
              <button
                className="btn btn-primary"
                onClick={() => window.hermesAPI.quitApp()}
              >
                {t("install.useExistingQuitBtn")}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="screen install-screen">
        <h1 className="install-title">{t("install.confirmTitle")}</h1>

        <div className="install-confirm">
          <p className="install-confirm-state install-confirm-state--fresh">
            {t("install.confirmBundledRuntime")}
          </p>
          <p className="install-confirm-note">
            {t("install.confirmOfflinePreparation")}
          </p>

          <div className="install-confirm-actions">
            <button
              className="btn btn-primary"
              onClick={() => setPhase("running")}
            >
              {t("install.confirmPrepareBtn")}
            </button>
            <button className="btn btn-secondary" onClick={handleUseExisting}>
              {t("install.useExistingBtn")}
            </button>
            <button className="btn btn-secondary" onClick={onCancel}>
              {t("common.cancel")}
            </button>
          </div>
          <p className="install-confirm-hint">{t("install.useExistingHint")}</p>
          {useExistingError && (
            <p className="install-confirm-error">{useExistingError}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="screen install-screen">
      <h1 className="install-title">
        {done
          ? t("install.installationComplete")
          : failed
            ? t("install.installationFailed")
            : t("install.preparingRuntime")}
      </h1>

      <div className="install-progress-container">
        <div className="install-progress-bar">
          <div
            className={`install-progress-fill ${failed ? "install-progress-fill--error" : ""}`}
            style={{ width: `${done ? 100 : percent}%` }}
          />
        </div>
        <div className="install-percent">{done ? "100" : percent}%</div>
      </div>

      {failed && (
        <div className="install-error-banner">
          <p className="install-error-text">{failed}</p>
          <div className="install-error-actions">
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
                // Re-trigger install via parent
                onFailed(failed);
              }}
            >
              {repairAction === "reinstall-desktop"
                ? t("install.reinstallDesktop")
                : t("install.retryPreparation")}
            </button>
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

      {!done && !failed && (
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

      {done && (
        <div className="install-done">
          <button className="btn btn-primary" onClick={onComplete}>
            {t("install.continueToSetup")}
            <ArrowRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

export default Install;
