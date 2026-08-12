import { memo } from "react";
import { ArrowRight, GitBranch } from "lucide-react";
import { useI18n } from "../../components/useI18n";
import type { ModelSwitchMessage } from "./types";

function RouteLabel({
  route,
  previous,
}: {
  route: ModelSwitchMessage["from"];
  previous?: boolean;
}): React.JSX.Element {
  const provider = route.provider.trim();
  const model = route.model.trim();
  return (
    <span className="chat-model-switch-marker-route">
      {provider && <span>{provider} · </span>}
      <span
        className={
          previous ? "chat-model-switch-marker-previous-model" : undefined
        }
      >
        {model}
      </span>
    </span>
  );
}

export const ModelSwitchMarker = memo(function ModelSwitchMarker({
  message,
}: {
  message: ModelSwitchMessage;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div
      className="chat-model-switch-marker"
      data-testid="model-switch-marker"
      role="status"
      aria-label={t("chat.modelSwitch.marker")}
    >
      <GitBranch size={13} aria-hidden />
      <span className="chat-model-switch-marker-label">
        {t("chat.modelSwitch.marker")}
      </span>
      <RouteLabel route={message.from} previous />
      <ArrowRight size={12} aria-hidden />
      <RouteLabel route={message.to} />
    </div>
  );
});
