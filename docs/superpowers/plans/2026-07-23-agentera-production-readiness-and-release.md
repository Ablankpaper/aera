# Production Readiness and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fail-closed, evidence-producing path from verified commits to private staging, signed desktop candidates, immutable Cloud/Admin image promotion, real-device acceptance, production rollout, rollback rehearsal, and public release without rebuilding artifacts between stages.

**Architecture:** GitHub Actions first validates all three repositories, builds content-addressed Cloud/Admin images and signed Desktop artifacts once, emits checksums/SBOM/provenance, and stores candidate manifests. Protected `staging` and `production` environments gate deployment and promotion. Staging deploys exact image digests and candidate hashes; acceptance records bind test evidence to those hashes. Production promotes the same digests/artifacts only after manual approval. Rollback tooling switches to a recorded previous digest or pauses Desktop publication without destructive schema rollback. Every state transition emits an auditable release record.

**Tech Stack:** GitHub Actions and Environments, GHCR, Docker Compose, Cosign/Sigstore, Syft/SPDX, Bash/PowerShell, macOS codesign/notary/stapler, Windows Authenticode/signtool, Electron Builder, Go/Node validation scripts, Caddy, PostgreSQL/Redis/MinIO, Playwright/E2E.

## Global Constraints

- Report these states separately: designed, feature branch implemented, locally verified, locally merged, pushed, remote CI passed, private staging deployed, staging accepted, signed candidate, real-device accepted, production deployed disabled, rollout enabled, public release.
- GitHub Actions billing/payment must be fixed by the account owner. No repository change can bypass a zero-step billing rejection.
- Use protected GitHub environments `staging` and `production`; production requires manual reviewer approval and does not expose secrets to pull requests.
- Cloud and Admin build one image per commit, identify it by digest, sign/attest it, and promote that exact digest. Desktop builds one signed candidate per version/commit and promotes those exact bytes.
- Production database migrations are forward-only. Application rollback is allowed only when the prior image declares compatibility with the current schema.
- Production secrets, signing private keys, provider credentials, real domains, IPs, and personal device evidence never enter Git.
- V1 release targets macOS Apple Silicon and Windows 11 x64. Linux remains a development build and is not represented as released.
- No public registration or production Agent rollout occurs without explicit production authority after staging and real-device evidence.
- `aera-runtime` stays unchanged; its locked seed is only packaged and verified by Desktop workflows.

## External Prerequisites — Not Implementable in Code

- GitHub account billing/spending limit repaired, followed by successful remote CI reruns.
- Apple Developer ID certificate, App Store Connect API key, issuer/key IDs, and notarization authority.
- Windows Authenticode certificate and private key/password or approved managed signing service.
- Filed final domain, trusted HTTPS, production SMTP/SMS/CAPTCHA providers, legal text approval, DNS/firewall authority, KMS/secret manager, S3-compatible production bucket, and production hosts/runners.
- Two supported Apple Silicon Macs covering current and previous supported macOS, plus a physical Windows 11 x64 device and a second trusted Windows VM or physical device.
- Named staging and production approvers with authority to deploy and release.

Implementation can make each missing prerequisite fail visibly and safely; it cannot truthfully mark the corresponding external gate complete.

## File Structure

### Cloud: `/Users/zizimutou/Desktop/aera/aera-cloud`

- Create `.github/workflows/candidate.yml`, `deploy-staging.yml`, `promote-production.yml`, and `rollback-production.yml`.
- Create `scripts/release/{build-manifest,verify-manifest,deploy-by-digest,rollback-by-digest}.sh` and tests.
- Modify `deploy/compose.production.yaml`, delivery contract tests, backup/restore runbooks, and production/private-staging runbooks.
- Add MinIO backup object lifecycle and quality/backup feature flags to deployment documentation.

### Admin: `/Users/zizimutou/Desktop/aera/aera-admin`

- Create `.github/workflows/ci.yml`, `candidate.yml`, `deploy-staging.yml`, `promote-production.yml`, and `rollback-production.yml`.
- Create `deploy/compose.production.yaml`, `deploy/Caddyfile.example`, deployment scripts/tests, and staging/production runbooks.
- Add image build, SBOM, signing, mTLS connectivity smoke, and Admin/Cloud version compatibility gates.

### Desktop: `/Users/zizimutou/Desktop/aera/aera`

- Create `.github/workflows/release-candidate.yml`, `promote-release.yml`, and `rerun-ci-checkpoint.yml`.
- Refactor `.github/workflows/beta-release.yml` and `.github/workflows/release.yml` so signing/packaging and publication are separate and never rebuild.
- Create `scripts/release/{candidate-manifest,verify-candidate,verify-macos,verify-windows,verify-device-evidence,publish}.mjs` plus PowerShell helpers/tests.
- Create `release/evidence.schema.json`, `docs/runbooks/{private-staging,desktop-signing,real-device-matrix,production-rollout,rollback-rehearsal}.md`.
- Modify CI and Lat documents.

---

### Task 1: Re-establish the remote CI safety checkpoint

**Consumes:** GitHub account billing repair performed by the user and current clean `main` commits.

**Produces:** Successful Cloud, Desktop, and Admin remote CI evidence before production automation is trusted.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/.github/workflows/rerun-ci-checkpoint.yml`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.github/workflows/ci.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/verify-ci-checkpoint.mjs`
- Test: `/Users/zizimutou/Desktop/aera/aera/scripts/verify-ci-checkpoint.test.mjs`

- [ ] Confirm the user has repaired GitHub billing/spending limits. If jobs still show zero steps with the payment/spending-limit annotation, stop this task and record `external_blocked`; do not modify tests to avoid Actions.
- [ ] Write script tests for an input manifest containing repository, commit SHA, workflow name, run URL, conclusion, and completed timestamp. Reject wrong SHAs, skipped/cancelled jobs, missing matrix platforms, or runs older than the commit.
- [ ] Run `node --test scripts/verify-ci-checkpoint.test.mjs`; expect failure.
- [ ] Implement the verifier and a manual workflow that uses `gh workflow run`/GitHub API only to dispatch existing CI and then validates all expected jobs. It does not carry production secrets and cannot turn a failed run green.
- [ ] Rerun Cloud and Desktop CI after billing repair; add Admin CI in Task 4, then rerun it. Save URLs and exact SHAs in an external release evidence directory, not source control.
- [ ] Run the verifier against the downloaded run metadata; expect pass only for all required jobs.
- [ ] Commit in Desktop: `git add .github/workflows/ci.yml .github/workflows/rerun-ci-checkpoint.yml scripts/verify-ci-checkpoint* && git commit -m "ci: verify remote safety checkpoints"`.

### Task 2: Cloud content-addressed candidate image and supply-chain evidence

**Consumes:** A Cloud commit with passing CI.

**Produces:** One GHCR image digest, SBOM, provenance, schema compatibility declaration, and signed candidate manifest.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.github/workflows/candidate.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/scripts/release/build-manifest.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/scripts/release/verify-manifest.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/scripts/tests/release-manifest.test.sh`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/scripts/tests/delivery-contract.test.sh`

- [ ] Write shell tests that reject mutable tags without a digest, mismatched source SHA, missing migration min/max, missing SBOM/provenance digest, unsigned image, or a dirty source tree.
- [ ] Run `bash scripts/tests/release-manifest.test.sh`; expect failure.
- [ ] Implement a canonical JSON manifest with repository, commit, image reference, immutable `sha256:` digest, build workflow/run, schema minimum/maximum, highest migration, SBOM digest, provenance digest, creation time, and feature flags for quality/backup default-off behavior.
- [ ] Implement candidate workflow: checkout exact SHA, run full Cloud verification/integration, build once with BuildKit, push commit tag to GHCR, resolve digest, generate SPDX SBOM, generate GitHub artifact attestation, sign image with Cosign OIDC, create/verify manifest, and upload manifest/evidence artifacts.
- [ ] Pin all third-party actions to reviewed full commit SHAs during implementation; GitHub-owned actions may be upgraded only in a separate dependency review commit.
- [ ] Run shell tests and `bash scripts/tests/delivery-contract.test.sh`; expect pass.
- [ ] Commit in Cloud: `git add .github/workflows/candidate.yml scripts/release && git commit -m "ci: build immutable cloud candidates"`.

### Task 3: Cloud staging deployment, promotion, and rollback by digest

**Consumes:** Verified Cloud candidate manifest and protected GitHub environments.

**Produces:** Exact-digest staging/production deploys with backup, smoke, feature gates, and reversible application rollout.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.github/workflows/deploy-staging.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.github/workflows/promote-production.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/.github/workflows/rollback-production.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/scripts/release/deploy-by-digest.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/scripts/release/rollback-by-digest.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/scripts/tests/deploy-by-digest.test.sh`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/deploy/compose.production.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/docs/runbooks/private-staging.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/docs/runbooks/production.md`

- [ ] Write tests using a fake Docker/health/backup command harness: deploy refuses a tag-only image, verifies Cosign/attestation, runs encrypted DB backup and disposable restore before migration, records previous digest, pulls exact digest, starts with public registration and new feature ingestion disabled, runs health/smoke, then enables only the approved staging flags.
- [ ] Write rollback tests: refuses unknown/unsigned digest, refuses schema-incompatible previous image, keeps forward migrations/data, switches exact image digest, re-runs health, and records rollback evidence.
- [ ] Run `bash scripts/tests/deploy-by-digest.test.sh`; expect failure.
- [ ] Change Compose `app.image` to require `AGENTERA_CLOUD_IMAGE_DIGEST` and disallow local build in staging/production deployment commands. Preserve loopback-only public port and private Internal Admin listener.
- [ ] Implement staging workflow using environment `staging`, an approved private runner/SSH tunnel, candidate manifest verification, deploy script, auth/official-quality/encrypted-backup smoke, and evidence upload.
- [ ] Implement production workflow using environment `production`, manual approval, same candidate digest, backup/restore gate, deploy disabled, smoke, then a separate explicit rollout-enable job.
- [ ] Implement rollback workflow requiring previous signed manifest, reason/ticket, production approval, and schema compatibility.
- [ ] Run deployment contract tests; expect pass.
- [ ] Commit in Cloud: `git add .github/workflows deploy scripts/release scripts/tests docs/runbooks && git commit -m "ops: promote cloud images by digest"`.

### Task 4: Admin CI and immutable candidate image

**Consumes:** Admin source, existing `make verify`/real Cloud E2E, Cloud internal contract.

**Produces:** Remote CI plus a signed, content-addressed Admin image and compatibility manifest.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-admin/.github/workflows/ci.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/.github/workflows/candidate.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/scripts/release/build-manifest.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/scripts/release/verify-manifest.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/scripts/tests/release-manifest.test.sh`

- [ ] Write CI contract tests requiring Go unit/integration/race, Admin web lint/test/typecheck/build, OpenAPI, E2E typecheck, image build, and a real Cloud E2E job using the exact Cloud candidate contract.
- [ ] Run the contract test locally; expect failure because workflows are absent.
- [ ] Add CI with PostgreSQL/Redis, `make verify`, and `AERA_ADMIN_E2E_CLOUD_REPO` against a checked-out pinned Cloud SHA. Never substitute a fake success when Cloud is unavailable.
- [ ] Add candidate workflow equivalent to Cloud: full verify, build once, push GHCR, SBOM, provenance, Cosign signature, and manifest declaring compatible Cloud internal API/schema versions.
- [ ] Run `make verify` and manifest tests; expect pass.
- [ ] Push only after explicit push authorization, then rerun Admin CI and add its URL/SHA to the external checkpoint manifest from Task 1.
- [ ] Commit in Admin: `git add .github scripts/release scripts/tests && git commit -m "ci: verify and attest admin candidates"`.

### Task 5: Admin private staging, production promotion, and Cloud mTLS smoke

**Consumes:** Verified Admin image digest, deployed compatible Cloud digest, dedicated mTLS/service-JWT secrets.

**Produces:** Private Admin deploy that fails closed if real Cloud connectivity or dual authentication is unavailable.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-admin/deploy/compose.production.yaml`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/deploy/Caddyfile.example`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/.github/workflows/deploy-staging.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/.github/workflows/promote-production.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/.github/workflows/rollback-production.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/scripts/release/deploy-by-digest.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/scripts/release/rollback-by-digest.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/scripts/tests/deploy-by-digest.test.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/docs/runbooks/private-staging.md`
- Create: `/Users/zizimutou/Desktop/aera/aera-admin/docs/runbooks/production.md`

- [ ] Write deploy tests requiring exact digest/signature, Admin DB backup/restore verification, loopback/private exposure, mounted read-only client cert/key/CA and service-JWT signing key, Cloud compatibility check, and real Cloud health before mutation routes become available.
- [ ] Write failure tests for expired certificate, wrong CA, invalid JWT issuer/subject/audience/scope, Cloud 404/timeout, and one of dual listeners failing. All remain unavailable; no mock success.
- [ ] Run deploy tests; expect failure.
- [ ] Implement hardened Compose with read-only root, bounded resources, separate Admin PostgreSQL/Redis, loopback-only browser listener, private egress to Cloud Internal Admin, and no public Cloud credentials.
- [ ] Implement staging/production/rollback workflows with protected environments and exact-digest promotion. Production deploys with mutation feature switches disabled until read-only health/audit and dual-auth smoke pass.
- [ ] Run `make verify`, deploy tests, and real Cloud E2E; expect pass.
- [ ] Commit in Admin: `git add deploy .github scripts/release scripts/tests docs/runbooks && git commit -m "ops: promote admin images by digest"`.

### Task 6: Desktop signed candidate workflow without publication

**Consumes:** Passing Desktop CI, locked Runtime Seed, Apple and Windows signing credentials supplied through protected environment secrets.

**Produces:** Signed/notarized macOS and Authenticode-signed Windows candidate bytes, checksums, SBOM, provenance, and one candidate manifest.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/.github/workflows/release-candidate.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/release/candidate-manifest.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/release/verify-candidate.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/release/verify-macos.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/release/verify-windows.ps1`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/release/candidate-manifest.test.mjs`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.github/workflows/beta-release.yml`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.github/workflows/release.yml`

- [ ] Write candidate-manifest tests rejecting version/SHA mismatch, missing Runtime Seed manifest, unsigned artifacts, missing notarization/Authenticode evidence, wrong architecture, inconsistent update metadata, and any Linux artifact marked releasable.
- [ ] Run `node --test scripts/release/candidate-manifest.test.mjs`; expect failure.
- [ ] Implement candidate workflow on protected `staging`: macOS arm64 builds with Developer ID signing and notarization; verifies `codesign --verify --deep --strict`, `spctl --assess`, and `xcrun stapler validate` on app/DMG. Windows x64 builds with protected Authenticode credentials and verifies both NSIS and portable executables with `signtool verify /pa /all`.
- [ ] Reuse existing Runtime Seed preparation and verification on unpacked and final artifacts. Add native-module architecture proof.
- [ ] Generate SHA-256 sums, SPDX SBOM for application dependencies and Runtime Seed lock, GitHub artifact attestation, and canonical candidate manifest containing exact artifact names/sizes/hashes/signing identities/notarization IDs/source SHA/version.
- [ ] Upload candidate artifacts only; create no tag or GitHub Release.
- [ ] Refactor beta/release workflows to call or consume the candidate workflow outputs; remove any publication path that rebuilds.
- [ ] Run local manifest tests and workflow static checks; expect pass. Remote signing remains externally blocked until credentials exist.
- [ ] Commit in Desktop: `git add .github/workflows scripts/release && git commit -m "ci: build signed desktop candidates once"`.

### Task 7: Desktop real-device evidence bound to candidate hashes

**Consumes:** Signed candidate manifest and physical/VM devices.

**Produces:** Machine-readable acceptance record that cannot be reused for different bytes.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/release/evidence.schema.json`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/release/verify-device-evidence.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/release/verify-device-evidence.test.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/docs/runbooks/real-device-matrix.md`

- [ ] Write verifier tests requiring four independent entries: current macOS Apple Silicon, previous supported macOS Apple Silicon, physical Windows 11 x64, and a second trusted Windows environment. Reject duplicate device fingerprints, virtual-only Windows evidence, wrong candidate hash/version/SHA, missing signature verification, or failed scenarios.
- [ ] Define required scenarios: clean install, upgrade from prior stable, login/offline entitlement, official Agent install/run/update/rollback/new-vs-existing RuntimeBinding, quality consent off/on, encrypted backup/create/authorized-device restore/phrase restore, restart, uninstall/reinstall, and no private-data upload canary.
- [ ] Run `node --test scripts/release/verify-device-evidence.test.mjs`; expect failure.
- [ ] Implement schema and verifier. Evidence records contain coarse OS/build, device-class label, candidate hashes, scenario booleans, timestamps, tester identity reference, and redacted artifact links—never local Profile paths, account secrets, prompts, Memory, or recovery words.
- [ ] Document exact commands for signature verification and evidence collection on each platform.
- [ ] Run verifier tests; expect pass. Actual device acceptance remains externally blocked until devices and testers are available.
- [ ] Commit in Desktop: `git add release scripts/release docs/runbooks/real-device-matrix.md && git commit -m "test: bind release evidence to desktop artifacts"`.

### Task 8: Private staging acceptance across Cloud, Admin, and Desktop

**Consumes:** Exact Cloud/Admin digests, Desktop candidate hashes, protected staging environment.

**Produces:** One cross-repo staging acceptance manifest with no public exposure.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/docs/runbooks/private-staging.md`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/release/verify-staging-evidence.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/release/verify-staging-evidence.test.mjs`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/agentera-official-managed-agent.e2e.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/agentera-official-quality.e2e.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/agentera-encrypted-backup.e2e.ts`

- [ ] Write evidence tests binding Cloud digest, Admin digest, Desktop candidate manifest digest, schema version, final staging origin, and test run URLs. Reject raw IP production issuer, public registration enabled, missing restore verification, or missing rollback drill.
- [ ] Run verifier tests; expect failure.
- [ ] Implement a staging suite covering auth/device/offline, workspace/organization/official Agent, immutable release/gray/pause/rollback, privacy quality k-anonymity/proposal governance, encrypted backup/restore/delete, Admin dual-auth/RBAC/audit, and migration backup/restore.
- [ ] Require network evidence that public listener is tunnel/VPN/allowlist only, Internal Admin is private, databases/object store are not exposed, and production provider credentials are absent.
- [ ] Run against private staging only after exact-digest deployments and upload the signed/redacted acceptance manifest as a protected workflow artifact.
- [ ] Commit in Desktop: `git add docs/runbooks/private-staging.md scripts/release tests/e2e && git commit -m "test: define cross-repo staging acceptance"`.

### Task 9: Production promotion and Desktop publication from existing bytes

**Consumes:** Passing remote CI, staging acceptance, real-device evidence, production approval, exact candidate manifests.

**Produces:** Cloud/Admin production disabled deploy, controlled enablement, and Desktop GitHub Release from candidate bytes without rebuild.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/.github/workflows/promote-release.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/release/publish.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/release/publish.test.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/docs/runbooks/production-rollout.md`

- [ ] Write publish tests using a fake GitHub API: download candidate artifacts by source workflow run ID, verify manifest/checksums/attestations/device/staging evidence, reject an existing mismatched tag, create an annotated tag at the exact source SHA, and upload exact artifact bytes plus update metadata without invoking build tools.
- [ ] Run `node --test scripts/release/publish.test.mjs`; expect failure.
- [ ] Implement protected `production` promotion workflow requiring candidate run ID, Cloud/Admin manifests, staging evidence, device evidence, legal/provider/domain gate attestations, and manual approval.
- [ ] Order rollout: deploy Cloud exact digest with registration/quality/backup ingestion disabled → health/read-only smoke → deploy Admin exact digest with mutations disabled → dual-auth/RBAC/audit smoke → enable Cloud feature flags by approved cohort → enable Admin mutations → publish Desktop exact candidate bytes → monitor.
- [ ] Ensure the Desktop publish job uses `gh run download` for the candidate workflow and fails if any file hash differs. It must not run `npm build`, Electron Builder, or Runtime Seed preparation.
- [ ] Document stop conditions, responsible approver, canary percentages, monitoring windows, and evidence links.
- [ ] Run local publish tests; expect pass. Actual promotion remains unauthorized until the user explicitly approves production actions and prerequisites exist.
- [ ] Commit in Desktop: `git add .github/workflows/promote-release.yml scripts/release docs/runbooks/production-rollout.md && git commit -m "ops: promote verified desktop bytes"`.

### Task 10: Rollback rehearsal and failure-mode proof

**Consumes:** Staging environment with current and previous signed candidates.

**Produces:** Rehearsed Cloud/Admin digest rollback and safe Desktop response without rewriting RuntimeBindings or destructive data rollback.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/docs/runbooks/rollback-rehearsal.md`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/release/verify-rollback-evidence.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/release/verify-rollback-evidence.test.mjs`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.github/workflows/rollback-production.yml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/.github/workflows/rollback-production.yml`

- [ ] Write evidence tests requiring: encrypted backup and disposable restore before drill; previous digest signature/schema compatibility; current digest; timestamps; health before/after; official Agent release pause/rollback; fixed existing RuntimeBinding proof; backup object/decryption proof; and restoration to the current digest after the drill.
- [ ] Run verifier tests; expect failure.
- [ ] Rehearse in staging: promote candidate B, create data using new additive schema, roll application to compatible candidate A without down migration, verify auth/Admin/official/quality/backup reads, then restore B. Record every exact digest.
- [ ] Rehearse Desktop response: pause/rollback an official Agent release and confirm existing sessions retain their original RuntimeBinding; for a bad Desktop binary, stop publication/update metadata and produce a higher-version corrective candidate from reviewed source rather than serving unsigned older bytes as a downgrade.
- [ ] Rehearse object-store outage, Admin-to-Cloud mTLS failure, expired signing evidence, failed notarization, and incomplete backup cleanup; every path must fail closed without chat/local-learning corruption.
- [ ] Run evidence verifier; expect pass only with real staging records.
- [ ] Commit in Desktop: `git add docs/runbooks/rollback-rehearsal.md scripts/release/verify-rollback-evidence* && git commit -m "test: require rollback rehearsal evidence"`.

### Task 11: Final local and remote release-gate verification

**Consumes:** All implementation plans completed on isolated feature branches.

**Produces:** Evidence-backed readiness report with no conflation of code completion and production release.

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-post-official-delivery.md`
- Create: `/Users/zizimutou/Desktop/aera/aera/docs/runbooks/release-status-template.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/docs/runbooks/production.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera-admin/docs/runbooks/production.md`

- [ ] Run Desktop local gates: `npm test`, `npm run typecheck`, `npm run build`, all AgentEra E2E suites, workflow/script tests, boundary scripts, and `lat check`.
- [ ] Run Cloud local gates: `go test -count=1 ./...`, integration/E2E suites with PostgreSQL/Redis/MinIO, `go test -race` security/control-plane packages, `go vet ./...`, image build, secret/delivery tests, encrypted backup and disposable restore.
- [ ] Run Admin local gates: `make verify`, real Cloud E2E, image build, deployment contract tests, and mTLS/service-JWT failure matrix.
- [ ] Verify all three worktrees are clean and record exact commit SHAs. Verify Runtime remains at its pre-program SHA and clean.
- [ ] After explicit merge authorization, merge locally and rerun proportional smoke. After explicit push authorization, push and validate remote CI.
- [ ] Populate the status template with each state and evidence URL/hash. Mark unavailable external prerequisites as `external_blocked`, not passed.
- [ ] Do not deploy, change DNS, enable production, publish a GitHub Release, or rotate production secrets without a separate explicit production authorization.

## Final Acceptance Evidence

- [ ] Cloud and Admin production consume exact candidate image digests signed and attested from passing commits.
- [ ] Desktop published files exactly match the signed/notarized/AuthentiCode candidate hashes accepted on real devices.
- [ ] Private staging proves full official-quality and encrypted-backup paths without public exposure.
- [ ] Rollback rehearsal succeeds without down migrations, data loss, RuntimeBinding mutation, or Hermes learning interruption.
- [ ] GitHub billing, Apple/Windows credentials, domain/providers/legal, hosts/storage, physical devices, staging acceptance, production approval, deployment, rollout, and public release each have independent evidence; none is inferred from code.
