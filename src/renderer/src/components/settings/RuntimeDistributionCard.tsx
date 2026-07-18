import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Download,
  Loader,
  RefreshCw,
  RotateCw,
  Wrench,
} from "lucide-react";

import type {
  RuntimeDistributionPhase,
  RuntimeDistributionPublicState,
} from "../../../../shared/agentera-runtime-distribution";
import agentEraIcon from "../../assets/iconv2.png";
import { useI18n } from "../useI18n";
import { useRuntimeDistribution } from "./useRuntimeDistribution";

const STATUS_KEYS: Record<RuntimeDistributionPhase, string> = {
  missing: "missing",
  installing: "installing",
  current: "current",
  checking: "checking",
  "update-available": "updateAvailable",
  downloading: "downloading",
  "candidate-ready": "candidateReady",
  rollback: "rollback",
  "repair-required": "repairRequired",
  external: "external",
};

function formatBytes(value: number | null): string {
  if (value === null) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${Number.isInteger(amount) ? amount : amount.toFixed(1)} ${unit}`;
}

function badgeClass(phase: RuntimeDistributionPhase): string {
  if (phase === "current") return "is-ok";
  if (phase === "update-available" || phase === "candidate-ready") {
    return "is-update";
  }
  if (phase === "rollback" || phase === "repair-required") {
    return "is-error";
  }
  return "";
}

export interface RuntimeDistributionCardProps {
  children?: ReactNode;
  onExternalUpdate?: () => void | Promise<void>;
  externalUpdating?: boolean;
  externalUpdateAvailable?: boolean;
}

export default function RuntimeDistributionCard({
  children,
  onExternalUpdate,
  externalUpdating = false,
  externalUpdateAvailable = true,
}: RuntimeDistributionCardProps): React.JSX.Element {
  const { t } = useI18n();
  const {
    state,
    checkForUpdate,
    downloadConfirmed,
    cancelDownload,
    restartToApply,
    retryRepair,
  } = useRuntimeDistribution();
  const [confirmingDownload, setConfirmingDownload] = useState(false);
  const phase = state?.phase ?? "checking";
  const statusKey = STATUS_KEYS[phase];

  return (
    <>
      <section className="settings-card settings-runtime-card">
        <header className="settings-card-head">
          <span className="settings-card-icon">
            <img
              src={agentEraIcon}
              width={20}
              height={20}
              className="brand-logo"
              alt={t("settings.sections.hermesAgent")}
            />
          </span>
          <div className="settings-card-headtext">
            <div className="settings-card-title">
              {t("settings.sections.hermesAgent")}
            </div>
            <div className="settings-card-sub">
              {t("settings.runtimeDistribution.subtitle")}
            </div>
          </div>
          <span className={`settings-card-badge ${badgeClass(phase)}`.trim()}>
            {t(`settings.runtimeDistribution.status.${statusKey}`)}
          </span>
        </header>

        <div className="settings-card-body">
          <div className="settings-meta-grid">
            <div className="settings-meta">
              <span className="settings-meta-label">
                {t("settings.runtimeDistribution.currentVersion")}
              </span>
              <span className="settings-meta-value">
                {state?.currentVersion ?? "—"}
              </span>
            </div>
            <div className="settings-meta">
              <span className="settings-meta-label">
                {t("settings.runtimeDistribution.sourceCommit")}
              </span>
              <span className="settings-meta-value">
                {state?.currentSourceCommit?.slice(0, 12) ?? "—"}
              </span>
            </div>
            {state?.packagedSeedVersion && (
              <div className="settings-meta">
                <span className="settings-meta-label">
                  {t("settings.runtimeDistribution.packagedSeedVersion")}
                </span>
                <span className="settings-meta-value">
                  {state.packagedSeedVersion}
                </span>
              </div>
            )}
          </div>

          {phase === "downloading" && (
            <div className="settings-runtime-progress">
              <progress
                max={100}
                value={state?.downloadPercent ?? undefined}
                aria-label={t(
                  "settings.runtimeDistribution.status.downloading",
                )}
              />
              <span>
                {state?.downloadPercent === null ||
                state?.downloadPercent === undefined
                  ? "—"
                  : `${Math.round(state.downloadPercent)}%`}
              </span>
            </div>
          )}

          {state?.lastErrorCode && (
            <div className="settings-runtime-error" role="status">
              <AlertTriangle size={14} />
              {t(`settings.runtimeDistribution.errors.${state.lastErrorCode}`)}
            </div>
          )}

          <div className="settings-card-actions">
            <RuntimeAction
              state={state}
              onCheck={() => void checkForUpdate()}
              onDownload={() => setConfirmingDownload(true)}
              onCancel={() => void cancelDownload()}
              onRestart={() => void restartToApply()}
              onRetry={() => void retryRepair()}
              onExternalUpdate={() => void onExternalUpdate?.()}
              externalUpdating={externalUpdating}
              externalUpdateAvailable={externalUpdateAvailable}
            />
          </div>

          {children}
        </div>
      </section>

      {confirmingDownload && state?.phase === "update-available" && (
        <div className="settings-runtime-dialog-backdrop">
          <div
            className="settings-runtime-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="runtime-download-confirm-title"
          >
            <h3 id="runtime-download-confirm-title">
              {t("settings.runtimeDistribution.confirmTitle")}
            </h3>
            <dl>
              <div>
                <dt>{t("settings.runtimeDistribution.confirmVersion")}</dt>
                <dd>{state.availableVersion ?? "—"}</dd>
              </div>
              <div>
                <dt>{t("settings.runtimeDistribution.confirmSource")}</dt>
                <dd>bignormal/aera-runtime</dd>
              </div>
              <div>
                <dt>{t("settings.runtimeDistribution.confirmSize")}</dt>
                <dd>{formatBytes(state.downloadSize)}</dd>
              </div>
            </dl>
            <div className="settings-runtime-dialog-actions">
              <button
                className="btn btn-secondary"
                onClick={() => setConfirmingDownload(false)}
              >
                {t("settings.runtimeDistribution.confirmCancel")}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setConfirmingDownload(false);
                  void downloadConfirmed();
                }}
              >
                <Download size={14} />
                {t("settings.runtimeDistribution.confirmDownload")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function RuntimeAction({
  state,
  onCheck,
  onDownload,
  onCancel,
  onRestart,
  onRetry,
  onExternalUpdate,
  externalUpdating,
  externalUpdateAvailable,
}: {
  state: RuntimeDistributionPublicState | null;
  onCheck: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onRestart: () => void;
  onRetry: () => void;
  onExternalUpdate: () => void;
  externalUpdating: boolean;
  externalUpdateAvailable: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const phase = state?.phase ?? "checking";
  if (phase === "current") {
    return (
      <button className="btn btn-secondary" onClick={onCheck}>
        <RefreshCw size={14} />
        {t("settings.runtimeDistribution.check")}
      </button>
    );
  }
  if (phase === "checking" || phase === "installing") {
    return (
      <button className="btn btn-secondary" disabled>
        <Loader size={14} className="settings-spin" />
        {phase === "checking"
          ? t("settings.checkingUpdates")
          : t("settings.runtimeDistribution.preparing")}
      </button>
    );
  }
  if (phase === "update-available") {
    return (
      <button className="btn btn-primary" onClick={onDownload}>
        <Download size={14} />
        {t("settings.runtimeDistribution.download")}
      </button>
    );
  }
  if (phase === "downloading") {
    return (
      <button className="btn btn-secondary" onClick={onCancel}>
        <Ban size={14} />
        {t("settings.runtimeDistribution.cancel")}
      </button>
    );
  }
  if (phase === "candidate-ready") {
    return (
      <button className="btn btn-primary" onClick={onRestart}>
        <RotateCw size={14} />
        {t("settings.runtimeDistribution.restart")}
      </button>
    );
  }
  if (
    phase === "rollback" ||
    phase === "repair-required" ||
    phase === "missing"
  ) {
    return (
      <button className="btn btn-primary" onClick={onRetry}>
        <Wrench size={14} />
        {t("settings.runtimeDistribution.retry")}
      </button>
    );
  }
  if (externalUpdating) {
    return (
      <button className="btn btn-secondary" disabled>
        <Loader size={14} className="settings-spin" />
        {t("settings.updating")}
      </button>
    );
  }
  if (!externalUpdateAvailable) {
    return (
      <button className="btn btn-secondary" disabled>
        <CheckCircle2 size={14} />
        {t("settings.latestVersion")}
      </button>
    );
  }
  return (
    <button className="btn btn-secondary" onClick={onExternalUpdate}>
      <Download size={14} />
      {t("settings.runtimeDistribution.externalUpdate")}
    </button>
  );
}
