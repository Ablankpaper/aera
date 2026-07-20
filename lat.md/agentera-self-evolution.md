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

### Candidate review and draft import

Workspace Members may submit from their own matching Installation, while Owner and Admin review terminal candidate decisions and import approved content into a local draft.

Cloud migration 11 stores an immutable candidate core plus at most one terminal review. Repository transactions recheck active Workspace membership, lifecycle, current device, and the exact active USER Installation before accepting a contribution.

Submission and review idempotency stay scoped to the authenticated USER actor. Account finalization detaches only submitter, device, and reviewer identifiers; the candidate digest, canonical bundle, destination, and terminal decision remain unchanged.

The cloud candidate API exposes separate own-status and Owner/Admin review queues. Lists omit bundle content; detail reads authorize the active submitter or Workspace reviewer, audit reviewer access, and never return the submitting device identity.

Submission accepts only the path-derived Workspace and definition plus a canonical Skill bundle, source version, and digest. The service repeats canonicalization and DLP before persistence, while rejection notes are bounded and secret-scanned and every review remains terminal.

Approval overlays only the selected Skill directory onto a new draft based on the latest immutable Workspace Agent version. It never publishes automatically or modifies an existing Hermes Profile or running RuntimeBinding.

### Candidate failure isolation

Preparation, upload, review, import, and publication failures are isolated from the source Profile and local learning loop.

The immutable local source Skill survives rejection and every failure. Offline preparation is allowed, submission retry is explicit, and an approved candidate remains importable when one reviewer's local draft creation fails.

## Version and adaptive-state layers

An installed Agent combines an immutable published version, an installation-policy overlay, and private local adaptive state.

Official updates replace only the immutable base for a new conversation. They do not overwrite local Memory, USER data, sessions, files, learned skills, or Curator state.

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

[[tests/e2e/agentera-agent-control.e2e.ts]] runs two independent devices with one account and hashes their private Profile markers across publish, install, update, archive, and injected cloud failures. Device A's native Memory and learned Skill remain absent from Device B and every captured cloud request, while an existing B conversation remains on v1 and a later conversation binds v2.

## First-release boundary

The first release guarantees self-evolution on the same device and in the same Profile.

Cross-device adaptive-state sync, encrypted backup, automatic personal-to-organization sharing, raw-conversation upload, and model-weight training are separate later projects.

The product gate, device session, seven-day offline entitlement, and existing-Profile claim rules are defined separately in [[agentera-app-authentication|AgentEra application authentication]]. Authentication selects an owner and Profile but never owns the Profile's adaptive state.
