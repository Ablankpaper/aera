# Desktop TUI Dashboard Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every Desktop-owned Runtime 0.20 TUI backend exits during Profile transitions and App shutdown without leaving a late-started or unowned process.

**Architecture:** Keep the existing TUI transport in `hermes.ts`, but give each client a generation-guarded lifecycle and an awaited exact-process-tree termination path. Add an independent pool-wide TUI stop and an idempotent Electron quit barrier so App exit cannot finish before bounded Runtime cleanup. Launch the backend through Runtime 0.20's `serve` plus `HERMES_DESKTOP=1` contract.

**Tech Stack:** Electron 39, TypeScript 5.9, Node child processes, WebSocket, Vitest 4, ESLint, Prettier, lat.md.

---

### Task 1: Specify the exact owned-process termination contract

**Files:**

- Modify: `src/main/process-tree.ts`
- Create: `src/main/process-tree.test.ts`
- Modify: `lat.md/agentera-runtime-distribution.md`

- [ ] **Step 1: Add RED tests for graceful exit and forced escalation**

Create deterministic fake `ChildProcess` values and mock the POSIX process table. The tests must require SIGTERM first, no SIGKILL when the exact root and captured descendant exit during the grace window, and SIGKILL only after the grace window when they remain alive.

```ts
// @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Exact process-tree shutdown]]
it("terminates the exact owned tree gracefully before the deadline", async () => {
  const stopping = terminateProcessTree(proc, {
    detachedProcessGroup: false,
    forceAfterMs: 3_000,
    pollIntervalMs: 50,
  });
  expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  expect(signalPid).toHaveBeenCalledWith(childPid, "SIGTERM");
  markExited();
  await vi.runAllTimersAsync();
  await expect(stopping).resolves.toMatchObject({ forced: false });
});

// @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Bounded force escalation]]
it("forces only captured live identities after the grace window", async () => {
  const stopping = terminateProcessTree(proc, {
    detachedProcessGroup: false,
    forceAfterMs: 3_000,
    pollIntervalMs: 50,
  });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");
  expect(signalPid).not.toHaveBeenCalledWith(unrelatedPid, "SIGKILL");
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

Capture descendants from the exact root PID before signalling. On POSIX, send signals to the captured child-first list and the exact `ChildProcess`; never signal a negative PGID when `detachedProcessGroup` is false. Poll only those captured PIDs. After the grace deadline, SIGKILL only identities still alive. On Windows, start with the exact child termination and use `taskkill /T /F /PID <root>` only after the grace deadline if the child remains alive.

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
    this.resetOwnedState();
    if (proc) {
      await this.dependencies.terminateProcessTree(proc, {
        detachedProcessGroup: false,
        forceAfterMs: 3_000,
      });
    }
  }
}
```

Every continuation after `pickDashboardPort()`, readiness, or WebSocket connection must compare its captured generation. Stale callbacks may clean up only their own exact child/WebSocket and must not reset a newer generation.

- [ ] **Step 6: Implement pool-wide stop and the headless Runtime command**

Change only the backend subcommand and Desktop ownership marker:

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
  const clients = [...tuiGatewayClients.values()];
  tuiGatewayClients.clear();
  await Promise.all(clients.map((client) => client.stop()));
}
```

Single-Profile stops remove their map entry and launch their async stop with an explicit handled promise. Existing chat fallback behavior remains restartable.

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
    inFlight = cleanup()
      .catch(onError)
      .then(() => {
        complete = true;
        quit();
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

Register `before-quit` through the barrier and move the existing disposal calls into its async cleanup closure. Do not change `window-all-closed`, updater behavior, Runtime transition reservations, or owner-switch semantics.

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

Give the reviewer the exact base/head diff and require checks for lifecycle completeness, late-start races, PID ownership safety, `serve + HERMES_DESKTOP=1`, App quit recursion, and test sufficiency. The reviewer must not edit files, launch Electron, build, download, or release.

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
