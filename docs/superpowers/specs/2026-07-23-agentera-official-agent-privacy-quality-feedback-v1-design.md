# AgentEra Official Agent Privacy and Quality Feedback V1 Design

**Status:** Approved in the primary development conversation on 2026-07-23.

## Purpose

Add the privacy-preserving input side of the Official Managed Agent improvement pipeline while keeping official publication human-controlled and keeping Hermes private runtime state outside Cloud and Admin.

V1 answers version-level questions such as whether a release has more timeouts, tool failures, crashes, or explicit negative feedback. It does not reconstruct what a user said, what the Agent answered, which files or tools were involved, or what Hermes learned locally.

## Scope

V1 includes:

- separate authorization for passive official quality metrics and explicit user feedback;
- trusted main-process validation that the event belongs to an eligible PLATFORM Agent RuntimeBinding;
- a strict content-free event schema;
- local minimization, bucketing, queue bounds, consent revocation, and deletion;
- Cloud authentication, schema validation, DLP, rate limiting, rotating pseudonyms, idempotency, retention, and aggregation;
- thresholded Admin dashboards;
- human-created and role-separated QualityProposal review;
- explicit creation of a platform draft from an immutable base version after proposal approval;
- full audit and fail-closed behavior;
- executable proof that no Hermes private marker enters Desktop network capture, Cloud storage, Admin storage, logs, or audit.

## Explicit Non-Goals

V1 does not include:

- model training or fine-tuning;
- automatic experience return;
- automatic prompt, Knowledge, Skill, or SOP generation;
- automatic draft creation, publication, rollout expansion, pause, or rollback;
- raw conversation, prompt, response, tool argument, tool result, filename, file content, path, raw exception, stack trace, log, Memory, USER, Session, private Skill, Curator, credential, API key, local-learning data, or Profile path upload;
- free-text user feedback;
- quality collection for USER, WORKSPACE, or ORGANIZATION Agents;
- individual user or device inspection in Admin;
- changes to `aera-runtime`.

## Consent Model

Quality collection is disabled by default. The desktop exposes two independent choices:

1. `official_quality_metrics`: permit automatic upload of the approved content-free fields after an eligible official conversation or isolated job completes.
2. `official_explicit_feedback`: permit a user-initiated rating and fixed reason code after the desktop shows the exact content-free payload preview.

Consent is versioned and recorded locally before any event is created. Cloud stores a user-scoped consent receipt for authorization, revocation, and deletion, but event rows never store the user or device identifier.

Revocation has four effects:

- prevent creation of new events immediately;
- delete the matching local unsent outbox;
- invalidate any in-flight upload before commit when possible;
- enqueue a Cloud purge for still-retained event rows and derived subject-level state.

Thresholded aggregates already released to Admin are statistical records and are not recomputed to isolate or subtract one person. The consent screen explains this before authorization.

Explicit feedback remains an affirmative action. Enabling passive metrics never submits a rating on the user's behalf.

## Eligibility and Provenance

The main process may create a quality event only when all of the following are true:

- the authenticated product account matches the USER-owned Installation;
- the Installation source is `PLATFORM`;
- the physical Profile and sanitized RuntimeBinding resolve through trusted local state;
- the RuntimeBinding is fixed to one immutable official AgentVersion and release revision;
- the event occurs after that conversation or isolated job reaches a terminal state;
- the corresponding consent purpose is active.

Renderer calls cannot supply owner scope, user ID, device ID, Installation ownership, AgentVersion, release revision, Profile identity, RuntimeBinding identity, model response, tool payload, or raw error.

The raw RuntimeBinding identifier is not persisted as quality data. Cloud verifies the submitted provenance against the authenticated USER-owned Installation and stores only a rotating, purpose-separated binding proof digest used for bounded deduplication.

## Public Event Contract

Every event contains exactly these categories:

- `protocol_version`;
- canonical UUIDv7 `event_id`;
- official platform, definition, immutable version, release, and release-revision identifiers;
- desktop release version and Runtime compatibility version;
- UTC day bucket rather than a high-resolution timestamp;
- one terminal result code;
- one latency bucket;
- one total-token bucket;
- an optional whitelisted crash code;
- for explicit feedback only, one rating and zero or more fixed reason codes;
- a device signature over the canonical event envelope.

Allowed result codes are:

- `success`;
- `user_cancelled`;
- `model_error`;
- `tool_error`;
- `runtime_crash`;
- `timeout`.

Latency uses fixed buckets: `lt_1s`, `1s_5s`, `5s_15s`, `15s_60s`, `60s_180s`, and `gte_180s`.

Total tokens use fixed buckets: `0`, `1_1k`, `1k_4k`, `4k_16k`, `16k_64k`, and `gte_64k`. V1 does not separate prompt from completion tokens.

Crash codes are a closed product-maintained enumeration. Unknown exceptions map to `unclassified_runtime_failure`; raw messages and stacks are discarded before the event object exists.

Explicit feedback ratings are `helpful` or `not_helpful`. Reason codes are a versioned closed catalog such as `incorrect`, `incomplete`, `tool_failed`, `too_slow`, `unsafe_or_inappropriate`, and `other_without_text`.

The strict decoder rejects unknown fields, duplicate fields, non-canonical identifiers, unknown enum values, oversized batches, timestamps outside the accepted day window, non-PLATFORM provenance, and any string outside the approved fields and bounds.

## Desktop Collection and Outbox

The desktop derives counters from existing trusted execution results without changing the Hermes prompt, tools, Memory, background review, Session database, or Profile layout.

The sanitized event is created only after raw runtime objects are out of scope. A static boundary test prevents imports from conversation text, tool payload, filesystem content, Memory, Skill, Curator, Profile, and legacy Hermes One synchronization modules.

The local outbox stores only canonical sanitized event bytes, consent version, attempt state, and bounded retry metadata. It is account- and device-scoped, capped at 1,000 events and 30 days, uses exponential backoff with jitter, and drops oldest passive metrics before any explicit feedback when capacity is reached.

Network failure, sign-out, shutdown, or Cloud unavailability never delays conversation completion. Sign-out removes unsent quality data for that account from the device.

## Cloud Ingestion and Pseudonymization

Cloud performs these checks in order:

1. strict bearer and registered-device authentication;
2. active purpose-specific consent;
3. canonical schema and signature validation;
4. current USER-owned official Installation and provenance verification;
5. request and subject rate limits;
6. forbidden-field and DLP scan of canonical bytes;
7. idempotency on `event_id` plus binding proof;
8. rotating HMAC pseudonym creation;
9. transactional event, consent-revision, and audit commit.

The persisted event has no user ID, device ID, Installation ID, Profile ID, Session ID, RuntimeBinding ID, IP address, User-Agent, or raw authorization metadata.

Pseudonyms use a dedicated key ring and domain separator. One subject pseudonym is stable only inside the configured aggregation window and cannot be joined to account, auth, backup, audit, Workspace, Organization, or ordinary Agent control-plane data by Admin APIs.

## Storage and Retention

Cloud adds isolated storage for:

- purpose-specific consent receipts and revocation state;
- sanitized quality events;
- daily version-level aggregates;
- aggregate suppression state;
- QualityProposals and append-only proposal reviews;
- outbox/reconciliation state for approved Admin-to-Cloud proposal actions;
- privacy-safe audit metadata.

Sanitized event rows are retained for at most 30 days. Daily aggregates are retained for at most 180 days. The retention worker is idempotent, independently audited, and never copies expired event rows into an archive.

Admin receives an aggregate only when it contains at least 10 distinct rotating subject pseudonyms. A suppressed bucket stays unavailable; the API does not reveal whether it contains zero, one, or nine subjects. Neighboring time, version, result, and feedback filters cannot be combined to bypass the threshold.

## Admin Workflow and Roles

Developer may view thresholded version-level aggregates, create a QualityProposal, and create a new platform draft from an approved proposal and its immutable base version.

Super Admin may approve or reject a proposal created by another employee. Proposal approval does not approve a later AgentVersion submission.

Operator may view release-health aggregates needed for bounded rollout, pause, and rollback decisions but cannot create or approve a proposal.

Auditor has read-only access to thresholded aggregates, proposals, reviews, and audit history.

Support and Finance receive no quality-data permission in V1.

A QualityProposal contains only:

- platform, definition, immutable version, and release references;
- selected aggregate identifiers;
- fixed problem categories;
- a bounded internal improvement objective;
- actor, role, reason code, work-order reference, revisions, and timestamps.

The internal improvement objective is DLP-scanned, length-bounded, and must not contain copied user content. A proposal follows `open -> submitted -> approved|rejected -> draft_linked -> closed`. Reviews are append-only, stale revisions fail, submitter self-approval is denied, and every mutation is idempotent and audited.

Creating a draft copies the existing immutable official version into the existing platform draft workflow and attaches only proposal provenance. It does not synthesize or change Agent content. Publication continues through the existing different-person review, immutable version, rollout, pause, and rollback pipeline.

## Failure and Privacy Behavior

- Missing or revoked consent creates no event.
- Unknown fields, DLP findings, invalid signatures, provenance mismatches, stale consent, and ambiguous retries fail closed.
- A rejected upload does not retry with a broader payload.
- Quality service or Admin unavailability never changes Agent execution or local learning.
- Aggregate calculation failure preserves accepted immutable events until normal retention without exposing partial results.
- Proposal or draft failure never changes an immutable version or current release.
- Logging and audit use bounded codes and object identifiers, never payload dumps.

## Acceptance Gate

V1 is complete only when tests prove:

- no event exists before consent;
- passive metrics and explicit feedback are independently authorized;
- only eligible PLATFORM RuntimeBindings produce events;
- every allowed field round-trips and every unknown or forbidden field fails;
- network capture, Desktop state, Cloud rows, Admin rows, logs, errors, and audit contain no private canary;
- revocation stops collection, clears local pending events, and purges retained subject events;
- rate limiting, idempotency, signature, provenance, DLP, and retention fail closed;
- fewer than 10 subjects never become visible through direct or combined filters;
- proposal self-approval and direct publication are impossible;
- approved proposals create only a human-editable draft from the verified immutable base;
- Cloud/Admin failure leaves conversations, RuntimeBindings, Profile bytes, Memory, USER, Session, learned Skills, and Curator unchanged;
- `aera-runtime` remains unchanged.
