# AgentEra Organization and Organization Agent V1

Organization V1 adds enterprise identity, governance, immutable Agent assets, and reviewed publication without moving Hermes runtime or private learning into the cloud.

## Release boundary

The first enterprise slice establishes Organization authorization and desktop product context before any Organization-owned Agent asset exists.

It supports Organization lifecycle, one transferable Owner, Admin/Auditor/Member roles, single-level Departments, one-time invitations, immutable signed policy snapshots, audit, and offline read-only metadata. The locked design is `docs/superpowers/specs/2026-07-21-agentera-organization-foundation-v1-design.md`.

## Invitations

Organization invitations are single-use, seven-day bearer grants whose raw token is never persisted.

Cloud persists only the token digest and returns the fragment-only deep link once. Desktop keeps a received token only in the volatile main-process inbox and routes invitation copying through Electron's main-process clipboard bridge; success is shown only after the write resolves, while failure instructs the administrator to copy the visible one-time link manually.

Acceptance distinguishes an unknown link from an expired, revoked, or already-used invitation without exposing raw tokens or server details. Unknown remains `invitation_unavailable`; expired and revoked links are gone, and a consumed single-use link is a conflict. The renderer removes the fragment before display and presents the exact safe state.

### Independent live proof

`tests/e2e/agentera-organization-invitation-live.e2e.ts` is the invitation-only real Desktop and Cloud acceptance gate; it proves the system clipboard and terminal link states without performing any Agent action.

The gate builds and starts the exact configured Cloud checkout, authenticates three fresh Desktop accounts, creates the Organization and invitation through the real control plane, copies the one-time `aera://` link through Electron's system clipboard bridge, accepts it on a second Desktop, and verifies exact already-used and revoked states on a third Desktop. It refreshes the Owner projection to prove the accepted membership without creating, publishing, reviewing, installing, or running any Agent. Run it with `AGENTERA_E2E_CLOUD_ROOT=<exact-cloud-checkout> AGENTERA_RUNTIME_SEED_DIR=<locked-runtime-seed> npm run test:e2e:organization-invitation-live`.

Organization Agent V1 adds `owner_scope=ORGANIZATION`, mandatory submission review with one Owner/Admin approval, and USER-owned member installation without changing Hermes runtime ownership.

The approved specification is `docs/superpowers/specs/2026-07-21-agentera-organization-agent-v1-design.md`.

`owner_scope=PLATFORM` and official managed Agents remain the slice after Organization Agent V1.

## Implementation progress

Organization Foundation is merged to local `main`. Organization Agent V1 is locally implemented on paired feature branches and remains unmerged, unpushed, and undeployed at this checkpoint.

The first implemented slice is the cloud persistence and configuration foundation in `aera-cloud/migrations/000012_organization_foundation.sql` and `aera-cloud/internal/config/config.go`. It adds six Organization-owned tables, an Organization scope on audit, deferred exactly-one-Owner enforcement, cross-Organization Department and policy-pointer protection, immutable policy snapshots, terminal invitation transitions, and explicit quota/rate-limit configuration.

`aera-cloud/internal/store/migrate_test.go` verifies the embedded migration, exact schema objects, real PostgreSQL commit-time invariants, cross-boundary foreign keys, invitation terminal behavior, and policy immutability. `aera-cloud/internal/config/config_test.go` verifies all Organization quota and rate settings, including missing and invalid values.

The second implemented slice is `aera-cloud/internal/organization/model.go`, `token.go`, and `limiter.go`. It defines strict Owner/Admin/Auditor/Member and lifecycle values, NFC-normalized Organization and Department names, stable Unicode case-folded Department keys, positive quotas/revisions, renderer-safe summary shapes, canonical 256-bit invitation secrets whose formatting is always redacted, and five independently hashed Redis rate-limit scopes. The focused tests prove malformed or non-canonical tokens are rejected, raw account/device/Organization identifiers never enter Redis keys, backend failure is fail-closed, and each action retains its own counter and window.

The third implemented slice is `aera-cloud/internal/organization/policy.go` and `signing.go`. Policy V1 uses strict duplicate-key and unknown-key rejection, deterministic canonical JSON, stable SHA-256 content digests, explicit null-inherit versus empty-deny semantics, and intersections that can only narrow model or tool access. Immutable policy attestations use the independent `agentera-organization-policy-v1` Ed25519 signature domain and bind Organization ID, snapshot ID, policy version, and content digest. Signing keys are validated and copied, published keys expose only public material, and focused regression tests keep the existing Agent-control signing path green. This is Organization control-plane metadata only; it creates no Agent, Installation, RuntimeBinding, Profile, Memory, session, or learning state.

The fourth implemented slice is `aera-cloud/internal/organization/repository.go` plus Organization-aware audit recording. Organization creation now atomically locks the active actor and ownership quota, enforces a domain-separated canonical request digest, inserts the Organization and sole Owner, signs and persists the platform default policy, stores replay evidence, and records a bounded success audit. Same-key same-request retries return the original safe summary; conflicting content is rejected. Safe keyset reads hide non-member Organizations, expose only summary policy data to Members, and return full validated policy material only to Owner/Admin/Auditor. Real PostgreSQL tests prove archived ownership still consumes quota and signer or audit failure rolls back every Organization, Membership, policy, and idempotency row. Organization audit metadata has a dedicated `organization_id` column and rejects invitations, policy bodies, paths, Profile, Memory, session, and Skill-shaped fields. The full cloud regression suite remains green.

The fifth implemented slice is `aera-cloud/internal/organization/service.go` plus transactional Membership, Department, rename, leave, removal, and Owner-transfer methods. Every mutation locks the authenticated account/device, Organization, and relevant Membership or Department before recomputing authorization. Owner/Admin may manage ordinary members and one-level Departments; Admin cannot mutate Owner/Admin or promote an Admin; Owner assignment exists only through the exact confirmed transfer transaction. Owner transfer atomically demotes the old Owner, promotes one current Admin, advances all expected revisions, and is the only operation in this slice allowed while the Organization is archived. Department assignment requires an active Department in the same Organization, archive requires zero assignments, and create/restore enforce active quota plus normalized-name uniqueness. Real PostgreSQL matrix and race tests cover every role plus outsiders, stale revisions, concurrent member changes, two competing Owner transfers with exactly one commit, cross-Organization assignment, empty-before-archive, quota, and restore collision. Departments remain member grouping metadata and never become product spaces, Agent owners, Installations, RuntimeBindings, or Hermes Profiles.

The sixth implemented slice completes the internal Organization lifecycle service in `aera-cloud/internal/organization/service.go` and `repository.go`. Invitation creation returns its 256-bit secret and fragment-only deep link once, persists only the digest, binds replay to the actor, and handles expiry, revoke, existing members, quota, and concurrent acceptance. Owner-only archive revokes pending invitations; restore rechecks ownership quota without reviving them. Dissolution requires archived state, exact display name, revision and confirmation, fails closed through the asset guard, rejects remaining members, pending invitations, or Department assignments, records final audit, deletes mutable rows, and retains only signed policy, audit, and an anonymous replay tombstone. Owner/Admin policy publication is monotonic, immutable, signed, idempotent, and atomic with the current pointer, Organization revision, and audit; Owner/Admin/Auditor receive keyset policy history and audit reads while Member and outsider access is denied without enumeration. Real PostgreSQL tests prove secret non-persistence, one concurrent invitation or policy winner, terminal dissolution, original-actor replay, signer/audit rollback, role gates, and stable keyset pagination. No Organization Agent owner scope or Hermes runtime data is introduced.

The seventh implemented slice exposes the complete Organization Foundation REST surface through `aera-cloud/internal/organization/http.go`, mounts it without shadowing Workspace or Agent routes, and wires it into the cloud process. Every route derives its actor only from the strict bearer principal, rejects ambiguous JSON, duplicate headers and fields, non-canonical UUIDs, unknown queries, oversized bodies, invalid revisions, and cross-collection cursors. Creation and high-risk operations retain actor-bound idempotency; invitation secrets appear only on a valid first creation; Members receive policy summary metadata while privileged roles receive a validated full policy with raw URL-safe signature encoding. The process wires all five configured Redis limit families, transactional PostgreSQL audit, the Foundation-only empty asset guard, and the independent `organization_policy` public verification purpose over the configured signing key ring. Focused route tests, isolated PostgreSQL/Redis process tests, the complete cloud suite, `go vet`, race detection, and production-code boundary scans pass. The Foundation asset guard is explicitly temporary and must be replaced by an Organization Agent asset-backed guard before `owner_scope=ORGANIZATION` can exist.

The eighth implemented slice integrates Organization ownership with account deletion and bounded maintenance. A deletion request now fails with `organization_owner_transfer_required` and only a safe owned-Organization count while any active or archived Organization still has that account as Owner; the verified receipt remains reusable. Finalization repeats the ownership check, removes only non-Owner Membership and Department assignment state, deletes the departing actor's Organization idempotency rows, clears invitation actor references, and anonymizes audit identities while retaining the Organization, Departments, other Memberships, signed policy history, and Organization-scoped audit boundary. A forward migration permits an accepted invitation to retain its terminal status and acceptance time after its accepting account is anonymized. Owner transfer now locks and rejects a target account that is not active, closing the deletion-versus-transfer race. Maintenance expires at most 500 due Organization invitations and deletes at most 500 expired Organization idempotency records per run while retaining unexpired dissolution replay evidence. These changes remain cloud control-plane lifecycle behavior and do not enumerate or mutate Hermes Profile, RuntimeBinding, Memory, session, files, learned Skills, or Curator state.

The ninth implemented slice publishes the Organization Foundation REST contract as OpenAPI 3.0.3 version 0.6.0 and pins it byte-for-byte into the desktop build. The contract declares every Organization lifecycle, Membership, Department, invitation, signed policy, audit, and ownership-deletion response with strict schemas, bounded idempotency and pagination, exact role and lifecycle enums, and the independent `organization_policy` signing-key purpose. `scripts/check-agentera-cloud-contract.mjs` parses the pinned YAML with duplicate-key rejection, verifies every local reference and response set, checks deterministic generated TypeScript, and rejects Organization schemas containing Profile, RuntimeBinding, Memory, session, credentials, API keys, private learning, or personal identity fields. This is still Foundation metadata only: it adds neither `owner_scope=ORGANIZATION` nor enterprise Agent publication or installation.

The tenth implemented slice adds the main-process-only [[src/main/agentera-organization/client.ts#AgenteraOrganizationClient|strict Organization cloud client]] and [[src/main/agentera-organization/policy-verifier.ts#AgenteraOrganizationPolicyVerifier|Organization policy verifier]]. All 27 Foundation interactions validate local input, inject current bearer and actor-bound idempotency headers inside main, bound and duplicate-scan response bytes, require exact generated wire fields and lifecycle relations, redact server bodies, and keep one-time invitation secrets out of list and replay projections. Policy publication canonicalizes allowlists with the same ordered JSON shape as cloud Go code, while verification requires an already canonical full snapshot, exact configured issuer, schema 1, matching SHA-256 digest, the `agentera-organization-policy-v1` signature domain, and a currently published Ed25519 key whose purpose is exactly `organization_policy`. Failed verification returns only a bounded code and never yields a cacheable snapshot. These modules import no Hermes Profile, RuntimeBinding, Memory, session, Skill mutation, Curator, credentials, or legacy Agent sync path.

The eleventh implemented slice adds the account-partitioned [[src/main/agentera-organization/db.ts#AgenteraOrganizationDatabase|Organization desktop cache]] below Electron `userData/agentera-organization/organization.db`, explicitly outside `HERMES_HOME`. Every summary, Membership, Department, invitation, verified policy, and durable mutation-intent query includes the authenticated account ID; authoritative Organization replacement transactionally prunes only that account's removed child state. Policy rows accept only canonical verifier output, retain bounded history, reject stale or conflicting replacements, and preserve the last current snapshot on every validation or transaction failure. The mode-restricted schema contains no audit table, raw invitation token or token digest, selection, Profile, RuntimeBinding, Memory, session, credential, or private-learning column. One-time invitation secrets are rejected before serialization, while non-secret request digests and idempotency keys may persist only as bounded retry intents and are removed on completion or account purge.

The twelfth implemented slice adds [[src/main/agentera-organization/manager.ts#AgenteraOrganizationManager|account-generation-aware Organization desktop state]] and the strict [[src/main/agentera-organization/deep-link.ts#parseOrganizationInvitationDeepLink|Organization invitation deep link]]. Online refresh replaces only the still-current account partition; any late refresh or mutation result from an old account generation is discarded before cache or renderer publication. Offline entitlement exposes cached Organization, Membership, Department, and last-verified current-policy metadata with an explicit stale flag and refresh time, while invitation management, audit, every mutation, and mutation-intent creation remain online-only. Ambiguous idempotent requests retain and reuse one non-secret key; definitive rejections and successful cache application clear it. Policy verification or stale-snapshot failure returns only a bounded error alongside the previous valid role-projected policy, and Member projection can never expose policy documents or signatures. The existing single-instance Workspace invitation inbox now holds one tagged volatile `workspace` or `organization` item: a newer valid fragment-only link replaces the older item, while compatibility methods and IPC tests preserve Workspace behavior. Neither the manager nor invitation handoff imports or invokes Profile, RuntimeBinding, Memory, Skill learning, Curator, Gateway, or legacy Agent synchronization.

The focused manager proof keeps its complete lifecycle and raw-invitation persistence assertions in single real-SQLite flows. Only those filesystem-backed tests receive 30-second Windows budgets; other platforms retain five seconds, and the global Vitest timeout stays unchanged.

The thirteenth implemented slice makes [[src/main/agentera-product-space/manager.ts#AgenteraProductSpaceManager|one trusted product-space coordinator]] and its protected account-partitioned database the sole writable Personal/Workspace/Organization selection source. It imports one still-active legacy Workspace selection once, validates every selection against current cached Membership, excludes archived scopes and Departments, rejects late cross-account results, and falls back to Personal without changing the active Hermes Profile or conversation. Workspace selection compatibility now forwards to the coordinator and never updates the legacy Workspace selection table. Its trusted Agent adapter preserves USER and WORKSPACE exactly; Organization yields `ORGANIZATION_UNAVAILABLE`, zero drafts/installations, and `organization_agent_not_enabled` before any draft, cloud, Profile, or Runtime store is touched. Existing installed Hermes Profile turns remain on the unchanged adapter path. Exact IPC parsing accepts only the selection kind and corresponding scope ID and rejects actor, role, cloud, path, Profile, Memory, and unknown fields.

The fourteenth implemented slice exposes [[src/main/agentera-organization/ipc-contract.ts#executeOrganizationIpc|one bounded Organization IPC contract]] and [[src/main/agentera-product-space/ipc-contract.ts#executeProductSpaceIpc|one bounded product-space IPC contract]] through exact preload namespaces. Main process startup opens the Workspace, Organization, and product-space stores below Electron `userData`, attaches the product-space coordinator as the sole Workspace compatibility writer, and gives Agent control only the coordinator's USER, WORKSPACE, or explicit Organization-unavailable context. Every renderer request receives a central preflight, authenticated, or online policy; inputs reject renderer-supplied actor, role, origin, path, Profile, RuntimeBinding, and unknown authority fields, while outputs are rebuilt from reviewed public allowlists. State and invitation events stop at destroyed renderers and expose removable listeners. Account-generation notifications refresh or invalidate all three control-plane views, and shutdown closes the product-space coordinator before its Organization and Workspace sources. Product-space changes only notify Agent control of context changes: they do not stop, start, select, create, or mutate any Hermes Profile, RuntimeBinding, Memory, session, Skill learning, Curator, Gateway, or legacy Agent synchronization path.

The fifteenth implemented slice replaces the legacy Workspace-only renderer selector with [[src/renderer/src/screens/Layout/ProductSpaceSwitcher.tsx#ProductSpaceSwitcher|one trusted work-context switcher]] directly below the desktop brand. The product wording is “我的 / 企业名 / 团队或项目” rather than three peer technical spaces; empty groups are omitted and one shared context hides redundant visual hierarchy. It never lists Departments, displays cached offline state, and sends selection only through the product-space bridge without invoking any Hermes Profile method. [[src/renderer/src/screens/Layout/OrganizationAccessDialog.tsx#OrganizationAccessDialog|The account-level enterprise and invitation dialog]] lets the same account paste a one-time invitation or create another Organization without introducing a second account type. [[src/renderer/src/screens/Layout/OrganizationManagementDialog.tsx#OrganizationManagementDialog|Organization governance]] is visible to Owner/Admin for mutation and Auditor for policy/audit read-only supervision; Member sees no governance entry. Renderer gating remains presentation only, and every mutation or privileged read still crosses strict main-process and cloud authorization. [[src/renderer/src/screens/Layout/OrganizationPolicyPanel.tsx#OrganizationPolicyPanel|The policy panel]] separates the verified active snapshot, editable next-version settings, publication action, and immutable signed history. Owner transfer and dissolution require exact confirmation material, invitation links remain volatile and visible once, and account, selection, role, close, and late-result changes invalidate sensitive dialog state. [[src/renderer/src/components/OrganizationInvitationGate.tsx#OrganizationInvitationGate|The Organization invitation gate]] retains tokens only in memory across sign-in or offline handoff and selects the accepted Organization through the product-space coordinator.

The sixteenth implemented slice closes Foundation with deterministic multi-account and isolation evidence. [[tests/e2e/agentera-organization.e2e.ts]] runs the real strict Organization client, account-generation-aware manager, signed-policy verifier, SQLite cache, and volatile invitation inbox against an in-process cloud fixture. The fixture derives authority only from three bearer identities, rejects unknown routes, headers, queries, bodies, private-runtime fields, idempotency conflicts, unauthorized calls, and token persistence, and stores invitation digests rather than raw secrets. The scenario covers Organization and Department creation, two one-time invitations, Member-to-Admin and Member-to-Auditor transitions, signed policy V2, Auditor policy and audit reads, atomic Owner transfer, archive/restore, leave/removal, empty Department archive, and confirmed dissolution. Before and after every action it hashes the complete populated Hermes tree and separately snapshots selected Profile, active conversation/session, USER RuntimeBinding, Memory, USER, learned Skill, Curator, and Runtime/Gateway identity. [[tests/agentera-organization-boundary.test.ts]] and [[tests/agentera-product-space-boundary.test.ts]] statically prevent Organization or product-space metadata from entering those runtime paths and lock the explicit Organization-Agent-unavailable stop. Run the focused proof with `npm test -- tests/agentera-organization-boundary.test.ts tests/agentera-product-space-boundary.test.ts` and `npm run test:e2e:organization`.

## Organization Agent approval

Organization publication uses immutable cloud submissions; one current Owner or Admin approval can create a signed Version, including approval by the submitter.

`aera-cloud/internal/agentcontrol/organization_submission_repository.go:PostgresRepository.ReviewOrganizationAgentSubmission` performs the transactional approval, and `organization_submission_repository_test.go:TestOrganizationApprovalRaceCreatesAtMostOneVersionAndReview` proves concurrent approvals create at most one Version and review.

### Submission state machine

Pending submissions terminate as approved, rejected, withdrawn, or superseded; a stale next-version approval commits superseded state without inserting another Version.

`aera-cloud/internal/agentcontrol/organization_submission_repository.go:markOrganizationSubmissionSuperseded` implements the terminal transition, proven by `organization_submission_repository_test.go:TestOrganizationNextApprovalCommitsSupersededWithoutVersion`.

### Role, policy, and DLP recheck

Owner/Admin may submit and review, Auditor is read-only, and Member may discover and install; policy and DLP are rechecked at review time.

`aera-cloud/internal/agentcontrol/organization_access.go:requireOrganizationAgentAccess` derives current lifecycle and role authority. `organization_submission_repository.go:validateAgainstCurrentOrganizationPolicy` narrows policy again, with coverage in `organization_access_test.go:TestIntersectOrganizationAgentPolicyOnlyNarrows`.

### Organization asset guard

Organization dissolution fails closed while a submission, published definition/version, or USER Installation still references the Organization.

`aera-cloud/internal/agentcontrol/organization_asset_guard.go:OrganizationAssetGuard.DissolutionBlockers` reads the protected categories, and `organization_asset_guard_test.go:TestOrganizationAgentAssetGuardReadsRealProtectedCategories` proves the real PostgreSQL blockers.

### Multi-account executable proof

Four real local accounts prove role gates, approval races, immutable versions, USER installations, offline use, removal gates, and private-runtime isolation.

[[tests/e2e/agentera-organization-agent.e2e.ts]] is the deterministic Owner/Admin/Auditor/Member flow. It snapshots every Profile-private fixture and captures cloud requests to prove Memory, USER, sessions, credentials, local Skills, Curator, files, and private learning never cross the boundary.

Owner, Admin, and Auditor may inspect submissions and reviews. Active Owner, Admin, and Member may discover and install approved versions; Auditor remains read-only. Every employee Installation, policy overlay, RuntimeBinding, physical Profile, and adaptive state remains USER-owned.

Organization policy and DLP run at submission and again at approval. An archived Organization is read-only, membership changes fail closed, and the real Agent asset guard blocks dissolution while enterprise submissions, published assets, or referencing Installations exist.

The desktop replaces `ORGANIZATION_UNAVAILABLE` only from the trusted product-space context. Renderer payloads never assert Organization ownership or role, and selecting an Organization never selects a Hermes Profile.

## Ownership and roles

Every active or archived Organization has exactly one transferable Owner plus optional Admin, Auditor, and Member Memberships.

Owner alone controls Admin assignment, ownership transfer, lifecycle, and dissolution. Owner and Admin manage ordinary members, Auditor roles, Departments, invitations, and policy. Auditor reads policy history and audit but cannot mutate. Member has ordinary safe read access.

Owner transfer is one atomic transaction to an existing Admin. Account deletion is blocked until every owned Organization is transferred or safely dissolved.

## Departments

Departments are one-level member groups inside one Organization and never become product spaces or Agent owners.

A Membership may belong to zero or one Department. Roles remain Organization-wide, Departments have no nesting, and `owner_scope=DEPARTMENT` is unsupported. Department assignment never switches a Hermes Profile.

## Policy snapshots

Organization policy is immutable, versioned, digest-bound, signed, cached only after verification, and composable only as a restriction on platform and local safety policy.

V1 expresses model/tool allowlists, manual-or-disabled ExperienceCandidate promotion, and whether future official Agent installation is allowed. Organization Agent installation and manual version selection intersect the current Organization policy with the immutable version; automatic experience publication has no policy value.

## Desktop product context

One trusted main-process coordinator owns USER, WORKSPACE, or ORGANIZATION selection for each authenticated account, while the product presents only where the same account is working.

The acceptance rule is: “one account, multiple working identities; login decides who you are, context decides where data belongs, and role decides what you can do.” Phone, email, and future SSO remain authentication methods for the same user. Membership or role changes do not create a personal-versus-enterprise account type.

In an active Organization, “我的智能体” remains available and can create USER-owned drafts; “企业智能体” contains the governed Organization catalog, drafts, and review surface. Owner and Admin may create, submit, and approve enterprise drafts; Auditor may inspect policy, audit, submissions, and review history without mutation; Member may work and use approved Agents but receives no enterprise-management entry.

[[agentera-agent-control-plane#Installation and binding#Conversation boundary|ConversationBoundary]] freezes each new conversation independently from the top selector. Running in an Organization does not make a conversation visible to colleagues: visibility remains PRIVATE until an explicit share operation exists.

Offline Organization metadata is stale and read-only. No offline mutation queue exists, and invalid policy cannot replace a previously verified snapshot.

## Hermes boundary

Organization owns control-plane metadata plus immutable enterprise Agent definitions and versions; employees retain USER-owned local runtime state.

Switching Organization context does not select, create, clone, move, merge, or delete a Profile or RuntimeBinding. Only an explicit “使用智能体” action may ask the existing Installation path to prepare that Agent's isolated local runtime. [[agentera-self-evolution#AgentEra self-evolution compatibility#Runtime isolation|Every Installation maps to an independent writable Profile]], and Memory, USER, sessions, files, credentials, learned Skills, Curator, and private learning remain local.

## Relationship to Workspace and Agent control

Organization reuses security primitives without becoming a Workspace type or extending legacy sync.

[[agentera-workspaces|Workspace Foundation]] retains its existing tables, fixed-owner lifecycle, invitation protocol, and WORKSPACE asset boundary. [[agentera-agent-control-plane|The Agent control plane]] consumes Organization context only from the trusted product-space coordinator and keeps all runtime ownership USER-scoped.

## Release gate

The Organization slice ships only after multi-account enterprise flow, policy verification, permission, concurrency, audit, and Hermes compatibility pass together.

### Deterministic multi-account flow

The deterministic flow covers creation through confirmed dissolution across three authenticated accounts.

It includes Department grouping, invitation, role changes, policy publication, audit, Owner transfer, archive/restore, member cleanup, and Department archive. Static and runtime gates prove every action leaves Profile bytes, Memory, USER, learned Skills, Curator, active RuntimeBinding, and Gateway process identity unchanged.

### Hermes compatibility boundary

Every Organization operation is control-plane-only. The static boundary test and the per-action runtime snapshots must both pass; neither a successful mutation nor a rejected authorization attempt may alter Hermes private or adaptive state.

### Product-space isolation

USER, WORKSPACE, and ORGANIZATION selection is account-scoped navigation metadata; the renderer presents it as “我的 / 企业 / 团队或项目”.

Organization context invalidation must stop new Organization Agent mutation and new conversations before a cloud or RuntimeBinding write, while existing immutable bindings remain usable.

Organization Agent V1 remains local implementation and validation evidence only until separate merge, push, deployment, and release gates are completed. `owner_scope=PLATFORM` remains a later slice.
