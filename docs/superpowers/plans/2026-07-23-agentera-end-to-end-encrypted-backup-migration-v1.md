# End-to-End Encrypted Backup and Migration V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one authenticated user create immutable, end-to-end encrypted Hermes Profile backups and restore them on an authorized device or with a 24-word recovery phrase, while the server stores only ciphertext and never obtains a decryption key.

**Architecture:** Desktop creates a consistency-gated allowlisted snapshot of one local Profile, encrypts an authenticated manifest and fixed-size chunks with a random per-backup DEK, wraps the Backup Root Key for authorized X25519 device keys and a phrase-derived recovery key, signs the public upload envelope with the existing Ed25519 device identity, and uploads ciphertext to a dedicated Cloud object store. Cloud controls account ownership, quotas, lifecycle, metadata, and ciphertext objects without decrypting them. Restore always verifies and stages the snapshot before creating a new USER-owned Installation and a fresh Hermes Profile; it never overlays or auto-merges existing local state.

**Tech Stack:** Electron/TypeScript, Node crypto, better-sqlite3, `@noble/hashes`, `@scure/bip39`, `@hpke/core`, `@hpke/dhkem-x25519`; Go 1.26, PostgreSQL, chi, MinIO Go SDK with S3-compatible storage; MinIO for local/CI; Vitest, Go integration tests, Playwright.

## Global Constraints

- This is immutable backup, not live synchronization and not a replacement for Hermes learning.
- Include only allowlisted Profile-owned state: `memories/MEMORY.md`, `memories/USER.md`, private learned Skills, `state.db`, durable Curator state, non-secret Profile configuration, managed Profile attachments, and encrypted historical RuntimeBinding provenance.
- Exclude `.env`, `auth.json`, provider/API keys, OS keychain state, AgentEra tokens/keys, backup device private keys, runtime/cache/log/temp data, read-only shared projections, and files outside the Profile root.
- Never follow symlinks or junctions. Reject special files, path escape, Unicode/case collisions, unstable files after bounded retry, and any non-allowlisted entry.
- Backup creation requires no active foreground conversation/job and a short gate that prevents a new run until snapshot materialization finishes.
- Cryptography is versioned and test-vector backed: random 256-bit Backup Root Key, 24-word BIP39 phrase from 256-bit entropy, Argon2id 64 MiB/3 iterations/1 lane, HPKE RFC 9180 X25519+HKDF-SHA256+AES-256-GCM device envelopes, random 256-bit DEK per backup, HKDF-SHA256 domain separation, and AES-256-GCM manifest/chunks.
- Cloud never receives plaintext manifest, phrase, root key, DEK, device private key, or decrypted file bytes.
- Restore is same-account only and always creates a new USER-owned Installation plus fresh Profile. Existing Profiles and RuntimeBindings remain unchanged.
- Defaults: 1 GiB per backup, 3 backups per Profile lineage, 5 GiB per account, 1 active upload per Profile, incomplete upload expiry 24 hours, manual backup plus opt-in daily schedule.
- Delete the wrapped DEK/envelopes transactionally before asynchronous object deletion. Device revocation blocks future envelopes but cannot retract already downloaded ciphertext or keys.
- `aera-runtime` is not modified.

## File Structure

### Cloud: `/Users/zizimutou/Desktop/aera/aera-cloud`

- Add MinIO/S3 dependency in `go.mod` and `go.sum`.
- Create `migrations/000018_e2ee_profile_backup_v1.sql`.
- Create `internal/encryptedbackup/{model,repository,service,http,signature,object_store,minio_store}.go` and tests.
- Create `internal/config/encrypted_backup.go`; modify `internal/config/config.go`.
- Modify `internal/httpapi/server.go`, `cmd/aera-cloud/main.go`, `internal/jobs/postgres.go`, `.env.example`, `compose.yaml`, and CI.
- Modify `api/openapi.yaml`, API tests, and `internal/store/migrate_test.go`.

### Desktop: `/Users/zizimutou/Desktop/aera/aera`

- Add audited crypto dependencies to `package.json` and lockfile.
- Create `src/shared/agentera-encrypted-backup.ts`.
- Create `src/main/agentera-encrypted-backup/{db,key-store,crypto,manifest,snapshot,archive,client,manager,restore,scheduler,ipc-contract}.ts` and tests.
- Modify `src/main/runtime-activity.ts`, `src/main/app/start.ts`, `src/main/ipc/register.ts`, `src/main/ipc/auth-guard.ts`, preload contracts, Settings Data page, and agent-control Installation/Profile adapters.
- Add `tests/e2e/agentera-encrypted-backup.e2e.ts`, fixtures, boundary scripts, and CI entry.

---

### Task 1: Lock cryptographic formats with independent test vectors

**Consumes:** Approved cryptographic suite and Desktop Node runtime.

**Produces:** Versioned binary/JSON envelope formats and reproducible vectors before network or filesystem work.

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera/package.json`
- Modify: `/Users/zizimutou/Desktop/aera/aera/package-lock.json`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/crypto.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/crypto.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/fixtures/crypto-v1.json`

- [x] Add `@noble/hashes`, `@scure/bip39`, `@hpke/core`, and `@hpke/dhkem-x25519` at exact locked versions using `npm install --save-exact`; do not add a native Argon2 dependency.
- [x] Write fixed-vector tests for 256-bit entropy → 24 English BIP39 words → entropy round trip; invalid word/checksum rejection; Argon2id with 64 MiB, 3 iterations, 1 lane and a fixed salt; HKDF labels `agentera-backup-v1/root-recovery`, `.../manifest`, `.../chunk/{index}`; AES-256-GCM associated data; HPKE X25519 device wrap/unwrap; and tamper rejection.
- [x] Add a test proving recovery wrapping derives a 32-byte recovery KEK with Argon2id then AES-256-GCM encrypts the Backup Root Key with backup lineage and format version as associated data.
- [x] Run `npm test -- src/main/agentera-encrypted-backup/crypto.test.ts`; expect failure.
- [x] Implement only the v1 primitives and canonical base64url/byte-length validators. Make every decrypt authenticate before returning plaintext and zero mutable key buffers in `finally` blocks.
- [x] Run the test twice, once normally and once with `TZ=Pacific/Honolulu`, and expect identical vectors.
- [x] Commit in Desktop: `git add package.json package-lock.json src/main/agentera-encrypted-backup && git commit -m "feat: lock encrypted backup crypto v1"`.

### Task 2: Cloud metadata schema, quotas, and envelope destruction semantics

**Consumes:** Backup format identifiers and existing authenticated user/device tables.

**Produces:** Migration 18 with account-scoped devices, immutable backups, ciphertext chunks, key envelopes, and deletion states.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/migrations/000018_e2ee_profile_backup_v1.sql`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/store/migrate_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/encryptedbackup/repository_test.go`

- [x] Write migration tests expecting migration count 18 and tables `backup_devices`, `encrypted_profile_backups`, `encrypted_backup_chunks`, `encrypted_backup_key_envelopes`, and `encrypted_backup_operations`.
- [x] Run `go test ./internal/store -run 'TestEmbeddedMigrations|TestApplyMigrations' -count=1`; expect failure.
- [x] Add migration 18 with foreign keys to user/device and USER-owned installation/definition/version provenance, format/suite checks, byte-size checks, one active upload per `(user_id, profile_lineage_id)`, and immutable completed backup/chunk triggers.
- [x] Model upload states `initiated`, `uploading`, `sealed`, `deleting`, `deleted`, `expired`; only sealed backups are listable/restorable.
- [x] Store encrypted manifest object key/digest/size, public signed envelope, phrase-wrapped root key, and per-device HPKE root-key envelopes. Do not store any plaintext manifest or secret key.
- [x] Implement a SQL function used by deletion that nulls phrase/device root-key envelopes and encrypted DEK material, moves the row to `deleting`, and returns object keys for asynchronous cleanup in the same transaction.
- [x] Write integration tests for 1 GiB/backup, 3/lineage, 5 GiB/account, one active upload, 24-hour expiry, no cross-account reads, and envelope-null-before-object-delete ordering.
- [x] Run `AERA_INTEGRATION_TESTS=1 go test ./internal/store ./internal/encryptedbackup -count=1`; expect pass.
- [x] Commit in Cloud: `git add migrations/000018_e2ee_profile_backup_v1.sql internal/store/migrate_test.go internal/encryptedbackup/repository_test.go && git commit -m "feat: add encrypted profile backup schema"`.

### Task 3: Cloud S3-compatible ciphertext object store

**Consumes:** Migration 18 and S3/MinIO configuration.

**Produces:** A narrow object-store interface that never logs or buffers plaintext and supports deterministic cleanup.

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/go.mod`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/go.sum`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/encryptedbackup/object_store.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/encryptedbackup/minio_store.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/encryptedbackup/object_store_test.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/config/encrypted_backup.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/config/config.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/compose.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.env.example`

- [x] Add failing config tests for an explicit enable flag, endpoint, bucket, region, access key, secret key, TLS choice, and hard quota defaults. Production rejects plaintext non-loopback endpoints.
- [x] Define `ObjectStore` with only `PutCiphertext`, `GetCiphertext`, `HeadCiphertext`, and `DeleteCiphertexts`; keys are server-generated under `users/{opaque-user-id}/backups/{backup-id}/` and clients cannot choose them.
- [x] Add integration tests against a MinIO container for exact size/digest validation, overwrite rejection, range-independent full retrieval, missing object behavior, and idempotent delete.
- [x] Run `go test ./internal/config ./internal/encryptedbackup -count=1`; expect failure.
- [x] Add `github.com/minio/minio-go/v7`, implement streaming upload/download with bounded readers and SHA-256 verification, disable payload logging, and map object-store unavailability to retryable service errors.
- [x] Add MinIO to local Compose on an internal network with a test-only bucket initialization and no host port in CI.
- [x] Run focused unit/integration tests; expect pass.
- [x] Commit in Cloud: `git add go.mod go.sum internal/encryptedbackup internal/config compose.yaml .env.example && git commit -m "feat: add ciphertext object storage"`.

### Task 4: Cloud backup API, device authorization, sealing, restore, and deletion

**Consumes:** Auth claims, existing Ed25519 device identity, migration 18, object store.

**Produces:** Same-account API that verifies public envelope signatures and never decrypts ciphertext.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/encryptedbackup/model.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/encryptedbackup/signature.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/encryptedbackup/repository.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/encryptedbackup/service.go`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/encryptedbackup/http.go`
- Test: matching package tests
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/httpapi/server.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/cmd/aera-cloud/main.go`

- [x] Write service tests for registering an X25519 backup public key signed by the authenticated device's existing Ed25519 key; key replacement requires a fresh signature and monotonic revision.
- [x] Write lifecycle tests for initiate → chunks → encrypted manifest → device/recovery envelopes → seal, including digest/size mismatch, missing chunk, invalid signature, revoked source device, expired upload, quota, and replay.
- [x] Write restore authorization tests proving only the same authenticated account can list/download, revoked devices receive no newly created device envelope, and phrase recovery can download ciphertext without Cloud learning the phrase.
- [x] Write deletion tests proving envelopes disappear before object cleanup and a partial cleanup remains `deleting` for job retry.
- [x] Run `go test ./internal/encryptedbackup ./internal/httpapi ./cmd/aera-cloud -count=1`; expect failure.
- [x] Implement bounded routes under `/api/v1/encrypted-profile-backups`: device registration/revoke, initiate, chunk upload, manifest upload, seal, list/get, ciphertext download, add-device-envelope, and delete. Require access auth and current device proof on mutations.
- [x] Verify the source Ed25519 signature over canonical public envelope fields only: format/suite, backup ID, lineage ID, source device ID, official/user base provenance, ciphertext digests/sizes, and envelope digests. Never include or inspect plaintext.
- [x] Compose the handler independently in `cmd/aera-cloud/main.go`; disabled configuration returns feature unavailable and exposes no object credentials.
- [x] Run focused tests; expect pass.
- [x] Commit in Cloud: `git add internal/encryptedbackup internal/httpapi/server.go cmd/aera-cloud/main.go && git commit -m "feat: serve encrypted profile backups"`.

### Task 5: Cloud retention jobs and public OpenAPI

**Consumes:** Backup API and lifecycle states.

**Produces:** Automatic incomplete-upload cleanup, deleting-state retries, and pinned Desktop contract.

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/jobs/postgres.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/internal/jobs/postgres_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi.yaml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/api/openapi_test.go`
- Modify: `/Users/zizimutou/Desktop/aera/aera-cloud/.github/workflows/ci.yml`

- [x] Write maintenance tests for uploads older than 24 hours, oldest-sealed pruning beyond three per lineage, and retrying object deletion without resurrecting envelopes.
- [x] Write OpenAPI tests asserting ciphertext bodies are binary, metadata is exact, key/envelope fields are opaque base64url, and plaintext/profile paths/file names/content fields are absent from Cloud responses except encrypted manifest bytes.
- [x] Run `go test ./internal/jobs ./api -count=1`; expect failure.
- [x] Implement maintenance integration and exact OpenAPI routes/schemas.
- [x] Add MinIO startup and encrypted-backup integration tests to Cloud CI; stop and delete its volume in the existing always-run teardown.
- [x] Run `go test ./... -count=1`; expect pass.
- [x] Commit in Cloud: `git add internal/jobs api .github/workflows/ci.yml && git commit -m "test: close encrypted backup cloud lifecycle"`.

### Task 6: Desktop backup key store and device/recovery enrollment

**Consumes:** Crypto v1 and Electron `safeStorage`.

**Produces:** Per-account Backup Root Key, X25519 device identity, 24-word recovery setup, and renderer-safe state.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/agentera-encrypted-backup.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/key-store.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/key-store.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/db.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/db.test.ts`

- [x] Write tests for an absolute, mode-restricted `userData/agentera-encrypted-backup` domain outside `HERMES_HOME`, account-bound records, logout isolation, and corrupt-store fail-closed behavior.
- [x] Write tests proving private X25519 key and Backup Root Key are encrypted with Electron `safeStorage`; the phrase is returned exactly once during enrollment and is never persisted; only salt, parameters, nonce, and encrypted root-key recovery envelope persist/upload.
- [x] Write tests for device authorization state, device revocation, and no private-key export through shared/preload contracts.
- [x] Run `npm test -- src/main/agentera-encrypted-backup/key-store.test.ts src/main/agentera-encrypted-backup/db.test.ts`; expect failure.
- [x] Implement schema version 1 and key-store APIs `initializeAccount`, `getDevicePublicRegistration`, `wrapRootKeyForDevice`, `recoverRootKeyFromPhrase`, `authorizeDevice`, and `revokeDevice`.
- [x] Use separate X25519 backup keys; reuse the existing Ed25519 device identity only to sign the public registration/envelope digest.
- [x] Run focused tests; expect pass.
- [x] Commit in Desktop: `git add src/shared/agentera-encrypted-backup.ts src/main/agentera-encrypted-backup/{key-store,key-store.test,db,db.test}.ts && git commit -m "feat: add encrypted backup key ownership"`.

### Task 7: Desktop consistency gate and allowlisted snapshot builder

**Consumes:** One installed Profile, runtime activity coordinator, explicit allowlist.

**Produces:** Stable staged plaintext snapshot that cannot capture secrets or follow links.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/manifest.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/snapshot.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/snapshot.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/runtime-activity.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/runtime-activity.test.ts`

- [x] Write runtime coordinator tests proving `beginSnapshot()` fails while a run is active, blocks `beginRun()` while held, and always releases after success/error/cancel.
- [x] Build filesystem fixtures for all included roots and every excluded secret/cache/log/projection. Add symlink, junction-compatible reparse abstraction, FIFO/special-file, `..`, absolute path, case collision, NFC/NFD collision, and mutate-between-stat/read/restat cases.
- [x] Add a real better-sqlite3 fixture with WAL activity and test `database.backup(stagedStateDb)` yields a consistent queryable copy without copying `-wal`/`-shm` files.
- [x] Run `npm test -- src/main/runtime-activity.test.ts src/main/agentera-encrypted-backup/snapshot.test.ts`; expect failure.
- [x] Implement a manifest with normalized relative UTF-8 NFC paths, kind, mode class, size, SHA-256, and logical provenance. Use `lstat`, no-follow opens, containment checks, stable hash/restat with at most two retries, and a 1 GiB accumulated limit.
- [x] Allow only `memories/MEMORY.md`, `memories/USER.md`, `state.db` via online backup, validated non-secret keys from `config.yaml`, private learned Skill directories, durable Curator directories explicitly enumerated in the design spec, managed attachments, and an exported encrypted RuntimeBinding provenance record. Exclude `.env` and `auth.json` regardless of location.
- [x] Stage under `userData/agentera-encrypted-backup/transactions/{transaction-id}` with mode 0700/0600 and recursively remove it in `finally`; never invoke `runHermesBackup`.
- [x] Run focused tests; expect pass.
- [x] Commit in Desktop: `git add src/main/runtime-activity.ts src/main/runtime-activity.test.ts src/main/agentera-encrypted-backup/{manifest,snapshot,snapshot.test}.ts && git commit -m "feat: snapshot allowlisted profile state"`.

### Task 8: Desktop archive encryption, upload, scheduling, and local lifecycle

**Consumes:** Staged snapshot, root key, Cloud API.

**Produces:** Encrypted manifest/chunks, resumable upload, manual and opt-in daily backup.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/archive.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/archive.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/client.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/client.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/manager.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/scheduler.ts`
- Test: matching manager/scheduler tests

- [x] Write archive tests that split canonical file streams into 8 MiB plaintext chunks, derive a distinct key per manifest/chunk, use a fresh 96-bit nonce, bind backup ID/index/digest/size as AAD, and reject reorder/duplication/truncation/tampering.
- [x] Write client tests for initiate, resume missing chunks, seal, quota error, expired upload restart, logout cancellation, and exact binary size/digest headers.
- [x] Write scheduler tests: off by default, at most one daily attempt per Profile lineage, only when authenticated/online/idle, no catch-up storm, and failures never affect chat.
- [x] Run focused tests; expect failure.
- [x] Implement archive streaming so plaintext staging files are read once, ciphertext is written to the transaction directory, plaintext chunks are never written separately, and the random DEK is wrapped under the Backup Root Key before upload.
- [x] Sign the canonical public envelope digest with `signAgenteraDeviceDigest`; do not sign or log plaintext.
- [x] Persist only resumable ciphertext metadata locally; remove transaction plaintext immediately after encryption and ciphertext after verified seal or explicit cancel.
- [x] Run focused tests; expect pass.
- [x] Commit in Desktop: `git add src/main/agentera-encrypted-backup && git commit -m "feat: encrypt and upload profile backups"`.

### Task 9: Desktop verified restore into a new Installation and Profile

**Consumes:** Sealed ciphertext backup, authorized device key or phrase, agent-control installation/profile adapters.

**Produces:** Same-account staged restore that creates a new branch without overlay or automatic merge.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/restore.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/restore.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/manager.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-agent-control/installation-manager.ts`
- Test: matching agent-control tests

- [x] Write restore tests for device unwrap and phrase recovery, wrong account, wrong phrase, revoked device without envelope, tampered manifest/chunk, unavailable immutable base version, path collision, disk-full cleanup, and existing destination refusal.
- [x] Write integration tests proving a restore creates a new USER-owned Installation ID, fresh Profile ID/path, regenerated read-only projections, and an encrypted provenance link to the source backup/old immutable base without copying an old local RuntimeBinding as active.
- [x] Write compatibility tests: sessions whose historical runtime/version is unavailable remain present but read-only; no existing Profile, session database, Memory, Skill, or current RuntimeBinding changes.
- [x] Run `npm test -- src/main/agentera-encrypted-backup/restore.test.ts src/main/agentera-agent-control`; expect failure.
- [x] Implement download → envelope unwrap → authenticated decrypt → full manifest/hash verification → immutable base verification → staging → atomic fresh Profile rename → fresh Installation registration. If any step fails, delete staging and leave both old and new control-plane state unchanged.
- [x] Regenerate shared Knowledge/Skill/SOP projections from the verified current immutable version; never restore projection bytes from backup.
- [x] Run focused tests; expect pass.
- [x] Commit in Desktop: `git add src/main/agentera-encrypted-backup/restore.ts src/main/agentera-encrypted-backup/restore.test.ts src/main/agentera-agent-control && git commit -m "feat: restore backups into fresh profiles"`.

### Task 10: Desktop IPC, Settings UI, and user-safe recovery flow

**Consumes:** Backup manager and restore service.

**Produces:** Manual backup, opt-in schedule, device list, recovery setup, list/delete, and fresh-Profile restore UI.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-encrypted-backup/ipc-contract.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/app/start.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/register.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/auth-guard.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.d.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/components/settings/DataPane.tsx`
- Test: IPC and DataPane tests

- [x] Write exact-object IPC tests rejecting arbitrary paths, file lists, destination paths, secret fields, and Profile overlays. Only Installation IDs, backup IDs, fixed confirmations, schedule boolean, device IDs, and a 24-word phrase input are accepted.
- [x] Write UI tests for one-time phrase display with explicit written-down confirmation, no clipboard-by-default behavior, device authorization/revoke warning, quota state, manual progress/cancel, delete warning, and restore name/confirmation.
- [x] Run focused Vitest files; expect failure.
- [x] Compose the manager in `app/start.ts` with auth owner, `safeStorage`, runtime activity, Profile resolver, and agent-control adapter. Close its DB on app shutdown and owner switch.
- [x] Expose renderer-safe methods: `getState`, `initializeRecovery`, `confirmRecoverySaved`, `createBackup`, `cancelBackup`, `listBackups`, `deleteBackup`, `setDailySchedule`, `listDevices`, `revokeDevice`, `prepareRestore`, and `confirmRestore`.
- [x] Display the phrase only in the enrollment result object and replace it with a boolean state after the modal closes. Never emit it on event channels or logs.
- [x] Run focused tests plus `npm run typecheck`; expect pass.
- [x] Commit in Desktop: `git add src/main/agentera-encrypted-backup src/main/app/start.ts src/main/ipc src/preload src/renderer/src/components/settings/DataPane.tsx && git commit -m "feat: add encrypted backup and migration UI"`.

### Task 11: End-to-end backup, migration, and privacy proof

**Consumes:** Complete Cloud and Desktop implementations.

**Produces:** Deterministic proof of ciphertext-only server storage, fresh-Profile restore, and unchanged Hermes mechanisms.

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/agentera-encrypted-backup.e2e.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/check-encrypted-backup-boundary.mjs`
- Modify: `/Users/zizimutou/Desktop/aera/aera/package.json`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.github/workflows/ci.yml`
- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-post-official-delivery.md`
- Create: `/Users/zizimutou/Desktop/aera/aera-cloud/docs/runbooks/user-encrypted-backup-operations.md`

- [x] Write a boundary script proving the Cloud schema/object metadata contains no plaintext filename/content/phrase/root-key/DEK and Desktop snapshot code never calls `runHermesBackup` or includes `.env`/`auth.json`.
- [x] Write E2E with MinIO: create Profile data and an active immutable Agent base; create manual backup; inspect PostgreSQL and MinIO for absence of plaintext canaries; authorize a second device; restore; verify a new Installation/Profile; verify Memory/USER/private Skill/session contents; verify existing Profile byte hashes and RuntimeBindings are unchanged.
- [x] Add recovery E2E with only the 24 words, wrong-phrase rejection, ciphertext tamper rejection, deletion envelope destruction, and partial object cleanup retry.
- [x] Run `npm run test:e2e:encrypted-backup`; expect failure before fixture wiring.
- [x] Add only deterministic test fixtures and MinIO lifecycle setup; no production bypass or server-held recovery key.
- [x] Run Desktop: `npm test -- src/main/agentera-encrypted-backup src/main/runtime-activity.test.ts src/main/agentera-agent-control && npm run typecheck && npm run build && npm run test:e2e:encrypted-backup && node scripts/check-encrypted-backup-boundary.mjs`.
- [x] Run Cloud: `go test -count=1 ./... && AERA_INTEGRATION_TESTS=1 go test -count=1 -p 1 ./internal/encryptedbackup ./internal/jobs`.
- [x] Run `npm exec --yes --package=lat.md@0.12.1 -- lat check` and commit docs/CI in the owning repositories.

## Execution Record — 2026-07-23

Desktop implementation commits are `5440a7e`, `0d29df6`, `cdf37d4`, `e910bb5`, `d0c1d36`, and `09e00bf`. Real cross-repository execution found and fixed the Cloud-device identity mismatch in `cfbe1f3`; deterministic MinIO/Electron acceptance and CI wiring are in `decc9c0`.

Cloud implementation commits are `acaead9`, `8b2d07a`, `a36542b`, `fddf990`, `d4a3807`, and `e550d55`. Real restore found and fixed loss of the signed Desktop `created_at` value in `8621c07`; the operations and rollback runbook is `09c3d89`.

Fresh local verification passed:

- Desktop focused suite: 31 files and 241 tests.
- Desktop typechecks and production Electron build.
- Desktop real three-device E2E: one authorized-device restore, one phrase-only restore, wrong phrase, revoked device, interrupted upload/resume, tamper refusal, and key-first delete/object-cleanup retry.
- Cross-repository boundary: five Cloud tables, 67 ciphertext/public-metadata columns, digest-only MinIO metadata, and a fixed Desktop allowlist.
- Cloud full suite: `go test -count=1 ./...`.
- Cloud isolated integration: `AERA_INTEGRATION_TESTS=1 go test -count=1 -p 1 ./internal/encryptedbackup ./internal/jobs`.
- Documentation: `lat check`.
- Runtime: `/Users/zizimutou/Desktop/aera/aera-runtime` clean at `c0439e1e3e5f35a91b658d57ddfc011e0d5ba1bb`.

State ledger:

- local feature-branch commits: complete;
- local verification: complete;
- local `main` merge: not performed;
- remote push: not performed;
- remote CI: not run;
- private staging deployment: not performed;
- production deployment or feature enablement: not performed;
- public release: not performed.

## Final Acceptance Evidence

- [x] Demonstrate both restore paths: authorized second device and 24-word phrase.
- [x] Demonstrate Cloud database and object store contain only opaque ciphertext/envelopes and public metadata.
- [x] Demonstrate backup failure, upload failure, restore failure, and device revoke never change existing Profile data or interrupt chat/local learning.
- [x] Demonstrate delete removes envelopes first and eventually removes every ciphertext object.
- [x] Record Desktop and Cloud commits, local verification, local main merge, push, remote CI, deployment, and release as separate states.
- [x] Confirm `/Users/zizimutou/Desktop/aera/aera-runtime` is unchanged.
