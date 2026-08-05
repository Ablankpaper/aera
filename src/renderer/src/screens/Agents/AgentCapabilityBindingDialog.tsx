import { useEffect, useMemo, useState } from "react";
import type {
  AgentCapabilityBindingConfiguration,
  ConfirmCapabilityBindingsInput,
} from "../../../../shared/agentera-agent-control";
import { X } from "../../assets/icons";
import { AppModal, AppModalTitle } from "../../components/modal/AppModal";
import { useI18n } from "../../components/useI18n";

export interface AgentCapabilityBindingDialogProps {
  open: boolean;
  configuration: AgentCapabilityBindingConfiguration;
  online: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (input: ConfirmCapabilityBindingsInput) => void;
}

function initialMappings(
  configuration: AgentCapabilityBindingConfiguration,
): Record<string, string> {
  return Object.fromEntries(
    configuration.requirements.map((requirement) => [
      requirement.logicalName,
      requirement.compatibleServers.find((server) => server.current)
        ?.mappingHandle ?? "",
    ]),
  );
}

export default function AgentCapabilityBindingDialog({
  open,
  configuration,
  online,
  busy,
  onClose,
  onConfirm,
}: AgentCapabilityBindingDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [mappings, setMappings] = useState<Record<string, string>>(() =>
    initialMappings(configuration),
  );

  useEffect(() => {
    if (open) setMappings(initialMappings(configuration));
  }, [configuration, open]);

  const requiredMissing = configuration.requirements.some(
    (requirement) => requirement.required && !mappings[requirement.logicalName],
  );
  const mappingHandles = useMemo(
    () =>
      configuration.requirements
        .map((requirement) => mappings[requirement.logicalName])
        .filter((handle): handle is string => Boolean(handle)),
    [configuration.requirements, mappings],
  );

  return (
    <AppModal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
      className="agent-control-modal"
      labelledBy="agent-capability-binding-dialog-title"
    >
      <header className="agent-control-modal-header">
        <div>
          <AppModalTitle id="agent-capability-binding-dialog-title">
            {t("agents.capabilityBinding.title")}
          </AppModalTitle>
          <p>{t("agents.capabilityBinding.privateBoundary")}</p>
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
        {configuration.requirements.map((requirement) => (
          <section
            key={requirement.logicalName}
            className="agent-control-asset-row"
          >
            <strong>{requirement.logicalName}</strong>
            <p>{requirement.tools.join(", ")}</p>
            <p>{requirement.permissionReason}</p>
            <p>
              {t(
                requirement.required
                  ? "agents.capabilityBinding.required"
                  : "agents.capabilityBinding.optional",
              )}
            </p>
            <label className="agents-create-field">
              <span>{t("agents.capabilityBinding.localMcp")}</span>
              <select
                className="input"
                aria-label={requirement.logicalName}
                value={mappings[requirement.logicalName] ?? ""}
                disabled={busy}
                onChange={(event) =>
                  setMappings((current) => ({
                    ...current,
                    [requirement.logicalName]: event.target.value,
                  }))
                }
              >
                <option value="">
                  {t(
                    requirement.required
                      ? "agents.capabilityBinding.chooseRequired"
                      : "agents.capabilityBinding.skipOptional",
                  )}
                </option>
                {requirement.compatibleServers.map((server) => (
                  <option
                    key={server.mappingHandle}
                    value={server.mappingHandle}
                  >
                    {server.displayName}
                  </option>
                ))}
              </select>
            </label>
            {requirement.compatibleServers.length === 0 ? (
              <p>{t("agents.capabilityBinding.noCompatibleServer")}</p>
            ) : null}
          </section>
        ))}
        {!online ? <p>{t("agents.capabilityBinding.onlineRequired")}</p> : null}
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
          disabled={busy || !online || requiredMissing}
          onClick={() =>
            onConfirm({
              installationId: configuration.installationId,
              mappingHandles,
              confirmation: "bind-profile-capabilities",
            })
          }
        >
          {t("agents.capabilityBinding.save")}
        </button>
      </footer>
    </AppModal>
  );
}
