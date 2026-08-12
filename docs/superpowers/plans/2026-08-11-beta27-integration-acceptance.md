# Beta.27 Integration and Electron Acceptance Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Beta.27 evidence loop with two isolated local providers, a cold-restart Electron journey, policy and Organization failure boundaries, and reproducible build/type/lat gates.

**Architecture:** The acceptance harness composes the checked-in Agent-control Electron harness with two loopback-only OpenAI-compatible servers and fresh user-data/Hermes roots. It creates only fixture-owned Cloud/control-plane records, records sanitized provider observations, and tears down every process and temporary directory it created.

**Tech Stack:** Electron, Playwright, Vitest, Node `http`, Node `sqlite`, better-sqlite3/`DatabaseSync`, TypeScript, YAML, lat.md.

---

## Preconditions and evidence rules

Run this plan only after the three implementation slices have passed their focused tests and the worktree is the exact Beta.27 branch. The acceptance run is a separate gate from package build, CI, merge, deployment, and physical-client update evidence.

The run must use `createAgentControlHarness()` from `tests/e2e/support/agentera-agent-control-harness.ts`, which owns temporary Cloud PostgreSQL/Redis/MinIO services and fresh Electron roots. It must not reuse an existing `HERMES_HOME`, Electron `userData`, database, credential, browser profile, or production Cloud origin. The provider fixtures bind only to `127.0.0.1` on ephemeral ports.

Provider request logs may retain method, path, model, provider fixture name, message-shape booleans, and request counts. They must not retain Authorization headers, API-key values, prompt text, file bytes, or raw response bodies. Test failure output uses counts and bounded codes only.

The acceptance claims are deliberately split:

| Gate                  | Proves                                               | Does not prove                                                                |
| --------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| Focused Vitest        | Contract, transaction, policy, and renderer behavior | Packaged Electron startup or live Cloud deployment                            |
| `npm run build`       | Exact checkout compiles and bundles                  | Cold user-data recovery or provider transport                                 |
| Isolated Electron     | Real UI/IPC/transport journey with fixture services  | Production account, production Cloud, release publication, or updater rollout |
| Exact-head CI/release | Candidate identity and artifact promotion            | User acceptance unless the physical client is updated and checked             |

## File map

- Create: `tests/e2e/support/beta27-reliability-provider.ts` — two loopback provider servers, deterministic SSE, request-shape capture, and cleanup.
- Create: `tests/e2e/support/beta27-reliability-provider.test.ts` — provider fixture isolation and attachment-shape unit proof.
- Create: `tests/e2e/support/beta27-reliability-harness.ts` — temporary roots, provider pair, Electron relaunch helpers, fixture Agent/Organization setup, and bounded database tampering for one stale local reference.
- Create: `tests/e2e/support/beta27-reliability-harness.test.ts` — ownership/cleanup/static safety checks for the harness.
- Create: `tests/e2e/beta27-model-enterprise-reliability.e2e.ts` — the real Electron journey and evidence assertions.
- Modify: `package.json` — add `test:e2e:beta27-reliability` without changing existing E2E scripts.
- Modify: `src/renderer/src/screens/Providers/ModelCenter.tsx`, `src/renderer/src/screens/Providers/ModelCenter.test.tsx`, `src/renderer/src/screens/Chat/ModelPicker.tsx`, `src/renderer/src/screens/Chat/ModelPicker.test.tsx`, `src/renderer/src/screens/Agents/OrganizationSubmissionPanel.tsx`, and `src/renderer/src/screens/Agents/OrganizationSubmissionPanel.test.tsx` — add exact non-secret acceptance selectors without altering behavior.
- Modify: `lat.md/provider-setup.md`, `lat.md/model-selection.md`, `lat.md/agentera-agent-control-plane.md`, and `lat.md/agentera-organizations.md` — record the executable Beta.27 acceptance evidence and non-claims.

### Task 1: Build the controlled provider pair

**Files:**

- Create: `tests/e2e/support/beta27-reliability-provider.ts`
- Create: `tests/e2e/support/beta27-reliability-provider.test.ts`

- [ ] **Step 1: Write the failing provider and attachment-shape test**

Add a test that starts two providers, posts one streaming Chat Completions request to each, and proves the fixture identity and multimodal shape are observable without retaining secrets:

```ts
it("serves two isolated deterministic providers and records attachment shape only", async () => {
  const pair = await startBeta27ProviderPair();
  try {
    const response = await fetch(`${pair.a.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${pair.a.apiKey}`,
      },
      body: JSON.stringify({
        model: "beta27-a",
        stream: true,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "fixture turn" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,fixture-image" },
              },
            ],
          },
        ],
      }),
    });
    expect(response.ok).toBe(true);
    expect(await response.text()).toContain("BETA27_PROVIDER_A_REPLY");
    expect(pair.a.observations).toMatchObject({
      requestCount: 1,
      attachmentRequestCount: 1,
      lastModel: "beta27-a",
    });
    expect(JSON.stringify(pair.a.observations)).not.toContain(pair.a.apiKey);
    expect(pair.a.observations.lastMessageText).toBeUndefined();
    const responseB = await fetch(`${pair.b.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "beta27-b",
        stream: true,
        messages: [{ role: "user", content: "fixture b" }],
      }),
    });
    expect(await responseB.text()).toContain("BETA27_PROVIDER_B_REPLY");
    expect(pair.b.observations.requestCount).toBe(1);
  } finally {
    await pair.close();
  }
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npx vitest run tests/e2e/support/beta27-reliability-provider.test.ts`

Expected: FAIL because `startBeta27ProviderPair` does not exist.

- [ ] **Step 3: Implement the loopback provider**

Export these exact types and functions:

```ts
export interface Beta27ProviderObservation {
  requestCount: number;
  attachmentRequestCount: number;
  invalidRequestCount: number;
  lastModel: string | null;
  lastMessageText: undefined;
}

export interface Beta27Provider {
  name: "A" | "B";
  apiKey: string;
  baseUrl: string;
  observations: Beta27ProviderObservation;
  close(): Promise<void>;
}

export interface Beta27ProviderPair {
  a: Beta27Provider;
  b: Beta27Provider;
  close(): Promise<void>;
}

export async function startBeta27ProviderPair(): Promise<Beta27ProviderPair>;
```

Use `createServer` and an ephemeral `listen(0, "127.0.0.1")`. Accept only `POST /v1/chat/completions`, require `stream: true`, a string `model`, and a `messages` array; increment `invalidRequestCount` and return 400 for every other request. Detect attachments by checking for an object content part with `type === "image_url"` or a file part, but never store message text or content bytes. Emit valid SSE frames (`data: {choices:[{delta:{content:"BETA27_PROVIDER_A_REPLY"}}]}\n\n` followed by `data: [DONE]\n\n`) and use the B reply for provider B. The fixture key is an internal constant used only by the test request; do not include it in errors, observations, or `console` output.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/e2e/support/beta27-reliability-provider.test.ts`

Expected: PASS for both providers, attachment detection, malformed-request rejection, and secret-free observations.

- [ ] **Step 5: Commit the provider fixture**

```bash
git add tests/e2e/support/beta27-reliability-provider.ts tests/e2e/support/beta27-reliability-provider.test.ts
git commit -m "test(beta27): add isolated provider pair"
```

### Task 2: Compose the fresh Electron and control-plane harness

**Files:**

- Create: `tests/e2e/support/beta27-reliability-harness.ts`
- Create: `tests/e2e/support/beta27-reliability-harness.test.ts`

- [ ] **Step 1: Write the failing ownership and relaunch tests**

Define a pure harness-level test with injected launch/close fakes. It checks every root is below one run-specific temporary directory, provider origins are loopback-only, and a relaunch reuses the same isolated `userData`/`HERMES_HOME` without starting Cloud or Electron inside Vitest:

```ts
it("accepts only run-owned paths and preserves them across relaunch", async () => {
  const root = "/private/tmp/beta27-reliability-fixture";
  const paths = {
    userData: `${root}/device/electron-user-data`,
    hermesHome: `${root}/device/hermes-home`,
  };
  expect(() => assertBeta27OwnedPaths(root, paths)).not.toThrow();
  expect(() =>
    assertBeta27OwnedPaths(root, {
      ...paths,
      userData: "/Users/example/Library/Application Support/Aera",
    }),
  ).toThrow("beta27_fixture_path_outside_root");

  const closeApp = vi.fn(async () => undefined);
  const launchDevice = vi.fn(async () => ({ ...FAKE_DEVICE, ...paths }));
  const fixture = fakeBeta27Harness({
    root,
    device: { ...FAKE_DEVICE, ...paths },
  });
  await relaunchBeta27Device(fixture, { closeApp, launchDevice });
  expect(closeApp).toHaveBeenCalledTimes(1);
  expect(launchDevice).toHaveBeenCalledWith(paths);
  expect(fixture.device).toMatchObject(paths);
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npx vitest run tests/e2e/support/beta27-reliability-harness.test.ts`

Expected: FAIL because the composed harness does not exist.

- [ ] **Step 3: Implement the composed harness and bounded fixture helpers**

Export these exact interfaces/functions:

```ts
export interface Beta27ReliabilityHarness {
  root: string;
  agentHarness: AgentControlHarness;
  device: AgentControlDevice;
  providers: Beta27ProviderPair;
  organizationId: string | null;
  close(): Promise<void>;
}

export interface Beta27RelaunchDependencies {
  closeApp(device: AgentControlDevice): Promise<void>;
  launchDevice(paths: {
    userData: string;
    hermesHome: string;
  }): Promise<AgentControlDevice>;
}

export function assertBeta27OwnedPaths(
  root: string,
  paths: { userData: string; hermesHome: string },
): void;
export async function createBeta27ReliabilityHarness(): Promise<Beta27ReliabilityHarness>;
export async function closeBeta27ReliabilityHarness(
  fixture: Beta27ReliabilityHarness,
): Promise<void>;
export async function relaunchBeta27Device(
  fixture: Beta27ReliabilityHarness,
  dependencies?: Beta27RelaunchDependencies,
): Promise<void>;
export async function configureFixtureProviderCatalog(
  fixture: Beta27ReliabilityHarness,
): Promise<void>;
export async function installFixtureAgent(
  fixture: Beta27ReliabilityHarness,
  mode: "user_select" | "allowlist" | "fixed",
  model?: "beta27-a" | "beta27-b",
): Promise<{
  installationId: string;
  profileId: string;
  definitionId: string;
  versionId: string;
}>;
export async function createApprovedOrganizationFixture(
  fixture: Beta27ReliabilityHarness,
): Promise<{ organizationId: string; submissionId: string; draftId: string }>;
export async function createSecondApprovedOrganizationSubmission(
  fixture: Beta27ReliabilityHarness,
  organizationId: string,
): Promise<{ submissionId: string; draftId: string }>;
export function corruptLocalSubmissionDigest(
  fixture: Beta27ReliabilityHarness,
  submissionId: string,
): void;
export function readThreadSegments(userDataPath: string): Promise<{
  activeModel: string;
  segmentCount: number;
  immutableModels: string[];
}>;
export function countOrganizationSubmissionListRequests(
  fixture: Beta27ReliabilityHarness,
): number;
```

`createBeta27ReliabilityHarness()` must call `createAgentControlHarness()`, `startBeta27ProviderPair()`, `launchAgentControlDevice()`, `authenticateFirstAgentControlDevice()`, and `claimDefaultProfile()` in that order. Write a minimal `config.yaml` below the fixture Hermes home before launch; its provider/base URL points only at provider A and contains no key. Use the existing harness cleanup plus provider cleanup in a `finally`-safe `close()` implementation.

`configureFixtureProviderCatalog()` must call only the new `mutateModelConfiguration` bridge twice, once for A and once for B, with `apiMode: "chat_completions"` and carrying forward the catalog revision returned by the first committed result. It then reads one owner catalog and requires both `beta27-a` and `beta27-b`; it must not call `setEnv`, `upsertCustomProvider`, `addModel`, or `setModelConfig`.

`installFixtureAgent()` must create a V3 draft in the USER context with the requested signed `modelPolicy` mode, publish it through `preparePublication`/`confirmPublication`, list its verified definition/version, read the owner catalog, and call `installVersion` with the exact `OwnerModelRouteSelection` for the requested model (default A). For `allowlist`, the manifest lists only that provider/model; for `fixed`, it lists exactly that one route; for `user_select`, both lists are empty. It must return only UUIDs/profile handles and never a credential or file path.

`createApprovedOrganizationFixture()` must use the existing Organization and Agent control bridges to create one Organization, select it through `window.agenteraProductSpace.select`, create/submit one V3 enterprise draft, perform the single-owner review flow, and return the Cloud submission/draft IDs. `createSecondApprovedOrganizationSubmission()` repeats only the draft/publication/review portion inside that exact Organization. `corruptLocalSubmissionDigest()` may open only `${device.userData}/agentera-control-plane/control-plane.db` with `DatabaseSync`, verify the target row belongs to the fixture Organization, and update only `content_digest` to a different 64-hex fixture value. It must not delete rows or touch Profiles, RuntimeBindings, Hermes sessions, or Cloud data.

`readThreadSegments()` opens only the fixture control-plane database, validates a single owner/device thread, parses each route through the production frozen-route parser, and returns only the three redacted aggregate fields in its signature. `countOrganizationSubmissionListRequests()` filters the harness's recorded Cloud requests by the canonical Organization submissions-list method/path; it never counts renderer calls or inspects authorization data. `closeBeta27ReliabilityHarness()` is idempotent and delegates to the fixture-owned `close()` exactly once.

- [ ] **Step 4: Verify GREEN and cleanup**

Run: `npx vitest run tests/e2e/support/beta27-reliability-harness.test.ts`

Expected: PASS; a forced cleanup closes the Electron app, provider servers, browser context, and only the run-specific temporary Cloud/control-plane resources.

- [ ] **Step 5: Commit the harness**

```bash
git add tests/e2e/support/beta27-reliability-harness.ts tests/e2e/support/beta27-reliability-harness.test.ts
git commit -m "test(beta27): compose isolated Electron harness"
```

### Task 3: Prove model save/edit, cold recovery, and the Agent catalog in Electron

**Files:**

- Create: `tests/e2e/beta27-model-enterprise-reliability.e2e.ts`
- Modify: `src/renderer/src/screens/Providers/ModelCenter.tsx` to add stable `data-testid="model-provider-wizard"`, `data-testid="model-provider-save"`, and `data-testid="model-service-card:<provider-label>"` attributes.
- Modify: `src/renderer/src/screens/Providers/ModelCenter.test.tsx` to assert those selectors contain no API-key or credential value.

- [ ] **Step 1: Add the failing Electron journey**

Use a fresh fixture and drive the actual Providers dialog. The first half of the test must assert the postconditions, not only button clicks:

```ts
test("saves, edits, cold-restores, and exposes one owner catalog", async () => {
  const fixture = await createBeta27ReliabilityHarness();
  try {
    await openProviders(fixture.device.page);
    await addCustomProviderThroughModelCenter(fixture.device.page, {
      name: "Beta27 A",
      baseUrl: fixture.providers.a.baseUrl,
      apiKey: fixture.providers.a.apiKey,
      model: "beta27-a",
    });
    await expect(
      fixture.device.page.getByTestId("model-service-card:Beta27 A"),
    ).toContainText("beta27-a");
    await relaunchBeta27Device(fixture);
    await openProviders(fixture.device.page);
    await expect(
      fixture.device.page.getByTestId("model-service-card:Beta27 A"),
    ).toContainText("beta27-a");

    await editCustomProviderThroughModelCenter(
      fixture.device.page,
      "Beta27 A",
      {
        name: "Beta27 B",
        baseUrl: fixture.providers.b.baseUrl,
        apiKey: fixture.providers.b.apiKey,
        model: "beta27-b",
      },
    );
    await expect(
      fixture.device.page.getByTestId("model-service-card:Beta27 B"),
    ).toContainText("beta27-b");
    await relaunchBeta27Device(fixture);
    const catalog = await fixture.device.page.evaluate(() =>
      window.hermesAPI.getOwnerModelRouteCatalog(),
    );
    expect(catalog.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "beta27-b",
          baseUrl: fixture.providers.b.baseUrl,
        }),
      ]),
    );
    expect(JSON.stringify(catalog)).not.toMatch(/apiKey|credentialRef|secret/i);

    await installFixtureAgent(fixture, "user_select", "beta27-b");
    await fixture.device.page
      .getByRole("button", { name: /Agents|智能体/ })
      .click();
    await expect(
      fixture.device.page.getByText("beta27-b").first(),
    ).toBeVisible();
    await expect(
      fixture.device.page.getByText(/configure a model first|请先配置模型/i),
    ).toHaveCount(0);
  } finally {
    await closeBeta27ReliabilityHarness(fixture);
  }
});
```

- [ ] **Step 2: Run the journey before product changes to verify RED**

Run: `npm run build && AGENTERA_E2E_CLOUD_ROOT=/Users/zizimutou/Desktop/aera/aera-cloud npx playwright test tests/e2e/beta27-model-enterprise-reliability.e2e.ts --grep "saves, edits"`

Expected: FAIL at the missing typed Model Center bridge or missing stable selector on the current Beta.26 implementation; it must not be converted into a skipped test.

- [ ] **Step 3: Implement only the test selectors and journey helpers**

`openProviders`, `addCustomProviderThroughModelCenter`, and `editCustomProviderThroughModelCenter` must use the existing `#provider-name`, `#provider-base-url`, `#provider-api-key`, `#provider-model`, and `#provider-api-mode` controls, select `chat_completions`, then click the dialog's `data-testid="model-provider-save"`. They must wait for the card's `role="status"`/`role="alert"` postcondition and clear the form key from the DOM after a committed result. The test must not invoke legacy `setEnv`, `upsertCustomProvider`, `addModel`, or `setModelConfig` as a shortcut.

The cold restart helper must close the current Electron process, relaunch with the same fixture roots, wait for `.layout` and authenticated state, dismiss only the startup model prompt if present, and then re-read the catalog through Main. A catalog containing B after restart plus the Agent page's B option is the required proof that Model Center, installation, and Agent routes share one owner catalog.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build && AGENTERA_E2E_CLOUD_ROOT=/Users/zizimutou/Desktop/aera/aera-cloud npx playwright test tests/e2e/beta27-model-enterprise-reliability.e2e.ts --grep "saves, edits"`

Expected: PASS with two provider observations still at zero; this test proves persistence/readback, not a provider chat response.

- [ ] **Step 5: Commit the Electron save journey**

```bash
git add tests/e2e/beta27-model-enterprise-reliability.e2e.ts src/renderer/src/screens/Providers/ModelCenter.tsx src/renderer/src/screens/Providers/ModelCenter.test.tsx
git commit -m "test(beta27): verify model save and cold catalog recovery"
```

### Task 4: Prove same-thread switching, policies, attachments, and safe failures

**Files:**

- Modify: `tests/e2e/beta27-model-enterprise-reliability.e2e.ts`
- Modify: `tests/e2e/support/beta27-reliability-harness.ts`
- Modify: `src/main/agentera-agent-control/hermes-adapter.test.ts`
- Modify: `src/main/hermes.test.ts`
- Modify: `src/renderer/src/screens/Chat/ModelPicker.tsx`
- Modify: `src/renderer/src/screens/Chat/ModelPicker.test.tsx`

- [ ] **Step 1: Add the failing switching and policy journeys**

Add one Electron test using the `user_select` fixture and one focused policy/transport test. The Electron assertion must prove one visible thread with two immutable segments and provider-specific replies:

```ts
test("switches A to B in one visible thread and resumes B after restart", async () => {
  const fixture = await createBeta27ReliabilityHarness();
  try {
    await configureFixtureProviderCatalog(fixture);
    const installed = await installFixtureAgent(fixture, "user_select");
    await openInstalledAgentChat(fixture.device.page, installed.profileId);
    await sendChatAndExpectReply(
      fixture.device.page,
      "first",
      "BETA27_PROVIDER_A_REPLY",
    );
    await chooseInstalledAgentModel(fixture.device.page, "beta27-b");
    await sendChatAndExpectReply(
      fixture.device.page,
      "continue",
      "BETA27_PROVIDER_B_REPLY",
    );
    expect(fixture.providers.a.observations.requestCount).toBe(1);
    expect(fixture.providers.b.observations.requestCount).toBe(1);
    await expect(
      fixture.device.page.getByTestId("model-switch-marker"),
    ).toHaveCount(1);
    await expect(
      fixture.device.page.locator(".sidebar-session-item"),
    ).toHaveCount(1);

    const segmentsBefore = await readThreadSegments(fixture.device.userData);
    expect(segmentsBefore).toMatchObject({
      activeModel: "beta27-b",
      segmentCount: 2,
    });
    expect(segmentsBefore.immutableModels).toEqual(["beta27-a", "beta27-b"]);
    await relaunchBeta27Device(fixture);
    await resumeMostRecentThread(fixture.device.page);
    await sendChatAndExpectReply(
      fixture.device.page,
      "after restart",
      "BETA27_PROVIDER_B_REPLY",
    );
    expect(fixture.providers.b.observations.requestCount).toBe(2);
  } finally {
    await closeBeta27ReliabilityHarness(fixture);
  }
});
```

Add a second Electron test that installs an `allowlist` Agent and a `fixed` Agent from the same two-route catalog. The allowlist picker must contain A and omit B; the fixed picker must be disabled with its signed-policy explanation. Record the fixed thread's segment count, send a forged B selection through the preload bridge, require `model_switch_fixed_policy`, and prove the segment count is unchanged.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/main/agentera-agent-control/hermes-adapter.test.ts src/main/hermes.test.ts tests/e2e/support/beta27-reliability-provider.test.ts`

Expected: the new policy/segment tests fail before implementation; existing ordinary attachment and session-override tests remain green.

- [ ] **Step 3: Implement the journey helpers and boundary assertions**

`openInstalledAgentChat` must open the existing Agent chat route and wait for a real enabled chat input. `ModelPicker` adds `data-testid="installed-agent-model-picker"` and `data-model-id` only for non-secret public route identity; its focused test proves no credential field reaches the DOM. `chooseInstalledAgentModel` must select that installed-Agent picker option, not call `setSessionModelOverride`; `sendChatAndExpectReply` must wait for the exact controlled reply text and a completed turn. `readThreadSegments` must query only the fixture control-plane database and return `{ activeModel, segmentCount, immutableModels }` after validating the owner/device tuple; it must not return route credentials or prompt bytes.

Add a temporary image fixture below the run root and send it with one B turn. Assert `provider.b.observations.attachmentRequestCount === 1` and `invalidRequestCount === 0`; no CLI request or dropped image is accepted as success. The SSH/remote test uses an injected remote inventory adapter with `routeAvailable: false`, expects `model_switch_remote_unavailable`, and checks that no local credential/provider file changed.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx vitest run src/main/agentera-agent-control/hermes-adapter.test.ts src/main/hermes.test.ts
npm run build
AGENTERA_E2E_CLOUD_ROOT=/Users/zizimutou/Desktop/aera/aera-cloud npx playwright test tests/e2e/beta27-model-enterprise-reliability.e2e.ts --grep "switches A to B|applies allowlist and fixed"
```

Expected: PASS; the visible thread has one marker, two immutable segments, B survives cold resume, and no tool/content replay occurs.

- [ ] **Step 5: Commit the switching acceptance**

```bash
git add tests/e2e/beta27-model-enterprise-reliability.e2e.ts tests/e2e/support/beta27-reliability-harness.ts src/main/agentera-agent-control/hermes-adapter.test.ts src/main/hermes.test.ts src/renderer/src/screens/Chat/ModelPicker.tsx src/renderer/src/screens/Chat/ModelPicker.test.tsx
git commit -m "test(beta27): verify safe Agent model switching"
```

### Task 5: Prove Organization isolation and one warning surface

**Files:**

- Modify: `tests/e2e/beta27-model-enterprise-reliability.e2e.ts`
- Modify: `tests/e2e/support/beta27-reliability-harness.ts`
- Modify: `src/renderer/src/screens/Agents/OrganizationSubmissionPanel.tsx`
- Modify: `src/renderer/src/screens/Agents/OrganizationSubmissionPanel.test.tsx`

- [ ] **Step 1: Add the failing Organization conflict journey**

Create two approved Organization submissions, corrupt the local reference for only the first, open Enterprise Agents, and assert both Cloud summaries remain visible while exactly one card carries the bounded warning:

```ts
test("quarantines one stale Organization link without hiding healthy submissions", async () => {
  const fixture = await createBeta27ReliabilityHarness();
  try {
    const organization = await createApprovedOrganizationFixture(fixture);
    const second = await createSecondApprovedOrganizationSubmission(
      fixture,
      organization.organizationId,
    );
    corruptLocalSubmissionDigest(fixture, organization.submissionId);
    await selectOrganizationAndOpenEnterprise(
      fixture.device.page,
      organization.organizationId,
    );
    await expect(
      fixture.device.page.getByText(organization.submissionId),
    ).toBeVisible();
    await expect(
      fixture.device.page.getByText(second.submissionId),
    ).toBeVisible();
    await expect(
      fixture.device.page.getByTestId(
        `submission-reference-conflict:${organization.submissionId}`,
      ),
    ).toHaveCount(1);
    await expect(
      fixture.device.page.getByTestId(
        `submission-reference-conflict:${second.submissionId}`,
      ),
    ).toHaveCount(0);
    expect(await countOrganizationSubmissionListRequests(fixture)).toBe(1);
    await fixture.device.page
      .getByRole("button", { name: /Refresh|刷新/ })
      .click();
    await expect(
      fixture.device.page.getByTestId(
        `submission-reference-conflict:${organization.submissionId}`,
      ),
    ).toHaveCount(1);
    expect(await countOrganizationSubmissionListRequests(fixture)).toBe(2);
  } finally {
    await closeBeta27ReliabilityHarness(fixture);
  }
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm run build && AGENTERA_E2E_CLOUD_ROOT=/Users/zizimutou/Desktop/aera/aera-cloud npx playwright test tests/e2e/beta27-model-enterprise-reliability.e2e.ts --grep "quarantines one"`

Expected: FAIL on the current batch-fatal list or duplicated child request; it must show the exact bounded error in the trace rather than skip the assertion.

- [ ] **Step 3: Implement the warning and detach assertions**

The helper must create the second submission in the same Organization and leave both Cloud rows trusted. The page assertion identifies cards by canonical Cloud submission ID rendered in a `data-submission-id` attribute; the conflict warning uses `data-testid="submission-reference-conflict:<id>"` and contains only the localized stage. Click the Owner/Admin-only disconnect action, confirm the literal `disconnect-local-draft-link`, and assert the card becomes `remote_only` while the draft row, published Version, Installation, Profile, and Hermes session hashes are byte-for-byte unchanged.

Use `agentControlRequests(fixture.agentHarness)` to count the Cloud `GET /api/v1/organizations/<id>/agent-publication-submissions` exchanges caused by the list bridge; exactly one request is allowed per initial load and one per explicit refresh. The child panel must contain no call to either the new envelope bridge or the deprecated array bridge. Add `data-submission-id="<cloud-id>"` to each card and `data-testid="submission-reference-conflict:<cloud-id>"` to only a quarantined warning; the focused panel test proves both attributes are derived from canonical public IDs.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build && AGENTERA_E2E_CLOUD_ROOT=/Users/zizimutou/Desktop/aera/aera-cloud npx playwright test tests/e2e/beta27-model-enterprise-reliability.e2e.ts --grep "quarantines one"`

Expected: PASS; both submissions and definitions remain usable, one item warning is shown once, refresh does not escalate it to a page error, and confirmed detach changes only the local link.

- [ ] **Step 5: Commit the Organization acceptance**

```bash
git add tests/e2e/beta27-model-enterprise-reliability.e2e.ts tests/e2e/support/beta27-reliability-harness.ts src/renderer/src/screens/Agents/OrganizationSubmissionPanel.tsx src/renderer/src/screens/Agents/OrganizationSubmissionPanel.test.tsx
git commit -m "test(beta27): verify isolated Organization conflicts"
```

### Task 6: Run the complete Beta.27 acceptance gates

**Files:**

- Modify: `package.json`
- Modify: `lat.md/provider-setup.md`
- Modify: `lat.md/model-selection.md`
- Modify: `lat.md/agentera-agent-control-plane.md`
- Modify: `lat.md/agentera-organizations.md`

- [ ] **Step 1: Add the dedicated script and lat evidence sections**

Add exactly this package script, without changing existing commands:

```json
"test:e2e:beta27-reliability": "npm run build && playwright test tests/e2e/beta27-model-enterprise-reliability.e2e.ts"
```

Document the provider pair, fresh-root requirement, save/cold-recovery postconditions, immutable segment evidence, one-request Organization evidence, and the fact that these checks do not claim push/merge/deploy/release. Add one `@lat:` reference next to each primary E2E test and do not reuse a verification key for two different behavior sections.

- [ ] **Step 2: Run focused tests, type checks, format, and lat validation**

```bash
npx vitest run \
  tests/e2e/support/beta27-reliability-provider.test.ts \
  tests/e2e/support/beta27-reliability-harness.test.ts \
  src/main/agentera-agent-control/hermes-adapter.test.ts \
  src/main/hermes.test.ts
npm test
npm run typecheck
npx prettier --check \
  tests/e2e/support/beta27-reliability-provider.ts \
  tests/e2e/support/beta27-reliability-harness.ts \
  tests/e2e/beta27-model-enterprise-reliability.e2e.ts \
  lat.md/provider-setup.md lat.md/model-selection.md \
  lat.md/agentera-agent-control-plane.md lat.md/agentera-organizations.md
npm exec --yes --package=lat.md@0.12.1 -- lat check
git diff --check
```

Expected: the focused tests and complete Vitest suite report zero failures, and every static command exits 0 before any Electron run is attempted.

- [ ] **Step 3: Build and run the isolated Electron gate**

Run with an explicit Cloud checkout and no production origin:

```bash
AGENTERA_E2E_CLOUD_ROOT=/Users/zizimutou/Desktop/aera/aera-cloud \
  npm run test:e2e:beta27-reliability
```

Expected: the save/edit/cold-restart, same-thread A→B, user_select/allowlist/fixed, attachment, SSH/remote, and Organization-conflict tests pass. If a test fails, retain the Playwright trace and bounded provider/control-plane diagnostics; do not convert it to a retry-only green result.

- [ ] **Step 4: Record the evidence ledger and non-claims**

Record the exact `HEAD`, `origin/main`, build output identity, test command, provider request counts, Electron fixture root, Cloud fixture origin, and Playwright result in the Beta.27 handoff. Record separately that this does not prove exact-head CI, merged-main CI, updater publication, deployment, or a physical internal-client update.

- [ ] **Step 5: Commit the integrated acceptance plan/evidence docs**

```bash
git add package.json lat.md/provider-setup.md lat.md/model-selection.md lat.md/agentera-agent-control-plane.md lat.md/agentera-organizations.md
git commit -m "test(beta27): add integration and Electron acceptance gate"
```

## Completion condition

The integration slice is complete only when the focused gates, build, isolated Electron journey, and `lat check` are all green on the same exact checkout. A green local journey is an acceptance result for this fixture run; it is not a Beta.27 publication or deployment claim.
