# Aera Agent Experience v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the Beta.35 fresh-Agent staging/retry fixes into Beta.36 and make Agent, model-switch, and team entry points capability-first without weakening Owner/Profile isolation.

**Architecture:** Fix the cross-repository root cause at the Runtime's existing Hermes-root resolver, then make Desktop fresh-Profile recovery depend on the durable reservation, owner binding, runtime Profile identity, and a bounded safe-scaffold inspection rather than directory existence. Keep the existing Owner model catalog, immutable conversation segments, and Hermes Kanban dispatcher; the renderer only simplifies actions, localizes errors, and exposes an honest team entry point.

**Tech Stack:** Python 3.11+/pytest, Electron, TypeScript, React, Vitest/Testing Library, Playwright, SQLite, lat.md.

---

### Task 1: Preserve a staged HERMES_HOME below the default Runtime root

**Files:**
- Modify: `/Users/zizimutou/Desktop/aera/aera-runtime/.worktrees/agent-experience-v2-runtime/tests/test_hermes_constants.py`
- Modify: `/Users/zizimutou/Desktop/aera/aera-runtime/.worktrees/agent-experience-v2-runtime/hermes_constants.py:161-200`

- [ ] **Step 1: Write the failing resolver tests**

Add behavior tests to `TestGetDefaultHermesRoot` for the exact default root, a named Profile, Desktop staging, and a custom root:

```python
def test_staging_home_below_native_root_is_not_collapsed(self, tmp_path, monkeypatch):
    native_root = tmp_path / ".hermes"
    staging_home = native_root / ".aera-profile-staging" / "operation-1" / "home"
    staging_home.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(staging_home))
    assert get_default_hermes_root() == staging_home

def test_native_named_profile_still_resolves_to_native_root(self, tmp_path, monkeypatch):
    native_root = tmp_path / ".hermes"
    profile = native_root / "profiles" / "researcher"
    profile.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(profile))
    assert get_default_hermes_root() == native_root
```

- [ ] **Step 2: Run the focused Runtime test and verify the staging case fails**

Run: `scripts/run_tests.sh tests/test_hermes_constants.py -k get_default_hermes_root`

Expected: the staging test fails because the current resolver returns `<tmp>/.hermes`.

- [ ] **Step 3: Narrow the resolver to the exact named-Profile shape**

Replace the broad containment shortcut with shape-aware resolution:

```python
native_home = _get_platform_default_hermes_home()
env_path = Path(env_home)
resolved_env = env_path.resolve()
resolved_native = native_home.resolve()
if resolved_env == resolved_native:
    return native_home
if resolved_env.parent.name == "profiles":
    root = resolved_env.parent.parent
    return native_home if root == resolved_native else env_path.parent.parent
return env_path
```

The comparison may resolve symlinks, but the returned non-Profile staging path remains the original `env_path`.

- [ ] **Step 4: Run focused and profile-resolution regression tests**

Run: `scripts/run_tests.sh tests/test_hermes_constants.py tests/gateway/test_profile_resolution.py`

Expected: both files pass with no flaky retry.

- [ ] **Step 5: Commit the Runtime fix**

```bash
git add hermes_constants.py tests/test_hermes_constants.py
git commit -m "fix(runtime): preserve isolated profile staging root"
```

### Task 2: Classify an existing fresh-Profile destination before retry

**Files:**
- Modify: `src/main/agentera-profile-binding.ts:90-135,390-435,481-502`
- Modify: `src/main/agentera-agent-control/installation-manager.ts:194-235,2741-2880`
- Modify: `src/main/profiles.ts:404-525`
- Modify: `src/main/agentera-agent-control/installation-manager.test.ts`
- Modify: `tests/agentera-profile-binding.test.ts`
- Modify: `lat.md/agentera-agent-control-plane.md:285-365`

- [ ] **Step 1: Write failing half-Profile and ownership tests**

Extend the installation fixture with a Profile destination containing only the known interrupted scaffold (`.env`, `SOUL.md`, empty `sessions/`, empty `skills/`) and assert:

```ts
expect(await manager().retryPendingInstallation(AGENT_INSTALLATION_ID, {
  modelProfileId: "configured-source",
})).toMatchObject({ status: "active", runtimeProfileId: RUNTIME_PROFILE_ID });
expect(prepareProfile).toHaveBeenCalledOnce();
expect(bindings.verifyProfileBinding(freshProfilePath, owner)).toMatchObject({
  runtimeProfileId: RUNTIME_PROFILE_ID,
  agentInstallationId: AGENT_INSTALLATION_ID,
});
```

Add negative cases proving that a foreign binding, missing/mismatched reservation, non-empty `MEMORY.md`, non-empty `sessions`, arbitrary file, or unexpected symlink is untouched and returns the existing bounded conflict/private-data code.

- [ ] **Step 2: Run the new installation tests and verify failure before mutation**

Run: `npx vitest run src/main/agentera-agent-control/installation-manager.test.ts`

Expected: the half-Profile retry fails because `existsSync(profilePath)` skips staged preparation; negative cases remain unchanged on disk.

- [ ] **Step 3: Add a bounded safe-scaffold classifier**

Export a filesystem-only inspection that never reads secret contents and returns one of four states:

```ts
export type FreshProfileDestinationState =
  | { status: "missing" }
  | { status: "safe_interrupted_scaffold" }
  | { status: "meaningful_or_unknown" }
  | { status: "owned"; binding: RuntimeOwnerBinding; isCurrentOwner: boolean };
```

Only allow regular `.env`, `SOUL.md`, `profile-meta.json`, and empty known scaffold directories. Reject symlinks, sockets, unknown names, non-empty private directories, or any binding/reservation mismatch. Do not expose paths or file contents.

- [ ] **Step 4: Replace existence-as-activation with validated retry state**

In the fresh target branch, load the durable reservation first and require exact operation/Profile/Runtime Profile/current-owner equality. Then:

```ts
const destination = this.profileBindings.inspectFreshProfileDestination(
  profilePath,
  this.owner,
);
const needsStagedActivation =
  destination.status === "missing" ||
  destination.status === "safe_interrupted_scaffold";
```

Add `resetInterruptedFreshProfile?: (profileId: string) => Promise<void>` to `AgentInstallationProfileAdapter`. Its production implementation in `profiles.ts` canonicalizes the requested named Profile under `PROFILES_DIR`, repeats the safe-scaffold classification immediately before removal, and removes only that one validated destination. For a safe interrupted scaffold, call this adapter and then execute the existing `prepareProfile -> candidate.materialize -> candidate.activate` path. For an already-owned destination, require current Owner plus the reservation Runtime Profile ID before coordinator-backed model repair. Every other state fails closed without delete, binding, or model write.

- [ ] **Step 5: Run installation, binding, and model-projection regressions**

Run:

```bash
npx vitest run \
  src/main/agentera-agent-control/installation-manager.test.ts \
  tests/agentera-profile-binding.test.ts \
  src/main/agentera-agent-control/owner-model-route-catalog.test.ts
```

Expected: all pass; retry activates the same reserved IDs and no negative test changes filesystem bytes.

- [ ] **Step 6: Document and commit Desktop recovery**

Update the Installation reconciliation section with the safe-scaffold allowlist, exact reservation/Owner matching, and fail-closed behavior. Add one `@lat:` reference per new contract test.

```bash
git add src/main/agentera-profile-binding.ts \
  src/main/agentera-agent-control/installation-manager.ts \
  src/main/profiles.ts \
  src/main/agentera-agent-control/installation-manager.test.ts \
  tests/agentera-profile-binding.test.ts \
  lat.md/agentera-agent-control-plane.md
git commit -m "fix(agents): recover interrupted fresh profiles safely"
```

### Task 3: Derive card-local Agent readiness and one primary action

**Files:**
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`
- Modify: `src/renderer/src/assets/main.css:19670-19835`
- Modify: `src/shared/i18n/locales/en/agents.ts`
- Modify: `src/shared/i18n/locales/zh-CN/agents.ts`

- [ ] **Step 1: Write failing card-local status tests**

Add renderer cases for three cards at once: one ready, one pending retry, and one missing a model. Assert each card has exactly one visible primary action (`开始对话`, `重试`, or `配置模型`), only the failing card renders its local message, and no page-level alert contains that failure.

```ts
const cards = within(screen.getByTestId("personal-agent-grid")).getAllByTestId(
  "agent-capability-card",
);
expect(within(cards[0]).getAllByRole("button")).toHaveLength(1);
expect(within(cards[1]).getByRole("button", { name: "agents.control.retryAgent" })).toBeTruthy();
expect(within(cards[2]).getByRole("button", { name: "agents.hub.configureModel" })).toBeTruthy();
expect(screen.queryByRole("alert")).toBeNull();
```

- [ ] **Step 2: Run the renderer test and verify it fails on the current card shape**

Run: `npx vitest run src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`

Expected: cards are whole-card detail buttons and do not expose isolated primary actions/status.

- [ ] **Step 3: Add a pure readiness/action projection**

Define a local `AgentCardPresentation` derived only from public installation/Profile/model state:

```ts
interface AgentCardPresentation {
  tone: "ready" | "pending" | "attention";
  statusKey: string;
  detailKey: string | null;
  primary: "chat" | "retry" | "configure_model" | "details";
}
```

Do not render Profile IDs, Runtime Profile IDs, owner IDs, staging paths, or credentials. Keep the existing detail dialog as the secondary card-body action and stop storing operation failures in a global sticky banner when the failure can be associated with an installation key.

- [ ] **Step 4: Render capability-first cards and matching styles**

Use a neutral card container, capability description, concise status pill, optional startup-model label, and one footer button. Add `.agent-hub-card-status`, `.agent-hub-card-local-error`, and `.agent-hub-card-primary`; preserve keyboard focus and responsive columns.

- [ ] **Step 5: Run renderer, accessibility, and type tests**

Run:

```bash
npx vitest run \
  src/renderer/src/screens/Agents/AgentControlPanel.test.tsx
npm run typecheck:web
```

Expected: all pass; no test finds a technical identifier in normal card copy.

- [ ] **Step 6: Commit the Agent Center UX change**

```bash
git add src/renderer/src/screens/Agents/AgentControlPanel.tsx \
  src/renderer/src/screens/Agents/AgentControlPanel.test.tsx \
  src/renderer/src/assets/main.css \
  src/shared/i18n/locales/en/agents.ts \
  src/shared/i18n/locales/zh-CN/agents.ts
git commit -m "feat(agents): make capability cards action first"
```

### Task 4: Make conversation model switching explicit without changing its contract

**Files:**
- Modify: `src/renderer/src/screens/Chat/ModelPicker.tsx`
- Modify: `src/renderer/src/screens/Chat/ModelPicker.test.tsx`
- Modify: `src/renderer/src/screens/Chat/Chat.global-profile-transport.test.tsx`
- Modify: `src/shared/i18n/locales/en/chat.ts`
- Modify: `src/shared/i18n/locales/zh-CN/chat.ts`
- Modify: `lat.md/model-selection.md`

- [ ] **Step 1: Add failing copy and failure-retention tests**

Assert that an installed-Agent picker says the selected model applies from the next message, `preparing` is visible, and `failed` leaves the old display model/active segment unchanged with an in-conversation retry hint:

```ts
const pending = renderPicker({
  agentConversation: agentContext,
  agentSwitchState: "preparing",
});
expect(pending.container.textContent).toContain("chat.modelSwitch.preparing");

const failed = renderPicker({
  agentConversation: agentContext,
  displayModel: "GPT-5.6",
  agentSwitchState: "failed",
});
expect(failed.container.textContent).toContain(
  "chat.modelSwitch.failedKeepsCurrent",
);
expect(failed.container.querySelector(".chat-model-name")?.textContent).toBe(
  "GPT-5.6",
);
```

- [ ] **Step 2: Run the two focused Chat tests and confirm only presentation assertions fail**

Run:

```bash
npx vitest run \
  src/renderer/src/screens/Chat/ModelPicker.test.tsx \
  src/renderer/src/screens/Chat/Chat.global-profile-transport.test.tsx
```

Expected: existing opaque selection/segment lifecycle remains green; new status copy assertions fail.

- [ ] **Step 3: Render switch-state guidance from existing state**

Add no new route state and no new IPC. Render `chat.modelSwitch.nextMessage`, `chat.modelSwitch.preparing`, and `chat.modelSwitch.failedKeepsCurrent` from `agentSwitchState`; close the dropdown after staging a valid opaque selection but change the trigger label only after the existing active-segment event updates `agentConversation.activeRoute`.

- [ ] **Step 4: Run Chat and Main segment lifecycle regressions**

Run:

```bash
npx vitest run \
  src/renderer/src/screens/Chat/ModelPicker.test.tsx \
  src/renderer/src/screens/Chat/Chat.global-profile-transport.test.tsx \
  src/main/ipc/register.agent-model-switch.test.ts \
  src/main/agentera-agent-control/conversation-thread-store.test.ts
```

Expected: switch affects the next send only; failed candidate keeps the active segment and global Settings remain untouched.

- [ ] **Step 5: Document and commit model-switch UX**

```bash
git add src/renderer/src/screens/Chat/ModelPicker.tsx \
  src/renderer/src/screens/Chat/ModelPicker.test.tsx \
  src/renderer/src/screens/Chat/Chat.global-profile-transport.test.tsx \
  src/shared/i18n/locales/en/chat.ts \
  src/shared/i18n/locales/zh-CN/chat.ts \
  lat.md/model-selection.md
git commit -m "feat(chat): clarify per-conversation model switching"
```

### Task 5: Add an honest multi-Agent team entry point over existing Kanban

**Files:**
- Modify: `src/renderer/src/screens/Agents/Agents.tsx`
- Modify: `src/renderer/src/screens/Agents/Agents.test.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`
- Modify: `src/renderer/src/screens/Layout/Layout.tsx`
- Modify: `src/renderer/src/assets/main.css`
- Modify: `src/shared/i18n/locales/en/agents.ts`
- Modify: `src/shared/i18n/locales/zh-CN/agents.ts`
- Modify: `lat.md/kanban.md`

- [ ] **Step 1: Write failing team-entry tests**

Assert the Agent Center shows a team section whose copy promises only capabilities the current Hermes Kanban already exposes (goal, decomposition, assignment, progress, summary), and that `发起团队任务` invokes only the navigation callback:

```ts
const onOpenTeams = vi.fn();
render(<AgentControlPanel profiles={[]} onOpenTeams={onOpenTeams} />);
fireEvent.click(
  screen.getByRole("button", { name: "agents.teams.startTask" }),
);
expect(onOpenTeams).toHaveBeenCalledOnce();
expect(screen.queryByText("agents.teams.fakeProgress")).toBeNull();
```

- [ ] **Step 2: Run the focused Agents/Layout tests and verify failure**

Run:

```bash
npx vitest run \
  src/renderer/src/screens/Agents/Agents.test.tsx \
  src/renderer/src/screens/Agents/AgentControlPanel.test.tsx \
  src/renderer/src/screens/Layout/Layout.navigation.test.ts
```

Expected: no team entry callback/section exists.

- [ ] **Step 3: Route the CTA to the existing board**

Add `onOpenTeams?: () => void` through `Agents` and `AgentControlPanel`. In `Layout`, pass `onOpenTeams={() => goTo("kanban")}`. Render a compact team card with an explicit “由 Hermes 任务看板执行” status; do not add a new bridge, database, dispatcher, credential store, or fake member state.

- [ ] **Step 4: Run UI and Kanban boundary regressions**

Run:

```bash
npx vitest run \
  src/renderer/src/screens/Agents/Agents.test.tsx \
  src/renderer/src/screens/Agents/AgentControlPanel.test.tsx \
  src/renderer/src/screens/Layout/Layout.navigation.test.ts \
  tests/kanban-runtime-invocation.test.ts \
  tests/kanban-unsupported.test.ts
```

Expected: CTA enters the real board; remote unsupported behavior and existing task mutations are unchanged.

- [ ] **Step 5: Document and commit the team entry point**

```bash
git add src/renderer/src/screens/Agents/Agents.tsx \
  src/renderer/src/screens/Agents/Agents.test.tsx \
  src/renderer/src/screens/Agents/AgentControlPanel.tsx \
  src/renderer/src/screens/Agents/AgentControlPanel.test.tsx \
  src/renderer/src/screens/Layout/Layout.tsx \
  src/renderer/src/assets/main.css \
  src/shared/i18n/locales/en/agents.ts \
  src/shared/i18n/locales/zh-CN/agents.ts \
  lat.md/kanban.md
git commit -m "feat(agents): expose existing team task workflow"
```

### Task 6: Prove first-failure retry, isolation, and real Electron behavior

**Files:**
- Modify: `tests/e2e/agentera-agent-control.e2e.ts`
- Modify: `lat.md/agentera-agent-control-plane.md`

- [ ] **Step 1: Add an Electron regression scenario for the original failure**

Use only test-owned temporary `userData` and `HERMES_HOME`. Inject one first-attempt interruption after Runtime materializes the known safe scaffold, restart the app, retry the same installation, and assert the same reserved Profile and Runtime Profile IDs become active. Assert the durable default root never receives the staged model/config bytes.

- [ ] **Step 2: Add model-switch and foreign-Profile assertions to the same isolated journey**

After activation, send once, switch to a second owner-catalog route, send again, and assert one new immutable segment. Create a foreign/meaningful Profile fixture and assert retry neither deletes nor binds it.

- [ ] **Step 3: Run the exact Electron test**

Run: `npm run build && npx playwright test tests/e2e/agentera-agent-control.e2e.ts`

Expected: Electron starts, the first attempt is visibly retryable, restart/retry succeeds, model switch takes effect on the next send, and all isolation assertions pass.

- [ ] **Step 4: Run Desktop and Runtime complete local gates**

Desktop:

```bash
npm run typecheck
npm run lint
npm test
git diff --check
lat check
```

Runtime:

```bash
scripts/run_tests.sh
git diff --check
```

Expected: every command exits 0, with no unexplained flaky retry and no access to the user's real Profile/database/credentials.

- [ ] **Step 5: Commit Electron evidence and final documentation**

```bash
git add tests/e2e/agentera-agent-control.e2e.ts lat.md/agentera-agent-control-plane.md
git commit -m "test(agents): verify interrupted install recovery in Electron"
```

### Task 7: Final scope and privacy audit

**Files:**
- Inspect: all changes since Desktop `bb3ea33af57d7a13f4b08c73f35471944bdd0f5b`
- Inspect: all changes since Runtime `fb42016967ad934c55e9da5af1896d5c7206b445`

- [ ] **Step 1: Verify scope boundaries**

Run `git diff --stat <baseline>..HEAD` and `git diff <baseline>..HEAD` in both worktrees. Confirm no version, updater, release metadata, Cloud/Admin/API, user database, installed app, credential, Memory, or session file changed.

- [ ] **Step 2: Scan renderer and logs for forbidden data**

Run:

```bash
rg -n "profilePath|runtimeProfileId|ownerId|Authorization|apiKey|HERMES_HOME" \
  src/renderer/src/screens/Agents src/renderer/src/screens/Chat
```

Expected: only internal type/test fixtures appear; no new UI copy or IPC payload exposes these values.

- [ ] **Step 3: Record exact verification evidence**

Record Desktop/Runtime HEADs, commands, pass counts, Electron test result, and explicit release evidence for Beta.36; do not claim promotion until the immutable candidate is separately verified and explicitly approved.
