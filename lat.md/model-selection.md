# Session model override

The in-chat (bottom) model picker selects a model for the **current conversation only** — it never rewrites `config.yaml`, so the Settings global default is preserved (#688), and carries the full model identity so cross-provider switches route correctly.

The override is held in renderer state on each `<Chat>` run ([[src/renderer/src/screens/Chat/Chat.tsx]]), persisted by session id, and sent with every message; it is cleared when the conversation is cleared/reset and is absent on a fresh chat, so new conversations start on the global default. This is distinct from the persisted [[model-context]] default that non-chat surfaces read.

Settings → Models uses a different path: each service card in [[src/renderer/src/screens/Providers/ModelCenter.tsx#ModelCenter]] has a default-model selector that immediately calls `setModelConfig` with the full provider, model, and Base URL identity. Activating an existing model never replays a service-catalog upsert or depends on its cached revision. It changes the global default for future conversations without mutating an active chat's session override.

## Two-pane picker grouped by display brand

The bottom [[src/renderer/src/screens/Chat/ModelPicker.tsx]] dropdown is a two-pane layout: a left **provider rail** filters a right **flat model list**, with a top search box narrowing both.

The rail has an "All models" entry plus one row per brand (logo + model count); each list row shows the model title, a `Provider · model-id` subtitle, and a check on the active model. The currently-selected model is sorted **first** within whatever filter is shown (exact provider+model+baseUrl match, then same provider+model), leaving the rest of the list in its original order.

Models are grouped by **display brand**, not the raw stored provider, so OpenAI-compatible providers persisted as `custom` (Hermes One, Groq, DeepSeek, …) get their own rail entry instead of one generic "OpenAI Compatible / Local" bucket. [[src/renderer/src/screens/Chat/hooks/useModelConfig.ts#groupModelsByProvider]] derives each group's key/label from [[src/renderer/src/constants.ts#displayBrandFromConfig]], which reverse-maps a `custom` model's `baseUrl` to a brand id via `OPENAI_COMPATIBLE_BASE_URLS` (same reverse-map the [[provider-setup]] active-model picker uses). A `custom` endpoint not in the map stays under "OpenAI Compatible / Local".

The global model library is not itself proof that a named custom provider is still configured for the current Profile. Before grouping, [[src/renderer/src/screens/Chat/hooks/useModelConfig.ts#availableModelsForProfile]] intersects custom attachments with that Profile's live `providers.json` identities. Removed providers disappear on `onCustomProvidersChanged`; endpoint-preserving renames are canonicalized to the current name instead of resurrecting an obsolete `custom:<name>` route. Built-in provider entries are unaffected.

Crucially, each model row keeps its **effective** `provider`/`baseUrl` for selection — only the rail grouping/label is branded. Built-in rows retain their stored route; a named custom row is canonicalized to the current Profile provider identity described above. The rail brand filter is display-only React state; picking "All models" or a brand never rewrites config. The rail logo is the brand's [[src/renderer/src/components/common/BrandLogo.tsx]] (`matchTheme`), with a generic fallback for unknown brands.

A **Configure** button is pinned at the bottom of the provider rail (below the scrollable brand list), replacing the old free-text model input: it closes the picker and dispatches the `navigation:goto` window event (detail `"providers"`). [[src/renderer/src/screens/Layout/Layout.tsx]] keeps that event compatible but now opens **Settings → Providers**, the single surface for managing keys and the model library.

## Full identity, not just the model name

The override is a `SessionModelOverride` (`{provider, model, baseUrl}`), not a bare model string — because switching across providers must change routing, not only the `model` field.

## Installed-Agent route selection uses an owner catalog

An installed Agent's model picker reads the same Main-owned catalog as Providers, while the selected opaque route is revalidated before installation or repair.

The catalog selection carries `sourceProfileId`, `modelLibraryId`, and `catalogRevision`; renderer code never receives a credential reference or Profile path. A route saved on an active installed Profile remains visible beside account routes, and a Beta.26 pending operation is converted through a fresh catalog snapshot before another write. A stale revision produces localized retry guidance instead of “please configure a model.”

The picker builds it via [[src/renderer/src/screens/Chat/hooks/useModelConfig.ts#effectiveOverrideBaseUrl]], the same baseUrl rule `selectModel` applies (keep the URL only for `custom`/`ollama-cloud`; clear it for named providers that have a canonical base URL), so the session pick and a persisted save can't drift. It is threaded renderer → preload IPC → main `sendMessage` as `modelOverride`.

## Installed-Agent switch policy and immutable resume

Installed-Agent model changes use a Main-resolved route and a new immutable RuntimeBinding; an existing segment is validated and reused without route mutation.

### User-selected routes and legacy policy compatibility

[[src/main/agentera-agent-control/model-policy.ts#decideAgentModelRoute]] treats every verified historical policy mode as `user_select` at Desktop runtime.

Signed V1/V2/V3 fields remain parseable for byte and signature compatibility, but `fixed` and `allowlist` no longer filter installation, repair, resume, or switching. Owner, catalog, endpoint, credential, Runtime capability, and immutable-segment checks remain fail-closed.

### Candidate route versus current segment

[[src/main/agentera-agent-control/hermes-adapter.ts#AgenteraHermesAdapter#prepareInstalledTurnPlan]] freezes only a same-turn [[src/main/agentera-agent-control/owner-model-route-catalog.ts#ResolvedOwnerModelRoute]] for a candidate. An identical full route reuses the active Binding, while a different route keeps the old Binding immutable and targets the Main-derived segment key.

### Current full-route and legacy validation

A current full route must still resolve to the exact source Profile/model row and usable credential before resume.

Exact Beta.26 three-field routes skip unavailable source metadata checks; historical signed model fields do not become a runtime route lock.

### Manager thread adoption and candidate preparation

[[src/main/agentera-agent-control/manager.ts#AgenteraAgentControlManager#prepareConversationRuntime]] adopts the first verified binding, resolves opaque selections in Main, reuses an identical route, and leaves a different route `preparing`.

If durable candidate finalization fails, Main marks that candidate `failed`, preserves the prior active Segment, and permits a later retry.

### Send initialization failure boundary

A candidate must leave `preparing` when any pre-output send initialization fails.

[[src/main/ipc/agent-model-send.ts#runAgentModelSegmentPreflight]] emits the preparing event and fails the candidate when local Gateway startup or SSH tunnel preparation rejects. Execution-lease creation and synchronous transport setup use the same idempotent lifecycle fallback in [[src/main/ipc/register.ts#registerIpcHandlers]], so the old active Segment remains authoritative and the user can retry the switch.

### User-selected staged selection

[[src/renderer/src/screens/Chat/ModelPicker.tsx#ModelPicker]] uses the installed Agent catalog instead of ordinary model groups, keeps historical fixed/allowlist Agents selectable, disables only in-flight switches, and stages the opaque selection for the next send without writing an ordinary session override.

The picker keeps the current active model label until Main activates the candidate. It distinguishes “next message”, “preparing”, and “failed, current model retained” states; a failed candidate clears only the opaque pending selection and leaves the active route, Segment ordinal, transcript, and global model settings unchanged.

### Authoritative resume context

[[src/renderer/src/screens/Chat/Chat.tsx#Chat]] waits for Main's conversation context before restoring an ordinary session override and retains the last verified Agent route while a refresh is pending, preventing model-picker flicker or cross-path persistence.

### Main-acknowledged local marker

[[src/renderer/src/screens/Chat/chatMessages.ts#insertModelSwitchMarker]] inserts and deduplicates a renderer-only marker only after an `active` segment event. The marker is excluded from prompts and transcript export, while duplicate events cannot advance the visible ordinal twice.

### Cold resume projects the active segment

Session history presents one Agent thread even though each accepted model switch owns a separate immutable Hermes session.

[[src/main/agentera-agent-control/conversation-thread-session-projection.ts#projectSessionSummaries]] replaces activated segment rows with the active session summary and leaves ordinary sessions unchanged. Resuming any known segment first resolves the active session through Main, then [[src/renderer/src/screens/Chat/sessionHistory.ts#buildConversationThreadResume]] restores its history and local switch markers.

### Whole-thread cleanup

Deleting one projected Agent session expands to every attached Hermes segment before owner-scoped control metadata is removed.

[[src/main/ipc/conversation-session-deletion.ts#deleteConversationSessions]] preserves metadata when Hermes deletion fails or its local database is unavailable, and stops before boundary cleanup if thread cleanup conflicts.

### Dynamic Runtime route capability

Cross-provider and cross-endpoint Agent switches stay fail-closed until Runtime advertises the exact request-scoped route contract.

[[src/main/hermes.ts#supportsHermesAgentModelRoute]] requires `request_model_route` plus `/v1/chat/completions`; [[src/main/hermes.ts#buildAgentModelRequestBody]] adds the short-lived `aera_model_route` only for a Main-approved dynamic execution lease. Unsupported Runtime versions return `model_switch_runtime_route_unsupported` without replaying the prompt.

## Desktop-only persistence

The selected model/provider is saved in a desktop-owned table keyed by session id, without storing API keys.

[[src/main/session-model-override-store.ts]] holds `desktop_session_model_overrides` with `provider`, `model`, and `base_url` only. [[src/renderer/src/screens/Chat/Chat.tsx#Chat]] restores the saved value for a resumed session, applies it to the local picker with `persist:false`, and saves later changes once a gateway session id exists. Deleting a session removes the row through [[src/main/sessions.ts#deleteSessionRows]].

## Text-only legacy fallback routes via CLI

Text-only legacy turns can use the CLI fallback when a session override changes provider or base URL away from `config.yaml`.

The upstream desktop model applies the session switch on the active gateway session with `/model <model> --provider <provider>`, then attaches media and submits on that same session. Hermes Desktop's dashboard transport follows that path; [[src/main/hermes.ts#shouldForceCliForSessionOverride]] keeps the CLI escape hatch only for text-only legacy fallback, where it can pass `-m <model>` and `--provider` without dropping attachments. Same-provider model swaps stay on the gateway/API path, where the new `model` string is sufficient. Remote (SSH) mode has no local CLI transport, so it remains limited to the model string.

## Attachment turns stay on session transport

Attachment turns must not be forced through the CLI override fallback because the CLI path cannot carry multimodal input.

[[src/main/hermes.ts#sendMessageViaCli]] can inline text-file attachments but ignores images, while the gateway/API path preserves image parts and path refs through [[src/main/hermes.ts#buildUserContent]]. When a session override is active and the user sends attachments, [[src/main/hermes.ts#shouldForceCliForSessionOverride]] leaves the turn eligible for the dashboard/gateway or API transport instead of silently dropping media.
