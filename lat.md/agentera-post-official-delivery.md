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

Task 6 local evidence is `src/main/agentera-official-quality/{db,model,minimizer}.test.ts`: 31 focused tests cover path isolation, permissions, schema shape, default-off consent, strict canonical serialization, bucket boundaries, replay safety, expiry, and future-schema refusal. This is local feature-branch evidence only; it is not a push, deployment, collection rollout, or production consent grant.

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

Task 8 local evidence covers strict IPC, independent consent, candidate expiry and revocation, renderer event scoping, default-off settings, fixed-code submission, and no-content canaries. This remains local feature-branch evidence only; it is not a push, deployment, production opt-in, or release.

### Quality privacy and regression evidence

The quality privacy gate locks the public envelope, private outbox, and production import boundary before every Desktop CI build.

`scripts/check-official-quality-boundary.mjs` verifies the exact 20-field public envelope, the exact 11-column private outbox, and every production import in the quality domain. It rejects content or identity fields and imports from Hermes Memory, private Skill, Curator, session-content, or attachment modules. The gate runs on every Desktop CI operating-system matrix entry.

[[tests/e2e/agentera-official-quality.e2e.ts]] composes the production SQLite privacy store, minimizer, collector, manager, Cloud client, and content-discarding chat observer around fixed local RuntimeBindings. Its deterministic Cloud fixture captures only protocol requests and cannot change product execution. The five acceptance cases prove default-off emits nothing, passive consent emits one minimized terminal envelope, explicit feedback is separately gated and fixed-code-only, network failure leaves chat successful with a retryable outbox row, and a new v2 RuntimeBinding does not mutate an existing v1 binding.

The 2026-07-23 local quality gate completed with these results:

- Desktop: 71 focused quality, IPC, settings, and chat tests; 5 Playwright protocol tests; Node and renderer typechecks; production Electron build; privacy boundary of 20 public fields, 11 outbox columns, and 7 production modules.
- Cloud: `go test -count=1 ./...` plus isolated PostgreSQL and Redis integration tests for `officialquality`, `adminapi`, and `jobs`.
- Admin: `make verify`, including 22 web files and 78 web tests, Go unit/integration/race checks, OpenAPI, E2E typecheck, and release builds. The real Admin-to-Cloud run passed 15 of 15 scenarios, including nine-subject suppression, ten-subject visibility, Developer proposal, different-Super-Admin approval, Developer clone to a normal draft, unchanged immutable versions/releases, unauthorized-role denial, and privacy-safe audit.

These are local feature-branch results. They do not mean local main merge, GitHub push, remote CI, staging deployment, production consent enablement, or public release. The Cloud HMAC feature remains disabled by default and no quality event is authorized to train, publish, alter rollout, mutate a RuntimeBinding, or enter Hermes learning.

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

`scripts/check-encrypted-backup-boundary.mjs` independently locks the cross-repository privacy boundary: Cloud tables and object metadata may contain only opaque ciphertext or public protocol metadata, while the Desktop allowlist excludes credentials and environment files and cannot call the Hermes backup mechanism.

The implementation checkpoints are:

- Desktop: `5440a7e`, `0d29df6`, `cdf37d4`, `e910bb5`, `d0c1d36`, `09e00bf`, the real-E2E device-identity fix `cfbe1f3`, and acceptance/CI commit `decc9c0`.
- Cloud: `acaead9`, `8b2d07a`, `a36542b`, `fddf990`, `d4a3807`, `e550d55`, the signed-time round-trip fix `8621c07`, and operations runbook `09c3d89`.
- Desktop gate: 31 focused files and 241 tests, Node and renderer typechecks, production Electron build, one full three-device Playwright scenario, the five-table/67-column cross-repository boundary, and `lat check`.
- Cloud gate: `go test -count=1 ./...` plus isolated PostgreSQL, Redis, and MinIO execution of `AERA_INTEGRATION_TESTS=1 go test -count=1 -p 1 ./internal/encryptedbackup ./internal/jobs`.
- Runtime boundary: `/Users/zizimutou/Desktop/aera/aera-runtime` remained clean on `c0439e1e3e5f35a91b658d57ddfc011e0d5ba1bb`.

This is local feature-branch evidence only. Desktop and Cloud have not thereby been merged to local `main`, pushed, accepted by remote CI, deployed to staging or production, enabled for production accounts, or publicly released. The separate `aera-runtime` checkout was not changed.

## Production readiness and release

Production delivery progresses through local verification, remote CI, private staging, signed candidates, real devices, restore and rollback rehearsal, disabled production deployment, bounded rollout, and separately approved public release.

Cloud and Admin images are built once from exact commits and promoted by digest. Desktop macOS Apple Silicon and Windows 11 x64 artifacts are signed once, verified on real devices, and published without rebuilding. Missing GitHub billing, production credentials, domains, providers, signing certificates, devices, or final authority remains an external gate rather than a code fallback.

The complete contract is `docs/superpowers/specs/2026-07-23-agentera-production-readiness-and-release-design.md`.

The executable CI, staging, signing, promotion, device-evidence, and rollback sequence is `docs/superpowers/plans/2026-07-23-agentera-production-readiness-and-release.md`.

### Remote CI safety checkpoint

`scripts/verify-ci-checkpoint.mjs` accepts only exact expected repository SHAs whose required platform jobs completed successfully after the commit and executed real steps.

The manual `rerun-ci-checkpoint.yml` workflow dispatches the existing repository CI workflows and records their GitHub URLs and job facts without carrying production secrets or changing a failed result. The latest Desktop and Cloud runs remain `external_blocked`: GitHub reported zero executed steps because recent account payments failed or the Actions spending limit must be increased.

### Signed Desktop candidate boundary

The Desktop candidate workflow builds signed distributable bytes once and cannot tag or publish them.

It requires exact-SHA successful CI, protected signing credentials, native macOS arm64 and Windows x64 runners, the exact locked Runtime Seed, Developer ID plus notarization and stapling evidence, Authenticode plus trusted timestamps, canonical updater metadata, an SPDX SBOM, provenance, checksums, and GitHub artifact attestation.

`release.yml` and `beta-release.yml` no longer contain build or publication paths; they can only invoke the candidate workflow. Local policy and workflow tests pass, but no remotely signed candidate exists while GitHub Actions is billing-blocked and protected Apple/Windows credentials have not executed. Local verification therefore proves the fail-closed pipeline contract, not signed bytes, device acceptance, staging deployment, or release.

### Real-device evidence boundary

Real-device approval is one canonical record bound to the exact candidate manifest and installed artifact hashes.

`release/evidence.schema.json` and `scripts/release/verify-device-evidence.mjs` require two different physical Apple Silicon Macs on consecutive supported macOS majors, one physical Windows 11 x64 machine, and a different physical or trusted-VM Windows 11 x64 environment. Duplicate device fingerprints, missing roles, unsigned bytes, wrong signer or timestamp, and evidence from another candidate fail closed.

Every role must pass the complete install/upgrade, online/offline, official Agent update/rollback and RuntimeBinding, quality privacy, encrypted-backup failure/restore, restart, and uninstall/reinstall matrix with two opaque QA account references and two opaque backup-device references. The exact-field schema excludes Profile paths, prompts, Memory, recovery words, secrets, raw device identifiers, and free-form notes.

The verifier and schema-policy tests pass locally. Real-device status remains `external_blocked` until one remotely signed candidate and the required physical/trusted devices, QA accounts, backup authorizations, and testers produce protected evidence.

### Private-staging acceptance boundary

Private-staging acceptance is one canonical Ed25519-signed manifest bound to exact Cloud/Admin image digests and the Desktop candidate-manifest digest.

`scripts/release/verify-staging-evidence.mjs` requires a final DNS HTTPS origin and issuer, VPN/tunnel/allowlist-only access, private Internal Admin dual authentication, non-public data services, disabled public registration, staging-only keys/data/providers, two accounts/devices, eight successful exact-SHA run URLs with real steps, and the closed scenario matrix.

The same manifest binds an encrypted database backup, disposable restore, object inventory with zero missing/orphan objects, and a feature-control rollback drill. Raw-IP issuers, public services, production credentials, skipped runs, failed scenarios, missing recovery, unknown fields, noncanonical JSON, wrong Ed25519 key IDs, or invalid detached signatures fail closed.

Official Agent, quality, and encrypted-backup E2Es now attach content-free `isolated_*_preflight` coverage summaries. Those attachments prove executable local coverage but cannot claim a deployed private-staging run. Actual staging acceptance remains `external_blocked` pending exact remote candidates, protected infrastructure, final DNS HTTPS, isolated secrets/providers/data, and signed protected run evidence.

## Hermes and data boundary

Quality, backup, and release failures cannot delay a conversation, revert local learning, mutate an active RuntimeBinding, overwrite a running Profile, or change `aera-runtime`.

Quality receives no private runtime content. Backup may contain explicitly allowlisted private Profile state only after client-side encryption and never exposes plaintext to Cloud or Admin. Production rollback preserves immutable versions, proposals, audit, ciphertext, key references, and existing Profile bytes.
