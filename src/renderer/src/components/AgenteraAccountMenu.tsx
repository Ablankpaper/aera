import { useState } from "react";
import type { AgenteraAuthPublicState } from "../../../shared/agentera-auth";
import {
  ChevronUp,
  CircleDollarSign,
  ExternalLink,
  Laptop,
  LogOut,
  RefreshCw,
  Settings,
} from "lucide-react";
import { useI18n } from "./useI18n";
import ProfileAvatar from "./common/ProfileAvatar";
import { useAgenteraUserProfile } from "./useAgenteraUserProfile";

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

interface AgenteraAccountMenuActions extends AgenteraAccountActions {
  onOpenSettings?: () => void | Promise<void>;
}

function defaultActions(): Required<AgenteraAccountMenuActions> {
  return {
    onManageAccount: () => window.agenteraAuth.openPortal("account"),
    onManageDevices: () => window.agenteraAuth.openPortal("devices"),
    onRecharge: () => window.agenteraAuth.openPortal("recharge"),
    onSwitchAccount: async () => {
      await window.agenteraAuth.logout();
      await window.agenteraAuth.startLogin({ forceAccountSelection: true });
    },
    onOpenSettings: () => undefined,
    onSignOut: () => window.agenteraAuth.logout(),
  };
}

export default function AgenteraAccountMenu({
  state,
  ...providedActions
}: {
  state: AuthorizedState;
} & AgenteraAccountMenuActions): React.JSX.Element {
  const { t } = useI18n();
  const { profile } = useAgenteraUserProfile(state.userId);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const actions = { ...defaultActions(), ...providedActions };
  const displayName =
    profile.displayName ||
    `${t("auth.account.defaultDisplayName")} ${state.userId.slice(0, 8)}`;

  const run = (action: () => void | Promise<void>): void => {
    setOpen(false);
    setBusy(true);
    setError(false);
    void Promise.resolve()
      .then(action)
      .catch(() => setError(true))
      .finally(() => setBusy(false));
  };

  const items = [
    {
      label: "auth.account.manage",
      icon: ExternalLink,
      action: actions.onManageAccount,
      danger: false,
      dividerBefore: false,
    },
    {
      label: "auth.account.devices",
      icon: Laptop,
      action: actions.onManageDevices,
      danger: false,
      dividerBefore: false,
    },
    {
      label: "auth.account.recharge",
      icon: CircleDollarSign,
      action: actions.onRecharge,
      danger: false,
      dividerBefore: false,
    },
    {
      label: "auth.account.switch",
      icon: RefreshCw,
      action: actions.onSwitchAccount,
      danger: false,
      dividerBefore: false,
    },
    {
      label: "navigation.settings",
      icon: Settings,
      action: actions.onOpenSettings,
      danger: false,
      dividerBefore: false,
    },
    {
      label: "auth.account.signOut",
      icon: LogOut,
      action: actions.onSignOut,
      danger: true,
      dividerBefore: true,
    },
  ] as const;

  return (
    <div className="agentera-account-menu-root">
      {open && (
        <div className="agentera-account-menu" role="menu">
          <div className="agentera-account-menu-summary">
            <strong>{displayName}</strong>
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
              className={[
                item.danger ? "is-danger" : "",
                item.dividerBefore ? "has-divider" : "",
              ]
                .filter(Boolean)
                .join(" ")}
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
        <ProfileAvatar
          name={displayName}
          avatar={profile.avatarDataUrl}
          size={28}
          defaultLogo={false}
          className="agentera-account-avatar"
        />
        <span className="agentera-account-trigger-copy">
          <strong title={displayName}>{displayName}</strong>
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
