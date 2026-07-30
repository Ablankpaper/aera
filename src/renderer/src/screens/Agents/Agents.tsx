import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
  onChatWith: (name: string) => void;
}

export function selectAgentModelProfileId(
  profiles: readonly ProfileInfo[],
  activeProfile: string,
): string | undefined {
  const isConfigured = (profile: ProfileInfo): boolean =>
    profile.provider.trim().length > 0 &&
    profile.provider.trim().toLocaleLowerCase() !== "auto" &&
    profile.model.trim().length > 0;
  const accountProfile = profiles.find(
    (profile) => !profile.agentInstallationId && isConfigured(profile),
  );
  if (accountProfile) return accountProfile.id;
  const active = profiles.find((profile) => profile.id === activeProfile);
  if (active && isConfigured(active)) return active.id;
  return profiles.find(isConfigured)?.id;
}

function Agents({ activeProfile, onChatWith }: AgentsProps): React.JSX.Element {
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const modelProfileId = useMemo(
    () => selectAgentModelProfileId(profiles, activeProfile),
    [activeProfile, profiles],
  );
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

  const loadProfiles = useCallback(async (): Promise<ProfileInfo[]> => {
    const list = await window.hermesAPI.listProfiles();
    setProfiles(list);
    return list;
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  useEffect(
    () =>
      window.hermesAPI.onModelLibraryChanged(() => {
        void loadProfiles();
      }),
    [loadProfiles],
  );

  // Cloud sync: null while the signed-in state is still loading.
  const [, setSyncStatus] = useState<AgentSyncStatus | null>(null);
  const autoSyncedRef = useRef(false);

  const refreshSyncStatus = useCallback(async (): Promise<void> => {
    try {
      setSyncStatus(await window.hermesAPI.getAgentSyncStatus());
    } catch {
      // Bridge unavailable (tests/old preload): leave the affordance hidden.
    }
  }, []);

  const runSync = useCallback(async (): Promise<void> => {
    try {
      const result = await window.hermesAPI.syncAgents();
      setSyncStatus((s) => (s ? { ...s, lastResult: result } : s));
      if (result.outcomes.some((o) => o.action === "created-local")) {
        await loadProfiles();
      }
    } catch {
      // Surfaced through lastResult on the next status refresh.
    } finally {
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

  const handleAgentReady = useCallback(
    async (installationId: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const list = await loadProfiles();
        const installed = list.find(
          (profile) => profile.agentInstallationId === installationId,
        );
        if (installed) {
          await window.hermesAPI.setActiveProfile(installed.id);
          onChatWith(installed.id);
          return true;
        }
        if (attempt < 2) {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 75);
          });
        }
      }
      return false;
    },
    [loadProfiles, onChatWith],
  );

  return (
    <div className="agents-container">
      <AgentControlPanel
        profiles={agentProfiles}
        initialTab="mine"
        onChatWithProfile={(profileId) => void handleChatWith(profileId)}
        onProfilesChanged={loadProfiles}
        onAgentReady={handleAgentReady}
        modelProfileId={modelProfileId}
      />
    </div>
  );
}

export default Agents;
