# Provider setup

Provider and model configuration is an in-desktop choice rather than a startup requirement. Users may enter the main desktop without a model, then configure credentials and choose an active model from the Providers surface.

The legacy [[src/renderer/src/screens/Setup/Setup.tsx]] component still encapsulates the provider-card form and writes a chosen provider/base URL via `setModelConfig` plus any key via `setEnv`, but [[src/renderer/src/App.tsx#App]] no longer mounts it in the startup state machine.

The provider list is data-driven from `PROVIDERS.setup` in [[src/renderer/src/constants.ts]]. Each entry carries an `envKey`, `configProvider`, `baseUrl`, and `needsKey`; selecting a card drives which form fields show (API key, or the Local server/base-URL flow).

## Local gateway authentication is automatic

The local Runtime gateway credential is an internal desktop concern, not a model-provider setting, so ordinary users never need to create, paste, or understand `API_SERVER_KEY`.

Dashboard chat authenticates with its own ephemeral per-process session token and does not use `API_SERVER_KEY`. The legacy local Gateway calls [[src/main/config.ts#ensureLocalApiServerKey]] inside its Main Process spawn path, immediately before building the child environment; an env-backed profile receives a strong generated credential just in time and an existing credential is reused.

Automatic generation is refused in Remote and SSH modes because those connections own their authentication separately. A profile using `secrets.provider: command` is refreshed but never overwritten; if its provider cannot resolve the internal credential, Gateway spawn fails closed.

[[src/main/config-health.ts#runConfigHealthCheck]] therefore does not treat an absent internal Gateway credential as a model/chat connection failure. It still reports conflicting or non-canonical values, missing model-provider credentials, and other real configuration faults. [[src/renderer/src/components/ConfigHealthBanner.tsx#ConfigHealthBanner]] filters the obsolete `EMPTY_API_SERVER_KEY` code defensively for mixed-version/hot-reload transitions, so a successful Dashboard reply can never be accompanied by the false “local connection not ready” banner. The Renderer has no parallel credential-generation lifecycle.

[[src/main/config.ts#setEnvValue]] writes new and rewritten `.env` files with Unix mode `0600`, keeping both internal gateway credentials and model-provider credentials private to the current OS user.

## Hermes One is the first-priority provider

**Hermes One Inference** (`https://inference.hermesone.org/v1`) is Hermes One's own OpenAI-compatible gateway, listed **first** in `PROVIDERS.setup`, `PROVIDER_CARDS`, and the `SETTINGS_SECTIONS` "LLM Providers" items — so it leads the Add-provider picker.

It is not a canonical agent provider, so it routes through `custom` + `base_url` exactly like the `openai` card, with its key stored/host-derived as `HERMESONE_API_KEY` (`inference.hermesone.org` → `HERMESONE_API_KEY` in [[src/shared/url-key-map.ts]], and `hermesone` in `OPENAI_COMPAT_PROVIDERS`). It appears in `OPENAI_COMPATIBLE_BASE_URLS` so `displayProviderFromConfig` reverse-maps it back to the Hermes One card on reload, and its logo (`detectBrand` → `hermesone`, the `hermes-icon.svg` mark) shows in the grids. Users get a key from the console's Credits → API keys.

## Top grid mirrors the agent's native providers

The top provider grid shows only providers the upstream agent supports natively; generic OpenAI-compatible endpoints live in the Local presets instead.

The source of truth is `CANONICAL_PROVIDERS` in the bundled agent (`hermes-agent/hermes_cli/models.py`) — the registry of providers with first-class auth/base-URL handling (nous, openrouter, anthropic, openai-codex, openai-api, gemini, xai, xiaomi, ollama-cloud, deepseek, …). A card belongs in the top grid only if it maps to a canonical slug. `aimlapi` was removed from the grid because it has no canonical entry; it remains reachable as a **Local → Remote OpenAI-Compatible APIs** preset.

DashScope API-key traffic uses the agent's native `alibaba` provider. The agent itself aliases `qwen` (and `dashscope`, `aliyun`, `alibaba-cloud`) to `alibaba`; only `qwen-oauth` is the Qwen Portal OAuth provider. DashScope hosts resolve to `alibaba` and `DASHSCOPE_API_KEY`, and legacy configs that still say `provider: qwen` keep working: the install-gate env map covers every alias, and `displayProviderFromConfig` lands them on the DashScope card.

The reusable Setup picker supports mainland China and international DashScope endpoints. Both choices keep `provider: alibaba`; only `base_url` changes. That picker defaults to mainland China (`DEFAULT_DASHSCOPE_BASE_URL`) and writes `base_url` explicitly, but the **canonical registry** ([[src/main/provider-registry.ts]] `PROVIDER_BASE_URLS`) stays on the international endpoint because it mirrors the agent's own default and is what `setModelConfig` fills into an empty `base_url` — a CN value there would silently repoint existing international users. The Providers tab has no endpoint field anymore (the active model is picked from configured providers), so `confirmModelPick` preserves the current `base_url` when re-picking an `alibaba` model — dropping it to empty would let the canonical fill flip a mainland user to the intl endpoint.

## OpenAI-compatible endpoints route through Local

Endpoints the agent does not natively support (Groq, DeepSeek, Together, Fireworks, Cerebras, AtlasCloud, Mistral, AIML, …) are offered as `LOCAL_PRESETS` chips under the `local` card, not as top-level cards.

Selecting a preset sets the base URL; the API-key env var is resolved by `resolveCustomEnvKey` — first an exact `LOCAL_PRESETS.envKey` match, then [[src/shared/url-key-map.ts]] by host. So a compatible provider configures correctly without a dedicated card (e.g. `api.aimlapi.com` → `AIMLAPI_API_KEY`).

## Active model is picked from configured providers

The Providers tab ([[src/renderer/src/screens/Providers/Providers.tsx]]) sets the default (active) model by choosing from what's already configured, not by free-form entry — there's no more provider chip grid, manual model/base-URL fields, or inline API-key input.

The Settings surface is organized as **General models**, **Auxiliary models**, and **Advanced**. General models renders [[src/renderer/src/screens/Providers/ModelCenter.tsx#ModelCenter]], Auxiliary models renders [[src/renderer/src/components/AuxiliaryTasksSection.tsx]], and Advanced preserves OAuth, credential-pool, and lower-level provider controls. A **Browse Registry** button opens [[src/renderer/src/components/RegistryBrowserModal.tsx]] to add curated models. Registry identity remains provider + endpoint + model id, matching [[src/main/models.ts#addModel]]'s dedup.

The General models path is intentionally beginner-facing. **Add model** opens one preset/custom dialog: presets fill Provider, Base URL, credential slot, and API protocol; custom mode exposes name, endpoint, optional context length, and API mode. The **Fetch** control sits beside the default-model field, calls `discoverProviderModels`, and keeps manual model entry available when a service has no catalog endpoint. An empty or unsupported catalog is a discovery limitation, not a failed configuration: the neutral hint asks the user to check Base URL or enter a model ID, while connection and credential failures remain errors.

Discovery succeeds only for a valid 2xx model catalog. Authentication, permission, endpoint, rate-limit, upstream, malformed-response, timeout, and network failures remain distinct; failed responses never populate the model cache or expose response bodies.

The editor reports locally saved models separately from the current service fetch, so an old local list cannot make a failed live request look successful. Coordinated save rejection text follows the stable startup code or failed transaction stage and includes only an opaque diagnostic id; ambiguous route-directory recovery keeps its own repair-required code.

A successful fetch while editing clears that service card's previous connection error before save. The dialog reports the live count independently, and coordinated save persists the complete deduplicated returned catalog together with the chosen default model.

[[src/main/model-discovery.ts#discoverProviderModels]] resolves the effective override/profile API key before consulting its in-memory cache. Model catalogs and their advertised context-window metadata share a cache scope made from provider, normalized endpoint, and a domain-separated SHA-256 credential fingerprint; the raw key is never stored in or emitted by the cache. Reusing the same key within the TTL avoids another request, while changing a key at the same endpoint forces a fresh authenticated discovery instead of returning the prior credential's catalog.

Saving the dialog stores the key in the provider-specific env slot and persists every returned model in `models.json`. For named custom providers, the coordinated Main mutation separates saving the provider catalog from changing the global default: a new secondary provider or an edit to an inactive provider uses `activate: false` and preserves the current route; an explicit **Set as default** action uses `activate: true`. Save-only verification requires both the unchanged active route and the newly persisted provider route, so a partial catalog write is rolled back rather than reported as committed. A provider with no existing default is activated on its first save. Preset providers retain the historical save-and-activate behavior. Petoi is a curated preset at `https://api.petoi.cn/v1` and always stores its credential in `PETOI_API_KEY`.

Each configured service renders as a detailed card rather than a one-line provider row. The card exposes only non-secret identity and model data: service name, preset/custom and current-default badges, Provider route, Base URL, model count, a real default-model selector, and model tags. Setting an already-saved model as default sends the stable custom-provider id through the coordinated activation path (or uses the legacy `setModelConfig` path for compatible/preset rows); it does not replay a stale catalog upsert. Refresh/edit remain the operations that persist service inventory, and editing a non-default named provider does not silently activate it. API keys never render on the saved card.

The **MODEL** section shows a read-only summary (logo + provider label + model). A **Change** button opens a picker modal with a **provider** picker (a custom `LogoSelect` — the brand logo renders inside the control and each option, which a native `<select>` can't do) and a native **model** dropdown. Confirming persists immediately through `setModelConfig`, then reads `getModelConfig` back so Main's canonical provider route is the single state returned to the Renderer. The **API key is resolved automatically** at runtime — the picker never asks for it.

The provider list (`pickerProviders`) is sourced from the **configured providers** — the same set shown as LLM cards — NOT from which providers happen to have saved models: keyed FieldDef providers (`env[f.key]` set, in FieldDef order so Hermes One leads) plus named custom providers whose `customProviderEnvKey(label)` is set. So a freshly-keyed provider with no models yet still appears.

The **model** dropdown merges that provider's saved models with live discovery ([[src/renderer/src/hooks/useDiscoveredModels.ts#useDiscoveredModels]]) so a just-configured provider is immediately usable. On confirm, a discovered-only model is persisted via `addModel` first (so its key resolves and it reappears), and compat providers store `custom` + their `OPENAI_COMPATIBLE_BASE_URLS` base URL.

The debounced auto-save keeps a guard from the grid era that still applies: `saveModelConfig` skips persisting a `custom` selection whose `base_url` is empty (writing it would clobber config.yaml with a dead endpoint) — **unless** config.yaml already holds a custom endpoint, tracked by the `persistedCustomUrl` ref (refreshed on load and after each save). In that case the empty value IS persisted, so deliberately clearing a configured custom endpoint doesn't leave the UI (empty) and config.yaml (old URL) disagreeing after navigation/relaunch.

### Coordinated activation suppresses legacy auto-save

After Model Center commits a coordinated mutation, its canonical route may update the parent form but must not replay through the older debounced `setModelConfig` writer.

The parent pauses that writer for the commit render and restores it on the next frame.

## LLM-provider keys are configured-only, via modals

The `SETTINGS_SECTIONS` "LLM Providers" section no longer renders a static key card for every known provider (an overwhelming wall of empty inputs). It shows only providers with a key set, plus an **Add provider** action.

[[src/renderer/src/components/ProviderKeysSection.tsx#ProviderKeysSection]] renders the configured cards + an Add tile; Add opens a searchable picker modal (logo per provider) → a per-provider config modal (key input with show/hide, **Remove provider**). It's a presentation layer over the same `env` state + `handleChange`/`handleBlur`/`handleRemove` handlers in [[src/renderer/src/screens/Providers/Providers.tsx]], so persistence is unchanged (`setEnv`); removing clears the env var.

The section is rendered **standalone, above the credential pool** rather than in the `SETTINGS_SECTIONS.map` position — it's the primary surface for configuring providers and the models the top active-model selector picks from, so it sits before the advanced multi-key pool. The map skips the `constants.sectionLlmProviders` entry (an inline title check returning null); other `SETTINGS_SECTIONS` (non-LLM) still render inline in place, after the pool.

### Named custom providers

The picker offers a **Custom provider** tile (last) for any OpenAI-compatible endpoint not covered by a built-in card. You can add **multiple**, each with a distinct name, base URL, and its own key.

A custom provider's **identity** is a stable UUID-backed record in the desktop's per-profile store [[src/main/providers-store.ts]] (`providers.json`, plaintext — it holds no secrets, only id, name, and base URL). Name and Base URL are editable attributes rather than the record key. Its **key** still lives in the profile `.env` and its **models** in `models.json`; the store is _additive_ so a provider renders as a card the moment it is saved, independent of whether any model has been added. This fixed the prior gap where a keyed-but-modelless provider was invisible.

That named identity also wins when its Base URL happens to equal a curated preset. The General models card keeps the custom name, `CUSTOM_PROVIDER_*` credential anchor, model attachments, edit flow, and delete scope; it must not silently reinterpret the record as the preset or ask for the preset's different env key after relaunch.

The config modal collects **Name**, **Base URL**, and an API key. On an edit, Renderer carries the original provider UUID through the coordinated mutation; [[src/main/providers-store.ts#upsertCustomProvider]] updates that exact record and rejects a new name whose derived env-key anchor belongs to another provider. New records still deduplicate by that anchor. The editor also selects its model by that UUID-backed identity, not by endpoint equality, so two providers sharing one endpoint still edit their own model inventory. The key is stored under the provider's dedicated env var, [[src/shared/url-key-map.ts#customProviderEnvKey]]`(name)` → `CUSTOM_PROVIDER_<SANITISED_NAME>_KEY` — so two custom providers never share a key.

A rename or endpoint change is one rollback-protected mutation: Main moves or replaces the credential, updates the same provider record, migrates its model attachments through [[src/main/models.ts#migrateModelsForCustomProvider]], removes the previous native provider entry, and activates the new `custom:<name>` route. Each current model attachment carries `providerId` plus the display `providerLabel`; stable id wins, while legacy rows continue to match by old label and endpoint. Two stable ids retain separate attachments even when endpoint and model id are identical; only a legacy row with the same provider-name anchor is absorbed during migration.

Configured custom-provider cards are the **union** of three sources, deduped by env-key anchor (in [[src/renderer/src/components/ProviderKeysSection.tsx#ProviderKeysSection]]): (1) the authoritative `providers.json` records via `listCustomProviders`; (2) back-compat — `provider: "custom"` models in `models.json` whose host resolves to `CUSTOM_API_KEY` (known compat hosts like groq/hermesone are excluded — they own dedicated key cards), grouped by `providerLabel`; (3) **orphan recovery** — any `CUSTOM_PROVIDER_*_KEY` env var with a value but no record/model, surfaced with an empty base URL so the user can complete or remove it. The active-model picker in [[src/renderer/src/screens/Providers/Providers.tsx]] unions (1) with the models-derived labels too, so a keyed custom provider is selectable before a model is saved; it prefers the authoritative `providers.json` base URL over a saved model's URL, so editing an existing provider's endpoint reroutes newly picked models instead of pinning them to the stale URL (a saved model's URL is used only for legacy/orphan records whose stored base URL is blank). **Remove provider** deletes only attachments with the provider's stable id (plus its scoped legacy rows), drops its `providers.json` record (`removeCustomProvider`), and clears its `CUSTOM_PROVIDER_*` key. For a named active route, [[src/main/model-configuration-runtime.ts#isActiveProviderRoute]] and [[src/renderer/src/screens/Providers/ModelCenter.tsx#ModelCenter]] compare the normalized name and never treat another named provider as active merely because the two share a Base URL and model; endpoint fallback is reserved for the legacy bare `custom` route.

When a named custom model is activated, [[src/main/native-custom-provider.ts#upsertNativeCustomProvider]] projects the desktop identity into Hermes Agent's native `providers:` schema: `api`, `key_env`, transport, default model, and model inventory live under one normalized provider name, while `model.provider` becomes the durable `custom:<name>` route. The secret remains only in `.env` under `CUSTOM_PROVIDER_<SANITISED_NAME>_KEY`; native config stores the `key_env` reference, never the key. `providers.json` and `models.json` remain UI identity/catalog stores rather than a second runtime router. [[src/shared/custom-providers.ts]] owns normalization and named-route recognition for Main and Renderer so the two sides cannot invent different custom-provider identities.

Legacy compatible presets without a named provider record still use the existing bare `custom` + host-derived credential path. Named records do not: [[src/main/ipc/register.ts#resolveLibraryModelEntry]] matches `custom:<name>` back to the saved model by provider label and Base URL, preserving that endpoint's `api_mode` while the Runtime resolves the declared `key_env`.

Every activation surface—including General service cards, the configured-provider picker, and the Chat picker—writes through Main and reads the resulting config back rather than reconstructing `custom:<name>` independently. `models.json` keeps its UI attachment shape (`provider: custom`, `providerLabel`, endpoint); the Advanced editor normalizes a native named route back to that attachment shape before its best-effort library upsert, preventing duplicate raw-custom and named-route rows.

Dashboard and Gateway processes snapshot configuration and environment variables when they start. Changing a runtime credential — including `CUSTOM_PROVIDER_*_KEY` — or activating a different route retires the local Dashboard before the IPC call returns; the chat transport launches it lazily with the new snapshot. A running legacy Gateway is restarted through its existing lifecycle. This prevents model discovery (which verifies the form key directly) from succeeding while chat keeps using a stale process-level key and reports a false 401.

Main also emits the payload-free `runtime-snapshot-changed` lifecycle event after such a retirement. It is deliberately separate from `connection-config-changed`: guest chats can close a stale local WebSocket without receiving account-owned Remote/SSH configuration. [[src/renderer/src/screens/Chat/Chat.tsx#Chat]] advances a Runtime connection revision, and [[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#useDashboardChatTransport]] closes the old client plus invalidates only process-local runtime ids. The durable stored conversation id is preserved, so the next send reconnects through Hermes' native `session.resume` rather than creating another sidebar chat.

Dashboard shutdown reuses [[src/main/process-tree.ts#killProcessTree]], the same cross-platform process-tree lifecycle used by Claw3D. POSIX Dashboard children launch in their own process group and receive TERM followed by a bounded KILL fallback; Windows uses `taskkill /T /F`. Provider-error workers therefore cannot retain an old credential snapshot or remain orphaned after the desktop has switched to a fresh Dashboard.

### Adding a curated partner provider

Sponsor/partner providers (and Hermes One itself) are OpenAI-compatible custom endpoints under the hood but are presented **first-class** — curated in-app, exactly like `hermesone`, with their own host-derived key and branding.

To add one, mirror the Hermes One entries: a card in `PROVIDERS.setup` + `PROVIDER_CARDS` + a base URL in `OPENAI_COMPATIBLE_BASE_URLS` ([[src/renderer/src/constants.ts]]), a `URL_KEY_MAP` entry giving it a dedicated `<PARTNER>_API_KEY` in [[src/shared/url-key-map.ts]], and a `detectBrand` rule + logo in [[src/renderer/src/components/common/BrandLogo.tsx]].

## Models live under each provider (OpenCode-style)

Models stay grouped under the service that owns their route, endpoint, and credential. The General models screen presents this hierarchy as detailed service cards.

The beginner-facing [[src/renderer/src/screens/Providers/ModelCenter.tsx#ModelCenter]] owns common setup and default selection. The Advanced provider modal retains lower-level per-model editing for display name, context window, and removal.

[[src/renderer/src/components/ProviderKeysSection.tsx#ProviderModelsManager]] renders below the key field in the config modal: a key-status line, the model pills, and an add-input. It reads/writes the same `models.json` library the chat picker reads (`listModels`/`addModel`/`removeModel`, and re-syncs on `onModelLibraryChanged`), so added models immediately appear in the chat model picker. Models show as chips with a remove button and a **pencil** that opens a small editor for the model's shared definition (display name + context window — see [[model-context]]); because the definition is keyed by model id, editing it under one provider reflects under every provider serving that id. The add-input autocompletes off live discovery and strips whitespace as typed/pasted (model IDs never contain spaces, so `"hello there"` can't be saved).

The single [[src/renderer/src/hooks/useDiscoveredModels.ts#useDiscoveredModels]] call does double duty: it feeds the add-input's `<datalist>` **and** drives the "Connected · key verified" status line — a `status: "ok"` means the endpoint accepted the key and returned a model list, so the "verified" claim is truthful. `unsupported`/`unknown-host` degrade to a plain "Connected" (key set, list not exposed), `error` to "Couldn't verify key", and an empty key to "Add a key to connect".

The env key is the only anchor the modal has, so persistence routing is derived from it by [[src/renderer/src/constants.ts#providerRouteForEnvKey]]: it scans `PROVIDERS.setup` (returning `{provider: configProvider ?? id, baseUrl}`) then `LOCAL_PRESETS` (always `custom` + `baseUrl`), falling back to a bare `custom` route. Native providers keep their agent slug (the gateway hardcodes the base URL); OpenAI-compatible providers save as `provider: "custom"` + explicit `baseUrl` — the same routing the Providers tab's active-model picker applies, so entries stay consistent regardless of where they were added.

## Owner-scoped model route catalog

Main exposes one credential-free route catalog to Model Center, Agent installation, and installed-Agent chat so those surfaces cannot select different Profile sets.

[[src/main/agentera-agent-control/owner-model-route-catalog.ts#OwnerModelRouteCatalog]] orders same-owner account and installed Profiles, deduplicates by provider/model/endpoint/API-mode identity, and stamps every selection with a catalog revision. [[src/main/agentera-agent-control/manager.ts#resolveInstallationModelSelection]] resolves that opaque handle again before any Profile write; stale, foreign, unavailable, or credentialless routes fail closed. Beta.26 two-field journal rows are parsed only by [[src/main/agentera-agent-control/installation-operation-store.ts#parseBeta26PersistedRuntimeModelSelection]] during recovery migration.

DashScope is a native provider rather than a compatible/custom endpoint, but it follows the same inline editing pattern: the endpoint selector writes either `dashscope.aliyuncs.com` or `dashscope-intl.aliyuncs.com` to `base_url`, and the key field writes `DASHSCOPE_API_KEY`.

Ids the agent can't resolve by id are listed in `OPENAI_COMPATIBLE_BASE_URLS` ([[src/renderer/src/constants.ts]]) — openai, perplexity, and every `LOCAL_PRESETS` chip (local servers + remote endpoints like groq, deepseek, atlascloud, mistral, …). This map MUST contain every preset id, or selecting that chip mis-routes; a test in `tests/constants.test.ts` enforces it. Selecting one autofills its base URL and shows the base-URL field; on save it is persisted as `provider: custom` + `base_url`, which the gateway accepts and uses to host-derive the API key (`runtime_provider._host_derived_api_key`, e.g. `api.groq.com` → `GROQ_API_KEY`). `displayProviderFromConfig` reverse-maps a stored `custom` + known base URL back to the brand id so the dropdown re-selects it on load. Native providers (the gateway hardcodes their base URL) clear the field instead.

## Switching providers rewrites the transport (`api_mode`)

Activating a model must rewrite or clear `model.api_mode`, or a stale protocol from the previous model routes the new endpoint over the wrong transport — dropping connections when switching OpenAI- and Anthropic-compatible custom endpoints.

The gateway's runtime-provider resolver honors a persisted `model.api_mode` (`anthropic_messages` vs `chat_completions`, …) for `custom`/compatible providers, and only auto-detects from the base URL (`/anthropic` suffix, `api.openai.com`, …) when the key is absent. So a leftover `anthropic_messages` would keep an OpenAI-compatible endpoint pointed at `/v1/messages` (404 / lost connection).

[[src/main/config.ts#setModelConfig]] takes an optional `apiMode` argument, handled exactly like `context_length`: a non-empty string sets `model.api_mode`, `null`/empty removes it (so auto-detection resumes), `undefined` leaves it untouched. The `set-model-config` IPC handler ([[src/main/ipc/register.ts]]) resolves it from the activated model's `apiMode` library field ([[src/main/models.ts#SavedModel]]) — `null` when the entry has none — alongside the `contextLength` mirror, on both the pure-local and remote-fallback local writes. Custom-provider library entries carry `apiMode` because `loadCustomProviders` reads `api_mode` from each `custom_providers:` block.

The library lookup runs through [[src/main/ipc/register.ts#resolveLibraryModelEntry]], which disambiguates by base URL when several entries share the same provider+model — e.g. two `custom` endpoints exposing the same model id over different transports. A bare provider+model match would return the first entry and persist its `api_mode` for the other endpoint, routing it over the wrong protocol; matching the base URL too keeps each endpoint's transport correct. Single-entry activations are unaffected.

## Provider icons

Each card's logo is resolved by [[src/renderer/src/components/common/BrandLogo.tsx]] from the provider id, falling back to a generic robot for unknown ids.

`detectBrand` matches the provider/model string to a `BrandKey`, and `matchTheme` flattens every logo to a single white/black tint so colored and `currentColor` SVGs render uniformly in the grid's logo tiles.

The Local/Remote preset chips are also branded: each renders the same `BrandLogo` (by preset id) to the left of its name in a row. `llama.cpp` is mapped off the Meta logo to the generic API mark (the `/llama/` substring would otherwise tag it, and Ollama, as Meta); any preset without a bundled logo falls back to the generic mark.
