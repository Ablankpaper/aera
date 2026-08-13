import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type {
  AgentSyncResult,
  AgentSyncStatus,
} from "../../../../shared/agent-sync";
import type { AgentRuntimeModelRouteSource } from "../../../../shared/agentera-agent-control";
import AgentControlPanel, {
  type AgentChatOpenOptions,
} from "./AgentControlPanel";

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
  onChatWith: (name: string, options?: AgentChatOpenOptions) => void;
  onConfigureModels?: () => void;
}

export function selectAgentModelProfileId(
  profiles: readonly ProfileInfo[],
  activeProfile: string,
): string | undefined {
  const isConfigured = (profile: ProfileInfo): boolean =>
    profile.provider.trim().length > 0 &&
    profile.provider.trim().toLocaleLowerCase() !== "auto" &&
    profile.model.trim().length > 0;
  // list-profiles is already restricted by the main process to Profiles bound
  // to the current owner. Follow the active configured Profile first even when
  // it belongs to an installed Agent: Model Center writes the selected service
  // to that Profile, and skipping it would reopen a stale account Profile and
  // expose only that old route's model catalog in the Agent editor.
  const active = profiles.find((profile) => profile.id === activeProfile);
  if (active && isConfigured(active)) return active.id;
  const accountProfile = profiles.find(
    (profile) => !profile.agentInstallationId && isConfigured(profile),
  );
  if (accountProfile) return accountProfile.id;
  return profiles.find(isConfigured)?.id;
}

function Agents({
  activeProfile,
  onChatWith,
  onConfigureModels,
}: AgentsProps): React.JSX.Element {
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [runtimeModelRoutes, setRuntimeModelRoutes] = useState<
    AgentRuntimeModelRouteSource[] | undefined
  >(undefined);
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

  const loadRuntimeModelRoutes = useCallback(
    async (profileList: readonly ProfileInfo[]): Promise<void> => {
      const catalogBridge = window.hermesAPI.getOwnerModelRouteCatalog;
      if (typeof catalogBridge === "function") {
        try {
          const catalog = await catalogBridge(activeProfile);
          setRuntimeModelRoutes(catalog.routes);
        } catch {
          // A present Beta.27 bridge is authoritative. An unavailable catalog
          // must not fall back to a stale Profile-derived source list.
          setRuntimeModelRoutes([]);
        }
        return;
      }

      // Beta.26 renderer/main compatibility: query one preferred source only.
      // New renderer writes never use this projection; it exists solely for
      // mixed-version read/activation transitions.
      const bridge = window.hermesAPI.listAgentRuntimeModelRoutes;
      const sourceProfileId = selectAgentModelProfileId(
        profileList,
        activeProfile,
      );
      if (typeof bridge !== "function" || !sourceProfileId) {
        setRuntimeModelRoutes(undefined);
        return;
      }
      try {
        setRuntimeModelRoutes(await bridge(sourceProfileId));
      } catch {
        setRuntimeModelRoutes(undefined);
      }
    },
    [activeProfile],
  );

  const refreshProfilesAndRoutes = useCallback(async (): Promise<void> => {
    const list = await loadProfiles();
    await loadRuntimeModelRoutes(list);
  }, [loadProfiles, loadRuntimeModelRoutes]);

  useEffect(() => {
    void refreshProfilesAndRoutes();
  }, [refreshProfilesAndRoutes]);

  useEffect(() => {
    const reloadRoutes = (): void => {
      void refreshProfilesAndRoutes();
    };
    const offModels = window.hermesAPI.onModelLibraryChanged(reloadRoutes);
    const offProviders =
      window.hermesAPI.onCustomProvidersChanged(reloadRoutes);
    const offConnection =
      window.hermesAPI.onConnectionConfigChanged(reloadRoutes);
    return () => {
      offModels();
      offProviders();
      offConnection();
    };
  }, [refreshProfilesAndRoutes]);

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
    async (name: string, options?: AgentChatOpenOptions): Promise<void> => {
      await window.hermesAPI.setActiveProfile(name);
      if (options) onChatWith(name, options);
      else onChatWith(name);
      void loadProfiles();
    },
    [loadProfiles, onChatWith],
  );

  const handleAgentReady = useCallback(
    async (
      installationId: string,
      options?: AgentChatOpenOptions,
    ): Promise<boolean> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const list = await loadProfiles();
        const installed = list.find(
          (profile) => profile.agentInstallationId === installationId,
        );
        if (installed) {
          await window.hermesAPI.setActiveProfile(installed.id);
          if (options) onChatWith(installed.id, options);
          else onChatWith(installed.id);
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
        runtimeModelRoutes={runtimeModelRoutes}
        initialTab="mine"
        onChatWithProfile={(profileId, options) =>
          void handleChatWith(profileId, options)
        }
        onProfilesChanged={loadProfiles}
        onAgentReady={handleAgentReady}
        onConfigureModels={onConfigureModels}
        modelProfileId={modelProfileId}
      />
    </div>
  );
}

export default Agents;
