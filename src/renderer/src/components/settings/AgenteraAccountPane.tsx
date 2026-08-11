import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import type { AgenteraUserProfileInput } from "../../../../shared/agentera-user-profile";
import {
  Camera,
  Check,
  CircleDollarSign,
  ExternalLink,
  Laptop,
  LogOut,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import { useI18n } from "../useI18n";
import type { AgenteraAccountActions } from "../AgenteraAccountMenu";
import ProfileAvatar from "../common/ProfileAvatar";
import { useAgenteraUserProfile } from "../useAgenteraUserProfile";
import { fileToAvatarDataUrl } from "../../utils/imageResize";
import DesktopControlStatusCard from "./DesktopControlStatusCard";

type ProfileFeedback =
  | "saved"
  | "nameRequired"
  | "uploadFailed"
  | "saveFailed"
  | null;

const EMPTY_PROFILE_INPUT: AgenteraUserProfileInput = {
  displayName: "",
  occupation: "",
  bio: "",
  avatarDataUrl: null,
};

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
  const [profileDraft, setProfileDraft] =
    useState<AgenteraUserProfileInput>(EMPTY_PROFILE_INPUT);
  const [profileSaving, setProfileSaving] = useState(false);
  const [avatarLoading, setAvatarLoading] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState<ProfileFeedback>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const state = providedState ?? observedState;
  const activeUserId =
    state.status === "authenticated" || state.status === "offline"
      ? state.userId
      : null;
  const {
    profile,
    loading: profileLoading,
    save: saveProfile,
  } = useAgenteraUserProfile(activeUserId);
  const defaultDisplayName = activeUserId
    ? `${t("auth.account.defaultDisplayName")} ${activeUserId.slice(0, 8)}`
    : t("auth.account.defaultDisplayName");

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

  useEffect(() => {
    if (!activeUserId || profile.userId !== activeUserId) return;
    setProfileDraft({
      displayName: profile.displayName || defaultDisplayName,
      occupation: profile.occupation,
      bio: profile.bio,
      avatarDataUrl: profile.avatarDataUrl,
    });
  }, [activeUserId, defaultDisplayName, profile]);

  useEffect(() => {
    setProfileFeedback(null);
  }, [activeUserId]);

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

  const updateProfileDraft = (
    field: "displayName" | "occupation" | "bio",
    value: string,
  ): void => {
    setProfileDraft((current) => ({ ...current, [field]: value }));
    setProfileFeedback(null);
  };

  const handleAvatarFile = async (
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setAvatarLoading(true);
    setProfileFeedback(null);
    try {
      const avatarDataUrl = await fileToAvatarDataUrl(file, 160);
      setProfileDraft((current) => ({ ...current, avatarDataUrl }));
    } catch {
      setProfileFeedback("uploadFailed");
    } finally {
      setAvatarLoading(false);
    }
  };

  const handleSaveProfile = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const input: AgenteraUserProfileInput = {
      displayName: profileDraft.displayName.trim(),
      occupation: profileDraft.occupation.trim(),
      bio: profileDraft.bio.trim(),
      avatarDataUrl: profileDraft.avatarDataUrl,
    };
    if (!input.displayName) {
      setProfileFeedback("nameRequired");
      return;
    }

    setProfileSaving(true);
    setProfileFeedback(null);
    void saveProfile(input)
      .then((saved) => {
        setProfileDraft({
          displayName: saved.displayName,
          occupation: saved.occupation,
          bio: saved.bio,
          avatarDataUrl: saved.avatarDataUrl,
        });
        setProfileFeedback("saved");
      })
      .catch(() => setProfileFeedback("saveFailed"))
      .finally(() => setProfileSaving(false));
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
            <UserRound size={18} aria-hidden="true" />
          </span>
          <div className="settings-card-headtext">
            <div className="settings-card-title">
              {t("auth.account.profile.title")}
            </div>
            <div className="settings-card-sub">
              {t("auth.account.profile.description")}
            </div>
          </div>
        </header>
        <form
          className="settings-card-body agentera-profile-form"
          aria-busy={profileLoading || profileSaving || avatarLoading}
          noValidate
          onSubmit={handleSaveProfile}
        >
          {profileLoading ? (
            <div className="agentera-profile-loading" role="status">
              {t("auth.account.profile.loading")}
            </div>
          ) : (
            <>
              <div className="agentera-profile-editor">
                <div className="agentera-profile-avatar-editor">
                  <ProfileAvatar
                    name={profileDraft.displayName || defaultDisplayName}
                    avatar={profileDraft.avatarDataUrl}
                    size={76}
                    defaultLogo={false}
                    className="agentera-profile-avatar-preview"
                  />
                  <input
                    ref={avatarInputRef}
                    className="agentera-profile-avatar-input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-label={t("auth.account.profile.uploadAvatar")}
                    onChange={(event) => void handleAvatarFile(event)}
                  />
                  <div className="agentera-profile-avatar-actions">
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={
                        profileLoading || profileSaving || avatarLoading
                      }
                      onClick={() => avatarInputRef.current?.click()}
                    >
                      <Camera size={14} aria-hidden="true" />
                      {avatarLoading
                        ? t("auth.account.profile.processingAvatar")
                        : t("auth.account.profile.uploadAvatar")}
                    </button>
                    {profileDraft.avatarDataUrl && (
                      <button
                        className="btn btn-ghost"
                        type="button"
                        disabled={profileSaving || avatarLoading}
                        onClick={() => {
                          setProfileDraft((current) => ({
                            ...current,
                            avatarDataUrl: null,
                          }));
                          setProfileFeedback(null);
                        }}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                        {t("auth.account.profile.removeAvatar")}
                      </button>
                    )}
                  </div>
                  <span className="agentera-profile-avatar-hint">
                    {t("auth.account.profile.avatarHint")}
                  </span>
                </div>

                <div className="agentera-profile-fields">
                  <div className="settings-field">
                    <label
                      className="settings-field-label"
                      htmlFor="agentera-profile-display-name"
                    >
                      {t("auth.account.profile.displayName")}
                    </label>
                    <input
                      id="agentera-profile-display-name"
                      className="input"
                      type="text"
                      autoComplete="nickname"
                      maxLength={80}
                      required
                      disabled={profileLoading || profileSaving}
                      placeholder={t(
                        "auth.account.profile.displayNamePlaceholder",
                      )}
                      value={profileDraft.displayName}
                      onChange={(event) =>
                        updateProfileDraft("displayName", event.target.value)
                      }
                    />
                  </div>
                  <div className="settings-field">
                    <label
                      className="settings-field-label"
                      htmlFor="agentera-profile-occupation"
                    >
                      {t("auth.account.profile.occupation")}
                    </label>
                    <input
                      id="agentera-profile-occupation"
                      className="input"
                      type="text"
                      autoComplete="organization-title"
                      maxLength={80}
                      disabled={profileLoading || profileSaving}
                      placeholder={t(
                        "auth.account.profile.occupationPlaceholder",
                      )}
                      value={profileDraft.occupation}
                      onChange={(event) =>
                        updateProfileDraft("occupation", event.target.value)
                      }
                    />
                  </div>
                  <div className="settings-field agentera-profile-bio-field">
                    <label
                      className="settings-field-label"
                      htmlFor="agentera-profile-bio"
                    >
                      {t("auth.account.profile.bio")}
                    </label>
                    <textarea
                      id="agentera-profile-bio"
                      className="input agentera-profile-bio"
                      maxLength={500}
                      rows={4}
                      disabled={profileLoading || profileSaving}
                      placeholder={t("auth.account.profile.bioPlaceholder")}
                      value={profileDraft.bio}
                      onChange={(event) =>
                        updateProfileDraft("bio", event.target.value)
                      }
                    />
                    <span className="agentera-profile-character-count">
                      {profileDraft.bio.length}/500
                    </span>
                  </div>
                </div>
              </div>

              <div className="agentera-profile-form-footer">
                <span className="agentera-profile-local-note">
                  {t("auth.account.profile.localOnly")}
                </span>
                <div className="agentera-profile-save-area">
                  {profileFeedback && (
                    <span
                      className={`agentera-profile-feedback ${
                        profileFeedback === "saved" ? "is-success" : "is-error"
                      }`}
                      role={profileFeedback === "saved" ? "status" : "alert"}
                    >
                      {profileFeedback === "saved" && (
                        <Check size={14} aria-hidden="true" />
                      )}
                      {t(`auth.account.profile.${profileFeedback}`)}
                    </span>
                  )}
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={profileSaving || avatarLoading}
                  >
                    <Save size={14} aria-hidden="true" />
                    {profileSaving
                      ? t("auth.account.profile.saving")
                      : t("auth.account.profile.save")}
                  </button>
                </div>
              </div>
            </>
          )}
        </form>
      </section>

      <DesktopControlStatusCard />

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
