# AgentEra Workspace Foundation V1

Workspace Foundation V1 adds collaborative identity and authorization around AgentEra assets while keeping Hermes execution and private learning local.

## Release boundary

The Workspace Foundation slice delivers workspace lifecycle, fixed ownership, membership roles, one-time invitations, audit, desktop context switching, and offline read-only metadata.

Foundation does not itself own Agent assets. The approved Workspace Agent extension builds `owner_scope=WORKSPACE`, immutable publication, discovery, and installation on this authorization boundary; organizations, official Agents, and ExperienceCandidate promotion remain later slices.

## Ownership and roles

Each workspace has one fixed Owner plus Admin and Member memberships, all derived from the authenticated AgentEra account rather than request-supplied actor fields.

Owner alone controls Admin roles and archive or restore. Owner and Admin may invite and remove ordinary Members. Owner transfer, multiple Owners, and Owner departure are unavailable in V1. An Owner account pending deletion exposes `owner_unavailable` read-only state until recovery or final deletion.

## Invitations

Invitations are globally single-use Member grants with a seven-day expiry and stable idempotent acceptance semantics.

The cloud persists only a SHA-256 digest of a token carrying at least 256 random bits. The raw token is returned once, excluded from logs and caches, and placed in the link fragment so the browser does not send it in the initial request or Referer.

## Desktop context

The global switcher below the AgentEra brand combines the existing personal-space identity with active workspace memberships returned by the dedicated Workspace API.

Selection is account-scoped product navigation state. It does not switch a Hermes Profile, move sessions or files, rewrite a RuntimeBinding, or activate a workspace Agent. Archived workspaces are managed separately and are not selectable as an active context.

The trusted main process now separates this context into three layers:

- a strict generated-contract cloud client for the 13 Workspace routes;
- `userData/agentera-workspace/workspace.db`, whose summaries, members, invitations, and selected context are partitioned by authenticated `user_id`;
- one Workspace manager that coalesces online refreshes, rejects late results after an account transition, and serves only stale read-only metadata while offline.

The renderer can reach the manager only through the exact `window.agenteraWorkspace` preload namespace. Every request passes the existing product-access guard and returns a stable success or sanitized error envelope. Renderer requests never supply actor identity, authorization headers, cloud URLs, database paths, or idempotency keys.

The switcher's management dialog renders lifecycle, membership, role, and invitation controls from the current actor role and server mutation state while treating the cloud as the final authorization authority. Offline, archived, and `owner_unavailable` states disable their corresponding mutations; no renderer-side action is queued for later.

A fresh invitation link is held only in the creation dialog state and is cleared on close, account change, workspace change, or an obsolete in-flight response. Invitation lists never contain the raw secret. The App-root invitation gate keeps a protocol token only in a React ref until authentication and explicit user confirmation, then accepts, dismisses the volatile inbox entry, and selects the joined workspace without touching Hermes execution state.

### Trusted Agent context projection

The Workspace manager exposes the selected space as a minimal USER or WORKSPACE Agent context and emits a signal when selection, membership role, or lifecycle refresh may change it.

The projection contains only scope, Workspace ID, and role. It carries no Profile, RuntimeBinding, session, file, Memory, credential, or actor-supplied authorization data, and the Agent manager remains responsible for all Agent operations.

The Agent manager publishes that already-trusted projection in its renderer-safe state so the Agent screen can present Owner/Admin authoring, Member install-only access, and offline read-only drafts. The renderer never sends the Workspace ID, scope, role, or actor back with an Agent mutation; cloud transactions remain the final authorization authority.

## Offline behavior

A valid product offline entitlement exposes last-known active workspace metadata as stale and read-only while every workspace mutation pauses.

No offline mutation queue is created. Local installed Agents and [[agentera-self-evolution#AgentEra self-evolution compatibility#Local learning loop|Hermes local learning]] continue independently, and a removed or archived selection falls back to personal space after authoritative refresh.

## Invitation handoff and single instance

The desktop accepts only the exact fragment link `agentera://workspace-invitation#TOKEN`. It rejects credentials, ports, paths, queries, percent-encoded variants, non-canonical tokens, and every other scheme or host.

Only one pending token exists in volatile main-process memory. A newer valid link replaces the previous unaccepted link; exact dismissal or successful acceptance clears it. It is never written to SQLite, local/session storage, logs, telemetry, or OAuth state.

The app acquires Electron's single-instance lock before Runtime bootstrap. A second launch forwards only a valid invitation to the existing process and cannot start a second desktop or Runtime bootstrap. Packaged and development protocol registration use their respective Electron executable forms.

## Control-plane separation

Workspace is an independent cloud and desktop domain rather than an extension of personal-space registration or the USER Agent protocol.

The [[agentera-agent-control-plane|AgentEra Agent control plane V1]] may consume the selected Workspace asset context, but Workspace code still cannot read or store Memory, USER, conversations, files, credentials, Profile paths, Curator state, RuntimeBindings, or unpublished local Skills. The approved Foundation design is `docs/superpowers/specs/2026-07-20-agentera-workspace-foundation-v1-design.md`.

## Release gate

Workspace Foundation V1 ships only after its multi-account product flow and its separation from Hermes execution and adaptive learning pass together.

### Deterministic multi-account flow

The Playwright gate runs the real desktop Workspace client, manager, account-partitioned SQLite cache, and volatile invitation inbox through a deterministic two-account lifecycle.

`tests/e2e/agentera-workspace.e2e.ts` uses a strict in-process implementation of all 13 locked Workspace routes. The fixture rejects unexpected routes, bodies, headers, query fields, or renderer-supplied actor identity.

The scenario proves Personal-first startup, Owner creation, rename and selection, one-time fragment invitation handoff before sign-in, Member acceptance by a second account, Owner promotion to Admin, Admin restrictions around Owner and peer Admin roles, same-account reload persistence, cross-account cache isolation, offline stale read-only behavior, archive fallback to Personal, and restored selection. It also checks that the raw invitation token occurs only in the first creation response, custom-protocol handoff, and acceptance request, and never in the desktop cache.

Run it with `npm run test:e2e:workspace`.

### Hermes compatibility boundary

The compatibility gate prevents workspace navigation and collaboration metadata from entering or mutating the Hermes execution and adaptive-learning domain.

`tests/agentera-workspace-boundary.test.ts` rejects Workspace-domain imports into Hermes execution, Profile mutation, sessions, Skills, Curator, Runtime distribution or binding, and legacy `agent-sync.ts`. It permits only the startup-level selected-context signal into Agent control and proves RuntimeBinding ownership remains USER-only.

The deterministic E2E additionally hashes a populated Hermes Profile tree and snapshots the selected Profile marker plus active USER RuntimeBinding before and after every workspace operation. All bytes and identities must remain unchanged. Existing Hermes compatibility suites remain part of the focused and complete desktop gates.

### Workspace Agent runtime boundary

Workspace Agent publication shares immutable capability assets without creating a shared writable runtime.

[[tests/agentera-workspace-agent-boundary.test.ts]] statically prevents WORKSPACE ownership from reaching Hermes execution, Profile state, RuntimeBindings, sessions, Skills, Curator, Runtime distribution, or legacy sync.

[[tests/e2e/agentera-workspace-agent.e2e.ts]] proves the complete Owner-to-Member flow with distinct accounts and physical Profiles. Member Memory and learned Skills remain byte-identical through Owner publication and Member update, published Skill, SOP, and Knowledge projections remain read-only outside `HERMES_HOME`, and old/new conversations retain their independently frozen USER RuntimeBindings.
