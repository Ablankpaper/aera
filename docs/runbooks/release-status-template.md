# AgentEra release status record

This record keeps implementation, verification, deployment, and publication as independent states. Complete it from exact source commits and protected evidence; never promote a state because an earlier state passed.

Allowed values are:

- `passed`: the exact required evidence exists and was revalidated;
- `in_progress`: authorized work is currently executing;
- `external_blocked`: code is ready to validate the state, but required external authority, infrastructure, credentials, devices, or executed remote evidence is unavailable;
- `not_started`: no authorized action has begun;
- `not_requested`: the action requires separate authorization that has not been given;
- `failed`: executed evidence proves the gate failed.

## Current feature-branch snapshot

Snapshot date: `2026-07-23`

| State | Status | Evidence or blocker |
| --- | --- | --- |
| Approved design | `passed` | Production-readiness design and executable plan are committed in Desktop. |
| Implemented on feature branches | `passed` | Separate Desktop, Cloud, and Admin `aera/official-quality-v1` worktrees; `aera-runtime` excluded. |
| Local unit/contract verification | `passed` | Desktop, Cloud, and Admin exhaustive local matrices below passed on 2026-07-23. |
| Local commits | `passed` | Verified code checkpoints: Desktop `e4ba6bbd98ac2ab5484e2e213645368c079ecd97`, Cloud `92632048a5261f02d06f132d22854dda1b513345`, Admin `57d637412470fc5c86524e40bd717399a9936162`. |
| Merged to local `main` | `not_requested` | Requires explicit merge authorization. |
| Pushed to origin | `passed` | All three `aera/official-quality-v1` branches were pushed with explicit authorization. |
| Remote CI for exact verified code SHAs | `passed` | Desktop run `30011233373`, Cloud run `30006310907`, and Admin run `30010245066` completed successfully for the exact checkpoints above. |
| Cloud/Admin signed candidate images | `external_blocked` | CI built local verification images, not signed immutable candidates. GHCR/OIDC signing, attestations, protected candidate execution, and digest records are still required. |
| Desktop signed candidate | `external_blocked` | Requires protected Apple/Windows signing credentials and native Actions runners. |
| Real-device acceptance | `external_blocked` | Requires exact remotely signed bytes and the four-device physical/trusted matrix. |
| Private staging deployed | `external_blocked` | Requires protected staging hosts, final staging DNS HTTPS, isolated providers/keys/data, and exact remote candidates. |
| Private staging accepted | `external_blocked` | Requires executed, signed staging evidence; local E2E attachments are coverage only. |
| Rollback rehearsal accepted | `external_blocked` | Requires executed B → A → B staging runs and signed cross-repository evidence. |
| Production authorized | `not_requested` | Requires separate production authority plus legal/provider/domain/backup evidence. |
| Cloud production deployed disabled | `not_started` | No production deployment was authorized or run. |
| Admin production deployed disabled | `not_started` | No production deployment was authorized or run. |
| Cloud feature rollout | `not_started` | No production cohort was authorized or enabled. |
| Admin mutation enablement | `not_started` | No production mutation enablement was authorized or run. |
| Desktop public publication | `not_started` | No release tag, GitHub Release, or updater publication was authorized. |
| Production monitoring complete | `not_started` | Depends on separately authorized deployment/rollout. |
| Runtime unchanged | `passed` | `/Users/zizimutou/Desktop/aera/aera-runtime` is clean at `c0439e1e3e5f35a91b658d57ddfc011e0d5ba1bb`. |

The exact local verification checkpoints before this self-report are:

```text
desktop_local_verification_sha=e4ba6bbd98ac2ab5484e2e213645368c079ecd97
cloud_local_verification_sha=92632048a5261f02d06f132d22854dda1b513345
admin_local_verification_sha=57d637412470fc5c86524e40bd717399a9936162
runtime_unchanged_sha=c0439e1e3e5f35a91b658d57ddfc011e0d5ba1bb
```

The status-only Desktop successor commit is intentionally recorded in the external handoff because a commit cannot contain its own Git object ID. These verified source checkpoints and CI runs are not signed candidate identities.

## Exact release identities

No candidate was created. Record these only in a protected external release record after an authorized push, successful exact-SHA CI, and candidate build:

```text
desktop_source_sha=
cloud_source_sha=
admin_source_sha=
runtime_source_sha=

desktop_candidate_run_id=
desktop_candidate_manifest_sha256=
cloud_candidate_run_id=
cloud_candidate_manifest_sha256=
cloud_image_digest=
admin_candidate_run_id=
admin_candidate_manifest_sha256=
admin_image_digest=
```

All SHAs and digests must be exact lowercase hex values. An image reference must be `ghcr.io/...@sha256:...`, never a mutable tag.

## Local verification record

The final local matrix ran on 2026-07-23 in the three isolated feature worktrees. Interactive output remains in the Codex task; no protected durable log artifact or evidence URL was created.

```text
desktop_unit_tests=passed; 299 files, 2751 passed, 3 skipped
desktop_typecheck=passed; Node and renderer
desktop_production_build=passed; Electron Vite production build
desktop_release_script_tests=passed; 49 tests
desktop_boundary_checks=passed; quality 20 fields/11 columns/7 modules; backup 5 tables/67 columns plus digest-only MinIO and fixed Desktop allowlist
desktop_all_agentera_e2e=passed; 17 scenarios in one single-worker run
desktop_official_agent_e2e=passed; failure matrix plus real Admin/Cloud/two-Desktop lifecycle
desktop_quality_e2e=passed; 6 scenarios
desktop_encrypted_backup_e2e=passed; ciphertext-only Cloud plus authorized-device and phrase recovery
desktop_runtime_seed_e2e=passed; online preparation, offline restart, no public download
desktop_lat_check=passed

cloud_go_tests=passed; default package set plus release builds
cloud_integration_tests=passed; PostgreSQL, Redis, MinIO, tagged E2E, and auth smoke
cloud_race_tests=passed; security, control-plane, and encrypted-backup packages
cloud_vet=passed
cloud_web=passed; 4 files/7 unit tests, typecheck/build, 8 browser scenarios
cloud_image_build=passed; local tag agentera-cloud:final-local only
cloud_secret_delivery_tests=passed; secret, delivery, digest deployment, release manifest, and shell syntax
cloud_backup_restore_and_object_reconciliation=passed; encrypted archive, disposable restore, integrity and identity decryption

admin_make_verify=passed; Go unit/integration/race, vet, release builds, 22 web files/78 tests, lint/typecheck/build, OpenAPI and E2E typecheck
admin_real_cloud_e2e=passed; 15 browser scenarios plus TestE2EAcceptance
admin_image_build=passed; local tag aera-admin:final-local only
admin_deployment_contract=passed; CI, manifest, exact-digest deploy/rollback, E2E runner, and Cloud material tests
admin_dual_auth_failure_matrix=passed; local contracts and real Cloud mTLS/service-JWT E2E
```

A command that did not execute, a job with zero steps, a cached design result, or an unreviewed partial log is not `passed`.

## Protected external evidence

```text
remote_ci_manifest_url=
remote_ci_manifest_sha256=

last_desktop_remote_observation_url=https://github.com/bignormal/aera/actions/runs/30011233373
last_desktop_remote_observation=success at e4ba6bbd98ac2ab5484e2e213645368c079ecd97; Ubuntu, Windows, and macOS jobs executed typecheck, tests, official-quality E2E, and build; Ubuntu also executed exact Cloud contract, privacy, production dependency audit, and informational lint gates
last_cloud_remote_observation_url=https://github.com/bignormal/aera-cloud/actions/runs/30006310907
last_cloud_remote_observation=success at 92632048a5261f02d06f132d22854dda1b513345; delivery/secret boundaries, Go and Web verification, service integration/auth smoke, encrypted backup/disposable restore, and application image build executed
last_admin_remote_observation_url=https://github.com/bignormal/aera-admin/actions/runs/30010245066
last_admin_remote_observation=success at 57d637412470fc5c86524e40bd717399a9936162; exact Cloud contract, full verify, release image build, and real Cloud mTLS/service-JWT E2E executed

device_evidence_url=
device_evidence_sha256=

staging_evidence_url=
staging_evidence_sha256=
staging_signature_sha256=

rollback_evidence_url=
rollback_evidence_sha256=
rollback_signature_sha256=

legal_evidence_url=
legal_evidence_sha256=
provider_evidence_url=
provider_evidence_sha256=
domain_tls_evidence_url=
domain_tls_evidence_sha256=

cloud_disabled_run_id=
admin_disabled_run_id=
cloud_enabled_run_id=
admin_enabled_run_id=
production_gate_sha256=
desktop_release_url=
```

Keep secrets and direct identifiers out of this record. Evidence URLs must point to access-controlled, redacted artifacts and must not contain query tokens.

## Production decision

```text
decision=not_requested
approver_identity_ref=
approved_at=
change_ticket_url=
incident_owner_identity_ref=
approved_cloud_flags=
approved_admin_mutations=
approved_desktop_candidate_cohort=
approved_public_desktop_release=
```

An approval authorizes only the exact recorded operation. It does not prove the operation succeeded.

## Final invariants

Before declaring any release state, confirm:

- Cloud/Admin production use exact signed candidate digests and no build path;
- Desktop publication uses exact signed/notarized/AuthentiCode candidate bytes and exact updater metadata;
- private staging and production have independent data, keys, CAs, providers, object storage, and identities;
- encrypted database backup, disposable restore, ciphertext object reconciliation, and client decryption passed;
- rollback used no down migration and preserved immutable releases, audit, ciphertext, Profile bytes, local learning, sessions, and fixed RuntimeBindings;
- public Admin, Internal Admin, PostgreSQL, Redis, and object storage exposure remains forbidden;
- `aera-runtime` is clean at its pre-program commit;
- merge, push, deployment, DNS, feature enablement, tag creation, Release publication, and secret rotation each have separate explicit authority and evidence.
