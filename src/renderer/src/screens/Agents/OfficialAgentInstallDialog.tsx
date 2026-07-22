import { useEffect, useState } from "react";
import type {
  AgenteraAgentControlErrorCode,
  AgenteraAgentInstallationSummary,
  OfficialAgentInstallPreview,
} from "../../../../shared/agentera-agent-control";
import { X } from "../../assets/icons";
import { AppModal, AppModalTitle } from "../../components/modal/AppModal";
import { useI18n } from "../../components/useI18n";

export interface OfficialAgentInstallDialogProps {
  open: boolean;
  preview: OfficialAgentInstallPreview;
  onClose: () => void;
  onCompleted: (installation: AgenteraAgentInstallationSummary) => void;
}

function errorKey(code: AgenteraAgentControlErrorCode): string {
  return `agents.control.errors.${code}`;
}

export default function OfficialAgentInstallDialog({
  open,
  preview,
  onClose,
  onCompleted,
}: OfficialAgentInstallDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
  }, [open, preview.installHandle]);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.agenteraAgents.confirmOfficialInstall({
        installHandle: preview.installHandle,
        confirmation: "install-official-agent",
      });
      if (!result.ok) {
        setError(errorKey(result.errorCode));
        return;
      }
      onCompleted(result.data);
      onClose();
    } catch {
      setError("agents.control.errors.operation_failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppModal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
      className="agent-control-modal agent-install-dialog"
      labelledBy="official-agent-install-dialog-title"
    >
      <header className="agent-control-modal-header">
        <div>
          <AppModalTitle id="official-agent-install-dialog-title">
            {t("agents.control.official.installTitle")}
          </AppModalTitle>
          <p>{preview.agent.displayName}</p>
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
        <p className="agent-control-private-boundary">
          {t("agents.control.official.freshProfileBoundary")}
        </p>
        <p>{t("agents.control.official.privateDataBoundary")}</p>
        {error ? <div className="agents-create-error">{t(error)}</div> : null}
      </div>

      <footer className="agent-control-modal-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onClose}
          disabled={busy}
        >
          {t("agents.control.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={busy}
        >
          {t("agents.control.official.confirmInstall")}
        </button>
      </footer>
    </AppModal>
  );
}
