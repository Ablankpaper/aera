# Desktop TUI Dashboard Shutdown Design

**Status:** Approved in conversation on 2026-08-07

## Context

The frozen `B24-ELECTRON-FINAL-SIX-018` run proved a Desktop product shutdown defect. Activating the named Profile `aera-space-msimrhpe` warmed a TUI Dashboard process, but closing Electron left that process listening on `127.0.0.1:9120` for more than two minutes after it was reparented to PID 1.

The process command was the Runtime 0.20 named-Profile unified route:

```text
python3 -m hermes_cli.main -p default dashboard --port 9120 \
  --host 127.0.0.1 --open-profile aera-space-msimrhpe --no-open
```

Desktop stores these processes in `tuiGatewayClients`. The App shutdown path calls `stopAeraOwnedGateways()`, which enumerates ordinary Gateway ownership only. A TUI client can be created independently by `notifyProfileSwitched()` or `ensureInitialized()`, so a TUI-only Profile is absent from that enumeration and receives no termination signal.

The frozen `B24-NO-ORPHAN-SHUTDOWN-017` run does not contradict this finding: it explicitly stopped the active Runtime before closing Electron. Both evidence archives remain immutable and are not edited or relabelled by this repair.

## Scope

This repair changes Desktop production code and focused Desktop tests only.

- Derive a new repair branch from Desktop commit `fa15e7d7f024039a23e6fc1c35255cd4ac00ca80`.
- Do not modify the blocked Beta.24 candidate, artifact, Runtime source, Runtime Seed lock, Cloud source, frozen evidence, or daily-use Aera/Hermes data.
- Do not add a Runtime parent watchdog or change Runtime 0.20 behavior.
- Do not redesign chat transport, ordinary Gateway ownership, Dashboard UI lifecycle, or release infrastructure.

## Runtime 0.20 Backend Contract

The TUI transport is a headless JSON-RPC/WebSocket consumer. It launches `hermes serve`, not the browser-oriented `hermes dashboard`, and supplies `HERMES_DESKTOP=1`.

This contract has two effects:

1. Runtime skips the named-Profile machine-dashboard reroute and keeps the backend scoped to the Desktop-owned Profile.
2. Runtime skips the browser SPA build/mount while preserving `/api/ws` and the TUI gateway protocol.

The existing session token, TUI marker, Profile home, credentials, loopback host, and dynamically selected port remain unchanged.

## Lifecycle Model

Each `TuiGatewayClient` owns one generation number, one optional startup promise, one optional exact `ChildProcess`, and one optional WebSocket.

Starting captures the current generation. After every asynchronous preparation boundary, the client verifies that the generation is still current before continuing. If shutdown invalidates the generation before spawn, no process is created. If shutdown wins immediately after spawn, registration detects the stale generation and terminates that exact child before returning.

Stopping is idempotent and performs this order:

1. invalidate the generation so no old startup continuation can publish a process;
2. close the WebSocket and reject pending RPC calls;
3. snapshot and clear the exact owned child reference;
4. send SIGTERM to that child and its captured descendants;
5. wait a fixed grace window for exit;
6. if still alive, send SIGKILL only to the captured exact PID and captured descendants;
7. settle the startup and stop promises before reporting completion.

On Windows, the existing exact-PID `taskkill /T /F` boundary remains the process-tree mechanism. On POSIX the TUI child currently shares a process group with Electron, so shutdown must not signal a negative PGID. Ownership is established only by the `ChildProcess` returned from this Desktop spawn and descendants captured from that PID.

## Pool-Wide Shutdown

`stopAllTuiGatewayClients()` snapshots and clears the complete TUI client map, then awaits every client stop. It is independent of `appStartedProfiles` and the ordinary Gateway ownership ledger.

`stopActiveRuntimeContext()` includes this pool-wide stop. Electron's `before-quit` handler uses one idempotent bounded quit barrier: the first event prevents exit, performs existing resource disposal plus awaited Runtime cleanup, marks cleanup complete, and calls `app.quit()` once. Repeated quit events reuse the same cleanup and cannot launch duplicate shutdown work.

Cleanup errors are logged, but the fixed termination bounds ensure the App cannot wait indefinitely. The barrier never enumerates or signals processes by product name, port, Profile display name, or global process scan.

## Test Design

Focused TDD coverage proves three product regressions:

- **TUI-only App exit:** a named Profile client present only in the TUI map is stopped by pool-wide shutdown even when ordinary Gateway ownership is empty.
- **Startup/stop race:** stopping while port preparation is pending invalidates that generation; resolving the preparation later cannot leave a newly spawned or registered child.
- **Bounded escalation:** an exact owned child first receives SIGTERM; only after the grace window does the same captured PID/tree receive SIGKILL, and an early exit prevents escalation.

Additional assertions bind the Runtime 0.20 launch contract to `serve` plus `HERMES_DESKTOP=1`, and bind App quit to the awaited idempotent cleanup barrier.

## Verification and Release Boundary

The repair is complete only after focused tests, Node/Web type checks, affected ESLint, formatting checks, relevant unit tests, `lat check`, and independent read-only review pass on clean bytes.

The blocked Beta.24 candidate remains non-promotable. A later release step must choose a new legal immutable version, merge the reviewed repair, build a new candidate once, record its exact commit/run/artifact identity, and perform the authorized single full six-item Electron run. Sigstore verification and promotion remain forbidden until that new candidate passes all six items and no-orphan cleanup.
