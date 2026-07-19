# Desktop model bypass and Agent navigation implementation plan

Implement the approved startup and sidebar behavior without changing Hermes user-state or learning boundaries.

## Task 1: Lock the behavior with failing tests

**Files:**

- Modify: `tests/agentera-startup-preflight.test.ts`
- Modify: `src/renderer/src/App.test.tsx`
- Create: `src/renderer/src/screens/Layout/Layout.navigation.test.ts`

Change the preflight expectation so every installed local Runtime targets `main`, add renderer coverage that normalizes a legacy `setup` target to `main`, change the post-install expectation to `main`, and assert that Agents follows Schedules in the pinned navigation.

Run the targeted tests and confirm they fail for the expected missing behavior before changing production code.

## Task 2: Remove model setup from startup routing

**Files:**

- Modify: `src/main/agentera-startup-preflight.ts`
- Modify: `src/renderer/src/App.tsx`

Return `main` for an installed Runtime regardless of model credentials. Normalize any remaining `setup` target to `main` after Profile ownership succeeds, and continue to `main` after a bundled Runtime installation or fresh Profile creation.

Keep authentication, Runtime installation, Runtime verification, and Profile ownership gates unchanged. Do not write credentials or model configuration while routing.

## Task 3: Add the Agent sidebar destination

**Files:**

- Modify: `src/renderer/src/screens/Layout/Layout.tsx`
- Modify: `src/shared/i18n/locales/en/navigation.ts`
- Modify: `src/shared/i18n/locales/zh-CN/navigation.ts`

Export the pinned navigation definition for focused testing, add the existing `agents` view after `schedules` with the Bot icon, and label it `Agents` / `智能体`. Reuse the already-mounted Agents screen and its existing handlers.

## Task 4: Update architectural knowledge

**Files:**

- Modify: `lat.md/provider-setup.md`
- Modify: `lat.md/agentera-app-authentication.md`
- Modify: `lat.md/sidebar-navigation.md`

Document that provider setup is now an in-desktop choice, that the startup state machine routes installed Profiles to main, and that Agents is a pinned sidebar destination.

## Task 5: Verify and publish

Run targeted Vitest coverage, both TypeScript projects, ESLint for changed source files, and `npx --yes lat.md check`. Restart the Electron dev app, inspect the sidebar and Agents page, then commit the source changes and push `aera/desktop-model-bypass-agent-nav` to `bignormal/aera`.
