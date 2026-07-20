# AgentEra Organization Foundation V1

Organization Foundation V1 adds enterprise identity, membership, departments, signed policy, audit, and lifecycle without moving Hermes runtime or private learning into the cloud.

## Release boundary

The first enterprise slice establishes Organization authorization and desktop product context before any Organization-owned Agent asset exists.

It supports Organization lifecycle, one transferable Owner, Admin/Auditor/Member roles, single-level Departments, one-time invitations, immutable signed policy snapshots, audit, and offline read-only metadata. The locked design is `docs/superpowers/specs/2026-07-21-agentera-organization-foundation-v1-design.md`.

`owner_scope=ORGANIZATION`, enterprise Agent publication, and member installation remain the next independently gated slice. `owner_scope=PLATFORM` and official managed Agents remain the slice after that.

## Ownership and roles

Every active or archived Organization has exactly one transferable Owner plus optional Admin, Auditor, and Member Memberships.

Owner alone controls Admin assignment, ownership transfer, lifecycle, and dissolution. Owner and Admin manage ordinary members, Auditor roles, Departments, invitations, and policy. Auditor reads policy history and audit but cannot mutate. Member has ordinary safe read access.

Owner transfer is one atomic transaction to an existing Admin. Account deletion is blocked until every owned Organization is transferred or safely dissolved.

## Departments

Departments are one-level member groups inside one Organization and never become product spaces or Agent owners.

A Membership may belong to zero or one Department. Roles remain Organization-wide, Departments have no nesting, and `owner_scope=DEPARTMENT` is unsupported. Department assignment never switches a Hermes Profile.

## Policy snapshots

Organization policy is immutable, versioned, digest-bound, signed, cached only after verification, and composable only as a restriction on platform and local safety policy.

V1 expresses model/tool allowlists, manual-or-disabled ExperienceCandidate promotion, and whether future official Agent installation is allowed. Automatic experience publication has no policy value. Runtime enforcement starts in the later Organization Agent slice.

## Desktop product context

One trusted main-process coordinator owns Personal, Workspace, or Organization product selection for each authenticated account.

The global top switcher displays all three scopes side by side. Workspace and Organization remain independent management domains, while a dedicated product-space store prevents two writable selection sources. An Organization selection in Foundation shows an explicit enterprise-Agent-unavailable state rather than falling back to personal Agent ownership.

Offline Organization metadata is stale and read-only. No offline mutation queue exists, and invalid policy cannot replace a previously verified snapshot.

## Hermes boundary

Organization owns only control-plane metadata now and future immutable enterprise Agent assets later; employees retain USER-owned local runtime state.

Switching Organization context does not select, create, clone, move, merge, or delete a Profile or RuntimeBinding. [[agentera-self-evolution#AgentEra self-evolution compatibility#Runtime isolation|Every later Installation still maps to an independent writable Profile]], and Memory, USER, sessions, files, credentials, learned Skills, Curator, and private learning remain local.

## Relationship to Workspace and Agent control

Organization reuses security primitives without becoming a Workspace type or extending legacy sync.

[[agentera-workspaces|Workspace Foundation]] retains its existing tables, fixed-owner lifecycle, invitation protocol, and WORKSPACE asset boundary. [[agentera-agent-control-plane|The Agent control plane]] receives no ORGANIZATION asset context until the next slice; Foundation only exposes trusted Membership, policy, lifecycle, asset-guard, and selected-context contracts.

## Release gate

The Organization slice ships only after multi-account enterprise flow, policy verification, permission, concurrency, audit, and Hermes compatibility pass together.

The deterministic flow covers creation, Department grouping, invitation, role changes, policy publication, audit, Owner transfer, archive/restore, and safe dissolution. Static and runtime gates prove every Organization operation leaves Profile bytes, Memory, USER, learned Skills, Curator, active RuntimeBinding, and Gateway process identity unchanged.
