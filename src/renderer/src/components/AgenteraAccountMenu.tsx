import { useState } from "react";
import type { AgenteraAuthPublicState } from "../../../shared/agentera-auth";
import {
  ChevronUp,
  CircleDollarSign,
  ExternalLink,
  Laptop,
  LogOut,
  RefreshCw,
  UserRound,
} from "lucide-react";
import { useI18n } from "./useI18n";

type AuthorizedState = Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
>;

export interface AgenteraAccountActions {
  onManageAccount?: () => Promise<void>;
  onManageDevices?: () => Promise<void>;
  onRecharge?: () => Promise<void>;
  onSwitchAccount?: () => Promise<void>;
  onSignOut?: () => Promise<void>;
}

function defaultActions(): Required<AgenteraAccountActions> {
  return {
    onManageAccount: () => window.agenteraAuth.openPortal("account"),
    onManageDevices: () => window.agenteraAuth.openPortal("devices"),
    onRecharge: () => window.agenteraAuth.openPortal("recharge"),
    onSwitchAccount: async () => {
      await window.agenteraAuth.logout();
      await window.agenteraAuth.startLogin({ forceAccountSelection: true });
    },
    onSignOut: () => window.agenteraAuth.logout(),
  };
}

export default function AgenteraAccountMenu({
  state,
  ...providedActions
}: { state: AuthorizedState } & AgenteraAccountActions): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const actions = { ...defaultActions(), ...providedActions };

  const run = (action: () => Promise<void>): void => {
    setOpen(false);
    setBusy(true);
    setError(false);
    void action()
      .catch(() => setError(true))
      .finally(() => setBusy(false));
  };

  const items = [
    {
      label: "auth.account.manage",
      icon: ExternalLink,
      action: actions.onManageAccount,
      danger: false,
    },
    {
      label: "auth.account.devices",
      icon: Laptop,
      action: actions.onManageDevices,
      danger: false,
    },
    {
      label: "auth.account.recharge",
      icon: CircleDollarSign,
      action: actions.onRecharge,
      danger: false,
    },
    {
      label: "auth.account.switch",
      icon: RefreshCw,
      action: actions.onSwitchAccount,
      danger: false,
    },
    {
      label: "auth.account.signOut",
      icon: LogOut,
      action: actions.onSignOut,
      danger: true,
    },
  ] as const;

  return (
    <div className="agentera-account-menu-root">
      {open && (
        <div className="agentera-account-menu" role="menu">
          <div className="agentera-account-menu-summary">
            <strong>{t("auth.account.title")}</strong>
            <span>
              {state.status === "offline"
                ? t("auth.account.offline")
                : t("auth.account.online")}
            </span>
            <code>{state.userId.slice(0, 8)}…</code>
          </div>
          {items.map(({ label, icon: Icon, action, ...item }) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className={item.danger ? "is-danger" : undefined}
              onClick={() => run(action)}
              disabled={busy}
            >
              <Icon size={15} aria-hidden="true" />
              {t(label)}
            </button>
          ))}
          {error && (
            <p className="agentera-account-menu-error" role="alert">
              {t("auth.account.actionFailed")}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        className="agentera-account-trigger"
        aria-label={t("auth.account.openMenu")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
      >
        <span className="agentera-account-avatar">
          <UserRound size={15} aria-hidden="true" />
        </span>
        <span className="agentera-account-trigger-copy">
          <strong>{t("auth.account.title")}</strong>
          <small>
            {state.status === "offline"
              ? t("auth.account.offline")
              : t("auth.account.online")}
          </small>
        </span>
        <ChevronUp size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
