# AgentEra Workspace Foundation V1

Workspace Foundation V1 adds collaborative identity and authorization around AgentEra assets while keeping Hermes execution and private learning local.

## Release boundary

The first workspace slice delivers workspace lifecycle, fixed ownership, membership roles, one-time invitations, audit, desktop context switching, and offline read-only metadata.

It does not enable `owner_scope=WORKSPACE`, workspace Agent publication, shared Knowledge or Skills, organizations, official Agents, or ExperienceCandidate promotion. Those remain later slices built on this authorization boundary.

## Ownership and roles

Each workspace has one fixed Owner plus Admin and Member memberships, all derived from the authenticated AgentEra account rather than request-supplied actor fields.

Owner alone controls Admin roles and archive or restore. Owner and Admin may invite and remove ordinary Members. Owner transfer, multiple Owners, and Owner departure are unavailable in V1. An Owner account pending deletion exposes `owner_unavailable` read-only state until recovery or final deletion.

## Invitations

Invitations are globally single-use Member grants with a seven-day expiry and stable idempotent acceptance semantics.

The cloud persists only a SHA-256 digest of a token carrying at least 256 random bits. The raw token is returned once, excluded from logs and caches, and placed in the link fragment so the browser does not send it in the initial request or Referer.

## Desktop context

The global switcher below the AgentEra brand combines the existing personal-space identity with active workspace memberships returned by the dedicated Workspace API.

Selection is account-scoped product navigation state. It does not switch a Hermes Profile, move sessions or files, rewrite a RuntimeBinding, or activate a workspace Agent. Archived workspaces are managed separately and are not selectable as an active context.

## Offline behavior

A valid product offline entitlement exposes last-known active workspace metadata as stale and read-only while every workspace mutation pauses.

No offline mutation queue is created. Local installed Agents and [[agentera-self-evolution#AgentEra self-evolution compatibility#Local learning loop|Hermes local learning]] continue independently, and a removed or archived selection falls back to personal space after authoritative refresh.

## Control-plane separation

Workspace is an independent cloud and desktop domain rather than an extension of personal-space registration or the USER Agent protocol.

The existing [[agentera-agent-control-plane|AgentEra Agent control plane V1]] remains `owner_scope=USER`. Workspace code cannot read or store Memory, USER, conversations, files, credentials, Profile paths, Curator state, or unpublished local Skills. The approved detailed design is `docs/superpowers/specs/2026-07-20-agentera-workspace-foundation-v1-design.md`.
