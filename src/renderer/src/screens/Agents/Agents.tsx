import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { X } from "../../assets/icons";
import { AppModal, AppModalTitle } from "../../components/modal/AppModal";
import { useI18n } from "../../components/useI18n";
import { useProfileModal } from "../../components/profile/ProfileModalContext";
import type {
  AgentSyncResult,
  AgentSyncStatus,
} from "../../../../shared/agent-sync";
import AgentControlPanel from "./AgentControlPanel";

interface ProfileInfo {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
  isActive: boolean;
  model: string;
  provider: string;
  hasEnv: boolean;
  hasSoul: boolean;
  skillCount: number;
  gatewayRunning: boolean;
  color?: string;
  avatar?: string | null;
  agentInstallationId?: string | null;
  runtimeProfileId?: string | null;
}

interface AgentsProps {
  activeProfile: string;
  onSelectProfile: (name: string) => void;
  onChatWith: (name: string) => void;
}

function Agents({
  activeProfile,
  onSelectProfile,
  onChatWith,
}: AgentsProps): React.JSX.Element {
  const { t } = useI18n();
  const { openProfile } = useProfileModal();
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [cloneConfig, setCloneConfig] = useState(true);
  // Source profile to clone config/keys/skills from when `cloneConfig` is on.
  const [cloneSource, setCloneSource] = useState("default");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const agentProfiles = useMemo(
    () =>
      profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        model: profile.model,
        provider: profile.provider,
        skillCount: profile.skillCount,
        gatewayRunning: profile.gatewayRunning,
        color: profile.color,
        avatar: profile.avatar,
        agentInstallationId: profile.agentInstallationId,
        runtimeProfileId: profile.runtimeProfileId,
      })),
    [profiles],
  );

  const loadProfiles = useCallback(async (): Promise<void> => {
    const list = await window.hermesAPI.listProfiles();
    setProfiles(list);
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  // Cloud sync: null while the signed-in state is still loading.
  const [syncStatus, setSyncStatus] = useState<AgentSyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const autoSyncedRef = useRef(false);

  const refreshSyncStatus = useCallback(async (): Promise<void> => {
    try {
      setSyncStatus(await window.hermesAPI.getAgentSyncStatus());
    } catch {
      // Bridge unavailable (tests/old preload): leave the affordance hidden.
    }
  }, []);

  const runSync = useCallback(async (): Promise<void> => {
    setSyncing(true);
    try {
      const result = await window.hermesAPI.syncAgents();
      setSyncStatus((s) => (s ? { ...s, lastResult: result } : s));
      if (result.outcomes.some((o) => o.action === "created-local")) {
        await loadProfiles();
      }
    } catch {
      // Surfaced through lastResult on the next status refresh.
    } finally {
      setSyncing(false);
      void refreshSyncStatus();
    }
  }, [loadProfiles, refreshSyncStatus]);

  // Load the signed-in state once, then run one automatic pass per visit so
  // console-side edits appear without a manual click.
  useEffect(() => {
    void (async () => {
      try {
        const status = await window.hermesAPI.getAgentSyncStatus();
        setSyncStatus(status);
        if (status.signedIn && !status.running && !autoSyncedRef.current) {
          autoSyncedRef.current = true;
          void runSync();
        }
      } catch {
        // Bridge unavailable: leave the affordance hidden.
      }
    })();
  }, [runSync]);

  // Syncs triggered elsewhere (e.g. right after sign-in) refresh the list too.
  useEffect(() => {
    if (!window.hermesAPI.onAgentSyncUpdated) return undefined;
    return window.hermesAPI.onAgentSyncUpdated((result: AgentSyncResult) => {
      setSyncStatus((s) => (s ? { ...s, lastResult: result } : s));
      if (result.outcomes.some((o) => o.action === "created-local")) {
        void loadProfiles();
      }
    });
  }, [loadProfiles]);

  const syncSummary = useCallback(
    (result: AgentSyncResult): string => {
      if (result.status === "unauthorized") return t("agents.syncUnauthorized");
      if (result.status === "error") {
        return result.error || t("agents.syncFailed");
      }
      const counts = { pushed: 0, pulled: 0, created: 0, errors: 0 };
      for (const outcome of result.outcomes) {
        if (
          outcome.action === "pushed" ||
          outcome.action === "created-remote"
        ) {
          counts.pushed += 1;
        } else if (outcome.action === "pulled") {
          counts.pulled += 1;
        }
        if (outcome.action === "created-local") counts.created += 1;
        if (outcome.action === "error") counts.errors += 1;
      }
      if (counts.errors > 0) {
        return t("agents.syncErrors", { count: counts.errors });
      }
      if (counts.pushed + counts.pulled + counts.created === 0) {
        return t("agents.syncUpToDate");
      }
      return t("agents.syncSummary", counts);
    },
    [t],
  );

  const profileSyncLabel = useMemo(() => {
    if (!syncStatus) return null;
    if (!syncStatus.signedIn) return t("agents.syncSignedOut");
    return syncStatus.lastResult
      ? syncSummary(syncStatus.lastResult)
      : (syncStatus.accountLabel ?? t("agents.syncUpToDate"));
  }, [syncStatus, syncSummary, t]);

  const profileSyncTitle = useMemo(() => {
    if (!syncStatus) return undefined;
    if (!syncStatus.signedIn) return t("agents.syncSignedOutHint");
    return (
      syncStatus.lastResult?.outcomes
        .flatMap((outcome) =>
          outcome.warnings.map((warning) => `${outcome.profile}: ${warning}`),
        )
        .join("\n") ||
      syncStatus.accountLabel ||
      undefined
    );
  }, [syncStatus, t]);

  // Open the create modal, defaulting the clone source to the active profile.
  const openCreate = useCallback((): void => {
    setNewName("");
    setError("");
    setCloneConfig(true);
    setCloneSource(activeProfile || "default");
    setShowCreate(true);
  }, [activeProfile]);

  function closeCreate(): void {
    setShowCreate(false);
    setError("");
  }

  async function handleCreate(): Promise<void> {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError("");
    const result = await window.hermesAPI.createProfile(
      name,
      cloneConfig ? cloneSource : null,
    );
    setCreating(false);
    if (result.success) {
      setShowCreate(false);
      setNewName("");
    } else {
      setError(result.error || t("agents.createFailed"));
    }
    loadProfiles();
  }

  // "Chat" button — make the agent active (starts its gateway) then open a
  // conversation with it. The only path here that starts a chat.
  const handleChatWith = useCallback(
    async (name: string): Promise<void> => {
      await window.hermesAPI.setActiveProfile(name);
      onChatWith(name);
      void loadProfiles();
    },
    [loadProfiles, onChatWith],
  );

  const handleEditProfile = useCallback(
    (profileId: string): void => {
      setError("");
      openProfile(profileId, {
        onChanged: loadProfiles,
        onDeleted: (deletedProfileId) => {
          if (activeProfile === deletedProfileId) onSelectProfile("default");
          void loadProfiles();
        },
      });
    },
    [activeProfile, loadProfiles, onSelectProfile, openProfile],
  );

  return (
    <div className="agents-container">
      <AgentControlPanel
        profiles={agentProfiles}
        initialTab="official"
        advancedOpenByDefault={false}
        onChatWithProfile={(profileId) => void handleChatWith(profileId)}
        onEditProfile={handleEditProfile}
        onCreateLocalProfile={openCreate}
        onProfilesChanged={loadProfiles}
        profileSyncLabel={profileSyncLabel}
        profileSyncTitle={profileSyncTitle}
        profileSyncEnabled={Boolean(syncStatus?.signedIn)}
        profileSyncing={syncing}
        onSyncProfiles={() => void runSync()}
      />

      <AppModal
        open={showCreate}
        onOpenChange={(open) => {
          if (!open) closeCreate();
        }}
        className="agents-create-modal"
        labelledBy="agents-create-title"
      >
        <div className="agents-create-modal-header">
          <AppModalTitle
            id="agents-create-title"
            className="agents-create-modal-title"
          >
            {t("agents.createTitle")}
          </AppModalTitle>
          <button
            type="button"
            className="profile-modal-close"
            onClick={closeCreate}
            aria-label={t("common.close")}
          >
            <X size={18} />
          </button>
        </div>
        <div className="agents-create-modal-body">
          <label className="agents-create-field">
            <span>{t("agents.nameLabel")}</span>
            <input
              className="input"
              placeholder={t("agents.namePlaceholder")}
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value);
                setError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleCreate();
              }}
              autoFocus
            />
          </label>
          <label className="agents-create-clone">
            <input
              type="checkbox"
              checked={cloneConfig}
              onChange={(event) => setCloneConfig(event.target.checked)}
            />
            <span>{t("agents.cloneConfig")}</span>
          </label>
          {cloneConfig ? (
            <label className="agents-create-field">
              <span>{t("agents.cloneFromLabel")}</span>
              <select
                className="input"
                value={cloneSource}
                onChange={(event) => setCloneSource(event.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {error ? <div className="agents-create-error">{error}</div> : null}
          <div className="agents-create-modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={closeCreate}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleCreate()}
              disabled={creating || !newName.trim()}
            >
              {creating ? t("agents.creating") : t("agents.create")}
            </button>
          </div>
        </div>
      </AppModal>
    </div>
  );
}

export default Agents;
