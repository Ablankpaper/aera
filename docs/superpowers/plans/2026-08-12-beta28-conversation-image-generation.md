# Beta.28 Conversation Image Generation Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing `image_generate` capability available by default in every ordinary Profile conversation and give users a secure Desktop UI for an independent OpenAI-compatible image relay.

**Architecture:** Runtime owns provider resolution and paid image calls; Desktop Main owns Profile configuration, secrets, discovery, and test transport. Renderer consumes typed, secret-free IPC status. All conversations resolve the current Profile setting rather than storing session copies, while signed Agent policy keeps final veto authority.

**Tech Stack:** Python, OpenAI Python SDK, pytest, Electron, TypeScript, React, YAML, Vitest, Testing Library, Playwright, lat.md.

---

## File Map

- Modify Runtime `plugins/image_gen/openai/__init__.py`: dedicated key/base URL/model/quality resolution, explicit SDK client construction, error redaction, and zero retries.
- Modify Runtime `tests/plugins/image_gen/test_openai_provider.py`: relay configuration, legacy fallback, generation/editing, redaction, and retry tests.
- Modify Runtime `hermes_cli/tools_config.py` and `tests/hermes_cli/test_tools_config.py`: Profile default-enable resolution with explicit disable and final policy veto.
- Modify Runtime `hermes_cli/config.py`, `cli-config.yaml.example`, and image-generation docs: recognize and document the dedicated credential and endpoint.
- Create Desktop `src/shared/image-generation.ts`: secret-free public config and result contracts.
- Create Desktop `src/main/image-generation-config.ts` and test: typed Profile reads/writes, validation, masked status, model discovery, and one-shot test generation.
- Modify Desktop `src/main/tools.ts` and `tests/toolset-toggle.test.ts`: preserve implicit defaults on first toolset write and honor `image_gen.enabled`.
- Modify Desktop `src/main/ipc/register.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`, and static IPC tests: narrow typed bridge.
- Create Desktop `src/renderer/src/screens/Tools/ImageGenerationConfig.tsx` and test: focused form, secret preservation, discovery, save, and paid-test confirmation state.
- Modify Desktop `src/renderer/src/screens/Tools/Tools.tsx`, tool locales, and `main.css`: integrate the responsive configuration surface.
- Create or modify `lat.md/image-generation.md`: Profile inheritance, secret boundary, paid-call boundary, and tests.

### Task 1: Runtime Relay Configuration

**Files:**

- Modify: `plugins/image_gen/openai/__init__.py`
- Test: `tests/plugins/image_gen/test_openai_provider.py`

- [ ] **Step 1: Write failing resolver and client tests**

Add tests proving dedicated settings take precedence and the SDK receives an explicit relay URL with retries disabled:

```python
def test_dedicated_relay_configuration_builds_zero_retry_client(tmp_path, monkeypatch):
    (tmp_path / "config.yaml").write_text(
        "image_gen:\n  provider: openai\n  openai:\n"
        "    base_url: https://relay.example/v1\n"
        "    model: gpt-image-1.5\n    quality: high\n"
    )
    monkeypatch.setenv("IMAGE_GEN_OPENAI_API_KEY", "image-secret")
    monkeypatch.setenv("OPENAI_API_KEY", "chat-secret")
    fake_openai = MagicMock()
    fake_openai.OpenAI.return_value.images.generate.return_value = _fake_response(
        b64=_b64_png()
    )
    with patch.dict("sys.modules", {"openai": fake_openai}):
        result = openai_plugin.OpenAIImageGenProvider().generate("a red square")
    assert result["success"] is True
    fake_openai.OpenAI.assert_called_once_with(
        api_key="image-secret",
        base_url="https://relay.example/v1",
        max_retries=0,
    )
    assert fake_openai.OpenAI.return_value.images.generate.call_args.kwargs["model"] == "gpt-image-1.5"
```

Add separate tests for legacy key fallback, malformed URL, empty credential, editing through the relay, exception redaction, and one SDK call on failure.

- [ ] **Step 2: Run and verify RED**

Run: `.venv/bin/pytest -q tests/plugins/image_gen/test_openai_provider.py`

Expected: new tests fail because dedicated configuration and zero-retry client construction do not exist.

- [ ] **Step 3: Implement the minimal resolver**

Add an immutable resolved-settings value with validated `http`/`https` URL, dedicated-key precedence, configured API model, quality, and compatibility tier mapping. Construct `openai.OpenAI(api_key=..., base_url=..., max_retries=0)` and pass the resolved API model/quality to generate and edit.

Sanitize exceptions to a stable public category; never interpolate the raw exception if it contains request headers, URLs with credentials, or key material.

- [ ] **Step 4: Verify GREEN**

Run: `.venv/bin/pytest -q tests/plugins/image_gen/test_openai_provider.py tests/tools/test_image_generation_plugin_dispatch.py tests/tools/test_image_generation_image_to_image.py`

Expected: PASS with no credential text in output.

### Task 2: Runtime Profile Default

**Files:**

- Modify: `hermes_cli/tools_config.py`
- Test: `tests/hermes_cli/test_tools_config.py`

- [ ] **Step 1: Write failing default/override tests**

```python
def test_image_generation_defaults_on_for_explicit_cli_toolsets():
    enabled = _get_platform_tools(
        {"platform_toolsets": {"cli": ["web"]}}, "cli"
    )
    assert "image_gen" in enabled

def test_image_generation_explicit_disable_and_agent_veto_win():
    assert "image_gen" not in _get_platform_tools(
        {"image_gen": {"enabled": False}}, "cli"
    )
    assert "image_gen" not in _get_platform_tools(
        {"image_gen": {"enabled": True},
         "agent": {"disabled_toolsets": ["image_gen"]}}, "cli"
    )
```

- [ ] **Step 2: Run and verify RED**

Run: `.venv/bin/pytest -q tests/hermes_cli/test_tools_config.py -k image_generation`

Expected: explicit CLI list test fails because direct membership currently omits `image_gen`.

- [ ] **Step 3: Implement Profile default resolution**

Before the final `agent.disabled_toolsets` subtraction, add `image_gen` for eligible conversation platforms when `image_gen.enabled` is absent or true. Remove it when explicitly false. Do not change signed Agent manifest enforcement; it remains outside and after general Profile admission.

- [ ] **Step 4: Verify GREEN**

Run: `.venv/bin/pytest -q tests/hermes_cli/test_tools_config.py tests/tools/test_image_generation_plugin_dispatch.py`

Expected: PASS.

### Task 3: Desktop Secret-Free Configuration Boundary

**Files:**

- Create: `src/shared/image-generation.ts`
- Create: `src/main/image-generation-config.ts`
- Create: `src/main/image-generation-config.test.ts`

- [ ] **Step 1: Write failing Main-boundary tests**

Test these behaviors with a temporary Profile:

```ts
it("returns secret-free Profile status and preserves a blank replacement key", async () => {
  const saved = await service.save("work", {
    enabled: true,
    baseUrl: "https://relay.example/v1",
    apiKey: "fixture-secret",
    model: "gpt-image-1.5",
    quality: "medium",
    aspectRatio: "square",
  });
  expect(saved.status).toBe("configured");
  expect(JSON.stringify(saved)).not.toContain("fixture-secret");
  await service.save("work", { ...request, apiKey: "" });
  expect(readEnv("work").IMAGE_GEN_OPENAI_API_KEY).toBe("fixture-secret");
});

it("discovers without mutation and test generation sends exactly once", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(modelsResponse(["gpt-image-1.5", "chat-model"]))
    .mockResolvedValueOnce(imageResponse(FIXTURE_B64));
  expect(await service.discover("work", draft)).toEqual(["gpt-image-1.5"]);
  expect(await service.testGeneration("work", draft)).toMatchObject({ success: true });
  expect(fetch).toHaveBeenCalledTimes(2);
});
```

Also test invalid URL/model, timeout, upstream rejection, malformed response, no prompt/base64 leakage, and save without any fetch.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/image-generation-config.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement contracts and Main service**

Public contracts expose booleans, safe enums, model IDs, base URL, and error codes only. Use the existing Profile path, `setEnvValue`, `getSecret`, YAML parser, and atomic writer. Network calls use a bounded `AbortController`; discovery is `GET /models`, test generation is one `POST /images/generations` with no application retry loop.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/main/image-generation-config.test.ts && npm run typecheck:node`

Expected: PASS.

### Task 4: Desktop Default Toolset Persistence

**Files:**

- Modify: `src/main/tools.ts`
- Modify: `tests/toolset-toggle.test.ts`

- [ ] **Step 1: Write failing regression tests**

```ts
it("keeps image generation enabled when the first unrelated tool toggle materializes cli", () => {
  writeConfig("model:\n  default: gpt-4o\n");
  setToolsetEnabled("web", false);
  expect(getToolsets().find((tool) => tool.key === "image_gen")?.enabled).toBe(true);
});

it("honors the Profile image generation disable", () => {
  writeConfig("image_gen:\n  enabled: false\n");
  expect(getToolsets().find((tool) => tool.key === "image_gen")?.enabled).toBe(false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run tests/toolset-toggle.test.ts`

Expected: first test fails because a missing CLI selection materializes from an empty set.

- [ ] **Step 3: Preserve implicit defaults**

When `platform_toolsets.cli` is missing, initialize the editable selection from the locally displayed implicit toolset defaults rather than an empty set. Overlay `image_gen.enabled` so explicit false stays false and default absence stays true.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/toolset-toggle.test.ts`

Expected: PASS.

### Task 5: Typed IPC And Configuration UI

**Files:**

- Modify: `src/main/ipc/register.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`
- Modify: `tests/preload-api-surface.test.ts`
- Create: `src/renderer/src/screens/Tools/ImageGenerationConfig.tsx`
- Create: `src/renderer/src/screens/Tools/ImageGenerationConfig.test.tsx`
- Modify: `src/renderer/src/screens/Tools/Tools.tsx`
- Modify: `src/renderer/src/assets/main.css`
- Modify: `src/shared/i18n/locales/en/tools.ts`
- Modify: `src/shared/i18n/locales/zh-CN/tools.ts`

- [ ] **Step 1: Write failing bridge and renderer tests**

Static surface tests require `getImageGenerationConfig`, `saveImageGenerationConfig`, `discoverImageGenerationModels`, and `testImageGeneration`. Renderer tests prove Profile routing, blank-key preservation, disabled state, model discovery, save-without-test, explicit paid test, and localized errors.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run tests/preload-api-surface.test.ts src/renderer/src/screens/Tools/ImageGenerationConfig.test.tsx`

Expected: FAIL because the API and component are absent.

- [ ] **Step 3: Add the narrow bridge**

Register local-only IPC handlers with typed request validation. SSH/remote requests return `remote_unsupported`; no handler returns an API key. Expose the exact four methods from preload.

- [ ] **Step 4: Build the focused Tools surface**

Render an un-nested configuration section under the image tool card. Use standard inputs, segmented/select controls, a masked password field, and icon-labelled commands. Keep stable responsive dimensions and do not auto-test on save.

- [ ] **Step 5: Verify GREEN**

Run: `npx vitest run tests/preload-api-surface.test.ts src/renderer/src/screens/Tools/ImageGenerationConfig.test.tsx tests/toolset-toggle.test.ts && npm run typecheck && npm run lint`

Expected: PASS.

### Task 6: Knowledge Graph And Acceptance

**Files:**

- Create: `lat.md/image-generation.md`
- Modify tests above with one `@lat` reference per leaf test specification.

- [ ] **Step 1: Document behavior and test specs**

Record Profile inheritance, explicit disable, signed policy veto, dedicated credential precedence, no-retry paid calls, secret-free IPC, and existing/new conversation behavior.

- [ ] **Step 2: Validate the graph**

Run: `lat check`

Expected: PASS with all links and code references valid.

- [ ] **Step 3: Run final Runtime verification**

Run targeted image-generation tests, then the broader Runtime unit command defined by the repository. Record exact pass/fail counts.

- [ ] **Step 4: Run final Desktop verification**

Run focused Vitest suites, full type checks, lint, and production build. Record exact exit codes.

- [ ] **Step 5: Perform isolated UI acceptance**

Start only an isolated Profile and isolated ports from the two Beta.28 worktrees. Capture desktop and narrow-viewport screenshots of Tools -> Image Generation. Verify no overlap, masked credential, disabled/enabled state, discovery result, and generated-image preview with a fixture relay.

- [ ] **Step 6: Optional real relay acceptance**

Use only a rotated or newly authorized credential. Issue one bounded generation and confirm the returned artifact. Do not use the credential previously exposed in chat.

- [ ] **Step 7: Commit and prove isolation**

Commit Desktop and Runtime separately. Re-read both active task worktrees and tasks, confirm their HEAD/status/processes are unchanged, and report the two commits as Beta.28 migration-ready increments. Do not push, merge, deploy, or cherry-pick into active branches.
