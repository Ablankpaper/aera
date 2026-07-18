import { useEffect, useState } from "react";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import {
  CircleDollarSign,
  ExternalLink,
  Laptop,
  LogOut,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useI18n } from "../useI18n";
import type { AgenteraAccountActions } from "../AgenteraAccountMenu";

export default function AgenteraAccountPane({
  state: providedState,
  ...providedActions
}: {
  state?: AgenteraAuthPublicState;
} & AgenteraAccountActions = {}): React.JSX.Element {
  const { t } = useI18n();
  const [observedState, setObservedState] = useState<AgenteraAuthPublicState>(
    providedState ?? { status: "checking" },
  );
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = providedState ?? observedState;

  useEffect(() => {
    if (providedState) return;
    let active = true;
    void window.agenteraAuth.getState().then((next) => {
      if (active) setObservedState(next);
    });
    const unsubscribe = window.agenteraAuth.onStateChanged((next) => {
      if (active) setObservedState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [providedState]);

  const defaults: Required<AgenteraAccountActions> = {
    onManageAccount: () => window.agenteraAuth.openPortal("account"),
    onManageDevices: () => window.agenteraAuth.openPortal("devices"),
    onRecharge: () => window.agenteraAuth.openPortal("recharge"),
    onSwitchAccount: async () => {
      await window.agenteraAuth.logout();
      await window.agenteraAuth.startLogin({ forceAccountSelection: true });
    },
    onSignOut: () => window.agenteraAuth.logout(),
  };
  const actions = { ...defaults, ...providedActions };
  const run = (action: () => Promise<void>): void => {
    setBusy(true);
    setError(false);
    void action()
      .catch(() => setError(true))
      .finally(() => setBusy(false));
  };

  if (state.status !== "authenticated" && state.status !== "offline") {
    return (
      <div className="settings-modal-pane">
        <p className="settings-field-hint">{t("auth.account.unavailable")}</p>
      </div>
    );
  }

  return (
    <div className="settings-modal-pane">
      <section className="settings-card">
        <header className="settings-card-head">
          <span className="settings-card-icon">
            <ShieldCheck size={18} aria-hidden="true" />
          </span>
          <div className="settings-card-headtext">
            <div className="settings-card-title">{t("auth.account.title")}</div>
            <div className="settings-card-sub">
              {state.status === "offline"
                ? t("auth.account.offline")
                : t("auth.account.online")}
            </div>
          </div>
        </header>
        <div className="settings-card-body">
          <div className="settings-meta-grid">
            <div className="settings-meta">
              <span className="settings-meta-label">
                {t("auth.account.userId")}
              </span>
              <span className="settings-meta-value">
                {state.userId.slice(0, 8)}…
              </span>
            </div>
            <div className="settings-meta">
              <span className="settings-meta-label">
                {t("auth.account.deviceId")}
              </span>
              <span className="settings-meta-value">
                {state.deviceId.slice(0, 8)}…
              </span>
            </div>
          </div>
          <p className="settings-field-hint">
            {t("auth.account.offlineUntil", {
              date: new Date(state.offlineExpiresAt).toLocaleString(),
            })}
          </p>
          <div className="settings-card-actions agentera-account-pane-actions">
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => run(actions.onManageAccount)}
            >
              <ExternalLink size={14} /> {t("auth.account.manage")}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => run(actions.onManageDevices)}
            >
              <Laptop size={14} /> {t("auth.account.devices")}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => run(actions.onRecharge)}
            >
              <CircleDollarSign size={14} /> {t("auth.account.recharge")}
            </button>
          </div>
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-card-body agentera-account-pane-notes">
          <p>{t("auth.account.localDataWarning")}</p>
          <p>{t("auth.account.rechargeSeparateAccount")}</p>
          <p>{t("auth.account.pendingRevocationWarning")}</p>
          {error && <p role="alert">{t("auth.account.actionFailed")}</p>}
          <div className="settings-card-actions agentera-account-pane-actions">
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => run(actions.onSwitchAccount)}
            >
              <RefreshCw size={14} /> {t("auth.account.switch")}
            </button>
            <button
              className="btn btn-secondary danger"
              type="button"
              disabled={busy}
              onClick={() => run(actions.onSignOut)}
            >
              <LogOut size={14} /> {t("auth.account.signOut")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
