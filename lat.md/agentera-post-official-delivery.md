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

## End-to-end encrypted backup V1

Encrypted backup stores immutable ciphertext snapshots for one USER-owned Installation and physical Profile; it is not Agent sync or live multi-device state replication.

One user-held 24-word recovery phrase and separately authorized X25519 devices wrap a client-only Backup Root Key. Every backup has its own Data Encryption Key, encrypted manifest, authenticated chunks, and random object identifiers. Cloud stores public keys, encrypted envelopes, hashes, sizes, quotas, and object references but cannot decrypt filenames, Agent/Profile metadata, conversations, Memory, USER, Skills, Sessions, or Curator state.

Restore verifies and decrypts into a transaction-owned staging directory, installs the exact immutable Agent base, and creates a new USER-owned Installation and fresh Profile. Different device histories remain explicit branches; no last-writer-wins or automatic merge path exists.

The complete contract is `docs/superpowers/specs/2026-07-23-agentera-end-to-end-encrypted-backup-migration-v1-design.md`.

The executable Cloud/Desktop implementation sequence is `docs/superpowers/plans/2026-07-23-agentera-end-to-end-encrypted-backup-migration-v1.md`.

## Production readiness and release

Production delivery progresses through local verification, remote CI, private staging, signed candidates, real devices, restore and rollback rehearsal, disabled production deployment, bounded rollout, and separately approved public release.

Cloud and Admin images are built once from exact commits and promoted by digest. Desktop macOS Apple Silicon and Windows 11 x64 artifacts are signed once, verified on real devices, and published without rebuilding. Missing GitHub billing, production credentials, domains, providers, signing certificates, devices, or final authority remains an external gate rather than a code fallback.

The complete contract is `docs/superpowers/specs/2026-07-23-agentera-production-readiness-and-release-design.md`.

The executable CI, staging, signing, promotion, device-evidence, and rollback sequence is `docs/superpowers/plans/2026-07-23-agentera-production-readiness-and-release.md`.

## Hermes and data boundary

Quality, backup, and release failures cannot delay a conversation, revert local learning, mutate an active RuntimeBinding, overwrite a running Profile, or change `aera-runtime`.

Quality receives no private runtime content. Backup may contain explicitly allowlisted private Profile state only after client-side encryption and never exposes plaintext to Cloud or Admin. Production rollback preserves immutable versions, proposals, audit, ciphertext, key references, and existing Profile bytes.
