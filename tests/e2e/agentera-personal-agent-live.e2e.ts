import { expect, test } from "playwright/test";

import {
  customProviderEnvKey,
  expectedEnvKeyForUrl,
} from "../../src/shared/url-key-map";
import { customProviderRuntimeRoute } from "../../src/shared/custom-providers";
import {
  agentControlExchangeDiagnostics,
  authenticateFirstAgentControlDevice,
  claimDefaultProfile,
  closeAgentControlHarness,
  createAgentControlHarness,
  deviceProcessDiagnostics,
  launchAgentControlDevice,
  type AgentControlDevice,
  type AgentControlHarness,
} from "./support/agentera-agent-control-harness";

const LIVE_API_KEY =
  process.env.AGENTERA_PERSONAL_AGENT_LIVE_API_KEY?.trim() ?? "";
const LIVE_BASE_URL =
  process.env.AGENTERA_PERSONAL_AGENT_LIVE_BASE_URL?.trim() ||
  "https://api.zhongzhuan.win/v1";
const LIVE_MODEL =
  process.env.AGENTERA_PERSONAL_AGENT_LIVE_MODEL?.trim() || "gpt-5.6-sol";
const LIVE_PROVIDER_NAME = new URL(LIVE_BASE_URL).hostname;
const LIVE_PROVIDER_ROUTE = customProviderRuntimeRoute(LIVE_PROVIDER_NAME);
const LIVE_PROVIDER_KEY = customProviderEnvKey(LIVE_PROVIDER_NAME);
const LIVE_REPLY_MARKER = "AERA_PERSONAL_AGENT_LIVE_OK_20260731";
const ORGANIZATION_NAME = "Personal Agent Live Organization";
const AGENT_NAME = "Live Published Agent";

test.setTimeout(600_000);

function diagnostics(
  harness: AgentControlHarness | null,
  device: AgentControlDevice | null,
): string {
  return JSON.stringify({
    exchanges: harness ? agentControlExchangeDiagnostics(harness) : [],
    processes: deviceProcessDiagnostics(device),
  });
}

async function selectedProductSpace(
  device: AgentControlDevice,
): Promise<unknown> {
  return device.page.evaluate(async () => {
    const result = await window.agenteraProductSpace.getState();
    return result.ok ? result.data.selected : result;
  });
}

// @lat: [[agentera-agent-control-plane#Release gate#Personal publish and use]]
test("keeps the Organization shell while a personal Agent publishes, becomes ready, and answers through a live model", async () => {
  test.skip(
    LIVE_API_KEY.length === 0,
    "Set AGENTERA_PERSONAL_AGENT_LIVE_API_KEY for the live provider acceptance.",
  );

  let harness: AgentControlHarness | null = null;
  let device: AgentControlDevice | null = null;
  const previousProviderKey = process.env[LIVE_PROVIDER_KEY];
  try {
    harness = await createAgentControlHarness();
    process.env[LIVE_PROVIDER_KEY] = LIVE_API_KEY;
    device = await launchAgentControlDevice(harness, "A");
    await authenticateFirstAgentControlDevice(harness, device);
    await claimDefaultProfile(device);

    const accountProfile = await device.page.evaluate(async () => {
      const profiles = await window.hermesAPI.listProfiles();
      return (
        profiles.find(
          (profile) => profile.isActive && !profile.agentInstallationId,
        ) ?? null
      );
    });
    expect(accountProfile).toMatchObject({
      isActive: true,
      agentInstallationId: null,
    });
    if (!accountProfile) {
      throw new Error("The bound account Runtime Profile is unavailable.");
    }

    const configured = await device.page.evaluate(
      async ({ baseUrl, model, profileId, providerName }) => {
        const provider = await window.hermesAPI.upsertCustomProvider(
          profileId,
          {
            name: providerName,
            baseUrl,
          },
        );
        const savedModel = await window.hermesAPI.addModel(
          model,
          "custom",
          model,
          baseUrl,
          64_000,
          providerName,
          "chat_completions",
        );
        await window.hermesAPI.setModelConfig(
          "custom",
          model,
          baseUrl,
          profileId,
        );
        return {
          provider,
          savedModel,
          active: await window.hermesAPI.getModelConfig(profileId),
        };
      },
      {
        baseUrl: LIVE_BASE_URL,
        model: LIVE_MODEL,
        profileId: accountProfile.id,
        providerName: LIVE_PROVIDER_NAME,
      },
    );
    expect(configured.provider).toMatchObject({
      name: LIVE_PROVIDER_NAME,
      baseUrl: LIVE_BASE_URL,
    });
    expect(configured.savedModel).toMatchObject({
      provider: "custom",
      providerLabel: LIVE_PROVIDER_NAME,
      model: LIVE_MODEL,
      baseUrl: LIVE_BASE_URL,
    });
    expect(configured.active).toEqual({
      provider: LIVE_PROVIDER_ROUTE,
      model: LIVE_MODEL,
      baseUrl: LIVE_BASE_URL,
    });
    expect(expectedEnvKeyForUrl(LIVE_BASE_URL)).not.toBe(LIVE_PROVIDER_KEY);

    const startupModelPrompt = device.page.locator(".startup-model-prompt");
    if (await startupModelPrompt.isVisible()) {
      await startupModelPrompt
        .getByRole("button", { name: /^(Later|稍后)$/ })
        .click();
      await expect(device.page.locator(".app-modal-overlay")).toHaveCount(0);
    }

    const organization = await device.page.evaluate(async (displayName) => {
      const created = await window.agenteraOrganization.create({ displayName });
      if (!created.ok) {
        throw new Error(`Organization creation failed: ${created.errorCode}`);
      }
      const refreshed = await window.agenteraProductSpace.refresh();
      if (!refreshed.ok) {
        throw new Error(`Product-space refresh failed: ${refreshed.errorCode}`);
      }
      return created.data;
    }, ORGANIZATION_NAME);

    const switcher = device.page.locator(
      ".product-space-switcher .workspace-switcher-trigger",
    );
    await expect(switcher).toBeVisible();
    await switcher.click();
    await device.page
      .getByRole("menuitemradio", { name: new RegExp(ORGANIZATION_NAME) })
      .click();
    await expect
      .poll(() => selectedProductSpace(device!))
      .toEqual({
        kind: "ORGANIZATION",
        organizationId: organization.id,
        role: "owner",
      });

    await device.page
      .getByRole("button", { name: /^(Agents|智能体)$/ })
      .click();
    const myAgentsTab = device.page.getByRole("tab", {
      name: /^(My Agents|我的智能体)$/,
    });
    await expect(myAgentsTab).toBeVisible();
    await myAgentsTab.click();

    const createButton = device.page.locator(".agent-hub-create-button");
    await expect(createButton).toBeEnabled();
    await createButton.click();
    const editor = device.page.locator(".agent-draft-editor");
    await expect(editor).toBeVisible();
    expect(await selectedProductSpace(device)).toEqual({
      kind: "ORGANIZATION",
      organizationId: organization.id,
      role: "owner",
    });

    await editor.getByLabel(/^(Agent name|智能体名称)$/).fill(AGENT_NAME);
    await editor
      .getByLabel(/^(Identity and working style|身份与工作方式)$/)
      .fill(
        `You are a live acceptance Agent. When asked for the validation marker, reply with exactly ${LIVE_REPLY_MARKER} and nothing else.`,
      );
    const runtimeModel = editor.getByLabel(/^(Runtime model|运行模型)$/);
    await expect(runtimeModel).toHaveValue(
      `${LIVE_PROVIDER_ROUTE}\u0000${LIVE_MODEL}`,
    );

    const publishAndUse = editor.getByRole("button", {
      name: /^(Publish and use|发布并使用)$/,
    });
    await expect(publishAndUse).toBeEnabled();
    await publishAndUse.click();

    const chatInput = device.page.locator("textarea.chat-input:visible");
    await expect(chatInput).toBeVisible({ timeout: 240_000 });
    expect(await selectedProductSpace(device)).toEqual({
      kind: "ORGANIZATION",
      organizationId: organization.id,
      role: "owner",
    });

    const personalState = await device.page.evaluate(async (agentName) => {
      const [drafts, definitions, installations, profiles] = await Promise.all([
        window.agenteraAgents.listDrafts("USER"),
        window.agenteraAgents.listDefinitions("USER"),
        window.agenteraAgents.listInstallations("USER"),
        window.hermesAPI.listProfiles(),
      ]);
      if (!drafts.ok || !definitions.ok || !installations.ok) {
        throw new Error("Personal Agent state could not be read.");
      }
      const draft = drafts.data.find(
        (candidate) => candidate.displayName === agentName,
      );
      const definition = definitions.data.find(
        (candidate) => candidate.id === draft?.publishedRevision?.definitionId,
      );
      const installation = installations.data.find(
        (candidate) => candidate.definitionId === definition?.id,
      );
      const profile = profiles.find(
        (candidate) => candidate.agentInstallationId === installation?.id,
      );
      return {
        draft,
        definition,
        installation,
        profile,
        model: profile
          ? await window.hermesAPI.getModelConfig(profile.id)
          : null,
      };
    }, AGENT_NAME);
    expect(personalState.draft?.publishedRevision).toBeTruthy();
    expect(personalState.definition?.latestVersionId).toBe(
      personalState.draft?.publishedRevision?.versionId,
    );
    expect(personalState.installation).toMatchObject({
      sourceScope: "USER",
      status: "active",
      selectedVersionId: personalState.definition?.latestVersionId,
    });
    expect(personalState.profile).toMatchObject({
      provider: LIVE_PROVIDER_ROUTE,
      model: LIVE_MODEL,
      agentInstallationId: personalState.installation?.id,
    });
    expect(personalState.profile?.id).not.toBe("default");
    expect(personalState.model).toEqual({
      provider: LIVE_PROVIDER_ROUTE,
      model: LIVE_MODEL,
      baseUrl: LIVE_BASE_URL,
    });

    await device.page
      .getByRole("button", { name: /^(Agents|智能体)$/ })
      .click();
    await device.page
      .getByRole("tab", { name: /^(My Agents|我的智能体)$/ })
      .click();
    const readyFilter = device.page
      .locator('[role="tabpanel"] .agent-hub-filters')
      .getByRole("button", { name: /^(Ready|可使用)$/ });
    await readyFilter.click();
    const agentGrid = device.page.getByTestId("personal-agent-grid");
    await expect(agentGrid).toContainText(AGENT_NAME);
    await expect(agentGrid).toContainText(/Ready|可使用/);

    await agentGrid.getByText(AGENT_NAME).click();
    await device.page
      .getByRole("button", { name: /^(Start using|开始使用)$/ })
      .click();
    await expect(chatInput).toBeVisible({ timeout: 120_000 });

    await chatInput.fill(
      `Return the validation marker now: ${LIVE_REPLY_MARKER}`,
    );
    const send = device.page.locator("button.chat-send-btn:visible");
    await expect(send).toBeEnabled({ timeout: 120_000 });
    await send.click();
    await expect(
      device.page
        .locator(".chat-message-agent .chat-bubble-agent")
        .filter({ hasText: LIVE_REPLY_MARKER }),
    ).toBeVisible({ timeout: 240_000 });
    await expect(
      device.page.locator(".chat-error-message"),
      `Live Agent chat failed; ${diagnostics(harness, device)}`,
    ).toHaveCount(0);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n${diagnostics(
        harness,
        device,
      )}`,
    );
  } finally {
    try {
      await closeAgentControlHarness(harness);
    } finally {
      if (previousProviderKey === undefined) {
        delete process.env[LIVE_PROVIDER_KEY];
      } else {
        process.env[LIVE_PROVIDER_KEY] = previousProviderKey;
      }
    }
  }
});
