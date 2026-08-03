# Profile and Runtime Durable Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fresh Profile creation, Agent installation materialization, installed-conversation snapshots, and Aera-owned Runtime gateway shutdown converge safely after retry or cold restart without crossing account or private-Profile boundaries.

**Architecture:** The encrypted Profile binding store persists a narrow fresh-Profile reservation before the first physical Profile byte. A Desktop-local SQLite installation journal coordinates the remaining Profile/binding/projection/Cloud activation phases. RuntimeBinding and ConversationBoundary already share the same SQLite, so a focused conversation coordinator commits both records and later session attachment in one transaction. A separate userData ownership ledger tracks only gateways launched by this Aera process so normal exit and the next cold start can stop those profiles without scanning or claiming unrelated Runtime processes.

**Tech Stack:** Electron, TypeScript, `better-sqlite3`/`node:sqlite`, encrypted `safeStorage` metadata, Vitest, existing Hermes CLI/Profile adapters.

---

### Task 1: Persist and recover fresh Profile reservations

**Files:**

- Modify: `src/main/agentera-profile-binding.ts`
- Modify: `src/main/profiles.ts`
- Modify: `tests/agentera-profile-binding.test.ts`
- Modify: `src/main/agentera-agent-control/installation-manager.test.ts`

- [x] **Step 1: Write failing encrypted-store recovery tests**

Add tests that create a durable reservation, simulate `createProfile` creating the reserved directory and throwing before returning, reconstruct `AgenteraProfileBindingStore`, and reconcile the same operation into exactly one owner binding. Add fail-closed cases for a differently owned binding, an unexpected private marker, and a retry with a different owner or profile identity.

```ts
const pending = store.reserveFreshProfile({
  operationId: AGENT_INSTALLATION_ID,
  name: "Fresh Agent",
  owner,
  profileId: "fresh-agent",
  activate: false,
});
expect(pending.runtimeProfileId).toBe(RUNTIME_PROFILE_ID);
expect(() => createReservedProfile()).toThrow("injected crash");

const restarted = new AgenteraProfileBindingStore(options);
expect(
  restarted.reconcileFreshProfile(AGENT_INSTALLATION_ID, adapters),
).toMatchObject({
  profileId: "fresh-agent",
  binding: { runtimeProfileId: RUNTIME_PROFILE_ID },
});
```

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- tests/agentera-profile-binding.test.ts src/main/agentera-agent-control/installation-manager.test.ts
```

Expected: FAIL because reservation/reconciliation and exact-ID Profile creation do not exist.

- [x] **Step 3: Evolve the encrypted binding payload without exposing paths**

Read binding envelope versions 1 and 2 and write version 3. The encrypted plaintext becomes:

```ts
interface RuntimeProfileBindingStateV3 {
  bindings: StoredProfileBinding[];
  freshProfileOperations: Array<{
    operationId: string;
    tenantId: string;
    ownerId: string;
    deviceInstallationId: string;
    profileId: string;
    runtimeProfileId: string;
    displayName: string;
    activate: boolean;
    createdAt: string;
  }>;
}
```

Reservations are unique by operation ID, Profile ID, and Runtime Profile ID. Replays must match every immutable field. Reconciliation may create or bind only the exact reserved Profile for the exact owner; it never opens, reassigns, deletes, or claims a differently owned or private Profile.

- [x] **Step 4: Add exact reserved-ID Profile creation**

Extend `createProfile(name, cloneFrom, reservedProfileId?)` so the optional reserved ID is validated as the same currently available ID produced by `profileIdForAgentName(name)`. Existing two-argument callers retain behavior. All AgentEra fresh-Profile paths first call `profileIdForAgentName`, persist the reservation, then invoke the exact-ID creation.

- [x] **Step 5: Verify GREEN**

Run:

```bash
npm test -- tests/agentera-profile-binding.test.ts src/main/agentera-agent-control/installation-manager.test.ts
npm run typecheck:node
git diff --check
```

Expected: PASS; a restart reuses one reserved Profile and one Runtime Profile ID.

### Task 2: Add the narrow installation operation journal

**Files:**

- Modify: `src/main/agentera-agent-control/db.ts`
- Modify: `src/main/agentera-agent-control/db.test.ts`
- Modify: `tests/agentera-agent-control-db.test.ts`
- Create: `src/main/agentera-agent-control/installation-operation-store.ts`
- Create: `src/main/agentera-agent-control/installation-operation-store.test.ts`

- [x] **Step 1: Write failing schema and owner-partition tests**

Pin schema version 9 and require `installation_operations` to be created for new databases and forward migrations. Test idempotent begin, immutable target conflict, owner/device partitioning, revision CAS, restart reads, and terminal committed records.

```ts
type InstallationOperationPhase =
  | "prepared"
  | "profile_bound"
  | "profile_attached"
  | "projection_active"
  | "cloud_activated"
  | "committed"
  | "repair_required";
```

The record stores only owner/device/Installation IDs, target kind, Profile ID, bounded display name/model-source IDs, phase, retry code, revision, and timestamps. It stores no credential, physical path, Profile content, token, or Cloud response body.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- src/main/agentera-agent-control/db.test.ts tests/agentera-agent-control-db.test.ts src/main/agentera-agent-control/installation-operation-store.test.ts
```

Expected: FAIL at schema version and missing store.

- [x] **Step 3: Implement schema 9 and the store**

Add a forward-only table with a unique owner/device/Installation tuple and exact `CHECK` constraints for target kind and phase. `begin`, `advance`, `markRepairRequired`, `commit`, `get`, and `listIncomplete` use owner-scoped queries and CAS revisions.

- [x] **Step 4: Verify GREEN**

Run the focused command from Step 2, `npm run typecheck:node`, and `git diff --check`. Expected: PASS.

### Task 3: Make installation materialization journal-first and restart-reconcilable

**Files:**

- Modify: `src/main/agentera-agent-control/installation-manager.ts`
- Modify: `src/main/agentera-agent-control/installation-manager.test.ts`
- Modify: `src/main/agentera-agent-control/manager.ts`
- Modify: `src/main/app/start.ts`

- [ ] **Step 1: Write failure-first crash-window tests**

Cover restart/retry after each durable edge: reserved Profile created before callback return, base owner binding written before SQLite Runtime Profile ID, Runtime Profile ID written before Agent Installation attachment, attachment before projection activation, Cloud activation before local active commit, duplicate retry, and two concurrent retries. Assert the same Installation/Profile/binding is reused and a claimed existing Profile is never deleted.

```ts
activateInstallation.mockResolvedValue(activeInstallation);
databaseFailure.failNextLocalActiveCommit();
await expect(first.install(input)).rejects.toMatchObject({
  code: "activation_failed",
});

const restarted = manager();
await restarted.reconcilePendingInstallations();
expect(activateInstallation).toHaveBeenLastCalledWith(
  AGENT_INSTALLATION_ID,
  RUNTIME_PROFILE_ID,
  expect.any(String),
  `activate:${AGENT_INSTALLATION_ID}`,
);
expect(restarted.getLocalInstallation(AGENT_INSTALLATION_ID).status).toBe(
  "active",
);
```

- [ ] **Step 2: Run the manager tests and verify RED**

Run:

```bash
npm test -- src/main/agentera-agent-control/installation-manager.test.ts src/main/agentera-agent-control/manager.test.ts
```

Expected: FAIL because no materialization journal or startup reconciliation exists.

- [ ] **Step 3: Implement the minimum durable saga**

For each pending Installation, serialize work by Installation ID and execute:

```text
journal prepared
→ verified version/policy/projection
→ reserved fresh Profile or exact explicit claim
→ owner binding
→ SQLite Runtime Profile ID + journal profile_bound
→ Agent Installation attachment + journal profile_attached
→ projection activation + journal projection_active
→ Cloud activation with the existing stable idempotency key
→ journal cloud_activated
→ local active row and journal committed in one SQLite transaction
```

Retries re-read physical/binding/SQLite postconditions instead of creating a second Profile. Ambiguous ownership, private data in an unbound reserved Profile, or cross-owner state becomes `repair_required` and is never deleted or reassigned. Cloud activation is safely replayed with the same idempotency key after an ambiguous network result or crash.

- [ ] **Step 4: Reconcile after authenticated startup and owner changes**

`AgenteraAgentControlManager` uses one in-process single-flight per owner/runtime key. An authenticated online access-state event schedules `reconcilePendingInstallations`; offline/signed-out states do not call Cloud. Errors are logged by stable code only and leave the journal retryable.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm test -- src/main/agentera-agent-control/installation-operation-store.test.ts src/main/agentera-agent-control/installation-manager.test.ts src/main/agentera-agent-control/manager.test.ts tests/agentera-profile-binding.test.ts
npm run typecheck:node
git diff --check
```

Expected: PASS with one durable operation and no duplicate Profile across retries/restart.

### Task 4: Atomically freeze RuntimeBinding and ConversationBoundary

**Files:**

- Create: `src/main/agentera-agent-control/conversation-runtime-coordinator.ts`
- Create: `src/main/agentera-agent-control/conversation-runtime-coordinator.test.ts`
- Modify: `src/main/agentera-agent-control/runtime-binding-store.ts`
- Modify: `src/main/agentera-agent-control/runtime-binding-store.test.ts`
- Modify: `src/main/agentera-agent-control/conversation-boundary-store.ts`
- Modify: `src/main/agentera-agent-control/conversation-boundary-store.test.ts`
- Modify: `src/main/agentera-agent-control/hermes-adapter.ts`
- Modify: `src/main/agentera-agent-control/hermes-adapter.test.ts`
- Modify: `src/main/agentera-agent-control/manager.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `tests/agentera-agent-control-ipc.test.ts`

- [ ] **Step 1: Write rollback, restart, resume, concurrency, and owner-isolation tests**

Use real SQLite. Prove a boundary conflict rolls back a newly inserted binding and its pending Cloud record; an old binding-only crash is repaired by creating the matching boundary; concurrent prepares return one matching pair; and session attachment either updates both records or neither. Use two owners to prove no lookup returns the other owner’s binding or boundary.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- src/main/agentera-agent-control/conversation-runtime-coordinator.test.ts src/main/agentera-agent-control/runtime-binding-store.test.ts src/main/agentera-agent-control/conversation-boundary-store.test.ts src/main/agentera-agent-control/hermes-adapter.test.ts src/main/agentera-agent-control/manager.test.ts tests/agentera-agent-control-ipc.test.ts
```

Expected: FAIL because production still performs separate writes.

- [ ] **Step 3: Separate asynchronous validation from persistence**

`AgenteraHermesAdapter.prepareInstalledTurnPlan` validates entitlement, Profile/Installation ownership, immutable version/policy, Runtime, tools, model route, revocation, and projection without inserting a binding. The plan contains a normalized binding input and the data needed to compose the final envelope.

- [ ] **Step 4: Commit both snapshots and attach the session atomically**

`ConversationRuntimeCoordinator.prepare` runs one `BEGIN IMMEDIATE`, calls transaction-aware RuntimeBinding and ConversationBoundary store methods, asserts matching owner/Installation/Profile/Version/policy/tool fields, and commits. `attachHermesSession` wraps both conditional updates in one transaction. Existing non-installed Profiles still receive only a Profile-default ConversationBoundary.

- [ ] **Step 5: Route both IPC entry points through the coordinator**

Replace the production sequence `prepareHermesTurn()` then `prepareConversationBoundary()` in conversation context and `send-message` with one manager method. Replace the two session-attachment calls with one manager coordinator call.

- [ ] **Step 6: Verify GREEN**

Run the focused command from Step 2, `npm run typecheck`, and `git diff --check`. Expected: PASS; every installed conversation has both matching snapshots or neither.

### Task 5: Reap only Aera-owned gateways and finish repository knowledge/gates

**Files:**

- Create: `src/main/gateway-process-ownership.ts`
- Create: `src/main/gateway-process-ownership.test.ts`
- Modify: `src/main/hermes.ts`
- Modify: `src/main/hermes.test.ts`
- Modify: `tests/gateway-restart.test.ts`
- Modify: `src/main/app/start.ts`
- Modify: `lat.md/agentera-app-authentication.md`
- Modify: `lat.md/agentera-agent-control-plane.md`

- [ ] **Step 1: Write failure-first ownership-ledger tests**

Prove launch intent is durable before spawn, spawn failure clears it, normal exit stops every Aera-started named/default gateway, cold startup reaps a prior owned entry, and an unrecorded or unchanged pre-existing gateway is never stopped. The ledger stores Profile IDs and PID-file identity metadata only; no credential or physical path.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- src/main/gateway-process-ownership.test.ts src/main/hermes.test.ts tests/gateway-restart.test.ts
```

Expected: FAIL because only the current active Profile is stopped today.

- [ ] **Step 3: Implement owned gateway recovery and shutdown**

Configure the ledger from Electron `userData` before gateway use. Record only launches initiated by `startGatewayDetailed`; never claim an already-running gateway. On normal exit and account transition, stop all current-process owned profiles. On cold startup, compare the recorded pre-launch PID identity to the current exact Profile PID record and invoke the existing Runtime Profile-specific stop path only when the record proves a new Aera-owned launch. Clear dead/completed entries; retain ambiguous entries without killing a process.

- [ ] **Step 4: Update LAT and run all Desktop gates**

Document journal phases, atomic conversation snapshots, owner partitioning, and gateway ownership cleanup. Run:

```bash
npm test -- --maxWorkers=2
npm run typecheck
npm run lint
npm run build
npm run check:agentera-cloud-contract
npx --yes lat.md check
git diff --check
git status --short --branch
```

Expected: all commands PASS; only intended source/tests/LAT/plan changes are present, Desktop stays `0.7.4-internal-beta.22`, and the Runtime Seed contract is unchanged.
