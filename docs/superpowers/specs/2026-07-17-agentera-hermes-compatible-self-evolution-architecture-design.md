# AgentEra Hermes-Compatible Self-Evolution Architecture Design

## Goal

Build AgentEra's account, official Agent, workspace, organization, policy, audit, and versioning capabilities around Hermes Agent without weakening, replacing, delaying, or silently changing Hermes Agent's core runtime and self-learning behavior.

The first release guarantees continuous self-evolution on the same device and in the same Hermes Profile. Cross-device inheritance of private adaptive state is intentionally deferred because Memory remains local and the first release does not include encrypted backup.

## Non-Negotiable Compatibility Rule

AgentEra must not break Hermes Agent's core mechanisms or self-learning mechanisms.

This is a release-blocking invariant, not a preference. Any AgentEra change that alters session prompt stability, tool availability, Profile isolation, Memory behavior, background review, agent-created skills, Curator behavior, or offline local operation must be rejected unless compatibility is demonstrated by explicit regression tests.

AgentEra may add orchestration, identity, policy, versioning, and publication layers around Hermes. It must not replace Hermes's local learning loop with a cloud workflow or require cloud approval before local learning becomes durable.

Integration follows an adapter-first rule. AgentEra should consume stable Hermes entry points and keep product orchestration outside upstream core modules whenever possible. If a Runtime core change is unavoidable, it must be minimal, preserve default upstream behavior when AgentEra configuration is absent, and add a regression test for the affected invariant before the implementation change.

## Verified Hermes Behavior That Must Be Preserved

The design is based on the actual `aera-runtime` implementation, not only on product intent.

Hermes currently preserves these behaviors:

- A Hermes Profile is an independent `HERMES_HOME` with its own config, credentials, sessions, Memory, USER profile, skills, gateway, cron state, and logs.
- The system prompt, tool definitions, SOUL identity, skills index, and Memory snapshot are built once for a conversation and remain stable. Mid-session learning writes are durable but normally become prompt context in the next conversation.
- A periodic background review replays completed work in an isolated fork and may update built-in Memory or agent-created skills without modifying the foreground conversation or its prompt cache.
- `MEMORY.md` stores compact operational knowledge, `USER.md` stores user preferences and identity context, and agent-created skills store reusable procedures.
- Agent-created skills retain provenance and are maintained by Curator. Curator archives rather than automatically deleting them, and its optional LLM consolidation remains separate from the foreground conversation.
- External Memory providers are optional plugins. They are not part of AgentEra's default cloud sync and must never be enabled silently.

These behaviors define the compatibility baseline for every bundled AgentEra Runtime update.

The primary code anchors are `aera-runtime/agent/background_review.py`, `aera-runtime/agent/turn_finalizer.py`, `aera-runtime/tools/memory_tool.py`, `aera-runtime/tools/skill_manager_tool.py`, `aera-runtime/agent/system_prompt.py`, `aera-runtime/agent/curator.py`, and `aera-runtime/hermes_cli/profiles.py`. The incompatible imported desktop path is implemented in `src/main/agent-sync.ts`, `src/main/memory.ts`, `src/renderer/src/screens/Agents/Agents.tsx`, and `src/renderer/src/components/HermesAccountModal.tsx`.

## Approaches Considered

### Chosen: local evolution plus explicit candidate promotion

Hermes continues to learn immediately inside the active owner-scoped Profile. A separate AgentEra pipeline may turn selected local learning outputs into shareable candidates, but publication is optional and never gates local learning.

This approach preserves offline operation and upstream behavior while adding controlled workspace, organization, and official Agent evolution.

### Rejected: fully local evolution with no publication path

Keeping all learning local is the smallest and safest implementation, but it provides no controlled path for a user, team, or organization to reuse proven skills and knowledge. It remains the privacy fallback when promotion is disabled.

### Rejected: cloud-owned evolution

Uploading conversations, Memory, or skills and waiting for a cloud service to update the Agent would create a second learning engine, break offline behavior, introduce races with Hermes background review, and make tenant data boundaries harder to enforce. It also conflicts with the decision to keep private runtime data local.

## Two Independent Evolution Loops

### Local self-evolution loop

The local loop is owned by Hermes and cannot be blocked by AgentEra cloud availability.

1. The user runs a conversation in an owner-scoped Runtime Profile.
2. Hermes persists the conversation in that Profile's local state.
3. Hermes background review may update `MEMORY.md`, `USER.md`, or agent-created skills.
4. The active conversation keeps its original prompt and tool contract.
5. The next conversation snapshots the latest local Memory, USER profile, and skills index.
6. Curator maintains agent-created skills according to Hermes rules.

A failed background review is best-effort and does not fail the completed user turn. A cloud outage, expired sync endpoint, unavailable workspace service, or failed candidate upload does not suppress this loop.

### Shareable promotion loop

The promotion loop is owned by AgentEra and operates only on explicitly eligible learning output.

1. A successful local Memory or skill write records local provenance and a content hash.
2. The user or an authorized workspace/organization policy explicitly selects an eligible item for promotion.
3. A local candidate builder creates a minimal `ExperienceCandidate` from the selected knowledge or skill diff. Raw sessions are not attached by default.
4. Owner-scope checks, authorization, sensitivity classification, and DLP run before upload.
5. The destination owner or administrator reviews the candidate.
6. Approved candidates enter an Agent draft.
7. Evaluation, audit, and version publication produce a new immutable `AgentVersion`.
8. Eligible new conversations may bind to that version according to installation update policy.

Rejecting, timing out, or failing a candidate never removes or rolls back the original local learning.

## Layered Agent Model

An installed Agent is not a single mutable profile copied between owners. It is a composition of three layers.

### Immutable base version

`AgentVersion` is a published, immutable bundle containing the shareable Agent definition: identity template, curated skills, approved knowledge, default tool declarations, compatibility metadata, and version manifest.

Official versions are platform-owned. User, workspace, and organization versions are owned by their corresponding `owner_scope`. Updating a version creates a new version; it never mutates a published artifact in place.

### Installation and policy overlay

`Installation` connects an Agent definition to one owner scope. It holds update policy, allowed version range, model constraints, tool policy references, and administrator-managed configuration.

Installation policy does not own sessions, Memory, USER data, files, or local learned skills.

### Private runtime and local adaptive state

`PrivateRuntimeState` belongs to one `RuntimeProfile` and contains sessions, files, credentials, local configuration, pending approvals, and other non-shareable operational data.

`LocalAdaptiveState` is the self-learning subset of that private state:

- `MEMORY.md` and `USER.md`;
- agent-created skills and their provenance;
- Curator state and recoverable archives;
- local learning drafts that have not been promoted.

An official version update may replace the immutable base version for a new conversation, but it must not overwrite, merge into, or delete private runtime or adaptive state.

## Runtime Profile and Physical Isolation

Every runnable installation receives a distinct `RuntimeProfile` mapped to one physical `HERMES_HOME`. Database `owner_scope` fields alone are not sufficient isolation.

The minimum identity tuple is:

```text
tenant_id / owner_scope / owner_id / installation_id / runtime_profile_id
```

Two installations must not share a writable Memory directory, skills directory, session database, credential file, Curator state, or local workspace directory, even when they belong to the same signed-in user.

Workspace and organization knowledge is exposed as a read-only approved layer, such as versioned external skills or version artifacts. It is not copied into a user's writable `MEMORY.md`. Personal learning is not automatically added to a workspace or organization candidate pool.

Hermes's generic Profile clone remains available for deliberate same-owner duplication, but AgentEra cross-scope publication must never call the generic clone path because that path can copy credentials, Memory, USER data, and skills.

## Runtime Binding Semantics

`RuntimeBinding` is immutable for one conversation or isolated job. In the diagram and implementation, “task start” means creating a new Hermes conversation/job boundary, not every message or internal tool iteration.

The binding records at least:

```text
tenant_id
owner_scope
owner_id
workspace_id
organization_id
agent_definition_id
agent_version_id
installation_id
runtime_profile_id
runtime_distribution_version
memory_scope_id
local_adaptive_revision
policy_snapshot_id
tool_permission_snapshot_id
created_at
```

The active conversation retains the same Agent version, prompt composition, skill index, and tool schema. A newer official version, newly promoted skill, changed SOUL file, or changed ordinary policy becomes effective in a new conversation.

Emergency revocation is the sole security exception. A live deny overlay may block a tool action at execution time without changing the advertised tool schema or rebuilding the system prompt. The denial is audited against both the original snapshot and the revocation event.

## Prompt and Asset Composition

At conversation creation, AgentEra resolves the binding and supplies Hermes with a stable composition:

1. immutable base identity and approved version assets;
2. installation and policy instructions;
3. owner-scoped read-only shared knowledge;
4. the Runtime Profile's private Memory, USER profile, and local skill index;
5. conversation context and environment information.

The resulting prompt and tool definitions are frozen according to Hermes behavior. AgentEra must not poll cloud state on every message to rebuild them.

Official or shared version skills should be materialized as read-only versioned assets. Locally learned skills stay in the Profile's writable skills area. Name collisions must be deterministic and visible; a local override may affect only that Runtime Profile and must not mutate the published base artifact.

## Cloud Data Boundary

AgentEra cloud stores account and tenant identity, Agent definitions and versions, installations, RuntimeBinding metadata, policy snapshots, audit metadata, and explicitly promoted candidates.

The default cloud boundary excludes:

- raw conversations and message bodies;
- `MEMORY.md` and `USER.md`;
- local files and workspaces;
- local session databases;
- agent-created skills that have not been explicitly promoted;
- API keys, provider credentials, and local environment files;
- Curator working state and archives.

Audit records contain actor, scope, object identifiers, action, result, timestamps, and hashes. They do not duplicate private content merely for audit convenience.

Operational telemetry for official Agents may include version id, success/failure classification, latency, token totals, and crash diagnostics without message content. User feedback may be attached without raw conversation content. Conversation content requires a separate explicit consent event and remains unavailable to self-created Agent improvement by default.

## Current Desktop Incompatibilities

The imported desktop currently performs automatic bidirectional profile sync for color, SOUL, model/provider, and the complete `MEMORY.md`. It may also replace `MEMORY.md` wholesale when the remote copy wins, and it triggers sync after sign-in and on the Agents screen.

That behavior conflicts with this design because it can race with Hermes background review, overwrite local learned entries, blur Agent definition and runtime state, and violate the local-Memory decision.

Before AgentEra cloud identity or official Agent installation is enabled, the legacy sync path must be contained:

- automatic Memory push and pull must be disabled;
- no remote operation may call whole-file `writeMemoryRaw` for AgentEra sync;
- official Agent updates must use immutable version installation rather than generic profile reconciliation;
- SOUL and model/provider behavior must be separated into definition, installation, and local override semantics;
- existing local data must remain untouched during the transition.

This containment is the first implementation priority.

## Offline Behavior

A valid signed device session permits local Agent use and local self-evolution for up to seven days without network access.

Here, offline entitlement means the AgentEra identity and control plane may be unreachable. It does not imply that an API-hosted model can infer without access to its configured endpoint. Model-dependent conversations, background review, and LLM Curator consolidation proceed only when that model endpoint remains reachable.

During offline operation:

- local data, settings, existing conversations, Memory, skills, files, and non-model local operations remain accessible;
- when the configured model endpoint is reachable, conversations and Hermes self-learning continue without requiring the AgentEra control plane;
- when the model endpoint is unreachable, AgentEra preserves all local state and does not substitute a cloud learning engine or fabricate a review result;
- new local RuntimeBindings may be derived from the last valid cached installation, version, entitlement, and policy snapshots;
- cloud sync, candidate upload, organization membership changes, and official version discovery pause;
- queued candidate metadata may remain local, but private content is not uploaded until authorization and network checks succeed;
- restoring connectivity revalidates the device session before cloud operations resume.

If the seven-day entitlement expires, AgentEra may require authentication before starting another user-facing conversation. It must preserve all local adaptive state and must not delete, reset, or upload it.

## Runtime Update Compatibility Gate

Every AgentEra Runtime seed or update must pass a compatibility gate before release.

The gate includes:

1. the relevant upstream Hermes test suite against an unmodified default Profile;
2. a foreground conversation that preserves one prompt/tool fingerprint across messages;
3. a background review that writes only to the bound Profile;
4. proof that a mid-session Memory or skill write does not rewrite the active prompt;
5. proof that a new conversation observes the durable learning;
6. proof that Curator provenance, pinning, archive, and recovery behavior remains intact;
7. proof that an official version update preserves local Memory, USER data, learned skills, sessions, and files;
8. cross-profile and cross-owner negative tests;
9. cloud-unavailable and seven-day offline tests;
10. migration tests against an existing user Profile with real local adaptive state.

A failed gate blocks packaging and release. AgentEra branding, account, policy, or cloud test success cannot override a Hermes compatibility failure.

## Error and Conflict Handling

- Cloud failure never fails an already completed local turn.
- Candidate upload failure remains retryable and does not alter local learning.
- Invalid signatures, hashes, compatibility ranges, or manifests prevent an Agent version from activating; the last valid version remains selected.
- A partial installation is staged outside the live Profile and switched atomically only after verification.
- Policy service failure uses the last valid signed snapshot within the offline entitlement window; missing or invalid policy does not trigger a silent permissive fallback for cloud or enterprise actions.
- Local adaptive state is never resolved with whole-file last-writer-wins synchronization.
- Cross-scope conflicts fail closed and require an explicit publish/import action.
- Background review and Curator failures are observable but remain best-effort, matching Hermes behavior.

## Delivery Decomposition

This architecture is delivered through independently testable projects rather than one cross-repository rewrite.

### Project 1: compatibility foundation and legacy sync containment

Create the compatibility test harness, record the Runtime/Profile mapping contract, disable legacy Memory synchronization, and ensure no current AgentEra surface overwrites Hermes adaptive state.

### Project 2: immutable Agent definition, version, installation, and binding

Introduce the cloud data model and desktop materialization path for immutable version artifacts, distinct installations, physical Runtime Profiles, and conversation-scoped RuntimeBinding snapshots.

### Project 3: authentication and personal space

Implement required registration/login, signed seven-day offline device sessions, automatic personal-space creation, and local Agent access after authentication without adding cloud Memory sync.

### Project 4: explicit experience candidate promotion

Add local provenance events, user selection, DLP and authorization, review queues, draft generation, evaluation, and version publication. Do not reprocess all raw conversations by default.

### Project 5: workspace and organization scopes

Add membership, role policy, read-only shared assets, organization audit, and cross-owner publication after the personal-space boundary is proven.

Cross-device private adaptive-state migration, end-to-end encrypted backup, and automatic content donation remain later standalone projects.

The implementation plan immediately following this design covers Project 1 only. Each later project requires its own scoped plan and review gate after the compatibility foundation is proven.

## Testing Strategy

Implementation follows test-driven development. Every project begins with failing tests that encode this compatibility contract before production changes.

Tests are split into four layers:

- Runtime contract tests verify native Hermes learning and session invariants.
- Desktop integration tests verify Profile selection, binding materialization, update behavior, offline operation, and absence of automatic Memory sync.
- Cloud contract tests verify owner scope, immutable versions, authorization, candidate consent, audit metadata, and negative data-boundary cases.
- End-to-end tests run an existing learned Profile through login, offline use, official Agent installation, version update, local learning, optional promotion, and rollback.

Golden fixtures include a Profile with Memory, USER entries, agent-created skills, Curator state, session history, and local files. Every migration and update test compares hashes before and after to prove that private adaptive state remains intact.

## Acceptance Criteria

- The same-device, same-Profile Hermes self-learning loop behaves the same with AgentEra features enabled or disabled.
- AgentEra cloud availability and candidate approval never gate local Memory or skill durability.
- A running conversation never changes Agent version, ordinary policy snapshot, prompt composition, skill index, or tool schema mid-session.
- A new conversation observes durable Hermes learning and the latest allowed immutable base version.
- Every installation maps to a physically isolated writable `HERMES_HOME`.
- Official updates and cross-scope publication cannot overwrite or copy private adaptive state.
- `MEMORY.md`, `USER.md`, raw sessions, files, credentials, and unpromoted agent-created skills remain local by default.
- The legacy automatic whole-file Memory sync is disabled before AgentEra cloud Agent rollout.
- The seven-day control-plane-offline path preserves local state and permits self-evolution whenever the configured model endpoint is reachable, without deleting or uploading private data.
- Runtime packages cannot release unless the Hermes compatibility gate passes.

## Explicit Non-Goals for the First Release

- Cross-device synchronization of `MEMORY.md`, `USER.md`, or agent-created skills.
- Encrypted cloud backup or restore of private adaptive state.
- Training or fine-tuning model weights; all model execution continues through configured APIs.
- Automatic organization sharing of personal learning.
- Uploading raw conversations for official or self-created Agent improvement by default.
- Replacing Hermes background review, Memory tools, skill tools, Curator, session storage, or Profile layout with AgentEra-specific implementations.
