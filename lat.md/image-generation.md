---
lat:
  require-code-mention: true
---

# Conversation image generation

Image generation is a Profile capability for ordinary conversations, with Desktop-owned relay configuration and Runtime-owned generation.

The active Profile owns the setting. A missing `image_gen.enabled` value means enabled, so existing and new conversations inherit the capability without session migration. An explicit Profile disable wins, and signed Agent or `agent.disabled_toolsets` policy remains a later final veto.

Desktop Main owns `config.yaml`, secret storage, network discovery, and the explicit test request. The Renderer receives only typed public status and never receives an existing API key. Image generation uses `IMAGE_GEN_OPENAI_API_KEY` first and keeps `OPENAI_API_KEY` only as a Runtime compatibility fallback.

A blank key may reuse the saved credential only while the normalized relay endpoint is unchanged. Changing the endpoint requires a newly supplied key, and a command-backed secret provider is read-only because Desktop cannot safely write back through an arbitrary credential command.

Desktop commits the YAML document through its atomic safe writer and rolls it back if the separate secret write fails. A successful save is followed by a Profile-scoped Runtime retirement and snapshot notification; other Profiles and their conversations are not restarted.

Saving settings performs no paid generation. Model discovery is read-only, while Test generation requires a second confirmation and makes one bounded request with no application retry. The Runtime provider also constructs the OpenAI-compatible SDK client with retries disabled.

An installed Agent turn freezes the verified policy's exact Runtime tool names into an immutable `allowed` and `denied` request policy. Runtime requires the `request_tool_policy` capability, computes `Profile tools ∩ allowed − denied`, applies the result to initial, Memory, Context Engine, MCP, and Tool Search schemas, then checks the same policy again immediately before execution.

Runtime image failures expose stable public categories only. SDK client construction, generation, editing, source-image loading, and caching failures must not copy raw provider bodies, credentials, signed URLs, filesystem paths, or exception text into tool results or logs.

After an image setting or image tool-card toggle is committed, Desktop retires the active Profile's old TUI Runtime and broadcasts a new Runtime snapshot. A cleanup failure cannot turn an already committed save into a false write failure; the next snapshot or session still reads the saved Profile state.

## Default conversation admission

An ordinary Profile without an explicit image setting keeps image generation enabled when Desktop materializes its first CLI toolset selection.

## Explicit Profile opt-out

Turning off the image tool persists `image_gen.enabled: false` and removes the capability from later Profile Runtime snapshots.

## Failed toggle reconciliation

If Main rejects a tool-card write, the Renderer rolls back its optimistic state and shows a localized failure instead of displaying a setting that was never persisted.

## Secret-free configuration

Desktop preserves a saved image credential when the replacement field is blank and never returns the credential through IPC status.

## Secret-free Desktop configuration

The isolated Desktop journey verifies that a saved relay key remains masked in the Renderer and is absent from every public IPC configuration result.

## One paid test request

The test command requires explicit confirmation, sends one generation request, and renders the returned fixture image without coupling Save to generation.

## Runtime snapshot refresh

A committed configuration change refreshes the target Profile Runtime, while cleanup failure remains a non-destructive degradation rather than a false persistence error.

## Remote boundary

Remote and SSH Profiles do not read or copy local image credentials until an authenticated remote configuration API exists.

## Responsive UI acceptance

The isolated Desktop journey verifies the Tools configuration at desktop and narrow viewport sizes, including no horizontal overflow before a user changes the Profile capability.
