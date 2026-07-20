# AgentEra Organization Foundation V1

Organization Foundation V1 adds enterprise identity, membership, departments, signed policy, audit, and lifecycle without moving Hermes runtime or private learning into the cloud.

## Release boundary

The first enterprise slice establishes Organization authorization and desktop product context before any Organization-owned Agent asset exists.

It supports Organization lifecycle, one transferable Owner, Admin/Auditor/Member roles, single-level Departments, one-time invitations, immutable signed policy snapshots, audit, and offline read-only metadata. The locked design is `docs/superpowers/specs/2026-07-21-agentera-organization-foundation-v1-design.md`.

`owner_scope=ORGANIZATION`, enterprise Agent publication, and member installation remain the next independently gated slice. `owner_scope=PLATFORM` and official managed Agents remain the slice after that.

## Implementation progress

Organization Foundation is being delivered as independently verified control-plane slices; it is not yet a complete or deployed product feature.

The first implemented slice is the cloud persistence and configuration foundation in `aera-cloud/migrations/000012_organization_foundation.sql` and `aera-cloud/internal/config/config.go`. It adds six Organization-owned tables, an Organization scope on audit, deferred exactly-one-Owner enforcement, cross-Organization Department and policy-pointer protection, immutable policy snapshots, terminal invitation transitions, and explicit quota/rate-limit configuration.

`aera-cloud/internal/store/migrate_test.go` verifies the embedded migration, exact schema objects, real PostgreSQL commit-time invariants, cross-boundary foreign keys, invitation terminal behavior, and policy immutability. `aera-cloud/internal/config/config_test.go` verifies all Organization quota and rate settings, including missing and invalid values. Later sections remain architectural requirements until their corresponding implementation tasks land.

The second implemented slice is `aera-cloud/internal/organization/model.go`, `token.go`, and `limiter.go`. It defines strict Owner/Admin/Auditor/Member and lifecycle values, NFC-normalized Organization and Department names, stable Unicode case-folded Department keys, positive quotas/revisions, renderer-safe summary shapes, canonical 256-bit invitation secrets whose formatting is always redacted, and five independently hashed Redis rate-limit scopes. The focused tests prove malformed or non-canonical tokens are rejected, raw account/device/Organization identifiers never enter Redis keys, backend failure is fail-closed, and each action retains its own counter and window.

The third implemented slice is `aera-cloud/internal/organization/policy.go` and `signing.go`. Policy V1 uses strict duplicate-key and unknown-key rejection, deterministic canonical JSON, stable SHA-256 content digests, explicit null-inherit versus empty-deny semantics, and intersections that can only narrow model or tool access. Immutable policy attestations use the independent `agentera-organization-policy-v1` Ed25519 signature domain and bind Organization ID, snapshot ID, policy version, and content digest. Signing keys are validated and copied, published keys expose only public material, and focused regression tests keep the existing Agent-control signing path green. This is Organization control-plane metadata only; it creates no Agent, Installation, RuntimeBinding, Profile, Memory, session, or learning state.

The fourth implemented slice is `aera-cloud/internal/organization/repository.go` plus Organization-aware audit recording. Organization creation now atomically locks the active actor and ownership quota, enforces a domain-separated canonical request digest, inserts the Organization and sole Owner, signs and persists the platform default policy, stores replay evidence, and records a bounded success audit. Same-key same-request retries return the original safe summary; conflicting content is rejected. Safe keyset reads hide non-member Organizations, expose only summary policy data to Members, and return full validated policy material only to Owner/Admin/Auditor. Real PostgreSQL tests prove archived ownership still consumes quota and signer or audit failure rolls back every Organization, Membership, policy, and idempotency row. Organization audit metadata has a dedicated `organization_id` column and rejects invitations, policy bodies, paths, Profile, Memory, session, and Skill-shaped fields. The full cloud regression suite remains green.

The fifth implemented slice is `aera-cloud/internal/organization/service.go` plus transactional Membership, Department, rename, leave, removal, and Owner-transfer methods. Every mutation locks the authenticated account/device, Organization, and relevant Membership or Department before recomputing authorization. Owner/Admin may manage ordinary members and one-level Departments; Admin cannot mutate Owner/Admin or promote an Admin; Owner assignment exists only through the exact confirmed transfer transaction. Owner transfer atomically demotes the old Owner, promotes one current Admin, advances all expected revisions, and is the only operation in this slice allowed while the Organization is archived. Department assignment requires an active Department in the same Organization, archive requires zero assignments, and create/restore enforce active quota plus normalized-name uniqueness. Real PostgreSQL matrix and race tests cover every role plus outsiders, stale revisions, concurrent member changes, two competing Owner transfers with exactly one commit, cross-Organization assignment, empty-before-archive, quota, and restore collision. Departments remain member grouping metadata and never become product spaces, Agent owners, Installations, RuntimeBindings, or Hermes Profiles.

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
