# AgentEra Workspace Agent V1 Design

## Goal

Add workspace-owned Agent definitions and immutable versions to the existing AgentEra control plane while preserving one USER-owned local Installation, physical Hermes Profile, RuntimeBinding, and private learning state per member and device.

This slice implements the next layer in the approved multi-tenant diagram: Owner and Admin publish approved workspace assets, every active member may discover and install them, and Hermes consumes the installed version as a read-only base for later conversations.

## Non-Negotiable Boundary

`owner_scope=WORKSPACE` describes ownership of the published Agent asset. It does not make a member's runtime data workspace-owned or cloud-hosted.

For a workspace Agent installed by a member, the two identities are deliberately different:

```text
published asset: owner_scope=WORKSPACE / workspace_id
local runtime:   owner_scope=USER / personal_space_id / user_id
                 device_installation_id / agent_installation_id / runtime_profile_id
```

The member's Installation, policy snapshot, RuntimeBinding, physical `HERMES_HOME`, Memory, USER profile, sessions, files, credentials, learned Skills, and Curator state remain USER-owned and local. No Workspace operation may create a second writer to that Profile.

## Chosen Architecture

### Chosen: extend the existing Agent control plane with an asset-owner context

The cloud keeps one `internal/agentcontrol` implementation for canonical manifests, immutable version signing, idempotency, policy snapshots, installations, audit, and API serialization. It adds a strict asset-owner context for either the existing USER owner or one Workspace.

Workspace publication and discovery use nested routes so the client cannot ambiguously select an owner tuple. The authenticated actor is still derived from the access token. Repository transactions re-check Workspace membership, role, lifecycle, and Owner availability before every protected read or write.

The desktop keeps one `agentera-agent-control` domain. Its trusted manager derives the target context from the existing Workspace manager; renderer calls never submit `owner_scope`, `workspace_id`, actor identity, cloud origin, or authorization headers.

### Rejected: duplicate Workspace Agent tables and services

A separate `workspace_agent_definitions` protocol would duplicate canonicalization, signatures, version verification, policy, installation, and audit behavior. The two implementations would drift and make a later organization scope substantially harder.

### Rejected: Workspace-owned RuntimeBindings or shared writable Profiles

Making a member's RuntimeBinding or `HERMES_HOME` workspace-owned would mix private adaptive state across users and contradict the approved Profile mapping contract. Shared capabilities are immutable read-only inputs, not a shared writable runtime.

## Release Boundary

Workspace Agent V1 includes:

- `owner_scope=WORKSPACE` for AgentDefinition and AgentVersion assets;
- local Workspace-targeted drafts for Owner and Admin;
- Owner/Admin initial publication and immutable next-version publication;
- active-member discovery and installation;
- read-only Knowledge, Skill, and SOP version assets through the existing verified projection;
- manual version selection that affects only later conversations;
- account-, Workspace-, and device-isolated local metadata;
- audited authorization decisions and end-to-end Hermes compatibility proof.

It does not include collaborative cloud draft editing, automatic updates, ExperienceCandidate extraction, DLP/review queues, organizations, official Agents, enterprise policy, production deployment, or encrypted backup.

## Cloud Ownership Model

### Scope-aware published assets

Migration `000010_workspace_agent_scope.sql` evolves only the tables that can hold published assets or their publication evidence:

- `agent_definitions`;
- `agent_versions`;
- `agent_control_idempotency_keys`.

USER rows retain `tenant_id=personal_space_id`, `owner_id=user_id`, and no `workspace_id`. WORKSPACE rows store `workspace_id` and leave USER-only ownership columns null. Database checks require exactly one valid variant, and the Workspace foreign key prevents orphaned published assets.

USER installations, policy snapshots, runtime binding records, and their owner columns remain unchanged. A Workspace version can be referenced by a USER installation, but the installation and policy rows continue to use the authenticated member's USER tuple.

Workspace-wide emergency revocation is deferred until a Workspace policy can issue and propagate a scope-level deny independently of one member's USER policy snapshot. The existing USER revocation route and table remain USER-only in this slice; ordinary Workspace corrections publish a new immutable version and require explicit member selection.

Scope-specific partial unique indexes preserve idempotency for both owner kinds even though nullable ownership columns are used. Existing USER rows and account-deletion foreign-key behavior remain intact.

### Authorization

Cloud authorization is exact:

| Operation | Owner | Admin | Member | Outsider |
| --- | --- | --- | --- | --- |
| List/read published Workspace Agents | yes | yes | yes | no |
| Publish initial or next version | yes | yes | no | no |
| Install a published version | yes | yes | yes | no |
| Select another published version | yes | yes | yes | no |

Publication and new installation require an active Workspace with an available Owner. An archived or `owner_unavailable` Workspace is read-only and rejects these mutations. An outsider receives a non-enumerating not-found response.

Membership is checked inside the same PostgreSQL transaction that creates a definition/version or installation. A role removal or archive racing a request therefore fails closed.

Removing a member or archiving a Workspace blocks future discovery, publication, installation, and update operations. It never deletes an already materialized local Profile or private learning. A previously verified installed version may continue locally during the valid offline entitlement window; reinstated cloud access is required for later version discovery or selection.

## Cloud API

Existing USER routes retain their current meaning and response schemas:

```text
GET  /api/v1/agent-definitions
POST /api/v1/agent-definitions
GET  /api/v1/agent-definitions/{definition_id}
GET  /api/v1/agent-definitions/{definition_id}/versions
POST /api/v1/agent-definitions/{definition_id}/versions
```

Workspace publication and discovery add these exact routes:

```text
GET  /api/v1/workspaces/{workspace_id}/agent-definitions
POST /api/v1/workspaces/{workspace_id}/agent-definitions
GET  /api/v1/workspaces/{workspace_id}/agent-definitions/{definition_id}
GET  /api/v1/workspaces/{workspace_id}/agent-definitions/{definition_id}/versions
POST /api/v1/workspaces/{workspace_id}/agent-definitions/{definition_id}/versions
```

The existing signed-version route may return either a USER version owned by the actor or a Workspace version visible through active membership:

```text
GET /api/v1/agent-versions/{version_id}
```

`POST /api/v1/agent-installations` adds one optional `workspace_id`. Its absence means the definition and version must be USER-owned by the actor. Its presence means both must belong to that exact Workspace and the actor must be an active member. This binds a compromised renderer request to the selected Workspace without changing the USER ownership of the resulting Installation.

Installation activation, policy retrieval, RuntimeBinding delivery, and archive routes remain USER-scoped. Version selection joins the Installation to its definition, re-checks any Workspace membership, and permits only a version from the same definition.

No request body accepts `owner_scope`, `tenant_id`, `owner_id`, actor user ID, actor role, Profile path, or private Hermes content.

## Desktop Data Model

Control-plane SQLite schema v3 adds a target context to local drafts and source context to local installations:

```text
agent_drafts.target_scope = USER | WORKSPACE
agent_drafts.workspace_id = null | UUID
local_agent_installations.source_scope = USER | WORKSPACE
local_agent_installations.source_workspace_id = null | UUID
```

Every row remains additionally partitioned by the authenticated `personal_space_id` and `user_id`. A demoted Admin's local Workspace draft is preserved but becomes inaccessible for editing or publication until that account again has an authoring role.

The verified version cache changes its logical key from global `version_id` to `(tenant_id, owner_id, version_id)` and writes new files below an account-partitioned directory. Existing USER cache rows and their legacy read-only paths remain readable after migration. Two accounts on one desktop can therefore install the same immutable Workspace version without sharing authorization state or colliding in SQLite.

Drafts remain local in V1. There is no cloud `agent_drafts` table and no collaborative draft sync. Only an explicit publish action sends the allowlisted manifest, icon, and approved asset bundle.

## Trusted Desktop Context

The Workspace manager remains authoritative for the selected product space. The Agent control manager consumes only a narrow snapshot getter and subscription callback supplied during main-process wiring.

The manager separates two component lifetimes:

- context components: draft store, publisher, and definition discovery, keyed by USER or the selected Workspace;
- runtime components: installation manager, verified version cache, Profile binding, Hermes adapter, and RuntimeBinding store, keyed only by the authenticated USER/device owner.

Changing the global product space swaps context components and refreshes the Agent screen. It does not select, create, clone, rename, move, or delete a Hermes Profile and does not mutate an active RuntimeBinding.

The renderer-facing `window.agenteraAgents` namespace remains exact. Scope and Workspace IDs are not added to publication or installation IPC inputs; the trusted main process supplies them from current state. This prevents renderer-controlled cross-Workspace operations.

## Desktop Experience

In Personal space, the existing Agent control experience remains unchanged.

In an active Workspace:

- Owner and Admin see local drafts for their account and that Workspace, may create/edit them, and may explicitly publish;
- Member sees published Workspace Agents and may install them, but cannot create, edit, or publish Workspace drafts;
- all roles see only local installations whose source is the selected Workspace;
- publication, discovery, installation, and update pause offline;
- verified installed Agents remain runnable locally;
- switching back to Personal restores the existing USER lists without altering the active Profile.

Workspace draft authoring is read-only while offline because cached role information may be stale. Failed publication or authorization never deletes the local draft.

## Read-Only Shared Assets

Workspace Knowledge, Skill, and SOP content uses the existing canonical AgentVersion bundle and verified projection path. The projection is staged outside `HERMES_HOME`, signature-checked, digest-checked, and made read-only before activation.

The projection may supply the installed immutable system prompt and approved version assets at conversation start. It must not copy over or write into `MEMORY.md`, `USER.md`, the Profile's writable `skills/`, sessions, credentials, files, Curator state, or local workspace directories. Name collisions follow the existing deterministic projection rules and remain visible in diagnostics.

## Conversation and Update Semantics

Each member Installation still receives one new or explicitly claimed physical Profile and one immutable RuntimeBinding per conversation.

The local RuntimeBinding remains `ownerScope: "USER"`. The AgentDefinition and AgentVersion IDs identify the installed Workspace base; they do not change ownership of runtime state. Selecting a newer Workspace version stages and verifies it, commits the USER installation's new policy, and affects only conversations created afterward. An active conversation keeps its original version, prompt, tool schema, Skill index, and adaptive snapshot.

## Error Handling

- stale base publication returns `version_conflict` without changing the draft;
- Member publication returns `workspace_forbidden` and records bounded audit evidence;
- outsider reads and installs return non-enumerating `not_found` or `workspace_not_found` according to the locked endpoint contract;
- archived or Owner-unavailable mutations return the existing Workspace lifecycle codes;
- invalid version, signature, digest, policy, or Runtime compatibility never activates;
- a cloud failure leaves the prior cached version, Profile, RuntimeBinding, and local learning unchanged;
- no failed operation queues private content or an automatic publication retry.

## Audit and Privacy

Successful publication and installation transactions record actor user, device, asset owner scope, Workspace ID when applicable, definition/version/installation IDs, request ID, outcome, and bounded reason metadata.

Denied publication/install attempts are audited without request bodies. Audit, logs, cache rows, and API payloads reject credentials, Profile paths, raw conversations, Memory, USER data, local files, unpromoted Skills, Curator data, and invitation secrets.

## Verification Gate

Cloud tests must prove:

- migration invariants for USER and WORKSPACE ownership variants;
- existing USER publication remains byte- and authorization-compatible;
- Owner and Admin can publish, Member cannot, and outsiders cannot enumerate;
- all active roles can install the same Workspace version into distinct USER installations;
- archived, Owner-unavailable, removed-member, and racing-role-change requests fail closed;
- immutable version, idempotency, audit, and version-selection invariants remain intact;
- OpenAPI and real PostgreSQL integration tests pass without cache.

Desktop tests must prove:

- SQLite v3 migration preserves existing USER drafts, caches, installations, bindings, and files;
- selected product context determines draft/discovery operations without renderer-supplied scope;
- Member authoring is blocked while installation remains available;
- two accounts can cache the same Workspace version without sharing rows or mutable paths;
- shared Knowledge, Skill, and SOP assets remain read-only projections;
- switching spaces leaves Profile selection and active RuntimeBindings unchanged;
- a Workspace v2 update affects a new conversation only;
- account removal, offline mode, publication failure, and update failure preserve local Profile bytes.

The deterministic end-to-end scenario is Owner publication to v1, Member installation into a separate Profile, Member-local Hermes learning, Owner/Admin v2 publication, manual Member update, old-conversation v1 stability, new-conversation v2 binding, and byte-identical private learning across every cloud request.

`aera-runtime` receives no implementation change. Existing Runtime compatibility gates remain release-blocking.

## Delivery Strategy

Implementation proceeds in independently testable local commits:

1. cloud ownership migration and repository authorization primitives;
2. nested Workspace Agent API, OpenAPI contract, and installation bridge;
3. desktop schema v3 and account-partitioned cache;
4. trusted Workspace context in Agent drafts, publication, discovery, and installation;
5. role-aware Agent UI and localized copy;
6. deterministic Workspace Agent E2E plus Hermes boundary and full regression gates.

No step merges to `main`, pushes, deploys, publishes a Runtime, or changes production configuration without separate authorization.
