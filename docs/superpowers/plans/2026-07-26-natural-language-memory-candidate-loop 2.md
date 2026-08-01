# Natural-language memory candidate loop implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn explicit natural-language Agent naming and account-wide address requests into user-confirmed, correctly scoped writes without delaying or intercepting Hermes self-evolution.

**Architecture:** A pure local classifier examines only the current visible user text after the normal Hermes submission has started. A main-process candidate manager persists only bounded structured proposals under the authenticated account; an inline renderer card confirms or rejects them. Confirmation routes to the existing Agent identity service or global-profile manager. Runtime production behavior stays unchanged unless executable provenance tests expose a real defect.

**Tech Stack:** Electron, TypeScript, React, Vitest, Python, pytest through `scripts/run_tests.sh`, Aera `lat.md`.

**Workspace constraint:** Continue in `/Users/zizimutou/Desktop/aera/aera` on the existing dirty feature branch. Preserve all unrelated user changes; do not commit, push, clean, or create a separate worktree.

---

### Task 1: Candidate contracts and local classifier

**Files:**

- Create: `src/shared/agentera-memory-candidate.ts`
- Create: `src/main/agentera-global-profile/classifier.ts`
- Create: `src/main/agentera-global-profile/classifier.test.ts`

- [ ] Write failing behavior tests proving a mixed explicit sentence yields two arbitrary-value proposals, unrelated questions yield none, values are bounded, and raw text is not part of the returned contract.
- [ ] Run `npm test -- src/main/agentera-global-profile/classifier.test.ts` and confirm RED because the classifier does not exist.
- [ ] Implement a deterministic high-confidence classifier for explicit Agent identity and preferred-address directives in Chinese and English. Do not hardcode example names and do not call a network/LLM.
- [ ] Re-run the focused test and confirm GREEN.

### Task 2: Account-partitioned candidate persistence

**Files:**

- Create: `src/main/agentera-global-profile/candidate-manager.ts`
- Create: `src/main/agentera-global-profile/candidate-manager.test.ts`
- Modify: `src/main/agentera-global-profile/manager.ts`

- [ ] Write failing tests for UUID account isolation, `0600` writes, deduplication, expiry, reject, single confirmation, and absence of raw transcript fields.
- [ ] Run the candidate-manager test and confirm RED.
- [ ] Implement structured candidate storage below `userData/agentera-global-profile/<userId>/candidates/` and an internal `setConfirmedCandidateEntry` path that records `source=candidate_confirmed`.
- [ ] Re-run manager and candidate tests and confirm GREEN.

### Task 3: Main-process confirmation routing

**Files:**

- Modify: `src/main/app/start.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/main/ipc/auth-guard.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `tests/preload-api-surface.test.ts`
- Create: `tests/agentera-memory-candidate-ipc.test.ts`

- [ ] Write failing contract tests proving renderer input cannot choose another account, filesystem path, target source, or unconfirmed payload.
- [ ] Run the focused tests and confirm RED.
- [ ] Expose `extract`, `confirm`, and `reject` handles. Derive account/profile in main, notify both identity and global-profile subscribers, and keep confirmation idempotent/fail closed.
- [ ] Re-run focused IPC/preload/auth tests and confirm GREEN.

### Task 4: Inline confirmation card and non-blocking chat integration

**Files:**

- Create: `src/renderer/src/screens/Chat/MemoryCandidateCard.tsx`
- Create: `src/renderer/src/screens/Chat/MemoryCandidateCard.test.tsx`
- Modify: `src/renderer/src/screens/Chat/types.ts`
- Modify: `src/renderer/src/screens/Chat/MessageList.tsx`
- Modify: `src/renderer/src/screens/Chat/hooks/useChatActions.ts`
- Modify: `src/renderer/src/screens/Chat/Chat.tsx`
- Modify: `src/shared/i18n/locales/en/chat.ts`
- Modify: `src/shared/i18n/locales/zh-CN/chat.ts`
- Modify: `src/renderer/src/assets/main.css`

- [ ] Write failing tests proving normal submission starts without awaiting extraction, cards cannot confirm while the Agent is running, confirm/reject resolves the card, and candidate cards never enter Hermes history.
- [ ] Run focused renderer tests and confirm RED.
- [ ] Start candidate extraction fire-and-forget after `sendToAgent` is launched, append local-only typed cards, disable mutation while loading, and route actions through preload.
- [ ] Re-run focused renderer tests and confirm GREEN.

### Task 5: Runtime provenance and self-evolution compatibility

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/tests/test_ephemeral_context_self_evolution.py`
- Modify only if the RED test proves a real defect: `/Users/zizimutou/Desktop/aera/aera-runtime/agent/*` or `/Users/zizimutou/Desktop/aera/aera-runtime/gateway/platforms/api_server.py`

- [ ] Write a behavior-level test with a unique sentinel proving `ephemeral_system_prompt` reaches the outbound model request but not persisted session messages or Background Review `messages_snapshot`.
- [ ] In the same test, prove the genuine user turn remains persisted, the Memory tool stays available, the normal memory-review trigger still fires, and an ordinary private memory write succeeds.
- [ ] Run through `scripts/run_tests.sh tests/test_ephemeral_context_self_evolution.py -q`. If existing behavior passes immediately, record it as an already-present Runtime contract rather than manufacturing production code; if it fails, implement only the narrow provenance repair and re-run RED/GREEN.
- [ ] Run existing Memory, background-review, Curator, skill-provenance, profile, API instruction, and prompt-cache compatibility tests.

### Task 6: Documentation and final gates

**Files:**

- Modify: `docs/multi-agent-memory-architecture.md`
- Modify: `lat.md/multi-agent-memory.md`
- Modify: `lat.md/chat-commands.md` when the chat behavior changes.

- [ ] Update implementation status without claiming unsupported semantic noninterference.
- [ ] Run focused Desktop tests, `npm run typecheck`, `npm run build`, Prettier check on touched files, and the existing Runtime compatibility gate.
- [ ] Run `lat check` and distinguish local validation from commit, push, deployment, and release.
