# AgentEra End-to-End Encrypted Backup and Cross-Device Migration V1 Design

**Status:** Approved in the primary development conversation on 2026-07-23.

## Purpose

Allow a user to create recoverable encrypted snapshots of one USER-owned Hermes Profile and restore a chosen snapshot on another authorized device without giving AgentEra Cloud, Aera Admin, an employee, or an object-storage provider the ability to decrypt it.

Backup is a separate ciphertext service. It is not Agent synchronization, Memory synchronization, live Profile replication, quality feedback, content donation, or a path around ExperienceCandidate review.

## Approved Recovery Model

V1 uses model A: a 24-word user-held recovery phrase plus separately authorized devices.

If the user loses every authorized device and the recovery phrase, the backup is permanently unrecoverable. Support and platform administrators have no recovery override, escrow key, hidden export, or reset path.

## Scope

V1 includes:

- account-level backup enablement and a confirmed 24-word recovery phrase;
- a backup encryption key pair for each authorized device, separate from authentication signing keys;
- one backup root key encrypted to the recovery phrase and each authorized device;
- one random data-encryption key for every immutable backup;
- safe Profile snapshot inventory, SQLite-consistent copy, compression, chunked authenticated encryption, resumable upload, atomic commit, retention, and deletion;
- manual backup and an explicit opt-in daily schedule;
- same-account backup listing and ciphertext download;
- recovery phrase and authorized-device enrollment of a new device;
- staged restore into a new USER-owned Installation and fresh physical Hermes Profile;
- branch-preserving cross-device history with no automatic merge;
- object-store isolation, quotas, cleanup, audit, and real cross-device E2E;
- complete proof that Cloud and Admin cannot decrypt or inspect backup content.

## Explicit Non-Goals

V1 does not include:

- live or bidirectional Profile synchronization;
- last-writer-wins Memory, USER, Session, Skill, or file replacement;
- automatic merge or conflict resolution;
- backup sharing across users, Workspaces, Organizations, or platform employees;
- restoring into a running or non-empty Profile;
- API keys, provider credentials, `.env`, OS keychain entries, AgentEra tokens, authentication private keys, or backup device private keys;
- external linked folders or arbitrary files outside the physical Profile;
- Runtime binaries, caches, logs, temporary files, generated read-only shared asset projections, or ordinary Agent control-plane caches;
- server-side decryption, scanning, indexing, preview, content DLP, or Admin download;
- recovery-key escrow or support-assisted plaintext recovery;
- changes to `aera-runtime`.

## Backup Content

One backup is bound to exactly one authenticated USER, one source device, one USER-owned Installation, one physical Hermes Profile, one Agent Definition provenance, and one Profile lineage.

The encrypted snapshot may include:

- `MEMORY.md` and `USER.md` for that Profile;
- Hermes-created private Skills, including restorable Skill archives;
- Session databases and conversation history;
- durable Curator state and archives;
- non-secret Profile configuration;
- attachment bytes already copied into the Profile's managed storage;
- encrypted provenance needed to interpret historical immutable RuntimeBindings.

The inventory excludes all secret, external, generated, transient, and machine-specific categories listed in Non-Goals. A checked-in versioned allowlist defines every accepted root and file class. Unknown roots are excluded rather than included by default.

Published official, Workspace, and Organization Knowledge, Skill, and SOP assets are not backed up. Restore reconstructs those read-only projections from the verified immutable AgentVersion.

## Snapshot Consistency

The existing full `hermes backup` archive is not uploaded because it may contain whole-home and secret material outside this V1 allowlist.

The desktop main process creates a dedicated Profile snapshot using trusted Installation-to-Profile mapping:

1. reject a source Profile with an active foreground conversation or isolated job;
2. prevent a new conversation from starting for the short snapshot transaction;
3. use SQLite online backup for every accepted database and exclude WAL, SHM, and journal sidecars;
4. open regular files without following links, capture size and file identity, stream and hash them, then recheck identity and metadata;
5. retry a file that changed during capture and abort the backup with a bounded code if it cannot stabilize;
6. reject symlinks, hard-link ambiguity, sockets, devices, FIFOs, path escape, Unicode normalization collision, case-fold collision, duplicate paths, oversized entries, or quota overflow;
7. write the plaintext snapshot only below a run-specific, permission-restricted temporary directory;
8. remove plaintext staging after encryption succeeds or fails.

Background Hermes learning is never disabled globally. If adaptive files remain busy, backup fails safely and can be retried without reverting or delaying local learning.

## Cryptographic Construction

All algorithms and formats are versioned in the backup envelope. V1 uses:

- 256 bits of CSPRNG entropy for the account Backup Root Key;
- a 24-word checksum-protected recovery phrase carrying 256 bits of entropy;
- Argon2id with a random per-account salt, 64 MiB memory, three iterations, one lane, and a 32-byte result to derive the recovery wrapping key;
- a dedicated X25519 key pair per authorized device;
- RFC 9180 HPKE with X25519, HKDF-SHA-256, and AES-256-GCM for device Root Key envelopes;
- one random 256-bit Data Encryption Key per backup;
- HKDF-SHA-256 domain-separated key derivation;
- AES-256-GCM authenticated encryption for the encrypted manifest and data chunks;
- SHA-256 ciphertext and plaintext inventory digests;
- the existing device Ed25519 authentication key only to sign the public upload envelope, never as an encryption key.

Every data chunk derives a separate AES key from the backup Data Encryption Key, backup ID, and chunk index. Each chunk uses a fresh 96-bit nonce and binds protocol version, user backup epoch, backup ID, encrypted-manifest digest, chunk index, total chunk count, and ciphertext length as authenticated associated data.

The plaintext manifest contains only relative normalized paths, file classes, sizes, digests, encrypted Agent/Profile provenance, lineage, parent backup, and format versions. It is encrypted before upload.

The public envelope exposes only values needed to transport and verify ciphertext: protocol and cipher-suite versions, opaque backup and key identifiers, chunk count, total ciphertext size, ciphertext digests, source-device public-key identifier, creation time, and signature. It contains no Profile name, Agent display name, file path, conversation metadata, or recovery phrase.

## Key Lifecycle

### First Enablement

The desktop generates the Backup Root Key and recovery phrase locally, derives the recovery wrapping key, creates the recovery envelope, creates the current device X25519 key pair, creates its device envelope, and uploads only public keys and encrypted envelopes.

The user must confirm randomly selected recovery words before enablement commits. Clipboard copy is an explicit action followed by a warning and best-effort clipboard clear. The phrase never enters renderer persistence, logs, telemetry, crash reports, Cloud requests, or Admin.

### Add Device

A new signed-in device generates its X25519 pair and presents a short-lived Cloud challenge. Enrollment succeeds through either:

- local recovery-phrase unwrapping followed by creation of the new device envelope; or
- an existing authorized device that verifies the challenge and HPKE-wraps the Root Key to the new public key.

Cloud checks same-account membership, active device status, challenge expiry, canonical keys, signatures, replay, and key-epoch revision but never receives the Root Key.

### Revoke Device

Revocation removes that device's Root Key envelope and blocks future backup listing and ciphertext download. It cannot erase plaintext or keys already exported by that device, and the UI states this limitation.

### Replace Recovery Phrase

An authorized device may create a new phrase and recovery envelope. The operation advances the key epoch with optimistic revision control and deletes the previous recovery envelope only after the new envelope is durably verified. It does not require re-encrypting backup payloads because the Backup Root Key remains unchanged.

V1 does not rotate a potentially compromised Root Key in place. The safe response is to create a new backup epoch, re-encrypt desired snapshots on an authorized device, and cryptographically delete the old epoch.

## Backup Encryption and Upload Flow

1. Resolve authenticated account, Installation, Profile, Agent provenance, current consent, quota, and schedule from trusted main-process state.
2. Create the allowlisted consistent plaintext snapshot.
3. Produce a canonical plaintext manifest and digest.
4. Compress accepted file streams before encryption.
5. Generate a backup Data Encryption Key and wrap it with the current Backup Root Key using a domain-separated AES-GCM envelope.
6. Encrypt the manifest and fixed-size chunks.
7. Ask Cloud for a short-lived multipart upload bound to backup ID, size, chunk count, expected ciphertext digests, device key, and idempotency key.
8. Upload chunks directly to a temporary random object prefix with checksums and resumable part state.
9. Ask Cloud to complete the backup. Cloud verifies ownership, device signature, upload expiry, object inventory, sizes, hashes, quotas, idempotency, and object-store consistency.
10. Commit metadata and immutable object reference transactionally, then make the backup visible.
11. Remove plaintext staging, local Data Encryption Key material, and upload temporary state.

An incomplete upload never creates a visible backup. A cleanup worker deletes expired temporary objects without touching committed ciphertext.

## Cloud Storage and Quotas

PostgreSQL stores only:

- backup account and epoch metadata;
- authorized device public keys and Root Key envelopes;
- recovery envelope and KDF parameters;
- immutable backup public envelopes and wrapped Data Encryption Keys;
- opaque object references, ciphertext digests, sizes, status, lineage hash, and retention state;
- idempotency, rate-limit, cleanup, and audit metadata.

Ciphertext lives in a dedicated S3-compatible bucket. Development and CI use an isolated MinIO instance. Production credentials and bucket policy are injected independently from database, quality, Agent artifact, and Admin credentials.

Object keys are random and reveal no account, Agent, Profile, Installation, device name, or path. Bucket policy permits only the Cloud backup service to issue bounded multipart operations. Admin has no object-read route.

V1 defaults are:

- maximum 1 GiB ciphertext per backup;
- three committed backups per Profile lineage;
- maximum 5 GiB committed ciphertext per account;
- one active upload per Profile;
- a 24-hour temporary-upload lifetime;
- manual backup plus an optional daily schedule;
- retention pruning only after a newer backup has committed successfully.

The server may lower a requested operation to configured quotas but cannot silently increase client-visible limits beyond deployment policy.

## Restore and Cross-Device Migration

The target device must be signed into the same active account and authorized for the backup epoch.

Restore performs:

1. select one immutable backup and display its locally decrypted metadata;
2. unwrap the Root Key and backup Data Encryption Key locally;
3. download every ciphertext object to a run-specific staging transaction;
4. verify the public signature, object hashes, encrypted manifest digest, every AEAD tag, manifest canonical form, inventory digests, size limits, path rules, file classes, and format compatibility;
5. resolve and verify the immutable Agent base version without trusting backup-provided cloud ownership;
6. create a new USER-owned Installation and empty physical Hermes Profile;
7. reconstruct read-only published projections through the existing verified projection path;
8. materialize private snapshot files only into the new Profile staging directory;
9. validate SQLite integrity and migration compatibility;
10. run an isolated local health check without starting a user conversation;
11. atomically activate the new Installation/Profile and record migration provenance;
12. remove all restore staging and key material.

Restore never overlays a running or non-empty Profile. A requested replacement is implemented as a new Profile plus an explicit later archive of the old Installation.

If the exact immutable Agent base cannot be verified, the decrypted snapshot remains quarantined only for the current transaction and is deleted when the operation ends. No partially restored Profile becomes selectable.

Historical RuntimeBinding metadata remains attached to restored sessions. A session can continue only when its exact immutable version and compatible Runtime are available; otherwise it is read-only. Restore never rewrites a historical binding to the newest version.

## Branching and Conflict Rules

Every backup belongs to a Profile lineage and may reference one parent backup. Restoring on another device creates a new lineage branch.

Two branches do not synchronize or merge automatically. The service never chooses a winner based on upload time. Users select the backup branch to restore. A later explicit ExperienceCandidate may promote selected learning across an owner boundary, but backup itself does not publish or share it.

## Deletion and Account Lifecycle

Deleting a backup first removes the wrapped Data Encryption Key and marks the backup cryptographically deleted. Ciphertext object cleanup follows asynchronously and is idempotent.

Account finalization removes recovery and device envelopes, wrapped backup keys, metadata, and object references, then schedules ciphertext deletion under the approved account-deletion retention policy. Audit retains only bounded deletion facts and opaque identifiers.

Neither Admin nor Support can restore a deleted key envelope or bypass account ownership.

## Failure Behavior

- Snapshot instability, disk exhaustion, path violations, quota overflow, encryption failure, or local cancellation removes only transaction-owned staging.
- Network interruption preserves only encrypted chunks and bounded resumable metadata; no plaintext is retained for retry.
- Wrong phrases, revoked devices, stale key epochs, envelope tampering, object corruption, missing chunks, AEAD failure, manifest mismatch, or incompatible versions fail before Profile activation.
- Cloud, object-store, or Admin unavailability never changes the source Profile or local learning.
- Restore failure removes the new staging Profile and leaves every existing Installation, Profile, RuntimeBinding, Session, Memory, USER, Skill, and Curator byte unchanged.
- Errors expose bounded codes and progress counts, not paths, filenames, keys, phrases, decrypted metadata, or raw crypto exceptions.

## Acceptance Gate

V1 is complete only when tests prove:

- Cloud, Admin, logs, audit, network captures, object metadata, and database rows contain no plaintext backup canary, recovery phrase, Root Key, Data Encryption Key, device private key, Profile path, filename, or secret;
- the server cannot decrypt a fixture backup with every server-side key and credential available to the test;
- `.env`, credentials, auth tokens, device signing keys, Runtime files, caches, logs, generated projections, external folders, links, special files, and path escapes never enter the plaintext inventory;
- SQLite snapshots remain consistent during permitted concurrent database writes;
- changing files either stabilize through bounded retry or abort without altering source data;
- interrupted multipart uploads resume from ciphertext only and expired temporary objects are cleaned safely;
- wrong phrase, wrong user, revoked device, stale epoch, replay, tampering, corruption, truncation, duplicate path, case collision, Unicode collision, zip bomb, and quota overflow fail closed;
- a successful second-device restore creates a new USER-owned Installation and distinct physical Profile with matching private-state hashes;
- official/shared projections are regenerated from the verified immutable version rather than copied from backup;
- historical RuntimeBindings stay fixed and incompatible historical sessions are read-only;
- two device branches remain distinct and no last-writer-wins or automatic merge path exists;
- backup, restore, deletion, and device enrollment failures leave Hermes local learning and existing Profile bytes unchanged;
- `aera-runtime` remains unchanged.
