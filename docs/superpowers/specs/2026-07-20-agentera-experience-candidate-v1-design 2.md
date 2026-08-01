# AgentEra ExperienceCandidate V1 Design

## Goal

Add a controlled path for one explicitly selected, Hermes-learned Skill to become a reviewable Workspace Agent contribution without changing how Hermes learns, stores, or uses that Skill locally.

In product terms, this is an Agent capability pull request: Hermes learns privately, the user chooses one reusable Skill, AgentEra creates a safe candidate snapshot, Workspace Owner or Admin reviews it, and approval creates a local Workspace Agent draft that still requires normal editing and publication.

## Non-Negotiable Boundary

Hermes remains the sole owner of local learning. AgentEra starts only after a Skill already exists durably inside one Installation's physical Hermes Profile.

ExperienceCandidate V1 must never:

- delay, replace, intercept, or require cloud approval for Hermes background review, Skill creation, Memory writes, USER writes, Curator, or next-conversation recall;
- watch a Profile and upload learning automatically;
- modify, move, rename, delete, redact, archive, or roll back the source Skill;
- upload `MEMORY.md`, `USER.md`, sessions, conversations, files outside the selected Skill, credentials, Profile paths, Curator state, `.usage.json`, or usage counters;
- turn an Installation, RuntimeBinding, or writable `HERMES_HOME` into Workspace-owned state;
- publish an AgentVersion automatically after approval.

The source Profile remains USER-owned and local. Candidate submission copies one immutable, allowlisted snapshot into AgentEra-owned storage outside `HERMES_HOME`. Rejection, upload failure, review failure, draft-import failure, and later publication failure leave the original Skill byte-for-byte unchanged.

`aera-runtime` receives no implementation change in this slice. The desktop consumes existing Hermes provenance and directory conventions through a read-only adapter.

## Approaches Considered

### Chosen: desktop read-only adapter plus cloud review and local draft import

The desktop reads one selected Installation's Profile through a narrow adapter, verifies Hermes's agent-created provenance, creates an immutable candidate snapshot, runs local DLP, and submits the canonical package to the AgentEra cloud. The cloud repeats validation and DLP, stores an immutable candidate, enforces Workspace review permissions, and records a terminal decision.

An approved candidate is downloaded by a Workspace Owner or Admin and imported into that reviewer's local Workspace Agent draft store. It does not write into any Hermes Profile and does not create a cloud draft.

This approach preserves the Runtime release boundary, reuses the existing Workspace Agent control plane, and makes every cross-boundary action explicit and testable.

### Rejected: add a Runtime export command first

A new Hermes CLI export command would provide a clean formal interface, but it would touch the Runtime producer, compatibility suite, seed packaging, and release process before the product flow is proven. The existing provenance sidecar and Skill directory are sufficient for a read-only V1 adapter.

### Rejected: automatic Profile monitoring and upload

Watching learned Skills and creating or uploading candidates in the background would weaken explicit consent, increase private-data exposure, and couple cloud availability to local learning. V1 requires a user action for both snapshot creation and submission.

## V1 Release Boundary

ExperienceCandidate V1 includes:

- one agent-created Skill package per candidate;
- candidates sourced only from an active USER-owned Installation of the selected Workspace Agent;
- an explicit local preview and consent step;
- immutable local and cloud candidate snapshots;
- local and cloud DLP using the same versioned contract;
- Member submission and own-status visibility;
- Owner/Admin Workspace review;
- terminal approval or rejection;
- approved-candidate import into a local Workspace Agent draft;
- normal explicit AgentVersion publication after draft review and editing;
- deterministic audit, authorization, privacy, and Hermes-isolation tests.

V1 does not promote Knowledge, SOP, Memory, USER data, conversations, complete Profiles, arbitrary files, or model weights. It does not add organization or official-Agent review, collaborative cloud drafts, automatic publication, automatic retry, candidate withdrawal, review reversal, production deployment, or encrypted backup.

## Eligibility and Source Selection

The desktop exposes “Promote local experience” only for an active local Installation whose source is the currently selected Workspace and whose `runtime_profile_id`, Workspace ID, AgentDefinition ID, and selected AgentVersion ID are already trusted main-process records.

The renderer submits only the local Installation ID and the selected Skill name. It cannot submit a Profile path, `HERMES_HOME`, Workspace ID, owner scope, actor identity, role, cloud origin, authorization header, source version, or source directory.

The trusted main process resolves the encrypted Profile binding and then applies all eligibility checks:

- the Installation is USER-owned by the authenticated account and current device;
- the Installation source is the exact active Workspace and AgentDefinition;
- the resolved Skill directory is a real descendant of that Installation's physical `HERMES_HOME/skills` directory;
- the `.usage.json` sidecar contains an explicit Hermes agent-created record for that Skill, using `created_by: "agent"` or the legacy-compatible `agent_created: true` marker;
- the Skill is active rather than archived and is not bundled, hub-installed, externally linked, or a read-only AgentVersion projection;
- every included entry is an ordinary regular file beneath the selected Skill directory.

The sidecar is provenance input only. `.usage.json`, counters, timestamps, state records, and Curator metadata are never copied into the candidate.

No background scan enumerates or snapshots Skills. The eligible list is produced only when the user opens the promotion flow, and a snapshot is created only after the user chooses one Skill.

## Canonical Skill Package

One candidate contains schema version 1, a normalized Skill name, the source Workspace Agent identity, the source selected AgentVersion ID, and a sorted list of text assets.

Candidate paths use the published Agent asset layout:

```text
skills/<normalized-skill-name>/SKILL.md
skills/<normalized-skill-name>/<support-relative-path>
```

The package requires `SKILL.md`. Markdown files use `text/markdown`; every other accepted UTF-8 text file uses `text/plain`. File bytes are normalized only for canonical transport encoding; the source files are never rewritten.

The desktop rejects:

- symlinks, aliases, junction-like entries, sockets, devices, and other non-regular files;
- real-path or normalized-path escape, absolute paths, empty path segments, `.` or `..` segments, and duplicate normalized paths;
- hidden metadata and dependency/cache directories including `.git`, `.env`, `node_modules`, virtual environments, `__pycache__`, and editor caches;
- NUL bytes, invalid UTF-8, binary or archive content, and unsupported oversized content;
- more than 32 files, more than 256 KiB in one file, or more than 1 MiB in the complete candidate.

The canonical document sorts assets by normalized path and computes SHA-256 for every file and for the complete schema-versioned document. The cloud reconstructs the same canonical document and digest instead of trusting client-provided hashes. Desktop TypeScript and cloud Go implementations share language-neutral positive and negative fixture vectors so their path, encoding, size, digest, and finding-code behavior cannot drift silently.

## DLP and Privacy Checks

Local DLP runs before AgentEra writes a prepared candidate snapshot. Cloud DLP runs again before PostgreSQL stores any candidate content. Passing one scanner never bypasses the other.

The versioned V1 scanner blocks high-confidence evidence of:

- private keys, bearer credentials, JWTs, URL credentials, common API-key formats, and secret-like environment assignments;
- absolute home, userData, Profile, or Runtime paths;
- Memory, USER, raw-session, conversation-export, credential-store, or Curator payloads;
- content that violates the canonical package file, path, encoding, or size rules.

Findings contain only a stable finding code, normalized candidate-relative path, and optional line number. Logs, renderer DTOs, audit metadata, and database error text never include the matched secret, surrounding source line, absolute source path, or request body.

A blocking local finding prevents snapshot creation. A blocking cloud finding rejects submission before candidate insertion and leaves the immutable local snapshot available for the user to inspect locally. AgentEra does not redact or edit the source in V1; after correcting the Hermes Skill, the user creates a new candidate with a new digest.

## Desktop Data Model

Control-plane SQLite schema v4 adds local candidate metadata and local draft-import receipts. Candidate content is stored in AgentEra-owned files below Electron userData, partitioned by authenticated personal space, user, device, and candidate ID. It is never stored beneath `HERMES_HOME`.

`local_experience_candidates` contains:

```text
id
tenant_id
owner_id
device_installation_id
agent_installation_id
workspace_id
agent_definition_id
source_agent_version_id
runtime_profile_id                 local-only lookup identity
skill_name
source_relative_path               local-only normalized path
content_digest
dlp_contract_version
snapshot_relative_path             AgentEra userData-relative path
status                             PREPARED | UPLOAD_FAILED | SUBMITTED
cloud_candidate_id                 nullable until accepted
last_error_code                    bounded code only
created_at
updated_at
submitted_at                       nullable
```

Every operation rechecks the authenticated `(tenant_id, owner_id, device_installation_id)` tuple. Renderer-safe DTOs omit `runtime_profile_id`, source paths, snapshot paths, and local filesystem details.

`local_experience_candidate_imports` contains:

```text
tenant_id
owner_id
device_installation_id
workspace_id
candidate_id
agent_definition_id
base_agent_version_id
candidate_content_digest
draft_id
imported_at
```

The primary key is the local owner/device plus candidate ID. Repeating an import on the same reviewer device opens the existing draft instead of creating a second draft. A different authorized reviewer device may independently import the same approved candidate because drafts remain local.

PREPARED and UPLOAD_FAILED candidates retain the immutable snapshot for explicit retry. After the cloud accepts the candidate, the desktop records the cloud ID before best-effort deletion of the redundant local candidate content; the original Hermes Skill remains untouched. Metadata and the digest remain for status and audit correlation.

## Cloud Data Model

The cloud stores immutable candidate content separately from the single terminal review decision.

`experience_candidates` contains the immutable core:

```text
id
workspace_id
agent_definition_id
source_agent_version_id
submitted_by_user_id               nullable only after account deletion
submitted_from_device_id             nullable only after device/account deletion
kind                               fixed to SKILL in V1
skill_name
schema_version                     fixed to 1
dlp_contract_version
content_digest
bundle_document                    canonical text-only package
created_at
```

Database constraints and repository transactions prove that the definition and source version belong to the exact Workspace, the version belongs to the definition, and the actor has an active membership and an active USER-owned Installation of that Workspace Agent. Schema, destination, digest, and bundle content are never updated after insertion; only existing account-deletion policy may detach actor or device references.

`experience_candidate_reviews` contains at most one row per candidate:

```text
id
candidate_id                       unique
workspace_id
decision                           APPROVED | REJECTED
reviewed_by_user_id                nullable only after account deletion
reason_code                        required for rejection
safe_note                          optional bounded reviewer note
reviewed_at
```

Candidate status is derived: no review row means `PENDING_REVIEW`; a review row means `APPROVED` or `REJECTED`. This prevents content mutation from being hidden inside a status update and makes terminal review races resolve through one database uniqueness boundary.

The existing Agent control idempotency mechanism is reused with the authenticated USER actor tuple and distinct submission and review operation names. Request hashes include Workspace, definition, source version, candidate digest, and decision as applicable. Replaying the same key and request returns the original result; reusing the key for different content returns the existing idempotency conflict.

Membership removal does not delete an already submitted Workspace candidate, but the removed submitter loses own-candidate access. Account deletion clears direct actor references under the existing restricted-audit identity policy; the explicitly contributed Workspace content and terminal review remain available to authorized Workspace reviewers.

## Cloud API

ExperienceCandidate V1 adds exact Workspace-nested routes:

```text
POST /api/v1/workspaces/{workspace_id}/agent-definitions/{definition_id}/experience-candidates
GET  /api/v1/workspaces/{workspace_id}/experience-candidates/mine
GET  /api/v1/workspaces/{workspace_id}/experience-candidates
GET  /api/v1/workspaces/{workspace_id}/experience-candidates/{candidate_id}
POST /api/v1/workspaces/{workspace_id}/experience-candidates/{candidate_id}/review
```

Submission requires an idempotency key and the canonical candidate package. The body accepts no owner scope, actor, role, device, local Installation ID, runtime Profile ID, Profile path, source path, DLP override, review state, or audit metadata. The authenticated main process supplies the device identity through its trusted session; the cloud derives the actor and membership.

`mine` returns only the authenticated actor's candidates while that actor remains an active Workspace member. The general list and candidate detail routes require Owner or Admin. Candidate content is visible to its active submitter and Workspace Owner/Admin, but not to other Members before publication.

Review accepts exactly one decision. Rejection requires a bounded reason code and permits an optional short safe note. The server rejects control characters, secret-like values, and overlong notes; audit records store the reason code but not the note. Approval accepts no replacement content and cannot alter the candidate package. Archived or Owner-unavailable Workspaces reject submission, review, and draft import preparation using the existing lifecycle errors.

## Authorization Matrix

Authorization is exact and rechecked transactionally:

| Operation | Owner | Admin | Member | Outsider |
| --- | --- | --- | --- | --- |
| Prepare a local candidate from own active Installation | yes | yes | yes | no |
| Submit from own active Installation | yes | yes | yes | no |
| List/read own submitted candidates | yes | yes | yes | no |
| List/read all Workspace candidates | yes | yes | no | no |
| Approve or reject | yes | yes | no | no |
| Import an approved candidate into own local draft | yes | yes | no | no |
| Publish the resulting Workspace Agent draft | yes | yes | no | no |

Submission requires the exact source version selected by the actor's active local Installation and a matching cloud USER Installation for the same device, Workspace Agent definition, and version. A Member cannot submit a Skill from a Personal Agent, another Workspace, another local account, an archived Installation, or an unbound arbitrary Profile.

Renderer calls are rejected locally before network access when the trusted current role cannot perform the requested action. Cloud authorization remains authoritative and fails closed if cached desktop role state is stale.

## State Machines

The local candidate state machine is:

```text
eligible Skill --explicit snapshot + local DLP--> PREPARED
PREPARED --transient upload failure-------------> UPLOAD_FAILED
UPLOAD_FAILED --explicit retry-------------------> SUBMITTED
PREPARED --cloud accepted------------------------> SUBMITTED
```

A deterministic cloud denial, including cloud DLP or lost authorization, keeps the immutable local candidate PREPARED with a bounded `last_error_code`; it is never rewritten into a different candidate. Transient transport or service failure uses UPLOAD_FAILED. There is no background retry.

The cloud review state machine is:

```text
PENDING_REVIEW --> APPROVED
PENDING_REVIEW --> REJECTED
```

APPROVED and REJECTED are terminal in V1. The same idempotent review may be replayed, but a different decision cannot replace it. A candidate cannot be edited, resubmitted under the same ID, withdrawn, reopened, or moved to another Workspace or definition.

## Review and Draft Import

Owner/Admin review shows the candidate package, DLP result, submitter identity, source AgentVersion, and a diff against the latest published Workspace Agent version. The review screen never reads the submitter's Profile; it uses only the explicitly submitted candidate.

“Approve and create draft” performs two separated operations:

1. commit the terminal APPROVED review in the cloud;
2. fetch the approved canonical candidate and import it into the reviewer's local draft store.

If step 1 succeeds and step 2 fails, the candidate remains APPROVED and exposes a retry action. Cloud approval never depends on one reviewer's local filesystem.

Import creates a new local Workspace Agent draft based on the latest immutable published version. It overlays only:

```text
skills/<candidate-skill-name>/...
```

All unrelated Knowledge, Skill, SOP, identity, model, tool, dependency, and Runtime-compatibility fields remain those of the base version. If the base already contains the same Skill directory, the review preview shows the replacement and requires explicit confirmation. No arbitrary existing draft is silently modified.

If the latest version changes between review preview and import, the desktop returns `candidate_base_advanced`, refreshes the diff, and requires an explicit “apply to latest version” confirmation. The candidate's recorded source version never changes.

After import, the reviewer may edit the local draft normally. Approval does not publish, schedule, or activate an AgentVersion. Publication continues through the existing one-use preview, canonical manifest, signing, immutable version, audit, and manual member-selection flow. Running conversations and existing RuntimeBindings remain unchanged.

## Desktop Experience

An active Workspace Agent Installation gains a “Promote local experience” action. Opening it performs the read-only eligibility scan and lists only safe candidate names and bounded metadata; no file content leaves the main process until one Skill is selected for preview.

The preview shows:

- source Workspace Agent and selected version;
- normalized Skill name and file list;
- total file and byte counts;
- candidate digest;
- local DLP result;
- an explicit statement that only this snapshot is submitted and the original remains local.

Submission requires a direct confirmation. Offline users with a previously verified installed Workspace Agent may prepare the immutable local candidate from that local Installation, but cached role state never authorizes a cloud mutation. The UI pauses submission and offers an explicit retry after connectivity returns, when the cloud rechecks membership and lifecycle.

All roles see “My candidates” with submission and review status. Owner/Admin additionally see “Experience review,” including pending candidates and terminal history. Members cannot enumerate other contributors or open the review queue.

Owner/Admin rejection requires a reason selection. Approval opens the diff and base-version confirmation, then creates or reopens the local imported draft. The existing Workspace Agent draft editor and publication confirmation remain the only release surface.

## Error and Recovery Semantics

- missing or invalid Hermes provenance returns `candidate_source_ineligible` without creating a snapshot;
- path escape, symlink, binary, size, or encoding failure returns its bounded candidate validation code;
- local or cloud DLP returns `candidate_dlp_blocked` plus finding codes and relative locations only;
- offline submission returns `online_required` while retaining PREPARED content;
- transient network or service failure returns `cloud_unavailable`, records UPLOAD_FAILED, and requires manual retry;
- removed membership returns `workspace_forbidden`; an archived or Owner-unavailable Workspace uses the existing lifecycle codes;
- a duplicate terminal decision returns the existing decision for an identical idempotent replay or `candidate_already_reviewed` for a conflicting decision;
- draft materialization or merge failure leaves the candidate APPROVED and retryable;
- a base-version race returns `candidate_base_advanced` before local draft mutation;
- no error path deletes or rewrites the source Skill, current draft, installed version, Profile binding, RuntimeBinding, or local adaptive state.

Error responses, logs, and audit records never contain candidate bodies, absolute paths, matched secret fragments, raw cloud responses, or private Profile content.

## Audit and Privacy

Cloud audit records these bounded events:

- candidate submission accepted or denied;
- candidate review approved, rejected, denied, or conflicted;
- candidate detail access by a reviewer;
- Workspace lifecycle or authorization denial.

Audit metadata may contain request ID, actor, device, Workspace ID, AgentDefinition ID, source AgentVersion ID, candidate ID, content digest, decision, reason code, outcome, and timestamps. It must not contain candidate file content, Skill source path, Profile identity/path, DLP evidence text, secrets, Memory, USER, sessions, conversations, Curator data, or request bodies.

The desktop local import receipt links an approved candidate digest to one local draft without syncing the draft or local path. V1 does not add cloud version-lineage tables; normal immutable publication audit remains authoritative for the resulting version, while richer candidate-to-version lineage is a later controlled enhancement.

## Verification Gate

Desktop unit and integration tests must prove:

- SQLite v4 migration preserves every existing USER/WORKSPACE draft, cached version, Installation, binding, and pending record;
- one account/device cannot enumerate, read, retry, or import another account/device's candidates;
- only a matching active Workspace Installation and its bound Profile can be a source;
- Hermes agent-created provenance is recognized without writing `.usage.json` or any Skill file;
- symlink, real-path escape, binary, invalid UTF-8, hidden metadata, size, and count attacks fail closed;
- local DLP finds the locked fixture cases without returning secret fragments;
- canonical ordering and digests are deterministic and match cloud vectors;
- PREPARED, UPLOAD_FAILED, SUBMITTED, and manual retry behavior is exact;
- approved import creates one idempotent local draft, overlays one Skill directory, and preserves all unrelated base assets;
- a base-version race, import failure, logout, context switch, and app restart preserve source and candidate bytes;
- IPC and renderer DTOs contain no owner-controlled scope, actor, Profile path, source path, or secret evidence.

Cloud unit, repository, HTTP, OpenAPI, and real PostgreSQL tests must prove:

- candidate core content is immutable and review is a unique terminal row;
- candidate definition/version ownership and exact Workspace membership are transactionally enforced;
- Owner/Admin/Member/outsider permissions match the matrix;
- submission requires a matching USER Installation for the actor and device;
- removed-member, archived, Owner-unavailable, and racing-role-change operations fail closed;
- cloud canonicalization and DLP reject tampered hashes, paths, encodings, sizes, binaries, and secret fixtures before insertion;
- own-list and reviewer-list visibility do not leak other Members' candidates;
- submission and review idempotency return stable results and reject changed requests;
- audit events contain allowlisted metadata and no candidate content or private runtime data;
- existing USER Agent, Workspace Agent, Workspace, authentication, and account-deletion tests remain green without cache.

The deterministic end-to-end scenario uses two real product accounts and two isolated desktop contexts:

1. Owner publishes Workspace Agent v1.
2. Member installs v1 into an independent physical Profile.
3. Hermes creates one local agent-created Skill while local Memory, USER, sessions, and a private non-selected Skill also exist.
4. Member explicitly snapshots and submits only the selected Skill.
5. Cloud requests are inspected to prove the excluded private data is absent.
6. Admin approves and creates a local draft based on v1.
7. Admin publishes v2 through the existing explicit publication flow.
8. Member manually selects v2; an existing conversation remains on v1 and a new conversation binds v2.
9. Source Profile hashes, private Skill, Memory, USER, sessions, Curator state, and every unrelated Installation remain unchanged through success and injected failures.

Existing Hermes compatibility, Workspace Agent boundary, Agent control E2E, Workspace E2E, cloud integration, renderer, build, and `lat check` gates remain release-blocking. `aera-runtime` remains clean.

## Delivery Strategy

Implementation proceeds in independently testable local commits:

1. cloud schema, immutable candidate/review repository, DLP contract, and authorization tests;
2. cloud Workspace-nested API, OpenAPI contract, audit, and real-database integration tests;
3. desktop SQLite v4, read-only Hermes Skill adapter, canonical snapshot, local DLP, and isolation tests;
4. trusted client/IPC manager flow, submission retry, candidate lists, and review authorization;
5. approved-candidate diff and idempotent local Workspace Agent draft import;
6. role-aware desktop UI and localized copy;
7. two-account deterministic E2E, private-data request inspection, full regression, and LAT evidence.

No step merges to `main`, pushes, deploys, publishes a Runtime, modifies production data, or changes production configuration without separate authorization.
