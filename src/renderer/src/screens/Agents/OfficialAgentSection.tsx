import type {
  AgenteraAgentInstallationSummary,
  OfficialAgentSummary,
  OfficialManagedUpdate,
} from "../../../../shared/agentera-agent-control";
import { useI18n } from "../../components/useI18n";

export interface OfficialAgentSectionProps {
  online: boolean;
  agents: OfficialAgentSummary[];
  installations: AgenteraAgentInstallationSummary[];
  updates: OfficialManagedUpdate[];
  busyInstallationId: string | null;
  onInstall: (definitionId: string) => void;
  onApplyUpdate: (installationId: string) => void;
}

export default function OfficialAgentSection({
  online,
  agents,
  installations,
  updates,
  busyInstallationId,
  onInstall,
  onApplyUpdate,
}: OfficialAgentSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const installationByDefinition = new Map(
    installations.map((installation) => [
      installation.definitionId,
      installation,
    ]),
  );
  const agentDefinitionIds = new Set(agents.map((agent) => agent.definitionId));
  const installedWithoutCatalogEntry = installations.filter(
    (installation) => !agentDefinitionIds.has(installation.definitionId),
  );
  const updateByInstallation = new Map(
    updates.map((update) => [update.installationId, update]),
  );
  const itemCount = agents.length + installedWithoutCatalogEntry.length;

  return (
    <section className="agent-control-group agent-control-installations">
      <div className="agent-control-group-title">
        <h3>{t("agents.control.official.title")}</h3>
        <span>{itemCount}</span>
      </div>
      <p className="agent-control-private-boundary">
        {t("agents.control.official.freshProfileBoundary")}
      </p>
      <p className="agent-control-empty">
        {t("agents.control.official.privateDataBoundary")}
      </p>

      {itemCount === 0 ? (
        <p className="agent-control-empty">
          {t(
            online
              ? "agents.control.official.noAgents"
              : "agents.control.official.noInstalledOffline",
          )}
        </p>
      ) : null}

      {agents.map((agent) => {
        const installation = installationByDefinition.get(agent.definitionId);
        const update = installation
          ? updateByInstallation.get(installation.id)
          : undefined;
        return (
          <article key={agent.definitionId} className="agent-control-card">
            <div>
              <strong>{agent.displayName}</strong>
              <p>
                <span>{t("agents.control.official.badge")}</span> ·{" "}
                {t(
                  agent.channel === "stable"
                    ? "agents.control.official.stableChannel"
                    : "agents.control.official.internalChannel",
                )}{" "}
                · {t("agents.control.official.version")} {agent.versionNumber}
              </p>
              {installation ? (
                <p>{t("agents.control.official.installedLocally")}</p>
              ) : null}
              {update ? (
                <>
                  <p>{t("agents.control.official.updateReady")}</p>
                  <p>
                    {t(
                      "agents.control.official.existingConversationsUnchanged",
                    )}
                  </p>
                </>
              ) : null}
            </div>
            <div className="agent-control-inline-actions">
              {online && !installation ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => onInstall(agent.definitionId)}
                >
                  {t("agents.control.official.install")}
                </button>
              ) : null}
              {online && installation && update ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busyInstallationId === installation.id}
                  onClick={() => onApplyUpdate(installation.id)}
                >
                  {t(
                    busyInstallationId === installation.id
                      ? "agents.control.official.applyingUpdate"
                      : "agents.control.official.applyUpdate",
                  )}
                </button>
              ) : null}
            </div>
          </article>
        );
      })}

      {installedWithoutCatalogEntry.map((installation) => (
        <article key={installation.id} className="agent-control-card">
          <div>
            <strong>{t("agents.control.official.installedSource")}</strong>
            <p>{t("agents.control.official.offlineLocalVersion")}</p>
            {!online ? (
              <p>{t("agents.control.official.offlineMayBeStale")}</p>
            ) : null}
          </div>
        </article>
      ))}
    </section>
  );
}
