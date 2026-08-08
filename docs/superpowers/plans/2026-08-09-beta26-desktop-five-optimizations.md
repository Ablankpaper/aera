# Beta.26 Desktop Five Optimizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the intermittent doubled assistant bubble and deliver the four approved UI/account/navigation improvements on the Beta.26 Desktop branch.

**Architecture:** Keep the existing sequenced Chat Stream Integrity protocol. Add a turn-scoped lifecycle in the Dashboard renderer so a legacy no-tool completion is authoritative and a replayed completion is ignored, while tool-bearing turns retain the existing pre-tool merge. Thread the existing Profile display name through Layout → Chat → ConversationBoundaryIndicator, change only Chinese labels, make the main-process recharge resolver default to Petoi, and remove only the obsolete Providers Hermes One account surface.

**Tech Stack:** Electron/Vite, React 19, TypeScript, Vitest, Testing Library, i18next locale objects, `lat.md` documentation, npm.

---

## File Map

### Chat stream boundary

- Modify: `src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts` — own one turn lifecycle ref, mark tool activity, select authoritative legacy completion text, and ignore same-turn completion replay.
- Modify: `src/renderer/src/screens/Chat/dashboardEventAdapter.ts` — preserve the existing authoritative-completion option and ensure tests cover the no-tool replacement without changing fuzzy text rules.
- Test: `src/renderer/src/screens/Chat/dashboardEventAdapter.test.ts` — reducer-level no-tool replacement and reasoning isolation.
- Test: `src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.test.tsx` — event lifecycle, duplicate completion, later-turn reset, and tool-bearing merge.

### Conversation Agent identity

- Modify: `src/renderer/src/screens/Layout/ActiveSessionsBar.tsx` — extend `ProfileAppearance` with the optional display name shared by Layout and Chat.
- Modify: `src/renderer/src/screens/Layout/Layout.tsx` — store `ProfileInfo.name` with color/avatar and pass it to each mounted Chat run.
- Modify: `src/renderer/src/screens/Chat/Chat.tsx` — accept the display name and pass a trimmed fallback name to the boundary indicator.
- Modify: `src/renderer/src/screens/Chat/ConversationBoundaryIndicator.tsx` — render the Agent label in the approved same-row order.
- Modify: `src/shared/i18n/locales/en/chat.ts` and `src/shared/i18n/locales/zh-CN/chat.ts` — add the `boundary.agent` label.
- Test: `src/renderer/src/screens/Chat/ConversationBoundaryIndicator.test.tsx` — normal name and fallback behavior.

### Navigation, recharge, and Providers

- Modify: `src/shared/i18n/locales/zh-CN/navigation.ts` — change only the two requested user-visible labels.
- Test: `src/renderer/src/screens/Layout/Layout.navigation.test.ts` — assert the Chinese strings while retaining the existing internal view order assertions.
- Modify: `src/main/agentera-auth/config.ts` — use Petoi as the default only after explicit env/build overrides have been checked; keep the existing URL parser.
- Create: `src/main/agentera-auth/config.test.ts` — test override precedence, Petoi fallback, canonical HTTPS output, and unsafe URL rejection.
- Modify: `src/renderer/src/screens/Providers/Providers.tsx` — remove Hermes account state/effect/UI/modal and retain model, OAuth, credential-pool, and registry controls.
- Create: `src/renderer/src/screens/Providers/Providers.test.tsx` — mock the provider subcomponents and IPC surface, open Advanced, and assert no legacy account lookup or UI.

### Documentation and verification

- Modify: `lat.md/chat-commands.md` — document authoritative no-tool completion and same-turn completion replay suppression.
- Modify: `lat.md/hermes-account-login.md` — describe the retained IPC/client contract without claiming a Providers-screen login entry.
- Run: focused tests, type checks, build, affected lint/format checks, `lat check`, and an isolated Electron smoke.

---

## Task 1: Lock the doubled-reply regression with failing tests

**Files:**

- Modify: `src/renderer/src/screens/Chat/dashboardEventAdapter.test.ts`
- Modify: `src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.test.tsx`

- [ ] **Step 1: Add the reducer regression for two complete no-tool answers.**

Append a test to the existing `applyDashboardStreamEvent — message.complete text reconciliation` suite. Feed one user row, a complete-looking `message.delta` identity block, then a different complete-looking `message.complete` identity block with `{ authoritativeCompletionText: true }`. Assert there are exactly two rows and the assistant content equals only the completion block.

```ts
it("uses the authoritative no-tool completion instead of stacking a second full answer", () => {
  let state: DashboardEventState = {
    messages: [{ id: "u-identity", role: "user", content: "你是谁？" }],
    reasoningSegmentClosed: false,
  };
  state = applyDashboardStreamEvent(state, {
    type: "message.delta",
    payload: { text: "我是 Nous Research 助手。\n\n我可以回答问题。" },
  });
  state = applyDashboardStreamEvent(
    state,
    {
      type: "message.complete",
      payload: { text: "我是 Hermes Agent。\n\n我可以回答问题和执行工具。" },
    },
    { authoritativeCompletionText: true },
  );

  expect(state.messages).toHaveLength(2);
  expect((state.messages[1] as { content: string }).content).toBe(
    "我是 Hermes Agent。\n\n我可以回答问题和执行工具。",
  );
});
```

- [ ] **Step 2: Add the transport event tests before implementation.**

Extend the existing `useDashboardChatTransport stream integrity` harness with three cases:

1. `message.start` without a `stream_id`, a full delta, and a different full completion yields only the completion.
2. A second completion for the same active `turnId` leaves the first completion unchanged.
3. A new `turnId` accepts a later completion whose text is identical to the previous turn.

Use the existing `connect(api)` helper and `dashboardMock.onEvent?.(...)`; do not add live network calls or provider credentials to the test.

- [ ] **Step 3: Add the tool and reasoning guard cases.**

Keep the existing pre-tool merge assertion and add an explicit `tool.start` between the delta and completion so the implementation cannot make every legacy completion authoritative. Retain the existing `thinking.delta`/`reasoning.delta` test and assert the identity text never appears in a `kind: "reasoning"` row.

- [ ] **Step 4: Run the new focused tests and confirm they fail for the intended reason.**

Run:

```bash
npx vitest run src/renderer/src/screens/Chat/dashboardEventAdapter.test.ts src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.test.tsx
```

Expected before implementation: the new no-tool case contains both blocks or the duplicate-completion case applies the second completion; unrelated existing tests remain green.

- [ ] **Step 5: Commit the red tests.**

```bash
git add src/renderer/src/screens/Chat/dashboardEventAdapter.test.ts \
  src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.test.tsx
git commit -m "test(chat): capture legacy doubled-completion regression"
```

## Task 2: Implement turn-scoped Chat completion reconciliation

**Files:**

- Modify: `src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts`
- Modify: `src/renderer/src/screens/Chat/dashboardEventAdapter.ts` only if the focused test exposes an adapter gap

- [ ] **Step 1: Add a private lifecycle ref keyed by `ActiveTurn.turnId`.**

Use a ref with this exact shape near `streamIntegrityRef`:

```ts
const dashboardTurnRef = useRef<{
  turnId: string | null;
  sawToolEvent: boolean;
  completionAccepted: boolean;
}>({ turnId: null, sawToolEvent: false, completionAccepted: false });
```

Add one local reset helper that reads `activeTurnRef.current?.turnId`, sets `sawToolEvent` and `completionAccepted` to `false`, and is called at the beginning of a fresh prompt path and when the connection/session reset effects retire the current turn. A new renderer `turnId`, not identical response text, defines a new turn.

- [ ] **Step 2: Mark tool activity before applying tool rows.**

Inside `handleGatewayEvent`, before `applyDashboardStreamEvent`, mark `sawToolEvent = true` for `tool.start`, `tool.progress`, `tool.generating`, and `tool.complete` when the event belongs to the current lifecycle turn. Do not mark `thinking.delta`, `reasoning.delta`, `reasoning.available`, or `clarify.request` as tool activity.

- [ ] **Step 3: Choose the legacy completion authority and suppress replay.**

In the `message.complete` branch:

1. If `completionAccepted` is already true for the same `turnId`, return without calling `setMessages`, changing loading state, or clearing the current tool progress.
2. Keep the existing `StreamIntegrityTracker.complete()` decision unchanged for sequenced streams.
3. For legacy/unsequenced streams, set `authoritativeCompletionText = !dashboardTurnRef.current.sawToolEvent` when completion text is non-empty.
4. Apply the event once, then set `completionAccepted = true` before the existing cleanup marks `activeTurnRef.current` completed and clears it.
5. Leave the empty-final-text path unchanged so a streamed-only answer still completes without losing its content.

The existing adapter call already treats `authoritativeCompletionText: true` as a replacement; do not add semantic similarity rules or remove the established tool-bearing `mergeStreamedWithFinal` behavior.

- [ ] **Step 4: Reset the lifecycle at the exact new-turn and connection boundaries.**

Reset the lifecycle before a new `prompt.submit`, when the stored/session connection revision changes, when the profile changes, and on unmount. Do not reset it in the middle of a single completion or on an ordinary `message.complete` cleanup, because the replay guard must survive until the next turn.

- [ ] **Step 5: Run the focused tests to green.**

```bash
npx vitest run src/renderer/src/screens/Chat/dashboardEventAdapter.test.ts src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.test.tsx
```

Expected: all existing stream-integrity tests and the new no-tool, replay, tool, and reasoning tests pass.

- [ ] **Step 6: Commit the Chat repair.**

```bash
git add src/renderer/src/screens/Chat/dashboardEventAdapter.ts \
  src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts \
  src/renderer/src/screens/Chat/dashboardEventAdapter.test.ts \
  src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.test.tsx
git commit -m "fix(chat): prevent doubled legacy completion bubbles"
```

## Task 3: Add the Agent name to the conversation boundary

**Files:**

- Modify: `src/renderer/src/screens/Layout/ActiveSessionsBar.tsx`
- Modify: `src/renderer/src/screens/Layout/Layout.tsx`
- Modify: `src/renderer/src/screens/Chat/Chat.tsx`
- Modify: `src/renderer/src/screens/Chat/ConversationBoundaryIndicator.tsx`
- Modify: `src/shared/i18n/locales/en/chat.ts`
- Modify: `src/shared/i18n/locales/zh-CN/chat.ts`
- Modify: `src/renderer/src/screens/Chat/ConversationBoundaryIndicator.test.tsx`

- [ ] **Step 1: Add a failing indicator test for the approved row.**

Extend the mocked translator to return readable strings for `chat.boundary.agent`, render `agentName="水鱼"`, and assert the DOM contains `智能体：` and `水鱼` between the scope and visibility fields. Add a second test with `agentName=""` and assert the fallback string is rendered.

- [ ] **Step 2: Extend the shared appearance shape and Layout map.**

Add `name?: string | null` to `ProfileAppearance`. Change the Layout state map to `Record<string, ProfileAppearance>`, and build each entry as `{ name: p.name, color: p.color, avatar: p.avatar }`. Keep the lookup keyed by `p.id`; never key it by editable display name.

- [ ] **Step 3: Thread and render the display name.**

Add `name?: string | null` to `ChatProps`'s `agentAppearance` shape. Derive `agentName = agentAppearance?.name?.trim() || profile?.trim() || "default"` and pass it to `ConversationBoundaryIndicator`. Add `boundary.agent` to English (`Agent:`) and Simplified Chinese (`智能体：`) locale objects. Render the new span in the order running-in, Agent, visibility, reusing the existing divider class.

- [ ] **Step 4: Run the focused header tests.**

```bash
npx vitest run src/renderer/src/screens/Chat/ConversationBoundaryIndicator.test.tsx src/renderer/src/screens/Layout/Layout.navigation.test.ts
```

Expected: the new indicator tests and existing layout navigation tests pass.

- [ ] **Step 5: Commit the header change.**

```bash
git add src/renderer/src/screens/Layout/ActiveSessionsBar.tsx \
  src/renderer/src/screens/Layout/Layout.tsx \
  src/renderer/src/screens/Chat/Chat.tsx \
  src/renderer/src/screens/Chat/ConversationBoundaryIndicator.tsx \
  src/shared/i18n/locales/en/chat.ts src/shared/i18n/locales/zh-CN/chat.ts \
  src/renderer/src/screens/Chat/ConversationBoundaryIndicator.test.tsx
git commit -m "feat(chat): show active Agent name in boundary"
```

## Task 4: Rename Chinese navigation labels

**Files:**

- Modify: `src/shared/i18n/locales/zh-CN/navigation.ts`
- Modify: `src/renderer/src/screens/Layout/Layout.navigation.test.ts`

- [ ] **Step 1: Add label assertions before changing the locale.**

Import the Simplified Chinese navigation object in the existing navigation test and assert:

```ts
expect(zhCNNavigation.discover).toBe("工具社区");
expect(zhCNNavigation.kanban).toBe("任务看板");
```

- [ ] **Step 2: Run the test and observe the expected failure.**

```bash
npx vitest run src/renderer/src/screens/Layout/Layout.navigation.test.ts
```

Expected: the two new string assertions fail while the internal view order assertions pass.

- [ ] **Step 3: Change only the two Simplified Chinese values.**

Set `discover: "工具社区"` and `kanban: "任务看板"`; leave `View`, `PINNED_NAV_ITEMS`, routes, icons, and all other locales unchanged.

- [ ] **Step 4: Run and commit.**

```bash
npx vitest run src/renderer/src/screens/Layout/Layout.navigation.test.ts
git add src/shared/i18n/locales/zh-CN/navigation.ts src/renderer/src/screens/Layout/Layout.navigation.test.ts
git commit -m "fix(i18n): clarify Chinese desktop navigation labels"
```

Expected: all navigation tests pass.

## Task 5: Default recharge to Petoi

**Files:**

- Modify: `src/main/agentera-auth/config.ts`
- Create: `src/main/agentera-auth/config.test.ts`

- [ ] **Step 1: Add configuration tests.**

Use the existing `vi.stubEnv`/process-env conventions. Save and restore `AGENTERA_RECHARGE_PUBLIC_URL`, `MAIN_VITE_AGENTERA_RECHARGE_PUBLIC_URL`, and import-meta env stubs in `afterEach`. Cover:

```ts
expect(getAgenteraRechargePublicUrl()).toBe("https://petoi.cn/");
process.env.AGENTERA_RECHARGE_PUBLIC_URL = "https://override.example/recharge";
expect(getAgenteraRechargePublicUrl()).toBe(
  "https://override.example/recharge",
);
expect(() => parseAgenteraRechargePublicUrl("http://example.com")).toThrow();
```

Also assert a loopback HTTP URL remains accepted and a URL containing credentials or a fragment remains rejected.

- [ ] **Step 2: Run the new config tests before implementation.**

```bash
npx vitest run src/main/agentera-auth/config.test.ts
```

Expected: the fallback assertion fails because the resolver currently returns `null`; override and parser tests establish the existing behavior.

- [ ] **Step 3: Add the reviewed default after overrides.**

Keep the current precedence:

```ts
const configured =
  process.env.AGENTERA_RECHARGE_PUBLIC_URL?.trim() ||
  process.env.MAIN_VITE_AGENTERA_RECHARGE_PUBLIC_URL?.trim() ||
  import.meta.env.MAIN_VITE_AGENTERA_RECHARGE_PUBLIC_URL?.trim();
return parseAgenteraRechargePublicUrl(configured || "https://petoi.cn");
```

Do not bypass `parseAgenteraRechargePublicUrl` or move URL construction into the renderer.

- [ ] **Step 4: Run and commit.**

```bash
npx vitest run src/main/agentera-auth/config.test.ts src/renderer/src/components/AgenteraAccountMenu.test.tsx
git add src/main/agentera-auth/config.ts src/main/agentera-auth/config.test.ts
git commit -m "fix(auth): default recharge portal to Petoi"
```

Expected: configuration and account-menu tests pass, including the existing portal target behavior.

## Task 6: Remove the Providers Hermes One login UI

**Files:**

- Modify: `src/renderer/src/screens/Providers/Providers.tsx`
- Create: `src/renderer/src/screens/Providers/Providers.test.tsx`

- [ ] **Step 1: Create a focused renderer test harness.**

Mock `ModelCenter`, `ProviderKeysSection`, `RegistryBrowserModal`, `AuxiliaryTasksSection`, `OAuthLoginModal`, and `useI18n` so the test exercises only Providers tab composition. Provide `window.hermesAPI` methods used by initial loading (`getEnv`, `getModelConfig`, `getCredentialPool`, `listCustomProviders`, and `getAccount`) as resolved Vitest mocks. Render `<Providers profile="default" visible />`, click the button whose translated label is `providers.center.advancedTab`, and assert:

```ts
expect(
  screen.queryByText("providers.hermesAccount.sectionTitle"),
).not.toBeInTheDocument();
expect(window.hermesAPI.getAccount).not.toHaveBeenCalled();
expect(screen.getByText("common.model")).toBeInTheDocument();
```

Add an assertion that the remaining advanced model controls can open the model picker, proving this is not a blanket Advanced-tab removal.

- [ ] **Step 2: Run the test before removing the UI.**

```bash
npx vitest run src/renderer/src/screens/Providers/Providers.test.tsx
```

Expected: the legacy section is found and `getAccount` has been called, so the new test fails.

- [ ] **Step 3: Remove only the legacy account surface.**

In `Providers.tsx`, delete the `HermesAccountModal` import, `HermesAccount` type import, `User` icon import, `account` and `showAccountModal` state, the `getAccount` effect, the first Hermes account settings section, and the bottom `HermesAccountModal` branch. Keep `OAuthLoginModal`, all provider key/model state, the advanced model picker, credential pool, and registry actions unchanged.

- [ ] **Step 4: Run the Providers and adjacent account tests.**

```bash
npx vitest run src/renderer/src/screens/Providers/Providers.test.tsx src/renderer/src/components/AgenteraAccountMenu.test.tsx src/renderer/src/components/settings/AgenteraAccountPane.test.tsx
```

Expected: the Providers test proves the legacy card is gone, while Aera account menu/pane tests remain green.

- [ ] **Step 5: Commit the Providers change.**

```bash
git add src/renderer/src/screens/Providers/Providers.tsx src/renderer/src/screens/Providers/Providers.test.tsx
git commit -m "fix(providers): remove legacy Hermes One login surface"
```

## Task 7: Update `lat.md` for the changed behavior

**Files:**

- Modify: `lat.md/chat-commands.md`
- Modify: `lat.md/hermes-account-login.md`

- [ ] **Step 1: Update the Chat completion section.**

Keep the existing explanation of pre-tool text, and add that no-tool legacy turns treat non-empty `message.complete` text as authoritative and that a second completion for the same renderer `turnId` is ignored. Explicitly retain the separate reasoning row behavior.

- [ ] **Step 2: Update the Hermes account UI paragraph.**

Replace the claim that `Providers.tsx` hosts the Hermes One account card with the retained boundary: the device-login IPC/client and `HermesAccountModal` compatibility code remain available to existing consumers, but Model > Advanced no longer exposes that legacy entry point. Keep the account store and Agent Sync links intact.

- [ ] **Step 3: Validate docs and commit.**

```bash
lat check
git diff --check
git add lat.md/chat-commands.md lat.md/hermes-account-login.md
git commit -m "docs(lat): record Beta26 chat and account UI boundaries"
```

Expected: `lat check` reports all links and code references valid.

## Task 8: Full local verification and isolated Electron smoke

**Files:**

- No additional product files; use the already changed files and temporary test roots only.

- [ ] **Step 1: Run the focused regression battery.**

```bash
npx vitest run \
  src/renderer/src/screens/Chat/dashboardEventAdapter.test.ts \
  src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.test.tsx \
  src/renderer/src/screens/Chat/ConversationBoundaryIndicator.test.tsx \
  src/renderer/src/screens/Layout/Layout.navigation.test.ts \
  src/main/agentera-auth/config.test.ts \
  src/renderer/src/screens/Providers/Providers.test.tsx \
  src/renderer/src/components/AgenteraAccountMenu.test.tsx \
  src/renderer/src/components/settings/AgenteraAccountPane.test.tsx
```

Expected: every listed file passes with no skipped new tests.

- [ ] **Step 2: Run the full static gates.**

```bash
npm run typecheck
npm run build
npx prettier --check src/main/agentera-auth/config.ts src/main/agentera-auth/config.test.ts \
  src/renderer/src/screens/Chat/dashboardEventAdapter.ts \
  src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts \
  src/renderer/src/screens/Chat/ConversationBoundaryIndicator.tsx \
  src/renderer/src/screens/Layout/Layout.tsx \
  src/renderer/src/screens/Layout/ActiveSessionsBar.tsx \
  src/renderer/src/screens/Providers/Providers.tsx \
  src/renderer/src/screens/Providers/Providers.test.tsx
npx eslint src/main/agentera-auth/config.ts src/main/agentera-auth/config.test.ts \
  src/renderer/src/screens/Chat/dashboardEventAdapter.ts \
  src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts \
  src/renderer/src/screens/Chat/ConversationBoundaryIndicator.tsx \
  src/renderer/src/screens/Layout/Layout.tsx \
  src/renderer/src/screens/Layout/ActiveSessionsBar.tsx \
  src/renderer/src/screens/Providers/Providers.tsx
lat check
git diff --check
```

Expected: typecheck, build, formatting, lint, and `lat check` all pass. Any pre-existing warning must be recorded with the exact command output and not fixed by widening this scope.

- [ ] **Step 3: Run the full Vitest baseline after changes.**

```bash
npm test
```

Expected: the same 359 test files remain green, plus the new focused files; no test may rely on the daily Profile or a live provider.

- [ ] **Step 4: Build the isolated Electron candidate.**

```bash
HERMES_DESKTOP_USER_DATA_DIR="$(mktemp -d -t aera-beta26-userdata)" \
HERMES_HOME="$(mktemp -d -t aera-beta26-hermes)" \
npm run build:unpack
```

Record only the temporary root paths, build exit status, exact branch/HEAD, and artifact hash. Do not use `/Applications/Aera.app`, the normal `HERMES_HOME`, or existing account credentials.

- [ ] **Step 5: Verify the five visible outcomes in one isolated Electron run.**

With the unpacked app and the same temporary `userData`/`HERMES_HOME`, verify:

1. a fixture sequence with two complete no-tool identity blocks displays only the authoritative final block;
2. the chat boundary row shows `智能体：<Profile name>`;
3. Chinese navigation shows `任务看板` and `工具社区` and routes still open the existing views;
4. the signed-in account menu’s recharge action resolves to `https://petoi.cn/` through main-process portal handling;
5. Model > Advanced has no Hermes One account card or sign-in button and still exposes model controls.

Capture screenshots or sanitized DOM/event evidence only. Do not retain prompts, responses, cookies, tokens, credentials, private Profile files, or account identifiers.

- [ ] **Step 6: Review the final diff and stop at the release boundary.**

```bash
git status --short --branch
git diff origin/main...HEAD --stat
git log --oneline --decorate -12
```

Expected: only the approved source, test, locale, and `lat.md` files are changed; no build output, temporary roots, credentials, or `.superpowers` files are tracked. Stop for separate PR/merge/release authorization.
