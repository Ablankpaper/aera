# Multi-Agent identity and global behavior profile

Aera separates each Agent's writable Hermes state from one account-wide behavior profile, so Agents evolve independently while sharing only user-approved, stable behavior context.

## Ownership layers

The architecture has three different owners and does not merge their files or write paths.

- One local Agent Profile owns its `SOUL.md`, `memories/MEMORY.md`, `memories/USER.md`, sessions, Skills, credentials, Curator state, and other Hermes files.
- Aera owns one account-partitioned global behavior profile outside every `HERMES_HOME`.
- The renderer receives profile entries for settings UI, but conversation injection bytes and hashes remain in the main process.

Hermes remains the sole writer for private adaptive Memory and USER learning. The global-profile manager never registers as a Hermes MemoryProvider and never rewrites a private Hermes learning file.

## Agent identity

An Agent name is arbitrary user data scoped to one Profile, not a keyword-classification rule or an account-wide user fact.

[[src/main/agent-identity.ts#AgentIdentityService#setDisplayName]] atomically updates `profile-meta.json`, a managed identity block in `SOUL.md`, revision metadata, and a private undo backup. Existing persona text outside the managed block is preserved.

Each explicit rename increments an identity revision. [[src/main/agent-identity.ts#AgentIdentityService#scopeConversationKey]] scopes later conversation bindings to that revision, while stale Hermes sessions are rejected and the visible renderer transcript remains mounted.

Both Profile UI rename and `/agent name <arbitrary name>` use this same service. Examples used by requirements or tests do not create production constants, special cases, or matching branches.

## Private user understanding

Hermes `memories/USER.md` means the current Agent's private understanding of the user, not the account-wide global profile.

The Memory UI labels this scope explicitly. A user-requested repair uses preview, exact editable replacement, confirmation, a content hash, a private backup, and guarded undo; it never automatically classifies text or migrates identity text into `SOUL.md`. Renderer coverage waits for the confirmation state update before applying the exact reviewed replacement, so the contract is stable across slower CI event loops.

## Account-wide behavior profile

The Aera-owned profile contains only allowlisted, confirmed behavior entries and is partitioned by the authenticated account below Electron `userData`.

[[src/main/agentera-global-profile/manager.ts#AgenteraGlobalProfileManager]] versions explicit entries, keeps history and audit data, enforces length and category limits, rejects credentials and prompt-control text, and supports rollback as a new version.

The settings page and `/global show|set|remove|history|rollback` are explicit local controls. Command text, values, and output are renderer-local artifacts and are excluded from later Hermes transcript history.

Natural-language chat never writes identity or the account profile directly. [[src/renderer/src/screens/Chat/hooks/useMemoryCandidates.ts#useMemoryCandidates]] starts local candidate extraction only after Hermes submission has started, stores cards in a renderer-only overlay, and binds each result to that submission's `turnId`. A card appears only after the matching non-error assistant reply completes a busy-to-idle cycle; failed turns and Profile switches discard it.

## Natural-language confirmation loop

One explicit sentence can propose both a current-Agent name and an account-wide user address, but neither mutation occurs until the user confirms the combined card.

The deterministic classifier reads only the visible submitted text and persists bounded proposals without raw transcript fields under the authenticated account. [[src/main/agentera-global-profile/candidate-confirmation.ts#AgenteraMemoryCandidateConfirmationCoordinator#confirm]] rechecks that every proposal belongs to the current Profile, then routes identity to the Profile-scoped identity service and the address to the account profile. A partial failure restores the exact pre-confirmation file bytes and leaves the batch pending.

Candidate recognition is fire-and-forget: Hermes dispatch happens first, recognition is never awaited, and extraction errors are ignored by the chat path. Renderer-only candidate messages are merged into `visibleMessages` for display but never into the core chat history, so cards are absent from Hermes input, persisted sessions, transcript export, and Background Review.

## Conversation snapshot and transport

Every new conversation freezes one rendered global-profile snapshot before model transport is selected.

[[src/main/agentera-global-profile/manager.ts#AgenteraGlobalProfileManager#prepareConversationSnapshot]] persists the rendered bytes, profile version, and SHA-256 under the account partition. Updating or clearing the account profile never changes an already prepared conversation.

Renderer `runId` is only stable while a tab is mounted. After Hermes creates a durable session, [[src/main/agentera-global-profile/manager.ts#AgenteraGlobalProfileManager#bindConversationSnapshotToSession]] binds the same snapshot bytes to the Profile and Hermes session; reopening history under a new `runId` restores that binding.

A legacy session with no prior binding is fixed to an empty snapshot instead of receiving a new profile in the middle of its history. Corrupt or unreadable Aera profile state degrades to native Hermes chat and does not block the conversation.

The durable binding is scoped by account, Agent Profile, and Hermes session. Regression tests in [[src/main/agentera-global-profile/manager.test.ts]] and [[tests/agentera-global-profile-runtime-binding.test.ts]] also prove that a corrupt alias degrades without exposing snapshot bytes, a conflicting rebind cannot overwrite the original alias, and Workspace's protected RuntimeBinding test remains unchanged.

[[src/main/agentera-global-profile/manager.ts#composeGlobalProfileEnvelope]] appends the read-only block after an existing Official Agent envelope and never overwrites signed instructions. Installed Agents, renamed Agents, and any non-empty global snapshot force the bound API path so Dashboard transport cannot bypass the required envelope or identity revision.

The renderer prepares this decision once per identity-scoped conversation. Account-profile change notifications update settings UI but do not toggle the active conversation's transport; an explicit Agent rename creates a new identity-scoped context immediately.

## Self-evolution boundary

Global behavior context is additive and does not replace Hermes self-evolution.

Hermes continues updating the current Profile's private `MEMORY.md`, `USER.md`, learned Skills, and Curator state. Runtime provenance tests prove the injected block reaches the outbound request but not persisted transcript or Background Review input, while ordinary private writes and review triggers continue. A real isolated UI run also observed Hermes independently updating private `USER.md` before the Aera confirmation card appeared. Runtime production code is unchanged.

This proves system-level non-persistence, not impossible semantic noninterference: a model that has read the profile can still choose to restate a fact through an ordinary Hermes tool. Blocking all such writes would intercept Hermes learning and violate this architecture. Profile cloning, cross-device backup, broader behavioral inference, and automatic promotion remain separate governed flows.
