# Cross-repository rollback rehearsal

This runbook proves that compatible Cloud and Admin application images can move from current candidate B to previous candidate A and back to the exact B digests without a down migration, data loss, RuntimeBinding rewrite, or interruption of local Hermes learning.

The automation and evidence verifier are `local_verified`. A real rehearsal remains `external_blocked` until exact signed A/B candidates, protected private-staging infrastructure, staging approvers, object storage, two accounts/devices, and executed Actions runs exist. Local fixtures or mocked commands cannot satisfy this gate.

## Authority and isolation

- Run only in the protected `staging` environment with staging-only database, Redis, object store, CA, service identities, signing keys, providers, accounts, and Desktop homes.
- Keep public registration disabled and every listener/data service behind the approved VPN, tunnel, private network, or allowlist.
- Name one rehearsal approver and one incident owner. The operator preparing evidence cannot approve their own manifest.
- Do not run the production option, deploy, publish, change DNS, rotate keys, or expose a listener under this runbook.
- Never copy credentials, recovery words, private keys, account/device/Profile/RuntimeBinding/session/backup/object identifiers, prompts, responses, Memory, Skills, local paths, IPs, database rows, or ciphertext into the evidence manifest.

## Freeze exact inputs

Record before starting:

- Cloud current B and previous A source SHAs, candidate run IDs, canonical manifest SHA-256 values, signed image digests, schema minimum/maximum, and highest migrations;
- Admin current B and previous A equivalents plus the Cloud Internal API/schema compatibility range;
- Desktop source SHA, version, candidate-manifest SHA-256, and signed/notarized/AuthentiCode artifact hashes;
- the current staging database migration levels, active image digests, feature/mutation state, object inventory hash, and rollback workflow source SHAs;
- before-digests for the selected synthetic Profile, Memory, USER, Session, learned Skill, Curator, published projection, and fixed RuntimeBinding fixtures.

Candidate A must be signed and attested, must differ from B, and must declare compatibility with the schema already applied by B. A failed signature, expired signing evidence, unknown digest, mutable tag, incompatible maximum migration, or dirty/unbound candidate is a stop condition.

## Prepare recoverable data

1. Deploy exact current Cloud B and Admin B candidates to private staging with public registration disabled.
2. Create synthetic data that exercises B's additive schema: authentication/device state, immutable official releases, one existing v2 RuntimeBinding/session, threshold-safe quality records, an encrypted backup, wrapped device/phrase recovery material, and committed ciphertext objects.
3. Create an encrypted PostgreSQL backup and hash the ciphertext archive.
4. Restore it into a disposable database, verify identity/key references, and destroy only that disposable target.
5. Export the object inventory and reconcile every committed backup row to one ciphertext object. Require zero missing and zero orphan objects.
6. Restore and decrypt one backup on an authorized client into a fresh Profile. The server must not obtain plaintext.
7. Finish both backup and disposable restore before the recorded drill start.

Do not start the digest switch if backup, disposable restore, object reconciliation, or client decryption is incomplete.

## Rehearse Cloud A and restore B

Dispatch `Ablankpaper/aera-cloud/.github/workflows/rollback-production.yml` with:

```text
target_environment=staging
previous_candidate_run_id=<CLOUD_A_CANDIDATE_RUN_ID>
previous_source_sha=<CLOUD_A_SOURCE_SHA>
current_candidate_run_id=<CLOUD_B_CANDIDATE_RUN_ID>
current_source_sha=<CLOUD_B_SOURCE_SHA>
restore_current_after_rehearsal=true
reason=private staging rollback rehearsal
ticket=<REDACTED_APPROVED_CHANGE_REFERENCE>
```

The protected workflow verifies both candidate identities and signatures. The rollback script:

1. checks health on B;
2. disables public registration, Official Agents, quality, and encrypted backup;
3. creates and disposable-restore-verifies another encrypted database backup;
4. checks A's schema maximum against B's applied migration;
5. pulls and starts exact A without a down migration;
6. runs the configured staging smoke against auth, official reads, quality reads, encrypted-backup reads, jobs, and ciphertext objects;
7. records the B → A evidence;
8. re-verifies B, deploys exact B with all new features disabled, repeats backup/restore and smoke, and records the A → B restoration.

Require both `cloud-staging-rollback-<RUN_ID>` and `cloud-staging-rehearsal-restore-<RUN_ID>` artifacts. The final `deployment-state.json` must report `environment=staging`, exact B source/digest, and every new feature disabled.

## Rehearse Admin A and restore B

First disable Admin mutations and the affected worker. Then dispatch `Ablankpaper/aera-admin/.github/workflows/rollback-production.yml` with the same input pattern using Admin A/B identities.

The Admin workflow must prove health before change, encrypted backup/disposable restore, A signature and Admin-schema compatibility, mounted mTLS/service-JWT material, real Cloud compatibility, dual authentication, browser/read-only access, RBAC/audit reads, and mutation rejection on A. It then re-verifies and restores exact Admin B with mutations disabled.

Require both Admin rollback/restoration artifacts. The final state must report exact Admin B, `environment=staging`, Cloud dual authentication and compatibility passed, restore verification passed, and `mutationsEnabled=false`.

Any unknown Cloud state, mTLS/JWT failure, one-listener failure, missing audit/RBAC proof, or failed B restoration is a failed rehearsal. Do not convert it into an available Admin state.

## Official Agent and Desktop response

While the selected existing session is fixed to v2:

1. pause the v2 release;
2. append an approved rollback release revision to v1 without editing or deleting v1/v2 history;
3. verify the existing session and RuntimeBinding remain byte-identical and continue using v2;
4. verify only a new RuntimeBinding selects the rollback release;
5. hash the immutable release history and RuntimeBinding evidence.

For a bad Desktop candidate:

1. stop candidate distribution and public publication;
2. remove only update discovery/metadata for the bad unpublished candidate;
3. never rewrite a release tag, overwrite signed assets, or serve an unsigned older downgrade;
4. produce a higher semantic version from reviewed source;
5. sign/notarize macOS and Authenticode-sign/timestamp Windows again;
6. repeat candidate, device, staging, and approval gates before publication.

If a bad version was already public, preserve its tag/assets for audit and publish a higher signed corrective version. GitHub Release deletion or tag rewriting is not rollback.

## Required failure injections

Run each failure against synthetic staging state and save only redacted hashes/URLs:

- **Object-store outage:** new backup/restore initiation is unavailable; conversation and local Profile continue; no committed row is reported complete without its object.
- **Admin-to-Cloud mTLS failure:** Admin reads/mutations remain unavailable; Cloud timeout or unknown state never becomes success.
- **Expired signing evidence:** candidate/rollback verification rejects before Docker or publication changes.
- **Failed notarization:** the macOS candidate is not distributable and no unsigned fallback is emitted.
- **Incomplete backup cleanup:** deletion remains pending/retryable until object inventory reaches zero; recovery material stays cryptographically destroyed and no false completion is reported.

Each record requires `triggerObserved=true`, `operationRejected=true`, `unsafeStatePublished=false`, `chatContinued=true`, and `localLearningUnchanged=true`.

## Assemble and verify evidence

Create canonical UTF-8 JSON matching the exact fields enforced by `scripts/release/verify-rollback-evidence.mjs`. It binds:

- exact Cloud/Admin A/B and Desktop candidate identities;
- drill/backup/restore timestamps;
- encrypted database backup, disposable restore, forward-only schema, additive-data reads, object reconciliation, ciphertext read, and client decryption;
- successful real Cloud/Admin/Desktop run URLs with executed steps;
- B → A → B digests, signatures, compatibility, health, and read checks;
- append-only Official Agent rollback and unchanged existing RuntimeBinding;
- safe Desktop withdrawal and higher signed corrective candidate;
- all five fail-closed injections;
- identical before/after hashes for Profile, Memory, USER, Session, learned Skill, Curator, published projection, and RuntimeBinding.

Canonicalize first, then sign the exact bytes with the protected staging Ed25519 evidence key. Keep the private key outside source control:

```bash
node --input-type=module <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
import { canonicalJSONStringify } from "./scripts/release/candidate-manifest.mjs";

const path = process.env.ROLLBACK_EVIDENCE_PATH;
const document = JSON.parse(await readFile(path, "utf8"));
await writeFile(path, canonicalJSONStringify(document), { mode: 0o600 });
NODE
openssl pkeyutl -sign -rawin \
  -inkey "$ROLLBACK_EVIDENCE_PRIVATE_KEY" \
  -in "$ROLLBACK_EVIDENCE_PATH" \
  -out "$ROLLBACK_EVIDENCE_SIGNATURE"
```

Verify the stored hash, exact candidates, structure, time order, and signature:

```bash
node scripts/release/verify-rollback-evidence.mjs \
  --evidence "$ROLLBACK_EVIDENCE_PATH" \
  --evidence-sha256 "$ROLLBACK_EVIDENCE_SHA256" \
  --signature "$ROLLBACK_EVIDENCE_SIGNATURE" \
  --public-key "$ROLLBACK_EVIDENCE_PUBLIC_KEY" \
  --cloud-current-source-sha "$CLOUD_B_SOURCE_SHA" \
  --cloud-current-image-digest "$CLOUD_B_IMAGE_DIGEST" \
  --cloud-previous-source-sha "$CLOUD_A_SOURCE_SHA" \
  --cloud-previous-image-digest "$CLOUD_A_IMAGE_DIGEST" \
  --admin-current-source-sha "$ADMIN_B_SOURCE_SHA" \
  --admin-current-image-digest "$ADMIN_B_IMAGE_DIGEST" \
  --admin-previous-source-sha "$ADMIN_A_SOURCE_SHA" \
  --admin-previous-image-digest "$ADMIN_A_IMAGE_DIGEST" \
  --desktop-source-sha "$DESKTOP_SOURCE_SHA" \
  --desktop-candidate-manifest-sha256 "$DESKTOP_CANDIDATE_MANIFEST_SHA256"
```

Store the evidence JSON, detached signature, public key, SHA-256, workflow artifacts, and reviewer decision in the protected release record. A verifier test fixture proves only the fail-closed contract; only these executed private-staging records can set rollback rehearsal to `passed`.

## Stop and recovery conditions

Stop immediately on any signature, source, digest, manifest, schema, timestamp, health, backup, restore, object, decryption, run, or preserved-state mismatch. Leave features/mutations disabled.

If A fails but B is healthy, restore exact signed B and preserve the failed evidence. If B restoration fails, keep the compatible A service disabled/private, stop the affected application when health is unknown, and escalate to the incident owner. Do not down-migrate, delete additive data, remove referenced keys, mutate an existing RuntimeBinding, restore server-side plaintext, or change `aera-runtime`.
