import {
  Bug,
  Calendar,
  Cpu,
  Download,
  FolderOpen,
  Loader,
  Monitor,
  RefreshCw,
  RotateCw,
  Stethoscope,
} from "lucide-react";
import { useI18n } from "../useI18n";
import agentEraIcon from "../../assets/iconv2.png";
import pythonLogo from "../../assets/logos/python.svg";
import openaiLogo from "../../assets/logos/openai.svg";
import { ConfigHealth } from "../../screens/Settings/ConfigHealth";
import { useSettings } from "./SettingsDataContext";
import RuntimeDistributionCard from "./RuntimeDistributionCard";
import {
  desktopUpdateFeedback,
  desktopUpdateStageKey,
} from "./desktop-update-feedback";
import type { DesktopUpdateStageV2 } from "../../../../shared/desktop-update";

export { desktopUpdateFeedback } from "./desktop-update-feedback";

/**
 * About & Updates. Two clearly-separated cards for the two distinct update
 * channels: the **Aera Runtime** (Python engine) and **Aera** (this
 * Electron app). They ship independently, so each owns its own update action.
 */
export default function AboutPane(): React.JSX.Element {
  const { t } = useI18n();
  const {
    hermesHome,
    hermesVersion,
    appVersion,
    parsedVersion,
    doctorOutput,
    doctorRunning,
    updating,
    updateResult,
    updateResultType,
    autoUpgradeEnabled,
    autoUpgradeSaved,
    dumpOutput,
    dumpRunning,
    setDumpOutput,
    setDumpRunning,
    handleUpdateHermes,
    handleDoctor,
    handleAutoUpgradeChange,
    desktopUpdateState,
    desktopUpdateVersion,
    desktopUpdatePercent,
    desktopUpdateError,
    desktopUpdateStageEvent,
    checkDesktopUpdate,
    handleDesktopUpdate,
  } = useSettings();

  const engineHasUpdate = !!parsedVersion?.updateInfo;
  const loading = hermesVersion === null;

  return (
    <div className="settings-modal-pane">
      <ConfigHealth />

      {/* ── Aera Runtime (engine) ─────────────────────────── */}
      <RuntimeDistributionCard
        onExternalUpdate={handleUpdateHermes}
        externalUpdating={updating}
        externalUpdateAvailable={engineHasUpdate}
      >
        <div className="settings-meta-grid settings-runtime-details">
          <Meta
            label={t("common.engine")}
            loading={loading}
            icon={<Cpu size={13} />}
          >
            {parsedVersion
              ? `v${parsedVersion.version}`
              : t("settings.notDetected")}
          </Meta>
          <Meta
            label={t("common.released")}
            loading={loading}
            icon={<Calendar size={13} />}
          >
            {parsedVersion?.date || "—"}
          </Meta>
          <Meta
            label="Python"
            loading={loading}
            icon={<MetaLogo src={pythonLogo} alt="Python" />}
          >
            {parsedVersion?.python || "—"}
          </Meta>
          <Meta
            label="OpenAI SDK"
            loading={loading}
            icon={<MetaLogo src={openaiLogo} alt="OpenAI" />}
          >
            {parsedVersion?.sdk || "—"}
          </Meta>
        </div>

        <div className="settings-meta-path">
          <span className="settings-meta-label">
            <FolderOpen size={13} />
            {t("common.home")}
          </span>
          {!hermesHome ? (
            <span className="skeleton skeleton-md" />
          ) : (
            <code className="settings-meta-pathvalue">{hermesHome}</code>
          )}
        </div>

        <div className="settings-card-actions">
          <button
            className="btn btn-secondary"
            onClick={handleDoctor}
            disabled={doctorRunning}
          >
            <Stethoscope size={14} />
            {doctorRunning
              ? t("settings.runningDiagnosis")
              : t("settings.runDiagnosis")}
          </button>
          <button
            className="btn btn-secondary"
            onClick={async () => {
              setDumpRunning(true);
              setDumpOutput(null);
              const output = await window.hermesAPI.runHermesDump();
              setDumpOutput(output);
              setDumpRunning(false);
            }}
            disabled={dumpRunning}
          >
            <Bug size={14} />
            {dumpRunning ? t("settings.running") : t("settings.debugDump")}
          </button>
        </div>

        {updateResult && (
          <div
            className={`settings-hermes-result ${updateResultType || "error"}`}
          >
            {updateResult}
          </div>
        )}
        {doctorOutput && (
          <pre className="settings-hermes-doctor">{doctorOutput}</pre>
        )}
        {dumpOutput && (
          <pre className="settings-hermes-doctor">{dumpOutput}</pre>
        )}
      </RuntimeDistributionCard>

      {/* ── Aera (this app) ────────────────────────── */}
      <section className="settings-card">
        <header className="settings-card-head">
          <span className="settings-card-icon">
            <img
              src={agentEraIcon}
              width={20}
              height={20}
              className="brand-logo"
              alt={t("settings.desktopTitle")}
            />
          </span>
          <div className="settings-card-headtext">
            <div className="settings-card-title">
              {t("settings.desktopTitle")}
            </div>
            <div className="settings-card-sub">
              {t("settings.desktopSubtitle")}
            </div>
          </div>
          {desktopUpdateState === "ready" ? (
            <span className="settings-card-badge is-update">
              {t("settings.statusUpdateReady")}
            </span>
          ) : desktopUpdateState === "available" ? (
            <span className="settings-card-badge is-update">
              {t("settings.statusUpdateAvailable")}
            </span>
          ) : desktopUpdateState === "uptodate" ? (
            <span className="settings-card-badge is-ok">
              {t("settings.statusUpToDate")}
            </span>
          ) : null}
        </header>

        <div className="settings-card-body">
          <div className="settings-meta-grid">
            <Meta
              label={t("common.desktop")}
              loading={!appVersion}
              icon={<Monitor size={13} />}
            >
              {t("settings.version", { version: appVersion })}
            </Meta>
          </div>

          <div className="settings-card-actions">
            <DesktopUpdateButton
              state={desktopUpdateState}
              version={desktopUpdateVersion}
              percent={desktopUpdatePercent}
              stageEvent={desktopUpdateStageEvent}
              onCheck={checkDesktopUpdate}
              onAct={handleDesktopUpdate}
            />
            {desktopUpdateState === "uptodate" && (
              <span className="settings-card-actions-note">
                {t("settings.onLatestVersion")}
              </span>
            )}
          </div>

          {desktopUpdateError && !desktopUpdateStageEvent && (
            <div className="settings-hermes-result error">
              {desktopUpdateError}
            </div>
          )}

          <div className="settings-toggle-row">
            <div className="settings-toggle-text">
              <div className="settings-toggle-title">
                {t("settings.autoUpgradeDesktop")}
                {autoUpgradeSaved && (
                  <span className="settings-saved">{t("settings.saved")}</span>
                )}
              </div>
              <div className="settings-field-hint">
                {t("settings.autoUpgradeDesktopHint")}
              </div>
            </div>
            <label className="tools-toggle">
              <input
                type="checkbox"
                checked={autoUpgradeEnabled}
                onChange={(e) => void handleAutoUpgradeChange(e.target.checked)}
              />
              <span className="tools-toggle-track" />
            </label>
          </div>
        </div>
      </section>
    </div>
  );
}

/** A labelled version/metadata cell with a leading icon. */
function Meta({
  label,
  loading,
  icon,
  children,
}: {
  label: string;
  loading?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="settings-meta">
      <span className="settings-meta-label">
        {icon}
        {label}
      </span>
      {loading ? (
        <span className="skeleton skeleton-sm" />
      ) : (
        <span className="settings-meta-value">{children}</span>
      )}
    </div>
  );
}

/** A brand logo (from assets/logos) tinted to the theme for use as a meta icon. */
function MetaLogo({
  src,
  alt,
}: {
  src: string;
  alt: string;
}): React.JSX.Element {
  return (
    <img
      src={src}
      width={13}
      height={13}
      alt={alt}
      className="brand-logo brand-logo--match-theme"
    />
  );
}

/** The desktop-app update action, driven by the live updater state machine. */
export function DesktopUpdateButton({
  state,
  version,
  percent,
  stageEvent,
  onCheck,
  onAct,
}: {
  state:
    | "available"
    | "downloading"
    | "ready"
    | "error"
    | "checking"
    | "uptodate"
    | null;
  version: string | null;
  percent: number | null;
  stageEvent?: DesktopUpdateStageV2 | null;
  onCheck: () => void;
  onAct: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const feedback = stageEvent ? desktopUpdateFeedback(stageEvent.code) : null;
  const rolledBack = stageEvent?.state === "rolled_back";

  const feedbackDetails =
    stageEvent &&
    (stageEvent.state === "failed" || stageEvent.state === "rolled_back") ? (
      <div
        className="settings-update-feedback"
        role="status"
        aria-live="polite"
      >
        <strong>
          {t(
            rolledBack
              ? "settings.updateRolledBack"
              : (feedback?.messageKey ?? "settings.updateUnknownFailure"),
          )}
        </strong>
        <span>{t(desktopUpdateStageKey(stageEvent.stage))}</span>
        {stageEvent.targetVersion && (
          <span>
            {t("settings.updateTargetVersion", {
              version: stageEvent.targetVersion,
            })}
          </span>
        )}
        <span>
          {t(
            rolledBack
              ? "settings.updateUseCurrentVersion"
              : (feedback?.actionKey ?? "settings.updateContactSupport"),
          )}
        </span>
        <code>{stageEvent.diagnosticId}</code>
      </div>
    ) : null;

  if (state === "downloading") {
    return (
      <>
        {feedbackDetails}
        <button className="btn btn-primary" disabled>
          <Loader size={14} className="settings-spin" />
          {t("common.downloading", { percent: percent ?? 0 })}
        </button>
      </>
    );
  }
  if (state === "ready") {
    return (
      <>
        {feedbackDetails}
        <button className="btn btn-primary" onClick={onAct}>
          <RotateCw size={14} />
          {t("common.restartToUpdate")}
        </button>
      </>
    );
  }
  if (state === "available") {
    return (
      <>
        {feedbackDetails}
        <button className="btn btn-primary" onClick={onAct}>
          <Download size={14} />
          {version
            ? t("common.updateAvailable", { version })
            : t("settings.downloadUpdate")}
        </button>
      </>
    );
  }
  if (state === "checking") {
    return (
      <>
        {feedbackDetails}
        <button className="btn btn-secondary" disabled>
          <Loader size={14} className="settings-spin" />
          {t("settings.checkingUpdates")}
        </button>
      </>
    );
  }
  // null, "uptodate", or "error" → offer a (re)check.
  return (
    <>
      {feedbackDetails}
      <button className="btn btn-secondary" onClick={onCheck}>
        <RefreshCw size={14} />
        {state === "error"
          ? t("settings.retry")
          : t("settings.checkForUpdates")}
      </button>
    </>
  );
}
