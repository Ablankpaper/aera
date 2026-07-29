import { memo, useEffect, useState } from "react";
import { Bot, CheckCircle2 } from "lucide-react";
import { useI18n } from "../../components/useI18n";
import type { AgentCreationGuideMessage } from "./types";
import type { AgentCreationInput } from "./hooks/useAgentCreationGuide";

interface AgentCreationGuideCardProps {
  message: AgentCreationGuideMessage;
  onConfirm: (messageId: string, input: AgentCreationInput) => void;
  onDismiss: (messageId: string) => void;
  onOpenMyAgents?: () => void;
}

function targetKey(message: AgentCreationGuideMessage): string {
  return `chat.agentCreation.target.${message.target?.scope ?? "UNKNOWN"}`;
}

function errorKey(message: AgentCreationGuideMessage): string {
  if (message.errorCode === "context_changed") {
    return "chat.agentCreation.contextChanged";
  }
  if (message.errorCode === "service_unavailable") {
    return "chat.agentCreation.serviceUnavailable";
  }
  return message.errorCode
    ? `agents.control.errors.${message.errorCode}`
    : "chat.agentCreation.createFailed";
}

export const AgentCreationGuideCard = memo(function AgentCreationGuideCard({
  message,
  onConfirm,
  onDismiss,
  onOpenMyAgents,
}: AgentCreationGuideCardProps): React.JSX.Element {
  const { t } = useI18n();
  const defaultName = t("chat.agentCreation.defaultName");
  const [name, setName] = useState(
    message.suggestedName || defaultName,
  );
  const [purpose, setPurpose] = useState(message.suggestedPurpose);

  useEffect(() => {
    setName(message.suggestedName || defaultName);
    setPurpose(message.suggestedPurpose);
  }, [
    defaultName,
    message.id,
    message.suggestedName,
    message.suggestedPurpose,
  ]);

  if (message.status === "created") {
    return (
      <section className="chat-agent-creation chat-agent-creation--created">
        <div className="chat-agent-creation-heading">
          <CheckCircle2 size={19} aria-hidden="true" />
          <div>
            <div className="chat-agent-creation-title">
              {t("chat.agentCreation.createdTitle", {
                name: message.createdName ?? name,
              })}
            </div>
            <p>{t("chat.agentCreation.createdDescription")}</p>
          </div>
        </div>
        <div className="chat-agent-creation-actions">
          <button
            type="button"
            className="chat-agent-creation-secondary"
            onClick={() => onDismiss(message.id)}
          >
            {t("chat.agentCreation.done")}
          </button>
          {onOpenMyAgents && (
            <button
              type="button"
              className="chat-agent-creation-primary"
              onClick={onOpenMyAgents}
            >
              {t("chat.agentCreation.openMyAgents")}
            </button>
          )}
        </div>
      </section>
    );
  }

  const resolving = message.status === "resolving";
  const creating = message.status === "creating";
  const canSubmit =
    Boolean(message.target) && name.trim().length > 0 && !creating;

  return (
    <section
      className={`chat-agent-creation chat-agent-creation--${message.status}`}
    >
      <div className="chat-agent-creation-heading">
        <Bot size={19} aria-hidden="true" />
        <div>
          <div className="chat-agent-creation-title">
            {t("chat.agentCreation.title")}
          </div>
          <p>{t("chat.agentCreation.description")}</p>
        </div>
      </div>

      {resolving ? (
        <div className="chat-agent-creation-status" role="status">
          {t("chat.agentCreation.resolving")}
        </div>
      ) : (
        <>
          <div className="chat-agent-creation-target">
            <span>{t("chat.agentCreation.targetLabel")}</span>
            <strong>{t(targetKey(message))}</strong>
          </div>
          <label>
            <span>{t("chat.agentCreation.name")}</span>
            <input
              value={name}
              maxLength={40}
              disabled={creating}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>{t("chat.agentCreation.purpose")}</span>
            <textarea
              value={purpose}
              maxLength={500}
              disabled={creating}
              placeholder={t("chat.agentCreation.purposePlaceholder")}
              onChange={(event) => setPurpose(event.target.value)}
            />
            <small>{t("chat.agentCreation.defaultHint")}</small>
          </label>
        </>
      )}

      {message.status === "error" && (
        <div className="chat-agent-creation-error" role="alert">
          {t(errorKey(message))}
        </div>
      )}

      <div className="chat-agent-creation-actions">
        <button
          type="button"
          className="chat-agent-creation-secondary"
          disabled={creating}
          onClick={() => onDismiss(message.id)}
        >
          {t("chat.agentCreation.cancel")}
        </button>
        {!resolving && (
          <button
            type="button"
            className="chat-agent-creation-primary"
            disabled={!canSubmit}
            onClick={() =>
              onConfirm(message.id, {
                name: name.trim(),
                purpose: purpose.trim(),
              })
            }
          >
            {t(
              creating
                ? "chat.agentCreation.creating"
                : message.status === "error"
                  ? "chat.agentCreation.retry"
                  : "chat.agentCreation.createDraft",
            )}
          </button>
        )}
      </div>
    </section>
  );
});
