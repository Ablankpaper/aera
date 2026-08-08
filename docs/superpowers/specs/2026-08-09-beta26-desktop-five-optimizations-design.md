# Beta.26 Desktop Five Optimizations Design

**Status:** Approved in conversation on 2026-08-09

**Desktop base:** `origin/main` at `e8404501e642f3f54b777b78ad32ce9f3dcb153a`

**Implementation branch:** `aera/beta26-five-optimizations`

## Goal

Deliver five bounded Desktop improvements for the next Beta.26 candidate:

1. prevent two complete-looking assistant answers from being joined into one reply bubble;
2. show the active conversation's Agent display name in the conversation-boundary row;
3. rename the Chinese navigation labels to “任务看板” and “工具社区”;
4. make the recharge action open `https://petoi.cn` by default;
5. remove the legacy Hermes One account sign-in surface from Model > Advanced.

The work changes only the independent Electron Desktop repository. It does not modify Aera Cloud, Admin, API, Runtime, the public site, or any deployed service.

## Observed Reply Defect

The supplied screenshot shows one assistant bubble containing two complete identity-and-capability introductions. The first introduces an unnamed Nous Research assistant; the second introduces Hermes Agent and repeats a similar capability list. This is a user-visible transcript defect even if it occurs only occasionally.

The screenshot does not resemble ordinary reasoning output. Dashboard `thinking.delta` events are ignored by the transcript adapter, and `reasoning.delta` events produce a separate reasoning row. Ordinary assistant text instead arrives through `message.delta` and is reconciled with the final text in `message.complete`.

The current main branch already verifies sequenced Runtime streams with `stream_id`, monotonic `seq`, `final_seq`, and `text_sha256`. That protects the sequenced path from duplicate, missing, conflicting, or stale chunks. Legacy or unsequenced turns still use heuristic text reconciliation. When streamed text and completion text are both non-empty, neither contains the other, and no meaningful seam is found, the current fallback joins them with a blank line. Two independently complete introductions can therefore become one doubled bubble.

The screenshot alone cannot prove whether the upstream Runtime produced a revised final answer, replayed a completion event, or supplied another legacy mismatch. The Desktop fix must be correct for each of those shapes without guessing from product-specific phrases such as “Hermes Agent” or “Nous Research”.

## Reply Reconciliation Design

The renderer will retain the existing sequenced integrity protocol and add a small turn-local completion boundary for legacy events.

Each active Dashboard turn is keyed by the renderer's existing `turnId`. Its
state resets when prompt submission starts; `message.start` confirms the same
turn boundary when that event is available. The turn records:

- whether a matching `message.start` has arrived;
- whether any tool event occurred before `message.complete`;
- whether a completion has already been accepted for that turn.

The rules are:

1. A valid sequenced completion remains authoritative and replaces the visible assistant text exactly, as it does on current main.
2. For an unsequenced turn with no tool event, non-empty completion text is the authoritative reply. It replaces streamed assistant text instead of concatenating another complete answer.
3. For a turn that did contain a tool event, the existing reconciliation remains available so useful prose streamed before a tool call is not discarded when the completion contains only the last assistant segment.
4. After one completion is accepted, another `message.complete` for the same `turnId` is ignored. A new prompt gets a new `turnId`, so a later user turn may legitimately receive identical text even if a legacy Runtime omits `message.start`.
5. `thinking.delta` remains excluded from assistant bubbles. `reasoning.delta` and non-duplicate completion reasoning remain separate reasoning rows.
6. No language-, brand-, identity-, or phrase-based deduplication is added. Legitimate repeated words, Chinese text, combining marks, emoji, and repeated model output remain intact when they are genuinely part of one authoritative answer.

This design prefers event provenance over fuzzy semantic similarity. It fixes the screenshot shape while preserving the established pre-tool-text behavior.

## Conversation Agent Name

The approved layout is the single-row option:

```text
运行于：我的 | 智能体：水鱼 | 可见性：仅自己
```

`listProfiles()` already returns both the stable internal Profile `id` and the user-facing `name`. `Layout` will retain the display name beside the existing avatar and color data, pass it through the mounted `Chat` run, and give it to `ConversationBoundaryIndicator`.

The indicator displays the trimmed Profile name. If it is empty, it falls back to the stable Profile ID and finally the existing default Profile label. The display change does not mutate the Profile, select another RuntimeBinding, change product-space ownership, or change conversation visibility.

The new “智能体” label is localized through the chat boundary locale rather than hard-coded into the React component. Narrow windows may wrap the existing flex row; no separate title row is introduced.

## Navigation Labels

Only user-visible Chinese navigation copy changes:

- `navigation.kanban`: “看板” becomes “任务看板”;
- `navigation.discover`: “发现” becomes “工具社区”.

The internal `kanban` and `discover` view identifiers, routes, saved state, icons, and component names remain unchanged. Other language packs keep their existing localized labels in this bounded change.

## Recharge Destination

`getAgenteraRechargePublicUrl()` will use `https://petoi.cn` as its production-safe default when no recharge URL is configured. Existing environment and build-time values continue to override the default for isolated development, tests, and later deployment changes.

The existing URL parser remains the authority. It still rejects credentials, fragments, unsafe protocols, and non-loopback HTTP. The account menu and Settings account pane continue to call the current main-process `openPortal("recharge")` path, so the renderer never constructs or trusts an external URL.

The canonical URL returned by `URL.href` may include the normal trailing slash. The destination origin remains `https://petoi.cn`.

## Remove the Hermes One Login Surface

Model > Advanced will no longer render the legacy Hermes One account card, login button, logout button, or device-login modal. `Providers.tsx` will remove the related account state, `getAccount()` effect, modal state, unused icon/type imports, and modal render branch.

This is a presentation-scope removal, not an account-system migration. The change does not delete:

- Aera product account login and the account menu;
- account, device, and recharge portal actions;
- main-process Hermes account compatibility APIs or stored data;
- Agent sync, wallet compatibility, or other existing consumers of those APIs.

Keeping the compatibility layer avoids breaking unrelated paths while ensuring the user can no longer encounter the obsolete login page in Model > Advanced. The relevant `lat.md` description will be updated so it no longer claims that Providers exposes this entry point.

## Error Handling

- A malformed or conflicting sequenced stream continues to fail closed with the existing localized stream-integrity error.
- A legacy turn with no final text keeps its streamed text and completes normally.
- A tool-bearing legacy turn keeps the established safe merge rules.
- A missing Profile display name degrades to a stable visible identifier rather than hiding the Agent field.
- Recharge URL validation failures continue to surface through the existing account action error state.
- Removing the Providers login surface introduces no data deletion and no automatic logout.

## Test Design

Focused tests will cover only the changed boundaries.

### Chat stream

- a no-tool turn with one complete streamed introduction and a different complete final introduction renders only the final introduction;
- a duplicate completion for the same `turnId` is ignored even when a legacy Runtime omits `message.start`;
- a later turn may legitimately produce the same final text;
- text before a real tool event and a final post-tool segment are both retained;
- sequenced stream repair and digest failure behavior remain unchanged;
- thinking stays out of the assistant bubble and reasoning stays in its own row.

### Conversation header

- the indicator renders scope, Agent display name, and private visibility in the approved order;
- an empty display name uses the Profile fallback;
- Layout passes `ProfileInfo.name` to each run without changing its stable Profile ID.

### Navigation, recharge, and Providers

- Chinese navigation resolves to “任务看板” and “工具社区” while the internal view identifiers remain unchanged;
- the recharge configuration resolves explicit overrides first and `https://petoi.cn/` otherwise;
- unsafe recharge values are still rejected;
- Model > Advanced does not call `getAccount()`, render the Hermes account section, or mount `HermesAccountModal`;
- OAuth provider login and the remaining advanced model controls continue to render.

## Verification

Implementation is complete only after:

1. focused Vitest suites for the affected chat, boundary, navigation, recharge, and Providers files;
2. Node and web TypeScript checks;
3. the production Electron/Vite build;
4. affected formatting and lint checks;
5. required `lat.md` updates and `lat check`;
6. one isolated Electron journey using temporary `userData` and `HERMES_HOME`, confirming the five visible outcomes without opening or modifying the daily `/Applications/Aera.app`, daily Profile, credentials, account state, or Runtime data.

The isolated Electron check may use deterministic fixture events to prove the intermittent duplicate boundary. A real-provider response is supplementary evidence, not a requirement to leak prompts, completions, credentials, or private Profile content.

## Non-goals and Release Boundary

This change does not:

- redesign the full ordered chat timeline;
- change Runtime 0.20 event serialization or publish a Runtime build;
- add semantic or AI-based duplicate detection;
- rename internal routes or migrate stored navigation state;
- redesign the conversation header beyond the approved single-row Agent field;
- change the Aera account system or delete legacy account data;
- deploy `petoi.cn`, change its payment system, or prove recharge settlement;
- authorize a push, pull request, merge, Beta.26 package, release, deployment, or production promotion.

Those delivery actions require separate explicit authorization and exact-head evidence after the implementation is reviewed.
