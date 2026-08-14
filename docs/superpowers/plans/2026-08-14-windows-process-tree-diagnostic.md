# Windows Process-Tree Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add and execute one release-isolated Windows diagnostic for the Beta.28.1 process-tree repair without starting unrelated Actions jobs.

**Architecture:** Extend the existing `CI` workflow with a manual `mode` selector. Full mode retains the current three-platform `check` matrix, while diagnostic mode runs one distinctly named Windows job whose shape cannot satisfy the release checkpoint verifier.

**Tech Stack:** GitHub Actions YAML, Vitest, TypeScript, Node.js 22, lat.md.

---

### Task 1: Lock the diagnostic workflow contract

**Files:**
- Modify: `tests/ci-workflow-policy.test.ts`
- Test: `tests/ci-workflow-policy.test.ts`

- [ ] **Step 1: Write the failing workflow-policy test**

Add a test that parses `.github/workflows/ci.yml` and requires:

```ts
expect(workflow.on.workflow_dispatch.inputs.mode).toEqual({
  description: "Execution mode",
  required: true,
  default: "full",
  type: "choice",
  options: ["full", "windows-process-tree-diagnostic"],
});
expect(workflow.jobs.check.if).toBe(
  "github.event_name != 'workflow_dispatch' || inputs.mode == 'full'",
);
expect(workflow.jobs["windows-process-tree-diagnostic"]).toMatchObject({
  if: "github.event_name == 'workflow_dispatch' && inputs.mode == 'windows-process-tree-diagnostic'",
  name: "windows-process-tree-diagnostic",
  "runs-on": "windows-latest",
  "timeout-minutes": 10,
});
```

Also assert that the diagnostic has checkout, Node 22 setup, `npm ci`, `npm run typecheck:node`, and one focused Vitest command for the four affected files.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run tests/ci-workflow-policy.test.ts --reporter=verbose
```

Expected: the new test fails because `workflow_dispatch.inputs.mode` and `windows-process-tree-diagnostic` do not exist.

### Task 2: Implement the release-isolated diagnostic

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `lat.md/agentera-post-official-delivery.md`
- Test: `tests/ci-workflow-policy.test.ts`

- [ ] **Step 1: Add the manual mode and diagnostic job**

Keep all current `check` steps intact and add this event input and job boundary:

```yaml
workflow_dispatch:
  inputs:
    mode:
      description: Execution mode
      required: true
      default: full
      type: choice
      options:
        - full
        - windows-process-tree-diagnostic

jobs:
  check:
    if: github.event_name != 'workflow_dispatch' || inputs.mode == 'full'
    # Existing matrix and steps remain byte-for-byte unchanged.

  windows-process-tree-diagnostic:
    if: github.event_name == 'workflow_dispatch' && inputs.mode == 'windows-process-tree-diagnostic'
    name: windows-process-tree-diagnostic
    runs-on: windows-latest
    timeout-minutes: 10
```

The diagnostic test command is:

```yaml
run: >-
  npm test --
  src/main/process-tree.test.ts
  tests/gateway-restart.test.ts
  src/main/tui-gateway-lifecycle.test.ts
  src/main/gateway-shutdown-lifecycle.test.ts
  --maxWorkers=1
  --testTimeout=20000
  --reporter=verbose
```

- [ ] **Step 2: Document the evidence boundary**

Extend `Remote CI safety checkpoint` to state that the manual diagnostic uses a distinct job name, runs no release matrix, and cannot satisfy `scripts/verify-ci-checkpoint.mjs`.

- [ ] **Step 3: Run the policy test and verify GREEN**

Run:

```bash
npx vitest run tests/ci-workflow-policy.test.ts --reporter=verbose
```

Expected: both CI workflow-policy tests pass.

### Task 3: Verify and push without automatic Actions

**Files:**
- Verify: `.github/workflows/ci.yml`
- Verify: `tests/ci-workflow-policy.test.ts`
- Verify: `lat.md/agentera-post-official-delivery.md`

- [ ] **Step 1: Run local gates**

Run:

```bash
npx vitest run tests/ci-workflow-policy.test.ts src/main/process-tree.test.ts tests/gateway-restart.test.ts src/main/tui-gateway-lifecycle.test.ts src/main/gateway-shutdown-lifecycle.test.ts
npm run typecheck:node
npx prettier --check .github/workflows/ci.yml tests/ci-workflow-policy.test.ts lat.md/agentera-post-official-delivery.md
git diff --check
lat check
```

Expected: 5 files pass, Node typecheck exits zero, formatting passes, the Git diff is clean, and lat reports all checks passed.

- [ ] **Step 2: Commit with an Actions skip directive**

Run:

```bash
git add .github/workflows/ci.yml tests/ci-workflow-policy.test.ts lat.md/agentera-post-official-delivery.md docs/superpowers/plans/2026-08-14-windows-process-tree-diagnostic.md
git commit -m "ci: add Windows process diagnostic [skip ci]"
```

Expected: the branch HEAD contains the workflow, policy test, architecture note, and skip directive.

- [ ] **Step 3: Push the exact branch and verify no push run starts**

Run:

```bash
git push --set-upstream origin aera/beta28.1-windows-gateway-exit
gh run list --repo Ablankpaper/aera --branch aera/beta28.1-windows-gateway-exit --event push --limit 5
```

Expected: the branch is present on origin and no executed push CI run exists for the new HEAD.

### Task 4: Execute and inspect the one Windows diagnostic

**Files:**
- Execute: `.github/workflows/ci.yml`

- [ ] **Step 1: Dispatch the exact branch and diagnostic mode**

Run:

```bash
gh workflow run CI --repo Ablankpaper/aera --ref aera/beta28.1-windows-gateway-exit -f mode=windows-process-tree-diagnostic
```

Expected: one workflow-dispatch run is queued for the exact branch HEAD.

- [ ] **Step 2: Verify run identity before waiting**

Read the run JSON and require the exact local HEAD SHA, event `workflow_dispatch`, one executed job named `windows-process-tree-diagnostic`, and no executed `check` matrix job.

- [ ] **Step 3: Wait once and inspect the terminal result**

Wait for the run to finish. On success, record the run URL, exact SHA, job duration, four test-file count, and test count. On failure, retrieve the exact failed-step log and stop without rerunning.

- [ ] **Step 4: Preserve release status separation**

Report the result as focused real-Windows evidence only. Do not push `main`, trigger full CI, build a candidate, promote, deploy, or publish from this diagnostic result.
