# AgentEra Agent control plane V1

The first AgentEra control-plane slice publishes USER-owned stable Agent versions without turning drafts or Hermes private runtime state into cloud data.

## First-release boundary

V1 implements only `owner_scope=USER`; workspace, organization, official Agent, ExperienceCandidate, and encrypted-backup behavior remain later projects.

The cloud is an identity, version, policy, installation, binding-metadata, and audit control plane. Agent execution and model access stay on the user's computer.

## Owner identity

The USER owner tuple is derived from the authenticated product session and cannot be selected by request payloads.

`tenant_id` is the account's `personal_space_id`, `owner_scope` is `USER`, and `owner_id` is the AgentEra `user_id`. The existing device-installation identity remains separate from a new per-Agent Installation ID and opaque Runtime Profile ID.

## Local drafts

Personal Agent drafts stay in an AgentEra-owned application database under Electron userData and do not synchronize to the cloud.

Draft editing does not mutate a running Profile. Importing selected Persona or Skill content is explicit and never scans or uploads Memory, USER, sessions, credentials, files, or the complete Profile.

## Local account isolation

One Electron userData root may outlive several product logins, so every local Agent record is scoped again inside the main process.

[[src/main/agentera-agent-control/db.ts#AGENTERA_CONTROL_PLANE_SCHEMA_VERSION]] schema v2 adds personal-space, user, and where required device ownership to drafts, verified version caches, installations, RuntimeBindings, and sanitized outbox records. Legacy records with no provable owner remain preserved but unavailable rather than being assigned to the next login.

[[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager]] resolves the current owner for each local operation and rebuilds Runtime components after an owner change. [[tests/agentera-agent-owner-isolation.test.ts]] proves that one long-lived manager cannot list, count, or open the previous account's draft; store-level tests cover versions, installations, bindings, and pending delivery.

## Immutable publication

An explicit publish action turns one local draft revision into an immutable cloud AgentVersion under a stable AgentDefinition.

Publication uses an allowlisted canonical manifest, content digest, platform Ed25519 attestation, policy checks, idempotency, ownership authorization, and audit. A failure leaves the local draft and Hermes Profile unchanged; published versions never use last-writer-wins reconciliation.

## Installation and binding

An Agent Installation selects one immutable version for one device/Profile pair and maps to one physically isolated writable `HERMES_HOME` through the existing encrypted Profile binding store.

The authentication installation ID is not reused as the Agent Installation ID. New Agent installations create a fresh Profile with `cloneFrom=null`; existing learned Profiles require explicit same-owner claim. A RuntimeBinding freezes version, Profile, Runtime, policy, and tools for one conversation.

Manual selection downloads and verifies the immutable version, calls the cloud selection transaction, retrieves the newly signed policy through `GET /api/v1/policy-snapshots/{policy_snapshot_id}`, and only then atomically activates the read-only projection for later conversations. A missing or invalid policy leaves the last local version selected.

[[src/main/agentera-agent-control/runtime-binding-store.ts#RuntimeBindingStore]] commits a complete local binding before queuing its sanitized cloud record. [[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager]] retries that outbox after installed turns, session attachment, and authentication changes, but delivery failure cannot delay or roll back Hermes.

## Hermes integration

Hermes remains the sole execution and self-learning engine while AgentEra supplies read-only version assets and policy at conversation start.

Published assets never overwrite private Profile paths. Native Memory, USER, background review, agent-created Skill learning, Curator, sessions, files, and credentials continue under [[agentera-self-evolution|the Hermes compatibility contract]].

## Cloud boundary

Cloud data is limited to Agent definitions, immutable versions, installations, policy snapshots, sanitized binding metadata, and audit evidence.

API keys, tokens, Base URLs, Profile paths, Memory, USER, conversations, files, credentials, unpromoted Skills, and Curator state remain local and are rejected by control-plane endpoints.

## Legacy sync separation

The imported Hermes One `/api/agents` reconciler remains a transitional compatibility feature and is not extended into the AgentEra control plane.

AgentEra uses a separate product account, cloud API, main-process module, local store, IPC namespace, and renderer state. Existing Memory exclusion remains intact, and legacy IDs are not migrated automatically.

## Offline and failure behavior

A valid offline entitlement allows cached installed versions, local RuntimeBindings, local drafts, and native Hermes learning whenever the configured model endpoint remains reachable.

Publication and discovery pause offline. Cloud, publication, installation, and audit failures never delete or roll back a draft, installed version, completed turn, Profile binding, or private adaptive state.

## Release gate

The feature cannot begin from or ship with a falsely green authentication or compatibility baseline.

Cloud tests run without cache, version immutability and owner isolation are proven, private Profile fixtures remain byte-identical through install/update failures, and active conversations keep a stable binding. The detailed approved design is `docs/superpowers/specs/2026-07-19-agentera-user-agent-control-plane-v1-design.md`.

### Two-device boundary

The end-to-end gate exercises one USER account through two physically isolated local device contexts.

[[tests/e2e/agentera-agent-control.e2e.ts]] launches two isolated Electron devices against a real local PostgreSQL/Redis-backed cloud. It proves draft-zero-cloud behavior, v1 publish and distinct installation, A-only Memory/Skill learning, v2 manual selection, old-conversation v1 stability, new-conversation v2 binding, sanitized requests, failure non-destruction, and absence of `/api/agents` calls.

The executable gate is `npm run test:e2e:agent-control`; contract drift is blocked by `npm run check:agentera-cloud-contract`. The test harness owns and removes only its temporary userData, `HERMES_HOME`, device keys, Runtime Seed copy, cloud process, containers, and database volume.
