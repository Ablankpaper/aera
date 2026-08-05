# AgentEra Agent control plane V1

The first AgentEra control-plane slice publishes USER-owned stable Agent versions without turning drafts or Hermes private runtime state into cloud data.

## First-release boundary

The original V1 slice implements `owner_scope=USER`; the approved Workspace Agent extension now adds WORKSPACE-owned definitions and versions without expanding runtime-data ownership.

The cloud is an identity, version, policy, installation, binding-metadata, and audit control plane. Agent execution and model access stay on the user's computer.

## Approved Workspace Agent extension

The next approved slice adds Workspace ownership only to published AgentDefinition and AgentVersion assets while keeping each member's Installation, RuntimeBinding, physical Hermes Profile, and adaptive state USER-owned.

Owner and Admin may publish immutable Workspace versions, and active Members may discover and install them. The desktop derives the target from the trusted global Workspace context rather than renderer-supplied ownership fields. Shared Knowledge, Skill, and SOP assets enter Hermes only through the existing verified read-only projection. The locked design is `docs/superpowers/specs/2026-07-20-agentera-workspace-agent-v1-design.md`.

## Approved Organization foundation boundary

The approved enterprise foundation adds Organization identity, transferable ownership, roles, Departments, signed policy, audit, lifecycle, and trusted product context before Agent control accepts Organization-owned assets.

[[agentera-organizations|Organization Foundation V1]] deliberately exposes an explicit unavailable Agent state while an Organization is selected. It does not map Organization navigation to USER ownership, create an Installation, or touch a Hermes Profile. The approved written Organization Agent V1 specification defines the separate gate that will replace this stop.

## Organization Agent V1 design checkpoint

The approved direction extends published assets to `owner_scope=ORGANIZATION` while every employee Installation, policy overlay, RuntimeBinding, physical Hermes Profile, and adaptive state remains USER-owned.

Editable drafts remain local to an Owner/Admin device. Submission creates one immutable cloud review package, and one current Owner or Admin approval is sufficient before the cloud signs and inserts an immutable AgentVersion. The submitter may perform that approval; authorization, policy, DLP, lifecycle, revision, and idempotency are still rechecked transactionally. No direct Organization publish route exists.

Owner/Admin/Auditor may inspect review history, while active Owner/Admin/Member may discover and install approved versions. Organization policy and DLP run at submission and approval, and every protected cloud transaction rechecks lifecycle, Membership, role, and current policy.

The desktop derives Organization ID and role from the trusted product-space coordinator. Renderer calls never provide scope, owner, Organization, role, actor, cloud origin, Profile path, or private Hermes content.

Read-only Knowledge, Skill, and SOP projection reuses the verified path outside `HERMES_HOME`. Manual version selection affects new conversations only, and local Memory, USER, sessions, learned Skills, Curator, credentials, and private learning remain unchanged and unsynchronized.

The approved written specification is `docs/superpowers/specs/2026-07-21-agentera-organization-agent-v1-design.md`; no Organization Agent implementation exists at this checkpoint.

## Official Managed Agent V1

The approved direction extends immutable Agent assets to `owner_scope=PLATFORM` while every desktop Installation, physical Hermes Profile, policy overlay, RuntimeBinding, and adaptive state remains USER-owned.

Platform employees use the separate Aera Admin application: Developer authors and submits, a different Super Admin approves immutable publication, Operator manages deterministic rollout and requests rollback, and Auditor remains read-only. Internal operations cross the fail-closed mTLS plus service-JWT Cloud listener; ordinary desktop users only browse and install eligible official Agents.

Official releases use append-only revisions for activation, percentage and allowlist changes, minimum desktop versions, pause, resume, and rollback. Pause stops new discovery and installation but does not remotely disable an installed Agent. Update and rollback replace only the verified immutable base for later conversations; active RuntimeBindings and Hermes private learning remain unchanged.

The approved follow-on work is [[agentera-post-official-delivery|the post-official delivery program]]. It adds a separate opt-in content-free quality plane, client-encrypted backup plane, and production release gates without expanding PLATFORM ownership into USER Installations, Profiles, RuntimeBindings, or adaptive state.

The user approved `docs/superpowers/specs/2026-07-22-agentera-official-managed-agent-v1-design.md` on 2026-07-22. Cloud, Admin, and Desktop now implement this slice on local feature branches; this is verified local development evidence, not a push, deployment, production release, or user rollout.

### Catalog and detail presentation

The Desktop presents official Agents as a catalog first, while keeping every install, update, Profile, and RuntimeBinding action on the existing verified control-plane path.

[[src/renderer/src/screens/Agents/OfficialAgentSection.tsx#OfficialAgentSection]] renders eligible or verified-offline official Agents as compact cards. Opening a card loads presentation-only detail through `getOfficialAgentDetail`; [[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager#getOfficialAgentDetail]] returns a sanitized capability summary, aggregate asset counts, allowed model/provider names, and an allowed-tool count. It never returns signed bundle bytes, release inputs, credentials, owner identity, Profile paths, Memory, sessions, or private learned Skills.

[[src/renderer/src/screens/Agents/AgentHubDetailDialog.tsx#AgentHubDetailDialog]] keeps one primary action visible. Uninstalled official Agents continue into the one-use install preview and confirmation flow, installed Agents with a linked local Profile enter chat through that Profile id, and managed updates still call the dedicated official-update API. An offline installation remains visible but cannot browse detail from Cloud, install, or update.

### Installation-bound version access

An authenticated device may read a PLATFORM version through the existing version endpoint only when its own USER-owned pending or active managed Installation currently selects that exact immutable version.

This rule keeps failed installation and ambiguous managed-update retries recoverable after a release head changes. A new v2 or rollback target is prepared from the current eligible official detail and must match the exact release, revision, Definition, and Version before local verification; arbitrary PLATFORM version enumeration remains unavailable.

The signed official policy binds platform, release, immutable release revision, user, device-installation identity, Agent Installation, and selected product context. Desktop verification reconstructs the same canonical policy bytes, accepts canonical UUIDv7 platform IDs, and still enforces digest, signature, issuer, Runtime compatibility, and exact-field checks.

### Executable lifecycle gate

The executable gate proves employee governance, user eligibility, local installation, immutable update and rollback, pause behavior, offline continuation, and private Hermes-state isolation across real local Admin, Cloud, and Electron processes.

[[tests/e2e/agentera-official-managed-agent.e2e.ts]] runs distinct Developer, Super Admin, and Operator actions; two product accounts; one fresh physical Hermes Profile; v1 and v2 RuntimeBindings; dual-control rollback; pause; offline restart; and reconnect. It distinguishes the physical Hermes Profile ID from the opaque Runtime Profile binding ID and hashes private Memory, Skill, and session fixtures throughout.

Run `AERA_OFFICIAL_AGENT_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud AERA_OFFICIAL_AGENT_E2E_ADMIN_REPO=/Users/zizimutou/Desktop/aera/aera-admin npm run test:e2e:official-managed-agent`. The harness requires explicit clean sibling repositories, creates isolated temporary databases and process roots, and never authorizes a push, merge, deploy, or release.

### Local verification evidence (2026-07-23)

The locally verified executable tips were Cloud `16ee99a`, Admin `b184e25`, and Desktop `ed6685a`; each preserves the documented PLATFORM control-plane and USER-owned runtime boundary.

The Desktop evidence commit follows the implementation commits that add [[src/main/agentera-agent-control/official-agent-service.ts]], [[src/main/agentera-agent-control/installation-manager.ts]], [[src/main/agentera-agent-control/trust.ts]], the bounded preload/IPC surface, and the official catalog and confirmation UI.

Cloud passed `go test ./... -count=1`, `go vet ./...`, and `AERA_INTEGRATION_TESTS=1 go test -p 1 ./... -count=1` against an isolated disposable PostgreSQL and Redis stack. Admin passed `make verify`, including Go unit/integration/race checks, 21 Web test files with 71 tests, typecheck, production build, and OpenAPI validation. Its real-Cloud `make e2e` passed 15 of 15 browser and service acceptance cases, including the official immutable-publication, bounded-rollout, dual-control, and fail-closed case.

Desktop passed typecheck, lint with zero errors, all 275 Vitest files with 2,620 passed and 3 conditionally skipped tests, and the pinned Cloud contract hash `c7546fee82b3cc7b2872580bc45367cc4f47d6d1e06d3ed5c035224677609b37`. The final cross-repository gate passed both the failure-injection matrix and the real Admin, Cloud, and two-Electron-desktop lifecycle scenario.

`aera-runtime` remained clean at `c0439e1e3e`, equal to its `origin/main`. The privacy scan found secret and `HERMES_HOME` markers only in Cloud rejection-test fixtures and no Admin official-agent match. `npm exec --yes --package=lat.md@0.12.1 -- lat check` passed on 2026-07-23. Cloud `16ee99a`, Admin `b184e25`, and Desktop `f5cd58c` were then fast-forwarded into their respective local `main` branches and the merged core suites were reverified; they have not been pushed, deployed, or released.

## Trusted Workspace Agent context

The main process derives one exact USER or WORKSPACE asset context from product navigation and never accepts ownership fields through Agent IPC.

### Nested Workspace routes

Workspace discovery and immutable publication use the exact nested Workspace API paths while USER requests retain their existing routes.

[[src/main/agentera-agent-control/client.ts#AgenteraAgentControlClient#listWorkspaceDefinitions]] validates Workspace identifiers, strict response DTOs, bearer authentication, and stable authorization errors without exposing response bodies.

### Role-gated publication

Owner and Admin can prepare and confirm Workspace publication, while Member is rejected locally before signing-key refresh or upload.

[[src/main/agentera-agent-control/publisher.ts#AgentPublisher]] binds each one-use preview to its target scope and dispatches initial and next immutable versions through the corresponding USER or Workspace client method.

Publication failures retain their exact bounded cause instead of presenting every post-upload failure as a signature error. A signature that remains invalid after one trust-key refresh, Cloud content or digest that differs from the prepared draft, and a verified version that cannot be cached are separate renderer-safe outcomes. The draft stores the narrower internal code for diagnosis, while no failed path marks the draft published or creates a usable local cache record.

### Local context partitions

Draft and Installation presentation is filtered by the exact selected context while the underlying Installation owner and device tuple remain USER-owned.

[[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager]] supplies the trusted context to draft, discovery, publication, and install-source operations. Version cache, Profile binding, Hermes adapter, and RuntimeBinding components remain keyed only by USER, device, and Runtime version.

### Product-facing Agent projection

The product UI presents drafts, published definitions, installations, and device-local runtime projections through one user concept: the Agent.

[[src/renderer/src/screens/Agents/AgentControlPanel.tsx#AgentControlPanel]] joins those internal records into one card and detail action. It never renders a second Runtime Profile, Installation, or RuntimeBinding management surface. An existing Hermes Profile appears as a ready Agent; choosing a published or pending Agent internally installs, retries, selects the immutable version, prepares an isolated local runtime, activates it, and opens chat.

While the shell remains in an Organization, “我的智能体” explicitly sends USER-scoped Agent operations instead of switching the global product space to PERSONAL. The draft editor, publish callback, Installation lookup, and return navigation therefore keep the Organization shell selected while operating only on the signed-in user's private Agent records.

[[src/renderer/src/screens/Agents/Agents.tsx#Agents]] resolves the resulting Installation back to its local Profile after materialization. This is an internal bridge only: the user selects “使用智能体” and does not name, claim, bind, or synchronize runtime records manually.

[[src/renderer/src/screens/Layout/ProfileSwitcher.tsx#ProfileSwitcher]] presents the same internal records only as Agents. Users may switch Agents, open the Agent screen, or open product-level Agent settings; provider routing, gateway state, internal Profile IDs, Installations, and RuntimeBindings remain hidden.

[[src/renderer/src/screens/Agents/AgentDraftEditor.tsx#AgentDraftEditor]] imports identity and capability Markdown and derives safe asset paths without requiring a Runtime model. New drafts default to a signed user-select model policy; allowlist and fixed-model policies are explicit advanced authoring choices.

Publishing an Agent and choosing a local model are separate actions. Publish-and-use may continue as one explicit product action, but it first publishes the immutable version and then resolves a current-owner Profile model during installation; publishing alone never requires a configured Runtime model.

Agent model pickers query credential-backed routes across the current owner's non-Agent Profiles, preferring the active Profile but not requiring one model to be the Profile default. Provider, credential, and model-library change events refresh the choices. They never merge a draft's historical model with unrelated global model history, and every visible option carries a consistent provider label.

### Guided product Agent creation

Natural-language creation in the default chat produces a real product draft rather than an unlisted Hermes-only Profile.

[[src/renderer/src/screens/Chat/agentCreationIntent.ts#parseAgentCreationIntent]] recognizes only explicit creation commands and leaves questions, status reports, and messages with attachments on the normal Hermes path. [[src/renderer/src/screens/Chat/hooks/useAgentCreationGuide.ts#useAgentCreationGuide]] captures the trusted Agent context, asks for missing name and responsibilities, revalidates that context immediately before mutation, and calls the existing `createDraft` preload method. [[src/renderer/src/screens/Chat/AgentCreationGuideCard.tsx#AgentCreationGuideCard]] links a successful draft to “我的智能体”; it never creates an unregistered runtime Profile as a substitute.

### Context-only refresh

Changing the selected product space invalidates publication handles and refreshes Agent control state without selecting, reading, creating, or mutating a Profile or RuntimeBinding.

The startup composition subscribes the Agent manager only to [[src/main/agentera-workspace/manager.ts#AgenteraWorkspaceManager#subscribeSelectedAgentContext]] and calls its context refresh hook. Runtime lifecycle remains outside that bridge.

A same-context state notification refreshes lists without closing the draft editor or interrupting its save-and-publish workflow. A real scope, owner, or role change still closes context-bound editors and one-use dialogs before later mutation.

### Role-aware presentation

The main process returns the trusted USER or WORKSPACE context with Agent control state. The Agent screen follows that state instead of reading Workspace authorization independently or accepting scope fields in mutation calls.

Personal behavior remains unchanged. Workspace Owner and Admin can view and author their account-local Workspace drafts while online; Member receives an install-only view and the renderer does not enumerate drafts. Offline Workspace drafts remain visible to their Owner or Admin but every field and author action is read-only.

[[src/renderer/src/screens/Agents/AgentControlPanel.tsx#AgentControlPanel]] closes context-bound dialogs when the selected scope, Workspace, or role changes and pauses Workspace discovery, installation, publication, and updates offline. Same-context draft refreshes do not unmount the active editor. [[src/renderer/src/screens/Agents/AgentDraftEditor.tsx#AgentDraftEditor]] renders the publication target from the one-use preview returned by main and never submits a Workspace ID, owner scope, or role.

Lifecycle denials preserve the stable `workspace_forbidden`, `workspace_archived`, and `workspace_owner_unavailable` codes while discarding raw cloud bodies and private error details.

### ExperienceCandidate authorization surface

The Workspace promotion surface keeps local preparation available with authenticated or valid offline access while requiring online access for every cloud submission, review-queue read, detail read, and terminal review.

Active Workspace Members may list eligible Skills, prepare one detached snapshot, submit it explicitly, and read their own candidate status. Owner and Admin additionally receive the review queue and may approve or reject once; Member review calls fail locally before cloud access.

The Agent-control preload exposes only candidate and Installation identifiers, the selected Skill name, the exact submit confirmation, and bounded review fields. Trusted Workspace context, account/device ownership, role, Profile resolution, candidate source path, mutation intent, and cloud credentials remain main-process state.

Account, device, or selected-space changes discard the cached candidate service before later reads. The local store and cloud requests remain partitioned by the newly derived owner/context, preventing a long-lived desktop manager from carrying candidate handles across sessions.

### Approved candidate draft import

Owner and Admin can turn one terminally approved candidate into a new local Workspace Agent draft without granting the renderer ownership or filesystem control.

The renderer first requests a preview by candidate ID, then confirms only a one-use import handle with the exact `apply-approved-skill-to-latest` phrase. Workspace ID, role, account/device identity, cloud origin, Profile paths, source paths, version bytes, and draft contents remain derived in the main process.

Import always starts from the currently published, signature- and digest-verified Workspace version. If the definition advances between preview and confirmation, `candidate_base_advanced` is returned before SQLite mutation so the UI can request a fresh diff.

The local draft and import receipt commit together. Approval itself remains cloud state, import remains device-local and idempotent per account/device, and publication remains the existing separate explicit action.

### Role-aware experience presentation

The renderer keeps promotion, review, draft import, and publication as separate visible actions without accepting ownership or Profile data.

[[src/renderer/src/screens/Agents/ExperiencePromotionDialog.tsx#ExperiencePromotionDialog]] exposes preparation and upload as separate user actions. It renders eligible names and safe preview metadata but never receives a Profile path, source path, Workspace ID, owner tuple, bundle bytes, DLP override, or cloud origin. Offline preparation remains available; upload failure remains an explicit manual retry with no background timer.

Its renderer test drains Radix FocusScope's deferred unmount event before Vitest replaces the jsdom realm, preventing a cross-realm `CustomEvent` failure without changing the dialog's product behavior.

[[src/renderer/src/screens/Agents/ExperienceCandidatePanel.tsx#ExperienceCandidatePanel]] calls the own-status list for every Workspace role and does not call review-list or review-detail methods for Member. [[src/renderer/src/screens/Agents/ExperienceReviewDialog.tsx#ExperienceReviewDialog]] commits a bounded terminal decision before requesting an approved import preview, confirms same-name replacement, refreshes a stale base without a draft mutation, and passes only the returned draft to the existing editor.

Same-context Agent-control invalidation closes transient experience, official-install, and archive dialogs and refreshes the candidate panel, but it does not unmount an active draft save or publication sequence. A selected scope, owner, or role change closes the editor as well. This renderer rule complements the main process clearing one-use handles on account, device, and selected-context changes.

## Owner identity

The USER owner tuple is derived from the authenticated product session and cannot be selected by request payloads.

`tenant_id` is the account's `personal_space_id`, `owner_scope` is `USER`, and `owner_id` is the AgentEra `user_id`. The existing device-installation identity remains separate from a new per-Agent Installation ID and opaque Runtime Profile ID.

## Local drafts

Personal Agent drafts stay in an AgentEra-owned application database under Electron userData and do not synchronize to the cloud.

Draft editing does not mutate a running Profile. Importing selected Persona or Skill content is explicit and never scans or uploads Memory, USER, sessions, credentials, files, or the complete Profile.

## Local account isolation

One Electron userData root may outlive several product logins, so every local Agent record is scoped again inside the main process.

[[src/main/agentera-agent-control/db.ts#AGENTERA_CONTROL_PLANE_SCHEMA_VERSION]] schema v3 adds account ownership plus exact draft target and installation source variants. Verified versions use account-partitioned rows and paths, while migrated v2 USER rows retain their legacy cache paths.

The filesystem-backed legacy migration proof keeps the default five-second budget on POSIX and uses the established bounded 30-second Windows budget for slower hosted runners; the suite-wide timeout remains unchanged.

[[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager]] resolves the current owner for each local operation and rebuilds Runtime components after an owner change. [[tests/agentera-agent-owner-isolation.test.ts]] proves that one long-lived manager cannot list, count, or open the previous account's draft; store-level tests cover versions, installations, bindings, and pending delivery.

## Agent Manifest V3 capability contract

Manifest V3 keeps the V2 model policy and adds only portable logical MCP requirements so an Agent can declare capabilities without publishing a local connection.

Each requirement contains a logical name, selected tool names, required or optional behavior, and a bounded permission reason. URL, command, arguments, environment, headers, token, auth, credential references, Profile paths, and local paths are rejected; V1 and V2 remain compatible. [[src/main/agentera-agent-control/manifest.ts#canonicalizeEditableAgent]] creates stable canonical bytes, [[src/shared/agentera-agent-control.ts#runtimeModelPolicyForEditableManifest]] preserves V2 model behavior, and [[src/main/agentera-agent-control/trust.ts#canonicalizeAgentVersionContent]] independently reconstructs trusted V3 content.

New drafts use V3 with an empty requirement list through [[src/renderer/src/screens/Agents/agentDraftDefaults.ts#createDefaultAgentManifest]]. An approved experience import retains requirements from its verified base through [[src/main/agentera-agent-control/experience-candidate-importer.ts#editableManifest]], while later capability changes remain ordinary draft revisions and next immutable Versions.

## Installed capability authoring boundary

Installed capability selection is a main-process preparation flow that exposes safe metadata and one-use handles without exposing a Profile path or MCP connection configuration.

[[src/main/agentera-agent-control/capability-authoring-service.ts#CapabilityAuthoringService#listAuthoringCapabilities]] returns only an opaque Profile handle, display names, Skill metadata, logical MCP names, enabled state, and discovered tool metadata. URL, command, arguments, environment, auth, token, headers, local paths, and secret-like descriptions stay out of renderer DTOs.

[[src/main/agentera-agent-control/capability-authoring-service.ts#CapabilityAuthoringService#prepareInstalledSkillSnapshot]] rejects links, path escape, hidden/cache entries, invalid UTF-8, duplicate targets, oversize content, and local DLP findings before retaining an immutable in-memory snapshot. Confirmation consumes its owner- and Profile-bound handle once, while MCP confirmation returns only a validated [[src/shared/agentera-agent-control.ts#AgentMcpRequirementV3]].

### Guided capability picker

The draft editor makes installed Skill and MCP selection the primary capability action while retaining advanced manual Skill, SOP, and Knowledge uploads.

[[src/renderer/src/screens/Agents/AgentCapabilityPicker.tsx#AgentCapabilityPicker]] accepts only safe Profile handles and display names. It previews and explicitly replaces a selected Skill snapshot, blocks duplicate logical MCP requirements, and captures selected tool names, required or optional behavior, and a bounded permission reason without rendering connection data.

[[src/main/agentera-agent-control/ipc-contract.ts#parsePrepareInstalledSkillSnapshotInput]] and [[src/main/agentera-agent-control/ipc-contract.ts#parsePrepareMcpRequirementInput]] enforce exact renderer fields before the main-process manager uses one-use preparation handles. [[src/renderer/src/screens/Agents/AgentDraftEditor.tsx#AgentDraftEditor]] stores confirmed Skill files in the ordinary immutable draft asset list and confirmed MCP metadata in Manifest V3; later saves create a new draft revision rather than changing an approved Version.

[[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager]] owns service construction and invalidates preparation state when access or selected product context changes. [[src/main/mcp-servers.ts#normalizeMcpDiscoveredTools]] normalizes tool discovery before the service applies its display-metadata privacy filter.

## Immutable publication

An explicit publish action turns one local draft revision into an immutable cloud AgentVersion under a stable AgentDefinition.

Publication uses an allowlisted canonical manifest, content digest, platform Ed25519 attestation, policy checks, idempotency, ownership authorization, and audit. A failure leaves the local draft and Hermes Profile unchanged; published versions never use last-writer-wins reconciliation.

`AgentDefinition.display_name` is mutable display metadata, not immutable Runtime content. A USER or WORKSPACE next-version publication carries the current draft name and atomically updates that stable definition alongside `latest_version_id`; the new AgentVersion is still immutable, and every existing RuntimeBinding remains pinned to its original version.

The current Desktop contract requires `display_name` and rejects a publication response that returns a stale name. During a Cloud-first rolling upgrade, an older Desktop that omits the field keeps the existing definition name. Organization next-version submissions retain their separate reviewed governance contract and do not gain an implicit rename path.

### Durable local version cache

The account-scoped local cache treats its signed SQLite row and read-only version directory as two re-verifiable representations so interrupted writes converge without clearing user state.

[[src/main/agentera-agent-control/version-cache.ts#AgentVersionCache#getVerifiedVersion]] revalidates stored JSON, signature, canonical digest, owner tuple, cache-relative path, and immutable bytes on every read. A valid row can rebuild a missing directory; one valid current-account digest directory can recreate a missing row after cold restart. Legacy paths remain readable only when an existing owner-scoped row names them.

[[src/main/agentera-agent-control/version-cache.ts#AgentVersionCache#cacheVerifiedVersion]] retains a fully verified destination when the later SQLite commit fails. A retry adopts those bytes and finishes only the local row. Recognized staging trees are removable cache artifacts, while rename losers verify the winning destination and converge through an idempotent `BEGIN IMMEDIATE` row transaction.

Multiple digest directories, row and directory disagreement, mutable or corrupt stored bytes, invalid signatures, path escape, and cross-account lookup remain fail-closed. A freshly verified Cloud candidate may replace only its exact cache-owned incomplete destination; recovery never deletes arbitrary siblings or asks the user to clear a cache.

Publisher and IPC boundaries expose distinct bounded conflict, corruption, permission, filesystem, database, and recovery codes. Draft failure summaries and renderer guidance never include filesystem paths, SQLite messages, signed payloads, credentials, or owner identifiers.

## Installation and binding

An Agent Installation selects one immutable version for one device/Profile pair and maps to one physically isolated writable `HERMES_HOME` through the existing encrypted Profile binding store.

The authentication installation ID is not reused as the Agent Installation ID. New Agent installations create a fresh Profile with `cloneFrom=null`; existing learned Profiles require explicit same-owner claim. A RuntimeBinding freezes version, Profile, Runtime, policy, and tools for one conversation.

### Local MCP requirement binding

Manifest V3 MCP requirements are satisfied only by a local, owner/device/Installation-scoped mapping in the employee's selected Profile; shared manifests and Cloud records never receive connection configuration.

Schema v11 adds `agent_mcp_requirement_bindings` through [[src/main/agentera-agent-control/db.ts#AGENTERA_CONTROL_PLANE_SCHEMA_VERSION]]. [[src/main/agentera-agent-control/capability-binding-store.ts#CapabilityBindingStore]] stores only the logical requirement, local MCP name, verified tools, revision, and timestamps, then requires the live server to remain enabled and expose every requested tool.

A required missing, disabled, or drifted mapping leaves installation pending with `profile_capability_configuration_required`; an optional failure becomes a bounded degraded list. [[src/main/agentera-agent-control/hermes-adapter.ts#AgenteraHermesAdapter#prepareInstalledTurnPlan]] freezes the resolved names, tools, and revisions into the local RuntimeBinding and its tool digest for a new conversation. A later remap affects only a new ConversationBoundary, while the sanitized Cloud outbox excludes all local mapping bytes.

### Model policy and runtime selection

An immutable AgentVersion signs a model policy, while the user's Installation selects the concrete local route that satisfies it.

Manifest V1 remains byte-for-byte compatible and keeps its required provider/model constraints. Manifest V2 uses one of three modes: `user_select` permits any current-owner configured route, `allowlist` permits only listed providers and models, and `fixed` requires exactly one provider and model. Provider endpoints, display names, credentials, Profile paths, and secret fingerprints never enter the shared AgentVersion.

The concrete route is resolved only when the user starts using or repairs an Agent. The main process validates the selected route against the signed model policy and effective tenant policy, copies only that route and its same-owner credential into the isolated target Profile, and freezes the resolved route in each new RuntimeBinding. Changing the user's selected model affects only later conversations.

An installed or shared Agent never treats an empty successful transport as a usable response. If the Runs API reports completion without text, reasoning, or tool activity, the main process performs the bounded Chat Completions compatibility fallback; any observed tool activity suppresses replay so side effects cannot run twice. If the compatibility path also returns no content, the turn fails instead of rendering a false success.

Creating a Hermes Runtime Profile directly is not equivalent to creating a product Agent. A usable Agent additionally requires a verified immutable AgentVersion, USER-owned Installation, Profile binding, and RuntimeBinding. [[src/main/agentera-agent-control/model-profile-seed.ts#seedAgentModelProfile]] copies only the selected provider route and same-owner credential into the isolated target Profile after validating the signed model policy.

When the active installed Agent Profile is also the selected model source, repair verifies the same-owner binding, credential availability, and signed model constraints in place. An already compatible route is not copied onto itself; a different allowed signed model is reconfigured on that Profile, while an unavailable credential or incompatible route still fails closed. After a version change, [[src/renderer/src/screens/Layout/chatRuns.ts#openProfileRunTransition]] forces a new run even for a same-Profile blank tab, so the previous conversation keeps its original RuntimeBinding and only the new run can freeze the selected version.

[[src/main/agentera-agent-control/installation-manager.ts#AgentInstallationManager#install]] and [[src/main/agentera-agent-control/installation-manager.ts#AgentInstallationManager#repairInstallationModel]] preserve `profile_model_configuration_failed` when the signed provider/model constraints cannot be projected. [[src/main/agentera-agent-control/ipc-contract.ts#mappedCode]] exposes only that allowlisted reason, and [[src/renderer/src/screens/Agents/AgentControlPanel.tsx#AgentControlPanel]] keeps the pending Agent non-runnable while showing model-compatibility guidance instead of a generic safety error or “published and usable” claim.

Installation activation is fail-closed until model projection succeeds. A pending Installation that already owns a prepared Profile is retried by explicitly claiming that Profile, not by opening chat or creating a second Profile. A profile-less pending Installation for an older version is archived before installing the newly published version. An active Profile whose selected version differs from the requested version must select the new immutable version and re-seed its signed model route before chat.

Fresh Installation materialization reserves the exact local Profile ID and opaque Runtime Profile ID under the stable Agent Installation ID before Hermes creates any Profile bytes. If creation is interrupted, the next attempt reads that encrypted reservation and adopts only the same Owner's safe scaffold; it never chooses a suffixed replacement or claims private or foreign data.

### Atomic fresh Profile allocation

Creation-intent persistence uses one immediate SQLite transaction and excludes fresh Profile IDs held by pending intents or Installation journals, so concurrent same-name installs persist distinct IDs before Cloud work begins.

#### Pending intent exclusion

Two same-name creation intents that overlap before either Cloud response persist different Profile IDs while keeping each original idempotency key stable.

#### Operation handoff exclusion

After an intent becomes a prepared Installation journal but before Profile bytes exist, its reserved Profile ID remains unavailable to later same-name creation intents.

Desktop schema v9 adds the narrow `installation_operations` journal. It stores only the exact Owner/device/Installation and bounded target/model identifiers, opaque Runtime Profile ID, phase, retry code, CAS revision, and timestamps; it contains no physical path, credential, token, Profile bytes, or Cloud body. Phases advance in order from `prepared` through `committed`, while ambiguous ownership can become terminal `repair_required`; stale revisions and cross-Owner reads fail closed.

Before the Cloud create request, `pending_sanitized_records` durably stores the stable idempotency key and a bounded Profile target with no physical path or credential. A cold restart replays that exact create key, verifies the returned pending Installation and policy, persists the local row and journal before deleting the intent, then resumes materialization.

Materialization rechecks each durable postcondition and serializes concurrent work by Agent Installation. The local Runtime Profile ID and `profile_bound` phase share one SQLite transaction; Cloud activation uses one stable key; the local active row and `committed` phase share another transaction. Fresh reservation completion and Profile activation must succeed before that final transaction, so either failure remains recoverable at `cloud_activated`. Profile attachment and projection are idempotently verified between those edges.

Foreign ownership, immutable reservation drift, Runtime Profile ID collision, and unexpected private fresh-Profile markers become `repair_required` with bounded stable codes. Recovery never deletes, reassigns, or retries those Profiles. [[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager#notifyAccessStateChanged]] schedules one reconciliation flight per Owner/Runtime only for authenticated online local access; offline, signed-out, Remote, and SSH states do not start Cloud recovery.

### Installation reconciliation isolation

A structurally orphaned journal operation whose Installation is missing becomes terminal `repair_required`; it cannot block later healthy operations from recovering during the same reconciliation flight.

#### Legacy creation intent migration

A Beta.21 creation intent without `profile_target` is replayed with its original idempotency key into a profile-less pending Installation, then awaits explicit same-owner Profile selection instead of guessing or being skipped.

#### Fresh reservation finalization recovery

If fresh Profile reservation completion fails after Cloud activation, the local Installation remains pending at `cloud_activated`; cold restart retries finalization without repeating Cloud activation.

#### Fresh Profile activation recovery

If local Profile activation fails after its reservation is completed, the same `cloud_activated` journal resumes activation on cold restart before committing the local Installation.

Manual selection downloads and verifies the immutable version, calls the cloud selection transaction, retrieves the newly signed policy through `GET /api/v1/policy-snapshots/{policy_snapshot_id}`, and only then atomically activates the read-only projection for later conversations. A missing or invalid policy leaves the last local version selected.

[[src/main/agentera-agent-control/runtime-binding-store.ts#RuntimeBindingStore]] persists a complete local binding and its sanitized cloud outbox record in one transaction. [[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager]] retries that outbox after installed turns, session attachment, and authentication changes, but delivery failure cannot delay or roll back Hermes.

### Conversation boundary

Every authenticated conversation freezes data ownership, visibility, and the complete RuntimeBinding snapshot before its first message.

[[src/main/agentera-agent-control/conversation-boundary-store.ts#ConversationBoundaryStore]] persists an actor-partitioned immutable boundary containing scope, scope id, private-by-default visibility, Installation, Definition, Version, Runtime, policy, Memory/files/Artifact ownership, and tool-permission snapshot. A resumed unbound legacy session defaults to USER and PRIVATE; selecting another work context cannot mutate an existing boundary or silently migrate history.

[[src/main/agentera-agent-control/hermes-adapter.ts#AgenteraHermesAdapter#prepareInstalledTurnPlan]] completes entitlement, ownership, immutable version/policy, Runtime, tool, model-route, revocation, and projection validation without writing a RuntimeBinding. [[src/main/agentera-agent-control/conversation-runtime-coordinator.ts#ConversationRuntimeCoordinator]] then creates or adopts the binding, its sanitized outbox row, and the matching ConversationBoundary under one `BEGIN IMMEDIATE` transaction. A binding-only interrupted state is completed on retry or cold restart, while a boundary conflict rolls back every new binding byte and outbox row.

Hermes session attachment also runs through the coordinator and updates RuntimeBinding plus ConversationBoundary in one transaction. A failed second update rolls back the first, and all reads and writes remain partitioned by the exact tenant, actor, and device owner tuple. A non-installed Profile creates only a `PROFILE_DEFAULT` boundary and never a synthetic RuntimeBinding.

The conversation-context and send-message IPC paths first refresh trusted product context, then call the same durable manager operation. The send path fails closed if that coordinator is unavailable and attaches the returned Hermes session through one atomic manager call. [[src/renderer/src/screens/Chat/ConversationBoundaryIndicator.tsx#ConversationBoundaryIndicator]] displays “运行于” independently from “可见性”, so an Organization or team/project run remains “仅自己” until a future explicit share action changes visibility.

## Hermes integration

Hermes remains the sole execution and self-learning engine while AgentEra supplies read-only version assets and policy at conversation start.

Published assets never overwrite private Profile paths. Native Memory, USER, background review, agent-created Skill learning, Curator, sessions, files, and credentials continue under [[agentera-self-evolution|the Hermes compatibility contract]].

Local Gateway lifecycle is coordinated outside Hermes private state. [[src/main/hermes.ts#startGatewayDetailed]] durably records an Aera launch before spawn and records the spawned PID before exposing it as started. The ledger commits fsynced pending bytes before platform-specific canonical replacement, recovers an interrupted replacement without deleting the last valid state, and advances memory only after the durable commit.

[[src/main/hermes.ts#recoverAeraOwnedGatewaysFromPreviousRun]] and [[src/main/hermes.ts#stopAeraOwnedGateways]] act only on exact recorded Profile/PID evidence. SIGTERM retains ownership until exit is confirmed; bounded escalation rechecks the Profile PID immediately before signalling, while a missing, unchanged, replaced, corrupt, or otherwise ambiguous identity is never claimed or killed. Stable recovery error codes are logged without paths or private data.

Cross-platform regression tests inject a non-terminating SIGTERM and deterministic rename failures instead of relying on platform signal or directory-replacement semantics. They cover the Windows `EACCES`, `EBUSY`, `EEXIST`, and `EPERM` canonical-replacement fallback while preserving the fsynced pending commit point. A queued restart for another Profile uses the same bounded platform-aware health budget after an earlier setup failure, so Windows scheduling cannot hide that the queued command ran. PID-file lifecycle assertions wait for a valid positive PID rather than file existence alone because Hermes may create or truncate `gateway.pid` before its contents are readable.

## Cloud boundary

Cloud data is limited to Agent definitions, immutable versions, installations, policy snapshots, sanitized binding metadata, and audit evidence.

API keys, tokens, Base URLs, Profile paths, Memory, USER, conversations, files, credentials, unpromoted Skills, and Curator state remain local and are rejected by control-plane endpoints.

## Legacy sync separation

The imported Hermes One `/api/agents` reconciler remains a transitional compatibility feature and is not extended into the AgentEra control plane.

AgentEra uses a separate product account, cloud API, main-process module, local store, IPC namespace, and renderer state. Existing Memory exclusion remains intact, and legacy IDs are not migrated automatically.

## Offline and failure behavior

A valid offline entitlement allows cached installed versions, local RuntimeBindings, personal drafts, read-only Workspace drafts, and native Hermes learning whenever the configured model endpoint remains reachable.

Publication and discovery pause offline. Cloud, publication, installation, and audit failures never delete or roll back a draft, installed version, completed turn, Profile binding, or private adaptive state.

## Release gate

The feature cannot begin from or ship with a falsely green authentication or compatibility baseline.

Cloud tests run without cache, version immutability and owner isolation are proven, private Profile fixtures remain byte-identical through install/update failures, and active conversations keep a stable binding. Desktop regression tests also cover same-Profile model validation, v1-to-v2 selection without self-repair conflict, forced creation of the new run, and preservation of the old run. The detailed approved design is `docs/superpowers/specs/2026-07-19-agentera-user-agent-control-plane-v1-design.md`.

### Personal publish and use

The personal Agent gate exercises the complete USER-scoped path while the visible product shell remains in an Organization.

[[tests/e2e/agentera-personal-agent-live.e2e.ts]] configures one saved provider route on the account Profile, publishes and installs a personal Agent into a distinct non-default Profile, verifies the selected model projection and active USER-owned Installation, finds the Agent through the Ready catalog filter, starts it again, and receives the fixed acceptance marker through the live model endpoint. The Organization selection must remain unchanged throughout both publish-and-use and later start-use actions.

Run the executable proof with `AGENTERA_PERSONAL_AGENT_LIVE_API_KEY`, and optionally `AGENTERA_PERSONAL_AGENT_LIVE_BASE_URL` and `AGENTERA_PERSONAL_AGENT_LIVE_MODEL`, supplied only through the local process environment: `npm run test:e2e:personal-agent-live`. The test skips without an explicit API key and never records the credential in the repository or its LAT contract.

### ExperienceCandidate boundary

The candidate gate exercises the complete selected-Skill promotion path while keeping every Installation, physical Profile, and RuntimeBinding USER-owned.

[[src/main/agentera-profile-binding.ts#AgenteraProfileBindingStore#resolveAttachedProfilePath]] resolves the candidate source only from the trusted runtime Profile ID, Agent Installation ID, and current owner. A renderer-provided Profile name or path cannot select the source.

[[tests/agentera-experience-candidate-boundary.test.ts]] locks exact renderer mutation fields and forbids candidate coupling to Hermes private-state mutation, Runtime distribution, legacy sync, or Workspace-owned runtime state.

[[tests/e2e/agentera-experience-candidate.e2e.ts]] proves Owner v1 publication, distinct Member installation, selected and unselected private learning, local secret blocking with no POST, manual retry, own-status isolation, Admin terminal review, atomic draft import, explicit v2 publication, and old/new conversation version pinning.

The harness also injects upload, review, and SQLite import failures and verifies every private fixture hash afterward. Run the executable proof with `npm run test:e2e:experience-candidate`.

### Organization Agent isolation

Organization definitions and versions are shared control-plane assets, but every installed runtime remains bound to the employee's USER owner tuple and one physical Profile.

[[src/main/agentera-agent-control/organization-publication-service.ts#OrganizationPublicationService]] keeps editable drafts local and uses one-use handles for immutable submission, review, and withdrawal. Renderer calls never supply Organization role, account authority, Profile paths, or cloud credentials.

An approved submission carries its exact immutable Version ID. The service joins it only to the trusted local submission reference, while [[src/main/agentera-agent-control/draft-store.ts#AgentDraftStore#recordPublishedRevision]] records the submitted revision without overwriting newer draft content; digest, Definition, Version, or owner conflicts fail closed.

[[src/renderer/src/screens/Agents/agentLifecycle.ts#deriveAgentLifecycle]] merges the Definition, trusted local draft, linked submission, and Installation into one lifecycle card. Pending work can only be edited or withdrawn; deleting a local draft, discarding unpublished edits, withdrawing a Cloud submission, and archiving a USER-owned Installation remain four distinct confirmations and main-process operations.

[[src/main/agentera-agent-control/installation-manager.ts#AgentInstallationManager]] records `sourceScope=ORGANIZATION` only as catalog provenance while retaining USER tenant, owner, device, policy overlay, and Runtime Profile ownership. [[src/main/agentera-agent-control/hermes-projection.ts#HermesProjectionManager]] materializes signed Knowledge, Skill, and SOP bytes read-only outside `HERMES_HOME`.

[[src/main/agentera-agent-control/hermes-adapter.ts#AgenteraHermesAdapter#prepareInstalledTurnPlan]] freezes the planned Version, policy, Runtime, Profile, model route, and tool digest per conversation before the atomic local snapshot commit. [[src/main/agentera-agent-control/hermes-adapter.ts#assertNewConversationContext]] rejects only a new Organization conversation after trusted context removal; an existing RuntimeBinding remains stable.

[[tests/e2e/agentera-organization-agent.e2e.ts]] proves the four-role approval and installation flow, restart-safe dirty-draft reconciliation and one-card presentation, withdrawal, local draft deletion, Installation archive, v1/v2 binding stability, offline verified use, reconnect removal gate, read-only projection, and byte-identical employee-private Memory and Skills. Run it with `npm run test:e2e:organization-agent`.

### Workspace Agent isolation

The Workspace Agent gate extends the release proof from USER assets to WORKSPACE-owned definitions and versions without changing USER ownership of installations, Profiles, RuntimeBindings, or adaptive data.

[[tests/agentera-workspace-agent-boundary.test.ts]] allowlists Workspace ownership vocabulary only in Agent asset/context modules and rejects it from Hermes, RuntimeBinding, Profile binding, sessions, Skills, Curator, Runtime distribution, and legacy sync. It also locks the exact renderer mutation boundary and read-only projection path.

[[tests/e2e/agentera-workspace-agent.e2e.ts]] runs two real product accounts against the local cloud and desktop: Owner publishes v1, Member installs into a separate Profile and learns privately, Owner publishes v2, and Member selects it manually. The v1 conversation remains bound to v1, the new conversation binds v2, both bindings remain USER-owned, account caches remain distinct, published assets are read-only, and captured cloud requests contain no private learning data.

Run the executable proof with `npm run test:e2e:workspace-agent`.

### Two-device boundary

The end-to-end gate exercises one USER account through two physically isolated local device contexts.

[[tests/e2e/agentera-agent-control.e2e.ts]] launches two isolated Electron devices against a real local PostgreSQL/Redis-backed cloud. It proves draft-zero-cloud behavior, v1 publish and distinct installation, A-only Memory/Skill learning, v2 manual selection, old-conversation v1 stability, new-conversation v2 binding, sanitized requests, failure non-destruction, and absence of `/api/agents` calls.

The executable gate is `npm run test:e2e:agent-control`; contract drift is blocked by `npm run check:agentera-cloud-contract`. The test harness owns and removes only its temporary userData, `HERMES_HOME`, device keys, Runtime Seed copy, cloud process, containers, and database volume.
