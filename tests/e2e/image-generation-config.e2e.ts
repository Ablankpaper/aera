import { chmod } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "playwright/test";

import {
  authenticateNewProductAccount,
  closeProductAuthHarness,
  createProductAuthHarness,
  launchRuntimeDesktop,
  type ProductAuthHarness,
} from "./support/agentera-product-auth-harness";

const FIXTURE_MODEL = "gpt-image-fixture-e2e";
const FIXTURE_API_KEY = "image-generation-e2e-key";
const FIXTURE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==";
const FIXTURE_RUNTIME_VERSION = "Hermes image generation E2E";

interface RelayState {
  authorizationHeaders: string[];
  discoveryRequests: number;
  generationRequests: number;
  generationRequestBodies: unknown[];
}

async function startFixtureRelay(): Promise<{
  baseUrl: string;
  server: Server;
  state: RelayState;
}> {
  const state: RelayState = {
    authorizationHeaders: [],
    discoveryRequests: 0,
    generationRequests: 0,
    generationRequestBodies: [],
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      state.authorizationHeaders.push(request.headers.authorization ?? "");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        state.discoveryRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: FIXTURE_MODEL, object: "model", owned_by: "aera-e2e" },
              { id: "chat-fixture-e2e", object: "model", owned_by: "aera-e2e" },
            ],
          }),
        );
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/images/generations"
      ) {
        state.generationRequests += 1;
        let body = "";
        for await (const chunk of request) body += String(chunk);
        state.generationRequestBodies.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ data: [{ b64_json: FIXTURE_PNG_BASE64 }] }),
        );
        return;
      }
      response.writeHead(404).end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Image generation fixture relay did not expose a port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    server,
    state,
  };
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

async function enterMainLayout(page: Page): Promise<void> {
  const mainLayout = page.locator(".layout");
  await expect(mainLayout).toBeVisible({ timeout: 60_000 });
}

async function dismissStartupModelPrompt(page: Page): Promise<void> {
  const prompt = page.locator(".startup-model-prompt");
  await prompt
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => undefined);
  if (await prompt.isVisible()) {
    await prompt.getByRole("button", { name: /^(Later|稍后)$/u }).click();
    await expect(page.locator(".app-modal-overlay")).toHaveCount(0);
  }
}

async function openToolsSettings(page: Page): Promise<void> {
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
    .filter({ hasText: /^Capabilities$|^工具$/u })
    .click();
  await expect(settingsPage.locator(".image-generation-config")).toBeVisible();
}

async function screenshot(
  page: Page,
  testInfo: { outputPath: (...paths: string[]) => string },
  name: string,
): Promise<void> {
  await page.screenshot({
    path: testInfo.outputPath(name),
    fullPage: false,
  });
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

test.setTimeout(1_200_000);

// @lat: [[image-generation#Secret-free Desktop configuration]]
// @lat: [[image-generation#Responsive UI acceptance]]
// @lat: [[image-generation#Local configuration disclosure]]
// Playwright requires its fixtures argument to use object destructuring.
// eslint-disable-next-line no-empty-pattern
test("configures and previews one relay-backed image in an isolated Electron Profile", async ({}, testInfo) => {
  let harness: ProductAuthHarness | null = null;
  let app: ElectronApplication | null = null;
  let relayServer: Server | null = null;

  try {
    harness = await createProductAuthHarness();
    await prepareExternalRuntime(harness);
    const relay = await startFixtureRelay();
    relayServer = relay.server;
    const launched = await launchRuntimeDesktop(
      harness,
      join(harness.root, "unused-seed"),
    );
    app = launched.app;
    const page = launched.page;
    await authenticateNewProductAccount(harness, app, page, {
      displayName: "Image generation E2E User",
    });
    await enterMainLayout(page);
    await dismissStartupModelPrompt(page);
    await expect(
      page
        .locator(".sidebar-nav-pinned")
        .getByRole("button", { name: /^Office$|^工作区$/u }),
    ).toHaveCount(0);
    const activeProfile = await page.evaluate(async () => {
      const profiles = await window.hermesAPI.listProfiles();
      return profiles.find((profile) => profile.isActive) ?? null;
    });
    if (!activeProfile) throw new Error("Isolated active Profile is missing.");
    await openToolsSettings(page);

    const settingsPage = page.locator(".settings-page");
    const imageCard = settingsPage
      .locator(".tools-card")
      .filter({ hasText: /Image Generation|图像生成/u });
    await expect(imageCard.locator('input[type="checkbox"]')).toBeChecked();
    const serviceToggle = settingsPage.locator(
      ".image-generation-heading .tools-toggle",
    );
    const serviceToggleInput = serviceToggle.locator('input[type="checkbox"]');
    await expect(serviceToggleInput).toBeChecked();
    await expect(
      settingsPage.locator("#image-generation-api-key"),
    ).toHaveAttribute("type", "password");

    const disclosure = settingsPage.getByRole("button", {
      name: /^Image generation service$|^图像生成服务$/u,
    });
    const configBody = settingsPage.locator(".image-generation-body");
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await settingsPage
      .locator("#image-generation-model")
      .fill("unsaved-image-model");
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(configBody).toBeHidden();
    await expect(serviceToggle).toBeVisible();
    await expect(serviceToggleInput).toBeChecked();
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(configBody).toBeVisible();
    await expect(settingsPage.locator("#image-generation-model")).toHaveValue(
      "unsaved-image-model",
    );

    await settingsPage
      .locator("#image-generation-base-url")
      .fill(relay.baseUrl);
    await settingsPage
      .locator("#image-generation-api-key")
      .fill(FIXTURE_API_KEY);
    await settingsPage.locator("#image-generation-model").fill(FIXTURE_MODEL);
    await settingsPage
      .getByRole("button", { name: /Discover models|发现模型/u })
      .click();
    await expect.poll(() => relay.state.discoveryRequests).toBe(1);
    await expect(
      settingsPage.locator(
        `#image-generation-models option[value="${FIXTURE_MODEL}"]`,
      ),
    ).toHaveCount(1);
    expect(relay.state.generationRequests).toBe(0);

    await settingsPage.getByRole("button", { name: /^Save$|^保存$/u }).click();
    await expect(settingsPage.locator("#image-generation-api-key")).toHaveValue(
      "",
    );
    await expect(
      settingsPage.locator(".image-generation-key-status"),
    ).toBeVisible();
    expect(relay.state.generationRequests).toBe(0);
    const publicConfig = await page.evaluate(
      (profile) => window.hermesAPI.getImageGenerationConfig(profile),
      activeProfile.id,
    );
    expect(publicConfig).toMatchObject({
      success: true,
      config: {
        enabled: true,
        hasApiKey: true,
        baseUrl: relay.baseUrl,
        model: FIXTURE_MODEL,
      },
    });
    expect(JSON.stringify(publicConfig)).not.toContain(FIXTURE_API_KEY);

    await settingsPage
      .getByRole("button", { name: /Test generation|测试生成/u })
      .click();
    expect(relay.state.generationRequests).toBe(0);
    await expect(
      settingsPage.getByText(/one paid image request|一次付费生图请求/u),
    ).toBeVisible();
    await settingsPage
      .getByRole("button", { name: /Confirm test|确认测试/u })
      .click();
    await expect.poll(() => relay.state.generationRequests).toBe(1);
    await expect(
      settingsPage.locator(".image-generation-preview img"),
    ).toBeVisible();
    expect(relay.state.authorizationHeaders).toEqual([
      `Bearer ${FIXTURE_API_KEY}`,
      `Bearer ${FIXTURE_API_KEY}`,
    ]);
    expect(relay.state.generationRequestBodies).toEqual([
      expect.objectContaining({ model: FIXTURE_MODEL, n: 1 }),
    ]);
    await screenshot(page, testInfo, "image-generation-desktop.png");

    await page.setViewportSize({ width: 700, height: 900 });
    await expect(
      settingsPage.locator(".image-generation-config"),
    ).toBeVisible();
    const narrowOverflow = await page.evaluate(() => ({
      body:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      pane: (() => {
        const pane = document.querySelector<HTMLElement>(".tools-pane");
        return pane ? pane.scrollWidth - pane.clientWidth : -1;
      })(),
    }));
    expect(narrowOverflow.body).toBeLessThanOrEqual(1);
    expect(narrowOverflow.pane).toBeLessThanOrEqual(1);
    await screenshot(page, testInfo, "image-generation-narrow.png");

    await page.setViewportSize({ width: 2200, height: 1700 });
    await serviceToggle.scrollIntoViewIfNeeded();
    await serviceToggle.click();
    await expect(serviceToggleInput).not.toBeChecked();
    await settingsPage.getByRole("button", { name: /^Save$|^保存$/u }).click();
    await expect(settingsPage.locator(".image-generation-config")).toHaveCount(
      0,
    );
    await expect(imageCard.locator('input[type="checkbox"]')).not.toBeChecked();
    const disabledConfig = await page.evaluate(
      (profile) => window.hermesAPI.getImageGenerationConfig(profile),
      activeProfile.id,
    );
    expect(disabledConfig).toMatchObject({
      success: true,
      config: { enabled: false, status: "disabled" },
    });

    await imageCard.locator(".tools-toggle").click();
    await expect(imageCard.locator('input[type="checkbox"]')).toBeChecked();
    await expect(
      settingsPage.locator(".image-generation-config"),
    ).toBeVisible();
    await expect(
      settingsPage.locator('.image-generation-heading input[type="checkbox"]'),
    ).toBeChecked();
  } finally {
    await app?.close().catch(() => undefined);
    await closeServer(relayServer).catch(() => undefined);
    await closeProductAuthHarness(harness).catch(() => undefined);
  }
});
