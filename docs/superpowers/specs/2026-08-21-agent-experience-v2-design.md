# Aera Agent Experience v2 Design

This design fixes the Beta.35 isolated-Agent installation failure and reduces the model and multi-Agent interaction burden without weakening Aera's ownership or Profile isolation.

## Baseline and scope

The Desktop implementation baseline is `origin/main` at `bb3ea33af57d7a13f4b08c73f35471944bdd0f5b` (`0.7.4-internal-beta.35`) in the isolated worktree `aera/.worktrees/agent-experience-v2`. The Runtime implementation baseline is `origin/main` at `fb42016967ad934c55e9da5af1896d5c7206b445` in `aera-runtime/.worktrees/agent-experience-v2-runtime`.

The observed failure is a cross-repository path bug followed by an unsafe Desktop retry decision:

```text
Desktop creates ~/.hermes/.aera-profile-staging/<operation>/home
  -> Runtime collapses every HERMES_HOME below ~/.hermes to ~/.hermes
  -> seed writes a partial Profile into the durable profiles directory
  -> staging validation fails and the partial directory remains
  -> Desktop treats exists(profilePath) as an activated Profile
  -> no owner binding/model transaction exists
  -> model projection is rejected before activation
```

The fix is limited to Desktop, Runtime, and the Agent surfaces that expose this flow. Cloud, Admin, API, the updater, and unrelated task-board behavior are not redesigned in this change.

## Product principles

1. Users choose an Agent by capability. Profile IDs, Owner records, RuntimeBindings, credentials, and staging paths remain Main/Runtime implementation details.
2. A model is a startup default or conversation choice, never a permanent Agent lock. A model change starts a new immutable conversation segment; earlier segments and messages keep their original route.
3. An error belongs to the Agent or conversation that caused it. A failed model projection must not paint a persistent page-level red banner over other Agents.
4. A team is an intent-level entry point. The user describes a goal and sees delegation/progress/results; the existing owner-scoped task/session primitives remain authoritative.
5. The simple path must be the default. Advanced model/profile repair remains available as a secondary action for users who need it.

## Runtime path resolution

`hermes_constants.get_default_hermes_root()` remains the single resolver for profile-level root operations. Its precedence is:

1. If `HERMES_HOME` is unset, return the platform default (`~/.hermes` on macOS/Linux, `%LOCALAPPDATA%\\hermes` on Windows).
2. If `HERMES_HOME` is exactly the platform default, return that default.
3. If `HERMES_HOME` is a normal Profile path under the default root (`<root>/profiles/<id>`), return the default root so profile enumeration continues to work.
4. For any other path under the default root, including Desktop's staging home (`<root>/.aera-profile-staging/<operation>/home`), return the exact `HERMES_HOME` path. A staging home is a real isolated execution root, not the durable root.
5. For custom deployments outside the platform default, preserve the existing `<root>/profiles/<id>` parent rule and otherwise return the custom `HERMES_HOME` path.

The implementation must resolve symlinks only for containment comparison and must not broaden a staging path to its parent. Existing default/profile/custom behavior must remain covered by regression tests.

## Desktop installation and recovery

The installation manager must use durable state plus validated filesystem state; directory existence alone is never proof of activation.

### Fresh installation

1. Persist the Installation operation and fresh Profile reservation before materializing bytes.
2. Prepare the candidate under the staging home returned by `prepareProfile`; launch/configure Runtime with that exact staging `HERMES_HOME`.
3. Seed only the selected owner-catalog route and same-owner credential. Do not copy Memory, `USER.md`, sessions, files, arbitrary environment values, or another Profile's private data.
4. Validate the complete staged managed-file set, Profile scaffold, owner authorization, projection digest, and route before one atomic activation.
5. Activate the candidate, create the exact Owner binding, attach the Installation, persist `runtime_profile_id`, then advance the operation to active/committed.
6. If any step fails, keep the Installation pending with a stable retry code and clean only the operation-owned staging tree. Never claim an unbound existing directory.

### Cold restart and half-Profile repair

Recovery may adopt a durable destination only when all of these match: operation ID, reserved Profile ID, reserved Runtime Profile ID, current Owner/device, and the expected safe scaffold. A path with meaningful private data, a foreign binding, a missing reservation, or an ambiguous owner is fail-closed and untouched.

For the known Beta.35 partial scaffold, recovery records a bounded diagnostic, verifies that the directory contains only operation-created safe files, and retries materialization through the staging path. It may remove or replace only that verified operation-owned partial scaffold; it must not delete a user-created Profile, database rows, credentials, Memory, sessions, or arbitrary directories. The retry is idempotent and must not create a suffixed Profile.

The ready state shown to the renderer requires all of: active Installation, non-null `runtime_profile_id`, a current-owner Profile binding, a complete Profile scaffold, and a successful model route projection. Any missing condition is represented as pending/degraded with a local retry or model configuration action.

## Agent Center experience

Use the existing `AgentControlPanel`/`Agents` projection and existing typed bridges; do not create a second Profile/Installation management surface.

- Keep the current Official / My / Enterprise scopes, but use capability-first cards with one primary action: `开始对话` for ready Agents, `重试` for a retryable pending Agent, and `配置模型` only when no owner-catalog route is available.
- Hide Profile IDs, Owner, RuntimeBinding, staging, and credential terminology from the normal card. The card may show a concise readiness explanation such as “系统已自动准备独立运行空间”。
- Replace persistent global error banners with card-local status and an actionable, localized message. A failed Agent must not change the state or copy of other cards.
- Keep the existing model catalog and opaque selection contract. The Agent card may show a small display label for the current startup model, but this label is informational and never a policy lock.
- Retain Aera's existing shell, brand, product-space boundaries, and accessibility conventions. Adopt WorkBuddy's low-friction hierarchy (capability, one action, short status) without copying its product identity or rebuilding unrelated navigation.

## Conversation model switching

The existing Main-owned `OwnerModelRouteCatalog`, `prepareConversationRuntime`, `ModelPicker`, and immutable segment contract remain authoritative.

- The picker displays provider/model identity without credential references or Profile paths.
- Selecting a route stages an opaque, revision-bearing selection for the next send; it does not rewrite `config.yaml` or the global Settings default.
- Main re-resolves the selection against the current Owner catalog immediately before the send. An unavailable, stale, foreign, or credentialless route returns a bounded error and leaves the active segment unchanged.
- A changed route creates/prepares a new RuntimeBinding segment. The previous segment remains immutable and resumable; the visible thread remains one conversation.
- The UI acknowledges the switch only after Main activates the candidate. The marker says which model starts from the next message and never mutates prompt history.
- A failed switch preserves the previous model and provides a retry path inside the conversation. It must not force navigation back to the Agent Center.

## Team experience boundary

The first implementation is a presentation and entry-point improvement, not a new orchestration engine. The Team card and detail surface reuse existing owner-scoped Kanban/active-session/task primitives where available.

- A user starts a team task by describing a goal, not by manually installing or binding each member.
- The UI presents a leader, member capabilities, inherited task model, optional per-member override, progress, and final summary as a single task view.
- Any actual dispatch remains through the existing typed task/kanban/runtime boundary. No new shared credential store, cross-Profile Memory, or Cloud synchronization of private Agent state is introduced.
- If an existing backend cannot provide a team field, the UI must label the surface as a task/board view rather than inventing a fake completed orchestration.

## Error and privacy contract

The renderer receives bounded error codes and safe display details only. It must distinguish at least `profile_model_configuration_failed`, `model_route_unavailable`, `profile_binding_failed`, `profile_reservation_conflict`, `runtime_profile_conflict`, and a transient retryable installation error. Raw paths, API keys, Authorization headers, database messages, Runtime command lines, and private Profile contents never cross IPC or appear in the UI.

Every failed installation/retry logs an opaque diagnostic ID, operation, stage, stable code, and retryability in Main/Runtime logs. The log is sufficient to correlate Desktop and Runtime evidence without exposing secrets. Existing owner and foreign-profile fail-closed behavior is preserved.

## Implementation sequence

The implementation is intentionally staged so each boundary can be verified before UI changes:

1. **Runtime path fix:** add a failing staging-under-default-root test, update the single root resolver, and run Runtime profile isolation tests.
2. **Desktop installation guard:** add failing tests for exists-without-binding, incomplete scaffold, owner mismatch, and `runtime_profile_id = null`; replace the existence shortcut with reservation/binding/scaffold validation and bounded recovery.
3. **Agent Center UI:** add card-local status/action behavior and the capability-first layout using existing bridges; preserve legacy error and model-selection compatibility.
4. **Conversation UI:** verify the existing picker is reachable from an Agent conversation, keeps the old route after a failed switch, and acknowledges a new immutable segment only after Main activation.
5. **Team surface:** expose only existing task/session capabilities with honest status; do not add a new orchestration protocol in this patch.
6. **Verification:** run focused Runtime/Python tests, focused Desktop/Vitest tests, typecheck, lint, `lat check`, then an Electron E2E with isolated temporary Desktop data and an exact Runtime seed. Do not change the version or publish a package in this work.

## Acceptance criteria

### Installation and recovery

- A clean Electron run can install an Agent with a staging `HERMES_HOME` nested under `~/.hermes` without writing any model/config file to the durable default Profile root.
- A forced first-attempt interruption leaves a pending operation and a safe, retryable state; the second attempt activates the same reserved Profile and Runtime Profile IDs.
- A directory that merely exists but has no current-owner binding is never reported ready and cannot be used as a model target.
- Foreign-owned or meaningful-data Profiles are not claimed, deleted, or overwritten.
- Successful activation has a durable `runtime_profile_id`, current Owner binding, complete managed files, and a committed installation operation.

### Model behavior

- An Agent can start with the current available route without a permanent model lock.
- Switching to another available provider/model affects the next message only, creates one new immutable segment, and leaves the prior segment and global Settings default unchanged.
- A stale/unavailable route leaves the prior active route usable and shows an in-conversation retry/actionable error.

### User experience

- The Agent Center has one obvious primary action per card and no persistent page-level error caused by another Agent.
- The normal flow never asks a user to understand Owner, Profile, RuntimeBinding, staging, or credential projection.
- Team entry shows real task/session state or a clearly labeled unavailable/degraded state; it never fabricates progress or completion.
- Desktop and Runtime tests pass without modifying the user's real database, Profiles, credentials, Memory, sessions, or installed application.

### Regression and delivery boundary

- Beta.32/Beta.35 existing Agent, chat, provider, updater, and workspace behavior remains covered by the unchanged regression suite.
- The implementation does not change the version, release metadata, Cloud/Admin deployment, update channel, or candidate artifacts.
- Production code is not considered complete until the actual Electron flow passes; unit/typecheck success alone is insufficient.

## Alternatives rejected

- **Only repair the visible error:** leaves the root-path and existence-as-activation class of bugs in place and keeps the user-facing flow confusing.
- **Full WorkBuddy clone:** would replace unrelated Aera navigation and introduce a new orchestration architecture, increasing regression and release risk.
- **Remove Profile/Owner isolation:** would hide the symptom by weakening the security boundary and is not acceptable.

