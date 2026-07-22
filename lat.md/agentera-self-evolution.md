# AgentEra self-evolution compatibility

AgentEra adds ownership, versioning, policy, and publication around Hermes while preserving Hermes's local self-learning loop as a release-blocking invariant.

## Compatibility rule

AgentEra must not weaken or replace Hermes session stability, Profile isolation, Memory, background review, agent-created skills, Curator, or offline local behavior.

Any change that touches those behaviors requires explicit regression proof. Product features, branding, account behavior, or cloud tests cannot override a failed Hermes compatibility check.

## Local learning loop

Hermes owns immediate private learning inside one physically isolated Profile and does not wait for AgentEra cloud services.

A completed conversation may lead Hermes background review to update local `MEMORY.md`, `USER.md`, or agent-created skills. The active conversation remains stable, and a later conversation observes the durable learning.

## Candidate promotion loop

AgentEra owns an optional publication path that starts only after local learning has succeeded.

Selected learning becomes a minimal candidate, passes owner-scope authorization and DLP, receives destination-owner review, and may enter a new immutable Agent version. Candidate failure never rolls back local learning.

### ExperienceCandidate V1

The first promotion slice treats one explicitly selected Hermes agent-created Skill as a reviewable Workspace Agent contribution.

The desktop reads the Skill through a trusted read-only adapter, snapshots it outside `HERMES_HOME`, and requires explicit user consent before submission. The locked design is `docs/superpowers/specs/2026-07-20-agentera-experience-candidate-v1-design.md`.

### Candidate privacy gate

Local and cloud scanners enforce the same versioned canonical-package and DLP contract before candidate content becomes cloud state.

V1 rejects links, path escape, binary or oversized files, credentials, Profile paths, and Memory, USER, session, conversation, or Curator payloads. Findings expose only codes and candidate-relative locations, never matched secrets.

The desktop pins the reviewed cloud OpenAPI and shared vector file byte-for-byte. Its main-process canonicalizer applies the same NFC paths, UTF-8 byte limits, deterministic JSON/SHA-256 encoding, sorted findings, and `experience-candidate-dlp-v1` rules as the cloud before later snapshot work can proceed.

Local control-plane schema v4 stores a prepared candidate as an immutable canonical snapshot below Electron `userData/agentera-control-plane/candidates/<tenant>/<owner>/<device>/<candidate>/candidate.json`, never below `HERMES_HOME`. The metadata row is bound to the exact active USER-owned Workspace Installation, source AgentVersion, Runtime Profile, account, and device; renderer-safe rows omit every Profile and snapshot path.

The read-only Hermes source adapter accepts only a persisted `.usage.json` record marked `created_by: "agent"` or legacy `agent_created: true`. It resolves only flat `skills/<skill>` or category `skills/<category>/<skill>` layouts in the selected physical Profile, excludes archived, bundled, Hub, external-link, projected, duplicate, and missing Skills, and rejects links, path escape, special files, hidden/dependency/cache trees, binary or invalid UTF-8 data, and package limits before snapshot creation. `.usage.json`, counters, absolute paths, and unrelated Skills never enter the detached candidate bundle, and neither successful nor failed reads mutate Hermes files.

### Trusted candidate control flow

Candidate preparation and submission are separate explicit operations so local learning never depends on cloud availability.

The main process resolves the active Workspace Installation and physical Profile from trusted local state. The renderer can provide only an Installation ID plus selected Skill name for preparation, or a prepared candidate ID plus an exact confirmation for submission; it cannot provide Workspace ownership, device identity, Profile paths, source paths, snapshot bytes, or DLP overrides.

Preparation performs the local provenance, canonicalization, and DLP checks before writing an immutable snapshot outside Hermes. Submission uses a durable idempotency intent and only removes the detached local snapshot after a verified cloud acceptance. Offline use preserves `PREPARED`; ambiguous transport failures preserve the same intent and snapshot as `UPLOAD_FAILED` for manual retry, with no timer, watcher, startup upload, or automatic retry.

Candidate IPC errors are bounded codes. A DLP denial may additionally expose only validated `{code,path,line}` findings; raw server bodies, matched evidence, source content, and exception messages never cross the preload bridge.

### Candidate review and draft import

Workspace Members may submit from their own matching Installation, while Owner and Admin review terminal candidate decisions and import approved content into a local draft.

Cloud migration 11 stores an immutable candidate core plus at most one terminal review. Repository transactions recheck active Workspace membership, lifecycle, current device, and the exact active USER Installation before accepting a contribution.

Submission and review idempotency stay scoped to the authenticated USER actor. Account finalization detaches only submitter, device, and reviewer identifiers; the candidate digest, canonical bundle, destination, and terminal decision remain unchanged.

The cloud candidate API exposes separate own-status and Owner/Admin review queues. Lists omit bundle content; detail reads authorize the active submitter or Workspace reviewer, audit reviewer access, and never return the submitting device identity.

Submission accepts only the path-derived Workspace and definition plus a canonical Skill bundle, source version, and digest. The service repeats canonicalization and DLP before persistence, while rejection notes are bounded and secret-scanned and every review remains terminal.

Approval overlays only the selected Skill directory onto a new draft based on the latest immutable Workspace Agent version. It never publishes automatically or modifies an existing Hermes Profile or running RuntimeBinding.

The desktop downloads and verifies the latest immutable Workspace Agent version before showing an import diff. A one-use handle binds the approved candidate digest, account, device, Workspace, definition, and verified base version; confirmation rechecks the latest base before any local write.

Only files below the selected `skills/<skill-name>/` prefix are added, replaced, or removed. Identity, model constraints, tool policy, dependencies, Runtime compatibility, icon, display name, and every unrelated asset are carried from the verified base into a new editable local draft.

Draft rows and the device-local candidate import receipt commit in one SQLite transaction. Repeating the import on the same account/device reopens the recorded draft, while another authorized device may create its own draft. A stale base, verification failure, transaction rollback, or disk failure leaves the terminal cloud approval and Hermes source Skill unchanged and removes any partial draft materialization.

The desktop presentation keeps every transition visible and manual. An active Workspace Installation exposes one promotion dialog that lists eligible Skill names, performs the detached local preview even with valid offline access, displays only safe DLP codes and candidate-relative locations, and never starts submission on open or through a timer. Every role can see only its own returned candidate status; only Owner and Admin receive review controls.

Approval is committed before the latest-base import preview is requested. Same-name replacement paths are shown explicitly, `candidate_base_advanced` refreshes the diff before any draft write, and a successful import opens the existing local draft editor. Publication remains a later, separate action and no renderer transition writes to a Hermes Profile.

### Candidate failure isolation

Preparation, upload, review, import, and publication failures are isolated from the source Profile and local learning loop.

The immutable local source Skill survives rejection and every failure. Offline preparation is allowed, submission retry is explicit, and an approved candidate remains importable when one reviewer's local draft creation fails.

## Version and adaptive-state layers

An installed Agent combines an immutable published version, an installation-policy overlay, and private local adaptive state.

Official updates replace only the immutable base for a new conversation. They do not overwrite local Memory, USER data, sessions, files, learned skills, or Curator state.

### Official managed privacy gate

Official release provenance is allowed only in the AgentEra control plane, verified cache, read-only projection, and sanitized RuntimeBinding metadata; it never becomes Hermes private-state ownership or learning input.

[[tests/agentera-official-agent-boundary.test.ts]] rejects PLATFORM and official-release vocabulary from Memory, sessions, Skills, Curator, Profile ownership, Runtime distribution, and legacy Hermes One sync. The real-process proof in [[tests/e2e/agentera-official-managed-agent.e2e.ts]] keeps private Profile hashes identical through v2, rollback, pause, offline use, and reconnect while each new conversation receives only its fixed immutable base.

## Runtime isolation

Every installation maps to a distinct writable `HERMES_HOME`; a database `owner_scope` value is not sufficient isolation by itself.

Workspace and organization knowledge is exposed as approved read-only assets. Personal learning is not copied across scopes through the generic Profile clone path.

The normative lifecycle and path-ownership rules are recorded in `docs/agentera-runtime-profile-contract.md` for every later installation and binding implementation.

## Binding stability

A RuntimeBinding is immutable for one conversation or isolated job and records the Agent version, Runtime Profile, Runtime distribution, policy, tools, and adaptive-state revision used at start.

Ordinary updates take effect in a new conversation. Emergency revocation may deny execution without rebuilding the active system prompt or advertised tool schema.

The sanitized RuntimeBinding cloud record is a best-effort audit/control-plane projection of the already committed local binding. Upload failure never changes the Hermes session, Profile, Memory, learned Skills, or local adaptive-state revision.

## Cloud boundary

Cloud state contains identity, ownership, immutable Agent versions, installations, binding metadata, policy snapshots, audit metadata, and explicitly promoted candidates.

Raw conversations, local files, credentials, `MEMORY.md`, `USER.md`, and unpromoted learned skills remain local by default. This replaces the private-data behavior described by the imported [[agent-sync|legacy cloud agent sync]].

The USER-owned stable-version implementation is defined by [[agentera-agent-control-plane|AgentEra Agent control plane V1]], which keeps personal drafts local and separates the new product protocol from the legacy reconciler.

## Legacy sync containment

The imported profile reconciler excludes `MEMORY.md` from upload, download, conflict hashes, and cloud-only profile creation, and no longer exposes a whole-file Memory replacement helper.

Color, SOUL, and model/provider remain in the transitional reconciler until immutable Agent version installation replaces it in Project 2.

## Release gate

Every bundled Runtime update must prove compatibility against a learned Profile before packaging.

The gate covers stable conversation prompts and tools, local background learning, next-conversation recall, Curator behavior, physical Profile isolation, offline use, version updates, migrations, and negative cross-scope cases.

The seed format, offline installation, user-confirmed update, signature verification, and rollback contract are defined by [[agentera-runtime-distribution|AgentEra Runtime distribution]].

### Controlled promotion boundary

The promotion gate proves that one reviewed Skill can reach a later immutable version without moving or changing any other local learning state.

[[tests/agentera-experience-candidate-boundary.test.ts]] permits physical Profile reads only through [[src/main/agentera-agent-control/hermes-skill-candidate-source.ts#ReadOnlyHermesSkillCandidateSource]] and rejects candidate dependencies on Memory or Skill mutation, sessions, Curator, legacy sync, Runtime distribution, Workspace-owned Profiles, and RuntimeBinding ownership changes.

[[tests/e2e/agentera-experience-candidate.e2e.ts]] uses isolated Electron devices and a real local cloud to prove local DLP blocking, explicit retry after upload and review failure, transactional import rollback, Member status isolation, Admin approval, v2 publication, v1 conversation stability, and unchanged private Profile hashes.

The E2E request capture contains only the selected canonical Skill package and allowlisted control metadata. Unselected Skill content, Memory, USER, session, Curator, credentials, local files, Profile paths, and `/api/agents` remain absent.

[[tests/e2e/agentera-agent-control.e2e.ts]] runs two independent devices with one account and hashes their private Profile markers across publish, install, update, archive, and injected cloud failures. Device A's native Memory and learned Skill remain absent from Device B and every captured cloud request, while an existing B conversation remains on v1 and a later conversation binds v2.

## First-release boundary

The first release guarantees self-evolution on the same device and in the same Profile.

Cross-device adaptive-state sync, encrypted backup, automatic personal-to-organization sharing, raw-conversation upload, and model-weight training are separate later projects.

The product gate, device session, seven-day offline entitlement, and existing-Profile claim rules are defined separately in [[agentera-app-authentication|AgentEra application authentication]]. Authentication selects an owner and Profile but never owns the Profile's adaptive state.
