# Exact-byte production rollout

This runbook promotes the Cloud and Admin image digests already accepted in private staging, then publishes the signed Desktop candidate bytes already accepted on real devices. It does not rebuild, resign, renotarize, retimestamp, retag an image, change DNS, enable production, or publish a GitHub Release during local preparation.

The current implementation state is `local_verified`. Until remote CI, signed candidates, final private-staging evidence, physical-device evidence, production infrastructure, provider/domain/legal approval, four protected production runs, and explicit production authorization exist, promotion is `external_blocked`.

## Roles and authority

- **Release approver:** owns the protected `production` environment approval and is accountable for the final go/no-go decision. The approver must not be the person who prepared the evidence bundle.
- **Cloud operator:** executes exact-digest Cloud disabled and enabled runs, watches health, authentication, jobs, backup ingestion, object storage, and provider errors.
- **Admin operator:** executes exact-digest Admin disabled and enabled runs, watches dual authentication, RBAC, audit, Cloud compatibility, and mutation safety.
- **Desktop release operator:** verifies the signed candidate, device evidence, update metadata, tag target, and GitHub Release assets. This role cannot change candidate bytes.
- **Incident owner:** has authority to stop progression immediately and invoke the rollback runbook.

An approval permits the exact operation recorded in the canonical production gate. It does not prove a deployment succeeded and does not authorize a different digest, source SHA, feature cohort, domain, provider account, or public release.

## Immutable inputs

Freeze and record:

- Desktop source SHA, signed-candidate run ID, candidate-manifest SHA-256, version, notarized macOS hashes, Authenticode Windows hashes, update-metadata hashes, Runtime Seed lock hash, SBOM, provenance, and GitHub attestations;
- Cloud source SHA, candidate run ID, candidate-manifest SHA-256, `ghcr.io/bignormal/aera-cloud@sha256:...`, signature, provenance, schema range, and highest migration;
- Admin source SHA, candidate run ID, candidate-manifest SHA-256, `ghcr.io/bignormal/aera-admin@sha256:...`, signature, provenance, Admin schema range, and Cloud compatibility range;
- canonical device evidence and SHA-256;
- canonical private-staging evidence, detached Ed25519 signature, public key, and their SHA-256 values;
- final DNS HTTPS production origin and identity issuer;
- provider, legal, domain/TLS, backup/restore, monitoring, and change-ticket evidence links and hashes.

Every referenced Actions job must have a successful conclusion and at least one real, non-skipped step. A green shell, an empty job, a local log, a workflow list page, or a design document is not release evidence.

## Preproduction gates

Do not start a production run until all are true:

1. Remote CI is successful for the exact three source SHAs, with platform jobs actually executed.
2. Cloud/Admin candidate images and the Desktop candidate were built once from those SHAs.
3. Image signatures, image provenance, manifest signatures, Desktop signatures, notarization, timestamps, checksums, SBOMs, and provenance verify.
4. The four-device matrix passed for those exact Desktop hashes.
5. Private-staging acceptance passed for the exact Cloud digest, Admin digest, and Desktop candidate-manifest hash.
6. Encrypted database backup and disposable restore passed; backup ciphertext metadata and object inventory reconcile with zero missing and zero orphan objects.
7. Production database, Redis, object storage, CA, keys, providers, domains, and monitoring are independently provisioned and are not staging resources.
8. Privacy policy, terms, data-processing, retention/deletion, provider, DNS, TLS, and production change approvals are current.
9. A separate authorized user explicitly approved the production operations.

If any item is unavailable, record `external_blocked`; do not substitute local E2E or staging data.

## Required rollout order

Use the existing protected workflows in the Cloud and Admin repositories. Record every run ID.

### 1. Cloud exact digest, all new features disabled

Dispatch `bignormal/aera-cloud/.github/workflows/promote-production.yml` with the exact candidate run ID and source SHA:

- `enable_rollout=false`
- `enable_public_registration=false`
- `enable_official_agents=false`
- `enable_official_quality=false`
- `enable_encrypted_backup=false`

Require encrypted backup, disposable restore, exact digest verification, schema compatibility, health, authentication, read-only API, background-job, object-store, and disabled-feature smoke. Monitor for at least 30 minutes.

Stop on elevated 5xx/auth failure, migration discrepancy, queue backlog, object-store error, backup/restore failure, plaintext canary, unexpected provider call, or any feature being enabled.

### 2. Admin exact digest, mutations disabled

After the Cloud disabled run and its monitoring window complete, dispatch `bignormal/aera-admin/.github/workflows/promote-production.yml` with:

- the exact Admin candidate run ID and source SHA;
- `enable_mutations=false`.

Require compatible Cloud API/schema, exact digest verification, encrypted Admin backup and disposable restore, mTLS plus audience/scope-bound service JWT, browser authentication/MFA, RBAC, audit, masked read-only lookup, and explicit mutation rejection. Monitor for at least 30 minutes.

Stop on mTLS/JWT bypass, Cloud timeout treated as success, RBAC/audit gap, unexpected mutation, incompatible schema, or listener exposure.

### 3. Cloud approved cohort

After both disabled deployments pass, dispatch the same Cloud workflow again with the same candidate run ID and source SHA. Set only the separately approved flags. The recommended initial application cohort is 5%, never more than 10% for the first window:

- keep public registration disabled unless separately approved;
- enable official managed Agents only for the approved cohort;
- enable official quality only for the approved cohort;
- enable encrypted backup only for the approved cohort.

The workflow first returns the same digest to disabled state, repeats health/read-only proof, then enables the approved cohort. Monitor for at least 30 minutes. Expansion requires a new recorded approval and another full monitoring window.

### 4. Admin mutations

After the Cloud enabled run completes and remains healthy, dispatch the same Admin workflow again with the same candidate run ID and source SHA and `enable_mutations=true`.

The workflow must first re-prove the same disabled digest, Cloud compatibility, dual authentication, RBAC, audit, and mutation-disabled behavior. It may then enable mutations. Monitor for at least 30 minutes.

### 5. Desktop candidate cohort

Before public publication, distribute only the exact signed candidate files through the approved private candidate channel to the opted-in release cohort. Start at 5% of that approved cohort, never more than 10% for the first window, and monitor for at least 60 minutes.

Reverify installed hashes, macOS notarization/stapling, Windows Authenticode/timestamp, login, valid offline entitlement, Official Agent install/run/update/rollback, fixed existing RuntimeBindings, encrypted backup/create/restore/delete, updater behavior, restart, and privacy canaries.

The current GitHub updater metadata does not encode a public staged percentage. Therefore the 5% value applies only to the controlled candidate cohort. Do not claim a percentage-controlled public updater rollout. Publishing the GitHub Release is the broad public transition and occurs only after the candidate cohort and all production service windows pass.

### 6. Publish exact Desktop bytes

Run `.github/workflows/promote-release.yml` only after the four production runs above complete in this exact order:

1. Cloud disabled-only;
2. Admin disabled-only;
3. Cloud enabled;
4. Admin enabled.

The workflow verifies chronology, exact sources, nonempty successful jobs, candidate manifests, image digests, image and manifest signatures, provenance, device evidence, signed private-staging evidence, production gate, existing tag target, and every Desktop checksum/attestation. It also downloads the disabled and enabled `deployment-state.json` plus `current-manifest.json` artifacts from all four production runs. Publication stops unless both services report the exact approved source/digest in `production`, the disabled records show every new capability off, and the enabled records match the production gate flag-for-flag. A successful workflow conclusion without those state files is not sufficient evidence.

Cloud and Admin enablement are fail-closed. If the enabled health or smoke checks fail, the deployment scripts write disabled flags, re-apply the same digest, and re-run the disabled checks. If that recovery also fails, they stop the application instead of leaving an unknown or partially enabled state.

After those checks, the workflow downloads the Desktop candidate by its source workflow run ID and uploads only the already-built release files.

It never invokes Desktop compilation, Electron packaging, Runtime Seed preparation, signing, notarization, or metadata regeneration. The published files are:

- signed/notarized macOS DMG and ZIP;
- Authenticode-signed Windows installer and portable executable;
- exact `latest-mac.yml` and `latest.yml`;
- canonical candidate manifest;
- candidate checksum inventory;
- SPDX SBOM and canonical provenance.

If the tag already resolves to another commit or a Release already exists, the publisher stops. It does not overwrite an existing release or asset.

## Promotion descriptors

The protected workflow accepts one closed JSON descriptor for Cloud and one for Admin:

```json
{
  "candidateRunId": "CANDIDATE_RUN_ID",
  "disabledRunId": "DISABLED_PRODUCTION_RUN_ID",
  "enabledRunId": "ENABLED_PRODUCTION_RUN_ID",
  "imageDigest": "sha256:IMAGE_DIGEST",
  "manifestSha256": "CANDIDATE_MANIFEST_SHA256",
  "sourceSha": "SOURCE_SHA"
}
```

Use canonical field names exactly. Run IDs must be different positive integers. The disabled run must have a successful deploy job and a skipped enable job; the enabled run must have both jobs successfully execute.

## Protected evidence bundle

The supplied successful protected Actions artifact contains exactly the approved redacted records needed by the publisher:

- `device-evidence.json`
- `staging-acceptance.json`
- `staging-acceptance.sig`
- `staging-acceptance-ed25519.pub.pem`
- `production-gate.json`

Do not include credentials, cookies, private keys, recovery words, emails, account/device/Profile/RuntimeBinding/session/backup/object identifiers, prompts, responses, Memory, Skills, local paths, IPs, or database rows.

The production gate is canonical JSON with the exact shape below. Evidence URLs are redacted HTTPS records; each carries a SHA-256. `deploymentRuns` records the four runs already completed. The `approval` is a record of prior explicit authority; the protected `production` environment adds the final manual approval at execution time.

```json
{
  "admin": {
    "candidateManifestSha256": "ADMIN_MANIFEST_SHA256",
    "imageDigest": "sha256:ADMIN_DIGEST",
    "repository": "bignormal/aera-admin",
    "sourceSha": "ADMIN_SOURCE_SHA"
  },
  "approval": {
    "approvedAt": "2026-07-23T10:00:00Z",
    "approverIdentityRef": "employee:release-owner",
    "changeTicketUrl": "https://github.com/bignormal/aera/actions/runs/RUN_ID",
    "productionDeployApproved": true,
    "publicDesktopReleaseApproved": true,
    "responsibility": "release_approver"
  },
  "cloud": {
    "candidateManifestSha256": "CLOUD_MANIFEST_SHA256",
    "imageDigest": "sha256:CLOUD_DIGEST",
    "repository": "bignormal/aera-cloud",
    "sourceSha": "CLOUD_SOURCE_SHA"
  },
  "decision": "approved",
  "deploymentRuns": {
    "adminDisabledRunId": "ADMIN_DISABLED_RUN_ID",
    "adminEnabledRunId": "ADMIN_ENABLED_RUN_ID",
    "cloudDisabledRunId": "CLOUD_DISABLED_RUN_ID",
    "cloudEnabledRunId": "CLOUD_ENABLED_RUN_ID"
  },
  "desktop": {
    "candidateManifestSha256": "DESKTOP_MANIFEST_SHA256",
    "repository": "bignormal/aera",
    "sourceSha": "DESKTOP_SOURCE_SHA",
    "version": "DESKTOP_VERSION"
  },
  "domain": {
    "dnsApproved": true,
    "evidenceSha256": "DOMAIN_EVIDENCE_SHA256",
    "evidenceUrl": "https://github.com/bignormal/aera/actions/runs/RUN_ID/artifacts/ARTIFACT_ID",
    "identityIssuer": "https://identity.example.com",
    "productionOrigin": "https://api.example.com",
    "tlsValidated": true
  },
  "evidence": {
    "deviceEvidenceSha256": "DEVICE_EVIDENCE_SHA256",
    "stagingEvidenceSha256": "STAGING_EVIDENCE_SHA256",
    "stagingSignatureSha256": "STAGING_SIGNATURE_SHA256"
  },
  "legal": {
    "dataProcessingApproved": true,
    "evidenceSha256": "LEGAL_EVIDENCE_SHA256",
    "evidenceUrl": "https://github.com/bignormal/aera/actions/runs/RUN_ID/artifacts/ARTIFACT_ID",
    "privacyPolicyApproved": true,
    "termsApproved": true
  },
  "providers": {
    "emailReady": true,
    "evidenceSha256": "PROVIDER_EVIDENCE_SHA256",
    "evidenceUrl": "https://github.com/bignormal/aera/actions/runs/RUN_ID/artifacts/ARTIFACT_ID",
    "identityReady": true,
    "objectStorageReady": true,
    "observabilityReady": true,
    "paymentsReady": true,
    "productionCredentialsVerified": true
  },
  "rollout": {
    "adminMutationsEnabled": true,
    "cloudCanaryPercent": 5,
    "cloudMonitoringMinutes": 30,
    "desktopCanaryPercent": 5,
    "desktopMonitoringMinutes": 60,
    "encryptedBackupEnabled": true,
    "officialAgentsEnabled": true,
    "officialQualityEnabled": true,
    "publicRegistrationEnabled": false
  },
  "schemaVersion": 1
}
```

Canonicalize recursively, hash the exact UTF-8 bytes, and store the SHA-256 as the workflow input. Never edit the gate after approval; any change requires a new review, hash, and environment approval.

## Monitoring and expansion

At the end of each monitoring window, record the exact run/digest, start/end times, cohort, dashboards, alert outcomes, synthetic checks, backup/restore result, object reconciliation, and approver decision. Do not copy personal data into release evidence.

Minimum signals:

- API success/error/latency and authentication/refresh/device-revocation failures;
- official release install/run/update/rollback failures and RuntimeBinding drift;
- quality ingestion retry/error/threshold behavior and privacy canaries;
- encrypted-backup create/resume/restore/delete failures, committed/object mismatch, orphan/missing counts, and storage pressure;
- Admin mTLS/JWT failures, RBAC denials, approvals, audit writes, Cloud timeouts, and mutation state;
- Desktop crash, startup, update download/install, signature, Runtime Seed, login/offline, and backup outcomes.

No expansion is automatic. Each cohort change is a separate approved state transition. The public Desktop release occurs only after the final pre-public decision.

## Stop conditions

Stop immediately on:

- source, manifest, image, artifact, SBOM, provenance, signature, notarization, timestamp, tag, evidence, or installed-byte mismatch;
- failed/empty/skipped required run or incorrect rollout order;
- schema incompatibility, failed encrypted backup/disposable restore, destructive down migration, or object reconciliation mismatch;
- health, auth, device, provider, queue, storage, or monitoring regression beyond the approved threshold;
- mTLS/JWT/RBAC/audit bypass, public Admin/Internal listener, public database/Redis/object store, or Cloud unknown state reported as success;
- privacy canary, private-content upload, production/staging credential overlap, unexpected public registration, or unapproved provider call;
- existing RuntimeBinding mutation, Profile/local-learning loss, backup decryption failure, or chat corruption;
- missing independent approver, expired evidence, unavailable incident owner, or rollback path not ready.

Leave new flags/mutations disabled or invoke the rollback workflow. For a bad Desktop candidate, stop publication or update availability and create a higher-version corrective candidate from reviewed source. Never serve unsigned older bytes as a downgrade and never rewrite a published tag.

## State reporting

Report these independently:

- local implementation and tests;
- local commits;
- local merge;
- remote push;
- remote CI;
- candidate build/signing;
- real-device acceptance;
- private-staging acceptance;
- production authorization;
- Cloud disabled deployment;
- Admin disabled deployment;
- Cloud cohort enablement;
- Admin mutation enablement;
- Desktop public publication;
- monitoring completion;
- rollback rehearsal.

One state never implies a later state. Missing external evidence is `external_blocked`, not passed.
