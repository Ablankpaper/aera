# AgentEra Runtime Profile Mapping Contract

Status: normative for every AgentEra desktop and bundled Runtime release.

## Non-negotiable compatibility rule

AgentEra may add account, ownership, versioning, policy, audit, and publication capabilities around Hermes. It must never replace, intercept, overwrite, delay, or silently change Hermes's native Memory, USER profile, background review, skill learning, Curator, session stability, or Profile isolation behavior.

Any change that violates this rule or fails the Hermes compatibility gate is release-blocking, regardless of whether AgentEra-owned product tests pass.

## Core invariant

Every runnable Agent installation owns exactly one writable Hermes Profile, and that Profile resolves to exactly one physical `HERMES_HOME` directory.

Database ownership fields do not replace filesystem isolation. Two installations must never share writable Memory, USER data, skills, sessions, credentials, Curator state, gateway state, cron state, logs, caches, or local workspace files.

## Identity tuple

The minimum binding identity is:

```text
tenant_id / owner_scope / owner_id / installation_id / runtime_profile_id
```

`runtime_profile_id` is an AgentEra identifier for one physical Hermes Profile. The local mapping from that identifier to a path is device-scoped and is never inferred only from an editable display name.

## Ownership rules

1. One installation maps to one `runtime_profile_id` on a device.
2. One `runtime_profile_id` maps to one writable `HERMES_HOME` path.
3. A writable `HERMES_HOME` belongs to only one installation identity tuple.
4. A conversation or isolated job binds to one Runtime Profile at start and does not switch Profiles mid-run.
5. Published Agent versions and approved shared knowledge are read-only inputs; they do not become another writer to the Profile's private directories.
6. Generic Hermes Profile clone may be used only for deliberate same-owner duplication. Cross-owner publication must not clone credentials, Memory, USER data, sessions, files, local skills, or Curator state.

## Private writable state

The following paths are installation-private even if a cloud Agent definition is shared:

- `memories/MEMORY.md`
- `memories/USER.md`
- `skills/` and skill provenance state
- session databases and session exports
- credentials and provider configuration
- Curator state, archives, and backups
- gateway, cron, logs, caches, and local workspace state

AgentEra cloud does not reconcile these paths. Optional encrypted backup is a separate later product with explicit user control.

## Lifecycle rules

- Creation allocates a new empty or explicitly same-owner-cloned Profile before the installation becomes runnable.
- Conversation start resolves the installation to its fixed Runtime Profile and snapshots the allowed Agent version and policy.
- Agent version update stages read-only version assets outside private writable state and affects a new conversation only.
- Sign-out, offline expiry, failed cloud sync, or failed candidate upload never deletes or resets the Profile.
- Installation removal requires an explicit local-data retention or deletion decision; cloud deletion alone does not erase the Profile.

## Project 1 enforcement

Project 1 enforces the parts possible before Installation and RuntimeBinding exist:

- the desktop no longer transfers or replaces `MEMORY.md`;
- obsolete Memory sync hashes are removed without touching local adaptive state;
- the Runtime compatibility gate proves Hermes prompt, learning, review, skill, Curator, and Profile invariants;
- Projects 2 and 3 must implement the identity tuple and lifecycle without weakening this contract.
