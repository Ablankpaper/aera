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

## Cloud boundary

Cloud state contains identity, ownership, immutable Agent versions, installations, binding metadata, policy snapshots, audit metadata, and explicitly promoted candidates.

Raw conversations, local files, credentials, `MEMORY.md`, `USER.md`, and unpromoted learned skills remain local by default. This replaces the private-data behavior described by the imported [[agent-sync|legacy cloud agent sync]].

## Legacy sync containment

The imported profile reconciler excludes `MEMORY.md` from upload, download, conflict hashes, and cloud-only profile creation, and no longer exposes a whole-file Memory replacement helper.

Color, SOUL, and model/provider remain in the transitional reconciler until immutable Agent version installation replaces it in Project 2.

## Release gate

Every bundled Runtime update must prove compatibility against a learned Profile before packaging.

The gate covers stable conversation prompts and tools, local background learning, next-conversation recall, Curator behavior, physical Profile isolation, offline use, version updates, migrations, and negative cross-scope cases.

## First-release boundary

The first release guarantees self-evolution on the same device and in the same Profile.

Cross-device adaptive-state sync, encrypted backup, automatic personal-to-organization sharing, raw-conversation upload, and model-weight training are separate later projects.
