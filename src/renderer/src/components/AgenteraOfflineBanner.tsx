import type { AgenteraAuthPublicState } from "../../../shared/agentera-auth";
import { CloudOff } from "lucide-react";
import { useI18n } from "./useI18n";

export default function AgenteraOfflineBanner({
  state,
}: {
  state: AgenteraAuthPublicState;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (state.status !== "offline") return null;

  return (
    <div className="agentera-offline-banner" role="status">
      <CloudOff size={15} aria-hidden="true" />
      <div>
        <strong>{t("auth.offline.title")}</strong>
        <span>{t("auth.offline.description")}</span>
      </div>
    </div>
  );
}
