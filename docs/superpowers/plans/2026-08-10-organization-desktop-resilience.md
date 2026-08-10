# Organization Desktop Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep successful Organization Agent data visible when a peer read fails and prevent stale cards or roles from surviving an Organization switch.

**Architecture:** Preserve the sequential submission-before-draft order and load epoch, but accumulate the first read error instead of returning early. Commit the trusted new context and empty context-bound collections immediately after `getState` identifies a context change, before any Cloud-dependent read can settle.

**Tech Stack:** Electron, React 19, TypeScript, Vitest, Testing Library, lat.md.

---

### Task 1: Prove a submission failure currently blanks definitions

**Files:**

- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`
- Modify: `lat.md/agentera-agent-control-plane.md`

- [ ] **Step 1: Add the behavior specification**

Under the trusted-context section in `lat.md/agentera-agent-control-plane.md`, add a leaf section stating that Organization catalog reads are independent, the first error remains visible, and successful definitions still render.

- [ ] **Step 2: Add the regression test**

Add a test with an Owner Organization, `initialTab="enterprise"`, a failing `listOrganizationSubmissions()` result using `cloud_unavailable`, and a successful `listDefinitions()` result containing `definition()`. Assert that `Research Agent` and `agents.control.errors.cloud_unavailable` are both visible and that `listDefinitions` was called.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npx vitest run src/renderer/src/screens/Agents/AgentControlPanel.test.tsx -t "keeps successful Organization definitions visible when submission history fails"
```

Expected: FAIL because the current loader returns before `listDefinitions`.

### Task 2: Prove a context switch currently retains stale cards and role

**Files:**

- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`
- Modify: `lat.md/agentera-agent-control-plane.md`

- [ ] **Step 1: Add the context-clearing specification**

Document that a changed trusted context commits the new state and clears definitions, drafts, installations, submissions, official collections, and selections before peer reads complete; epoch cancellation prevents an older load from restoring them.

- [ ] **Step 2: Add the pending-read regression test**

Create two Organization states: the first is Owner and renders `Research Agent`; the second has a different Organization ID and Auditor role. Capture `onStateChanged`, make the second `listOrganizationSubmissions()` call return a manually controlled Promise, trigger the context change, and assert before resolving that Promise that `Research Agent` and the Owner-only new-draft button are absent.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npx vitest run src/renderer/src/screens/Agents/AgentControlPanel.test.tsx -t "clears stale Organization cards and role before the next peer read settles"
```

Expected: FAIL because the current component commits the new context only after every read finishes.

### Task 3: Implement minimal independent reads and early context invalidation

**Files:**

- Modify: `src/renderer/src/screens/Agents/AgentControlPanel.tsx`

- [ ] **Step 1: Introduce one first-error accumulator before peer reads**

Declare `let nextError: string | null = null` immediately after the trusted state and context key are derived. For installation, submission, and draft results, replace each error `return` with:

```ts
nextError ??= errorKey(result.errorCode);
```

Assign successful data only in the corresponding `else` branch. Preserve submission-before-draft call order.

- [ ] **Step 2: Commit a changed trusted context before peer reads**

Immediately after `nextContextKey` is derived, detect a non-null different selected key. For a changed context, close the existing transient dialogs, clear all context-bound arrays and selections, set the new trusted state, and update `selectedContextKey.current` before calling `listInstallations` or any Cloud read.

Use the existing setters; do not add a timer, retry, relaxed validator, or renderer-supplied identity.

- [ ] **Step 3: Preserve the first error in later reads**

For definitions, official agents, and official updates, use `nextError ??=` so a later failure cannot replace the first load-order error.

- [ ] **Step 4: Avoid duplicate invalidation at the final commit**

Keep same-context dialog behavior unchanged and ensure the final commit still sets every successful array, the trusted state, `selectedContextKey.current`, and `setError(nextError)` for the current epoch only.

### Task 4: Verify RED to GREEN and protect ordering

**Files:**

- Verify: `src/renderer/src/screens/Agents/AgentControlPanel.tsx`
- Verify: `src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`

- [ ] **Step 1: Run both new tests**

Run:

```bash
npx vitest run src/renderer/src/screens/Agents/AgentControlPanel.test.tsx -t "keeps successful Organization definitions visible when submission history fails|clears stale Organization cards and role before the next peer read settles"
```

Expected: both tests pass.

- [ ] **Step 2: Run the full component file**

Run: `npx vitest run src/renderer/src/screens/Agents/AgentControlPanel.test.tsx`

Expected: all component tests pass, including submission-before-draft reconciliation and same-context workflow persistence.

- [ ] **Step 3: Run static and knowledge gates**

Run:

```bash
npm run typecheck
npx prettier --check src/renderer/src/screens/Agents/AgentControlPanel.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx lat.md/agentera-agent-control-plane.md
lat check
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Commit the Desktop repair**

Run:

```bash
git add src/renderer/src/screens/Agents/AgentControlPanel.tsx src/renderer/src/screens/Agents/AgentControlPanel.test.tsx lat.md/agentera-agent-control-plane.md
git commit -m "fix(desktop): isolate organization catalog reads"
```

Expected: one focused implementation commit after the design and plan commits.

### Task 5: Run isolated Electron acceptance

**Files:**

- Verify: installed Beta.25 and the repair build using isolated user data.

- [ ] **Step 1: Build the repair branch**

Run: `npm run build`

Expected: type checks and Electron Vite build exit 0.

- [ ] **Step 2: Run the checked-in isolated Organization journey**

Run: `npm run test:e2e:organization-agent`

Expected: the isolated Organization Agent journey passes without using daily Electron data or Hermes state.

- [ ] **Step 3: Run live post-deployment acceptance inside Electron**

After the Cloud recovery candidate is enabled, launch installed Beta.25 and verify the existing Owner Organization definitions, publication history, and ExperienceCandidate panels. Then switch Organizations and verify that no previous card or role is visible during the next load.

Expected: no `service_unavailable`, no `invalid_request`, no whole-page blank state, and no cross-Organization stale content.
