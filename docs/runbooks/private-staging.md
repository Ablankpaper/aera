# Cross-repository private-staging acceptance

This runbook produces one signed, redacted acceptance manifest for exact Cloud, Admin, and Desktop candidates. It never treats local E2E, image build, deployment health, or private-staging access as public release evidence.

## Required inputs

Record these immutable inputs before deployment:

- successful remote CI URLs with real executed steps for the exact Cloud, Admin, and Desktop source SHAs;
- verified Cloud and Admin candidate workflow run IDs, manifest SHA-256 values, and `image@sha256:...` digests;
- the signed Desktop candidate run ID and canonical candidate-manifest SHA-256;
- the final DNS HTTPS staging origin and its separate DNS HTTPS identity issuer;
- a protected staging Ed25519 acceptance public key and its `ed25519:<SPKI SHA-256>` key ID;
- two dedicated staging accounts and at least two independently backup-authorized staging devices.

The staging key, CA, issuer, cookies, databases, Redis namespaces, object bucket, provider accounts, devices, and user records must be independent from production. Do not copy a staging credential or test record into production.

Current GitHub billing, missing protected candidates, absent staging infrastructure, or missing approval keeps this gate `external_blocked`.

## Local preflight is not staging acceptance

Before using infrastructure, run the deterministic cross-repository preflight from the exact Desktop source:

```bash
export AERA_OFFICIAL_AGENT_E2E_CLOUD_REPO="/approved/aera-cloud"
export AERA_OFFICIAL_AGENT_E2E_ADMIN_REPO="/approved/aera-admin"

npm run test:e2e:official-managed-agent
npm run test:e2e:official-quality
npm run test:e2e:encrypted-backup
```

The three suites attach content-free coverage summaries. They deliberately label themselves `isolated_*_preflight`; their passing output proves the executable contract but cannot populate a `private_staging` acceptance manifest. Actual staging observations must come from protected runs against the deployed digests and final origin.

## Deploy exact Cloud and Admin digests

Deploy Cloud first with every new feature disabled. Use exact candidate workflow run IDs and SHAs:

```bash
gh workflow run deploy-staging.yml \
  --repo bignormal/aera-cloud \
  --ref CLOUD_SOURCE_REF \
  -f candidate_run_id=CLOUD_CANDIDATE_RUN_ID \
  -f source_sha=CLOUD_SOURCE_SHA \
  -f enable_official_agents=false \
  -f enable_official_quality=false \
  -f enable_encrypted_backup=false
```

The protected Cloud runner must verify the candidate manifest, keyless Cosign identity/provenance, exact digest, encrypted database backup, disposable restore, migration compatibility, disabled flags, health, and read-only smoke before returning success.

Deploy Admin second with mutations disabled:

```bash
gh workflow run deploy-staging.yml \
  --repo bignormal/aera-admin \
  --ref ADMIN_SOURCE_REF \
  -f candidate_run_id=ADMIN_CANDIDATE_RUN_ID \
  -f source_sha=ADMIN_SOURCE_SHA \
  -f enable_mutations=false
```

The protected Admin runner must verify its exact manifest/digest, compatible Cloud API and migration, encrypted Admin backup and disposable restore, certificate/key material, mTLS, audience/scope-bound service JWT, RBAC, audit, masked lookup, and explicit `MUTATIONS_DISABLED` behavior.

Retain the redacted `deployment-state.json` and `current-manifest.json` artifacts from both runs. Do not retain environment files, certificate private keys, JWTs, database URLs, cookies, passwords, TOTP material, provider credentials, recovery words, Profile paths, or user content.

## Prove the private network boundary

Final acceptance uses the approved DNS HTTPS origin. Raw-IP, loopback HTTP, or self-signed exploratory sessions are disposable and cannot be the final issuer recorded in evidence.

On the staging host, record a redacted listener/firewall report:

```bash
set -euo pipefail
ss -lntp
docker network inspect "$AERA_CLOUD_ADMIN_PRIVATE_NETWORK"
docker compose -f /approved/cloud/compose.production.yaml ps
docker compose -f /approved/admin/compose.production.yaml ps
```

The report must prove:

- the Cloud browser/public listener is reachable only through VPN, SSH tunnel, or strict HTTPS allowlist;
- the Admin browser listener is loopback/private and not Internet-reachable;
- the Internal Admin listener has no public reverse-proxy route or host port and is reachable only from Admin on the private network;
- PostgreSQL, Redis, and object storage have no Internet listener;
- object-store public access is blocked;
- requests lacking the dedicated Admin client certificate fail before application authorization;
- requests with mTLS but missing, expired, wrong-issuer, wrong-subject, wrong-audience, or wrong-scope service JWT fail closed;
- either Cloud listener failing makes the Cloud deployment unavailable.

Run a probe from an approved but non-VPN/non-allowlisted external runner and require connection denial. Run the same health probe from inside the approved access path and require trusted HTTPS. Record only command outcomes, coarse addresses such as `private-network`, and hashes; redact host IPs if the protected evidence policy requires it.

Hash the redacted network report and store it at an HTTPS evidence URL without credentials, query parameters, fragments, or raw IPs. These become `networkBoundary.evidenceSha256` and `networkBoundary.evidenceUrl`.

## Prove staging-only safety

Use the secret manager's metadata API to compare secret identifiers, key fingerprints, CA fingerprints, database resource IDs, Redis users, bucket IDs, and provider account modes with the production register without retrieving or printing secret values.

Acceptance requires:

- `publicRegistrationEnabled=false`;
- `productionProviderCredentialsPresent=false`;
- `productionDataUsed=false`;
- `stagingOnlyKeysVerified=true`.

Attempt public registration through the final origin and require the documented disabled response. Test-provider workflows may be used only after their sandbox/test mode is independently verified.

## Execute the eight protected suites

Each suite entry must reference a successful GitHub Actions run for the exact source SHA, include a nonzero executed-step count, and hash its redacted evidence artifact. A run with zero steps, a skipped job, a local terminal log, or a search/list URL is invalid.

### `auth_device_offline`

With two staging accounts and two devices, prove login, device registration/list/revoke, refresh rotation, seven-day offline entitlement, and account recovery. Public registration remains disabled.

### `workspace_organization`

Prove Workspace and Organization lifecycle, invitations, roles, signed policy, offline read-only metadata, ownership transfer, and isolation from USER-owned Profiles, RuntimeBindings, sessions, Memory, Skills, and local learning.

### `official_managed_agent`

Prove PLATFORM draft creation, different-person approval, immutable v1/v2 versions, deterministic allowlist rollout, install/run, pause/resume, append-only rollback, valid offline use, and an existing RuntimeBinding remaining fixed while only later bindings use the selected release.

### `quality_governance`

Prove consent off/on/revoke, minimized content-free upload, explicit fixed-code feedback, retry without chat failure, ten-subject threshold suppression/visibility, proposal creation, different-person approval, clone to a normal draft, immutable release history, and no private canary in Desktop capture, Cloud rows, aggregates, Admin views, or audit.

### `encrypted_backup_migration`

Prove recovery enablement and phrase confirmation, separate-device authorization, manual and scheduled creation, interrupted/resumable upload, corruption/wrong-phrase/revoked-device rejection, authorized-device and phrase restore into fresh Profiles, cryptographic deletion, retention cleanup, and no plaintext canary in Cloud or object metadata.

### `admin_dual_auth_rbac_audit`

Prove browser authentication/MFA, backend RBAC, two-person approval, audit, read-only/masked lookup, mutation-disabled behavior, then the separately approved mutation exercise. Repeat the mTLS/service-JWT failure matrix and real Cloud timeout/404 behavior without mock success.

### `database_restore_object_reconciliation`

Create an encrypted Cloud PostgreSQL backup after the staging scenarios. Restore it into a disposable database, run schema and security-state checks there, and never point a live listener at it.

Export a stable object inventory and compare every committed backup metadata row with ciphertext objects and committed digests. Acceptance requires zero missing and zero orphan objects. Record only the encrypted-backup archive hash, redacted inventory hash, counts, and run URL.

### `release_control_rollback`

With the current exact digests, disable each new feature flag independently, pause and rollback the official release, and prove existing official conversations plus local Profiles remain usable and unchanged. Re-enable only the approved staging cohort after the checks. This feature-control drill is required for staging acceptance; the separate application-digest rollback rehearsal remains an additional later release gate.

## Enable only the approved staging cohort

After disabled-state and rollback checks pass, rerun the exact Cloud candidate deployment with only the approved staging flags enabled. The deploy script must first return to disabled state, reverify the same digest, and then enable:

```bash
gh workflow run deploy-staging.yml \
  --repo bignormal/aera-cloud \
  --ref CLOUD_SOURCE_REF \
  -f candidate_run_id=CLOUD_CANDIDATE_RUN_ID \
  -f source_sha=CLOUD_SOURCE_SHA \
  -f enable_official_agents=true \
  -f enable_official_quality=true \
  -f enable_encrypted_backup=true
```

Enable Admin mutations only for the approved exercise and only after the same-digest disabled dual-auth/RBAC/audit smoke passes:

```bash
gh workflow run deploy-staging.yml \
  --repo bignormal/aera-admin \
  --ref ADMIN_SOURCE_REF \
  -f candidate_run_id=ADMIN_CANDIDATE_RUN_ID \
  -f source_sha=ADMIN_SOURCE_SHA \
  -f enable_mutations=true
```

If either post-enable smoke fails, return mutations/features to disabled and leave the gate failed. Do not change the manifest to match a drifted deployment.

## Construct and sign the acceptance manifest

Create an exact-field JSON document accepted by `scripts/release/verify-staging-evidence.mjs`. It contains only:

- candidate repositories, exact source SHAs, candidate manifest hashes, and image digests;
- final staging origin and identity issuer;
- private-network booleans plus one redacted report hash/link;
- staging-only safety booleans and coarse test population counts;
- eight exact successful run records;
- the closed scenario boolean set;
- encrypted database backup/object inventory hashes and reconciliation counts;
- the acceptance Ed25519 public-key fingerprint and completion time.

Do not include user, administrator, account, device, Profile, RuntimeBinding, session, proposal, backup, object, hostname, IP, database, bucket, certificate, or secret identifiers. Do not include request bodies, prompts, responses, Memory, Skills, filenames, paths, recovery words, keys, tokens, cookies, emails, or free-form notes.

Canonicalize recursively by key and sign the exact UTF-8 bytes in a protected staging signing step. The private key stays in the staging secret manager; retain only the public key and base64 detached signature.

An approved runner can sign without printing key material:

```bash
export AERA_STAGING_EVIDENCE="/protected/staging-acceptance.json"
export AERA_STAGING_SIGNATURE="/protected/staging-acceptance.sig"
export AERA_STAGING_SIGNING_KEY_FILE="/secret-manager/mount/staging-acceptance-ed25519.pem"

node --input-type=module <<'NODE'
import { sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { canonicalJSONStringify } from "./scripts/release/candidate-manifest.mjs";

const raw = await readFile(process.env.AERA_STAGING_EVIDENCE, "utf8");
const document = JSON.parse(raw);
if (raw !== canonicalJSONStringify(document)) {
  throw new Error("staging acceptance manifest is not canonical JSON");
}
const privateKey = await readFile(
  process.env.AERA_STAGING_SIGNING_KEY_FILE,
  "utf8",
);
const signature = sign(null, Buffer.from(raw), privateKey).toString("base64");
await writeFile(process.env.AERA_STAGING_SIGNATURE, `${signature}\n`, {
  flag: "wx",
  mode: 0o600,
});
NODE
```

Verify from the exact Desktop source:

```bash
node scripts/release/verify-staging-evidence.mjs \
  /protected/staging-acceptance.json \
  --cloud-image-digest "sha256:CLOUD_DIGEST" \
  --admin-image-digest "sha256:ADMIN_DIGEST" \
  --desktop-candidate-manifest-sha256 "DESKTOP_MANIFEST_SHA256" \
  --cloud-source-sha "CLOUD_SOURCE_SHA" \
  --admin-source-sha "ADMIN_SOURCE_SHA" \
  --desktop-source-sha "DESKTOP_SOURCE_SHA" \
  --public-key /protected/staging-acceptance-ed25519.pub.pem \
  --signature /protected/staging-acceptance.sig
```

Upload the canonical JSON, detached signature, public key, and redacted referenced artifacts only to the protected staging workflow artifact/record. Never commit actual staging evidence.

## Stop conditions and state

Stop on any source/digest/manifest drift, skipped run, raw-IP issuer, untrusted TLS, public listener, public bucket, public registration, production credential/data match, dual-auth bypass, privacy canary, failed restore, missing/orphan object, RuntimeBinding change, or rollback failure.

Any source or artifact change invalidates the manifest and all downstream evidence. Until all external prerequisites and protected runs exist, the implementation state is `local_verified` and the private-staging acceptance state is `external_blocked`, not passed.
