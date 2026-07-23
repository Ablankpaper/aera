# Aera Internal Beta Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an installable internal Beta for trusted company testers on Apple Silicon macOS and Windows 11 x64, backed by the authorized ECS host, with direct registration, Desktop login, Agent use, quality consent, encrypted backup, and cross-device restore.

**Architecture:** Cloud is the only Internet-facing application and is published through a publicly trusted HTTPS certificate for the temporary IP. Admin, PostgreSQL, Redis, MinIO, and the Cloud Internal Admin listener stay private. Cloud and Admin deploy exact Cosign-signed GHCR digests. Desktop packages bake in the exact HTTPS issuer and its reviewed offline-entitlement public key, package the unchanged locked Runtime Seed, and emit a keyless-signed internal-Beta manifest without creating a tag or GitHub Release.

**Tech Stack:** Go 1.25, React/Vite, Electron 39, TypeScript/Vitest/Playwright, GitHub Actions, GHCR, Docker Compose, Caddy, Certbot 5.4+, PostgreSQL 17, Redis 7.4, MinIO, Ed25519, mTLS, service JWT, Cosign 2.5.3/Sigstore, Syft/SPDX, Bash, PowerShell.

## Global Constraints

- Begin from the exact remote checkpoints in the approved design: Desktop `47e1ef0b8eb4d5395f7dd26217422438a4dae949`, Cloud `7b0337d64e50bbcbfb7c0d20981bdf140a8ecba6`, Admin `edbf6f790518d1e2d22db57c7583f6fe92c6f813`, and unchanged Runtime `c0439e1e3e5f35a91b658d57ddfc011e0d5ba1bb`.
- Keep designed, implemented, local verification, push, pull request, merge, remote CI, candidate creation, deployment, package creation, and live acceptance as distinct evidence states.
- Do not modify `/Users/zizimutou/Desktop/aera/aera-runtime`.
- Do not commit or print the ECS address, SSH password, GHCR token, user login identifier, recovery phrase, signing private key, mTLS private key, database password, Redis password, TOTP seed, or session token.
- Treat the password previously posted in chat as exposed. Replace it after SSH-key access works and disable SSH password authentication.
- The only public listener is Cloud through ports 80/443. Admin is reached through an SSH tunnel. Databases, Redis, MinIO, Docker, and Cloud Internal Admin never receive public host ports.
- Internal Beta has no account-count cap, invitation code, application IP allowlist, or VPN requirement. Existing password/login controls plus a bounded direct-registration request rate limit, audit, device, and authorization rules remain enabled.
- SMTP and SMS are deferred. Direct registration accepts an email-shaped login identifier without claiming mailbox ownership, stores it as unverified, and is allowed only by an explicit `internal_beta` flag. Production always rejects this mode.
- Verification-dependent password reset, identity binding, deletion recovery, and similar account-center actions stay unavailable and are hidden while direct registration is active.
- Cloud/Admin candidate verification must bind the expected GitHub OIDC issuer and exact workflow identity. GitHub private-repository artifact attestations are not used.
- Unsigned/ad-hoc Desktop packages are labelled internal-only. They do not satisfy Apple notarization, Windows Authenticode, production device-matrix, updater, or public-release gates.
- Cloud deploys before Admin. Application rollback changes only to a recorded compatible image digest and never runs a down migration.
- A closed ECS security-group port, unavailable GHCR read credential, absent Windows test device, or absent tester action is an explicit external gate. It must not be replaced with fake success.
- After every Desktop task, update `lat.md/` when behavior changes and run `npm exec --yes --package=lat.md@0.12.1 -- lat check`.

## External Inputs Kept Outside Git

The operator keeps these values in a mode-`0600` file under a local external evidence directory and in the mode-`0700` host secret root:

- `AERA_INTERNAL_BETA_HOST`: SSH host alias, not a literal address in source files.
- `AERA_INTERNAL_BETA_ORIGIN`: exact `https://` origin for the temporary IP.
- `AERA_ACME_CONTACT_EMAIL`: ACME expiry contact.
- `GHCR_READ_TOKEN`: least-privilege credential able to pull the two private GHCR packages.
- Two Admin bootstrap identities, used only if Admin activation is completed during this delivery.
- One macOS tester and one Windows tester/device for the final physical-device steps.

SMTP and SMS values are intentionally absent in this delivery. Do not configure repository placeholder providers or expose a verification code through logs or Admin.

## Worktree Layout

- Desktop coordinator and implementation: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery`
- Cloud implementation: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery`
- Admin implementation: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery`
- Runtime read-only source: `/Users/zizimutou/Desktop/aera/aera-runtime`
- External local operator state: `/Users/zizimutou/Desktop/aera/.internal-beta-operator`
- Host application root: `/opt/aera/internal-beta`

---

### Task 1: Establish exact isolated implementation worktrees

**Produces:** Three clean same-feature worktrees with immutable baseline evidence.

**Files:**

- Existing: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/docs/superpowers/specs/2026-07-24-aera-internal-beta-delivery-design.md`
- Existing: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/docs/superpowers/plans/2026-07-24-aera-internal-beta-delivery.md`
- Create outside Git: `/Users/zizimutou/Desktop/aera/.internal-beta-operator/baseline.json`

- [x] Run `git -C /Users/zizimutou/Desktop/aera/aera fetch origin main`, `git -C /Users/zizimutou/Desktop/aera/aera-cloud fetch origin main`, and `git -C /Users/zizimutou/Desktop/aera/aera-admin fetch origin main`.
- [x] Assert the three `origin/main` SHAs equal the approved Desktop, Cloud, and Admin checkpoints. If any differs, inspect ancestry and stop rather than silently rebasing the approved start.
- [x] Create Cloud worktree with `git -C /Users/zizimutou/Desktop/aera/aera-cloud worktree add /Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery -b aera/internal-beta-delivery origin/main`.
- [x] Create Admin worktree with `git -C /Users/zizimutou/Desktop/aera/aera-admin worktree add /Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery -b aera/internal-beta-delivery origin/main`.
- [x] Assert Desktop is on `aera/internal-beta-delivery`, contains only the approved spec/plan commits ahead of `origin/main`, and has no unrelated uncommitted change.
- [x] Assert `git -C /Users/zizimutou/Desktop/aera/aera-runtime rev-parse HEAD` is `c0439e1e3e5f35a91b658d57ddfc011e0d5ba1bb` and `git status --porcelain=v1` is empty.
- [x] Create `/Users/zizimutou/Desktop/aera/.internal-beta-operator` with mode `0700`; write only repository names, baseline SHAs, and UTC timestamps to `baseline.json`.
- [x] Run Desktop focused baseline `npx vitest run tests/agentera-auth-config.test.ts tests/agentera-auth-controller.test.ts tests/runtime-packaging-scripts.test.ts`.
- [x] Run Cloud baseline `go test ./internal/config ./internal/httpapi ./internal/notification ./internal/verification ./cmd/aera-cloud`.
- [x] Run Admin baseline `go test ./internal/config ./cmd/aera-admin ./cmd/aera-admin-bootstrap`.
- [x] Record command, exit status, and exact SHA in the external baseline document. Do not commit generated logs.

### Task 2: Add a fail-closed Cloud `internal_beta` environment

**Produces:** A named deployment mode that requires remote HTTPS, explicit public and direct registration, strong application keys, and no fake provider configuration.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/config/internal_beta.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/config/internal_beta_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/config/config.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/config/config_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/config/public_registration.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/config/public_registration_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/config/registration_mode.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/config/registration_mode_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/config/encrypted_backup.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/config/encrypted_backup_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/.env.example`

- [x] Add tests that accept exactly `development`, `test`, `internal_beta`, and `production`, while rejecting all other environment strings.
- [x] Add tests that require an explicit `AGENTERA_CLOUD_PUBLIC_REGISTRATION_ENABLED=true` in `internal_beta`; omission must default to disabled.
- [x] Add tests that accept `AGENTERA_CLOUD_REGISTRATION_MODE=verified|direct`, require an explicit direct mode in `internal_beta`, and reject direct mode in every other environment.
- [x] Add tests that let direct mode omit SMTP/SMS configuration while verified mode retains existing provider requirements.
- [x] Add tests for bounded `AGENTERA_CLOUD_DIRECT_REGISTRATION_IP_LIMIT` and `AGENTERA_CLOUD_DIRECT_REGISTRATION_WINDOW`; require them only in direct mode.
- [x] Add tests that require an HTTPS public origin for a remote `internal_beta` host and still reject path, query, fragment, credentials, or remote HTTP.
- [x] Add tests that allow plaintext MinIO only for an unexposed service-network endpoint in `internal_beta`, while production continues to require TLS for non-loopback object storage.
- [x] Run `go test ./internal/config -run 'InternalBeta|PublicRegistration|RegistrationMode|EncryptedBackup' -count=1`; expect RED failures.
- [x] Implement `IsInternalBeta` and `IsDeployedEnvironment` helpers and use them instead of scattered string comparisons.
- [x] Change public-registration defaulting so both `internal_beta` and `production` default closed.
- [x] Keep secure browser cookies enabled whenever the public origin is HTTPS.
- [x] Document `AGENTERA_CLOUD_ENVIRONMENT=internal_beta`, explicit public registration, and explicit direct-registration mode in `.env.example` without adding a real host or secret.
- [x] Rerun the focused config tests; expect pass.
- [x] Run `gofmt -w internal/config` and `go test ./internal/config -count=1`.
- [x] Commit: `git add internal/config .env.example && git commit -m "feat: add fail-closed internal beta mode"`.

### Task 3: Add isolated direct registration and accurate capabilities

**Produces:** Unverified direct internal-Beta registration with no SMTP/SMS dependency, a public non-secret capability document, and no simulated identity verification.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/migrations/000019_internal_beta_direct_registration.sql`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/store/migrate_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/account/model.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/account/service.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/account/service_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/account/repository.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/account/repository_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/account/http.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/account/http_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/account/direct_registration_limiter.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/account/direct_registration_limiter_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/httpapi/public_config.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/httpapi/public_config_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/httpapi/server.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/internal/httpapi/server_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/cmd/aera-cloud/main.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/cmd/aera-cloud/main_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/web/src/api/client.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/web/src/pages/RegisterPage.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/web/src/pages/RegisterPage.test.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/web/src/pages/LoginPage.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/web/src/pages/LoginPage.test.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/web/src/pages/AccountPage.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/web/src/pages/DeleteAccountPage.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/web/src/pages/ForgotPasswordPage.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/web/src/public-config.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/web/src/public-config.test.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/web/src/main.tsx`

- [x] Add account-service and repository tests proving direct registration normalizes an email-shaped identifier, stores `verified_at` as `NULL`, preserves unique-identity locking, never consumes a verification receipt, and is impossible unless injected explicitly by deployed configuration.
- [x] Add migration tests proving only `identities.verified_at` nullability changes and migration 19 remains forward-only and idempotently recorded.
- [x] Add HTTP tests proving direct mode requires the raw `identity`, rejects a supplied receipt/phone/malformed identity, applies the normal body limit, and returns the existing bounded error family.
- [x] Add limiter tests proving direct registrations are bounded per remote IP, Redis errors fail closed, and no raw IP or identity is stored.
- [x] Add tests proving verified registration remains byte-for-byte compatible and production service construction never enables direct mode.
- [x] Add public-config handler tests for exact JSON keys: `environment`, `public_registration_enabled`, `registration_mode`, `registration_identity_kinds`, and `identity_verification_available`; reject non-GET methods and set `Cache-Control: no-store`.
- [x] Add RegisterPage tests proving direct mode renders no phone/code/verification controls, submits the normalized login identifier, labels it unverified, and cannot submit before both legal and capability requests succeed.
- [x] Add LoginPage/router tests proving password reset, identity binding, and deletion-recovery entry points are hidden or unavailable when verification capability is false.
- [x] Run `go test ./internal/config ./internal/store ./internal/account ./internal/httpapi ./cmd/aera-cloud -count=1` and `npm --prefix web test -- --run src/public-config.test.tsx src/pages/RegisterPage.test.tsx src/pages/LoginPage.test.tsx`; expect RED.
- [x] Implement a separate direct-registration record path and Redis-backed request limiter; never fabricate a verification challenge/receipt or populate `verified_at`.
- [x] Make SMTP/SMS verification handler construction optional only when direct `internal_beta` mode is active; disabled verification endpoints return a bounded unavailable response.
- [x] Mount `GET /api/v1/public/config` before the SPA fallback and include only non-secret capability values.
- [x] Load legal and public configuration together in RegisterPage, render only the email-shaped internal-Beta login identifier, and explain that mailbox recovery is unavailable.
- [x] Keep registration and login rate limits fail closed and do not print identities, passwords, or verification material.
- [x] Rerun focused Go/Web tests, Web typecheck, and Web build; expect pass.
- [x] Run `gofmt -w internal cmd/aera-cloud` and Prettier only on changed Web files.
- [x] Commit: `git add internal cmd/aera-cloud web .env.example migrations && git commit -m "feat: add isolated internal beta registration"`.

### Task 4: Add a hardened Admin `internal_beta` loopback mode

**Produces:** Admin can run privately over an SSH tunnel with production-strength Redis/key requirements and mutations disabled by default.

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/internal/config/config.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/internal/config/config_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/.env.example`

- [x] Add tests that accept `internal_beta`, require dedicated Redis username/password and non-zero DB, default mutations to false, and allow only loopback HTTP for `AERA_ADMIN_PUBLIC_URL`.
- [x] Add tests that reject a remote HTTP Admin public URL, an empty Redis password, DB 0, or implicit mutation enablement.
- [x] Run `go test ./internal/config -run InternalBeta -count=1`; expect RED.
- [x] Implement deployed-security helpers so `internal_beta` gets production Redis/key checks while retaining loopback-only HTTP and an empty trusted-proxy set.
- [x] Update `.env.example` comments without adding real identities or secrets.
- [x] Run `gofmt -w internal/config` and `go test ./internal/config -count=1`; expect pass.
- [x] Commit: `git add internal/config .env.example && git commit -m "feat: harden admin internal beta mode"`.

### Task 5: Replace unavailable private-repository attestations in Cloud

**Produces:** A successful Cloud candidate workflow with keyless image signature, SLSA v1 in-toto attestation, signed canonical manifest, SPDX SBOM, and deploy-time identity verification.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/scripts/release/build-provenance.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/scripts/tests/provenance.test.sh`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/.github/workflows/candidate.yml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/scripts/release/verify-manifest.sh`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/scripts/tests/release-manifest.test.sh`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/scripts/tests/delivery-contract.test.sh`

- [x] Write provenance tests requiring canonical SLSA v1 predicate fields for exact repository, source SHA, workflow path, workflow ref, run URL, builder identity, and immutable image digest.
- [x] Extend manifest tests to reject a missing/tampered `manifest.sigstore.json`, absent SLSA attestation, wrong certificate identity, wrong OIDC issuer, or mismatched provenance digest.
- [x] Change delivery-contract expectations to require `cosign attest --type slsaprovenance1` and forbid `actions/attest-build-provenance`.
- [x] Run the three shell suites; expect RED.
- [x] Implement canonical provenance predicate generation with no secret/environment dump.
- [x] In candidate workflow, generate the predicate, run `cosign sign --yes IMAGE@DIGEST`, and run `cosign attest --yes --type slsaprovenance1 --predicate provenance.json IMAGE@DIGEST`.
- [x] Build the candidate manifest, sign it with `cosign sign-blob --yes --bundle manifest.sigstore.json manifest.json`, then run manifest verification after the bundle exists.
- [x] Verify image, SLSA v1 attestation, manifest bundle, source SHA, workflow identity, issuer, and local SBOM/provenance digests.
- [x] Remove `attestations: write`; retain `id-token: write`, `contents: read`, `actions: read`, and `packages: write`.
- [x] Run shell suites, `go test ./...`, `go vet ./...`, Web test/typecheck/build, and secret scan.
- [x] Commit: `git add .github/workflows/candidate.yml scripts/release scripts/tests && git commit -m "ci: attest private cloud candidates with sigstore"`.

### Task 6: Replace unavailable private-repository attestations in Admin

**Produces:** The equivalent successful Admin candidate chain, pinned to the exact compatible Cloud contract.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/scripts/release/build-provenance.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/scripts/tests/provenance.test.sh`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/.github/workflows/candidate.yml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/scripts/release/verify-manifest.sh`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/scripts/tests/release-manifest.test.sh`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/scripts/tests/ci-contract.test.sh`

- [ ] Add the same SLSA v1, manifest-bundle, OIDC issuer, and workflow-identity failure tests, plus exact `cloudSha` and Cloud migration/API compatibility checks.
- [ ] Run `bash scripts/tests/provenance.test.sh`, `bash scripts/tests/release-manifest.test.sh`, and `bash scripts/tests/ci-contract.test.sh`; expect RED.
- [ ] Implement the Admin provenance predicate and keyless image/attestation/manifest signing path.
- [ ] Remove the GitHub artifact-attestation action and permission.
- [ ] Verify the signed candidate locally through fake-Cosign tests and retain the real verification in deployment scripts.
- [ ] Run `make verify` and `AERA_ADMIN_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery make e2e`.
- [ ] Commit: `git add .github/workflows/candidate.yml scripts/release scripts/tests && git commit -m "ci: attest private admin candidates with sigstore"`.

### Task 7: Add build-time Desktop Beta trust roots

**Produces:** Desktop accepts only the exact baked Beta issuer/key pair and continues to reject runtime-injected trust.

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/src/main/env.d.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/src/main/agentera-auth/config.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/tests/agentera-auth-config.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/tests/agentera-auth-controller.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/lat.md/agentera-app-authentication.md`

- [ ] Add tests for a build-time `MAIN_VITE_AGENTERA_OFFLINE_PUBLIC_KEYS_JSON` containing one canonical HTTPS IP issuer, Ed25519 public key, and stable key ID.
- [ ] Add rejection tests for malformed JSON, unknown fields, duplicate key IDs, remote HTTP, issuer paths, noncanonical base64url, wrong key length, and a configured issuer that differs from the Cloud origin.
- [ ] Add a test proving `process.env.MAIN_VITE_AGENTERA_OFFLINE_PUBLIC_KEYS_JSON` cannot add trust to a packaged build.
- [ ] Add controller coverage proving online tokens are not persisted when the returned offline entitlement has a wrong issuer, key ID, signature, device binding, installation binding, or expiry.
- [ ] Run `npx vitest run tests/agentera-auth-config.test.ts tests/agentera-auth-controller.test.ts`; expect RED.
- [ ] Parse only the Vite-baked value, merge it with the loopback development root, freeze the result, and select keys only by exact canonical issuer.
- [ ] Keep `MAIN_VITE_AGENTERA_CLOUD_PUBLIC_URL` as the build-time origin and require the workflow to prove its equality with the sole Beta issuer.
- [ ] Update authentication Lat sections and their test references.
- [ ] Run focused tests, Node typecheck, and `npm exec --yes --package=lat.md@0.12.1 -- lat check`; expect pass.
- [ ] Commit: `git add src/main tests lat.md/agentera-app-authentication.md && git commit -m "feat: bind desktop beta to reviewed issuer keys"`.

### Task 8: Build an unsigned internal-Beta Desktop candidate workflow

**Produces:** macOS arm64 DMG/ZIP and Windows x64 setup/portable packages with immutable checksums, Runtime Seed proof, SPDX SBOM, SLSA-style provenance, and keyless-signed Beta manifest.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/.github/workflows/internal-beta.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/build/electron-builder.internal-beta.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/scripts/internal-beta/manifest.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/scripts/internal-beta/manifest.test.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/scripts/internal-beta/workflow-policy.test.mjs`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/package.json`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/package-lock.json`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/docs/runbooks/internal-beta-packaging.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/lat.md/agentera-post-official-delivery.md`

- [ ] Add manifest tests requiring exact source SHA, successful CI run URL, version `0.7.4-internal-beta.1`, HTTPS IP origin, offline key ID/public key, Runtime lock SHA, both Runtime platform identities, four package hashes, SBOM/provenance hashes, and `signingStatus=internal_only_unsigned`.
- [ ] Add failure tests for mutable filenames, duplicate artifacts, missing platform, wrong Runtime commit/channel, mismatched origin/trust issuer, noncanonical JSON, changed bytes, or unknown fields.
- [ ] Add workflow-policy tests that forbid tags, Releases, updater publication, Apple/Windows signing claims, GitHub artifact-attestation actions, and runtime source checkout.
- [ ] Run `node --test scripts/internal-beta/*.test.mjs`; expect RED.
- [ ] Set package/lock version to `0.7.4-internal-beta.1`.
- [ ] Add an Electron Builder overlay that disables code-sign discovery/notarization, retains hardened runtime settings where applicable, publishes never, and produces deterministically named internal-Beta artifacts.
- [ ] Implement `internal-beta.yml` with exact `source_sha` and `ci_run_id` inputs plus protected `internal-beta` environment variables for origin, key ID, and public key.
- [ ] On macOS arm64 and Windows x64 jobs: `npm ci`, prepare the locked Runtime Seed, verify it, rebuild native modules for the target architecture, inject origin/trust values, build, package unsigned bytes, and stage the Runtime manifest.
- [ ] On the assembly job: verify the exact CI belongs to the source SHA, build SBOM/provenance/manifest/checksums, keyless-sign the manifest and provenance with Cosign bundles, verify both bundles with the expected workflow identity/OIDC issuer, and upload one 30-day Actions artifact.
- [ ] Run manifest/policy tests, Runtime packaging tests, typechecks, production build, and Lat validation.
- [ ] Commit: `git add .github/workflows/internal-beta.yml build/electron-builder.internal-beta.yml scripts/internal-beta package.json package-lock.json docs/runbooks/internal-beta-packaging.md lat.md && git commit -m "ci: build internal beta desktop packages"`.

### Task 9: Add the Cloud internal-Beta deployment stack

**Produces:** A one-host Cloud stack with private PostgreSQL/Redis/MinIO/Internal Admin and loopback application ingress for the HTTPS proxy.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/deploy/compose.internal-beta.yaml`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/deploy/internal-beta/Caddyfile`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/deploy/internal-beta/deploy.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/deploy/internal-beta/health-smoke.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/deploy/internal-beta/exposure-check.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/scripts/tests/internal-beta-deploy.test.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/docs/runbooks/internal-beta.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery/scripts/tests/delivery-contract.test.sh`

- [ ] Write static/fixture tests requiring exact image-by-digest input, app port bound only to `127.0.0.1`, no host ports for PostgreSQL/Redis/MinIO/Internal Admin, read-only app root, resource limits, MinIO persistence, private Admin network, and a health check.
- [ ] Add deploy-script tests with fake Docker/Cosign/curl proving manifest verification occurs before pull/start, first deployment is recorded, flags remain disabled on failed smoke, and later rollback uses only the recorded prior digest.
- [ ] Add exposure-check tests that fail if host listeners other than SSH/80/443 are public or if a container publishes data-service ports.
- [ ] Run `bash scripts/tests/internal-beta-deploy.test.sh`; expect RED.
- [ ] Implement the Compose stack using separate Cloud Postgres/Redis/MinIO volumes and the existing external `aera-cloud-admin-private` network.
- [ ] Mount Cloud Internal Admin server cert/key, client CA, and service-JWT public key read-only.
- [ ] Set `AGENTERA_CLOUD_ENVIRONMENT=internal_beta`; keep public registration, Official Agent, quality, and encrypted backup controlled by a generated feature env file.
- [ ] Implement first-deploy and update paths with exact manifest verification, schema-forward startup, health, redacted state recording, and failure rollback.
- [ ] Configure Caddy to serve `/.well-known/acme-challenge/` from `/var/lib/aera-certbot`, redirect port 80 otherwise, terminate with the Certbot IP certificate files, omit request access logs, and proxy only to `127.0.0.1:18086`.
- [ ] Run Compose config validation, shell syntax tests, delivery contract, Go tests, and secret scan.
- [ ] Commit: `git add deploy scripts/tests docs/runbooks/internal-beta.md && git commit -m "ops: add cloud internal beta stack"`.

### Task 10: Add the Admin internal-Beta deployment stack

**Produces:** Loopback-only Admin connected to the real Cloud private listener with mTLS plus scoped service JWT.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/deploy/compose.internal-beta.yaml`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/deploy/internal-beta/deploy.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/deploy/internal-beta/health-smoke.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/scripts/tests/internal-beta-deploy.test.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery/docs/runbooks/internal-beta.md`

- [ ] Write tests requiring loopback-only Admin HTTP, separate Postgres/Redis volumes and credentials, private Cloud network, read-only mTLS/JWT mounts, mutations disabled by default, and no public ports.
- [ ] Add fake-command tests proving exact manifest/Cloud compatibility/mTLS material checks run before Admin starts and any unknown Cloud state remains unavailable.
- [ ] Run `bash scripts/tests/internal-beta-deploy.test.sh`; expect RED.
- [ ] Implement Admin Compose with `AERA_ADMIN_ENVIRONMENT=internal_beta`, `AERA_ADMIN_PUBLIC_URL=http://127.0.0.1:18080`, dedicated Redis DB 10, and `AERA_ADMIN_CLOUD_BASE_URL=https://aera-cloud-internal-admin:8443`.
- [ ] Keep Admin browser access through `ssh -L 18080:127.0.0.1:18080 AERA_INTERNAL_BETA_HOST`; do not expose it through Caddy.
- [ ] Implement deploy/health scripts that verify the Admin candidate, pinned Cloud contract, key file modes, TLS 1.3 dual authentication, read-only queries, and disabled mutations before optional enablement.
- [ ] Run Compose config validation, shell tests, `make verify`, and real cross-repository E2E.
- [ ] Commit: `git add deploy scripts/tests docs/runbooks/internal-beta.md && git commit -m "ops: add admin internal beta stack"`.

### Task 11: Add host bootstrap, key ceremony, and operator tooling

**Produces:** Reproducible, secret-safe host preparation and one external operator record without putting infrastructure values in Git.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/ops/internal-beta/bootstrap-host.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/ops/internal-beta/generate-secrets.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/ops/internal-beta/install-ip-certificate.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/ops/internal-beta/render-operator-record.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/ops/internal-beta/operator-record.test.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/ops/internal-beta/shell-policy.test.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/docs/runbooks/internal-beta-host.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/lat.md/agentera-post-official-delivery.md`

- [ ] Add policy tests forbidding literal IPv4 addresses, passwords, tokens, private-key markers, unsafe broad deletes, SSH `StrictHostKeyChecking=no`, secret echoing, and password persistence in tracked files.
- [ ] Add operator-record tests allowing only exact SHAs/digests/run URLs/package hashes/statuses/timestamps/coarse platform versions and rejecting credentials, emails, codes, recovery words, prompts, content, Profile paths, and free-form logs.
- [ ] Run `node --test ops/internal-beta/*.test.mjs`; expect RED.
- [ ] Implement host bootstrap: create a non-root `aera-deploy` account, install its authorized key, verify key login, install Docker/Compose/OpenSSL/Caddy/Python venv, install Certbot 5.4+, create `/opt/aera/internal-beta` mode `0700`, configure UFW for SSH/80/443 only, and enable unattended security updates.
- [ ] Implement secret generation with independent random material for Cloud/Admin databases, Redis, key rings, HMACs, OAuth/access/offline/agent-control signing, quality pseudonyms, MinIO, backup encryption, Internal Admin CA/server/client certificates, and service JWT.
- [ ] Generate offline-entitlement key ID/public key as a separate public output; keep its private 64-byte Ed25519 material only in the Cloud env file.
- [ ] Implement IP certificate staging issuance first, then trusted issuance using Certbot `--preferred-profile shortlived --webroot --ip-address`; install an automated renew timer and Caddy reload deploy hook.
- [ ] Implement password rotation without command-line or log exposure, verify `aera-deploy` key access, then disable `PasswordAuthentication` and direct root SSH while retaining cloud-console recovery.
- [ ] Render a redacted operator record in `/Users/zizimutou/Desktop/aera/.internal-beta-operator`; never copy the host secret directory into Actions artifacts.
- [ ] Run policy tests, `bash -n` on scripts, ShellCheck when installed, focused Desktop tests, and Lat validation.
- [ ] Commit: `git add ops/internal-beta docs/runbooks/internal-beta-host.md lat.md && git commit -m "ops: automate internal beta host ceremony"`.

### Task 12: Add redacted live-acceptance evidence and tester handoff

**Produces:** A machine-validated acceptance record and concise instructions for trusted macOS/Windows testers.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/release/internal-beta-evidence.schema.json`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/scripts/internal-beta/verify-live-evidence.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/scripts/internal-beta/verify-live-evidence.test.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/docs/runbooks/internal-beta-live-smoke.md`
- Create: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/docs/runbooks/internal-beta-tester-handoff.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/docs/runbooks/release-status-template.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery/lat.md/agentera-post-official-delivery.md`

- [ ] Write evidence tests requiring exact Cloud/Admin/Desktop/Runtime identities, candidate run URLs, deployed digests, package hashes, certificate expiry, direct-registration mode, Mac/Windows platform roles, and fixed outcomes for registration/login/Agent/quality/backup/restore/rejection/restart/sign-out/uninstall.
- [ ] Add tests rejecting secrets, emails, recovery phrases, raw identifiers, prompts/responses, file paths, arbitrary notes, missing rejection scenarios, or evidence from package bytes that differ from the manifest.
- [ ] Run `node --test scripts/internal-beta/verify-live-evidence.test.mjs`; expect RED.
- [ ] Implement strict JSON-schema and semantic validation with canonical JSON enforcement.
- [ ] Document exact checksum verification plus Gatekeeper and SmartScreen internal-only override steps without claiming signatures.
- [ ] Document the live order: HTTPS/health, direct registration, Desktop OAuth/offline entitlement, Mac install, Windows install, Agent turn, quality off/on, backup interruption/resume, second-device restore, tamper/wrong-phrase/revocation failures, restart, sign-out/in, uninstall/reinstall.
- [ ] Update release status so partial execution cannot be reported as internal-Beta acceptance.
- [ ] Run validator tests, Prettier, focused release-policy tests, and Lat validation.
- [ ] Commit: `git add release scripts/internal-beta docs/runbooks lat.md && git commit -m "test: define internal beta live acceptance"`.

### Task 13: Run exhaustive local verification and integrate the three repositories

**Produces:** Reviewable commits, pull requests, merged exact SHAs, and fresh successful CI before candidate creation.

- [ ] In Cloud run secret scan, delivery/release/deploy tests, `go test -count=1 ./...`, race tests for secure/account/oauth/device/session/jobs/encrypted-backup, `go vet ./...`, Web test/typecheck/build, and PostgreSQL/Redis/MinIO integration.
- [ ] In Admin run candidate/deploy tests, `make verify`, and `AERA_ADMIN_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery make e2e`.
- [ ] In Desktop run internal-Beta/release policy tests, authentication tests, Runtime packaging/verification tests, official-quality boundary, encrypted-backup boundary, Node/Web typechecks, production build, and Lat validation.
- [ ] Review `git diff origin/main...HEAD` separately in each repository for secret material, accidental Runtime edits, unrelated files, weakened failures, and generated artifacts.
- [ ] Push each `aera/internal-beta-delivery` branch, open one scoped pull request per repository, and wait for all exact-SHA CI jobs.
- [ ] Fix only evidence-backed failures in the owning repository; rerun the failed focused gate and the repository’s complete gate.
- [ ] Merge Cloud first, Admin second, Desktop third after each PR is green. Record merge SHAs and main CI URLs separately.
- [ ] Assert all repositories remain private and Runtime HEAD/working tree are unchanged.

### Task 14: Create and verify Cloud/Admin candidates

**Produces:** Two deployable exact image digests and complete private-repository Sigstore evidence.

- [ ] Dispatch Cloud `candidate.yml` with the merged Cloud SHA and its successful main CI run ID.
- [ ] Wait for every real step to complete; download `cloud-candidate-SHA`, verify manifest bundle, image signature, SLSA v1 attestation, SBOM/provenance digests, source SHA, schema range, and workflow identity.
- [ ] Dispatch Admin `candidate.yml` with the merged Admin SHA and its successful main CI run ID.
- [ ] Download and verify `admin-candidate-SHA`, including exact compatible Cloud SHA/API/migration.
- [ ] Record candidate run URLs, image references/digests, manifest hashes, and bundle hashes in the external operator record.
- [ ] Do not reuse the partial digests from failed runs `30031326894` or `30031361564`.

### Task 15: Bootstrap and deploy the authorized ECS host

**Produces:** Healthy HTTPS Cloud, private Admin, automated short-lived IP certificate renewal, and exact deployed digests.

- [ ] Inspect the SSH host key through the cloud console/out-of-band fingerprint before adding it to `known_hosts`.
- [ ] Use the already authorized current credential once to install the temporary deployment key; never place the credential in a command string, repository, plan output, or retained log.
- [ ] Run host bootstrap and verify key-only access in a second session before rotating/disabling password authentication.
- [ ] Confirm Alibaba security-group ingress permits SSH from the operator, and ports 80/443 publicly; remove every other inbound rule not required by the host.
- [ ] Upload only reviewed Compose/Caddy/operator scripts and candidate evidence to `/opt/aera/internal-beta`; do not clone writable application repositories onto the host.
- [ ] Generate all secret material on the host and copy only the Beta issuer/key ID/public key back to the external local operator directory.
- [ ] Configure GitHub `internal-beta` environment variables `AERA_INTERNAL_BETA_ORIGIN`, `AERA_INTERNAL_BETA_OFFLINE_KEY_ID`, and `AERA_INTERNAL_BETA_OFFLINE_PUBLIC_KEY`; do not put the private key in GitHub.
- [ ] Obtain the staging IP certificate, validate Caddy challenge routing, obtain the trusted six-day certificate, and confirm the renew timer/deploy hook.
- [ ] Log in to GHCR with the least-privilege read token, deploy the exact Cloud digest with features disabled, and pass health plus exposure checks.
- [ ] Enable explicit direct registration, Official Agent, quality, and encrypted backup in the generated feature file only after Cloud health, migration, and trust-root probes pass.
- [ ] Deploy the exact Admin digest with mutations disabled, pass Cloud compatibility and mTLS/service-JWT probes, then enable only the internal-Beta Admin operations needed for observation.
- [ ] Optionally create the two one-time Super Admin bootstrap invitations; handle activation URLs/TOTP/recovery codes directly with the named administrators and never retain them in evidence.
- [ ] Reboot once, then verify Docker services, certificate timer, firewall, Cloud readiness, Admin loopback readiness, private-network dual auth, and zero public data-service ports.

### Task 16: Build and distribute exact Desktop internal-Beta packages

**Produces:** One immutable internal package set bound to the deployed issuer.

- [ ] After the Desktop merge and successful main CI, dispatch `internal-beta.yml` with exact Desktop SHA and CI run ID.
- [ ] Wait for native macOS arm64, Windows x64, and assembly jobs to complete.
- [ ] Download the artifact and verify manifest/provenance Sigstore bundles against `github.com/bignormal/aera/.github/workflows/internal-beta.yml@refs/heads/main` and `https://token.actions.githubusercontent.com`.
- [ ] Verify package SHA-256 values, Runtime Seed lock/manifest/signature for both platforms, exact Cloud origin, exact offline key ID/public key, version, SBOM, and unsigned internal-only label.
- [ ] Copy the artifact into the external operator handoff directory; retain the immutable Actions URL and checksums.
- [ ] Do not create a tag, GitHub Release, updater metadata publication, or production signing claim.

### Task 17: Execute the live Mac/Windows acceptance and hand off

**Produces:** Either `INTERNAL_BETA_ACCEPTED` with complete evidence or an exact list of external-blocked gates.

- [ ] Confirm Cloud/Admin health reports match the recorded deployed digests and the HTTPS certificate is publicly trusted and more than 24 hours from expiry.
- [ ] Register an unverified internal-Beta login identifier, confirm the UI states that recovery is unavailable, and sign in through Desktop OAuth.
- [ ] Confirm Desktop accepts the exact offline entitlement, works during a bounded offline interval, and rejects a wrong issuer/key/signature/binding.
- [ ] Install the exact DMG on Apple Silicon macOS after checksum verification and record the expected unsigned warning/override outcome.
- [ ] Install the exact setup executable on physical Windows 11 x64 after checksum verification and record the expected SmartScreen override outcome.
- [ ] Complete one real Agent turn on both platforms without changing USER-owned Profile or historical RuntimeBinding ownership.
- [ ] Verify quality consent off sends nothing; consent on sends only the minimized approved envelope; forced delivery failure does not break chat.
- [ ] Create an encrypted backup on one device, interrupt/resume an upload, authorize the second device, and restore into a fresh Profile.
- [ ] Verify wrong recovery material, corrupted ciphertext, and a revoked device fail without replacing the usable Profile.
- [ ] Verify restart, sign-out/sign-in, and uninstall/reinstall basics on both systems.
- [ ] Write the canonical redacted evidence JSON and run `node scripts/internal-beta/verify-live-evidence.mjs`.
- [ ] If every required outcome passes, mark `INTERNAL_BETA_ACCEPTED` and give testers the URL, packages, checksums, warning instructions, known limitations, and issue-reporting path.
- [ ] If a required external input is unavailable, mark only that gate `external_blocked`; report deployed/package-ready states separately and do not call the Beta accepted.

## Final Verification Commands

Run these from the three implementation worktrees before any completion claim:

```bash
cd /Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery
bash scripts/tests/check-secrets.test.sh
bash scripts/tests/delivery-contract.test.sh
bash scripts/tests/release-manifest.test.sh
bash scripts/tests/provenance.test.sh
bash scripts/tests/internal-beta-deploy.test.sh
./scripts/check-secrets.sh
go test -count=1 ./...
go vet ./...
npm --prefix web test -- --run
npm --prefix web run typecheck
npm --prefix web run build

cd /Users/zizimutou/Desktop/aera/aera-admin/.worktrees/internal-beta-delivery
bash scripts/tests/ci-contract.test.sh
bash scripts/tests/release-manifest.test.sh
bash scripts/tests/provenance.test.sh
bash scripts/tests/internal-beta-deploy.test.sh
make verify
AERA_ADMIN_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud/.worktrees/internal-beta-delivery make e2e

cd /Users/zizimutou/Desktop/aera/aera/.worktrees/internal-beta-delivery
node --test scripts/internal-beta/*.test.mjs ops/internal-beta/*.test.mjs
npx vitest run tests/agentera-auth-config.test.ts tests/agentera-auth-controller.test.ts tests/runtime-packaging-scripts.test.ts
npm run check:official-quality-boundary
npm run check:encrypted-backup-boundary
npm run typecheck
npm run build
npm exec --yes --package=lat.md@0.12.1 -- lat check
```

Expected result: every command exits `0`; no tracked secret is found; all three worktrees are clean; exact remote CI and candidate runs are successful; deployed digests equal verified manifests; Desktop package bytes equal the internal-Beta manifest; Runtime remains unchanged.

## Execution Choice

The user explicitly selected inline execution in the current session and instructed execution to begin immediately after planning. Therefore use the inline path: complete one task at a time, update this checklist/evidence after each checkpoint, and do not spawn subagents.
