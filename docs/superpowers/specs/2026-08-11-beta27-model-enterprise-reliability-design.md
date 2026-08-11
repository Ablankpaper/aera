# Beta.27 Model and Organization Reliability

This design makes model configuration authoritative and recoverable, isolates Organization submission-reference drift, and lets an installed Agent change model or provider without rewriting an existing immutable RuntimeBinding or breaking the visible conversation.

## Scope

Beta.27 closes four related Desktop failures:

1. Editing or adding a provider/model can partially persist and still report a generic save failure.
2. Model Center and the Agent surface can read different Profile sets, so a valid newly saved route is followed by “configure a model first”.
3. One stale Organization submission reference can fail the entire submission list, and the same request and error are rendered twice.
4. The chat model picker changes renderer state, but an installed Agent continues to use the model frozen into its first RuntimeBinding.

The work is owned by Aera Desktop. It does not relax the Cloud OpenAPI contract, mutate an immutable AgentVersion, upload local model routes or credentials, or modify Aera Cloud, Admin, Runtime, API, or website repositories. It does not delete existing Profiles, drafts, Organization submissions, RuntimeBindings, ConversationBoundaries, Hermes sessions, Memory, credentials, or model records as part of migration.

## Evidence and root causes

### Split model-Profile authority

`selectAgentModelProfileId()` prefers the active configured Profile, including an installed Agent Profile. Model Center therefore writes a new provider and active model to that Profile. `modelSourceProfileIds`, however, excludes every installed Agent Profile whenever any account Profile exists. `listAgentRuntimeModelRoutes()` then reads a different Profile set and returns no route for the saved model.

The current tests mock the Agent bridge without exercising this installed-Profile/account-Profile combination, so both halves can pass independently while the real UI reports that no model is configured.

### Multi-file save with one generic catch

Model Center currently writes the credential, `providers.json`, global `models.json` rows, and the Profile's `config.yaml` through separate IPC calls. It then reads the active model and reloads UI data inside the same `try` block. There is no transaction coordinator or rollback. A late read/reload failure is indistinguishable from a persistence failure, and the empty `catch` removes the failed stage and safe diagnostic code.

The inspected local Profiles parse successfully and contain no duplicate routes, invalid provider collection, or known legacy row shape that explains every historical failure. The repair therefore targets the demonstrated coordination defect rather than guessing a single transient filesystem step.

### Batch-fatal Organization reconciliation

`listSubmissions()` validates and reconciles every Cloud row with `values.map(...)`. `refreshSubmissionReference()` throws the same `organization_submission_conflict` code for digest drift, definition drift, local publication-record failure, and compare-and-set failure. One thrown row rejects the whole list. Refresh repeats the same batch-fatal reconciliation and cannot isolate the stale reference.

`AgentControlPanel` also fetches submissions for draft lifecycle derivation while `OrganizationSubmissionPanel` independently fetches the same list for presentation. This duplicates the Cloud request and renders the same failure twice.

The inspected local database is structurally healthy. Its single reference, draft ownership, revisions, and published binding are well-formed, which narrows the observed conflict to a Cloud/local approved-reference mismatch. Model settings do not write the submission-reference table, so this design does not claim that changing a model caused the Organization conflict.

### Immutable binding wins over the picker

Ordinary chats pass a persisted `{ provider, model, baseUrl }` session override to the transport. Installed Agent preparation instead selects `existing?.modelRoute ?? currentModelRoute`, and the send boundary prefers `preparedAgentTurn.modelOverride` over the renderer override. This correctly prevents silent RuntimeBinding mutation, but it also means the picker can display a new route while Main still sends through the old route.

## Approaches considered

### Patch the two renderer conditions

Including the active installed Profile in one array and changing the generic save message would remove the immediate symptoms. It would leave multi-file partial commits, duplicate Organization reads, batch-fatal reconciliation, and misleading Agent model switching intact. This is rejected as incomplete.

### Mutate the current RuntimeBinding and Hermes session

Overwriting `modelRoute` on an existing RuntimeBinding would make the picker appear to work with minimal UI changes. It would destroy the immutable audit boundary, make earlier messages falsely appear to have used the new route, and introduce unsafe credential and policy drift. This is rejected.

### Main-owned coordinators and immutable conversation segments

The selected approach adds one Main-owned route catalog, one model-configuration coordinator, per-item Organization reconciliation, and a stable visible conversation composed of immutable runtime segments. It preserves current privacy and ownership boundaries while making each failure recoverable and testable at its actual stage.

## Architecture invariants

- Cloud and shared Agent assets never receive provider endpoints, Profile paths, credential references, API keys, local conversation segments, or model-picker state.
- Every runnable Installation, Runtime Profile, RuntimeBinding, ConversationBoundary, thread, and segment remains USER-owned and device-local.
- AgentVersion and tenant policy remain the authority for `user_select`, `allowlist`, and `fixed` model policy.
- A RuntimeBinding and ConversationBoundary remain immutable after creation. A route change creates a new segment rather than rewriting the prior segment.
- Apart from the transient Model Center form and its single save IPC request, API keys are resolved only in Main from the selected same-owner source and are never persisted in a thread, segment, RuntimeBinding, renderer store, log, error, or Cloud outbox.
- Ordinary non-Agent chat retains its current session-override behavior unless a focused compatibility test proves a required shared correction.
- A refresh or presentation failure cannot turn a committed model save into a reported persistence failure.
- A corrupt local Organization reference cannot hide unrelated valid Cloud submissions.

## Owner model-route authority

### One catalog service

Main introduces an `OwnerModelRouteCatalog` as the only authority used by Model Center, Agent installation/repair, and Agent conversation switching. Renderer components no longer construct competing Profile lists or infer credential availability.

The catalog resolves a route from a local opaque selection:

```ts
interface AgentRuntimeModelSelection {
  sourceProfileId: string;
  modelLibraryId: string;
  catalogRevision: string;
}
```

Main expands that selection into a private resolved route containing canonical provider, model, Base URL, API mode, source Profile, model-library identity, and a credential reference. The renderer receives display fields, the opaque selection, and availability/policy state; it never receives the credential reference or value.

Route identity is the canonical tuple `provider + model + normalizedBaseUrl + apiMode`. Provider labels are presentation metadata and cannot select a route. A stale `catalogRevision`, renamed provider, changed endpoint, missing model row, missing credential, foreign Profile, or owner change fails closed and requires a refreshed selection.

### Deterministic Profile order

The catalog enumerates only Profiles already verified by Main to belong to the current owner. It uses this order:

1. an explicitly selected non-Agent account Profile;
2. the owner's default non-Agent account Profile;
3. remaining non-Agent account Profiles in stable Profile-ID order;
4. the active installed Agent Profile as a legacy fallback;
5. remaining same-owner installed Agent Profiles only for non-destructive legacy discovery.

Routes are deduplicated by canonical route identity, keeping the first usable source. A route without required credential evidence is not selectable. Local endpoints remain selectable without an API key under the existing local-endpoint rule. OAuth-only routes remain unavailable for isolated Agent execution until a transport can reference them without copying private tokens.

Model Center writes new global/default configuration to the resolved non-Agent account Profile even when an installed Agent is the active shell Profile. Agent execution Profiles remain runtime targets rather than configuration catalogs.

### Legacy convergence

Existing routes found only in an installed Agent Profile remain visible as `legacySource` so Beta.26 users are not locked out. Selecting or editing such a route revalidates same-owner access and non-destructively copies the provider identity, model row, API mode, and credential into the canonical account Profile before use. The old installed-Profile entries are not automatically removed. Future reads prefer the canonical account source.

Model/provider/config change events carry the affected Profile and a monotonically changing catalog revision. Model Center, Agents, and the active picker reload the same catalog snapshot, eliminating the current event race between an updated Profile list and a stale route list.

## Model configuration coordinator

### Single mutation boundary

Renderer replaces the sequence of `setEnvValue`, `upsertCustomProvider`, repeated `addModel`, `setModelConfig`, readback, and reload calls with one typed Main request. The request supports create, edit, activate, and delete intents and carries an API key only for the duration of the IPC call.

Main serializes mutations per owner and target Profile. A prepared operation validates all bounded input, owner/Profile access, provider identity, endpoint policy, API mode, credential requirement, model IDs, duplicate canonical routes, delete dependencies, and the expected catalog revision before writing any file.

### Commit order and rollback

The coordinator reads and validates snapshots of every affected document before commit, builds complete next documents in memory, and writes through sibling temporary files plus atomic rename where the filesystem supports it. The dependency-first commit order is:

1. credential store or Profile `.env` update;
2. provider identity update;
3. model-library update;
4. native provider/API-mode update;
5. active `config.yaml` route last.

The active route therefore never points at a dependency that this operation has not already committed. A failure in the running process restores every successfully changed document from the validated snapshots in reverse order and verifies the previous active route. Rollback failure returns a distinct recovery-required result and preserves the affected Profile for repair rather than continuing with unverified state.

The Desktop database stores the operation journal in `desktop_model_configuration_operations`. It contains only operation ID, owner/Profile handles, stage, canonical non-secret route identity, file-state digests, and timestamps. It never contains key values or raw file bodies. After a process crash, dependency-only additions are safe and inactive because `config.yaml` is committed last. Startup recovery verifies the active route and either completes an idempotent non-secret dependency write or reports `model_configuration_recovery_required`; it never guesses or deletes a credential.

Delete operations use the same coordinator. A route that is active in any Profile or referenced by an active Agent segment must first select a valid replacement. Historical segment metadata is retained even after its provider is removed; it becomes unavailable for future calls but is not rewritten.

### Result semantics

The mutation returns one of three states:

- `committed`: persistence and authoritative readback succeeded;
- `committed_refresh_warning`: persistence succeeded but a presentation reload failed;
- `rejected`: no new active route was committed, with a bounded failed stage and rollback/recovery status.

UI closes the editor and updates from the returned authoritative snapshot for both committed states. A refresh warning says the change was saved and offers refresh; it never says “save failed”. A rejected result keeps the editor open and maps the stage to localized guidance. Safe stages are `validation`, `credential`, `provider`, `model_library`, `native_route`, `activation`, `verification`, `rollback`, and `recovery`. Raw paths, environment-variable values, YAML/JSON bodies, stack traces, and secrets remain in neither IPC nor telemetry.

## Organization submission resilience

### Per-item reconciliation

The Organization service separates Cloud record validation from local-reference reconciliation. Each valid Cloud record produces a summary even when its optional local reference is stale. Local reconciliation returns a typed result instead of throwing out of the list:

```ts
type SubmissionReferenceState =
  | { kind: "verified"; draftId: string; draftRevision: number }
  | { kind: "remote_only" }
  | { kind: "quarantined"; stage: SubmissionReferenceConflictStage };
```

Bounded stages distinguish `reference_shape`, `content_digest`, `definition`, `published_version`, `draft_publication`, and `compare_and_set`. The renderer receives only the stage and a canonical Cloud submission ID. It does not receive local database details or conflicting digest values.

A malformed individual Cloud row is omitted and contributes one bounded `cloud_record_invalid` issue; other valid rows remain readable. The entire list fails only when the request, authentication/authorization, Organization identity, or top-level response cannot be trusted.

### Quarantine and repair

Schema migration adds a local conflict table keyed by Organization and Cloud submission ID. It stores only the bounded stage, first/last observed timestamps, and reference revision. The original reference is not rewritten when quarantined. A later refresh reconciles every item independently and clears the conflict record when the same trusted reference verifies again.

Automatic repair is allowed only when the existing reference, local draft, Cloud definition, digest, revision, and published Version converge exactly and the local publication update is idempotent. No digest, definition, or revision is guessed from a newer draft.

For a persistent mismatch, an advanced “disconnect local draft link” action requires explicit confirmation. It archives the bounded conflict metadata and removes only the active local link in one transaction. It does not delete or modify the Cloud submission, local draft, published Version, Installation, Profile, or Hermes state. The Cloud submission then remains visible as `remote_only`.

### One request and one error surface

`AgentControlPanel` owns the single submission-list request because it needs the data for draft lifecycle derivation. It passes the result, issues, loading state, and mutation callbacks to `OrganizationSubmissionPanel`, which becomes presentational and no longer performs a second list request.

A quarantined item renders its normal Cloud status plus one localized local-link warning on that card. Other cards and definitions remain usable. Page-level error is reserved for a list-wide failure. Refresh re-runs one request; a persistent conflict remains an item warning rather than an unrecoverable duplicated page error.

## Agent conversation model switching

### Stable thread, immutable segments

An installed Agent conversation becomes one visible `ConversationThread` containing one or more ordered `ConversationSegment` records. The thread owns the stable visible identity. Each segment owns one immutable resolved model route, RuntimeBinding, ConversationBoundary, and Hermes session.

The local control-plane schema adds:

- `conversation_threads`: UUID, owner/device tuple, root conversation key, active segment ID, compare-and-set revision, and timestamps;
- `conversation_segments`: UUID, thread ID, ordinal, segment conversation key, non-secret resolved route, source Profile/model row handles, RuntimeBinding ID, ConversationBoundary ID, Hermes session ID, history boundary count, state, and timestamps.

Segment states are `preparing`, `active`, `superseded`, and `failed`. There is one active segment per thread. Tables contain no prompt/message bodies, API keys, credential values, Memory, files, or Cloud payloads. The credential reference needed for Main re-resolution is non-secret, local-only, and excluded from the RuntimeBinding Cloud record.

### Switch protocol

The existing bottom model picker remains the user entry point. For an installed Agent, a different selection is staged for the next send rather than pretending the existing RuntimeBinding has changed.

On the next send Main performs this protocol:

1. Reject while the same visible run is generating or while another switch owns the thread revision.
2. Resolve the opaque selection against the current catalog revision and current owner.
3. Validate provider, model, Base URL, API mode, credential availability, AgentVersion policy, tenant policy, Installation, Profile, and Runtime ownership.
4. If the canonical route equals the active segment route, reuse the active segment.
5. Otherwise create a `preparing` segment, RuntimeBinding, and ConversationBoundary in one `BEGIN IMMEDIATE` transaction while leaving the prior segment active.
6. Start a fresh Hermes session through the bound API/gateway transport, attach its session ID to the candidate binding/boundary/segment in one transaction, and send the new turn with the existing normalized visible history and current attachments. The prior segment remains active at this point.
7. Before any output or tool activity, a transport/setup failure marks the candidate failed and keeps the prior segment active. The failed candidate remains local diagnostic history and is hidden from normal recents.
8. On the first output/tool activity, or on successful completion when no earlier event exists, atomically compare-and-set the candidate active and mark the previous segment superseded. A later error is reported without automatic replay, so side effects cannot execute twice; both segments remain immutable and readable.

Switching back to an earlier provider creates another segment. It never reopens or mutates the historical segment.

### Context and presentation

The first request in a new Hermes session receives the same normalized, bounded visible history that the current send pipeline already supplies. Beta.27 does not add a hidden model-generated summarization call. If an existing trusted conversation summary is already available, the normal context builder may use it; otherwise it applies the existing deterministic context limits.

The thread records the visible message count at each switch. The renderer inserts a non-prompt marker such as “Model changed from A to B” at that boundary. Old messages retain their original segment attribution; the marker is UI/audit metadata and is never injected as a user instruction.

Recent-session listing collapses segment Hermes sessions into one visible thread and points to the active segment. Resuming by any known segment session resolves the owning thread and opens its active visible history. The active Hermes session contains the transferred bounded history, while segment boundaries supply markers and attribution. Deleting a visible thread uses the existing safe session-deletion path for every known segment session and removes only its local thread/segment metadata.

### Policy and credential behavior

- `user_select`: any current-owner catalog route that is usable on the target runtime may be selected.
- `allowlist`: the selectable set is the intersection of the catalog, signed AgentVersion allowlist, and effective tenant policy.
- `fixed`: the picker is disabled for that Agent and displays the signed policy reason.

Main derives API mode and credential reference from the catalog; renderer-provided provider/model/Base URL text cannot override them. Secret values are resolved just in time. Local execution may use the verified same-owner credential without placing it in segment state. SSH/remote switching is allowed only when the remote runtime proves the selected route is already configured there; Desktop does not copy a local secret over SSH. Unsupported remote changes fail with bounded guidance and leave the old segment active.

Attachment turns remain on the gateway/API transport so images and paths are not dropped by the legacy CLI fallback. A provider removal, expired credential, or upstream outage can make a historical route unavailable; “does not affect the conversation” means history and prior attribution are preserved and the old segment is not rewritten, not that an unavailable provider is guaranteed to keep answering.

## Migration and compatibility

The control-plane migration is additive and advances `AGENTERA_CONTROL_PLANE_SCHEMA_VERSION` from the current 11 to 12 for the Organization conflict table plus thread/segment tables. The separate Desktop model-operation journal is added through the existing Desktop database initializer. Existing rows are not rewritten in bulk.

An existing installed-Agent conversation is lazily adopted on resume: Main creates one thread and one active segment around its verified RuntimeBinding, ConversationBoundary, and Hermes session. A legacy binding whose route lacks new API-mode or credential-reference metadata remains readable and frozen; Main derives a complete route only when creating a later segment.

Existing installed-Agent session overrides are treated as a requested selection only after catalog, owner, credential, and policy revalidation. The ordinary `desktop_session_model_overrides` table and non-Agent behavior remain compatible. New Agent segment state becomes authoritative only for installed Agent threads.

If migration, lazy adoption, route resolution, or thread compare-and-set fails, the existing conversation remains readable and the current segment remains active. The product does not instruct the user to clear all application data or recreate the Agent.

## Error handling

New local error families are bounded and localized:

- model configuration: `model_save_<stage>_failed`, `model_save_refresh_failed`, and `model_configuration_recovery_required`;
- Organization reference: `organization_submission_reference_conflict` with a bounded stage and `organization_submission_reference_detach_failed`;
- Agent switching: `model_switch_in_progress`, `model_switch_fixed_policy`, `model_switch_route_stale`, `model_switch_route_unavailable`, `model_switch_credential_unavailable`, `model_switch_remote_unavailable`, `model_switch_history_failed`, and `model_switch_segment_conflict`.

The existing generic codes remain accepted for old clients and legacy rows. Logs may include operation/segment IDs and safe stage codes, but never API keys, authorization headers, raw provider responses, prompt history, Profile paths, database paths, conflicting digests, or private owner identifiers.

## UI behavior

- Model Center shows the authoritative target account Profile and route source when legacy data is being converged.
- A committed save updates the card and active route immediately from Main's returned snapshot. A later reload warning is visibly different from a rejected save.
- The Agent creation/install controls consume the same route catalog. “Configure a model first” appears only when the authoritative catalog truly has no policy-eligible usable route.
- Installed-Agent picker options are policy-filtered. Fixed policy explains why switching is unavailable.
- The picker is disabled during generation and while a segment switch is preparing.
- A successful switch inserts one model-change marker and updates the displayed active route from Main acknowledgement, not optimistic renderer state.
- A pre-output switch failure preserves the previous selection and conversation and offers retry/configuration guidance.
- Organization submission conflicts appear once on the affected card; healthy submissions and Agent definitions remain visible.

## Test design

Implementation follows failure-first tests. Each test must fail for the demonstrated reason before production code changes.

### Route/Profile tests

1. An active installed Agent Profile containing the newly saved route alongside a configured account Profile produces the same route in Model Center, Agent installation, and Agent picker catalogs.
2. Deterministic precedence and canonical deduplication cover active/default/other account Profiles plus legacy installed Profiles.
3. Foreign-owner, stale revision, missing credential, OAuth-only, renamed custom provider, Base URL drift, and API-mode drift fail closed.
4. Legacy installed-only configuration converges to the canonical account Profile without deleting the source.

### Save coordinator tests

1. Failure injection at every commit stage proves reverse rollback and preservation of the prior active route.
2. A post-commit reload failure returns `committed_refresh_warning`, not save failure.
3. Readback mismatch returns verification failure and restores the prior snapshot.
4. Crash-state fixtures before and after active-config commit prove that startup recovery never activates an incomplete route or logs a secret.
5. Concurrent saves serialize, and stale catalog revisions cannot overwrite a newer edit.
6. Delete refuses a route still active or referenced until a replacement is selected.

### Organization tests

1. One good Cloud submission and one digest-conflicted local reference return both Cloud summaries; only the affected item is quarantined.
2. Every typed conflict stage is covered and contains no raw digest, path, or database message.
3. A malformed individual Cloud row does not hide other valid rows, while an untrusted top-level response still fails closed.
4. Refresh clears a conflict only after exact convergence; persistent drift remains one item warning.
5. Confirmed detach removes only the local link and leaves the draft, Cloud summary, Version, and Installation intact.
6. Renderer coverage proves exactly one list request and one visible warning.

### Conversation segment tests

1. `user_select` switches model within one provider and across providers while preserving the visible history and immutable old binding.
2. Provider, model, Base URL, API mode, source Profile, credential reference, and catalog revision are all revalidated in Main.
3. `allowlist` exposes only the policy intersection; `fixed` rejects before creating a segment.
4. Same-route selection reuses the segment; each different route creates one new binding/boundary/session atomically.
5. Cold restart and resume by any segment session recover one visible thread and the correct active route.
6. Pre-output failure keeps the old segment active; output/tool activity prevents automatic replay; compare-and-set races create no double-active segment.
7. Attachment, long-history, local endpoint, remote/SSH rejection, provider removal, and credential expiry paths preserve history and fail safely.
8. Ordinary chat session overrides and same-provider gateway behavior do not regress.

### Verification gates

Focused Vitest files, control-plane schema migration tests, Node and renderer type checks, affected lint/format checks, `lat check`, `git diff --check`, and a production build must pass.

The isolated Electron acceptance uses temporary user data, temporary Hermes homes, a copied/fixture control-plane database, and two controlled local provider endpoints. It must prove:

1. save/edit/readback survives a cold restart;
2. the Agent page immediately sees the saved route without “configure a model first”;
3. a `user_select` Agent answers through provider A, switches to provider B in the same visible thread, preserves history and the marker, and resumes provider B after restart;
4. a fixed-policy Agent cannot switch;
5. one mismatched Organization reference does not block the remaining enterprise catalog and appears only once;
6. no daily-use Electron Profile, real credential, production account, or production Cloud mutation is used.

## Beta.27 delivery boundary

Implementation targets branch `aera/beta27-model-enterprise-reliability` based on current `origin/main`. The feature commits and exact-head checks do not themselves constitute a Beta.27 release, push, merge, deployment, or user acceptance.

After implementation and isolated Electron acceptance, Beta.27 versioning and release artifacts are prepared as a separate immutable release step. A release claim requires exact-head CI, merged-main CI, artifact identity, updater publication, and a physical internal-client update check as separate evidence layers.

## Success criteria

The work is complete when all of the following are true:

- Model edits are committed or rejected with accurate stage semantics; a UI refresh failure cannot masquerade as a failed save.
- Model Center, Agent installation, and Agent chat consume the same owner-scoped route catalog and the Profile split regression is green.
- Organization enterprise content remains readable with one stale local submission reference, and the warning is isolated, actionable, and rendered once.
- A policy-eligible installed Agent can switch model or provider in one visible conversation without rewriting old messages, bindings, boundaries, or segment attribution.
- Switching failure leaves a safe usable segment whenever replay is safe, and never duplicates tool side effects.
- Cold restart, migration, ordinary chat compatibility, privacy boundaries, and isolated Electron acceptance are green.
- No claim of Beta.27 publication is made until release and updater evidence exists.
