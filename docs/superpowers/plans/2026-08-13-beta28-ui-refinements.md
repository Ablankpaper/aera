# Beta.28 UI Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved collapsible image-generation configuration, readable conversation Agent names, and presentation-only Workspace menu hiding without packaging or releasing Beta.28.

**Architecture:** Preserve stable Profile IDs for every routing and persistence boundary while adding a nullable metadata-only `displayName` for conversation presentation. Keep image disclosure as renderer-local state around the existing form, and retain an explicit navigation catalog whose `office` descriptor is hidden from the visible list rather than deleted.

**Tech Stack:** Electron 39, React 19, TypeScript 5.9, Vitest and Testing Library, Playwright Electron, `lat.md`.

---

### Task 1: Preserve nullable Agent display metadata

**Files:**
- Modify: `src/main/profiles.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Test: `tests/profiles.test.ts`

- [ ] **Step 1: Write failing Profile metadata tests**

Add assertions that a saved metadata name is returned through `displayName`, while an unnamed non-default Profile keeps compatibility `name = id` but returns `displayName = null`. Also assert that default metadata may still be exposed without changing its stable ID.

```ts
expect(work).toMatchObject({
  id: "work",
  name: "Work Agent",
  displayName: "Work Agent",
});
expect(unnamed).toMatchObject({
  id: "fresh",
  name: "fresh",
  displayName: null,
});
```

- [ ] **Step 2: Run the Profile tests and verify RED**

Run: `npx vitest run tests/profiles.test.ts`

Expected: FAIL because `ProfileInfo` results do not yet contain `displayName`.

- [ ] **Step 3: Add the minimal nullable display-name contract**

Add `displayName: string | null` to `ProfileInfo`; populate it from trimmed `profile-meta.json` name for local Profiles and `null` when absent. Keep the existing `name` fallback for compatibility. Map SSH results to `displayName: null`, and expose the field through both preload declarations.

```ts
export interface ProfileInfo {
  id: string;
  name: string;
  displayName: string | null;
  // existing fields stay unchanged
}
```

- [ ] **Step 4: Run the Profile and preload boundary tests and verify GREEN**

Run: `npx vitest run tests/profiles.test.ts tests/preload-api-surface.test.ts`

Expected: PASS with no secret or internal-routing contract changes.

- [ ] **Step 5: Commit the metadata boundary**

```bash
git add src/main/profiles.ts src/main/ipc/register.ts src/preload/index.ts src/preload/index.d.ts tests/profiles.test.ts
git commit -m "feat(chat): expose optional agent display names"
```

### Task 2: Render safe conversation names and refresh renames

**Files:**
- Modify: `src/renderer/src/screens/Layout/ActiveSessionsBar.tsx`
- Modify: `src/renderer/src/screens/Layout/Layout.tsx`
- Modify: `src/renderer/src/screens/Layout/Layout.model-setup-prompt.test.tsx`
- Modify: `src/renderer/src/screens/Chat/Chat.tsx`
- Modify: `src/renderer/src/screens/Chat/ConversationBoundaryIndicator.tsx`
- Modify: `src/renderer/src/screens/Chat/ConversationBoundaryIndicator.test.tsx`
- Modify: `src/shared/i18n/locales/ar/chat.ts`
- Modify: `src/shared/i18n/locales/en/chat.ts`
- Modify: `src/shared/i18n/locales/es/chat.ts`
- Modify: `src/shared/i18n/locales/he/chat.ts`
- Modify: `src/shared/i18n/locales/id/chat.ts`
- Modify: `src/shared/i18n/locales/ja/chat.ts`
- Modify: `src/shared/i18n/locales/pl/chat.ts`
- Modify: `src/shared/i18n/locales/pt-BR/chat.ts`
- Modify: `src/shared/i18n/locales/pt-PT/chat.ts`
- Modify: `src/shared/i18n/locales/tr/chat.ts`
- Modify: `src/shared/i18n/locales/zh-CN/chat.ts`
- Modify: `src/shared/i18n/locales/zh-TW/chat.ts`
- Test: `src/shared/i18n/index.test.ts`

- [ ] **Step 1: Write failing conversation-name tests**

Cover the exact presentation matrix and the live identity event:

```ts
expect(resolveConversationAgentName("default", "Renamed", t)).toBe("default");
expect(resolveConversationAgentName("video-agent", " 智能短视频分析 ", t)).toBe("智能短视频分析");
expect(resolveConversationAgentName("019f...", null, t)).toBe("未命名智能体");
```

In the Layout renderer test, capture the `onAgentIdentityChanged` listener, emit a rename for the active Profile, and assert the mocked Chat receives the new display name without changing its `profile` prop.

- [ ] **Step 2: Run focused renderer tests and verify RED**

Run: `npx vitest run src/renderer/src/screens/Chat/ConversationBoundaryIndicator.test.tsx src/renderer/src/screens/Layout/Layout.model-setup-prompt.test.tsx src/shared/i18n/index.test.ts`

Expected: FAIL because default/non-default resolution, nullable display metadata, rename refresh, and locale copy are not implemented.

- [ ] **Step 3: Implement the minimal presentation resolver and refresh listener**

Give `ProfileAppearance` a nullable `displayName`, build it from `listProfiles()`, and subscribe in Layout to the existing identity event. Update only the matching appearance record.

```ts
setProfileAppearance((current) => ({
  ...current,
  [identity.profileId]: {
    ...current[identity.profileId],
    displayName: identity.displayName.trim() || null,
  },
}));
```

Pass stable `profileId` and nullable `agentDisplayName` into `ConversationBoundaryIndicator`. Resolve `default` literally; otherwise render the trimmed display name or `t("chat.boundary.unnamedAgent")`. Add the explicit locale value to every supported chat locale, including Simplified Chinese `未命名智能体`.

- [ ] **Step 4: Run the focused renderer tests and verify GREEN**

Run: `npx vitest run src/renderer/src/screens/Chat/ConversationBoundaryIndicator.test.tsx src/renderer/src/screens/Layout/Layout.model-setup-prompt.test.tsx src/shared/i18n/index.test.ts`

Expected: PASS; the non-default test also proves no UUID/Profile-ID fallback is rendered.

- [ ] **Step 5: Commit the conversation presentation change**

```bash
git add src/renderer/src/screens/Layout/ActiveSessionsBar.tsx src/renderer/src/screens/Layout/Layout.tsx src/renderer/src/screens/Layout/Layout.model-setup-prompt.test.tsx src/renderer/src/screens/Chat/Chat.tsx src/renderer/src/screens/Chat/ConversationBoundaryIndicator.tsx src/renderer/src/screens/Chat/ConversationBoundaryIndicator.test.tsx src/shared/i18n/locales/*/chat.ts src/shared/i18n/index.test.ts
git commit -m "fix(chat): show readable agent names"
```

### Task 3: Add independent image-configuration disclosure

**Files:**
- Modify: `src/renderer/src/screens/Tools/ImageGenerationConfig.tsx`
- Modify: `src/renderer/src/screens/Tools/ImageGenerationConfig.test.tsx`
- Modify: `src/renderer/src/assets/main.css`
- Modify: `tests/e2e/image-generation-config.e2e.ts`

- [ ] **Step 1: Write failing disclosure tests**

Assert that the title button starts expanded, collapses the form without changing the independent enabled switch, and preserves an unsaved model value across collapse and re-expansion.

```ts
const disclosure = screen.getByRole("button", {
  name: "tools.imageGeneration.title",
});
expect(disclosure).toHaveAttribute("aria-expanded", "true");
fireEvent.change(screen.getByLabelText("tools.imageGeneration.model"), {
  target: { value: "unsaved-image-model" },
});
fireEvent.click(disclosure);
expect(disclosure).toHaveAttribute("aria-expanded", "false");
expect(screen.getByLabelText("tools.imageGeneration.enabled")).toBeChecked();
fireEvent.click(disclosure);
expect(screen.getByLabelText("tools.imageGeneration.model")).toHaveValue("unsaved-image-model");
```

- [ ] **Step 2: Run the component test and verify RED**

Run: `npx vitest run src/renderer/src/screens/Tools/ImageGenerationConfig.test.tsx`

Expected: FAIL because no disclosure button or `aria-expanded` state exists.

- [ ] **Step 3: Implement the minimal local disclosure state and styling**

Add `expanded` state defaulting to true. Render a native title-and-arrow button with `aria-expanded` and `aria-controls`, retain the enabled switch as its sibling, and keep the existing body mounted inside a wrapper whose `hidden` attribute follows disclosure. Use right/down chevrons and focused CSS without changing provider calls or draft state.

- [ ] **Step 4: Run the component test and verify GREEN**

Run: `npx vitest run src/renderer/src/screens/Tools/ImageGenerationConfig.test.tsx`

Expected: PASS, including existing save/discover/paid-confirmation and remote-boundary cases.

- [ ] **Step 5: Extend the isolated Electron fixture journey**

Before any fixture relay call, fill an unsaved model, collapse the title button, prove the body is hidden and the switch remains visible/checked, then re-expand and prove the value survived. Continue through the existing local discovery and one-request fixture generation flow.

- [ ] **Step 6: Commit the disclosure change**

```bash
git add src/renderer/src/screens/Tools/ImageGenerationConfig.tsx src/renderer/src/screens/Tools/ImageGenerationConfig.test.tsx src/renderer/src/assets/main.css tests/e2e/image-generation-config.e2e.ts
git commit -m "feat(tools): collapse image generation settings"
```

### Task 4: Hide only the Workspace menu descriptor

**Files:**
- Modify: `src/renderer/src/screens/Layout/Layout.tsx`
- Modify: `src/renderer/src/screens/Layout/Layout.navigation.test.ts`

- [ ] **Step 1: Write the failing navigation test**

Require the visible list to omit `office` while the retained catalog still contains the hidden Office descriptor and all other visible items remain ordered.

```ts
expect(PINNED_NAV_ITEMS.map((item) => item.view)).toEqual([
  "discover",
  "kanban",
  "schedules",
  "agents",
]);
expect(PINNED_NAV_CATALOG).toEqual(
  expect.arrayContaining([expect.objectContaining({ view: "office", hidden: true })]),
);
```

- [ ] **Step 2: Run the navigation test and verify RED**

Run: `npx vitest run src/renderer/src/screens/Layout/Layout.navigation.test.ts`

Expected: FAIL because `office` is still visible and no retained catalog exists.

- [ ] **Step 3: Add a retained catalog and derive the visible list**

Keep the `office` descriptor with `hidden: true`; derive `PINNED_NAV_ITEMS` by filtering hidden descriptors. Do not modify the `View` union, Office import, visited-view renderer, Workspace dialogs, locale key, route state, data, IPC, or permissions.

- [ ] **Step 4: Run the navigation test and verify GREEN**

Run: `npx vitest run src/renderer/src/screens/Layout/Layout.navigation.test.ts`

Expected: PASS and prove the feature descriptor remains restorable.

- [ ] **Step 5: Commit the presentation-only navigation change**

```bash
git add src/renderer/src/screens/Layout/Layout.tsx src/renderer/src/screens/Layout/Layout.navigation.test.ts
git commit -m "feat(navigation): hide workspace menu entry"
```

### Task 5: Document and verify the integrated current scope

**Files:**
- Modify: `lat.md/image-generation.md`
- Modify: `lat.md/sidebar-navigation.md`
- Modify: `tests/e2e/image-generation-config.e2e.ts`

- [ ] **Step 1: Update the knowledge graph**

Document the local disclosure behavior, the strict conversation-name fallback matrix and identity-event refresh, and the hidden-but-retained Office descriptor. Add one `@lat` reference beside each new regression test section that requires code mention.

- [ ] **Step 2: Run focused unit verification**

Run:

```bash
npx vitest run \
  tests/profiles.test.ts \
  tests/preload-api-surface.test.ts \
  src/shared/i18n/index.test.ts \
  src/renderer/src/screens/Chat/ConversationBoundaryIndicator.test.tsx \
  src/renderer/src/screens/Layout/Layout.model-setup-prompt.test.tsx \
  src/renderer/src/screens/Layout/Layout.navigation.test.ts \
  src/renderer/src/screens/Tools/ImageGenerationConfig.test.tsx
```

Expected: all focused suites PASS with zero failures.

- [ ] **Step 3: Run static verification**

Run: `npm run typecheck && npx eslint src/main/profiles.ts src/main/ipc/register.ts src/preload/index.ts src/preload/index.d.ts src/renderer/src/screens/Layout/ActiveSessionsBar.tsx src/renderer/src/screens/Layout/Layout.tsx src/renderer/src/screens/Chat/Chat.tsx src/renderer/src/screens/Chat/ConversationBoundaryIndicator.tsx src/renderer/src/screens/Tools/ImageGenerationConfig.tsx`

Expected: exit 0 with no TypeScript or ESLint errors.

- [ ] **Step 4: Run the isolated Electron fixture journey**

Run: `npm run test:e2e:image-generation`

Expected: PASS using temporary Electron `userData`, temporary `HERMES_HOME`, and the local fixture relay. The test must make no real paid provider request. Capture the expanded/collapsed configuration and verify the sidebar contains no visible Office/Workspace nav item while the app remains healthy.

- [ ] **Step 5: Validate `lat.md` and the final diff**

Run: `lat check && git diff --check && git status --short --branch`

Expected: `lat check` passes, the diff has no whitespace errors, and only the intended Beta.28 files are changed.

- [ ] **Step 6: Commit the integrated docs and acceptance update**

```bash
git add lat.md/image-generation.md lat.md/sidebar-navigation.md tests/e2e/image-generation-config.e2e.ts
git commit -m "test(beta28): verify UI refinements"
```

Do not run Electron Builder, modify `package.json` version, push, merge, deploy, or publish.
