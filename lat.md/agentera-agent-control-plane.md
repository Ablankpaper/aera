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

## Immutable publication

An explicit publish action turns one local draft revision into an immutable cloud AgentVersion under a stable AgentDefinition.

Publication uses an allowlisted canonical manifest, content digest, platform Ed25519 attestation, policy checks, idempotency, ownership authorization, and audit. A failure leaves the local draft and Hermes Profile unchanged; published versions never use last-writer-wins reconciliation.

## Installation and binding

An Agent Installation selects one immutable version for one device/Profile pair and maps to one physically isolated writable `HERMES_HOME` through the existing encrypted Profile binding store.

The authentication installation ID is not reused as the Agent Installation ID. New Agent installations create a fresh Profile with `cloneFrom=null`; existing learned Profiles require explicit same-owner claim. A RuntimeBinding freezes version, Profile, Runtime, policy, and tools for one conversation.

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
