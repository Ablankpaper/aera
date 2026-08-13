import { LockKeyhole } from "lucide-react";
import type { AgenteraConversationBoundarySummary } from "../../../../shared/agentera-global-profile";
import { useI18n } from "../../components/useI18n";

interface ConversationBoundaryIndicatorProps {
  boundary: AgenteraConversationBoundarySummary;
  profileId: string;
  agentDisplayName?: string | null;
}

function scopeLabel(
  boundary: AgenteraConversationBoundarySummary,
  t: (key: string) => string,
): string {
  if (boundary.scopeDisplayName) return boundary.scopeDisplayName;
  return t(`chat.boundary.scope.${boundary.scope}`);
}

export function ConversationBoundaryIndicator({
  boundary,
  profileId,
  agentDisplayName,
}: ConversationBoundaryIndicatorProps): React.JSX.Element {
  const { t } = useI18n();
  const displayAgentName =
    profileId === "default"
      ? "default"
      : agentDisplayName?.trim() || t("chat.boundary.unnamedAgent");

  return (
    <div
      className="chat-conversation-boundary"
      aria-label={t("chat.boundary.label")}
    >
      <LockKeyhole size={14} aria-hidden="true" />
      <span>
        {t("chat.boundary.runningIn")}{" "}
        <strong>{scopeLabel(boundary, t)}</strong>
      </span>
      <span className="chat-conversation-boundary-divider" aria-hidden="true" />
      <span>
        {t("chat.boundary.agent")} <strong>{displayAgentName}</strong>
      </span>
      <span className="chat-conversation-boundary-divider" aria-hidden="true" />
      <span>
        {t("chat.boundary.visibility")}{" "}
        <strong>
          {t(`chat.boundary.visibilityValue.${boundary.visibility}`)}
        </strong>
      </span>
    </div>
  );
}
