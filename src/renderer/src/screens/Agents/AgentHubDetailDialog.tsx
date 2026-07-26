import type { CSSProperties, ReactNode } from "react";
import { Bot, ChatBubble, X } from "../../assets/icons";
import { AppModal, AppModalTitle } from "../../components/modal/AppModal";
import { useI18n } from "../../components/useI18n";

export interface AgentHubDetailAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  kind?: "chat" | "default";
}

export interface AgentHubDetailDialogProps {
  open: boolean;
  onClose: () => void;
  name: string;
  eyebrow: string;
  meta?: string;
  iconSrc?: string | null;
  iconColor?: string;
  icon?: ReactNode;
  description: string;
  tags: string[];
  examples: string[];
  loading?: boolean;
  error?: string | null;
  primaryAction?: AgentHubDetailAction | null;
  secondaryAction?: AgentHubDetailAction | null;
  extraActions?: AgentHubDetailAction[];
}

export default function AgentHubDetailDialog({
  open,
  onClose,
  name,
  eyebrow,
  meta,
  iconSrc,
  iconColor,
  icon,
  description,
  tags,
  examples,
  loading = false,
  error = null,
  primaryAction = null,
  secondaryAction = null,
  extraActions = [],
}: AgentHubDetailDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const iconStyle = {
    "--agent-hub-icon-color": iconColor ?? "var(--accent)",
  } as CSSProperties;

  return (
    <AppModal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      className="agent-hub-detail-modal"
      labelledBy="agent-hub-detail-title"
    >
      <header className="agent-hub-detail-header">
        <div className="agent-hub-detail-identity">
          <div className="agent-hub-detail-avatar" style={iconStyle}>
            {iconSrc ? (
              <img src={iconSrc} alt="" />
            ) : (
              (icon ?? <Bot size={30} />)
            )}
          </div>
          <div>
            <AppModalTitle id="agent-hub-detail-title">{name}</AppModalTitle>
            <div className="agent-hub-detail-meta">
              <span>{eyebrow}</span>
              {meta ? <span>{meta}</span> : null}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="agent-hub-icon-button"
          aria-label={t("agents.control.close")}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>

      <div className="agent-hub-detail-body">
        <section>
          <h3>{t("agents.hub.capabilityTitle")}</h3>
          {loading ? (
            <div className="agent-hub-detail-loading">
              <div className="loading-spinner" />
            </div>
          ) : (
            <p className="agent-hub-detail-description">{description}</p>
          )}
        </section>

        {tags.length > 0 ? (
          <section>
            <h3>{t("agents.hub.expertiseTitle")}</h3>
            <div className="agent-hub-detail-tags">
              {tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          </section>
        ) : null}

        <section>
          <h3>{t("agents.hub.examplesTitle")}</h3>
          <div className="agent-hub-detail-examples">
            {examples.map((example) => (
              <div key={example} className="agent-hub-detail-example">
                <ChatBubble size={15} />
                <span>{example}</span>
              </div>
            ))}
          </div>
        </section>

        {error ? <div className="agents-create-error">{error}</div> : null}

        {extraActions.length > 0 ? (
          <div className="agent-hub-detail-extra-actions">
            {extraActions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={action.disabled}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {primaryAction || secondaryAction ? (
        <footer className="agent-hub-detail-footer">
          {secondaryAction ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={secondaryAction.disabled}
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </button>
          ) : null}
          {primaryAction ? (
            <button
              type="button"
              className="btn btn-primary agent-hub-detail-primary"
              disabled={primaryAction.disabled}
              onClick={primaryAction.onClick}
            >
              {primaryAction.kind === "chat" ? <ChatBubble size={16} /> : null}
              {primaryAction.label}
            </button>
          ) : null}
        </footer>
      ) : null}
    </AppModal>
  );
}
