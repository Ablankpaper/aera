import { useEffect, useMemo, useState } from "react";
import type {
  AgenteraAgentInstallationSummary,
  OfficialAgentDetail,
  OfficialAgentSummary,
  OfficialManagedUpdate,
} from "../../../../shared/agentera-agent-control";
import { Bot, Check, Refresh, Sparkles } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";
import AgentHubDetailDialog from "./AgentHubDetailDialog";

export type OfficialAgentFilter = "all" | "installed" | "updates";

export interface OfficialAgentProfileLink {
  id: string;
  name: string;
  agentInstallationId?: string | null;
}

export interface OfficialAgentSectionProps {
  online: boolean;
  agents: OfficialAgentSummary[];
  installations: AgenteraAgentInstallationSummary[];
  updates: OfficialManagedUpdate[];
  profiles?: OfficialAgentProfileLink[];
  query?: string;
  filter?: OfficialAgentFilter;
  busyInstallationId: string | null;
  installBusy?: boolean;
  onInstall: (definitionId: string) => void;
  onApplyUpdate: (installationId: string) => void;
  onChatWithProfile?: (profileId: string) => void;
}

interface OfficialCatalogItem {
  key: string;
  name: string;
  agent: OfficialAgentSummary | null;
  installation: AgenteraAgentInstallationSummary | null;
  update: OfficialManagedUpdate | null;
  profile: OfficialAgentProfileLink | null;
}

function iconDataUrl(agent: OfficialAgentSummary | null): string | null {
  if (!agent?.iconMediaType || !agent.iconDataBase64Url) return null;
  const standard = agent.iconDataBase64Url
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  return `data:${agent.iconMediaType};base64,${padded}`;
}

export default function OfficialAgentSection({
  online,
  agents,
  installations,
  updates,
  profiles = [],
  query = "",
  filter = "all",
  busyInstallationId,
  installBusy = false,
  onInstall,
  onApplyUpdate,
  onChatWithProfile,
}: OfficialAgentSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<OfficialAgentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const items = useMemo(() => {
    const installationByDefinition = new Map(
      installations.map((installation) => [
        installation.definitionId,
        installation,
      ]),
    );
    const updateByInstallation = new Map(
      updates.map((update) => [update.installationId, update]),
    );
    const profileByInstallation = new Map(
      profiles
        .filter((profile) => profile.agentInstallationId)
        .map((profile) => [profile.agentInstallationId!, profile]),
    );
    const catalogDefinitionIds = new Set(
      agents.map((agent) => agent.definitionId),
    );
    const next: OfficialCatalogItem[] = agents.map((agent) => {
      const installation =
        installationByDefinition.get(agent.definitionId) ?? null;
      return {
        key: agent.definitionId,
        name: agent.displayName,
        agent,
        installation,
        update: installation
          ? (updateByInstallation.get(installation.id) ?? null)
          : null,
        profile: installation
          ? (profileByInstallation.get(installation.id) ?? null)
          : null,
      };
    });
    for (const installation of installations) {
      if (catalogDefinitionIds.has(installation.definitionId)) continue;
      const profile = profileByInstallation.get(installation.id) ?? null;
      next.push({
        key: installation.id,
        name: profile?.name ?? t("agents.control.official.installedSource"),
        agent: null,
        installation,
        update: updateByInstallation.get(installation.id) ?? null,
        profile,
      });
    }
    return next;
  }, [agents, installations, profiles, t, updates]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (
        normalizedQuery &&
        !item.name.toLocaleLowerCase().includes(normalizedQuery)
      ) {
        return false;
      }
      if (filter === "installed") return item.installation !== null;
      if (filter === "updates") return item.update !== null;
      return true;
    });
  }, [filter, items, query]);

  const selected = items.find((item) => item.key === selectedKey) ?? null;

  useEffect(() => {
    if (!selected?.agent || !online) {
      setDetail(null);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    void window.agenteraAgents
      .getOfficialAgentDetail(selected.agent.definitionId)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setDetailError(t(`agents.control.errors.${result.errorCode}`));
          return;
        }
        setDetail(result.data);
      })
      .catch(() => {
        if (!cancelled) {
          setDetailError(t("agents.control.errors.operation_failed"));
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [online, selected?.agent, t]);

  const detailTags = useMemo(() => {
    if (!selected) return [];
    const tags: string[] = [];
    if (detail) {
      if (detail.assetCounts.skill > 0) {
        tags.push(
          t("agents.hub.skillTag", { count: detail.assetCounts.skill }),
        );
      }
      if (detail.assetCounts.sop > 0) {
        tags.push(t("agents.hub.sopTag", { count: detail.assetCounts.sop }));
      }
      if (detail.assetCounts.knowledge > 0) {
        tags.push(
          t("agents.hub.knowledgeTag", {
            count: detail.assetCounts.knowledge,
          }),
        );
      }
      if (detail.allowedToolCount > 0) {
        tags.push(t("agents.hub.toolTag", { count: detail.allowedToolCount }));
      }
      for (const model of detail.allowedModels.slice(0, 2)) {
        tags.push(model.split("/").pop() ?? model);
      }
    }
    if (tags.length === 0) {
      tags.push(
        selected.agent?.channel === "internal"
          ? t("agents.control.official.internalChannel")
          : t("agents.control.official.stableChannel"),
      );
      tags.push(t("agents.hub.localMemoryTag"));
      tags.push(t("agents.hub.isolatedProfileTag"));
    }
    return tags.slice(0, 6);
  }, [detail, selected, t]);

  const closeDetail = (): void => {
    setSelectedKey(null);
    setDetail(null);
    setDetailError(null);
  };

  return (
    <>
      {filteredItems.length === 0 ? (
        <div className="agent-hub-empty agent-hub-empty-compact">
          <div className="agent-hub-empty-icon">
            <Sparkles size={28} />
          </div>
          <strong>
            {query
              ? t("agents.hub.noSearchResults")
              : t(
                  online
                    ? "agents.control.official.noAgents"
                    : "agents.control.official.noInstalledOffline",
                )}
          </strong>
          <p>
            {online
              ? t("agents.hub.officialEmptyHint")
              : t("agents.hub.officialOfflineHint")}
          </p>
        </div>
      ) : (
        <div className="agent-hub-grid" data-testid="official-agent-grid">
          {filteredItems.map((item) => {
            const iconSrc = iconDataUrl(item.agent);
            return (
              <button
                key={item.key}
                type="button"
                className="agent-hub-card"
                onClick={() => setSelectedKey(item.key)}
              >
                <div className="agent-hub-card-heading">
                  <div className="agent-hub-card-avatar official">
                    {iconSrc ? <img src={iconSrc} alt="" /> : <Bot size={24} />}
                  </div>
                  <div className="agent-hub-card-title-group">
                    <strong>{item.name}</strong>
                    <span>{t("agents.hub.officialPublisher")}</span>
                  </div>
                  {item.installation ? (
                    <span className="agent-hub-card-state installed">
                      <Check size={12} />
                      {t("agents.hub.installed")}
                    </span>
                  ) : null}
                </div>
                <p>
                  {t("agents.hub.officialCardDescription", {
                    name: item.name,
                  })}
                </p>
                <div className="agent-hub-card-tags">
                  <span>{t("agents.control.official.badge")}</span>
                  <span>
                    {item.agent?.channel === "internal"
                      ? t("agents.control.official.internalChannel")
                      : t("agents.control.official.stableChannel")}
                  </span>
                  {item.update ? (
                    <span className="update">
                      <Refresh size={11} />
                      {t("agents.hub.updateAvailable")}
                    </span>
                  ) : item.agent ? (
                    <span>v{item.agent.versionNumber}</span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selected ? (
        <AgentHubDetailDialog
          open
          onClose={closeDetail}
          name={selected.name}
          eyebrow={t("agents.hub.officialPublisher")}
          meta={
            selected.installation
              ? t("agents.hub.installed")
              : t("agents.hub.readyToInstall")
          }
          iconSrc={iconDataUrl(selected.agent)}
          description={
            detail?.capabilitySummary ??
            t("agents.hub.officialDetailFallback", { name: selected.name })
          }
          tags={detailTags}
          examples={[
            t("agents.hub.exampleIntroduce", { name: selected.name }),
            t("agents.hub.examplePlan"),
            t("agents.hub.exampleExecute"),
          ]}
          loading={detailLoading}
          error={detailError}
          primaryAction={
            selected.profile && onChatWithProfile
              ? {
                  label: t("agents.hub.useAgent"),
                  kind: "chat",
                  onClick: () => {
                    onChatWithProfile(selected.profile!.id);
                    closeDetail();
                  },
                }
              : !selected.installation && selected.agent
                ? {
                    label: t("agents.hub.installAgent"),
                    disabled: !online || installBusy,
                    onClick: () => {
                      onInstall(selected.agent!.definitionId);
                      closeDetail();
                    },
                  }
                : {
                    label: t("agents.hub.localProfileUnavailable"),
                    disabled: true,
                    onClick: () => undefined,
                  }
          }
          extraActions={
            selected.installation && selected.update
              ? [
                  {
                    label:
                      busyInstallationId === selected.installation.id
                        ? t("agents.control.official.applyingUpdate")
                        : t("agents.control.official.applyUpdate"),
                    disabled:
                      !online ||
                      busyInstallationId === selected.installation.id,
                    onClick: () => onApplyUpdate(selected.installation!.id),
                  },
                ]
              : []
          }
        />
      ) : null}
    </>
  );
}
