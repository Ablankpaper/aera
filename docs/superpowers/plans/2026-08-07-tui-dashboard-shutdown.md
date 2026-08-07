# Desktop TUI Dashboard Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every Desktop-owned Runtime 0.20 TUI backend exits during Profile transitions and App shutdown without leaving a late-started or unowned process.

**Architecture:** Keep the existing TUI transport in `hermes.ts`, but give each client a generation-guarded lifecycle and an awaited exact-process termination path. POSIX TUI children use dedicated process groups; Windows refreshes invariant creation identities. Add an independent, TUI-local pool drain and a fail-closed Electron quit barrier. Launch through Runtime 0.20's `serve` plus `HERMES_DESKTOP=1` contract. Do not add a global Runtime IPC/Owner admission gate.

**Tech Stack:** Electron 39, TypeScript 5.9, Node child processes, WebSocket, Vitest 4, ESLint, Prettier, lat.md.

---

### Task 1: Specify the exact owned-process termination contract

**Files:**

- Modify: `src/main/process-tree.ts`
- Create: `src/main/process-tree.test.ts`
- Modify: `lat.md/agentera-runtime-distribution.md`

- [ ] **Step 1: Add RED tests for graceful exit and forced escalation**

Create deterministic fake `ChildProcess` values and mock the dedicated POSIX process group. The tests must require group SIGTERM first, no SIGKILL when the group exits during the grace window, and group SIGKILL only after the grace window. They must also prove that query failure sends no signal and that a leader-exited group descendant is still cleaned up.

```ts
// @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
it("terminates the dedicated owned group gracefully before the deadline", async () => {
  const stopping = terminateProcessTree(proc, {
    detachedProcessGroup: true,
    forceAfterMs: 3_000,
    pollIntervalMs: 50,
  });
  expect(signalProcessGroup).toHaveBeenCalledWith(proc.pid, "SIGTERM");
  markExited();
  await vi.runAllTimersAsync();
  await expect(stopping).resolves.toMatchObject({ forced: false });
});

// @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Bounded force escalation]]
it("forces only the same dedicated group after the grace window", async () => {
  const stopping = terminateProcessTree(proc, {
    detachedProcessGroup: true,
    forceAfterMs: 3_000,
    pollIntervalMs: 50,
  });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(signalProcessGroup).toHaveBeenLastCalledWith(proc.pid, "SIGKILL");
  markExited();
  await vi.runAllTimersAsync();
  await stopping;
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run src/main/process-tree.test.ts
```

Expected: FAIL because `terminateProcessTree` and its result type do not exist.

- [ ] **Step 3: Implement bounded exact-tree termination**

Add an async API without changing existing `killProcessTree` callers:

```ts
export interface TerminateProcessTreeOptions {
  detachedProcessGroup?: boolean;
  forceAfterMs?: number;
  pollIntervalMs?: number;
  forceSettleMs?: number;
}

export interface ProcessTreeTerminationResult {
  forced: boolean;
  remainingPids: number[];
}

export async function terminateProcessTree(
  proc: ChildProcess,
  options: TerminateProcessTreeOptions = {},
): Promise<ProcessTreeTerminationResult>;
```

On POSIX, the caller must spawn the TUI child with `detached: true`. Verify the saved dedicated PGID before signalling, send TERM and then bounded KILL only to that same group, and never fall back to a positive PID or shared Electron group. On Windows, capture the exact tree with invariant `CreationFileTimeUtc` identities and refresh those identities before forced termination. Query timeout, parse failure, empty identity, or remaining PIDs must fail closed.

- [ ] **Step 4: Document the LAT contract and make tests GREEN**

Add `Desktop TUI backend lifecycle` to `lat.md/agentera-runtime-distribution.md` with `Exact process-tree shutdown` and `Bounded force escalation` leaf sections matching the test references.

Run:

```bash
npx vitest run src/main/process-tree.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the termination primitive**

```bash
git add src/main/process-tree.ts src/main/process-tree.test.ts lat.md/agentera-runtime-distribution.md
git commit -m "fix(runtime): terminate owned process trees predictably"
```

### Task 2: Close the TUI client lifecycle and Runtime 0.20 launch contract

**Files:**

- Modify: `src/main/hermes.ts`
- Create: `src/main/tui-gateway-lifecycle.test.ts`
- Modify: `lat.md/agentera-runtime-distribution.md`

- [ ] **Step 1: Add RED coverage for Runtime 0.20 launch identity**

Instantiate an exported `TuiGatewayClient` with injected port, spawn, readiness, and termination dependencies. Require the exact launch contract:

```ts
expect(args).toEqual([
  "-m",
  "hermes_cli.main",
  "serve",
  "--no-open",
  "--host",
  "127.0.0.1",
  "--port",
  "9120",
]);
expect(options.env).toMatchObject({
  HERMES_DASHBOARD_TUI: "1",
  HERMES_DESKTOP: "1",
});
```

- [ ] **Step 2: Add RED coverage for the startup/stop race**

Hold port selection on a deferred promise, begin `start()`, call `stop()`, then resolve the port. Require that the old generation cannot spawn or publish a child:

```ts
// @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Cancelled startup cannot outlive Desktop]]
it("does not spawn after stop invalidates pending port selection", async () => {
  const started = client.start();
  const stopped = client.stop();
  port.resolve(9120);
  await expect(started).rejects.toThrow("stopped");
  await stopped;
  expect(spawnBackend).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Add RED coverage for pool-wide TUI-only shutdown**

Populate clients for `default` and a named Profile without adding ordinary Gateway ownership. Require `stopAllTuiGatewayClients()` to snapshot, clear, and await both clients.

```ts
// @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Pool-wide App shutdown]]
it("stops every TUI-only Profile independently of Gateway ownership", async () => {
  const first = getTuiGatewayClient("default");
  const second = getTuiGatewayClient("work");
  vi.spyOn(first, "stop").mockResolvedValue();
  vi.spyOn(second, "stop").mockResolvedValue();
  await stopAllTuiGatewayClients();
  expect(first.stop).toHaveBeenCalledOnce();
  expect(second.stop).toHaveBeenCalledOnce();
});
```

- [ ] **Step 4: Run the lifecycle tests and verify RED**

Run:

```bash
npx vitest run src/main/tui-gateway-lifecycle.test.ts
```

Expected: FAIL because the lifecycle exports, dependency seams, generation cancellation, pool-wide stop, and Runtime 0.20 launch identity are missing.

- [ ] **Step 5: Implement the minimum generation-guarded client**

Keep the transport protocol unchanged. Add a monotonically increasing generation and make stop asynchronous:

```ts
export class TuiGatewayClient {
  private generation = 0;

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    const generation = ++this.generation;
    // Start only while generation remains current.
  }

  async stop(): Promise<void> {
    ++this.generation;
    const proc = this.proc;
    this.rejectPending(
      new Error("Aera Runtime dashboard gateway stream stopped"),
    );
    this.resetTransportState();
    if (proc) {
      await this.dependencies.terminateProcessTree(proc, {
        detachedProcessGroup: process.platform !== "win32",
        forceAfterMs: 3_000,
      });
      if (this.proc === proc) this.proc = null;
    }
  }
}
```

Every continuation after `pickDashboardPort()`, readiness, or WebSocket connection must compare its captured generation. Stale callbacks may clean up only their own exact child/WebSocket and must not reset a newer generation.

- [ ] **Step 6: Implement pool-wide stop and the headless Runtime command**

Change only the backend subcommand, Desktop marker, POSIX spawn group, and TUI-local pool lifecycle:

```ts
const dashboardEnv = invocation.environment({
  ...this.env,
  HERMES_DASHBOARD_SESSION_TOKEN: this.token,
  HERMES_DASHBOARD_TUI: "1",
  HERMES_DESKTOP: "1",
});
const args = invocation.cliArgs([
  "serve",
  "--no-open",
  "--host",
  "127.0.0.1",
  "--port",
  String(this.port),
]);

export async function stopAllTuiGatewayClients(): Promise<void> {
  closeTuiPoolAdmission();
  await serializeStableDrain(async () => {
    const clients = [...tuiGatewayClients.entries()];
    const results = await Promise.allSettled(
      clients.map(([, client]) => client.stop()),
    );
    removeOnlySuccessfulClients(clients, results);
    throwIfAnyCleanupFailed(results);
  });
}
```

Single-Profile stops retain the map entry until cleanup succeeds and attach an explicit rejection handler. Failed clients retain their exact child for retry. Ordinary Runtime cleanup reopens only the TUI-local pool after a clean drain; App quit closes it permanently. Existing chat fallback behavior remains restartable.

- [ ] **Step 7: Run lifecycle and existing stream tests GREEN**

Run:

```bash
npx vitest run src/main/tui-gateway-lifecycle.test.ts src/main/tui-gateway-stream.test.ts
```

Expected: PASS with the existing 19 stream/env tests unchanged.

- [ ] **Step 8: Commit the TUI lifecycle repair**

```bash
git add src/main/hermes.ts src/main/tui-gateway-lifecycle.test.ts lat.md/agentera-runtime-distribution.md
git commit -m "fix(runtime): own every Desktop TUI backend lifecycle"
```

### Task 3: Hold Electron quit until bounded Runtime cleanup settles

**Files:**

- Create: `src/main/app/quit-barrier.ts`
- Create: `src/main/app/quit-barrier.test.ts`
- Modify: `src/main/app/start.ts`
- Modify: `lat.md/agentera-runtime-distribution.md`

- [ ] **Step 1: Add RED tests for the idempotent quit barrier**

Require the first `before-quit` event to prevent exit and launch cleanup once, a repeated event to reuse the in-flight cleanup, and the post-cleanup `app.quit()` event to pass through.

```ts
// @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Awaited Electron quit barrier]]
it("waits for one cleanup before allowing Electron to quit", async () => {
  const handler = createQuitBarrier(cleanup, quit, onError);
  handler(firstEvent);
  handler(secondEvent);
  expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
  expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
  cleanupDeferred.resolve();
  await flushPromises();
  expect(quit).toHaveBeenCalledOnce();
  handler(finalEvent);
  expect(finalEvent.preventDefault).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the quit-barrier test and verify RED**

Run:

```bash
npx vitest run src/main/app/quit-barrier.test.ts
```

Expected: FAIL because `createQuitBarrier` does not exist.

- [ ] **Step 3: Implement the pure quit barrier**

```ts
export function createQuitBarrier(
  cleanup: () => Promise<void>,
  quit: () => void,
  onError: (error: unknown) => void,
): (event: { preventDefault(): void }) => void {
  let complete = false;
  let inFlight: Promise<void> | null = null;
  return (event) => {
    if (complete) return;
    event.preventDefault();
    if (inFlight) return;
    inFlight = Promise.resolve()
      .then(cleanup)
      .then(() => {
        complete = true;
        quit();
      })
      .catch((error) => {
        onError(error);
        inFlight = null;
      });
  };
}
```

- [ ] **Step 4: Make Runtime-context cleanup awaited**

Change `stopActiveRuntimeContext()` to return `Promise<void>`. Start pool-wide TUI shutdown before ordinary Gateway cleanup, then await it before the context transition completes:

```ts
export async function stopActiveRuntimeContext(): Promise<void> {
  stopHealthPolling();
  runtimeActivity.abortAll();
  cleanupTempMediaFiles();
  stopAllDashboards();
  const tuiShutdown = stopAllTuiGatewayClients();
  stopAeraOwnedGateways();
  stopSshTunnel();
  closeDbConnection();
  await tuiShutdown;
}
```

Register `before-quit` through the barrier and move the existing disposal calls into its async cleanup closure. Cleanup success alone may reissue quit; failure keeps Electron open and permits only a later explicit retry. Keep `window-all-closed`, updater behavior, Runtime transition reservations, and Owner coordinator semantics unchanged. The Owner transition call site may only handle and log the new async cleanup rejection; it must not add an IPC admission queue.

- [ ] **Step 5: Run the focused shutdown tests GREEN**

Run:

```bash
npx vitest run src/main/app/quit-barrier.test.ts src/main/tui-gateway-lifecycle.test.ts src/main/process-tree.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the awaited App shutdown**

```bash
git add src/main/app/quit-barrier.ts src/main/app/quit-barrier.test.ts src/main/app/start.ts lat.md/agentera-runtime-distribution.md
git commit -m "fix(app): await Runtime cleanup before quit"
```

### Task 4: Verify the complete repair and freeze reviewable bytes

**Files:**

- Verify: all files changed since `fa15e7d7f024039a23e6fc1c35255cd4ac00ca80`
- Verify unchanged: `build/agentera-runtime-seed.lock.json`
- Verify unchanged: release version/workflows

- [ ] **Step 1: Run focused tests and both TypeScript projects**

```bash
npx vitest run src/main/process-tree.test.ts src/main/tui-gateway-lifecycle.test.ts src/main/tui-gateway-stream.test.ts src/main/app/quit-barrier.test.ts
npm run typecheck:node
npm run typecheck:web
```

Expected: all tests and both type checks pass.

- [ ] **Step 2: Run affected lint and formatting checks**

```bash
npx eslint src/main/process-tree.ts src/main/process-tree.test.ts src/main/hermes.ts src/main/tui-gateway-lifecycle.test.ts src/main/app/quit-barrier.ts src/main/app/quit-barrier.test.ts src/main/app/start.ts
npx prettier --check src/main/process-tree.ts src/main/process-tree.test.ts src/main/hermes.ts src/main/tui-gateway-lifecycle.test.ts src/main/app/quit-barrier.ts src/main/app/quit-barrier.test.ts src/main/app/start.ts docs/superpowers/specs/2026-08-07-tui-dashboard-shutdown-design.md docs/superpowers/plans/2026-08-07-tui-dashboard-shutdown.md lat.md/agentera-runtime-distribution.md
```

Expected: both commands exit 0 without rewriting files.

- [ ] **Step 3: Run the broader affected unit suite and LAT validation**

```bash
npx vitest run src/main/hermes.test.ts src/main/gateway-process-ownership.test.ts src/main/gateway-ports.test.ts
lat check
```

Expected: all tests pass and every LAT reference resolves.

- [ ] **Step 4: Prove release inputs remain unchanged**

```bash
git diff fa15e7d7f024039a23e6fc1c35255cd4ac00ca80 -- build/agentera-runtime-seed.lock.json package.json package-lock.json .github/workflows
git diff --check
git status --short --branch
```

Expected: no Runtime lock, version, dependency, or workflow diff; no whitespace errors; only intentional repair files differ.

- [ ] **Step 5: Request independent read-only review**

Give the reviewer the exact base/head diff and require checks for lifecycle completeness, late-start races, process-group ownership safety, `serve + HERMES_DESKTOP=1`, stable drain, cleanup retry, App quit recursion, and test sufficiency. Require explicit confirmation that no Owner queue/global Runtime IPC admission WIP remains. The reviewer must not edit files, launch Electron, build, download, or release.

- [ ] **Step 6: Repair review findings, rerun only affected gates, and freeze the repair SHA**

If review finds a real issue, add a failing regression first, make the smallest correction, and rerun the affected focused command plus `git diff --check` and `lat check`. Commit the final correction and record a clean exact repair SHA.

### Task 5: Hand the repair to a new immutable release identity

**Files:**

- Verify: repository release workflows and current online Internal Beta identity
- Do not modify during this repair plan: version, Runtime lock, candidate artifact, frozen evidence

- [ ] **Step 1: Determine the next legal immutable version from live and repository state**

Confirm that `0.7.4-internal-beta.24` has an already-built blocked candidate and cannot be reused. Inspect current live Internal Beta metadata and release workflow version gates, then report the proposed next version before changing release-bound files.

- [ ] **Step 2: Create a separate release-identity plan**

The follow-up plan must cover the version bump, exact-head CI, one new candidate run, signed/notarized/static identity checks, one full six-item Electron run, two Sigstore bundles, one promotion, and online byte verification. It must reuse frozen 017/018/007 evidence only for historical attribution, never as acceptance of the new candidate.
