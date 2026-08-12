# Beta.27 Agent Model Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a policy-eligible installed Agent switch model or provider inside one visible conversation while preserving immutable RuntimeBindings, old-message attribution, cold resume, credentials, attachments, and failure fallback.

**Architecture:** A local `ConversationThread` owns ordered immutable `ConversationSegment` records. Main resolves an opaque catalog selection, prepares a candidate RuntimeBinding/ConversationBoundary/segment atomically, starts a fresh Hermes session, and activates it only at the first irreversible output/tool event or successful completion; renderer shows policy-filtered choices and non-prompt switch markers.

**Tech Stack:** Electron, TypeScript, better-sqlite3, React 19, Hermes gateway/API transport, Vitest, Testing Library, Playwright, lat.md.

---

## Preconditions and file map

Execute `2026-08-11-beta27-model-configuration-reliability.md` first so `OwnerModelRouteCatalog` and opaque selections exist. Execute `2026-08-11-beta27-organization-submission-resilience.md` through Task 1 so schema-v12 thread/segment tables exist.

- Create `src/main/agentera-agent-control/frozen-agent-model-route.ts`: local-only resolved route validation and legacy binding compatibility.
- Create `src/main/agentera-agent-control/conversation-thread-store.ts` and tests: thread/segment CRUD, adoption, CAS activation, failure, lookup, and owner isolation.
- Modify `runtime-binding-store.ts` and tests: freeze full local route while keeping Cloud payload unchanged.
- Modify `conversation-runtime-coordinator.ts` and tests: atomically create/adopt candidate segment with binding and boundary.
- Modify `hermes-adapter.ts` and tests: validate requested/current route against signed and tenant policies without mutating existing bindings.
- Modify `manager.ts` and tests: resolve selections, choose/reuse/create segments, attach/activate/fail, and return public conversation model context.
- Modify `src/shared/agentera-global-profile.ts` and `src/shared/model-configuration.ts`: public policy/active-route/segment-event types.
- Modify `src/main/ipc/register.ts`: pass opaque Agent selection separately from ordinary override and drive segment lifecycle from transport events.
- Modify `src/main/hermes.ts` and `src/main/hermes.test.ts`: use a just-in-time Main execution lease for API mode/credential without serializing the secret.
- Modify preload type/runtime files: send parameter and `chat-agent-segment` event.
- Modify `Chat.tsx`, `useChatActions.ts`, `useChatIPC.ts`, `types.ts`, `MessageList.tsx`, and tests: staged selection, disabled states, active acknowledgement, markers, and rollback.
- Modify `sessions.ts`, `sessionHistory.ts`, `Layout.tsx`, and tests: collapse segment sessions into one recent item, resume active session, insert markers, and delete the full thread safely.
- Modify Agent/chat locale files and CSS for fixed-policy guidance and switch marker presentation.
- Modify `lat.md/model-selection.md` and `lat.md/agentera-agent-control-plane.md` with thread/segment behavior and tests.

### Task 1: Freeze the full local Agent route without changing ordinary overrides

**Files:**

- Create: `src/main/agentera-agent-control/frozen-agent-model-route.ts`
- Create: `src/main/agentera-agent-control/frozen-agent-model-route.test.ts`
- Modify: `src/main/agentera-agent-control/runtime-binding-store.ts`
- Modify: `src/main/agentera-agent-control/runtime-binding-store.test.ts`

- [ ] **Step 1: Write failing full-route and legacy tests**

```ts
it("freezes API mode and credential reference locally but not in Cloud", () => {
  const binding = store.create(
    bindingInput({
      modelRoute: frozenRoute({
        apiMode: "codex_responses",
        credentialRef: "CUSTOM_PROVIDER_PETOI_KEY",
      }),
    }),
  );
  expect(binding.modelRoute).toMatchObject({
    provider: "custom:petoi",
    model: "gpt-5.6-sol",
    apiMode: "codex_responses",
    credentialRef: "CUSTOM_PROVIDER_PETOI_KEY",
  });
  expect(JSON.stringify(store.pendingCloudRecords())).not.toMatch(
    /petoi|responses|credentialRef|CUSTOM_PROVIDER/i,
  );
});

it("reads a three-field Beta.26 route as immutable legacy data", () => {
  writeLegacyBindingJson({
    modelRoute: {
      provider: "openai",
      model: "gpt-5.6",
      baseUrl: "https://api.openai.com/v1",
    },
  });
  expect(store.getByConversationKey("legacy")?.modelRoute).toMatchObject({
    provider: "openai",
    model: "gpt-5.6",
    apiMode: null,
    credentialRef: null,
    legacy: true,
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/agentera-agent-control/frozen-agent-model-route.test.ts src/main/agentera-agent-control/runtime-binding-store.test.ts`

Expected: FAIL because RuntimeBinding accepts only `SessionModelOverride`.

- [ ] **Step 3: Add strict local and legacy parsing**

Define:

```ts
export interface FrozenAgentModelRoute {
  provider: string;
  model: string;
  baseUrl: string;
  apiMode: string | null;
  sourceProfileId: string | null;
  modelLibraryId: string | null;
  credentialRef: string | null;
  legacy: boolean;
}
```

`freezeResolvedOwnerModelRoute()` accepts only a current `ResolvedOwnerModelRoute`, bounds every string, and sets `legacy:false`. `parseFrozenAgentModelRoute()` accepts either the exact new shape or the exact historical three-field shape; unknown keys, paths, raw secrets, invalid URL/control characters, and partial new shapes throw `binding_corrupt`.

Change only local binding JSON/modelRoute types. Keep `CLOUD_FIELDS`, the sanitized outbox body, and ordinary `SessionModelOverride` untouched.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/main/agentera-agent-control/frozen-agent-model-route.test.ts src/main/agentera-agent-control/runtime-binding-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentera-agent-control/frozen-agent-model-route.ts src/main/agentera-agent-control/frozen-agent-model-route.test.ts src/main/agentera-agent-control/runtime-binding-store.ts src/main/agentera-agent-control/runtime-binding-store.test.ts
git commit -m "feat(agents): freeze complete local model routes"
```

### Task 2: Implement the owner-scoped thread and segment store

**Files:**

- Create: `src/main/agentera-agent-control/conversation-thread-store.ts`
- Create: `src/main/agentera-agent-control/conversation-thread-store.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it("prepares a candidate without replacing the active segment", () => {
  const active = store.adopt(adoption());
  const candidate = store.prepareCandidate(
    candidateInput({
      expectedThreadRevision: active.thread.revision,
      ordinal: 2,
    }),
  );
  expect(candidate.segment.state).toBe("preparing");
  expect(store.getThread(active.thread.id)?.activeSegmentId).toBe(
    active.segment.id,
  );
});

it("activates once with CAS and supersedes the old immutable segment", () => {
  const { thread, segment: oldSegment } = store.adopt(adoption());
  const candidate = store.prepareCandidate(
    candidateInput({
      expectedThreadRevision: thread.revision,
      ordinal: 2,
    }),
  );
  store.attachSession(candidate.segment.id, "hermes-new");
  const activated = store.activate({
    threadId: thread.id,
    segmentId: candidate.segment.id,
    expectedThreadRevision: thread.revision,
  });
  expect(activated.segment.state).toBe("active");
  expect(store.getSegment(oldSegment.id)?.state).toBe("superseded");
  expect(() =>
    store.activate({
      threadId: thread.id,
      segmentId: candidate.segment.id,
      expectedThreadRevision: thread.revision,
    }),
  ).toThrowErrorMatchingObject({ code: "model_switch_segment_conflict" });
});
```

Add tests for owner isolation, lookup by any Hermes session, exact route parsing, unique ordinal/session, failed candidate retention, no two active segments, and root-key adoption idempotency.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/agentera-agent-control/conversation-thread-store.test.ts`

Expected: FAIL because the store is absent.

- [ ] **Step 3: Implement validated rows and transactions**

Expose:

```ts
export class ConversationThreadStore {
  adopt(input: AdoptConversationSegmentInput): ConversationThreadSnapshot;
  prepareCandidate(
    input: PrepareConversationSegmentInput,
  ): ConversationThreadSnapshot;
  attachSession(segmentId: string, sessionId: string): ConversationSegment;
  activate(input: ActivateConversationSegmentInput): ConversationThreadSnapshot;
  fail(input: FailConversationSegmentInput): ConversationThreadSnapshot;
  getByRootConversationKey(key: string): ConversationThreadSnapshot | null;
  getByHermesSessionId(sessionId: string): ConversationThreadSnapshot | null;
  listSegments(threadId: string): ConversationSegment[];
}
```

Validate owner/device tuple on every query. `adopt` creates one active ordinal-1 segment around an existing verified binding/boundary/session or returns the exact existing row. Persist `route_json` only through `serializeFrozenAgentModelRoute()` and parse it through `parseFrozenAgentModelRoute()` on every read. A new segment must have both `sourceProfileId` and `modelLibraryId`; an adopted Beta.26 legacy binding has both fields `null`. Public snapshots map only to `PublicModelRouteIdentity` and never return `route_json` or `credentialRef`. `prepareCandidate` inserts only `preparing`; `activate` uses one `BEGIN IMMEDIATE` CAS on thread revision, supersedes the prior active row, activates the candidate, and increments revision. The schema partial unique index plus the transaction must prevent two active segments. `fail` never changes the active segment.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/main/agentera-agent-control/conversation-thread-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentera-agent-control/conversation-thread-store.ts src/main/agentera-agent-control/conversation-thread-store.test.ts
git commit -m "feat(agents): persist immutable conversation segments"
```

### Task 3: Make binding, boundary, and candidate creation atomic

**Files:**

- Modify: `src/main/agentera-agent-control/conversation-runtime-coordinator.ts`
- Modify: `src/main/agentera-agent-control/conversation-runtime-coordinator.test.ts`
- Modify: `src/main/agentera-agent-control/runtime-binding-store.ts`
- Modify: `src/main/agentera-agent-control/conversation-boundary-store.ts`
- Modify: `src/main/agentera-agent-control/runtime-binding-store.test.ts`
- Modify: `src/main/agentera-agent-control/conversation-boundary-store.test.ts`

- [ ] **Step 1: Write failing atomicity tests**

```ts
it("rolls back thread, segment, binding, and boundary together", () => {
  boundaryStore.failNextPrepare("boundary_conflict");
  expect(() => coordinator.prepareSegment(input())).toThrowErrorMatchingObject({
    code: "boundary_conflict",
  });
  expect(count(database, "conversation_threads")).toBe(0);
  expect(count(database, "conversation_segments")).toBe(0);
  expect(count(database, "runtime_bindings")).toBe(0);
  expect(count(database, "conversation_boundaries")).toBe(0);
});

it("attaches one session to binding, boundary, and segment atomically", () => {
  const prepared = coordinator.prepareSegment(input());
  const attached = coordinator.attachSegmentSession({
    segmentId: prepared.segment.id,
    runtimeBindingId: prepared.runtimeBinding!.id,
    boundaryId: prepared.boundary.id,
    sessionId: "hermes-segment-2",
  });
  expect(attached.segment.hermesSessionId).toBe("hermes-segment-2");
  expect(attached.runtimeBinding?.hermesSessionId).toBe("hermes-segment-2");
  expect(attached.boundary.hermesSessionId).toBe("hermes-segment-2");
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/agentera-agent-control/conversation-runtime-coordinator.test.ts`

Expected: FAIL because the coordinator does not own segment lifecycle.

- [ ] **Step 3: Refactor transaction ownership**

Add `prepareSegment`, `attachSegmentSession`, `activateSegment`, and `failSegment`. Pass one `ConversationThreadStore` into the coordinator. Move existing binding/boundary calls to their `*InTransaction` variants and prohibit nested `BEGIN`. Preserve `prepare()` as a compatibility wrapper for non-Agent and pre-v12 callers.

Generate the segment UUID before inserting and derive the candidate conversation key as `aera-segment:${threadId}:${segmentId}`. Validate both UUIDs and the final bounded key. Never use the renderer-provided root text, model/provider labels, or a NUL character in the segment key; the thread row remains the only owner of the visible root conversation key.

- [ ] **Step 4: Verify GREEN and existing boundary behavior**

Run: `npx vitest run src/main/agentera-agent-control/conversation-runtime-coordinator.test.ts src/main/agentera-agent-control/conversation-boundary-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentera-agent-control/conversation-runtime-coordinator.ts src/main/agentera-agent-control/conversation-runtime-coordinator.test.ts src/main/agentera-agent-control/runtime-binding-store.ts src/main/agentera-agent-control/conversation-boundary-store.ts src/main/agentera-agent-control/runtime-binding-store.test.ts src/main/agentera-agent-control/conversation-boundary-store.test.ts
git commit -m "feat(agents): coordinate segment runtime boundaries"
```

### Task 4: Resolve requested routes through signed policies

**Files:**

- Modify: `src/main/agentera-agent-control/hermes-adapter.ts`
- Modify: `src/main/agentera-agent-control/hermes-adapter.test.ts`
- Modify: `src/main/agentera-agent-control/model-policy.ts`
- Modify: `src/main/agentera-agent-control/model-policy.test.ts`

- [ ] **Step 1: Write failing policy tests**

```ts
it.each([
  ["user_select", true],
  ["allowlist", true],
  ["fixed", false],
] as const)("applies %s to a requested route", async (mode, allowed) => {
  usePolicy(mode);
  const action = adapter.prepareInstalledTurnPlan({
    ...turnInput(),
    conversationKey: "root\0segment:2",
    requestedModelRoute: PETOI_ROUTE,
    existingBinding: FIRST_BINDING,
  });
  if (allowed) {
    await expect(action).resolves.toMatchObject({
      bindingInput: { modelRoute: PETOI_ROUTE },
    });
  } else {
    await expect(action).rejects.toMatchObject({
      code: "model_switch_fixed_policy",
    });
  }
});
```

Add allowlist provider/model intersection, tenant-policy denial, stale current credential, same-route reuse, and legacy-route continuation tests.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/agentera-agent-control/model-policy.test.ts src/main/agentera-agent-control/hermes-adapter.test.ts -t "requested route|fixed"`

Expected: FAIL because the adapter always chooses `existing?.modelRoute`.

- [ ] **Step 3: Separate current-segment validation from candidate selection**

Add a policy decision function returning `{ allowed, reason }` for `user_select`, `allowlist`, and `fixed`. In `prepareInstalledTurnPlan`, require an explicit `requestedModelRoute` only for a new segment. Revalidate existing binding route for resume; never replace it. For a candidate, validate the resolved route against AgentVersion and tenant policy, freeze it, and build a new binding input with the segment conversation key.

Do not read a renderer Base URL, API mode, or credential reference. The caller must provide a route resolved by `OwnerModelRouteCatalog` in the same Main turn.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/main/agentera-agent-control/model-policy.test.ts src/main/agentera-agent-control/hermes-adapter.test.ts`

Expected: PASS, including the existing “changed default does not alter old binding” test.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentera-agent-control/hermes-adapter.ts src/main/agentera-agent-control/hermes-adapter.test.ts src/main/agentera-agent-control/model-policy.ts src/main/agentera-agent-control/model-policy.test.ts
git commit -m "feat(agents): validate model switches against policy"
```

### Task 5: Orchestrate thread adoption and route selection in Manager

**Files:**

- Modify: `src/shared/agentera-global-profile.ts`
- Modify: `src/shared/model-configuration.ts`
- Modify: `src/main/agentera-agent-control/manager.ts`
- Modify: `src/main/agentera-agent-control/manager.test.ts`

- [ ] **Step 1: Write failing Manager tests**

```ts
it("adopts the first installed-Agent runtime as one active segment", async () => {
  const prepared = await manager.prepareConversationRuntime(turnInput());
  expect(prepared.agentConversation).toMatchObject({
    policyMode: "user_select",
    activeRoute: expect.objectContaining({ model: "gpt-5.6" }),
    activeSegmentOrdinal: 1,
  });
  expect(count(database, "conversation_threads")).toBe(1);
  expect(count(database, "conversation_segments")).toBe(1);
});

it("resolves a different opaque selection into a preparing segment", async () => {
  const first = await manager.prepareConversationRuntime(turnInput());
  manager.attachConversationRuntimeSession({
    ...attachInput(first),
    sessionId: "hermes-old",
  });
  const next = await manager.prepareConversationRuntime({
    ...turnInput(),
    resumeSessionId: "hermes-old",
    requestedModelSelection: PETOI_SELECTION,
    visibleHistoryCount: 8,
  });
  expect(next.segmentTransition).toMatchObject({
    kind: "candidate",
    from: expect.objectContaining({ model: "gpt-5.6" }),
    to: expect.objectContaining({ model: "gpt-5.6-sol" }),
    historyBoundaryCount: 8,
  });
  expect(next.agentConversation.activeSegmentOrdinal).toBe(1);
});
```

Add same-route reuse, stale revision, missing credential, fixed policy, lookup by old segment session, and concurrent revision conflict tests.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/agentera-agent-control/manager.test.ts -t "active segment|preparing segment|stale revision|fixed policy"`

Expected: FAIL because Manager has no thread/catalog orchestration.

- [ ] **Step 3: Add public context and lifecycle methods**

Define redacted renderer contracts:

```ts
export interface AgentConversationModelContext {
  threadId: string;
  policyMode: "user_select" | "allowlist" | "fixed";
  activeRoute: PublicModelRouteIdentity;
  activeSegmentOrdinal: number;
  catalog: OwnerModelRouteCatalogSnapshot;
  switchDisabledCode: "model_switch_fixed_policy" | null;
}

export interface AgentConversationSegmentEvent {
  state: "preparing" | "active" | "failed";
  threadId: string;
  segmentId: string;
  from: PublicModelRouteIdentity;
  to: PublicModelRouteIdentity;
  historyBoundaryCount: number;
  code: string | null;
}
```

Extend the conversation-context return with `agentConversation: AgentConversationModelContext | null`. Extend `PrepareAgenteraHermesTurnInput` internally with `requestedModelSelection?: OwnerModelRouteSelection` and `visibleHistoryCount?: number`.

Manager must:

1. verify the Profile binding and installed Installation;
2. prepare/adopt the first binding/boundary and thread;
3. resolve any requested selection from the current catalog;
4. reuse the active segment when route keys match;
5. otherwise ask the adapter for a candidate plan and call `prepareSegment`;
6. return redacted context plus the private prepared turn;
7. expose `attachConversationRuntimeSession`, `activateConversationSegment`, and `failConversationSegment` with current-owner checks.

- [ ] **Step 4: Verify GREEN and public redaction**

Run: `npx vitest run src/main/agentera-agent-control/manager.test.ts`

Expected: PASS; serialized public context contains no `credentialRef`, key value, owner ID, Profile path, or prompt bytes.

- [ ] **Step 5: Commit**

```bash
git add src/shared/agentera-global-profile.ts src/shared/model-configuration.ts src/main/agentera-agent-control/manager.ts src/main/agentera-agent-control/manager.test.ts
git commit -m "feat(agents): orchestrate conversation model segments"
```

### Task 6: Drive segment lifecycle from the real send transport

**Files:**

- Create: `src/main/agent-model-execution-lease.ts`
- Create: `src/main/agent-model-execution-lease.test.ts`
- Modify: `src/main/hermes.ts`
- Modify: `src/main/hermes.test.ts`
- Modify: `src/main/ipc/register.ts`
- Create: `src/main/ipc/register.agent-model-switch.test.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`

- [ ] **Step 1: Write failing execution-lease tests**

```ts
it("resolves a same-owner credential only inside the send callback", async () => {
  const lease = createAgentModelExecutionLease({
    route: PETOI_FROZEN_ROUTE,
    getSecret: vi.fn(() => API_KEY),
    verifySourceProfile: vi.fn(() => true),
  });
  await lease.run(async (execution) => {
    expect(execution.modelOverride).toEqual({
      provider: "custom:petoi",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.petoi.cn/v1",
    });
    expect(execution.apiMode).toBe("codex_responses");
    expect(execution.credential).toBe(API_KEY);
  });
  expect(JSON.stringify(lease.publicIdentity)).not.toContain(API_KEY);
  expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining(API_KEY));
});

it("rejects SSH when the remote route is not already configured", async () => {
  await expect(
    createAgentModelExecutionLease(remoteInput({ routeAvailable: false })).run(
      vi.fn(),
    ),
  ).rejects.toMatchObject({ code: "model_switch_remote_unavailable" });
});
```

- [ ] **Step 2: Write failing IPC lifecycle tests**

Mock `sendMessage` callbacks and prove the activation point:

```ts
it("keeps the old segment active when candidate setup fails before output", async () => {
  sendMessage.mockRejectedValueOnce(new Error("connect failed"));
  await expect(invokeSend(agentSwitchInput())).rejects.toThrow(
    "connect failed",
  );
  expect(control.failConversationSegment).toHaveBeenCalledTimes(1);
  expect(control.activateConversationSegment).not.toHaveBeenCalled();
});

it("activates once before forwarding the first tool event and never replays", async () => {
  sendMessage.mockImplementation((_message, callbacks) => {
    callbacks.onSessionStarted("hermes-new");
    callbacks.onToolEvent(toolEvent());
    callbacks.onError("provider disconnected");
    return abortHandle();
  });
  await expect(invokeSend(agentSwitchInput())).rejects.toThrow();
  expect(control.activateConversationSegment).toHaveBeenCalledTimes(1);
  expect(sendMessage).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Run and verify RED**

Run: `npx vitest run src/main/agent-model-execution-lease.test.ts src/main/ipc/register.agent-model-switch.test.ts`

Expected: FAIL because no execution lease, selection argument, or segment event exists.

- [ ] **Step 4: Implement just-in-time execution and event state**

The execution lease revalidates source Profile, model row, API mode, provider endpoint, and credential reference immediately before send. It passes the secret only to the internal provider request builder, then drops references in `finally`. For local gateway/API transport, route provider/model/Base URL/API mode explicitly; do not rewrite an old RuntimeBinding. For SSH/remote, require the remote configuration inventory to match and never copy a local credential.

Extend `send-message` with a final optional `agentModelSelection` separate from `SessionModelOverride`. In the handler:

1. call Manager preparation with visible history count;
2. emit `chat-agent-segment` `preparing` for a candidate;
3. attach session in `onSessionStarted` without activation;
4. use an idempotent `activateCandidate()` before forwarding the first content/reasoning/tool event, or in `onDone` if no such event occurred;
5. on pre-activation error call `failConversationSegment` and emit `failed`;
6. after activation report the transport error without fallback/replay.

Thread the new event and selection through preload. No event includes credential reference/value or local identifiers beyond thread/segment IDs and safe route identity.

- [ ] **Step 5: Verify GREEN and attachment routing**

Run: `npx vitest run src/main/agent-model-execution-lease.test.ts src/main/ipc/register.agent-model-switch.test.ts`.

Then run `npx vitest run src/main/hermes.test.ts -t "attachment|session override"` and require PASS. Agent attachment turns must remain on API/gateway transport.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent-model-execution-lease.ts src/main/agent-model-execution-lease.test.ts src/main/hermes.ts src/main/hermes.test.ts src/main/ipc/register.ts src/main/ipc/register.agent-model-switch.test.ts src/preload/index.ts src/preload/index.d.ts
git commit -m "feat(agents): activate model segments on real transport"
```

### Task 7: Add policy-filtered picker state and model-switch markers

**Files:**

- Modify: `src/renderer/src/screens/Chat/Chat.tsx`
- Modify: `src/renderer/src/screens/Chat/Chat.global-profile-transport.test.tsx`
- Modify: `src/renderer/src/screens/Chat/hooks/useChatActions.ts`
- Modify: `src/renderer/src/screens/Chat/hooks/useChatActions.memory-candidate.test.tsx`
- Modify: `src/renderer/src/screens/Chat/hooks/useChatIPC.ts`
- Modify: `src/renderer/src/screens/Chat/hooks/useChatIPC.test.tsx`
- Modify: `src/renderer/src/screens/Chat/ModelPicker.tsx`
- Modify: `src/renderer/src/screens/Chat/ModelPicker.test.tsx`
- Modify: `src/renderer/src/screens/Chat/types.ts`
- Modify: `src/renderer/src/screens/Chat/MessageList.tsx`
- Create: `src/renderer/src/screens/Chat/ModelSwitchMarker.tsx`
- Create: `src/renderer/src/screens/Chat/ModelSwitchMarker.test.tsx`
- Modify: `src/renderer/src/assets/main.css`
- Modify: `src/shared/i18n/locales/en/chat.ts`
- Modify: `src/shared/i18n/locales/zh-CN/chat.ts`
- Modify: `src/shared/i18n/locales/en/agents.ts`
- Modify: `src/shared/i18n/locales/zh-CN/agents.ts`

- [ ] **Step 1: Write failing picker and marker tests**

```tsx
it("stages an installed-Agent selection until the next send", async () => {
  renderAgentChat({ policyMode: "user_select", routes: [OPENAI, PETOI] });
  await chooseModel("Petoi · gpt-5.6-sol");
  expect(setSessionModelOverride).not.toHaveBeenCalled();
  expect(screen.getByText("chat.modelSwitch.pending")).toBeVisible();
  await send("continue");
  expect(sendMessage).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ agentModelSelection: PETOI.selection }),
  );
});

it("disables a fixed-policy Agent picker with an explanation", () => {
  renderAgentChat({ policyMode: "fixed", routes: [OPENAI] });
  expect(screen.getByRole("button", { name: /gpt-5.6/i })).toBeDisabled();
  expect(screen.getByText("chat.modelSwitch.fixedPolicy")).toBeVisible();
});

it("inserts one non-prompt marker only after Main activation", () => {
  const { emitSegment } = renderAgentChat();
  emitSegment(activeSegmentEvent({ historyBoundaryCount: 2 }));
  expect(screen.getAllByTestId("model-switch-marker")).toHaveLength(1);
  expect(historySentToAgent()).not.toContain("Model changed from");
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/renderer/src/screens/Chat/ModelPicker.test.tsx src/renderer/src/screens/Chat/ModelSwitchMarker.test.tsx src/renderer/src/screens/Chat/hooks/useChatIPC.test.tsx src/renderer/src/screens/Chat/Chat.global-profile-transport.test.tsx`

Expected: FAIL because Chat treats every selection as an ordinary override and has no segment event.

- [ ] **Step 3: Implement explicit installed-Agent state**

Add:

```ts
export interface ModelSwitchMessage {
  id: string;
  kind: "model_switch";
  role: "agent";
  from: PublicModelRouteIdentity;
  to: PublicModelRouteIdentity;
  segmentId: string;
  localOnly: true;
}
```

Include it in `ChatMessage`; `shouldSendToAgent` and transcript export must exclude it. `MessageList` renders it through `ModelSwitchMarker` without an Agent avatar.

Store `agentConversation`, `pendingAgentModelSelection`, and `agentSwitchState` separately from ordinary `sessionModelOverride`. Use catalog routes for installed Agents and existing model groups for ordinary chats. Disable during `isLoading`/preparing/fixed. A `preparing` event shows pending state; `active` updates active route, clears the pending selection, and inserts/deduplicates the marker at `historyBoundaryCount`; `failed` restores the active display and shows localized guidance.

- [ ] **Step 4: Verify GREEN and ordinary-chat compatibility**

Run: `npx vitest run src/renderer/src/screens/Chat/ModelPicker.test.tsx src/renderer/src/screens/Chat/ModelSwitchMarker.test.tsx src/renderer/src/screens/Chat/hooks/useChatIPC.test.tsx src/renderer/src/screens/Chat/Chat.global-profile-transport.test.tsx src/main/session-model-override-store.test.ts`

Expected: PASS; ordinary chat still persists `{ provider, model, baseUrl }` by session ID.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/screens/Chat/Chat.tsx src/renderer/src/screens/Chat/Chat.global-profile-transport.test.tsx
git add src/renderer/src/screens/Chat/hooks/useChatActions.ts src/renderer/src/screens/Chat/hooks/useChatActions.memory-candidate.test.tsx src/renderer/src/screens/Chat/hooks/useChatIPC.ts src/renderer/src/screens/Chat/hooks/useChatIPC.test.tsx
git add src/renderer/src/screens/Chat/ModelPicker.tsx src/renderer/src/screens/Chat/ModelPicker.test.tsx src/renderer/src/screens/Chat/types.ts src/renderer/src/screens/Chat/MessageList.tsx src/renderer/src/screens/Chat/ModelSwitchMarker.tsx src/renderer/src/screens/Chat/ModelSwitchMarker.test.tsx src/renderer/src/assets/main.css
git add src/shared/i18n/locales/en/chat.ts src/shared/i18n/locales/zh-CN/chat.ts src/shared/i18n/locales/en/agents.ts src/shared/i18n/locales/zh-CN/agents.ts
git commit -m "feat(chat): show safe Agent model transitions"
```

### Task 8: Collapse segments for recents, cold resume, and deletion

**Files:**

- Create: `src/main/agentera-agent-control/conversation-thread-session-projection.ts`
- Create: `src/main/agentera-agent-control/conversation-thread-session-projection.test.ts`
- Modify: `src/main/sessions.ts`
- Modify: `tests/sessions-delete-session.test.ts`
- Modify: `tests/sessions-history-items.test.ts`
- Modify: `tests/session-history-mapping.test.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/renderer/src/screens/Chat/sessionHistory.ts`
- Create: `src/renderer/src/screens/Chat/sessionHistory.test.ts`
- Modify: `src/renderer/src/screens/Layout/Layout.tsx`
- Modify: `src/renderer/src/screens/Layout/chatRuns.test.ts`

- [ ] **Step 1: Write failing projection tests**

```ts
it("collapses three Hermes segments into the active visible thread", () => {
  const projected = projectSessionSummaries({
    sessions: [session("s1"), session("s2"), session("s3")],
    threads: [threadWithSegments(["s1", "s2", "s3"], "s3")],
  });
  expect(projected).toHaveLength(1);
  expect(projected[0]).toMatchObject({ sessionId: "s3", segmentCount: 3 });
});

it("resuming any segment resolves the active session and all markers", () => {
  expect(projection.resolveResume("s1")).toEqual({
    activeSessionId: "s3",
    threadId: THREAD_ID,
    markers: [marker(1), marker(2)],
  });
});

it("expands one visible delete into every segment session", () => {
  expect(projection.expandDelete("s3")).toEqual(["s1", "s2", "s3"]);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/agentera-agent-control/conversation-thread-session-projection.test.ts src/renderer/src/screens/Chat/sessionHistory.test.ts`

Expected: FAIL because session listing/loading treats segments as unrelated sessions.

- [ ] **Step 3: Implement Main projection and renderer marker merge**

Post-process `listSessions()` with current-owner thread metadata: hide failed/preparing sessions, collapse active/superseded sessions, retain the latest title/timestamp/count, and never merge sessions from another owner/Profile. Before loading a requested session, resolve it to the active session and return redacted marker metadata. Insert markers by `historyBoundaryCount` after database-to-chat conversion and deduplicate by segment ID.

For deletion, expand the visible active session into all thread sessions, call existing `deleteSessionRows` for each inside the existing transaction, then delete segment/thread metadata only after session deletion succeeds. ConversationBoundary/RuntimeBinding retention follows current audit rules; do not force-delete restricted rows.

- [ ] **Step 4: Verify GREEN and cold resume**

Run: `npx vitest run src/main/agentera-agent-control/conversation-thread-session-projection.test.ts src/renderer/src/screens/Chat/sessionHistory.test.ts src/renderer/src/screens/Layout/chatRuns.test.ts tests/sessions-delete-session.test.ts tests/sessions-history-items.test.ts tests/session-history-mapping.test.ts`

Expected: PASS. In `conversation-thread-session-projection.test.ts`, add one integration-style test that closes and reopens the same fixture control-plane database, reconstructs the projection, and resolves `s1` into active `s3` with two redacted markers.

- [ ] **Step 5: Commit**

```bash
git add src/main/agentera-agent-control/conversation-thread-session-projection.ts src/main/agentera-agent-control/conversation-thread-session-projection.test.ts src/main/sessions.ts src/main/ipc/register.ts src/renderer/src/screens/Chat/sessionHistory.ts src/renderer/src/screens/Chat/sessionHistory.test.ts src/renderer/src/screens/Layout/Layout.tsx src/renderer/src/screens/Layout/chatRuns.test.ts tests/sessions-delete-session.test.ts tests/sessions-history-items.test.ts tests/session-history-mapping.test.ts
git commit -m "feat(chat): resume Agent conversation threads"
```

### Task 9: Document and verify the switching slice

**Files:**

- Modify: `lat.md/model-selection.md`
- Modify: `lat.md/agentera-agent-control-plane.md`

- [ ] **Step 1: Add exact architecture/test sections**

Document stable visible thread, immutable segment lifecycle, activation point, policy modes, just-in-time credentials, SSH limitation, attachment transport, marker exclusion from prompts, cold resume, and safe deletion. Bind each leaf behavior to one primary test with `@lat:`.

- [ ] **Step 2: Run Node and renderer gates**

```bash
npx vitest run \
  src/main/agentera-agent-control/frozen-agent-model-route.test.ts \
  src/main/agentera-agent-control/runtime-binding-store.test.ts \
  src/main/agentera-agent-control/conversation-thread-store.test.ts \
  src/main/agentera-agent-control/conversation-runtime-coordinator.test.ts \
  src/main/agentera-agent-control/model-policy.test.ts \
  src/main/agentera-agent-control/hermes-adapter.test.ts \
  src/main/agentera-agent-control/manager.test.ts \
  src/main/agent-model-execution-lease.test.ts \
  src/main/ipc/register.agent-model-switch.test.ts \
  src/main/agentera-agent-control/conversation-thread-session-projection.test.ts \
  src/renderer/src/screens/Chat/ModelPicker.test.tsx \
  src/renderer/src/screens/Chat/ModelSwitchMarker.test.tsx \
  src/renderer/src/screens/Chat/hooks/useChatIPC.test.tsx \
  src/renderer/src/screens/Chat/hooks/useChatActions.memory-candidate.test.tsx \
  src/renderer/src/screens/Chat/Chat.global-profile-transport.test.tsx \
  src/renderer/src/screens/Chat/sessionHistory.test.ts \
  src/renderer/src/screens/Layout/chatRuns.test.ts
npm run typecheck
npx prettier --check \
  src/main/agentera-agent-control/frozen-agent-model-route*.ts \
  src/main/agentera-agent-control/conversation-thread*.ts \
  src/main/agent-model-execution-lease*.ts \
  src/renderer/src/screens/Chat \
  lat.md/model-selection.md lat.md/agentera-agent-control-plane.md
npm exec --yes --package=lat.md@0.12.1 -- lat check
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Run failure-boundary regression groups**

Run the exact compatibility boundary files in bounded Vitest batches:

```bash
npx vitest run \
  src/main/agentera-agent-control/manager.test.ts \
  src/main/agentera-agent-control/hermes-adapter.test.ts \
  src/main/agentera-agent-control/conversation-boundary-store.test.ts \
  src/main/session-model-override-store.test.ts \
  src/main/hermes.test.ts \
  tests/sessions-delete-session.test.ts \
  tests/sessions-history-items.test.ts \
  tests/session-history-mapping.test.ts
```

Expected: PASS with ordinary session overrides, attachment routing, immutable boundaries, and multi-segment deletion all covered. Do not rerun unchanged batches after a later documentation-only edit.

- [ ] **Step 4: Commit documentation**

```bash
git add lat.md/model-selection.md lat.md/agentera-agent-control-plane.md
git commit -m "docs(chat): record immutable Agent model segments"
```

- [ ] **Step 5: Record the exact slice head**

Run: `git status --short --branch && git rev-parse HEAD`

Expected: clean worktree; retain the SHA for integration without claiming Electron, CI, or release completion.
