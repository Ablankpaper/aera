# AgentEra Post-Official V1 Delivery Program Design

**Status:** Approved in the primary development conversation on 2026-07-23.

## Goal

Close the remaining architecture gaps after Official Managed Agent V1 without weakening Hermes Profile isolation, local self-learning, immutable RuntimeBinding behavior, or the default private-data boundary.

This delivery program contains three independently testable projects executed as one continuous development program:

1. Official Agent Privacy and Quality Feedback V1.
2. End-to-End Encrypted Backup and Cross-Device Migration V1.
3. Private Staging, Production Signing, Deployment, Rollback, and Release Readiness.

The projects share release gates but do not share payloads, encryption keys, storage tables, queues, or administrative permissions.

## Approved Decisions

- Official quality collection is disabled by default and applies only to `owner_scope=PLATFORM` Agents after explicit user authorization.
- Official quality data contains no prompt, response, tool payload, file content, raw error, stack trace, Memory, USER, Session, private Skill, Curator, credential, or Profile path.
- Quality data can create only a human-reviewed improvement proposal. It cannot train a model, modify an Agent draft, publish a version, or expand a rollout automatically.
- End-to-end backup uses recovery model A: one user-held 24-word recovery phrase plus separately authorized devices.
- The service never stores a plaintext backup root key, device private key, recovery phrase, or any key that can independently decrypt a user backup.
- Backup is an immutable snapshot and restore operation, not live Profile synchronization. Concurrent device histories branch and never merge automatically.
- Restore creates a new USER-owned Installation and a fresh physical Hermes Profile. It never overlays a running Profile.
- `aera-runtime` remains unchanged. Desktop adapters may invoke stable existing Hermes behavior, but no telemetry, backup transport, cloud key handling, or release control enters Hermes core.
- Production release remains a separately authorized external operation after code, local verification, remote CI, private staging, signing, real-device checks, and rollback rehearsal.

## Repository Responsibilities

### Desktop: `aera`

The desktop owns user consent, official-run provenance validation, event minimization, explicit feedback UI, local bounded outboxes, client-side encryption and decryption, recovery phrase handling, device backup keys, safe snapshot creation, staged restore, and real-device release validation.

The renderer never supplies owner scope, cloud identity, Profile paths, plaintext backup bytes, encryption keys, or quality-event provenance. Those values are resolved or produced in the trusted main process.

### Cloud: `aera-cloud`

Cloud owns strict public APIs, consent receipts, sanitized quality-event ingestion, rotating pseudonyms, thresholded aggregates, proposal source records, backup metadata, ciphertext object lifecycle, authorized-device public keys, wrapped-key envelopes, quotas, idempotency, audit, and production service composition.

Cloud validates ciphertext structure, hashes, signatures, quotas, and ownership without decrypting the backup archive.

### Admin: `aera-admin`

Admin owns thresholded quality dashboards, proposal triage, role-separated proposal approval, draft linkage, release-health views, deployment health, and existing immutable official publication, rollout, pause, and rollback controls.

Admin never receives individual user identities, event payloads below the anonymity threshold, raw backup objects, recovery material, or Hermes private content.

### Runtime: `aera-runtime`

Runtime remains unchanged. Hermes retains ownership of conversations, prompt stability, Memory, USER, background review, learned Skills, Curator, session persistence, and local adaptive-state semantics.

## Physically Separate Data Planes

### Quality Plane

The quality plane carries only version provenance, fixed result codes, bounded timing and token buckets, whitelisted crash codes, and explicit fixed-code feedback. It uses its own public endpoints, tables, retention jobs, consent checks, rate limits, pseudonymization keys, internal Admin read models, and audit actions.

### Backup Plane

The backup plane carries encrypted chunks, encrypted manifests, ciphertext hashes, device public keys, and wrapped-key envelopes. It uses separate endpoints, tables, object-store credentials, quotas, temporary-object cleanup, and audit actions. Backup payloads are never parsed by quality, search, Agent synchronization, or Admin review code.

### Control Plane

The existing Agent control plane remains authoritative for PLATFORM definitions, drafts, immutable versions, release revisions, eligibility, USER-owned Installations, and sanitized RuntimeBinding metadata. Quality proposals may link to a new platform draft only through an explicit employee action followed by the existing role-separated publication flow.

## Shared Invariants

- Every installed official Agent remains a USER-owned Installation mapped to one independent writable Hermes Profile.
- One conversation or isolated job receives one immutable RuntimeBinding at start. Quality, backup, update, rollback, and restore cannot mutate that binding.
- Feature unavailability never blocks an Agent conversation, local learning, or valid offline use.
- Missing consent, unknown protocol fields, invalid signatures, ambiguous ownership, stale revisions, DLP findings, or unavailable dependencies fail closed for the affected cloud action.
- User private data never becomes a normal Agent synchronization payload.
- Local backup plaintext exists only in a bounded staging transaction and is removed after success or failure.
- No server, employee, support workflow, audit record, log, trace, or error message receives backup plaintext or user recovery material.
- Application rollback preserves forward-compatible schema, immutable release history, encrypted backup objects, proposal history, and audit evidence.
- Local validation, commit, push, remote CI, staging deployment, production deployment, and public release are reported separately.

## Delivery Order

1. Implement quality consent, sanitized events, aggregation, Admin proposal review, and privacy E2E.
2. Implement backup keys, encrypted snapshots, object storage, restore, device authorization, and cross-device E2E.
3. Harden CI and release workflows, deploy both features disabled to private staging, run real-device and recovery drills, then perform separately authorized production rollout.

GitHub Actions billing recovery is an external prerequisite for remote CI. Development and local verification may continue while it is unresolved, but remote verification and production release cannot be declared complete.

## Release Completion

This program is complete only when each child specification passes its own acceptance gate and the production-readiness specification records the exact external evidence for remote CI, private staging, signatures, real devices, backup restore, rollback, production deployment, and public release.

The detailed requirements are defined in:

- `2026-07-23-agentera-official-agent-privacy-quality-feedback-v1-design.md`
- `2026-07-23-agentera-end-to-end-encrypted-backup-migration-v1-design.md`
- `2026-07-23-agentera-production-readiness-and-release-design.md`
