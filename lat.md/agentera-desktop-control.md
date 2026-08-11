---
lat:
  require-code-mention: true
---

# Aera Desktop Control V1

Desktop Control V1 lets a signed-in Aera Desktop report a bounded online and health state to Cloud so internal operators can see real devices without a registration-code workflow.

## Auth-bound heartbeat

[[src/main/agentera-desktop-control/coordinator.ts#AgenteraDesktopControlCoordinator]] starts only for an authenticated, Cloud-available account, sends immediately, follows the server's 60-second interval, and aborts the old principal before an account switch.

The main process obtains the bearer immediately before each request through [[src/main/agentera-desktop-control/client.ts#AgenteraDesktopControlClient]]. The request body contains only display name, app version, platform, architecture, capability, bounded uptime, and the previous fixed health summary.

## Fixed health check

Cloud may claim only `health_check`; [[src/main/agentera-desktop-control/health.ts#runDesktopControlHealthProbe]] maps Runtime availability, configuration health, and Gateway reachability to fixed codes without serializing issue text, profiles, paths, logs, or exceptions.

Gateway reachability accepts the active Dashboard Gateway first and falls back to the legacy API Gateway probe; neither branch starts or restarts a service.

The allowed terminal codes are `HEALTHY`, `DESKTOP_UNHEALTHY`, `RUNTIME_UNAVAILABLE`, `GATEWAY_UNAVAILABLE`, `HEALTH_CHECK_TIMEOUT`, and `CLIENT_INTERRUPTED`. Restart, upgrade, rollback, configuration delivery, arbitrary commands, and log upload are outside V1.

## Idempotent receipt journal

[[src/main/agentera-desktop-control/store.ts#DesktopControlJournal]] keeps at most 32 main-process-only command receipts in an owner-only file so a terminal result can be retried and an interrupted running command is never executed twice.

Only account/device isolation keys, command ID, running or terminal state, fixed result fields, and timestamps are persisted. Corrupt or oversized files fail closed to an empty journal.

## Renderer privacy boundary

The preload exposes only `getState` and `onStateChanged`; [[src/shared/agentera-desktop-control.ts#serializeDesktopControlPublicState]] reconstructs status, last heartbeat, fixed error code, and fixed health result from allowlists.

[[src/renderer/src/components/settings/DesktopControlStatusCard.tsx#DesktopControlStatusCard]] reuses the existing Settings card system. It never receives Cloud tokens, account/device identifiers, raw responses, paths, logs, or detailed health issues.

## Real cross-repository delivery gate

The delivery gate drives one real Electron Desktop through isolated Cloud and Admin services; its temporary Admin files are restored during teardown.

Harness boundary tests use Vitest's Node environment because they exercise filesystem, process, and SQLite-backed test infrastructure.

[[tests/e2e/support/agentera-agent-control-harness.ts#buildDesktopFleetAdminSeedScript]] wraps Payload initialization in an async entrypoint so `tsx` can compile the temporary Admin seed under CommonJS rules. The Runtime-unavailable leg clears only the selected run-owned device installation and test seed. [[tests/e2e/agentera-desktop-fleet.e2e.ts]] remains the end-to-end proof owner.
