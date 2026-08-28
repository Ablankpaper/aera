# Beta.38 Managed Gateway Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a bounded Windows diagnostic that reproduces the packaged Desktop managed Gateway launch and identifies the first failing import or initialization phase without weakening readiness or process-ownership checks.

**Architecture:** The diagnostic runs the same six-stage Python invocation boundary used by Desktop, materializes only an isolated API-server Profile, and records JSONL phase/process/readiness evidence. A single stack-trace branch is appended only after the traced Gateway launch times out; every cleanup action requires a complete captured-and-current process identity.

**Tech Stack:** Node.js standard library, Python packaged Runtime, PowerShell/CIM on Windows, Node test runner, ESLint, Prettier, TypeScript, lat.md.

**Spec:** `lat.md/agentera-runtime-distribution.md#AgentEra Runtime distribution#Desktop TUI backend lifecycle#Gateway readiness evidence`

## Global Constraints

- Do not start Beta.39 or rerun the full candidate before diagnostic evidence identifies the first unresolved phase.
- Readiness requires both a verified `gateway.pid` listener identity and authenticated `/v1/capabilities`.
- Windows cleanup must target only an exact captured process identity/tree and must fail closed on unavailable or changed evidence.
- Preserve the main checkout's existing WIP; all edits stay in `beta38-gateway-startup-fix`.

---

### Task 1: Lock the managed invocation and identity-retry contracts

**Files:**

- Modify: `scripts/diagnose-windows-serve-help.test.mjs`
- Modify: `scripts/diagnose-windows-serve-help.mjs`

**Interfaces:**

- `buildManagedGatewayEnvironment()` must mirror Desktop's managed environment while explicitly excluding inherited `PYTHONHOME`, `PYTHONPATH`, CI markers, and provider credentials.
- `buildManagedGatewayPhases()` must emit the exact `-m hermes_cli.main gateway` command and one diagnostic-only import-time flag.
- `readProcessEvidenceWithRetry()` may retry only transient query misses and must stop on identity mismatch.

- [x] **Step 1: Add failing assertions for exact environment and phase argv.**
- [x] **Step 2: Run `node --test scripts/diagnose-windows-serve-help.test.mjs` and verify the new assertions fail for the non-Desktop fields or missing boundary.**
- [x] **Step 3: Implement the smallest environment/phase/retry changes.**
- [x] **Step 4: Re-run the focused Node tests and verify they pass.**

### Task 2: Complete bounded evidence and fail-closed cleanup

**Files:**

- Modify: `scripts/diagnose-windows-serve-help.mjs`
- Modify: `scripts/diagnose-windows-serve-help.test.mjs`

**Interfaces:**

- Phase evidence must retain wrapper PID/identity, listener PID/identity, pid-file state, command/args, import-time tails, faulthandler tails, exit status, cleanup attempts, and remaining PIDs after redaction.
- `runGatewayPhase()` must append `gateway-stacktrace` only after a readiness timeout and must preserve the stacktrace phase result before deleting its sandbox.

- [x] **Step 1: Add failing tests for stacktrace evidence, pid-file transitions, and identity-unverified cleanup residue.**
- [x] **Step 2: Run the focused tests and verify the expected failures.**
- [x] **Step 3: Implement bounded evidence retention and cleanup reporting without adding retries or timeout relaxation.**
- [x] **Step 4: Re-run focused tests and `node --check`.**

### Task 3: Admit the diagnostic to CI and update architecture evidence

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `lat.md/agentera-runtime-distribution.md`
- Modify: `lat.md/lat.md`

**Interfaces:**

- Ordinary platform CI runs the Node diagnostic unit test; the workflow-dispatch Windows job runs the managed-Gateway diagnostic and uploads its JSONL artifact.
- lat.md documents the phase chain, bounded identity retry, stacktrace branch, and residue/fail-closed boundary with valid source/test references.

- [x] **Step 1: Add the test file to the ordinary CI test command and rename the dispatch job description to managed Gateway diagnostic.**
- [x] **Step 2: Add concise architecture and test-spec sections with adjacent `@lat` references.**
- [x] **Step 3: Run `lat check` and the workflow policy tests.**

### Task 4: Run local gates and hand off the exact diagnostic head

**Files:**

- No additional files.

- [x] **Step 1: Run targeted Node tests, ESLint, Prettier check, Node typecheck, `git diff --check`, and `lat check`.**
- [x] **Step 2: Stop on the first new failure and record its exact command/output; do not speculative-rerun it.**
- [x] **Step 3: Commit only the diagnostic/CI/lat changes and report the exact head for PR CI.**
