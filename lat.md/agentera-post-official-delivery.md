# AgentEra post-official delivery program

The approved follow-on program adds content-free official quality feedback, client-encrypted Profile snapshots, and production release gates without changing Hermes core ownership.

The canonical umbrella design is `docs/superpowers/specs/2026-07-23-agentera-post-official-v1-delivery-program-design.md`. Quality, backup, and release use separate payloads, storage, keys, permissions, and failure domains.

## Official quality feedback V1

Official quality feedback is an opt-in PLATFORM-only pipeline for fixed result codes, timing and token buckets, whitelisted crash codes, and explicit fixed-code user feedback.

The desktop derives provenance from a trusted USER-owned official Installation and fixed RuntimeBinding, then discards raw runtime objects before creating an event. Cloud stores no user, device, Installation, Profile, Session, or RuntimeBinding identifier in the event row and exposes aggregates only at ten or more rotating anonymous subjects.

Admin may create a DLP-scanned QualityProposal from thresholded aggregates. A different employee approves it before a Developer can clone the verified immutable base into a human-editable platform draft. No event trains a model, generates Agent content, publishes a version, changes rollout, or enters Hermes learning automatically.

The complete contract is `docs/superpowers/specs/2026-07-23-agentera-official-agent-privacy-quality-feedback-v1-design.md`.

The executable cross-repository task sequence is `docs/superpowers/plans/2026-07-23-agentera-official-agent-privacy-quality-feedback-v1.md`.

### Local minimization boundary

The main process converts runtime observations into closed result, latency, token, and crash buckets before any durable quality object exists.

[[src/main/agentera-official-quality/minimizer.ts#bucketOfficialQualityLatency]] and [[src/main/agentera-official-quality/minimizer.ts#bucketOfficialQualityTotalTokens]] accept only bounded numeric counters, while [[src/main/agentera-official-quality/model.ts#parseOfficialQualityEnvelope]] rejects unknown fields, raw text, malformed provenance, and non-canonical signatures.

This domain never accepts prompts, responses, error messages, paths, conversation or session identifiers, Profile or RuntimeBinding identifiers, Memory, Skills, Curator state, or attachments. Official release provenance is the minimum gate; later collection must fail closed when the binding is not an eligible PLATFORM release.

### Consent and private outbox

The quality outbox is a separate private SQLite domain below Electron `userData` and outside `HERMES_HOME`.

[[src/main/agentera-official-quality/db.ts#openAgenteraOfficialQualityDatabase]] creates private directory and file permissions. The database stores only purpose-scoped consent receipts and canonical minimized envelopes; its schema deliberately has no column for runtime content or Hermes-owned identity.

Consent defaults off independently for passive quality and explicit feedback. An enqueue requires the currently active purpose and exact consent version, expires after thirty days, and treats exact event replay as idempotent while rejecting conflicting reuse. A future schema version is rejected without modification.

Task 6 focused evidence is `src/main/agentera-official-quality/{db,model,minimizer}.test.ts`: 31 tests cover path isolation, permissions, schema shape, default-off consent, strict canonical serialization, bucket boundaries, replay safety, expiry, and future-schema refusal. Feature-branch push and exact-SHA CI are recorded separately below; none of this is a deployment, collection rollout, or production consent grant.

### Trusted terminal collection

Quality observation attaches after the installed Agent turn has already fixed its local RuntimeBinding and never changes the prompt, tool schema, Profile, session, or learning path.

[[src/main/agentera-official-quality/collector.ts#createOfficialQualityBindingResolver]] accepts provenance only when the USER-owned local Installation is active, managed, PLATFORM-sourced, and matches the fixed binding plus verified policy snapshot. The content-discarding [[src/main/agentera-official-quality/collector.ts#createOfficialQualityChatObserver]] retains only bounded total tokens and one closed terminal classification; raw response, error, history, attachments, tool payloads, session identity, and paths never reach the collector or manager.

[[src/main/agentera-official-quality/manager.ts#AgenteraOfficialQualityManager]] synchronizes purpose-specific consent before delivery, uploads only account/device-scoped due rows, retries transient failures with bounded exponential jitter, drops terminal privacy rejections, and purges old-account pending rows on logout. Collection and upload failures are swallowed at the quality boundary and cannot reject or delay the chat promise.

The outbox remains capped at 1,000 events and drops the oldest passive metrics before explicit feedback. Expired rows are removed after thirty days, revocation immediately removes unsent rows for that purpose, and every Cloud request uses the product bearer token without placing it in IPC or logs.

### Consent and fixed-code feedback surface

[[src/renderer/src/components/settings/PrivacyPane.tsx#PrivacyPane]] presents passive metrics and explicit feedback as independent, default-off choices with no-content disclosure.

Disabling either purpose deletes its unsent local outbox rows. Signed-out users can read the fail-closed state but cannot mutate consent.

[[src/main/agentera-official-quality/ipc-contract.ts#parseOfficialQualityFeedbackInput]] accepts exactly `eventId`, `rating`, and `reasonCodes`. It rejects extra properties, free text, raw errors or responses, Session, conversation, Profile, RuntimeBinding identifiers, non-UUIDv7 handles, unknown ratings, unknown reasons, and duplicate reasons before the manager runs.

Explicit feedback remains independent from passive collection. [[src/main/agentera-official-quality/collector.ts#OfficialQualityCollector]] may hold one content-free successful-turn candidate in bounded main-process memory when explicit feedback is enabled even if passive metrics are disabled. Nothing is persisted until the user affirmatively submits a fixed rating. Revocation, account change, a thirty-minute timeout, or one submission invalidates the candidate.

The main process emits [[src/shared/agentera-official-quality.ts#OfficialQualityFeedbackEligibility]] only after an eligible PLATFORM-bound turn succeeds. [[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#attachOfficialQualityEligibility]] never derives eligibility from a Dashboard event; without the trusted main-process token the renderer shows no controls. [[src/renderer/src/screens/Chat/MessageRow.tsx#MessageRow]] submits only the opaque event handle, `helpful|not_helpful`, and the closed reason catalog. Conversation text and renderer turn identity never enter that call.

Task 8 focused evidence covers strict IPC, independent consent, candidate expiry and revocation, renderer event scoping, default-off settings, fixed-code submission, and no-content canaries. The feature branch has since passed exact-SHA remote CI; it is not a deployment, production opt-in, or release.

### Quality privacy and regression evidence

The quality privacy gate locks the public envelope, private outbox, and production import boundary before every Desktop CI build.

`scripts/check-official-quality-boundary.mjs` verifies the exact 20-field public envelope, the exact 11-column private outbox, and every production import in the quality domain. It rejects content or identity fields and imports from Hermes Memory, private Skill, Curator, session-content, or attachment modules. The gate runs on every Desktop CI operating-system matrix entry.

[[tests/e2e/agentera-official-quality.e2e.ts]] composes the production SQLite privacy store, minimizer, collector, manager, Cloud client, and content-discarding chat observer around fixed local RuntimeBindings. Its deterministic Cloud fixture captures only protocol requests and cannot change product execution. The five acceptance cases prove default-off emits nothing, passive consent emits one minimized terminal envelope, explicit feedback is separately gated and fixed-code-only, network failure leaves chat successful with a retryable outbox row, and a new v2 RuntimeBinding does not mutate an existing v1 binding.

The 2026-07-23 local quality gate completed with these results:

- Desktop: 71 focused quality, IPC, settings, and chat tests; 5 Playwright protocol tests; Node and renderer typechecks; production Electron build; privacy boundary of 20 public fields, 11 outbox columns, and 7 production modules.
- Cloud: `go test -count=1 ./...` plus isolated PostgreSQL and Redis integration tests for `officialquality`, `adminapi`, and `jobs`.
- Admin: `make verify`, including 22 web files and 78 web tests, Go unit/integration/race checks, OpenAPI, E2E typecheck, and release builds. The real Admin-to-Cloud run passed 15 of 15 scenarios, including nine-subject suppression, ten-subject visibility, Developer proposal, different-Super-Admin approval, Developer clone to a normal draft, unchanged immutable versions/releases, unauthorized-role denial, and privacy-safe audit.

These results were first established locally and were later covered by the exact-SHA branch CI recorded below. They do not mean local main merge, staging deployment, production consent enablement, or public release. The Cloud HMAC feature remains disabled by default and no quality event is authorized to train, publish, alter rollout, mutate a RuntimeBinding, or enter Hermes learning.

## End-to-end encrypted backup V1

Encrypted backup stores immutable ciphertext snapshots for one USER-owned Installation and physical Profile; it is not Agent sync or live multi-device state replication.

One user-held 24-word recovery phrase and separately authorized X25519 devices wrap a client-only Backup Root Key. Every backup has its own Data Encryption Key, encrypted manifest, authenticated chunks, and random object identifiers. Cloud stores public keys, encrypted envelopes, hashes, sizes, quotas, and object references but cannot decrypt filenames, Agent/Profile metadata, conversations, Memory, USER, Skills, Sessions, or Curator state.

Restore verifies and decrypts into a transaction-owned staging directory, installs the exact immutable Agent base, and creates a new USER-owned Installation and fresh Profile. Different device histories remain explicit branches; no last-writer-wins or automatic merge path exists.

The complete contract is `docs/superpowers/specs/2026-07-23-agentera-end-to-end-encrypted-backup-migration-v1-design.md`.

The executable Cloud/Desktop implementation sequence is `docs/superpowers/plans/2026-07-23-agentera-end-to-end-encrypted-backup-migration-v1.md`.

### Local encrypted-backup acceptance evidence

The production Desktop application, a real Cloud process, PostgreSQL, Redis, MinIO, and three isolated Electron device homes completed the encrypted-backup acceptance flow on 2026-07-23.

The proof refused backup while a Profile had a running chat, then created and sealed a manual backup after the runtime became idle. PostgreSQL and MinIO inspection found none of the plaintext canaries in object bytes, object metadata, public backup metadata, device envelopes, or wrapped-key rows. A separately registered and authorized second device restored into a new USER-owned Installation and fresh Profile. A third device recovered the same backup with only the 24-word phrase.

The same flow rejected a wrong phrase, resumed after a forced first-chunk upload failure, rejected a revoked device, and detected tampered ciphertext without changing the restored Profile. Deletion destroyed recovery material, wrapped keys, and device envelopes before retrying unavailable object-store cleanup to zero remaining objects. The source Profile's Memory, USER state, private Skills, environment file bytes, session rows, and RuntimeBindings remained unchanged throughout.

The changing-file snapshot regression forces a different byte length on every retry so fail-closed identity detection remains deterministic even on filesystems whose timestamp updates may share one clock tick.

Key-store regression tests retain the production Argon2id parameters and give KDF-bearing cases explicit runtime budgets. Slower CI runners must not weaken the KDF or bypass fail-closed secure-storage assertions.

The recovery-envelope regression performs one wrap and two unwrap operations, so its case budget covers three full production-cost Argon2id derivations without changing the cryptographic parameters.

`scripts/check-encrypted-backup-boundary.mjs` independently locks the cross-repository privacy boundary: Cloud tables and object metadata may contain only opaque ciphertext or public protocol metadata, while the Desktop allowlist excludes credentials and environment files and cannot call the Hermes backup mechanism.

The implementation checkpoints are:

- Desktop: `5440a7e`, `0d29df6`, `cdf37d4`, `e910bb5`, `d0c1d36`, `09e00bf`, the real-E2E device-identity fix `cfbe1f3`, and acceptance/CI commit `decc9c0`.
- Cloud: `acaead9`, `8b2d07a`, `a36542b`, `fddf990`, `d4a3807`, `e550d55`, the signed-time round-trip fix `8621c07`, and operations runbook `09c3d89`.
- Desktop gate: 31 focused files and 241 tests, Node and renderer typechecks, production Electron build, one full three-device Playwright scenario, the five-table/67-column cross-repository boundary, and `lat check`.
- Cloud gate: `go test -count=1 ./...` plus isolated PostgreSQL, Redis, and MinIO execution of `AERA_INTEGRATION_TESTS=1 go test -count=1 -p 1 ./internal/encryptedbackup ./internal/jobs`.
- Runtime boundary: `/Users/zizimutou/Desktop/aera/aera-runtime` remained clean on `c0439e1e3e5f35a91b658d57ddfc011e0d5ba1bb`.

This acceptance was first established locally. Desktop and Cloud feature branches have since been pushed and accepted by exact-SHA remote CI, but they have not been merged to local `main`, deployed to staging or production, enabled for production accounts, or publicly released. The separate `aera-runtime` checkout was not changed.

## Production readiness and release

Production delivery progresses through local verification, remote CI, private staging, signed candidates, real devices, restore and rollback rehearsal, disabled production deployment, bounded rollout, and separately approved public release.

Cloud and Admin images are built once from exact commits and promoted by digest. Desktop macOS Apple Silicon and Windows 11 x64 artifacts are signed once, verified on real devices, and published without rebuilding. Missing production credentials, domains, providers, signing certificates, devices, or final authority remains an external gate rather than a code fallback.

The complete contract is `docs/superpowers/specs/2026-07-23-agentera-production-readiness-and-release-design.md`.

The executable CI, staging, signing, promotion, device-evidence, and rollback sequence is `docs/superpowers/plans/2026-07-23-agentera-production-readiness-and-release.md`.

### Remote CI safety checkpoint

`scripts/verify-ci-checkpoint.mjs` accepts only exact expected repository SHAs whose required platform jobs completed successfully after the commit and executed real steps.

Desktop CI keeps two Vitest workers on macOS but serializes test files on hosted Ubuntu and Windows runners after both platforms emitted worker-level failures under filesystem-heavy parallel load. The Windows full-suite job also gives each case a 20-second ceiling because hosted runner pauses repeatedly moved the default five-second failure across otherwise sub-second SQLite and process tests; assertions and required platform gates remain unchanged.

The CI workflow also exposes a manual `windows-process-tree-diagnostic` mode for one release-isolated hosted-Windows check of the four process-tree lifecycle test files. Its distinct job name and missing macOS/Ubuntu matrix mean `scripts/verify-ci-checkpoint.mjs` cannot accept it as a release checkpoint; push, pull-request, and full manual CI retain the complete matrix. Candidate validators allow only that exact diagnostic job to be skipped beside a full run and still require the named Ubuntu, macOS, and Windows `check` jobs to execute successfully, so diagnostic-only or incomplete runs remain ineligible for packaging.

The manual `rerun-ci-checkpoint.yml` workflow dispatches the existing repository CI workflows and records their GitHub URLs and job facts without carrying production secrets or changing a failed result.

On 2026-07-23 the three pushed feature-branch checkpoints completed exact-SHA CI successfully:

- Desktop `e4ba6bbd98ac2ab5484e2e213645368c079ecd97`: run `30011233373`; Ubuntu, Windows, and macOS typecheck, full tests, Official Quality E2E, and production build passed. Ubuntu also verified the pinned Cloud SHA and bytes, both privacy boundaries, and the production dependency tree.
- Cloud `92632048a5261f02d06f132d22854dda1b513345`: run `30006310907`; delivery/secret contracts, Go and Web gates, service integration/auth smoke, encrypted backup/disposable restore, and application image build passed.
- Admin `57d637412470fc5c86524e40bd717399a9936162`: run `30010245066`; exact Cloud contract verification, full unit/integration/race/Web/OpenAPI/build gates, release image build, and real Cloud mTLS/service-JWT E2E passed.

These CI image builds are verification artifacts, not signed immutable release candidates.

### Signed Desktop candidate boundary

The Desktop candidate workflow builds signed distributable bytes once and cannot tag or publish them.

It requires exact-SHA successful CI, protected signing credentials, native macOS arm64 and Windows x64 runners, the exact locked Runtime Seed, Developer ID plus notarization and stapling evidence, Authenticode plus trusted timestamps, canonical updater metadata, an SPDX SBOM, provenance, checksums, and GitHub artifact attestation.

`release.yml` and `beta-release.yml` no longer contain build or publication paths; they can only invoke the candidate workflow. Local policy and workflow tests pass, but no remotely signed candidate exists because the protected Apple/Windows signing path was not authorized or executed. Local and branch-CI verification therefore prove the fail-closed pipeline contract, not signed bytes, device acceptance, staging deployment, or release.

The Hermes 0.20.0 promotion train updates `build/agentera-runtime-seed.lock.json` only in the release branch: it binds `runtime-v0.20.0-agentera.1-rc.1`, source `ae746df6556f1d496f9dd49c850cc6133997e317`, and the exact Darwin/Windows manifest and signature names. For the authorized Beta.24 channel, `internal-beta.yml` signs, notarizes, and staples macOS while publishing Windows as explicitly unsigned; any later production candidate must use `release-candidate.yml` and its stricter Authenticode boundary.

### Platform-signed internal-Beta candidate boundary

Beta.23 is immutable; Beta.24 keeps Beta.21's notarized macOS boundary and intentionally unsigned Windows x64 Internal Beta packages. Production candidates remain Authenticode fail-closed.

`.github/workflows/internal-beta.yml` requires one exact successful-CI Desktop SHA on `main`, prepares and verifies the locked Runtime Seed without checking out Runtime source, and bakes one reviewed HTTPS IP Origin plus its issuer-scoped Ed25519 public key. Since Beta.21 the macOS job requires protected Developer ID and App Store Connect credentials, signs and verifies the application, submits an exact signed application payload to Apple, records its submission ID and bytes before waiting on that same ID, staples and validates the accepted application, and only then produces the final DMG and ZIP. It records the exact final container bytes and submission IDs before waiting on those same IDs, staples and validates the accepted DMG, and requires strict `codesign`, Gatekeeper, architecture, and Runtime Seed verification for both distributed application copies. The Beta.24 Internal Beta Windows job disables identity discovery and remains explicitly unsigned while retaining fixed x64 artifact names, Runtime Seed verification, digests, and signed update metadata. Tags and Releases stay disabled, a separate pinned Ed25519 key authenticates the private online-update channel, and `.github/workflows/release-candidate.yml` continues to require Authenticode and trusted timestamps.

`scripts/internal-beta/manifest.mjs` binds version `0.7.4-internal-beta.24`, Runtime Seed candidate `runtime-v0.20.0-agentera.1-rc.1` at `ae746df6556f1d496f9dd49c850cc6133997e317`, both workflow run identities, the Origin and public trust root, Runtime lock and Darwin/Windows manifests, four fixed package names and hashes, SPDX SBOM, SLSA v1 provenance, `macos-evidence.json`, accepted final DMG and ZIP notarization submission IDs, and `macos_developer_id_notarized_windows_unsigned`. The previously attempted old-lock run and the differing Beta.23 candidate bytes are not reusable. The candidate workflow additionally signs a strict two-platform Desktop update manifest and uploads one immutable artifact without publisher credentials. A separate manual promotion workflow verifies the exact successful candidate run, source, checksums, canonical manifest, and update signature before a forced-command-only principal atomically switches current metadata and verifies the live path; it never rebuilds or resigns. Runtime stable upgrades remain a separate user-confirmed channel until this candidate is accepted. Beta.6 through Beta.8 require a manual bridge install because they predate the corrected macOS ASAR extraction boundary.

The host ceremony is restart-safe when Caddy is installed but its configuration was intentionally removed: preparation creates and validates a loopback-only waiting configuration before enabling the service, rejects regular-path substitutes including dangling symbolic links, and reuses only an already installed Cosign binary whose version and SHA-256 exactly match the pinned verifier. Secret generation also creates the fixed-name, UID-scoped Admin PKI view and the Admin-to-Cloud service configuration needed for the private mTLS/JWT health probe. Desktop Beta.3 must therefore bake the public offline-entitlement key generated by that same live host; Beta.2 remains a byte-verifiable earlier candidate but is not the online-host trust match.

The workflow keyless-signs the canonical manifest and provenance with Cosign and immediately verifies the exact GitHub OIDC issuer plus `internal-beta.yml@refs/heads/main` identity. Its final artifact lasts thirty days and creates no public release surface. Local manifest/policy tests prove the pipeline contract only; no remote internal-Beta package or physical-device acceptance is claimed until the later live execution records it.

### Real-device evidence boundary

Real-device approval is one canonical record bound to the exact candidate manifest and installed artifact hashes.

`release/evidence.schema.json` and `scripts/release/verify-device-evidence.mjs` require two different physical Apple Silicon Macs on consecutive supported macOS majors, one physical Windows 11 x64 machine, and a different physical or trusted-VM Windows 11 x64 environment. Duplicate device fingerprints, missing roles, unsigned bytes, wrong signer or timestamp, and evidence from another candidate fail closed.

Every role must pass the complete install/upgrade, online/offline, official Agent update/rollback and RuntimeBinding, quality privacy, encrypted-backup failure/restore, restart, and uninstall/reinstall matrix with two opaque QA account references and two opaque backup-device references. The exact-field schema excludes Profile paths, prompts, Memory, recovery words, secrets, raw device identifiers, and free-form notes.

The verifier and schema-policy tests pass locally. Real-device status remains `external_blocked` until one remotely signed candidate and the required physical/trusted devices, QA accounts, backup authorizations, and testers produce protected evidence.

### Private-staging acceptance boundary

Private-staging acceptance is one canonical Ed25519-signed manifest bound to exact Cloud/Admin image digests and the Desktop candidate-manifest digest.

`scripts/release/verify-staging-evidence.mjs` requires a final DNS HTTPS origin and issuer, VPN/tunnel/allowlist-only access, private Internal Admin dual authentication, non-public data services, disabled public registration, staging-only keys/data/providers, two accounts/devices, eight successful exact-SHA run URLs with real steps, and the closed scenario matrix.

The same manifest binds an encrypted database backup, disposable restore, object inventory with zero missing/orphan objects, and a feature-control rollback drill. Raw-IP issuers, public services, production credentials, skipped runs, failed scenarios, missing recovery, unknown fields, noncanonical JSON, wrong Ed25519 key IDs, or invalid detached signatures fail closed.

Official Agent, quality, and encrypted-backup E2Es now attach content-free `isolated_*_preflight` coverage summaries. Those attachments prove executable local/CI coverage but cannot claim a deployed private-staging run. Actual staging acceptance remains `external_blocked` pending exact remote candidates, protected infrastructure, final DNS HTTPS, isolated secrets/providers/data, and signed protected run evidence.

### Exact-byte production promotion boundary

`.github/workflows/promote-release.yml` promotes immutable release identities only after protected production approval and four ordered production runs.

The required order is Cloud disabled, Admin disabled, Cloud enabled, then Admin enabled. `scripts/release/publish.mjs` downloads the Desktop candidate by its source workflow run ID, verifies canonical manifest and checksum closure, GitHub attestations, signed-device evidence, signed private-staging evidence, exact image/manifests, legal/provider/domain gates, and an annotated tag at the exact source SHA before creating a draft Release. The protected workflow also downloads the disabled and enabled Cloud/Admin state artifacts and refuses publication unless their environment, source, image digest, manifest hash, and actual feature/mutation values match the production gate exactly.

Cloud and Admin enablement is fail-closed: a failed enabled health/smoke check restores disabled flags and repeats the disabled proof; a failed recovery stops the service instead of reporting unknown state as success.

The publisher uploads only the six candidate artifacts plus their manifest, checksums, SBOM, and provenance; it has no build, packaging, Runtime Seed preparation, signing, notarization, or metadata-generation path.

The production runbook distinguishes the controlled 5% Desktop candidate cohort from public updater availability because the current exact update metadata has no public staged percentage. Local publication tests pass with a fake GitHub API, including tampered-byte and mismatched-tag rejection. Production authorization, four deployment runs, monitoring, protected evidence, tag creation, and public release remain `external_blocked`; the authorized feature-branch pushes and CI runs do not imply any production write.

### Rollback rehearsal boundary

Rollback acceptance requires signed private-staging proof that exact compatible Cloud/Admin images move B → A → B without a down migration or preserved-state change.

`scripts/release/verify-rollback-evidence.mjs` binds encrypted backup/disposable restore, object reconciliation and client decryption, image signatures/schema compatibility, health/read checks, append-only Official Agent rollback, fixed existing RuntimeBindings, safe Desktop withdrawal/correction, five fail-closed injections, and before/after hashes for Profile and Hermes learning state.

The protected Cloud/Admin rollback workflows can target staging only when the exact current candidate is supplied and automatic restoration is enabled. They record B → A, re-verify and restore B disabled, and upload separate rollback/restoration artifacts. Production rollback never auto-restores and still requires its own protected approval.

Local verifier and fake-command workflow tests do not establish a real rehearsal. Exact signed candidates, staging infrastructure, executed runs, protected evidence, and independent approval remain `external_blocked`.

### Final local verification and frozen handoff

The 2026-07-23 exhaustive local matrix passed from the isolated feature worktrees.

- Desktop at verified code checkpoint `e4ba6bbd98ac2ab5484e2e213645368c079ecd97`: 299 Vitest files with 2,751 passing and 3 explicitly skipped tests; Node and renderer typechecks; production Electron build; 49 release-policy tests; official-quality and encrypted-backup boundary checks; Lat validation; and all 17 AgentEra Playwright scenarios in one single-worker run.
- Cloud at `92632048a5261f02d06f132d22854dda1b513345`: secret/delivery/digest/manifest contracts; all default Go packages; security/control-plane/encrypted-backup race tests; vet and release builds; Web unit, type, build, and eight browser checks; PostgreSQL/Redis/MinIO integration; tagged E2E; auth smoke; encrypted backup and disposable restore; and local image build.
- Admin at `57d637412470fc5c86524e40bd717399a9936162`: `make verify`; all release/deploy/Cloud-material contracts; local image build; 15 real-Cloud browser scenarios; and the backend E2E acceptance test.
- Runtime remained clean at `c0439e1e3e5f35a91b658d57ddfc011e0d5ba1bb`.

The Desktop status-only successor commit is recorded in the external handoff because a Git commit cannot contain its own object ID. All three `aera/official-quality-v1` branches exist on origin, and the exact verified code checkpoints passed the CI runs recorded above. Signed candidates, physical-device evidence, private-staging acceptance, rollback rehearsal, production deployment, rollout, and public publication remain `external_blocked` or not authorized as recorded in `docs/runbooks/release-status-template.md`.

Authorized feature-branch pushes and their CI runs occurred. No local `main` merge, pull request, deployment, DNS change, production feature enablement, tag, GitHub Release, or secret rotation occurred.

### Internal-Beta host ceremony boundary

The temporary company-internal Beta host now has a fail-closed, repository-owned
ceremony contract without committing its address or credentials.

`ops/internal-beta/bootstrap-host.sh` creates the dedicated deployment account,
installs reviewed Docker/Compose and certificate prerequisites, narrows the host
firewall, proves strict host-key and Ed25519 key access before it permits
password/root SSH hardening, and leaves cloud-console recovery intact.
`generate-secrets.sh` refuses overwrite and produces independent Cloud/Admin
datastore, key-ring, HMAC, OAuth/signing, Official Agent, quality, MinIO,
encrypted-backup, Payload, mTLS, and service-JWT material. The Admin Payload
secret is independently generated, collision checked, and written only to the
owner-controlled Admin environment. Only the offline-entitlement key ID and
32-byte public key leave the host-secret boundary.

`install-ip-certificate.sh` requires Certbot 5.4 or newer, proves staging IP
issuance before trusted short-lived issuance, then installs automatic renewal
and fail-closed Caddy reload. SMTP/SMS remain intentionally absent; enabled
registration is the isolated internal-Beta direct mode and does not assert
mailbox ownership.

The external operator record has a strict canonical schema. It can record exact
source SHAs, signed candidate digests and run URLs, package hashes, fixed
statuses/timestamps, certificate expiry, and coarse Mac/Windows versions. It
cannot record infrastructure addresses, credentials, identities, codes,
recovery phrases, prompts/responses, Profile paths, or logs.

Local policy and renderer tests establish the ceremony implementation only.
They do not claim that the real host was changed, a certificate was issued,
secrets were generated, a candidate was deployed, packages were built, or
physical-device acceptance passed. Each remains a separate later proof.

### Internal-Beta live acceptance boundary

Internal-Beta acceptance is one canonical, content-free record bound to exact
Cloud/Admin digests and the installed Mac/Windows package bytes.

`validateLiveEvidence` in
`scripts/internal-beta/verify-live-evidence.mjs` requires the exact Desktop,
Cloud, Admin, and unchanged Runtime identities; candidate manifest hashes and
Actions runs; direct-registration deployment state; short-lived certificate
expiry; four package hashes; both platform roles; and the complete fixed
success/rejection matrix. `parseAndValidateLiveEvidence` also rejects
noncanonical JSON, while package verification rehashes each local artifact and
refuses a symlink, changed size, or changed digest.

The schema and semantic validator cannot store credentials, emails, recovery
phrases, raw account/device identifiers, prompts/responses, Profile paths,
arbitrary notes, or logs. Beta.21 and later macOS candidates must pass
Gatekeeper without an override. Windows SmartScreen overrides remain a
one-time internal-only action after exact checksum verification and never
become a signing claim.

The release status remains `NOT_ACCEPTED` until the validator passes the
complete record against real candidates and bytes. Local tests define this gate
but do not claim a deployed host, built packages, physical Mac/Windows results,
backup migration, rollback, or acceptance.

## Hermes and data boundary

Quality, backup, and release failures cannot delay a conversation, revert local learning, mutate an active RuntimeBinding, overwrite a running Profile, or change `aera-runtime`.

Quality receives no private runtime content. Backup may contain explicitly allowlisted private Profile state only after client-side encryption and never exposes plaintext to Cloud or Admin. Production rollback preserves immutable versions, proposals, audit, ciphertext, key references, and existing Profile bytes.
