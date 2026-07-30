import { useEffect, useState } from "react";
import type {
  AgenteraAgentControlErrorCode,
  AgenteraAgentInstallationSummary,
  AgenteraAgentVersionSummary,
} from "../../../../shared/agentera-agent-control";
import { X } from "../../assets/icons";
import { AppModal, AppModalTitle } from "../../components/modal/AppModal";
import { useI18n } from "../../components/useI18n";

export interface AgentInstallProfileOption {
  id: string;
  name: string;
}

export interface AgentInstallDialogProps {
  open: boolean;
  mode: "install" | "retry" | "update";
  definitionId: string;
  versionId: string;
  installation: AgenteraAgentInstallationSummary | null;
  versions: AgenteraAgentVersionSummary[];
  profiles: AgentInstallProfileOption[];
  modelProfileId?: string;
  onClose: () => void;
  onCompleted: (installation: AgenteraAgentInstallationSummary) => void;
}

function errorKey(code: AgenteraAgentControlErrorCode): string {
  return `agents.control.errors.${code}`;
}

export default function AgentInstallDialog({
  open,
  mode,
  definitionId,
  versionId,
  installation,
  versions,
  profiles,
  modelProfileId,
  onClose,
  onCompleted,
}: AgentInstallDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [target, setTarget] = useState<"fresh" | "claim">("fresh");
  const [profileName, setProfileName] = useState("");
  const [localProfileId, setLocalProfileId] = useState(profiles[0]?.id ?? "");
  const [selectedVersionId, setSelectedVersionId] = useState(versionId);
  const [confirmedClaim, setConfirmedClaim] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTarget("fresh");
    setProfileName("");
    setLocalProfileId(profiles[0]?.id ?? "");
    setSelectedVersionId(versionId);
    setConfirmedClaim(false);
    setBusy(false);
    setError(null);
  }, [definitionId, installation?.id, mode, open, profiles, versionId]);

  const titleKey =
    mode === "retry"
      ? "agents.control.retryTitle"
      : mode === "update"
        ? "agents.control.updateTitle"
        : "agents.control.installTitle";
  const actionKey =
    mode === "retry"
      ? "agents.control.retry"
      : mode === "update"
        ? "agents.control.selectVersion"
        : "agents.control.install";
  const canSubmit =
    mode === "update"
      ? Boolean(installation && selectedVersionId && localProfileId)
      : target === "fresh"
        ? profileName.trim().length > 0
        : Boolean(localProfileId && confirmedClaim);

  const submit = async (): Promise<void> => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    const result =
      mode === "update" && installation
        ? await window.agenteraAgents.selectInstallationVersion({
            id: installation.id,
            versionId: selectedVersionId,
            localProfileId,
          })
        : mode === "retry" && installation
          ? await window.agenteraAgents.retryPendingInstallation({
              id: installation.id,
              target:
                target === "fresh"
                  ? {
                      kind: "fresh",
                      profileName: profileName.trim(),
                      ...(modelProfileId ? { modelProfileId } : {}),
                    }
                  : {
                      kind: "claim",
                      localProfileId,
                      confirmation: "claim-existing-profile",
                    },
            })
          : target === "fresh"
            ? await window.agenteraAgents.installVersion({
                definitionId,
                versionId,
                profileName: profileName.trim(),
                ...(modelProfileId ? { modelProfileId } : {}),
              })
            : await window.agenteraAgents.claimVersion({
                definitionId,
                versionId,
                localProfileId,
                confirmation: "claim-existing-profile",
              });
    setBusy(false);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    onCompleted(result.data);
    onClose();
  };

  return (
    <AppModal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
      className="agent-control-modal agent-install-dialog"
      labelledBy="agent-install-dialog-title"
    >
      <header className="agent-control-modal-header">
        <div>
          <AppModalTitle id="agent-install-dialog-title">
            {t(titleKey)}
          </AppModalTitle>
          <p>{t("agents.control.installIsolationHint")}</p>
        </div>
        <button
          type="button"
          className="agents-row-edit"
          aria-label={t("agents.control.close")}
          onClick={onClose}
          disabled={busy}
        >
          <X size={16} />
        </button>
      </header>

      <div className="agent-control-modal-body">
        {mode === "update" ? (
          <>
            <p className="agent-control-private-boundary">
              {t("agents.control.updateNewConversationsOnly")}
            </p>
            <label className="agents-create-field">
              <span>{t("agents.control.version")}</span>
              <select
                className="input"
                aria-label={t("agents.control.version")}
                value={selectedVersionId}
                onChange={(event) => setSelectedVersionId(event.target.value)}
              >
                {versions.map((item) => (
                  <option key={item.id} value={item.id}>
                    v{item.versionNumber}
                  </option>
                ))}
              </select>
            </label>
            <label className="agents-create-field">
              <span>{t("agents.control.localProfile")}</span>
              <select
                className="input"
                aria-label={t("agents.control.localProfile")}
                value={localProfileId}
                onChange={(event) => setLocalProfileId(event.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <div className="agent-control-install-options">
              <label>
                <input
                  type="radio"
                  name="agent-install-target"
                  checked={target === "fresh"}
                  onChange={() => {
                    setTarget("fresh");
                    setConfirmedClaim(false);
                  }}
                />
                <span>{t("agents.control.freshProfile")}</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="agent-install-target"
                  checked={target === "claim"}
                  onChange={() => setTarget("claim")}
                />
                <span>{t("agents.control.claimProfile")}</span>
              </label>
            </div>
            {target === "fresh" ? (
              <label className="agents-create-field">
                <span>{t("agents.control.profileName")}</span>
                <input
                  className="input"
                  aria-label={t("agents.control.profileName")}
                  value={profileName}
                  onChange={(event) => setProfileName(event.target.value)}
                />
                <small>{t("agents.control.noCloneHint")}</small>
              </label>
            ) : (
              <>
                <label className="agents-create-field">
                  <span>{t("agents.control.localProfile")}</span>
                  <select
                    className="input"
                    aria-label={t("agents.control.localProfile")}
                    value={localProfileId}
                    onChange={(event) => setLocalProfileId(event.target.value)}
                  >
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="agent-control-confirm-row">
                  <input
                    type="checkbox"
                    checked={confirmedClaim}
                    aria-label={t("agents.control.claimConfirmation")}
                    onChange={(event) =>
                      setConfirmedClaim(event.target.checked)
                    }
                  />
                  <span>{t("agents.control.claimConfirmation")}</span>
                </label>
              </>
            )}
          </>
        )}
        {error && <div className="agents-create-error">{t(error)}</div>}
      </div>

      <footer className="agent-control-modal-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t("agents.control.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSubmit || busy}
          onClick={() => void submit()}
        >
          {t(actionKey)}
        </button>
      </footer>
    </AppModal>
  );
}
