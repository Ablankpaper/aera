import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";

export type ProductAccessLevel =
  | "preflight"
  | "authenticated"
  | "bound-profile";

export interface ProductAccessGuard {
  assert(level: ProductAccessLevel): void;
}

/** Renderer argument indexes exclude Electron's leading event argument. */
export const AGENTERA_PROFILE_ARGUMENT_INDEX: Readonly<Record<string, number>> =
  Object.freeze({
    "add-credential-pool-entry": 3,
    "add-mcp-server": 1,
    "add-memory-entry": 1,
    "agent-sync-linked-id": 0,
    "autofix-config-issue": 1,
    "claw3d-start-all": 0,
    "create-cron-job": 4,
    "create-wallet": 0,
    "dashboard-status": 0,
    "delete-wallet": 0,
    "discover-memory-providers": 0,
    "discover-provider-models": 3,
    "fresh-dashboard-ws-url": 0,
    "generate-api-server-key": 0,
    "get-api-server-key-status": 0,
    "get-auxiliary-config": 0,
    "get-config": 1,
    "get-config-health": 0,
    "get-credential-pool": 0,
    "get-env": 0,
    "get-hermes-home": 0,
    "get-messaging-platforms": 0,
    "get-model-config": 0,
    "get-model-context-window": 3,
    "get-platform-enabled": 0,
    "get-toolsets": 0,
    "hermes-account-get": 0,
    "hermes-account-login": 0,
    "install-mcp-catalog-entry": 2,
    "install-skill": 1,
    "kanban-archive-task": 1,
    "kanban-assign-task": 2,
    "kanban-block-task": 2,
    "kanban-comment-task": 2,
    "kanban-complete-task": 2,
    "kanban-create-board": 3,
    "kanban-create-task": 1,
    "kanban-current-board": 0,
    "kanban-dispatch-once": 1,
    "kanban-get-task": 1,
    "kanban-list-boards": 1,
    "kanban-promote-task": 1,
    "kanban-reclaim-task": 2,
    "kanban-remove-board": 2,
    "kanban-schedule-task": 2,
    "kanban-specify-task": 1,
    "kanban-switch-board": 1,
    "kanban-unblock-task": 1,
    "list-cron-jobs": 1,
    "list-custom-providers": 0,
    "list-installed-skills": 0,
    "list-mcp-catalog": 0,
    "list-mcp-servers": 0,
    "list-wallets": 0,
    "oauth-login": 1,
    "pause-cron-job": 1,
    "read-memory": 0,
    "read-soul": 0,
    "registry-install": 2,
    "registry-list-installed": 0,
    "remove-cron-job": 1,
    "remove-custom-provider": 0,
    "remove-mcp-server": 1,
    "remove-memory-entry": 1,
    "rename-wallet": 0,
    "rerun-config-health": 0,
    "reset-auxiliary-config": 0,
    "reset-soul": 0,
    "restart-gateway": 0,
    "resume-cron-job": 1,
    "run-hermes-backup": 0,
    "run-hermes-import": 1,
    "send-message": 1,
    "set-auxiliary-task": 2,
    "set-config": 2,
    "set-credential-pool": 2,
    "set-env": 2,
    "set-mcp-server-enabled": 2,
    "set-model-config": 3,
    "set-platform-enabled": 2,
    "set-toolset-enabled": 2,
    "start-dashboard": 0,
    "stop-dashboard": 0,
    "test-mcp-server": 1,
    "test-messaging-platform": 1,
    "transcribe-audio": 2,
    "trigger-cron-job": 1,
    "uninstall-skill": 1,
    "update-memory-entry": 2,
    "update-messaging-platform": 2,
    "upsert-custom-provider": 0,
    "validate-chat-readiness": 0,
    "wallet-portfolio": 0,
    "wallet-provision": 0,
    "wallet-sync": 0,
    "write-soul": 1,
    "write-user-profile": 1,
  });

const PREFLIGHT_CHANNELS = [
  "agentera-auth-cancel-login",
  "agentera-auth-get-state",
  "agentera-auth-logout",
  "agentera-auth-retry-online",
  "agentera-auth-start-login",
  "agentera-install-file-probe",
  "agentera-startup-preflight",
  "get-gpu-status",
  "get-locale",
  "quit-app",
  "relaunch-app",
  "set-locale",
] as const;

const AUTHENTICATED_CHANNELS = [
  "adopt-hermes-home",
  "agentera-auth-open-portal",
  "agentera-connection-bind-current",
  "agentera-connection-inspect-current",
  "agentera-profile-bind-active",
  "agentera-profile-create-fresh",
  "agentera-profile-inspect-active",
  "agentera-profile-list-unbound",
  "agentera-runtime-cancel-download",
  "agentera-runtime-check-update",
  "agentera-runtime-download-confirmed",
  "agentera-runtime-get-state",
  "agentera-runtime-restart-apply",
  "agentera-runtime-retry-repair",
  "agentera-switch-to-local",
  "check-install",
  "check-openclaw",
  "copy-to-clipboard",
  "get-connection-config",
  "inspect-install-target",
  "is-remote-mode",
  "is-remote-only-mode",
  "is-ssh-tunnel-active",
  "open-external",
  "probe-remote-auth-mode",
  "reenable-gpu",
  "set-connection-chat-transports",
  "set-connection-config",
  "set-gpu-preference",
  "set-ssh-config",
  "start-install",
  "test-remote-connection",
  "test-ssh-connection",
  "validate-hermes-home",
  "verify-install",
] as const;

const BOUND_PROFILE_CHANNELS = [
  "abort-chat",
  "add-credential-pool-entry",
  "add-mcp-server",
  "add-memory-entry",
  "add-model",
  "agent-sync-linked-id",
  "agent-sync-run",
  "agent-sync-status",
  "autofix-config-issue",
  "clarify-respond",
  "claw3d-get-logs",
  "claw3d-get-port",
  "claw3d-get-ws-url",
  "claw3d-set-port",
  "claw3d-set-ws-url",
  "claw3d-setup",
  "claw3d-start-adapter",
  "claw3d-start-all",
  "claw3d-start-dev",
  "claw3d-status",
  "claw3d-stop-adapter",
  "claw3d-stop-all",
  "claw3d-stop-dev",
  "clear-staged-attachments",
  "create-cron-job",
  "create-profile",
  "create-wallet",
  "dashboard-status",
  "delete-profile",
  "delete-session",
  "delete-sessions",
  "delete-wallet",
  "discover-memory-providers",
  "discover-provider-models",
  "fresh-dashboard-ws-url",
  "gateway-status",
  "generate-api-server-key",
  "get-api-server-key-status",
  "get-auxiliary-config",
  "get-config",
  "get-config-fix-log",
  "get-config-health",
  "get-credential-pool",
  "get-env",
  "get-hermes-home",
  "get-hermes-version",
  "get-messaging-platforms",
  "get-model-config",
  "get-model-context-window",
  "get-model-definition",
  "get-platform-enabled",
  "get-session-context-folder",
  "get-session-messages",
  "get-session-model-override",
  "get-skill-content",
  "get-token-balances",
  "get-toolsets",
  "hermes-account-get",
  "hermes-account-login",
  "hermes-account-login-cancel",
  "hermes-account-logout",
  "import-wallet",
  "install-mcp-catalog-entry",
  "install-skill",
  "invalidate-secrets-cache",
  "kanban-archive-task",
  "kanban-assign-task",
  "kanban-block-task",
  "kanban-comment-task",
  "kanban-complete-task",
  "kanban-create-board",
  "kanban-create-task",
  "kanban-current-board",
  "kanban-dispatch-once",
  "kanban-get-task",
  "kanban-list-boards",
  "kanban-list-claw3d-hq-tasks",
  "kanban-list-tasks",
  "kanban-promote-task",
  "kanban-reclaim-task",
  "kanban-remove-board",
  "kanban-schedule-task",
  "kanban-specify-task",
  "kanban-switch-board",
  "kanban-unblock-task",
  "list-bundled-skills",
  "list-cached-sessions",
  "list-cron-jobs",
  "list-custom-providers",
  "list-installed-skills",
  "list-mcp-catalog",
  "list-mcp-servers",
  "list-model-definitions",
  "list-models",
  "list-profiles",
  "list-recent-session-context-folders",
  "list-sessions",
  "list-wallets",
  "media-file-exists",
  "oauth-login",
  "oauth-login-cancel",
  "open-file-in-editor",
  "open-terminal",
  "pause-cron-job",
  "read-directory",
  "read-file",
  "read-image-file",
  "read-logs",
  "read-media-file",
  "read-memory",
  "read-soul",
  "record-session-continuation",
  "record-session-local-error",
  "refresh-hermes-version",
  "registry-detail",
  "registry-fetch",
  "registry-fetch-models",
  "registry-install",
  "registry-list-installed",
  "remote-oauth-login",
  "remote-oauth-logout",
  "remote-oauth-session-state",
  "remove-cron-job",
  "remove-custom-provider",
  "remove-mcp-server",
  "remove-memory-entry",
  "remove-model",
  "remove-model-definition",
  "remove-profile-avatar",
  "rename-wallet",
  "rerun-config-health",
  "reset-auxiliary-config",
  "reset-soul",
  "restart-gateway",
  "resume-cron-job",
  "run-claw-migrate",
  "run-hermes-backup",
  "run-hermes-doctor",
  "run-hermes-dump",
  "run-hermes-import",
  "run-hermes-update",
  "save-media-file",
  "search-sessions",
  "select-folder",
  "send-message",
  "set-active-profile",
  "set-auxiliary-task",
  "set-config",
  "set-credential-pool",
  "set-env",
  "set-mcp-server-enabled",
  "set-model-config",
  "set-model-definition",
  "set-platform-enabled",
  "set-profile-avatar",
  "set-profile-color",
  "set-profile-name",
  "set-session-context-folder",
  "set-session-model-override",
  "set-toolset-enabled",
  "show-media-menu",
  "stage-attachment",
  "start-dashboard",
  "start-gateway",
  "start-ssh-tunnel",
  "stop-dashboard",
  "stop-gateway",
  "stop-ssh-tunnel",
  "sync-session-cache",
  "test-mcp-server",
  "test-messaging-platform",
  "transcribe-audio",
  "trigger-cron-job",
  "uninstall-skill",
  "update-memory-entry",
  "update-messaging-platform",
  "update-model",
  "update-session-title",
  "upsert-custom-provider",
  "validate-chat-readiness",
  "wallet-portfolio",
  "wallet-provision",
  "wallet-sync",
  "write-soul",
  "write-user-profile",
] as const;

function buildChannelPolicy(): Readonly<Record<string, ProductAccessLevel>> {
  const policy: Record<string, ProductAccessLevel> = {};
  const add = (
    channels: readonly string[],
    level: ProductAccessLevel,
  ): void => {
    for (const channel of channels) {
      if (policy[channel]) {
        throw new Error(`Duplicate AgentEra IPC policy for ${channel}.`);
      }
      policy[channel] = level;
    }
  };
  add(PREFLIGHT_CHANNELS, "preflight");
  add(AUTHENTICATED_CHANNELS, "authenticated");
  add(BOUND_PROFILE_CHANNELS, "bound-profile");
  return Object.freeze(policy);
}

export const AGENTERA_IPC_CHANNEL_POLICY = buildChannelPolicy();

export function createProductAccessGuard(options: {
  getAuthState: () => AgenteraAuthPublicState;
  isRuntimeContextBound: () => boolean;
  assertCurrentEntitlement?: () => void;
}): ProductAccessGuard {
  return {
    assert(level: ProductAccessLevel): void {
      if (level === "preflight") return;
      const state = options.getAuthState();
      if (state.status !== "authenticated" && state.status !== "offline") {
        throw new Error("AgentEra product sign-in is required.");
      }
      options.assertCurrentEntitlement?.();
      if (level === "bound-profile" && !options.isRuntimeContextBound()) {
        throw new Error("AgentEra Runtime Profile binding is required.");
      }
    },
  };
}

interface InternalIpcMainLike {
  handle(channel: string, listener: (...args: never[]) => unknown): void;
  on(channel: string, listener: (...args: never[]) => unknown): unknown;
}

export function createGuardedIpcMain<T extends object>(
  rawIpcMain: T,
  guard: ProductAccessGuard,
  assertChannelArguments?: (
    channel: string,
    rendererArguments: readonly unknown[],
  ) => void,
): T {
  return new Proxy(rawIpcMain, {
    get(target, property, receiver) {
      if (property !== "handle" && property !== "on") {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (channel: string, listener: (...args: unknown[]) => unknown) => {
        const level = AGENTERA_IPC_CHANNEL_POLICY[channel];
        if (!level) {
          throw new Error(`Missing AgentEra IPC policy for ${channel}.`);
        }
        const guardedListener = (...args: unknown[]): unknown => {
          guard.assert(level);
          assertChannelArguments?.(channel, args.slice(1));
          return listener(...args);
        };
        const registrar = target as unknown as InternalIpcMainLike;
        return registrar[property](channel, guardedListener as never);
      };
    },
  });
}
