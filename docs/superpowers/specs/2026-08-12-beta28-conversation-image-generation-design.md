# Beta.28 Conversation Image Generation Design
## Purpose

Beta.28 makes image generation an ordinary Profile capability so a user can ask for an image in any conversation without configuring each session.

The existing Runtime `image_generate` tool and Desktop image rendering remain the execution and presentation paths. This change adds a first-class Profile configuration surface and a relay-compatible OpenAI Images endpoint without changing chat-model routing.

## Product Contract

- Image generation is enabled by default for ordinary Profile conversations, including existing and newly created conversations.
- The setting is Profile-scoped. Conversations do not persist their own copy of the image provider, endpoint, credential, model, quality, or aspect ratio.
- A user can explicitly disable image generation for a Profile. That decision applies to later turns in existing conversations and to new conversations.
- Natural-language requests such as "帮我生成一张图" use the existing `image_generate` tool. `/image` remains a deterministic shortcut.
- A signed Agent manifest or effective Agent policy that denies `image_generate` remains authoritative. Profile defaults never expand a signed Agent beyond its verified capability set.
- Enabling a tool is distinct from configuring a paid provider. If no usable provider is configured, the tool is unavailable and the UI gives a direct configuration path rather than allowing a doomed paid call.

## Configuration Ownership

The active Hermes Profile is authoritative for image-generation configuration. Non-secret settings live under `image_gen` in that Profile's `config.yaml`; the credential lives in the Profile-scoped secret provider using `IMAGE_GEN_OPENAI_API_KEY`.

```yaml
image_gen:
  enabled: true
  provider: openai
  model: gpt-image-1.5
  aspect_ratio: square
  openai:
    base_url: https://relay.example/v1
    model: gpt-image-1.5
    quality: medium
```

The independent credential and endpoint deliberately do not reuse or rewrite the Profile's chat model provider, base URL, API mode, or credential. The OpenAI image provider retains a compatibility fallback to `OPENAI_API_KEY` only when the dedicated image credential is absent.

`image_gen.enabled` defaults to true when absent. Explicit false wins. Runtime `agent.disabled_toolsets`, signed Agent manifests, and other verified policy restrictions run after this default and therefore retain final veto authority.

## Runtime Integration

The bundled `plugins/image_gen/openai` provider continues to own OpenAI-compatible generation and editing. It gains one resolver for:

1. dedicated `IMAGE_GEN_OPENAI_API_KEY`, then the legacy `OPENAI_API_KEY` fallback;
2. `image_gen.openai.base_url`, normalized to an absolute HTTP(S) URL;
3. a configured API model such as `gpt-image-1`, `gpt-image-1.5`, or `gpt-image-2`;
4. quality and aspect-ratio defaults.

The SDK client is constructed with `max_retries=0`. Hermes must not automatically repeat a paid image request after a timeout or upstream failure. Errors are mapped to bounded public messages; API keys, Authorization headers, raw bodies, and credential-bearing exception text are never returned or logged.

Model discovery uses the relay's OpenAI-compatible `GET /v1/models` endpoint and filters image-capable model IDs. Discovery is read-only. The explicit test-generation action issues one `POST /v1/images/generations` request and consumes one returned image; saving settings never generates an image.

## Desktop Integration

Settings -> Tools keeps the existing image-generation tool card and adds a focused configuration section when the card is enabled. The section contains:

- enabled toggle;
- OpenAI-compatible service mode;
- base URL;
- masked API key input that preserves an existing secret when left blank;
- model selection with discovery;
- quality selection;
- default aspect ratio;
- Save, Discover models, and Test generation commands.

Main owns filesystem, network, and secret access. Renderer uses a narrow typed preload API and never reads `.env`, `config.yaml`, or credentials directly. Public status exposes only `hasApiKey` and an optional masked-length hint, never the value.

Local mode supports configuration in Beta.28. SSH/remote mode remains read-only until the remote Runtime exposes an equivalent authenticated API; Desktop must not copy a local secret to another machine.

## Failure Behavior

- Invalid base URL or model input is rejected before persistence.
- A blank key during update preserves an existing credential; an explicit clear operation is separate.
- Model discovery has a bounded timeout and does not mutate configuration.
- Test generation requires an explicit click, sends exactly one paid request, and never retries.
- A failed save leaves the prior complete configuration usable. A failed test leaves the saved configuration intact.
- Returned errors use stable categories: `invalid_configuration`, `credential_required`, `request_timeout`, `network_unavailable`, `upstream_rejected`, `invalid_response`, and `write_failed`.
- Logs may contain the Profile ID, stage, response status, and safe host name. They must not contain API keys, Authorization headers, prompts, generated base64, or raw upstream bodies.

## Compatibility And Migration

No per-session schema migration is needed because sessions do not own this state. Existing Profiles without `image_gen.enabled` inherit true. Existing explicit `platform_toolsets.cli` selections remain respected; Desktop writes a complete implicit-default selection on first toggle so enabling or disabling one card does not accidentally remove `image_gen` or unrelated defaults.

Existing OpenAI image setups using `OPENAI_API_KEY` and the current virtual GPT Image quality-tier IDs remain valid. Dedicated image settings take precedence only when present.

## Isolation And Release Boundary

Desktop work is isolated on `aera/beta28-image-generation`; Runtime work is isolated on `aera/beta28-image-generation-runtime`. Neither branch enters or modifies the active model-routing or content-delivery worktrees.

The result is delivered as two independent Beta.28 commits. It is not merged, pushed, deployed, or described as released while the other Beta.28 content-delivery task is active.

## Acceptance

1. A Profile with no prior image setting reports image generation enabled.
2. Existing and new ordinary conversations expose `image_generate` when a provider is usable.
3. Explicit Profile disable removes the tool from subsequent turns.
4. A signed Agent denial still removes the tool even while the Profile default is enabled.
5. A dedicated relay endpoint and key reach the OpenAI Images API without changing chat-model files.
6. Saving configuration issues no image request; Test generation issues exactly one request and no retry.
7. The Desktop status and all errors remain secret-free.
8. Generated output renders through the existing preview, lightbox, and save flow.
9. Desktop and Runtime targeted suites, type checks, build, `lat check`, and isolated UI acceptance pass on the final heads.
