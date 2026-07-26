import { useState } from "react";
import {
  hasAgenteraSignedInAccess,
  type AgenteraDesktopAccessState,
  type AgenteraSignedInAuthState,
} from "../../../shared/agentera-auth";
import {
  ChevronUp,
  CircleDollarSign,
  ExternalLink,
  Laptop,
  LogIn,
  LogOut,
  RefreshCw,
  Settings,
} from "lucide-react";
import { useI18n } from "./useI18n";
import ProfileAvatar from "./common/ProfileAvatar";
import { useAgenteraUserProfile } from "./useAgenteraUserProfile";

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

interface AgenteraAccountMenuProps extends AgenteraAccountMenuActions {
  state: AgenteraDesktopAccessState;
  onSignIn?: () => void | Promise<void>;
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

function AgenteraGuestLogin({
  onSignIn,
}: {
  onSignIn?: () => void | Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const signIn = (): void => {
    if (busy) return;
    setBusy(true);
    setError(false);
    void Promise.resolve()
      .then(onSignIn ?? (() => window.agenteraAuth.startLogin()))
      .catch(() => setError(true))
      .finally(() => setBusy(false));
  };

  return (
    <div className="agentera-account-menu-root">
      <button
        type="button"
        className="agentera-account-trigger agentera-guest-login"
        aria-label={t("auth.account.signIn")}
        onClick={signIn}
        disabled={busy}
      >
        <span className="agentera-account-avatar" aria-hidden="true">
          <LogIn size={15} />
        </span>
        <span className="agentera-account-trigger-copy">
          <strong>{t("auth.account.signIn")}</strong>
          <small>
            {busy ? t("auth.account.signingIn") : t("auth.account.guestLocal")}
          </small>
        </span>
      </button>
      {error && (
        <p className="agentera-account-menu-error" role="alert">
          {t("auth.account.actionFailed")}
        </p>
      )}
    </div>
  );
}

function SignedInAgenteraAccountMenu({
  state,
  ...providedActions
}: {
  state: AgenteraSignedInAuthState;
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

export default function AgenteraAccountMenu({
  state,
  onSignIn,
  ...providedActions
}: AgenteraAccountMenuProps): React.JSX.Element {
  if (!hasAgenteraSignedInAccess(state)) {
    return <AgenteraGuestLogin onSignIn={onSignIn} />;
  }
  return <SignedInAgenteraAccountMenu state={state} {...providedActions} />;
}
