import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "playwright/test";

import { customProviderEnvKey } from "../../src/shared/url-key-map";
import {
  authenticateNewProductAccount,
  closeProductAuthHarness,
  createProductAuthHarness,
  launchRuntimeDesktop,
  type ProductAuthHarness,
} from "./support/agentera-product-auth-harness";

const ORIGINAL_PROVIDER = "Original provider";
const RENAMED_PROVIDER = "123456";
const TWIN_PROVIDER = "Twin provider";
const ORIGINAL_MODEL = "original-model-e2e";
const TWIN_MODEL = "twin-model-e2e";
const ORIGINAL_KEY = "provider-lifecycle-original-key";
const RECOVERY_KEY = "provider-lifecycle-recovery-key";
const RENAMED_KEY = "provider-lifecycle-renamed-key";
const UPDATED_KEY = "provider-lifecycle-updated-key";
const TWIN_KEY = "provider-lifecycle-twin-key";
const FIXTURE_RUNTIME_VERSION = "Hermes provider lifecycle E2E";

interface DiscoveryRelay {
  baseUrl: string;
  alternateBaseUrl: string;
  authorizationHeaders: string[];
  respond(statusCode: number, models?: string[]): void;
  server: Server;
}

async function startEmptyDiscoveryRelay(): Promise<DiscoveryRelay> {
  const authorizationHeaders: string[] = [];
  let statusCode = 200;
  let models: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      authorizationHeaders.push(request.headers.authorization ?? "");
      if (statusCode >= 400) {
        response.writeHead(statusCode, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Fixture discovery failure",
              type: "server_error",
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: models.map((id) => ({ id, object: "model" })),
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider lifecycle relay did not expose a port.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl: `${origin}/v1`,
    alternateBaseUrl: `${origin}/alternate/v1`,
    authorizationHeaders,
    respond(nextStatusCode, nextModels = []) {
      statusCode = nextStatusCode;
      models = [...nextModels];
    },
    server,
  };
}

function modelOperationState(userDataPath: string): {
  count: number;
  latestState: string | null;
} {
  const sqlite = new DatabaseSync(
    join(userDataPath, "model-configuration", "model-configuration.db"),
  );
  try {
    const count = Number(
      (
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM desktop_model_configuration_operations",
          )
          .get() as { count: number | bigint }
      ).count,
    );
    const latest = sqlite
      .prepare(
        "SELECT state FROM desktop_model_configuration_operations ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { state: string } | undefined;
    return { count, latestState: latest?.state ?? null };
  } finally {
    sqlite.close();
  }
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function prepareExternalRuntime(
  harness: ProductAuthHarness,
): Promise<void> {
  const runtimeRoot = join(harness.hermesHome, "hermes-agent");
  const python = join(runtimeRoot, "venv", "bin", "python");
  await mkdir(dirname(python), { recursive: true });
  await mkdir(join(runtimeRoot, "hermes_cli"), { recursive: true });
  await writeFile(
    python,
    `#!/bin/sh\nif [ "$1" = "-m" ] && [ "$2" = "hermes_cli.main" ] && [ "$3" = "--version" ]; then\n  echo "${FIXTURE_RUNTIME_VERSION}"\nfi\nexit 0\n`,
    "utf8",
  );
  await chmod(python, 0o755);
  await writeFile(join(runtimeRoot, "hermes_cli", "main.py"), "# E2E marker\n");
  await writeFile(
    join(harness.userData, "hermes-home.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: "external",
        hermesHome: harness.hermesHome,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function dismissStartupModelPrompt(page: Page): Promise<void> {
  const prompt = page.locator(".startup-model-prompt");
  await prompt
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => undefined);
  if (await prompt.isVisible()) {
    await prompt.getByRole("button", { name: /^(Later|稍后)$/u }).click();
  }
}

async function openModelSettings(page: Page): Promise<void> {
  const settingsItem = page.getByRole("menuitem", {
    name: /^Settings$|^设置$/u,
  });
  if (!(await settingsItem.isVisible())) {
    const accountMenuTrigger = page.locator(".agentera-account-trigger");
    await expect(accountMenuTrigger).toBeVisible();
    await accountMenuTrigger.click();
  }
  await settingsItem.click();
  const settingsPage = page.locator(".settings-page");
  await expect(settingsPage).toBeVisible();
  await settingsPage
    .locator(".settings-page-nav-item")
    .filter({ hasText: /^Models$|^模型$/u })
    .click();
  await expect(settingsPage.locator(".model-center")).toBeVisible();
}

function serviceCard(page: Page, name: string): Locator {
  return page.locator(".model-service-card").filter({
    has: page.getByRole("heading", { name, exact: true }),
  });
}

async function openAddCustomDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add model service" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Custom", exact: true }).click();
  return dialog;
}

async function fillAndFetchCustomProvider(
  dialog: Locator,
  input: { name: string; baseUrl: string; apiKey: string; model: string },
): Promise<void> {
  await dialog.locator("#provider-name").fill(input.name);
  await dialog.locator("#provider-base-url").fill(input.baseUrl);
  await dialog.locator("#provider-api-key").fill(input.apiKey);
  await dialog.getByRole("button", { name: "Fetch", exact: true }).click();
  await expect(
    dialog.getByText(
      "No model catalog was detected. Check the Base URL or enter the model ID below.",
      { exact: true },
    ),
  ).toBeVisible();
  await dialog.locator("#provider-model").fill(input.model);
}

test.setTimeout(1_200_000);

// @lat: [[provider-setup#Active model is picked from configured providers]]
// @lat: [[provider-setup#LLM-provider keys are configured-only, via modals#Named custom providers]]
// Playwright requires its fixtures argument to use object destructuring.
// eslint-disable-next-line no-empty-pattern
test("renames, reroutes, and deletes one stable custom provider in Electron", async ({}) => {
  let harness: ProductAuthHarness | null = null;
  let app: ElectronApplication | null = null;
  let relayServer: Server | null = null;

  try {
    harness = await createProductAuthHarness();
    await prepareExternalRuntime(harness);
    const relay = await startEmptyDiscoveryRelay();
    relayServer = relay.server;
    const launched = await launchRuntimeDesktop(
      harness,
      join(harness.root, "unused-seed"),
    );
    app = launched.app;
    const page = launched.page;

    await authenticateNewProductAccount(harness, app, page, {
      displayName: "Provider lifecycle E2E User",
    });
    await page.evaluate(async () => {
      localStorage.setItem("hermes-locale", "en");
      await window.hermesAPI.setLocale("en");
    });
    await page.reload();
    await expect(page.locator(".layout")).toBeVisible({ timeout: 60_000 });
    await dismissStartupModelPrompt(page);

    // Exercise the real Main -> preload -> Renderer event path that previously
    // left an up-to-date client permanently showing "Downloading 0%".
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        "update-download-progress",
        { percent: 0 },
      );
    });
    await expect(page.locator(".sidebar-update-btn")).toContainText(
      "Downloading 0%",
    );
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        "update-not-available",
      );
    });
    await expect(page.locator(".sidebar-update-btn")).toHaveCount(0);

    await openModelSettings(page);

    const originalDialog = await openAddCustomDialog(page);
    await fillAndFetchCustomProvider(originalDialog, {
      name: ORIGINAL_PROVIDER,
      baseUrl: relay.baseUrl,
      apiKey: ORIGINAL_KEY,
      model: ORIGINAL_MODEL,
    });
    const journalBeforeOriginalSave = modelOperationState(harness.userData);
    await originalDialog
      .getByRole("button", { name: "Add and use", exact: true })
      .click();
    await expect(originalDialog).toBeHidden();
    await expect(serviceCard(page, ORIGINAL_PROVIDER)).toHaveCount(1);
    expect(modelOperationState(harness.userData)).toEqual({
      count: journalBeforeOriginalSave.count + 1,
      latestState: "committed",
    });

    // Reproduce the stale-card sequence from the Beta.33 report: a card first
    // records a discovery failure, then its edit dialog successfully fetches
    // 21 models. The old card error must disappear immediately and the save
    // must persist the complete catalog.
    const originalCardAfterSave = serviceCard(page, ORIGINAL_PROVIDER);
    await originalCardAfterSave
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const cacheBustDialog = page.getByRole("dialog", {
      name: "Edit model service",
    });
    await cacheBustDialog.locator("#provider-api-key").fill(RECOVERY_KEY);
    await cacheBustDialog
      .getByRole("button", { name: "Save and use", exact: true })
      .click();
    await expect(cacheBustDialog).toBeHidden();
    relay.respond(503);
    await originalCardAfterSave
      .getByRole("button", { name: "Refresh models", exact: true })
      .click();
    await expect(
      originalCardAfterSave.locator(".model-service-feedback.error"),
    ).toBeVisible();

    const discoveredModels = [
      ORIGINAL_MODEL,
      ...Array.from(
        { length: 20 },
        (_, index) => `discovered-model-${index + 1}`,
      ),
    ];
    relay.respond(200, discoveredModels);
    await originalCardAfterSave
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const discoveryRecoveryDialog = page.getByRole("dialog", {
      name: "Edit model service",
    });
    await discoveryRecoveryDialog
      .getByRole("button", { name: "Fetch", exact: true })
      .click();
    await expect(
      discoveryRecoveryDialog.getByText("Fetched this time: 21 models", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      originalCardAfterSave.locator(".model-service-feedback.error"),
    ).toHaveCount(0);
    await discoveryRecoveryDialog
      .getByRole("button", { name: "Save and use", exact: true })
      .click();
    await expect(discoveryRecoveryDialog).toBeHidden();
    await expect(originalCardAfterSave).toContainText("21 models");
    relay.respond(200);

    const originalRecord = await page.evaluate(async (providerName) => {
      const profiles = await window.hermesAPI.listProfiles();
      const activeProfile = profiles.find((profile) => profile.isActive);
      if (!activeProfile) throw new Error("Active Profile is missing.");
      const providers = await window.hermesAPI.listCustomProviders(
        activeProfile.id,
      );
      return (
        providers.find((provider) => provider.name === providerName) ?? null
      );
    }, ORIGINAL_PROVIDER);
    expect(originalRecord).not.toBeNull();

    const twinDialog = await openAddCustomDialog(page);
    await fillAndFetchCustomProvider(twinDialog, {
      name: TWIN_PROVIDER,
      baseUrl: relay.baseUrl,
      apiKey: TWIN_KEY,
      model: TWIN_MODEL,
    });
    await expect(
      twinDialog.getByRole("button", { name: "Add", exact: true }),
    ).toBeVisible();
    await twinDialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(twinDialog).toBeHidden();
    await expect(page.locator(".model-service-card")).toHaveCount(2);
    await expect(
      serviceCard(page, ORIGINAL_PROVIDER).getByTitle(ORIGINAL_MODEL),
    ).toBeVisible();
    await expect(
      serviceCard(page, ORIGINAL_PROVIDER).getByTitle(TWIN_MODEL),
    ).toHaveCount(0);
    await expect(
      serviceCard(page, TWIN_PROVIDER).getByTitle(TWIN_MODEL),
    ).toBeVisible();
    await expect(
      serviceCard(page, TWIN_PROVIDER).getByTitle(ORIGINAL_MODEL),
    ).toHaveCount(0);
    // Saving a second provider is additive. It must not silently replace the
    // route that was already the user's default.
    await expect(
      serviceCard(page, ORIGINAL_PROVIDER).locator(
        ".model-service-badge.current",
      ),
    ).toBeVisible();
    await expect(
      serviceCard(page, TWIN_PROVIDER).locator(".model-service-badge.current"),
    ).toHaveCount(0);

    // An explicit card action carries the stable provider identity through the
    // coordinator. First make the new provider active, then switch back to the
    // older provider; this exercises the formerly failing named-provider path.
    await serviceCard(page, TWIN_PROVIDER)
      .getByRole("button", { name: "Set as default", exact: true })
      .click();
    await expect(
      serviceCard(page, TWIN_PROVIDER).locator(".model-service-badge.current"),
    ).toBeVisible();
    await serviceCard(page, ORIGINAL_PROVIDER)
      .getByRole("button", { name: "Set as default", exact: true })
      .click();
    await expect(
      serviceCard(page, ORIGINAL_PROVIDER).locator(
        ".model-service-badge.current",
      ),
    ).toBeVisible();

    // Make the original provider non-default again, then edit/save it. This
    // is the exact regression that used to fail final route verification and
    // restore the whole configuration.
    await serviceCard(page, TWIN_PROVIDER)
      .getByRole("button", { name: "Set as default", exact: true })
      .click();
    await expect(
      serviceCard(page, TWIN_PROVIDER).locator(".model-service-badge.current"),
    ).toBeVisible();

    const originalCard = serviceCard(page, ORIGINAL_PROVIDER);
    await originalCard
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const renameDialog = page.getByRole("dialog", {
      name: "Edit model service",
    });
    await expect(renameDialog).toBeVisible();
    await renameDialog.locator("#provider-name").fill(RENAMED_PROVIDER);
    await renameDialog.locator("#provider-api-key").fill(RENAMED_KEY);
    await renameDialog
      .getByRole("button", { name: "Fetch", exact: true })
      .click();
    await expect(
      renameDialog.getByText(
        "No model catalog was detected. Check the Base URL or enter the model ID below.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      renameDialog.getByRole("button", { name: "Save", exact: true }),
    ).toBeVisible();
    await renameDialog
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(renameDialog).toBeHidden();
    expect(modelOperationState(harness.userData).latestState).toBe("committed");

    await expect(page.locator(".model-service-card")).toHaveCount(2);
    await expect(serviceCard(page, ORIGINAL_PROVIDER)).toHaveCount(0);
    await expect(serviceCard(page, RENAMED_PROVIDER)).toHaveCount(1);
    await expect(serviceCard(page, TWIN_PROVIDER)).toHaveCount(1);
    await expect(
      serviceCard(page, TWIN_PROVIDER).locator(".model-service-badge.current"),
    ).toBeVisible();
    await expect(
      serviceCard(page, RENAMED_PROVIDER).locator(
        ".model-service-badge.current",
      ),
    ).toHaveCount(0);

    const renamedRecord = await page.evaluate(async (providerName) => {
      const profiles = await window.hermesAPI.listProfiles();
      const activeProfile = profiles.find((profile) => profile.isActive);
      if (!activeProfile) throw new Error("Active Profile is missing.");
      const providers = await window.hermesAPI.listCustomProviders(
        activeProfile.id,
      );
      const env = await window.hermesAPI.getEnv(activeProfile.id);
      return {
        provider:
          providers.find((provider) => provider.name === providerName) ?? null,
        env,
      };
    }, RENAMED_PROVIDER);
    expect(renamedRecord.provider?.id).toBe(originalRecord?.id);
    expect(
      renamedRecord.env[customProviderEnvKey(ORIGINAL_PROVIDER)] ?? "",
    ).toBe("");
    expect(renamedRecord.env[customProviderEnvKey(RENAMED_PROVIDER)]).toBe(
      RENAMED_KEY,
    );

    const renamedCard = serviceCard(page, RENAMED_PROVIDER);
    await renamedCard
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const rerouteDialog = page.getByRole("dialog", {
      name: "Edit model service",
    });
    await expect(rerouteDialog).toBeVisible();
    await expect(rerouteDialog.locator("#provider-api-key")).toHaveValue(
      RENAMED_KEY,
    );
    await rerouteDialog
      .locator("#provider-base-url")
      .fill(relay.alternateBaseUrl);
    await rerouteDialog.locator("#provider-api-key").fill(UPDATED_KEY);
    await rerouteDialog
      .getByRole("button", { name: "Fetch", exact: true })
      .click();
    await expect(
      rerouteDialog.getByText(
        "No model catalog was detected. Check the Base URL or enter the model ID below.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      rerouteDialog.getByRole("button", { name: "Save", exact: true }),
    ).toBeVisible();
    await rerouteDialog
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(rerouteDialog).toBeHidden();
    await expect(page.locator(".model-service-card")).toHaveCount(2);
    await expect(
      renamedCard.getByText(relay.alternateBaseUrl, { exact: true }),
    ).toBeVisible();

    const twinCard = serviceCard(page, TWIN_PROVIDER);
    await expect(
      twinCard.locator(".model-service-badge.current"),
    ).toBeVisible();

    await renamedCard
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    const deleteDialog = page.getByRole("dialog", {
      name: "Delete model service",
    });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog
      .getByRole("button", { name: "Delete service", exact: true })
      .click();
    await expect(deleteDialog).toBeHidden();
    await expect(page.locator(".model-service-card")).toHaveCount(1);
    await expect(serviceCard(page, RENAMED_PROVIDER)).toHaveCount(0);
    await expect(serviceCard(page, TWIN_PROVIDER)).toHaveCount(1);
    await expect(
      twinCard.locator(".model-service-badge.current"),
    ).toBeVisible();

    const finalState = await page.evaluate(async () => {
      const profiles = await window.hermesAPI.listProfiles();
      const activeProfile = profiles.find((profile) => profile.isActive);
      if (!activeProfile) throw new Error("Active Profile is missing.");
      const [providers, env, modelConfig] = await Promise.all([
        window.hermesAPI.listCustomProviders(activeProfile.id),
        window.hermesAPI.getEnv(activeProfile.id),
        window.hermesAPI.getModelConfig(activeProfile.id),
      ]);
      return { providers, env, modelConfig };
    });
    expect(finalState.providers).toHaveLength(1);
    expect(finalState.providers[0]?.name).toBe(TWIN_PROVIDER);
    expect(finalState.env[customProviderEnvKey(RENAMED_PROVIDER)] ?? "").toBe(
      "",
    );
    expect(finalState.env[customProviderEnvKey(TWIN_PROVIDER)]).toBe(TWIN_KEY);
    expect(finalState.modelConfig.model).toBe(TWIN_MODEL);
    expect(relay.authorizationHeaders).toContain(`Bearer ${ORIGINAL_KEY}`);
    expect(relay.authorizationHeaders).toContain(`Bearer ${RENAMED_KEY}`);
    expect(relay.authorizationHeaders).toContain(`Bearer ${UPDATED_KEY}`);
    expect(relay.authorizationHeaders).toContain(`Bearer ${TWIN_KEY}`);
  } finally {
    await app?.close().catch(() => undefined);
    await closeServer(relayServer);
    await closeProductAuthHarness(harness);
  }
});
