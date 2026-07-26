import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CloudUpload,
  Download,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useI18n } from "../useI18n";
import { useSettings } from "./SettingsDataContext";
import type { AgenteraAgentInstallationSummary } from "../../../../shared/agentera-agent-control";
import type {
  AgenteraEncryptedBackupPreparedRestore,
  AgenteraEncryptedBackupProgress,
  AgenteraEncryptedBackupPublicDevice,
  AgenteraEncryptedBackupPublicState,
  AgenteraEncryptedBackupPublicSummary,
} from "../../../../shared/agentera-encrypted-backup";

const UNAVAILABLE_STATE: AgenteraEncryptedBackupPublicState = {
  available: false,
  initialized: false,
  recoveryConfirmed: false,
  currentDeviceId: null,
  keyEpoch: null,
  profileLineageId: null,
  scheduledInstallationIds: [],
  activeBackups: [],
};

const DISPLAYABLE_ERROR_CODES = new Set([
  "authentication_required",
  "online_required",
  "cloud_unavailable",
  "service_unavailable",
  "existing_backup_recovery_required",
  "recovery_phrase_unavailable",
  "recovery_setup_required",
  "invalid_request",
  "backup_not_found",
  "backup_failed",
]);

type DestructiveConfirmation =
  | { kind: "authorize"; id: string }
  | { kind: "revoke"; id: string }
  | { kind: "delete"; id: string };

function failureCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  if (error instanceof Error) {
    const codes = error.message.match(/[a-z][a-z0-9_]{2,63}/g);
    const known = codes?.find(
      (code) => code === "quota_exceeded" || DISPLAYABLE_ERROR_CODES.has(code),
    );
    if (known) return known;
  }
  return "backup_failed";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function shortIdentifier(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function EncryptedBackupPanel(): React.JSX.Element {
  const { t } = useI18n();
  const [state, setState] =
    useState<AgenteraEncryptedBackupPublicState>(UNAVAILABLE_STATE);
  const [installations, setInstallations] = useState<
    AgenteraAgentInstallationSummary[]
  >([]);
  const [selectedInstallationId, setSelectedInstallationId] = useState("");
  const [backups, setBackups] = useState<
    AgenteraEncryptedBackupPublicSummary[]
  >([]);
  const [devices, setDevices] = useState<AgenteraEncryptedBackupPublicDevice[]>(
    [],
  );
  const [progress, setProgress] = useState<AgenteraEncryptedBackupProgress[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null);
  const [recoveryWritten, setRecoveryWritten] = useState(false);
  const [confirmation, setConfirmation] =
    useState<DestructiveConfirmation | null>(null);
  const [restoreTarget, setRestoreTarget] =
    useState<AgenteraEncryptedBackupPublicSummary | null>(null);
  const [restorePhrase, setRestorePhrase] = useState("");
  const [preparedRestore, setPreparedRestore] =
    useState<AgenteraEncryptedBackupPreparedRestore | null>(null);
  const [restoreName, setRestoreName] = useState("");
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);

  const setFailure = useCallback((caught: unknown) => {
    setNotice(null);
    setError(failureCode(caught));
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const nextState = await window.agenteraEncryptedBackup.getState();
      setState(nextState);
      setProgress(nextState.activeBackups);

      const installationResult =
        await window.agenteraAgents.listInstallations();
      if (installationResult.ok) {
        const eligible = installationResult.data.filter(
          (installation) =>
            installation.sourceScope === "USER" &&
            installation.status === "active",
        );
        setInstallations(eligible);
        setSelectedInstallationId((current) =>
          eligible.some((installation) => installation.id === current)
            ? current
            : (eligible[0]?.id ?? ""),
        );
      } else {
        setInstallations([]);
        setSelectedInstallationId("");
      }

      if (!nextState.available) {
        setBackups([]);
        setDevices([]);
        return;
      }
      const [backupResult, deviceResult] = await Promise.allSettled([
        window.agenteraEncryptedBackup.listBackups(),
        window.agenteraEncryptedBackup.listDevices(),
      ]);
      setBackups(backupResult.status === "fulfilled" ? backupResult.value : []);
      setDevices(deviceResult.status === "fulfilled" ? deviceResult.value : []);
      if (backupResult.status === "rejected") {
        setFailure(backupResult.reason);
      } else if (deviceResult.status === "rejected") {
        setFailure(deviceResult.reason);
      }
    } catch (caught) {
      setState(UNAVAILABLE_STATE);
      setBackups([]);
      setDevices([]);
      setFailure(caught);
    } finally {
      setLoading(false);
    }
  }, [setFailure]);

  useEffect(() => {
    void refresh();
    const unsubscribeProgress = window.agenteraEncryptedBackup.onProgress(
      (nextProgress) => {
        setProgress(nextProgress);
      },
    );
    const unsubscribeAuth = window.agenteraAuth?.onStateChanged(() => {
      void refresh();
    });
    return () => {
      unsubscribeProgress();
      unsubscribeAuth?.();
    };
  }, [refresh]);

  const selectedProgress = useMemo(
    () =>
      progress.find(
        (entry) => entry.installationId === selectedInstallationId,
      ) ?? null,
    [progress, selectedInstallationId],
  );

  const selectedScheduled = state.scheduledInstallationIds.includes(
    selectedInstallationId,
  );

  const run = useCallback(
    async (label: string, action: () => Promise<void>): Promise<void> => {
      setBusy(label);
      setError(null);
      setNotice(null);
      try {
        await action();
      } catch (caught) {
        setFailure(caught);
      } finally {
        setBusy(null);
      }
    },
    [setFailure],
  );

  const initializeRecovery = (): void => {
    void run("setup", async () => {
      const enrollment =
        await window.agenteraEncryptedBackup.initializeRecovery();
      setState(enrollment.state);
      if (!enrollment.recoveryPhrase) {
        throw Object.assign(new Error("Recovery phrase unavailable."), {
          code: "recovery_phrase_unavailable",
        });
      }
      setRecoveryWritten(false);
      setRecoveryPhrase(enrollment.recoveryPhrase);
    });
  };

  const confirmRecovery = (): void => {
    if (!recoveryWritten) return;
    void run("confirm-recovery", async () => {
      const nextState =
        await window.agenteraEncryptedBackup.confirmRecoverySaved();
      setState(nextState);
      setRecoveryPhrase(null);
      setRecoveryWritten(false);
      setNotice("recoveryConfirmed");
    });
  };

  const registerCurrentDevice = (): void => {
    void run("register-device", async () => {
      const nextDevices =
        await window.agenteraEncryptedBackup.registerCurrentDevice();
      setDevices(nextDevices);
      setNotice("deviceRegistered");
    });
  };

  const createBackup = (): void => {
    if (!selectedInstallationId) return;
    void run("create-backup", async () => {
      const result = await window.agenteraEncryptedBackup.createBackup(
        selectedInstallationId,
      );
      setNotice(
        result.deviceEnvelopeSyncPending
          ? "backupCreatedEnvelopePending"
          : "backupCreated",
      );
      setBackups(await window.agenteraEncryptedBackup.listBackups());
    });
  };

  const cancelBackup = (): void => {
    if (!selectedInstallationId) return;
    void run("cancel-backup", async () => {
      await window.agenteraEncryptedBackup.cancelBackup(selectedInstallationId);
    });
  };

  const updateSchedule = (enabled: boolean): void => {
    if (!selectedInstallationId) return;
    void run("schedule", async () => {
      setState(
        await window.agenteraEncryptedBackup.setDailySchedule(
          selectedInstallationId,
          enabled,
        ),
      );
    });
  };

  const confirmDestructiveAction = (): void => {
    if (!confirmation) return;
    const target = confirmation;
    void run(target.kind, async () => {
      if (target.kind === "authorize") {
        setDevices(
          await window.agenteraEncryptedBackup.authorizeDevice(target.id),
        );
        setNotice("deviceAuthorized");
      } else if (target.kind === "revoke") {
        setDevices(
          await window.agenteraEncryptedBackup.revokeDevice(target.id),
        );
        setNotice("deviceRevoked");
      } else {
        await window.agenteraEncryptedBackup.deleteBackup(target.id);
        setBackups((current) =>
          current.filter((backup) => backup.backupId !== target.id),
        );
        setNotice("backupDeleted");
      }
      setConfirmation(null);
    });
  };

  const closeRestore = (): void => {
    const prepared = preparedRestore;
    setRestoreTarget(null);
    setRestorePhrase("");
    setPreparedRestore(null);
    setRestoreName("");
    setRestoreConfirmed(false);
    if (prepared) {
      void window.agenteraEncryptedBackup
        .cancelRestore(prepared.preparationId)
        .catch(() => undefined);
    }
  };

  const prepareRestore = (): void => {
    if (!restoreTarget) return;
    void run("prepare-restore", async () => {
      const normalizedPhrase = restorePhrase.trim();
      const prepared = await window.agenteraEncryptedBackup.prepareRestore(
        restoreTarget.backupId,
        normalizedPhrase || undefined,
      );
      setRestorePhrase("");
      setPreparedRestore(prepared);
    });
  };

  const confirmRestore = (): void => {
    if (!preparedRestore || !restoreConfirmed || !restoreName.trim()) return;
    void run("confirm-restore", async () => {
      await window.agenteraEncryptedBackup.confirmRestore(
        preparedRestore.preparationId,
        restoreName.trim(),
      );
      setPreparedRestore(null);
      setRestoreTarget(null);
      setRestorePhrase("");
      setRestoreName("");
      setRestoreConfirmed(false);
      setNotice("restoreComplete");
    });
  };

  const percent =
    selectedProgress && selectedProgress.totalObjects > 0
      ? Math.round(
          (selectedProgress.uploadedObjects / selectedProgress.totalObjects) *
            100,
        )
      : 0;

  return (
    <>
      <section className="settings-encrypted-backup">
        <div className="settings-encrypted-backup-heading">
          <div>
            <div className="settings-field-label">
              <ShieldCheck size={16} />
              {t("settings.encryptedBackup.title")}
            </div>
            <div className="settings-field-hint">
              {t("settings.encryptedBackup.privacy")}
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost"
            aria-label={t("settings.encryptedBackup.refresh")}
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {loading ? (
          <div className="settings-field-hint">
            {t("settings.encryptedBackup.loading")}
          </div>
        ) : !state.available ? (
          <div className="settings-encrypted-backup-status warning">
            {t("settings.encryptedBackup.signInRequired")}
          </div>
        ) : (
          <>
            {!state.initialized && (
              <div className="settings-encrypted-backup-card">
                <div className="settings-encrypted-backup-card-title">
                  <KeyRound size={15} />
                  {t("settings.encryptedBackup.recoverySetup")}
                </div>
                <p>{t("settings.encryptedBackup.recoverySetupHint")}</p>
                <div className="settings-encrypted-backup-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={initializeRecovery}
                    disabled={busy !== null}
                  >
                    {t("settings.encryptedBackup.setup")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={registerCurrentDevice}
                    disabled={busy !== null}
                  >
                    {t("settings.encryptedBackup.registerThisDevice")}
                  </button>
                </div>
              </div>
            )}

            {state.initialized && (
              <div className="settings-encrypted-backup-card">
                <div className="settings-encrypted-backup-card-title">
                  <CloudUpload size={15} />
                  {t("settings.encryptedBackup.manualTitle")}
                </div>
                <label className="settings-encrypted-backup-control">
                  <span>{t("settings.encryptedBackup.profile")}</span>
                  <select
                    value={selectedInstallationId}
                    onChange={(event) =>
                      setSelectedInstallationId(event.target.value)
                    }
                    disabled={busy !== null || progress.length > 0}
                  >
                    {installations.map((installation) => (
                      <option key={installation.id} value={installation.id}>
                        {shortIdentifier(installation.id)}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedProgress ? (
                  <>
                    <div
                      className="settings-encrypted-backup-progress"
                      aria-label={t("settings.encryptedBackup.progress", {
                        percent,
                      })}
                    >
                      <span style={{ width: `${percent}%` }} />
                    </div>
                    <div className="settings-field-hint">
                      {t("settings.encryptedBackup.progress", { percent })}
                    </div>
                  </>
                ) : null}
                <div className="settings-encrypted-backup-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={createBackup}
                    disabled={
                      busy !== null ||
                      !state.recoveryConfirmed ||
                      !selectedInstallationId ||
                      selectedProgress !== null
                    }
                  >
                    {t("settings.encryptedBackup.backupNow")}
                  </button>
                  {selectedProgress ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={cancelBackup}
                      disabled={busy !== null}
                    >
                      {t("settings.encryptedBackup.cancelBackup")}
                    </button>
                  ) : null}
                  <label className="settings-encrypted-backup-schedule">
                    <input
                      type="checkbox"
                      checked={selectedScheduled}
                      onChange={(event) => updateSchedule(event.target.checked)}
                      disabled={
                        busy !== null ||
                        !state.recoveryConfirmed ||
                        !selectedInstallationId
                      }
                    />
                    {t("settings.encryptedBackup.dailySchedule")}
                  </label>
                </div>
              </div>
            )}

            <div className="settings-encrypted-backup-card">
              <div className="settings-encrypted-backup-card-title">
                {t("settings.encryptedBackup.backupsTitle")}
              </div>
              {backups.length === 0 ? (
                <p>{t("settings.encryptedBackup.noBackups")}</p>
              ) : (
                <div className="settings-encrypted-backup-list">
                  {backups.map((backup) => (
                    <div
                      key={backup.backupId}
                      className="settings-encrypted-backup-list-row"
                    >
                      <div>
                        <strong>{shortIdentifier(backup.backupId)}</strong>
                        <span>
                          {new Date(backup.sealedAt).toLocaleString()} ·{" "}
                          {formatBytes(backup.totalCiphertextSize)}
                        </span>
                      </div>
                      <div className="settings-encrypted-backup-row-actions">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          aria-label={t("settings.encryptedBackup.restore", {
                            id: backup.backupId,
                          })}
                          onClick={() => setRestoreTarget(backup)}
                          disabled={busy !== null}
                        >
                          {t("settings.encryptedBackup.restore")}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          aria-label={t(
                            "settings.encryptedBackup.deleteBackup",
                            { id: backup.backupId },
                          )}
                          onClick={() =>
                            setConfirmation({
                              kind: "delete",
                              id: backup.backupId,
                            })
                          }
                          disabled={busy !== null}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="settings-encrypted-backup-card">
              <div className="settings-encrypted-backup-card-title">
                <Smartphone size={15} />
                {t("settings.encryptedBackup.devicesTitle")}
              </div>
              {devices.length === 0 ? (
                <p>{t("settings.encryptedBackup.noDevices")}</p>
              ) : (
                <div className="settings-encrypted-backup-list">
                  {devices.map((device) => (
                    <div
                      key={device.deviceId}
                      className="settings-encrypted-backup-list-row"
                    >
                      <div>
                        <strong>{shortIdentifier(device.deviceId)}</strong>
                        <span>
                          {device.isCurrent
                            ? t("settings.encryptedBackup.currentDevice")
                            : device.authorizationRequired
                              ? t(
                                  "settings.encryptedBackup.authorizationPending",
                                )
                              : device.status === "revoked"
                                ? t("settings.encryptedBackup.revoked")
                                : t("settings.encryptedBackup.authorized")}
                        </span>
                      </div>
                      {device.authorizationRequired ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          aria-label={t(
                            "settings.encryptedBackup.authorizeDevice",
                            { id: device.deviceId },
                          )}
                          onClick={() =>
                            setConfirmation({
                              kind: "authorize",
                              id: device.deviceId,
                            })
                          }
                          disabled={busy !== null}
                        >
                          {t("settings.encryptedBackup.authorize")}
                        </button>
                      ) : !device.isCurrent &&
                        device.authorized &&
                        device.status === "active" ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          aria-label={t(
                            "settings.encryptedBackup.revokeDevice",
                            { id: device.deviceId },
                          )}
                          onClick={() =>
                            setConfirmation({
                              kind: "revoke",
                              id: device.deviceId,
                            })
                          }
                          disabled={busy !== null}
                        >
                          {t("settings.encryptedBackup.revoke")}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {error ? (
          <div className="settings-encrypted-backup-status error" role="alert">
            {t(
              error === "quota_exceeded"
                ? "settings.encryptedBackup.quotaExceeded"
                : DISPLAYABLE_ERROR_CODES.has(error)
                  ? `settings.encryptedBackup.errors.${error}`
                  : "settings.encryptedBackup.errors.generic",
              { code: error },
            )}
          </div>
        ) : null}
        {notice ? (
          <div className="settings-encrypted-backup-status success">
            {t(`settings.encryptedBackup.notices.${notice}`)}
          </div>
        ) : null}
      </section>

      {recoveryPhrase ? (
        <div className="settings-encrypted-backup-dialog-backdrop">
          <div
            className="settings-encrypted-backup-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="encrypted-backup-recovery-title"
          >
            <h3 id="encrypted-backup-recovery-title">
              {t("settings.encryptedBackup.recoveryTitle")}
            </h3>
            <p>{t("settings.encryptedBackup.recoveryWarning")}</p>
            <code className="settings-encrypted-backup-phrase">
              {recoveryPhrase}
            </code>
            <label className="settings-encrypted-backup-confirmation">
              <input
                type="checkbox"
                checked={recoveryWritten}
                onChange={(event) => setRecoveryWritten(event.target.checked)}
              />
              {t("settings.encryptedBackup.confirmWritten")}
            </label>
            <div className="settings-encrypted-backup-dialog-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={confirmRecovery}
                disabled={!recoveryWritten || busy !== null}
              >
                {t("settings.encryptedBackup.confirmRecovery")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmation ? (
        <div className="settings-encrypted-backup-dialog-backdrop">
          <div
            className="settings-encrypted-backup-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="encrypted-backup-confirm-title"
          >
            <h3 id="encrypted-backup-confirm-title">
              {t(`settings.encryptedBackup.${confirmation.kind}ConfirmTitle`)}
            </h3>
            <p className="settings-encrypted-backup-warning">
              <AlertTriangle size={16} />
              {t(`settings.encryptedBackup.${confirmation.kind}Warning`)}
            </p>
            <div className="settings-encrypted-backup-dialog-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmation(null)}
                disabled={busy !== null}
              >
                {t("settings.encryptedBackup.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={confirmDestructiveAction}
                disabled={busy !== null}
              >
                {t(
                  `settings.encryptedBackup.confirm${
                    confirmation.kind[0].toUpperCase() +
                    confirmation.kind.slice(1)
                  }`,
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {restoreTarget ? (
        <div className="settings-encrypted-backup-dialog-backdrop">
          <div
            className="settings-encrypted-backup-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="encrypted-backup-restore-title"
          >
            <button
              type="button"
              className="btn-ghost settings-encrypted-backup-dialog-close"
              aria-label={t("settings.encryptedBackup.cancel")}
              onClick={closeRestore}
              disabled={busy !== null}
            >
              <X size={16} />
            </button>
            <h3 id="encrypted-backup-restore-title">
              {t("settings.encryptedBackup.restoreTitle")}
            </h3>
            <p className="settings-encrypted-backup-warning">
              <AlertTriangle size={16} />
              {t("settings.encryptedBackup.restoreFreshWarning")}
            </p>
            {!preparedRestore ? (
              <>
                <label className="settings-encrypted-backup-control">
                  <span>{t("settings.encryptedBackup.recoveryPhrase")}</span>
                  <textarea
                    value={restorePhrase}
                    onChange={(event) => setRestorePhrase(event.target.value)}
                    placeholder={t(
                      "settings.encryptedBackup.recoveryPhraseOptional",
                    )}
                    rows={3}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <div className="settings-encrypted-backup-dialog-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={closeRestore}
                    disabled={busy !== null}
                  >
                    {t("settings.encryptedBackup.cancel")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={prepareRestore}
                    disabled={busy !== null}
                  >
                    {t("settings.encryptedBackup.prepareRestore")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="settings-field-hint">
                  {t("settings.encryptedBackup.restorePreview", {
                    id: preparedRestore.sourceInstallationId,
                  })}
                </div>
                <label className="settings-encrypted-backup-control">
                  <span>{t("settings.encryptedBackup.restoreName")}</span>
                  <input
                    value={restoreName}
                    onChange={(event) => setRestoreName(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label className="settings-encrypted-backup-confirmation">
                  <input
                    type="checkbox"
                    checked={restoreConfirmed}
                    onChange={(event) =>
                      setRestoreConfirmed(event.target.checked)
                    }
                  />
                  {t("settings.encryptedBackup.confirmFreshProfile")}
                </label>
                <div className="settings-encrypted-backup-dialog-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={closeRestore}
                    disabled={busy !== null}
                  >
                    {t("settings.encryptedBackup.cancel")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={confirmRestore}
                    disabled={
                      busy !== null || !restoreConfirmed || !restoreName.trim()
                    }
                  >
                    {t("settings.encryptedBackup.confirmRestore")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Export / import a full Hermes backup archive, plus the OpenClaw → Hermes
 * migration (which imports config, keys, sessions, and skills — a data import,
 * so it lives here rather than under Community).
 */
export default function DataPane(): React.JSX.Element {
  const { t } = useI18n();
  const {
    backingUp,
    backupResult,
    backupResultType,
    importing,
    importResult,
    importResultType,
    handleBackup,
    handleImport,
    openclawFound,
    openclawPath,
    migrationDismissed,
    migrating,
    migrationLog,
    migrationResult,
    migrationResultType,
    migrationLogRef,
    handleMigrate,
    handleDismissMigration,
  } = useSettings();

  return (
    <div className="settings-modal-pane">
      <EncryptedBackupPanel />

      <div className="settings-field">
        <div className="settings-field-hint" style={{ marginBottom: 10 }}>
          {t("settings.dataHint")}
        </div>
        <div className="settings-hermes-actions">
          <button
            className="btn btn-secondary"
            onClick={handleBackup}
            disabled={backingUp}
          >
            <Download size={14} style={{ marginRight: 6 }} />
            {backingUp ? t("settings.backingUp") : t("settings.exportBackup")}
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleImport}
            disabled={importing}
          >
            <Upload size={14} style={{ marginRight: 6 }} />
            {importing ? t("settings.importing") : t("settings.importBackup")}
          </button>
        </div>
        {backupResult && (
          <div
            className={`settings-hermes-result ${backupResultType || "error"}`}
            style={{ marginTop: 8 }}
          >
            {backupResult}
          </div>
        )}
        {importResult && (
          <div
            className={`settings-hermes-result ${importResultType || "error"}`}
            style={{ marginTop: 8 }}
          >
            {importResult}
          </div>
        )}
      </div>

      {openclawFound && !migrationDismissed && (
        <div className="settings-migration-banner">
          <div className="settings-migration-header">
            <div>
              <div className="settings-migration-title">
                {t("settings.migrationDetected")}
              </div>
              <div
                className="settings-migration-desc"
                dangerouslySetInnerHTML={{
                  __html: t("settings.migrationDesc", {
                    path: openclawPath || "",
                  }),
                }}
              />
            </div>
            <button
              className="btn-ghost settings-migration-dismiss"
              onClick={handleDismissMigration}
              title={t("settings.migrationDismiss")}
            >
              &times;
            </button>
          </div>
          {migrationLog && (
            <pre className="settings-hermes-doctor" ref={migrationLogRef}>
              {migrationLog}
            </pre>
          )}
          {migrationResult && (
            <div
              className={`settings-hermes-result ${migrationResultType || "error"}`}
            >
              {migrationResult}
            </div>
          )}
          <div className="settings-migration-actions">
            <button
              className="btn btn-primary "
              onClick={handleMigrate}
              disabled={migrating}
            >
              {migrating
                ? t("settings.migrating")
                : t("settings.migrateToHermes")}
            </button>
            <button
              className="btn btn-secondary "
              onClick={handleDismissMigration}
            >
              {t("settings.skip")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
