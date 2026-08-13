# Beta.28 Agent User Experience Design

**Status:** Approved by the user on 2026-08-13.

## Goal

Make the remaining multi-tenant Agent flows usable without teaching ordinary users about Installations, RuntimeBindings, candidates, policies, immutable versions, or review pipelines.

## User contract

The primary Agent surface exposes four outcome-oriented intents: start using an Agent, continue a conversation, share one saved capability, and recover from a failed operation. A user action authorizes the named outcome; trusted Main and Cloud services still execute every required verification, isolation, DLP, authorization, and audit step.

“Start using” automatically selects the preferred currently available owner model route, prepares an isolated local runtime when required, and opens the conversation. If no model route exists, the same primary location offers “Configure model” and opens the existing model settings; the UI does not display a disabled action or a Runtime/Profile error.

Hermes learned Skills are already saved locally. The product therefore calls them “saved capabilities” rather than pretending to save them again. Sharing one saved capability to a team/project or enterprise performs local preparation and DLP, then submits it in the same explicit click. It never uploads Memory, USER data, conversations, sessions, credentials, other Skills, Profile paths, or model configuration.

## Progressive disclosure

The default Agent page is a catalog and conversation launcher. Governance queues, proposal history, review decisions, draft/version controls, and audit-oriented detail remain available only in a collapsed secondary area for roles that can use them. Ordinary members do not need to open that area to use or share an Agent.

Primary cards and dialogs use user language. Technical identifiers, content digests, source version UUIDs, Installation/Profile labels, policy revisions, and candidate terminology are not shown in the primary journey.

## Error recovery

Recoverable transport, stale-state, local-preparation, and cache errors expose one “Try again” action that reloads authoritative state or replays the bounded operation. Model-route errors expose “Configure model.” Authorization, privacy, and destructive conflicts remain fail-closed and explain the user-visible outcome without exposing internal implementation details.

## Safety boundaries

- One-click orchestration does not merge API calls or bypass prepare/confirm handles.
- The user click supplies the existing fixed confirmation token only for the plainly named action.
- DLP findings stop sharing before Cloud submission.
- Review separation, tenant permissions, immutable publication, audit, and RuntimeBinding freezing remain unchanged.
- Existing conversations keep their fixed binding; automatic managed updates affect later conversations only.
- No Runtime, Cloud, Admin, or schema change is required for this Desktop experience slice.

## Acceptance

Focused tests must prove that one click uses the preferred model route and opens the installed Agent, official installation retains prepare/confirm verification while requiring no second dialog, sharing performs prepare plus submit without a technical preview checkbox, DLP blocks submission, governance defaults closed, and recoverable/model failures expose one concrete next action. An isolated Electron journey must exercise the rendered ordinary-user path.
