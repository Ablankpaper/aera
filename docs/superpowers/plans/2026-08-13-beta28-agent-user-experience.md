# Beta.28 Agent User Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing verified Agent control-plane operations into outcome-oriented one-click Desktop journeys without changing Cloud, Runtime, or Admin contracts.

**Architecture:** Add a thin renderer orchestration layer over existing prepare/confirm and install/repair APIs. Keep all trusted checks in Main/Cloud, hide their implementation records from primary UI, and retain governance under progressive disclosure.

**Tech Stack:** Electron 39, React 19, TypeScript 5.9, Vitest/Testing Library, Playwright Electron, lat.md.

---

### Task 1: One-click Agent activation

**Files:**
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Modify: `src/renderer/src/screens/Agents/Agents.tsx`
- Modify: `src/renderer/src/screens/Layout/Layout.tsx`
- Test: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`

- [x] Write a failing test proving “Start using” immediately chooses the preferred available model route, installs/repairs the Agent, and opens chat without a model-choice dialog.
- [x] Run the focused test and confirm RED for the unexpected model-choice dialog.
- [x] Pass an `onConfigureModels` callback from Layout and make the no-model primary action open provider settings.
- [x] Implement automatic preferred-route activation and run the focused test GREEN.

### Task 2: One-click official Agent use

**Files:**
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Modify: `src/renderer/src/screens/Agents/OfficialAgentSection.tsx`
- Test: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`
- Remove: `src/renderer/src/screens/Agents/OfficialAgentInstallDialog.tsx`
- Remove: `src/renderer/src/screens/Agents/OfficialAgentInstallDialog.test.tsx`

- [x] Write a failing test proving one “Start using” click calls prepare then confirm with the returned one-use handle and opens the resulting installation.
- [x] Run the focused test and confirm RED because a second confirmation dialog is rendered.
- [x] Move the existing fixed confirmation into the named click handler while preserving sequential prepare/confirm calls.
- [x] Run the official flow tests GREEN and remove the unused dialog.

### Task 3: One-click capability sharing

**Files:**
- Modify: `src/renderer/src/screens/Agents/ExperiencePromotionDialog.tsx`
- Modify: `src/renderer/src/screens/Agents/OrganizationExperienceCandidatePanel.tsx`
- Modify: `src/shared/i18n/locales/*/agents.ts`
- Test: `src/renderer/src/screens/Agents/ExperiencePromotionDialog.test.tsx`
- Test: `src/renderer/src/screens/Agents/OrganizationExperienceCandidatePanel.test.tsx`

- [x] Write failing tests proving a selected saved capability is prepared, DLP-checked, and submitted by one share click without preview identifiers or a confirmation checkbox.
- [x] Run both focused tests and confirm RED on the existing preview/confirmation flow.
- [x] Implement sequential prepare/submit orchestration; stop before submit on any finding and keep the local capability unchanged.
- [x] Replace candidate/governance terminology in the ordinary-user controls and run both tests GREEN.

### Task 4: Progressive disclosure and recovery actions

**Files:**
- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Modify: `src/renderer/src/screens/Agents/AgentHubDetailDialog.tsx`
- Modify: `src/shared/i18n/locales/*/agents.ts`
- Test: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`

- [x] Write failing tests proving governance defaults closed, recoverable errors show one “Try again” action, and model errors show “Configure model.”
- [x] Run the focused tests and confirm RED.
- [x] Add a bounded error-action mapping and keep non-recoverable privacy/permission denials fail-closed.
- [x] Run focused tests GREEN.

### Task 5: Knowledge graph and isolated acceptance

**Files:**
- Modify: `lat.md/agentera-agent-control-plane.md`
- Modify: `lat.md/sidebar-navigation.md`
- Test: focused Agent renderer files and an isolated Electron journey selected from the existing Agent E2E harness.

- [x] Document the outcome-oriented UI and add exact `@lat` references beside new regression tests.
- [x] Run only the changed-boundary unit suites, TypeScript checks, and `lat check`.
- [x] Run one isolated Electron Agent journey for the ordinary-user path with the verified Darwin arm64 Runtime Seed and local Cloud harness.
- [x] Inspect the final diff and report code, verification, and release state separately.

## Verification boundary

The renderer/unit, TypeScript, production build, knowledge-graph, diff, and isolated Electron Agent Control checks are green. The Electron run uses the verified Darwin arm64 Runtime Seed and exercises the default-Profile claim plus two-device Agent lifecycle; it is not a packaged-release or cross-platform acceptance claim. No release or deployment claim is made.
