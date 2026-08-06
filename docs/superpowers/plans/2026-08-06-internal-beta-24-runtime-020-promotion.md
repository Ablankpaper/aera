# Internal Beta.24 Runtime 0.20 Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a new immutable `0.7.4-internal-beta.24` Desktop update containing the already reviewed Runtime `0.20.0-agentera.1`, without replacing the published Beta.23 bytes.

**Architecture:** Advance only the Desktop release identity and its version-bound candidate, promotion, manifest, tests, runbooks, and LAT contract from Beta.23 to Beta.24. Keep `runtime-v0.20.0-agentera.1-rc.1`, Runtime source `ae746df6556f1d496f9dd49c850cc6133997e317`, the Runtime Seed lock, macOS Developer ID/notarization boundary, and explicitly unsigned Windows Internal Beta boundary unchanged. Build and promote only from the merged-main SHA after fresh candidate-byte and isolated Electron acceptance.

**Tech Stack:** Electron, TypeScript, Node.js test runner, Vitest, GitHub Actions, electron-builder, Apple notarytool/stapler, Ed25519 update signatures, Sigstore Cosign, GitHub CLI.

---

### Task 1: Freeze the immutable baseline

**Files:**
- Record outside Git: `/Users/zizimutou/Desktop/aera-worktrees/beta24-runtime020-promotion-verification-ledger.md`
- Verify: `build/agentera-runtime-seed.lock.json`
- Verify: live `https://47.100.169.193/desktop-updates/internal-beta/manifest.json`

- [ ] **Step 1: Record the clean linked-worktree identity**

Record branch `release/beta24-runtime020-promotion`, base `cf68b3ee8f2a0908396618ca42a7e79b5db950c1`, tree `0a95bf0a0c9a7f330d4b0b8eba9821f74cff1c22`, clean status, remote main, and absence of a pre-existing Beta.24 branch.

- [ ] **Step 2: Record Beta.23 immutable and superseded-candidate evidence**

Record the live Beta.23 manifest hashes, candidate run `31080549287`, artifact `8959770915`, artifact digest `sha256:990a4b15c29aaa8daa4de7526846cf70433ea1bf72276dda8e2cc915adcafec2`, isolated packaged-Electron result, and canceled old-Seed run `31077673642`. Mark the differing same-version candidate permanently non-promotable.

- [ ] **Step 3: Prove the existing focused release baseline is green**

Run:

```bash
node --test scripts/internal-beta/manifest.test.mjs scripts/internal-beta/desktop-update.test.mjs scripts/internal-beta/publish-desktop-update.test.mjs scripts/internal-beta/workflow-policy.test.mjs
```

Expected: 15 pass, 0 fail, 1 Windows-only skip.

### Task 2: Drive the Beta.24 identity failure first

**Files:**
- Modify: `scripts/internal-beta/workflow-policy.test.mjs`
- Modify: `scripts/internal-beta/manifest.test.mjs`
- Test: `scripts/internal-beta/workflow-policy.test.mjs`
- Test: `scripts/internal-beta/manifest.test.mjs`

- [ ] **Step 1: Change the exact policy assertion and manifest fixture to Beta.24**

Require:

```js
assert.match(raw, /test "\$VERSION" = "0\.7\.4-internal-beta\.24"/u);
```

and this exact signed update note:

```text
Beta.24 将随包 Runtime 升级到 0.20.0-agentera.1，保留 Agent 安装恢复、Profile/Runtime 绑定与稳定更新通道；macOS 继续通过 Apple 公证、装订及 Gatekeeper 验证，Windows 内测包仍明确未签名。
```

Set the manifest fixture version to `0.7.4-internal-beta.24`.

- [ ] **Step 2: Run the two tests and verify RED**

Run:

```bash
node --test scripts/internal-beta/workflow-policy.test.mjs scripts/internal-beta/manifest.test.mjs
```

Expected: failure because production still exposes Beta.23 in the candidate workflow and manifest constant.

### Task 3: Advance every release-bound identity

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/internal-beta.yml`
- Modify: `.github/workflows/internal-beta-promote.yml`
- Modify: `scripts/internal-beta/manifest.mjs`
- Modify: `scripts/internal-beta/desktop-update.test.mjs`
- Modify: `scripts/internal-beta/manifest.test.mjs`
- Modify: `scripts/internal-beta/publish-desktop-update.test.mjs`
- Modify: `scripts/internal-beta/workflow-policy.test.mjs`

- [ ] **Step 1: Set the package, lockfile, manifest and fixtures to one version**

Use exactly:

```text
0.7.4-internal-beta.24
```

Do not change `build/agentera-runtime-seed.lock.json`, `INTERNAL_BETA_RUNTIME_SOURCE_SHA`, Runtime filenames, update trust keys, signing status, production `release-candidate.yml`, or publisher immutability logic.

- [ ] **Step 2: Update both workflow gates**

Both candidate and promotion workflows must contain:

```bash
test "$VERSION" = "0.7.4-internal-beta.24"
```

The candidate workflow must sign the exact release note from Task 2. Promotion must continue to download, verify, and publish the candidate without rebuilding or resigning.

- [ ] **Step 3: Run the focused release tests and lint**

Run:

```bash
node --test scripts/internal-beta/manifest.test.mjs scripts/internal-beta/desktop-update.test.mjs scripts/internal-beta/publish-desktop-update.test.mjs scripts/internal-beta/workflow-policy.test.mjs
npx eslint scripts/internal-beta/manifest.mjs scripts/internal-beta/manifest.test.mjs scripts/internal-beta/desktop-update.test.mjs scripts/internal-beta/publish-desktop-update.test.mjs scripts/internal-beta/workflow-policy.test.mjs
```

Expected: all executable tests pass with only the Windows-only syntax test skipped on macOS; ESLint exits 0.

### Task 4: Align operator and architecture contracts

**Files:**
- Modify: `docs/runbooks/internal-beta-packaging.md`
- Modify: `docs/runbooks/internal-beta-live-smoke.md`
- Modify: `lat.md/desktop-updates.md`
- Modify: `lat.md/agentera-post-official-delivery.md`
- Create: `docs/superpowers/plans/2026-08-06-internal-beta-24-runtime-020-promotion.md`

- [ ] **Step 1: Preserve Beta.23 as history and name Beta.24 as current**

State that live Beta.23 remains immutable, the differing Beta.23 candidate is not promotable, Beta.24 uses new package names and bytes, macOS remains Developer ID signed/notarized/stapled/Gatekeeper accepted, Windows remains explicitly unsigned for Internal Beta, and production Authenticode policy is unchanged.

- [ ] **Step 2: Bind the unchanged Runtime Seed**

Document `runtime-v0.20.0-agentera.1-rc.1` and `ae746df6556f1d496f9dd49c850cc6133997e317` as unchanged Beta.24 inputs. Do not describe canceled run `31077673642` as reusable.

- [ ] **Step 3: Validate the knowledge graph**

Run:

```bash
lat check
```

Expected: all LAT links and code references pass.

### Task 5: Freeze and land the Beta.24 release contract

**Files:**
- Commit: only the files listed in Tasks 2 through 4

- [ ] **Step 1: Review the exact diff and unchanged Runtime lock**

Run:

```bash
git diff --check
git diff --stat
git diff -- build/agentera-runtime-seed.lock.json
rg --hidden -n '0\.7\.4-internal-beta\.23|Beta\.23' --glob '!.git/**' --glob '!node_modules/**' .
```

Expected: no whitespace error, no Runtime lock diff, and remaining Beta.23 references are explicitly historical.

- [ ] **Step 2: Run the final local release-contract gate once**

Run the focused release tests, `npm run typecheck`, affected ESLint, and `lat check` once on the final unstaged bytes. If any command changes files, repair and rerun only the affected failed command before freezing.

- [ ] **Step 3: Commit and verify the frozen SHA**

Commit message:

```text
chore(release): prepare immutable internal beta 24
```

Verify clean status, exact commit, parent `cf68b3ee8f2a0908396618ca42a7e79b5db950c1`, and explicit changed-file inventory.

- [ ] **Step 4: Push once and open one PR**

Push `release/beta24-runtime020-promotion`, open a PR against `main`, and record the PR URL and exact head. Do not amend or force-push after exact-head CI begins.

- [ ] **Step 5: Accept only the unique automatic exact-head and merged-main CI runs**

Wait for the PR's automatic exact-head CI and review. Merge normally only if required checks and review pass, then wait for the one automatic merged-main CI on the merge SHA. Do not manually dispatch or rerun CI.

### Task 6: Build and verify one new immutable Beta.24 candidate

**Files:**
- Verify: `.github/workflows/internal-beta.yml`
- Verify: candidate artifact from the unique workflow run
- Record outside Git: `/Users/zizimutou/Desktop/aera-worktrees/beta24-runtime020-promotion-verification-ledger.md`

- [ ] **Step 1: Dispatch the candidate exactly once**

Use the merged-main SHA and its successful CI run ID as `source_sha` and `ci_run_id`. Never use run `31077673642`, the Beta.23 candidate run, or a branch/tag identity.

- [ ] **Step 2: Verify the complete candidate artifact**

Verify the outer artifact digest, `SHA256SUMS`, canonical manifest, Ed25519 update signature, Cosign manifest/provenance bundles and exact OIDC identity. On macOS verify Developer ID, hardened runtime, nested signatures, app/DMG notarization and stapling, Gatekeeper, arm64 and packaged Seed. On Windows verify absent Authenticode certificate table, setup/portable hashes, x86-64 executable/native payload, identical Seed payloads and the unchanged Runtime identity. Do not claim Windows physical-device acceptance.

### Task 7: Run fresh isolated Electron acceptance

**Files:**
- Test: `tests/e2e/agentera-runtime-seed.e2e.ts`
- Test: `tests/e2e/chat-stream-integrity.e2e.ts`
- Record outside Git: `/Users/zizimutou/Desktop/aera-worktrees/beta24-runtime020-promotion-verification-ledger.md`

- [ ] **Step 1: Prove packaged Seed boot and restart**

Launch the exact packaged Beta.24 executable with a fresh test-created `user-data`, `HERMES_HOME`, Runtime root, local auth Cloud and the exact three-file candidate Seed. Require first launch/login, public Runtime download denial, Runtime `0.20.0-agentera.1`, cold restart and run-owned cleanup.

- [ ] **Step 2: Prove core chat through the exact Desktop candidate and Runtime SHA**

Run `chat-stream-integrity.e2e.ts` with the exact packaged Beta.24 executable, Runtime SHA `ae746df6556f1d496f9dd49c850cc6133997e317`, fresh isolated Runtime clone/dependencies and its loopback OpenAI-compatible provider. Require visible/completion/`state.db` hash equality, zero invalid requests and no orphan process. No daily credential, Profile, cache or private Hermes data may be read.

### Task 8: Promote and close the online byte chain

**Files:**
- Verify: `.github/workflows/internal-beta-promote.yml`
- Verify: live signed manifest and versioned assets

- [ ] **Step 1: Recheck the live channel and promotion uniqueness**

Confirm live current is still immutable Beta.23, no Beta.24 version directory or prior promotion exists, and the exact candidate run remains successful and unexpired.

- [ ] **Step 2: Dispatch promotion exactly once**

Use only the merged-main Beta.24 source SHA and its accepted candidate run ID. Let the workflow verify and publish without rebuild or resign.

- [ ] **Step 3: Verify live same-byte closure**

Compare live manifest and signature byte-for-byte with the candidate. Hash the live Beta.24 macOS ZIP and Windows setup bytes against candidate metadata, verify the monotonic Beta.23 to Beta.24 update path in a fresh isolated client, restart, and confirm no orphan process. Report candidate, promotion, manifest and platform evidence as separate layers.
