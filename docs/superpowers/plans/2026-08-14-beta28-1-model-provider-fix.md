# Beta.28.1 Model Provider Identity and Deletion Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make custom Provider edits preserve one stable identity across name/Base URL/API-key changes, make deletion agree with the active-route identity, make manual model discovery fallback text accurate, scope discovery caches to the current credential, and restore compatible Windows Runtime Seed extraction for Beta.28.1.

**Architecture:** Use the existing immutable `CustomProviderRecord.id` as the mutation identity and persist that id on named custom model-library attachments. A coordinated upsert migrates the existing provider record, credential anchor, model rows, and native Runtime route in one journaled operation; legacy rows without the id are matched only by their old name/endpoint during migration. Named active routes are compared by normalized name, while endpoint fallback remains only for legacy bare `custom` routes. Model discovery resolves the effective credential before cache lookup and keys both model and context caches by provider, endpoint, and a domain-separated SHA-256 credential fingerprint; raw keys are never stored in or emitted by the cache. Runtime Seed ZIPs use a dedicated two-pass `yauzl` path that validates signed inventory before writing, validates destinations again during streaming extraction, and re-hashes the final tree; Desktop update ZIPs keep Electron's hardened extractor.

**Tech Stack:** Electron 41.10.5, Node 24, Electron/Vite, React/TypeScript, Vitest, YAML config writer, coordinated Main-process model configuration runtime, `yauzl` 3.4.

---

### Task 1: Add failing identity-migration and deletion tests

**Files:**

- Modify: `src/main/providers-store.test.ts`
- Modify: `src/main/models.provider-removal.test.ts`
- Modify: `src/main/model-configuration-runtime.test.ts`
- Modify: `tests/native-custom-provider-routing.test.ts`
- Modify: `src/renderer/src/screens/Providers/ModelCenter.test.tsx`

- [x] **Step 1: Write a failing provider rename test** asserting that an existing provider record id is preserved when its display name and Base URL change, while the old name anchor is no longer listed.
- [x] **Step 2: Write a failing model attachment migration test** asserting that rows owned by the provider id move to the new name and endpoint without duplicate model rows, and that legacy rows are migrated by the old label/endpoint fallback.
- [x] **Step 3: Write a failing coordinated-runtime test** asserting that a rename copies the old credential to the new `CUSTOM_PROVIDER_*` key, clears the old key, updates one native provider entry, and leaves one active route.
- [x] **Step 4: Write a failing deletion test** for two named providers sharing a Base URL; deleting the inactive one must commit without requiring a replacement for the other named route.
- [x] **Step 5: Write a failing Renderer test** covering edit-name save followed by delete, and assert that the mutation carries the stable provider id.
- [x] **Step 6: Run the focused tests and confirm they fail for the intended identity/deletion reasons.**

Run: `npx vitest run src/main/providers-store.test.ts src/main/models.provider-removal.test.ts src/main/model-configuration-runtime.test.ts tests/native-custom-provider-routing.test.ts src/renderer/src/screens/Providers/ModelCenter.test.tsx`

Expected: New tests fail because the upsert request does not carry a Provider id, model rows have no owner id, and active deletion still falls back to endpoint equality for named routes.

### Task 2: Implement stable Provider identity and atomic migration

**Files:**

- Modify: `src/shared/custom-providers.ts`
- Modify: `src/shared/model-configuration.ts`
- Modify: `src/main/providers-store.ts`
- Modify: `src/main/models.ts`
- Modify: `src/main/model-configuration-runtime.ts`
- Modify: `src/main/native-custom-provider.ts`
- Modify: `src/main/agentera-agent-control/runtime-model-routes.ts`
- Modify: `src/renderer/src/screens/Providers/ModelCenter.tsx`

- [x] **Step 1: Add optional `providerId` to the coordinated upsert request and `providerId` to named model-library rows, retaining legacy compatibility for rows that lack it.**
- [x] **Step 2: Extend `upsertCustomProvider` to update by stable id, reject a conflicting name anchor, and preserve the existing id/createdAt through a true rename.**
- [x] **Step 3: Add model-row migration/update helpers that assign the stable provider id, move the old endpoint to the new endpoint, update the provider label, and deduplicate by provider id + model + endpoint + API mode.**
- [x] **Step 4: In the coordinated Main mutation, resolve the existing record by `providerId`, migrate the old credential to the new key, migrate model rows before adding the submitted catalog, update native Runtime identity, and clear the old key only after the new key is staged.**
- [x] **Step 5: Make Runtime route resolution and model removal prefer `providerId`, with the existing label/endpoint fallback only for legacy rows.**
- [x] **Step 6: Change active-provider detection so a named `custom:<name>` route matches only the same normalized name; retain endpoint fallback only when the active route is bare `custom`.**
- [x] **Step 7: Pass the edited custom provider record id from Model Center into the coordinated upsert and into non-coordinated model writes.**
- [x] **Step 8: Run the focused tests and confirm all new identity/deletion tests pass.**

### Task 3: Correct manual discovery fallback messaging

**Files:**

- Modify: `src/shared/i18n/locales/zh-CN/providers.ts`
- Modify: `src/shared/i18n/locales/en/providers.ts`
- Modify: `src/renderer/src/screens/Providers/ModelCenter.test.tsx`
- Modify: `src/main/model-discovery.ts`
- Modify: `tests/model-discovery.test.ts`

- [x] **Step 1: Add a failing UI assertion that an empty/manual discovery result warns that no catalog was detected and asks the user to verify Base URL or enter a model id, without claiming the service definitively does not support discovery.**
- [x] **Step 2: Update the Chinese and English strings while preserving manual-save behavior.**
- [x] **Step 3: Run the Renderer test and confirm it passes.**
- [x] **Step 4: Add failing loopback tests proving that changing the API key for the same provider and endpoint must re-fetch both the model catalog and advertised context windows, while an unchanged key still hits the cache.**
- [x] **Step 5: Resolve the effective override/env key before cache lookup and scope both caches with a domain-separated SHA-256 credential fingerprint without storing or logging the raw key.**
- [x] **Step 6: Re-run the discovery and Provider-focused tests and confirm the new cache tests and existing identity/deletion behavior pass.**

### Task 4: Restore compatible and safe Windows Runtime Seed extraction

**Files:**

- Modify: `src/main/agentera-runtime-distribution/extractor.ts`
- Modify: `src/main/app/internal-beta-updater.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Add: `tests/secure-zip-extractor.test.ts`
- Modify: `lat.md/agentera-runtime-distribution.md`
- Modify: `lat.md/desktop-updates.md`

- [x] **Step 1: Record the Beta.28 Windows failure at the 40% `Extracting the verified local Runtime` boundary without claiming the unsupported Electron 39/old-Node hypothesis.**
- [x] **Step 2: Keep Electron's hardened extractor for Desktop update ZIPs, remove the vulnerable legacy `extract-zip@2.0.1` production dependency, and route Runtime Seed ZIPs through a dedicated two-pass `yauzl` implementation.**
- [x] **Step 3: Preserve signed manifest, path, case-folded duplicate, entry type, symlink target, size-budget, cleanup, and post-extraction hash validation.**
- [x] **Step 4: Run focused Runtime/ZIP tests and extract the exact 99 MB Windows Runtime Seed through the final implementation.**
- [ ] **Step 5: Verify the exact source on Windows CI and require the packaged Windows Seed installation gate before promotion.**

### Task 5: Verify, version, and publish Beta.28.1

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: release/version metadata required by the checked-in Beta workflow

- [x] **Step 1: Run focused tests, then the full unit/typecheck/build/audit gates.**
- [x] **Step 2: Run an isolated Electron journey covering: edit name + URL, manual model fallback save, duplicate-card absence, delete of the renamed provider, and active-route protection.**
- [x] **Step 3: Bump version to `0.7.4-internal-beta.28.1`, commit the tested changes, push the Beta.28.1 source branch, and merge/update the release source according to the checked-in workflow policy.**
- [ ] **Step 4: Dispatch the exact Beta candidate workflow and verify its source SHA, CI run, Runtime Seed, signed macOS app, notarization, and Windows package.**
- [ ] **Step 5: Run the final DMG App UI launch check, then Promote only the `internal-beta` channel for Beta.28.1.**
- [ ] **Step 6: Download the live manifest/signature and both published installers through the local proxy, verify byte checksums/range probes, and confirm no formal production Release was created.**

### Task 6: Reissue the unpublished maintenance candidate as Beta.29

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/internal-beta.yml`
- Modify: `.github/workflows/internal-beta-promote.yml`
- Modify: `scripts/internal-beta/manifest.mjs`
- Modify: Internal Beta release-contract tests and `lat.md/desktop-updates.md`

- [x] **Step 1: Record the failed Beta.28.1 promotion evidence.** Candidate identity, checksums, and update signature passed, but the server rejected the maintenance-version archive path before publication; the live channel remained Beta.28.
- [x] **Step 2: Change the immutable release identity to `0.7.4-internal-beta.29` without changing the already verified Provider or Runtime implementation.**
- [x] **Step 3: Run the focused release-contract tests, `lat check`, and the changed-boundary local checks, then assemble the exact Beta.29 source commit.**
- [ ] **Step 4: Push and fast-forward `main`, then run one exact-SHA three-platform CI and one immutable Beta.29 candidate build.**
- [ ] **Step 5: Verify the exact packaged macOS candidate at the version/package boundary, then promote the recorded Beta.29 candidate once.**
- [ ] **Step 6: Verify the live signed manifest and both versioned package range probes, and confirm no Git tag or GitHub Release was created.**
