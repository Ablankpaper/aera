# Internal Beta.13 Agent Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish an immutable `0.7.4-internal-beta.13` candidate containing the merged personal and organization Agent creation, publishing, shared installation, and start-use fixes.

**Architecture:** Keep the merged Agent implementation at `origin/main` unchanged and advance only the version-bound internal-Beta release contract. Bind package metadata, workflow validation, signed update metadata, tests, and operator documentation to the same Beta.13 identity, then publish only from the merged `main` SHA whose three-platform CI succeeded.

**Tech Stack:** Electron, TypeScript, Node.js test runner, Vitest, GitHub Actions, Ed25519-signed desktop update metadata.

---

### Task 1: Lock the workflow to the Beta.13 identity

**Files:**
- Modify: `scripts/internal-beta/workflow-policy.test.mjs`
- Test: `scripts/internal-beta/workflow-policy.test.mjs`

- [x] **Step 1: Add exact version and release-note policy assertions**

Add assertions that the workflow contains exactly:

```js
assert.match(raw, /test "\$VERSION" = "0\.7\.4-internal-beta\.13"/u);
assert.match(
  raw,
  /--release-notes "Beta\.13 修复个人与企业组织智能体的创建、发布、共享安装及开始使用流程。"/u,
);
```

- [x] **Step 2: Run the policy test and confirm the old Beta.12 workflow fails**

Run:

```bash
node --test scripts/internal-beta/workflow-policy.test.mjs
```

Expected: FAIL because `.github/workflows/internal-beta.yml` still names Beta.12.

### Task 2: Advance every release-bound identity to Beta.13

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/internal-beta.yml`
- Modify: `scripts/internal-beta/manifest.mjs`
- Modify: `scripts/internal-beta/manifest.test.mjs`
- Modify: `scripts/internal-beta/desktop-update.test.mjs`
- Modify: `scripts/internal-beta/publish-desktop-update.test.mjs`
- Modify: `tests/internal-beta-updater.test.ts`
- Modify: `docs/runbooks/internal-beta-packaging.md`
- Modify: `lat.md/agentera-post-official-delivery.md`

- [x] **Step 1: Update package and manifest identity**

Set the package, lockfile root, and `INTERNAL_BETA_VERSION` to:

```text
0.7.4-internal-beta.13
```

- [x] **Step 2: Update the GitHub release gate and signed release notes**

Set the workflow version gate to `0.7.4-internal-beta.13` and its signed update release note to:

```text
Beta.13 修复个人与企业组织智能体的创建、发布、共享安装及开始使用流程。
```

- [x] **Step 3: Update release fixtures and the upgrade boundary**

Use Beta.13 in manifest, desktop-update, and publisher fixtures. In `tests/internal-beta-updater.test.ts`, set:

```ts
const CURRENT_VERSION = "0.7.4-internal-beta.12";
const NEXT_VERSION = "0.7.4-internal-beta.13";
```

- [x] **Step 4: Update operator documentation**

Change the current candidate identity and four artifact names to Beta.13 while retaining explicitly historical Beta.6-Beta.12 references where they describe earlier releases.

- [x] **Step 5: Run focused release tests**

Run:

```bash
node --test \
  scripts/internal-beta/workflow-policy.test.mjs \
  scripts/internal-beta/manifest.test.mjs \
  scripts/internal-beta/desktop-update.test.mjs \
  scripts/internal-beta/publish-desktop-update.test.mjs
npx vitest run tests/internal-beta-updater.test.ts
```

Expected: all focused release tests pass.

### Task 3: Verify the complete Desktop candidate locally

**Files:**
- Verify: all files changed in Tasks 1 and 2
- Modify: `lat.md/agentera-agent-control-plane.md`

- [x] **Step 1: Verify no stale release-bound Beta.12 identity remains**

Run a repository search excluding dependencies and this plan. The only intended `0.7.4-internal-beta.12` occurrence is `CURRENT_VERSION` in the updater regression test.

- [x] **Step 2: Restore the personal Agent release-gate LAT contract**

Run `lat check` and confirm it rejects the missing `Release gate#Personal publish and use` target. Add that exact subsection beside the existing Organization, Workspace, and Two-device release gates, binding the live personal-Agent E2E to the USER-owned publish, isolated model projection, ready catalog, start-use, and live response proof. Re-run `lat check` and require exit code 0.

- [x] **Step 3: Run full tests and static checks**

Run:

```bash
npm test
npm run typecheck
npm run lint
```

Expected: exit code 0 with no failing tests or lint errors.

- [x] **Step 4: Run the production build and repository policy check**

Run:

```bash
npm run build
npm exec --yes --package=lat.md@0.12.1 -- lat check
```

Expected: both commands exit 0.

### Task 4: Land the immutable Beta.13 release contract

**Files:**
- Commit: only the Beta.13 release files and this plan

- [ ] **Step 1: Review the complete diff and commit it**

Run `git diff --check`, inspect `git diff`, then commit with:

```text
chore: prepare internal beta 13 agent fixes
```

- [ ] **Step 2: Push and open a pull request**

Push `aera/internal-beta-13-agent-fix`, open a PR to `main`, and wait for macOS, Ubuntu, Windows, and CodeRabbit checks.

- [ ] **Step 3: Merge only after all PR checks succeed**

Use a merge commit so the Beta.13 release commit remains independently auditable.

### Task 5: Publish and accept the online update

**Files:**
- Verify: `.github/workflows/internal-beta.yml`
- Verify: live `internal-beta/manifest.json`

- [ ] **Step 1: Wait for the exact merged-main CI**

Record the merged `main` SHA and its successful three-platform CI run ID.

- [ ] **Step 2: Dispatch the protected internal-Beta workflow**

Run:

```bash
merged_main_sha=$(git rev-parse origin/main)
successful_main_ci_run_id=$(
  gh run list \
    --repo bignormal/aera \
    --workflow ci.yml \
    --branch main \
    --event push \
    --status success \
    --limit 20 \
    --json databaseId,headSha \
    --jq ".[] | select(.headSha == \"$merged_main_sha\") | .databaseId" |
    head -n 1
)
test -n "$successful_main_ci_run_id"
gh workflow run internal-beta.yml \
  --repo bignormal/aera \
  --ref main \
  -f source_sha="$merged_main_sha" \
  -f ci_run_id="$successful_main_ci_run_id"
```

- [ ] **Step 3: Verify publication bytes and live metadata**

Require the packaging workflow, checksums, signatures, SSH publication, HTTPS range probes, and live manifest to agree on Beta.13.

- [ ] **Step 4: Perform true-client acceptance**

On the existing Beta.12 client, verify discovery, download, installation, restart into Beta.13, and the personal/organization Agent creation, publishing, shared installation, and start-use paths. Do not call the update user-ready until this step passes.
