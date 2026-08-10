import { Activity } from "lucide-react";
import { useEffect, useState } from "react";
import type { DesktopControlPublicState } from "../../../../shared/agentera-desktop-control";
import { useI18n } from "../useI18n";

const INITIAL_STATE: DesktopControlPublicState = {
  status: "unregistered",
  lastHeartbeatAt: null,
  lastErrorCode: null,
  lastHealth: null,
};

export default function DesktopControlStatusCard({
  state: providedState,
}: {
  state?: DesktopControlPublicState;
}): React.JSX.Element {
  const { t } = useI18n();
  const [observedState, setObservedState] =
    useState<DesktopControlPublicState>(INITIAL_STATE);
  const state = providedState ?? observedState;

  useEffect(() => {
    if (providedState) return;
    const api = window.agenteraDesktopControl;
    if (!api) return;
    let active = true;
    void api.getState().then((next) => {
      if (active) setObservedState(next);
    });
    const unsubscribe = api.onStateChanged((next) => {
      if (active) setObservedState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [providedState]);

  return (
    <section
      className="settings-card"
      data-testid="desktop-control-status-card"
    >
      <header className="settings-card-head">
        <span className="settings-card-icon">
          <Activity size={18} aria-hidden="true" />
        </span>
        <div className="settings-card-headtext">
          <div className="settings-card-title">
            {t("auth.account.desktopControl.title")}
          </div>
          <div
            className="settings-card-sub"
            data-testid="desktop-control-status"
          >
            {t(`auth.account.desktopControl.status.${state.status}`)}
          </div>
        </div>
      </header>
      <div className="settings-card-body">
        <div className="settings-meta-grid">
          <div className="settings-meta">
            <span className="settings-meta-label">
              {t("auth.account.desktopControl.lastHeartbeat")}
            </span>
            <span className="settings-meta-value">
              {state.lastHeartbeatAt
                ? new Date(state.lastHeartbeatAt).toLocaleString()
                : t("auth.account.desktopControl.notAvailable")}
            </span>
          </div>
          <div className="settings-meta">
            <span className="settings-meta-label">
              {t("auth.account.desktopControl.lastHealth")}
            </span>
            <span
              className="settings-meta-value"
              data-testid="desktop-health-code"
            >
              {state.lastHealth?.code ??
                t("auth.account.desktopControl.notChecked")}
            </span>
          </div>
        </div>
        {state.lastErrorCode && (
          <p className="settings-field-hint" role="status">
            {t("auth.account.desktopControl.error", {
              code: state.lastErrorCode,
            })}
          </p>
        )}
        <p className="settings-field-hint">
          {t("auth.account.desktopControl.privacy")}
        </p>
      </div>
    </section>
  );
}
