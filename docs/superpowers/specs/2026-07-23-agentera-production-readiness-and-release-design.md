# AgentEra Private Staging, Production Readiness, and Release Design

**Status:** Approved in the primary development conversation on 2026-07-23.

## Purpose

Turn the locally verified Agent control plane, Official Agent quality pipeline, and encrypted backup service into a reproducible private-staging and production delivery process with explicit signing, secret, real-device, recovery, rollback, and publication evidence.

This specification does not treat code completion as deployment and does not treat deployment as public release.

## Starting State

Desktop, Cloud, and Admin `main` are pushed and synchronized with their GitHub remotes. Runtime remains unchanged. Local Official Managed Agent verification has passed.

The current Desktop and Cloud GitHub Actions jobs exit before their first step because the GitHub account reports failed recent payments or an insufficient Actions spending limit. Repository code cannot resolve that account billing state.

Cloud already contains production-shaped Compose, encrypted PostgreSQL backup, disposable restore verification, private staging, production runbooks, strict production configuration checks, and Internal Admin isolation. Desktop already contains macOS and Windows beta/stable build workflows and Runtime Seed verification. This program hardens and executes those foundations for the newly approved features.

## Scope

This program includes:

- restoration and rerun of remote Cloud and Desktop CI after the account owner resolves GitHub billing;
- CI coverage for quality feedback, encrypted backup, object storage, privacy boundaries, cross-repository contracts, and real service E2E;
- protected GitHub staging and production environments;
- immutable Cloud/Admin images and Desktop artifacts tied to exact commits;
- private staging with PostgreSQL, Redis, S3-compatible object storage, Cloud public API, Cloud Internal Admin API, and Aera Admin;
- independent staging and production key sets, certificate authorities, service identities, object-store credentials, and signing material;
- macOS Apple Silicon and Windows 11 x64 signed Desktop artifacts;
- software bill of materials, hashes, provenance, release manifest, and artifact promotion without rebuild;
- physical-device and trusted-VM verification;
- encrypted database restore and ciphertext object reconciliation drills;
- staged feature enablement and official Agent allowlist rollout;
- application, feature, data, and Desktop rollback rehearsal;
- separately authorized production deployment and public release.

## Explicit Non-Goals

This program does not:

- charge a payment method, modify a GitHub spending limit, purchase a certificate, create a production domain, complete regulatory filing, contract an email/SMS/CAPTCHA or object-storage provider, or accept legal terms on the user's behalf;
- commit production secrets, certificates, recovery keys, or provider credentials;
- bypass a missing external credential with development material;
- expand the supported Desktop production matrix to Linux;
- publish unsigned or unnotarized Desktop artifacts;
- expose Aera Admin or the Internal Admin listener to the public Internet;
- enable public registration before production launch gates pass;
- declare production release from local, simulated, or dry-run evidence;
- change `aera-runtime`.

## Delivery State Vocabulary

Every checkpoint reports exactly one or more independently proven states:

1. `designed`;
2. `implemented_on_feature_branch`;
3. `locally_verified`;
4. `merged_to_local_main`;
5. `pushed_to_origin_main`;
6. `remote_ci_verified`;
7. `private_staging_deployed`;
8. `private_staging_accepted`;
9. `release_candidate_signed`;
10. `real_device_verified`;
11. `production_deployed_disabled`;
12. `production_feature_rollout`;
13. `public_release_published`.

No state implies a later state.

## CI Architecture

### Required Repository Gates

Cloud requires formatting, Go tests, race checks, vet, OpenAPI validation, browser tests, strict secret/delivery checks, PostgreSQL/Redis integration, MinIO integration, database encrypted-backup restore, ciphertext reconciliation, image build, and boundary scans.

Admin requires formatting, Go tests, race checks, typecheck, web tests, production build, OpenAPI validation, real-Cloud mTLS/service-JWT E2E, quality proposal role tests, and fail-closed upstream behavior.

Desktop requires Cloud contract pinning, typecheck, unit and integration tests, boundary tests, build, dependency audit, Runtime Seed verification, quality/consent E2E, encrypted-backup E2E, cross-device restore E2E, and macOS/Windows packaging dry runs.

The cross-repository gate starts isolated Cloud, Admin, PostgreSQL, Redis, MinIO, and two Desktop users. It uses temporary accounts, certificates, keys, buckets, Profiles, and process roots and removes only resources carrying the run identifier.

### Protected Environments

GitHub defines `staging` and `production` environments.

- Pull-request and ordinary branch workflows receive no staging or production secrets.
- Staging deployment is manual and requires the exact remote-CI-verified commit set.
- Production image promotion and Desktop publication require environment approval.
- Production jobs use least-privilege OIDC or environment-scoped credentials and cannot print secret values.
- Concurrency permits only one staging deployment and one production deployment at a time.
- A cancelled deployment runs bounded cleanup and records the unchanged prior version.

### Current Billing Blocker

After the account owner restores payment or increases the Actions limit, the exact failed Cloud and Desktop main runs are rerun first. If GitHub cannot rerun them because the workflow revision has advanced, a new main run at the same verified source commits is triggered and recorded.

Until jobs execute real steps, the status remains `pushed_to_origin_main`, not `remote_ci_verified`.

## Environment Topology

### Private Staging

Private staging contains independent Cloud, Admin, PostgreSQL, Redis, and S3-compatible object-storage resources. It is reachable only through VPN, SSH tunnel, or trusted HTTPS with a strict developer allowlist.

Cloud public API remains loopback/private-proxy bound. Internal Admin uses a different private listener with a dedicated mTLS CA and short-lived audience/scope-bound Ed25519 service JWT. Admin is reachable only through the approved company identity network or equivalent zero-trust access.

Public registration remains disabled. Test provider accounts, test legal versions, test signing keys, and staging-only buckets are used. No staging issuer, cookie, database, Redis namespace, key, CA, device, object, or account is promoted to production.

### Production

Production uses the existing isolated AgentEra Cloud application boundary with a dedicated database, Redis user/namespace, object bucket, public HTTPS origin, Internal Admin listener, Admin workload, secret manager, and backup destination.

The object bucket enables encryption at rest in addition to client ciphertext, versioning, blocked public access, least-privilege service access, multipart cleanup, and a daily inventory used for metadata/object reconciliation. Provider-side encryption is defense in depth and is not the user's end-to-end encryption boundary.

## Secret and Signing Key Ceremony

Production creates independent versioned material for:

- identity-field encryption;
- exact-lookup HMAC;
- OAuth state encryption;
- access-token signing;
- offline-entitlement signing;
- AgentVersion signing;
- Workspace, Organization, and platform policy signing;
- official rollout HMAC;
- Internal Admin operation HMAC;
- Internal Admin service-JWT signing and verification;
- Internal Admin mTLS server, client, and CA identities;
- Cloud and Admin session, CSRF, TOTP, password, and operation protection;
- PostgreSQL encrypted-backup `age` recipient;
- object-store service credentials;
- macOS Developer ID and App Store Connect notarization;
- Windows Authenticode signing and timestamping.

Each key ring has an explicit active identifier and retains every still-referenced verification or decryption key. Rotation adds the new key, deploys readers, switches writers, verifies, and retires the old key only after reference and restore checks pass.

Backup Root Keys, recovery phrases, backup Data Encryption Keys, and device backup private keys are never part of this ceremony because they exist only on user devices.

Before deployment, automated configuration validation checks that no development key, reserved provider, wildcard trust range, reused key bytes, insecure URL, public Internal Admin listener, public object bucket, or missing active key reaches production composition.

## Immutable Cloud and Admin Delivery

CI builds Cloud and Admin images once from exact commits, records their image digests and SBOMs, scans them for tracked secrets and high-severity production dependencies, and deploys the same digests to staging.

Production promotes the accepted staging digests without rebuilding. Deployment records the exact Cloud, Admin, Desktop-contract, migration, and object-schema versions in a signed release manifest.

Database migrations are transactional, lock-protected, forward-compatible with the immediately previous application version, and applied while new feature flags remain disabled. Rollback never drops newly applied tables, columns, immutable revisions, proposals, consent facts, backup metadata, or audit records.

## Desktop Signing and Artifact Promotion

The V1 production matrix remains:

- macOS Apple Silicon: signed Hardened Runtime application, notarized DMG and ZIP;
- Windows 11 x64: Authenticode-signed NSIS and Portable executables.

Linux packaging remains available for development but is not a production release target in this program.

The build workflow maps environment-scoped `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, App Store Connect values, `WIN_CSC_LINK`, and `WIN_CSC_KEY_PASSWORD` into job-local signing variables. Missing signing or notarization material fails the candidate; unsigned fallback is forbidden.

Each candidate verifies:

- package version and exact source commit;
- AgentEra Cloud contract hash;
- packaged Runtime Seed manifest, signature, repository, version, commit, platform, and architecture;
- native dependency architecture;
- application code signature and macOS notarization or Windows Authenticode chain and timestamp;
- DMG, ZIP, NSIS, Portable, blockmap, and update metadata hashes;
- SBOM and build provenance;
- no production secret or private Profile marker in artifacts.

CI uploads one immutable candidate artifact set. After real-device approval, the production publication job creates the signed release tag and GitHub Release and attaches the exact candidate bytes. It does not rebuild them.

## Private Staging Acceptance

Private staging uses at least two product accounts and two independently authorized devices and proves:

- registration, login, device management, seven-day offline entitlement, and account recovery;
- PLATFORM draft, separate approval, immutable version, deterministic rollout, pause, resume, rollback, and user installation;
- quality consent off/on/revoke, sanitized event upload, threshold suppression, aggregate visibility, proposal separation, draft linkage, and no private marker leakage;
- backup enablement, phrase confirmation, device enrollment, manual and scheduled backup, resumable upload, corruption rejection, wrong phrase, revoked device, cryptographic deletion, and new-Profile restore;
- Cloud and Admin fail closed when mTLS, service JWT, object storage, database, Redis, signing key, consent, or upstream state is unavailable;
- encrypted PostgreSQL backup restores into a disposable database and reconciles every committed backup metadata row to one valid ciphertext object inventory entry;
- feature shutdown leaves existing official conversations and local Profiles usable.

## Real-Device Matrix

Mandatory physical/trusted targets are:

- two Apple Silicon Macs covering the current and immediately previous supported major macOS versions;
- one physical Windows 11 x64 machine plus one independent trusted Windows 11 x64 VM, or two physical Windows machines;
- two AgentEra accounts and at least two backup-authorized devices.

Every platform covers:

- clean install;
- upgrade from the previous public Desktop version;
- invalid or missing signature rejection;
- sign-in, official Agent installation, and independent Hermes Profile creation;
- online and valid offline official use;
- quality consent, explicit feedback, revocation, and no-content network capture;
- manual backup, interrupted backup, disk exhaustion, ciphertext corruption, wrong phrase, revoked device, cross-device restore, and restored-session rules;
- v1 to v2 official update and rollback affecting only later RuntimeBindings;
- application restart, OS restart, uninstall, and reinstall without unintended Profile deletion.

At least one real Mac and one real Windows device must install the final signed candidate bytes. Simulator-only, unit-only, or package-inspection evidence cannot satisfy this gate.

## Production Deployment Order

1. Verify remote CI for the exact commits.
2. Accept private staging and signed candidate evidence.
3. Create and verify an encrypted PostgreSQL backup in a disposable database.
4. Export and verify object inventory and backup-metadata reconciliation.
5. Record active key IDs, certificate expiries, image digests, artifact hashes, migration level, and rollback target in the signed release manifest without recording secret values.
6. Deploy production PostgreSQL, Redis, object-store policy, Cloud, and Admin changes with every new feature disabled.
7. Verify public health, private Internal Admin dual authentication, object-store access, retention workers, and fail-closed configuration.
8. Enable employee-only quality dashboards against synthetic or staging-origin test data; production user data remains absent.
9. Enable quality consent for an explicit staff account allowlist.
10. Enable encrypted backup for an explicit staff account allowlist.
11. Publish the signed Desktop candidate to a bounded beta/prerelease audience.
12. Complete real production-origin consent, backup, restore, disable, and rollback checks using dedicated test accounts.
13. Expand quality and backup rollout in recorded stages only after error, privacy, storage, and restore thresholds remain healthy.
14. Publish the stable Desktop release only after a separate production approval.

Public registration remains disabled until the filed domain, trusted HTTPS, real notification/CAPTCHA providers, published legal documents, backup/restore evidence, and production approval are all recorded.

## Rollback Design

### Feature Rollback

Feature flags stop new quality event creation, quality ingestion, new backup creation, new device enrollment, or restore initiation independently. Disabling a feature does not delete valid ciphertext, key envelopes, immutable quality proposals, Agent versions, release revisions, or audit.

### Cloud and Admin Rollback

Before rollback, stop Admin mutations and the affected worker, verify an encrypted database backup, and preserve already-applied schema. Deploy the immediately previous compatible image digest. Do not roll back a key ring by deleting keys still referenced by tokens, policies, identities, audit, proposals, backup metadata, or objects.

### Desktop Rollback

Never rewrite or delete an existing release tag or signed artifact. Ship a new signed corrective version or pause update discovery. Official Agent rollback continues through append-only release revisions and affects only later RuntimeBindings.

### Data and Object Rollback

Database recovery always targets a disposable instance first. After a restore, reconcile account/device revocations, consent state, committed backup rows, key epochs, object inventory, and immutable audit before reopening either listener.

Object-store rollback never replaces ciphertext from an unverified older version merely because it has a later provider timestamp. The database committed object digest and signed public envelope remain authoritative.

## Rollback Rehearsal

Staging must rehearse:

- quality API and worker rollback while conversations continue;
- backup API and object-store outage while local Profiles continue;
- Cloud current image to previous compatible image;
- Admin current image to previous compatible image with Internal Admin disabled first;
- failed migration transaction;
- database restore and object reconciliation;
- lost active signing key with retained previous verification keys;
- official Agent v2 activation followed by append-only rollback to v1;
- Desktop candidate withdrawal followed by a new signed corrective candidate.

The rehearsal hashes selected Profile, Memory, USER, Session, learned Skill, Curator, published projection, and RuntimeBinding fixtures before and after every failure. Unrelated bytes must remain unchanged.

## External Prerequisites and Authority

The user or the appropriate account administrator must provide and authorize:

- GitHub payment recovery or Actions spending limit;
- Apple Developer ID, App Store Connect issuer/key, and notarization authority;
- Windows code-signing certificate and timestamping authority;
- final production domain, filing where required, DNS, and trusted HTTPS;
- real SMTP, SMS, and CAPTCHA providers;
- production Secret Manager/KMS, PostgreSQL, Redis, object storage, and backup destination;
- approved Admin private-network access;
- the required real devices;
- production deployment, feature rollout, public registration, and stable release publication.

Development may prepare validation commands, secret names, dry runs, manifests, and deployment automation. It may not fabricate these prerequisites or perform a financial, legal, credential-acceptance, DNS, public-exposure, or final production action without the corresponding explicit authority and material.

## Final Acceptance

The program is complete only when evidence proves:

- every required local and remote CI job executed real steps and passed;
- staging and production use distinct resources and key material;
- Cloud/Admin images and Desktop artifacts were promoted without rebuild;
- every production artifact is signed, verified, hash-recorded, and tied to exact source commits;
- private staging passed the full quality, backup, official Agent, auth, failure, privacy, and restore gates;
- the mandatory real-device matrix installed and exercised the final candidate bytes;
- production database backup and disposable restore passed;
- committed ciphertext objects reconciled to metadata without server decryption;
- rollback rehearsal preserved existing Profiles, local learning, active RuntimeBindings, ciphertext, immutable versions, proposals, and audit;
- production deployment occurred with features disabled before bounded rollout;
- each rollout expansion and the final public release has separate approval and evidence;
- `aera-runtime` remains unchanged.
