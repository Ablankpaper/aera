# Beta.23 Internal Beta Unsigned Windows Exception Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Beta.21-style unsigned Windows x64 packaging contract only for `0.7.4-internal-beta.23`, while preserving strict macOS notarization, update-byte integrity, and the production Authenticode gate.

**Architecture:** The Internal Beta workflow will package Windows NSIS and portable artifacts with signing discovery disabled and will no longer produce or consume `windows-evidence.json`. The Internal Beta manifest will explicitly record `macos_developer_id_notarized_windows_unsigned`; the separate production candidate workflow and shared Windows verifier remain untouched and fail closed on missing Authenticode.

**Tech Stack:** GitHub Actions YAML, Electron Builder 26, Node.js 22 ESM tests, PowerShell, LAT architecture documentation.

---

### Task 1: Make the Internal Beta workflow explicitly unsigned

**Files:**
- Modify: `scripts/internal-beta/workflow-policy.test.mjs`
- Modify: `.github/workflows/internal-beta.yml`

- [ ] **Step 1: Write the focused failing workflow-policy assertions**

Keep the existing macOS signing assertions and PowerShell syntax test. Replace only the Internal Beta Windows assertions with this contract, and add a separate production-workflow read so the exception cannot leak:

```js
const productionCandidatePath = new URL(
  "../../.github/workflows/release-candidate.yml",
  import.meta.url,
);

assert.match(raw, /Build unsigned Windows x64 internal Beta/u);
assert.match(raw, /CSC_IDENTITY_AUTO_DISCOVERY:\s*"false"/u);
assert.match(raw, /Package unsigned Windows setup and portable executables/u);
assert.doesNotMatch(raw, /secrets\.WIN_CSC_LINK|secrets\.WIN_CSC_KEY_PASSWORD/u);
assert.doesNotMatch(raw, /candidate\/evidence\/windows-evidence\.json/u);

const productionRaw = await readFile(productionCandidatePath, "utf8");
assert.match(productionRaw, /Build and Authenticode-sign Windows x64/u);
assert.match(productionRaw, /secrets\.WIN_CSC_LINK/u);
assert.match(productionRaw, /secrets\.WIN_CSC_KEY_PASSWORD/u);
assert.match(productionRaw, /scripts\/release\/verify-windows\.ps1/u);
```

- [ ] **Step 2: Run the policy test and capture RED**

Run:

```bash
node --test scripts/internal-beta/workflow-policy.test.mjs
```

Expected: FAIL because the current Internal Beta workflow still requires `WIN_CSC_*`, produces `windows-evidence.json`, and names the Windows job Authenticode-signed.

- [ ] **Step 3: Restore the Beta.21-style Windows job**

Replace the credential/signing and evidence steps in `.github/workflows/internal-beta.yml` with the focused unsigned packaging path:

```yaml
  windows:
    name: Build unsigned Windows x64 internal Beta

      - name: Package unsigned Windows setup and portable executables
        shell: pwsh
        env:
          CSC_IDENTITY_AUTO_DISCOVERY: "false"
        run: |
          npx electron-builder `
            --config build/electron-builder.internal-beta.yml `
            --win nsis portable --x64 --publish never
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

Restore the existing Runtime Seed verification against `dist/win-unpacked/resources/agentera-runtime-seed`, stage only `artifacts/` and `runtime-seed/`, remove the assemble-stage Windows evidence copy, remove `--windows-evidence`, and change the release note suffix to `macOS Apple 公证、装订及 Gatekeeper 验证。`.

- [ ] **Step 4: Run the workflow-policy test and capture GREEN**

Run:

```bash
node --test scripts/internal-beta/workflow-policy.test.mjs
```

Expected: PASS on macOS with the existing Windows-only PowerShell AST test skipped; production Authenticode assertions remain PASS.

- [ ] **Step 5: Commit the workflow slice**

```bash
git add .github/workflows/internal-beta.yml scripts/internal-beta/workflow-policy.test.mjs
git commit -m "release: restore unsigned Windows internal beta packaging"
```

### Task 2: Restore the unsigned Internal Beta manifest contract

**Files:**
- Modify: `scripts/internal-beta/manifest.test.mjs`
- Modify: `scripts/internal-beta/verify-live-evidence.test.mjs`
- Modify: `scripts/internal-beta/manifest.mjs`

- [ ] **Step 1: Write the focused failing manifest expectations**

Remove `windowsEvidence` from the fixture options and supply-chain fixture. Delete the Authenticode-evidence mutation tests, then assert the temporary contract directly:

```js
assert.equal(
  INTERNAL_BETA_SIGNING_STATUS,
  "macos_developer_id_notarized_windows_unsigned",
);
assert.equal(document.signingStatus, INTERNAL_BETA_SIGNING_STATUS);
assert.equal(Object.hasOwn(document.supplyChain, "windowsEvidence"), false);
```

Keep the Windows setup/portable artifact fixtures and Runtime Seed Windows target so unsigned packages remain byte- and Seed-bound.

- [ ] **Step 2: Run the manifest tests and capture RED**

Run:

```bash
node --test scripts/internal-beta/manifest.test.mjs scripts/internal-beta/verify-live-evidence.test.mjs
```

Expected: FAIL because the current schema requires `windowsEvidence` and reports `windows_authenticode`.

- [ ] **Step 3: Remove Authenticode evidence only from the Internal Beta manifest**

Set the identity and supply-chain keys to the approved values:

```js
export const INTERNAL_BETA_SIGNING_STATUS =
  "macos_developer_id_notarized_windows_unsigned";

const SUPPLY_CHAIN_KEYS = [
  "macosEvidence",
  "manifestBundle",
  "oidcIssuer",
  "provenance",
  "provenanceBundle",
  "sbom",
  "signerIdentity",
];
```

Delete the Internal Beta-only certificate thumbprint pattern, Windows evidence key lists, `validateWindowsEvidence`, supply-file validation, file hashing, document field, CLI option, and build-time read. Do not change `INTERNAL_BETA_ARTIFACTS`, the Windows Runtime Seed target, `scripts/release/verify-windows.ps1`, or production candidate validation.

- [ ] **Step 4: Run the manifest tests and capture GREEN**

Run:

```bash
node --test scripts/internal-beta/manifest.test.mjs scripts/internal-beta/verify-live-evidence.test.mjs
```

Expected: PASS with zero failures; both Windows artifacts and the Windows Runtime Seed target remain in the canonical manifest.

- [ ] **Step 5: Commit the manifest slice**

```bash
git add scripts/internal-beta/manifest.mjs scripts/internal-beta/manifest.test.mjs scripts/internal-beta/verify-live-evidence.test.mjs
git commit -m "release: record unsigned Windows internal beta evidence"
```

### Task 3: Align runbooks and LAT without weakening production

**Files:**
- Modify: `docs/runbooks/internal-beta-live-smoke.md`
- Modify: `docs/runbooks/internal-beta-packaging.md`
- Modify: `lat.md/agentera-post-official-delivery.md`
- Modify: `lat.md/desktop-updates.md`
- Existing: `docs/superpowers/specs/2026-08-04-internal-beta-23-unsigned-windows-exception-design.md`

- [ ] **Step 1: Update Internal Beta statements**

Document these exact boundaries:

```text
Beta.23 macOS remains Developer ID signed, notarized, stapled, and Gatekeeper accepted.
Beta.23 Internal Beta Windows setup and portable packages are intentionally unsigned.
The Windows acceptance record must expect an unknown publisher while still requiring exact hashes, x64, Runtime Seed, and signed update metadata.
The production release-candidate workflow remains Authenticode fail-closed.
```

Remove `WIN_CSC_*` and `windows-evidence.json` from the Internal Beta packaging prerequisites and candidate tree only. Keep production rollout, production device evidence, and `release-candidate.yml` Authenticode language unchanged.

- [ ] **Step 2: Run documentation checks once**

Run:

```bash
git diff --check
lat check
```

Expected: no whitespace errors; `lat check` reports `All checks passed`.

- [ ] **Step 3: Commit documentation**

```bash
git add docs/runbooks/internal-beta-live-smoke.md docs/runbooks/internal-beta-packaging.md lat.md/agentera-post-official-delivery.md lat.md/desktop-updates.md
git commit -m "docs: mark Beta.23 Windows internal beta unsigned"
```

### Task 4: Freeze one reviewable PR and use one CI per layer

**Files:**
- Verify only the files committed in Tasks 1–3 and the approved design/plan documents.

- [ ] **Step 1: Run the remaining final-SHA local checks once**

Do not repeat the already-green focused Node tests on unchanged content. Run only checks not yet recorded for the final tree:

```bash
npx eslint scripts/internal-beta/manifest.mjs scripts/internal-beta/manifest.test.mjs scripts/internal-beta/verify-live-evidence.test.mjs scripts/internal-beta/workflow-policy.test.mjs
npx prettier --check scripts/internal-beta/manifest.mjs scripts/internal-beta/manifest.test.mjs scripts/internal-beta/verify-live-evidence.test.mjs scripts/internal-beta/workflow-policy.test.mjs
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: ESLint and Prettier exit 0, diff check is empty, and the worktree is clean and ahead only by this task's commits.

- [ ] **Step 2: Check main drift once**

```bash
git fetch origin main
git log --oneline HEAD..origin/main
```

Expected: no output. If main moved, rebase once and run only conflict-affected policy/manifest/LAT checks.

- [ ] **Step 3: Push and create the single PR**

```bash
git push -u origin release/internal-beta-unsigned-windows
gh pr create --base main --head release/internal-beta-unsigned-windows \
  --title "release: allow unsigned Windows Beta.23 packages" \
  --body-file - <<'EOF'
## Summary
- restore Beta.21-style unsigned Windows x64 packaging only for Beta.23 Internal Beta
- keep macOS Developer ID signing/notarization and all update-byte/Runtime Seed checks
- keep the production candidate Authenticode gate unchanged

## Verification
- focused workflow-policy, manifest, and live-evidence tests
- focused ESLint, Prettier, diff, and LAT checks

## Release boundary
Windows is intentionally unsigned and may show unknown-publisher or SmartScreen warnings. Candidate run 30883414444 remains isolated and cannot be promoted or reused.
EOF
```

- [ ] **Step 4: Accept one exact-head and one merged-main CI**

Wait for the automatically created exact-head run. Do not rerun it. If successful, merge the unchanged head once, record the merge SHA, and wait for that SHA's single automatically created merged-main run. After success, remove the temporary worktree and retire local/remote branches.

### Task 5: Build a new isolated Beta.23 candidate

**Files:**
- No source edits after the final merged-main SHA.

- [ ] **Step 1: Resolve the exact successful main evidence**

```bash
AERA_BETA23_SOURCE_SHA=$(gh api repos/Ablankpaper/aera/commits/main --jq .sha)
AERA_BETA23_CI_RUN_ID=$(gh run list --workflow ci.yml --branch main --event push --limit 20 \
  --json databaseId,headSha,status,conclusion \
  --jq ".[] | select(.headSha == \"$AERA_BETA23_SOURCE_SHA\" and .status == \"completed\" and .conclusion == \"success\") | .databaseId" | head -n 1)
test -n "$AERA_BETA23_SOURCE_SHA"
test -n "$AERA_BETA23_CI_RUN_ID"
```

Expected: one final main SHA and its successful merged-main CI run ID.

- [ ] **Step 2: Dispatch exactly one new candidate**

```bash
gh workflow run internal-beta.yml \
  -f source_sha="$AERA_BETA23_SOURCE_SHA" \
  -f ci_run_id="$AERA_BETA23_CI_RUN_ID"
```

Do not rerun candidate `30883414444`; do not promote it. Wait on the newly created run only. The expected jobs are strict macOS signing/notarization, explicitly unsigned Windows x64 packaging, and immutable candidate assembly without publication credentials.

- [ ] **Step 3: Record the candidate boundary**

Require Accepted Apple submissions, stapling, codesign, Gatekeeper, exact macOS/Windows hashes, signed update metadata, Cosign bundles, Runtime Seed `.1`, and manifest status `macos_developer_id_notarized_windows_unsigned`. Record that Windows Authenticode is intentionally absent and that candidate completion is not online promotion or real-device acceptance.
