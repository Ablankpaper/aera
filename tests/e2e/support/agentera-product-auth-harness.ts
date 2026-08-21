import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  _electron as electron,
  chromium,
  expect,
  type Browser,
  type ElectronApplication,
  type Page,
} from "playwright/test";

const desktopRoot = resolve(process.cwd());
const cloudRoot = resolve(
  process.env.AGENTERA_E2E_CLOUD_ROOT?.trim() ||
    resolve(desktopRoot, "../aera-cloud"),
);
export const productAuthCloudOrigin = "http://127.0.0.1:8086";
const encryptedBackupMinioPort = 59010;
const password = "Aera Runtime E2E battery staple 2026";

export function productAuthorizationLanding(
  url: URL,
): "authorize" | "login" | null {
  if (url.origin !== productAuthCloudOrigin) return null;
  if (url.pathname === "/authorize") {
    return url.searchParams.get("request_id") ? "authorize" : null;
  }
  if (url.pathname !== "/login") return null;

  const next = url.searchParams.get("next");
  if (!next) return null;
  let continuation: URL;
  try {
    continuation = new URL(next, productAuthCloudOrigin);
  } catch {
    return null;
  }
  return continuation.origin === productAuthCloudOrigin &&
    continuation.pathname === "/authorize" &&
    continuation.searchParams.get("request_id")
    ? "login"
    : null;
}

type SMSDelivery = {
  to: string;
  code: string;
  purpose: string;
};

export interface ProductAuthHarness {
  root: string;
  userData: string;
  hermesHome: string;
  cloudBinary: string;
  postgresPort: number;
  redisPort: number;
  composeProject: string;
  captureServer: Server;
  captureOrigin: string;
  deliveries: SMSDelivery[];
  phone: string;
  cloudProcess: ChildProcess | null;
  browser: Browser;
  browserPage: Page;
  composeStarted: boolean;
}

export interface E2ERepositoryRequirement {
  environmentName: string;
  markerPath: string;
  expectedMarker: string;
}

export function requireCleanE2ERepository(
  requirement: E2ERepositoryRequirement,
): string {
  const configured = process.env[requirement.environmentName]?.trim();
  if (!configured) {
    throw new Error(`${requirement.environmentName} is required.`);
  }
  const repository = realpathSync(resolve(configured));
  const topLevel = spawnSync(
    "git",
    ["-C", repository, "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (topLevel.status !== 0) {
    throw new Error(`${requirement.environmentName} is not a Git checkout.`);
  }
  const resolvedTopLevel = realpathSync(topLevel.stdout.trim());
  if (resolvedTopLevel !== repository) {
    throw new Error(
      `${requirement.environmentName} must name the checkout root.`,
    );
  }
  const status = spawnSync("git", ["-C", repository, "status", "--porcelain"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (status.status !== 0 || status.stdout.trim() !== "") {
    throw new Error(`${requirement.environmentName} checkout must be clean.`);
  }
  const marker = readFileSync(join(repository, requirement.markerPath), "utf8");
  if (!marker.includes(requirement.expectedMarker)) {
    throw new Error(
      `${requirement.environmentName} has an unexpected repository identity.`,
    );
  }
  return repository;
}

function command(
  executable: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): void {
  const result = spawnSync(executable, args, {
    ...options,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed (status=${String(
        result.status,
      )}, signal=${String(result.signal)}, error=${String(
        result.error?.message ?? "",
      )})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve an isolated loopback port."));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      );
    });
  });
}

async function assertIssuerPortAvailable(): Promise<void> {
  await new Promise<void>((resolveAvailability, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          "Aera Runtime E2E requires loopback issuer port 8086 to be free.",
        ),
      ),
    );
    server.listen(8086, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolveAvailability())),
    );
  });
}

function parseDevelopmentEnvironment(contents: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator);
    let value = trimmed.slice(separator + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"')))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

async function createCaptureServer(): Promise<{
  server: Server;
  origin: string;
  deliveries: SMSDelivery[];
}> {
  const deliveries: SMSDelivery[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      if (chunks.reduce((total, item) => total + item.length, 0) < 64 * 1024) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (request.url === "/sms" && request.method === "POST") {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            to?: unknown;
            code?: unknown;
            purpose?: unknown;
          };
          if (
            request.headers.authorization !== "Bearer e2e-sms-secret" ||
            typeof body.to !== "string" ||
            typeof body.code !== "string" ||
            typeof body.purpose !== "string"
          ) {
            response.writeHead(400).end();
            return;
          }
          deliveries.push({
            to: body.to,
            code: body.code,
            purpose: body.purpose,
          });
          response.writeHead(202, { "Content-Type": "application/json" });
          response.end('{"status":"accepted"}');
          return;
        } catch {
          response.writeHead(400).end();
          return;
        }
      }
      if (request.url === "/captcha" && request.method === "POST") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"success":true}');
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Verification capture server did not bind to loopback.");
  }
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    deliveries,
  };
}

function composeEnvironment(harness: ProductAuthHarness): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AERA_CLOUD_POSTGRES_BIND: `127.0.0.1:${harness.postgresPort}`,
    AERA_CLOUD_REDIS_BIND: `127.0.0.1:${harness.redisPort}`,
  };
}

async function waitForReady(
  process: ChildProcess,
  logs: () => string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Aera cloud exited before readiness.\n${logs()}`);
    }
    try {
      const response = await fetch(`${productAuthCloudOrigin}/health/ready`);
      if (response.ok) return;
    } catch {
      // The listener is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Aera cloud did not become ready.\n${logs()}`);
}

export async function startProductAuthCloud(
  harness: ProductAuthHarness,
): Promise<void> {
  if (harness.cloudProcess?.exitCode === null) return;
  const base = parseDevelopmentEnvironment(
    await readFile(join(cloudRoot, ".env.example"), "utf8"),
  );
  const child = spawn(harness.cloudBinary, [], {
    cwd: cloudRoot,
    env: {
      ...process.env,
      ...base,
      AGENTERA_CLOUD_LISTEN_ADDR: "127.0.0.1:8086",
      AGENTERA_CLOUD_PUBLIC_URL: productAuthCloudOrigin,
      AGENTERA_CLOUD_DATABASE_URL: `postgres://aera_cloud:aera-cloud-dev-only@127.0.0.1:${harness.postgresPort}/aera_cloud?sslmode=disable`,
      AGENTERA_CLOUD_REDIS_ADDR: `127.0.0.1:${harness.redisPort}`,
      AGENTERA_CLOUD_SMS_ENDPOINT: `${harness.captureOrigin}/sms`,
      AGENTERA_CLOUD_SMS_API_KEY: "e2e-sms-secret",
      AGENTERA_CLOUD_CAPTCHA_ENDPOINT: `${harness.captureOrigin}/captcha`,
      AGENTERA_CLOUD_CAPTCHA_SECRET: "e2e-captcha-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString("utf8")}`.slice(-128 * 1024);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  await waitForReady(child, () => output);
  harness.cloudProcess = child;
}

export async function stopProductAuthCloud(
  harness: ProductAuthHarness,
): Promise<void> {
  const child = harness.cloudProcess;
  harness.cloudProcess = null;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) =>
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolveTimeout();
      }, 10_000),
    ),
  ]);
}

export async function createProductAuthHarness(): Promise<ProductAuthHarness> {
  await assertIssuerPortAvailable();
  const root = await mkdtemp(join(tmpdir(), "agentera-runtime-e2e-"));
  let capture: Awaited<ReturnType<typeof createCaptureServer>> | null = null;
  let browser: Browser | null = null;
  let harness: ProductAuthHarness | null = null;
  try {
    const userData = join(root, "electron-user-data");
    const hermesHome = join(root, "hermes-home");
    await mkdir(userData, { recursive: true });
    await mkdir(hermesHome, { recursive: true });
    capture = await createCaptureServer();
    browser = await chromium.launch({ headless: true });
    const browserPage = await (
      await browser.newContext({ locale: "en-US" })
    ).newPage();
    harness = {
      root,
      userData,
      hermesHome,
      cloudBinary: join(root, "aera-cloud"),
      postgresPort: await freePortExcluding(encryptedBackupMinioPort),
      redisPort: await freePortExcluding(encryptedBackupMinioPort),
      composeProject: `agentera-runtime-e2e-${process.pid}`,
      captureServer: capture.server,
      captureOrigin: capture.origin,
      deliveries: capture.deliveries,
      phone: "+8613900000021",
      cloudProcess: null,
      browser,
      browserPage,
      composeStarted: false,
    };
    command(
      "docker",
      [
        "compose",
        "-p",
        harness.composeProject,
        "up",
        "-d",
        "--wait",
        "postgres",
        "redis",
        "encrypted-backup-minio",
      ],
      { cwd: cloudRoot, env: composeEnvironment(harness) },
    );
    harness.composeStarted = true;
    command("go", ["build", "-o", harness.cloudBinary, "./cmd/aera-cloud"], {
      cwd: cloudRoot,
    });
    await startProductAuthCloud(harness);
    return harness;
  } catch (error) {
    if (harness) {
      await closeProductAuthHarness(harness).catch(() => undefined);
    } else {
      await browser?.close().catch(() => undefined);
      if (capture) {
        const captureServer = capture.server;
        await new Promise<void>((resolveClose) =>
          captureServer.close(() => resolveClose()),
        );
      }
      await rm(root, { recursive: true, force: true });
    }
    throw error;
  }
}

async function freePortExcluding(...excluded: number[]): Promise<number> {
  let port = await freePort();
  while (excluded.includes(port)) port = await freePort();
  return port;
}

export async function closeProductAuthHarness(
  harness: ProductAuthHarness | null,
): Promise<void> {
  if (!harness) return;
  await stopProductAuthCloud(harness).catch(() => undefined);
  await harness.browser.close().catch(() => undefined);
  await new Promise<void>((resolveClose) =>
    harness.captureServer.close(() => resolveClose()),
  );
  if (harness.composeStarted) {
    command(
      "docker",
      [
        "compose",
        "-p",
        harness.composeProject,
        "down",
        "-v",
        "--remove-orphans",
      ],
      { cwd: cloudRoot, env: composeEnvironment(harness) },
    );
  }
  await rm(harness.root, { recursive: true, force: true });
}

export async function launchRuntimeDesktop(
  harness: ProductAuthHarness,
  runtimeSeedDirectory: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const executablePath = process.env.AGENTERA_E2E_EXECUTABLE_PATH?.trim();
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath
      ? [`--user-data-dir=${harness.userData}`]
      : [".", `--user-data-dir=${harness.userData}`],
    cwd: desktopRoot,
    env: {
      ...process.env,
      AGENTERA_CLOUD_PUBLIC_URL: productAuthCloudOrigin,
      AGENTERA_RUNTIME_SEED_DIR: runtimeSeedDirectory,
      HERMES_DESKTOP_USER_DATA_DIR: harness.userData,
      HERMES_HOME: harness.hermesHome,
      HERMES_DISABLE_GPU: "1",
      HERMES_OPEN_DEVTOOLS: "0",
      HERMES_DESKTOP_OPEN_DEVTOOLS: "0",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
  });
  // Electron can still be replacing its initial inspector context while the
  // application module creates the first window. Waiting for that window
  // makes the main-process network guard deterministic without allowing any
  // user action to race ahead of the guard.
  const page = await app.firstWindow();
  await app.evaluate(({ shell }) => {
    const state = globalThis as typeof globalThis & {
      __agenteraE2EExternalUrls?: string[];
      __agenteraE2EPublicFetchAttempts?: string[];
      __agenteraE2EOriginalFetch?: typeof fetch;
    };
    state.__agenteraE2EExternalUrls = [];
    state.__agenteraE2EPublicFetchAttempts = [];
    shell.openExternal = async (url: string): Promise<void> => {
      state.__agenteraE2EExternalUrls?.push(url);
    };
    if (!state.__agenteraE2EOriginalFetch) {
      state.__agenteraE2EOriginalFetch = globalThis.fetch.bind(globalThis);
    }
    const originalFetch = state.__agenteraE2EOriginalFetch;
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(raw);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      ) {
        return originalFetch(input, init);
      }
      state.__agenteraE2EPublicFetchAttempts?.push(url.href);
      throw new TypeError("Public HTTP is blocked by Aera Runtime E2E");
    };
  });
  return { app, page };
}

async function externalURLs(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __agenteraE2EExternalUrls?: string[];
    };
    return [...(state.__agenteraE2EExternalUrls ?? [])];
  });
}

async function captureExternalURL(
  app: ElectronApplication,
  action: () => Promise<void>,
): Promise<string> {
  const before = (await externalURLs(app)).length;
  await action();
  await expect
    .poll(async () => (await externalURLs(app)).length)
    .toBeGreaterThan(before);
  return (await externalURLs(app))[before];
}

async function waitForCode(
  harness: ProductAuthHarness,
  purpose: string,
  phone = harness.phone,
): Promise<string> {
  await expect
    .poll(
      () =>
        harness.deliveries.findLast(
          (delivery) => delivery.to === phone && delivery.purpose === purpose,
        )?.code ?? "",
    )
    .toMatch(/^\d{6}$/);
  return harness.deliveries.findLast(
    (delivery) => delivery.to === phone && delivery.purpose === purpose,
  )?.code as string;
}

export async function authenticateNewProductAccount(
  harness: ProductAuthHarness,
  app: ElectronApplication,
  desktopPage: Page,
  options: { displayName?: string; phone?: string } = {},
): Promise<void> {
  const accountPhone = options.phone?.trim() || harness.phone;
  const displayName = options.displayName?.trim() || "Runtime E2E User";
  if (!/^\+[1-9][0-9]{7,14}$/u.test(accountPhone)) {
    throw new Error("Aera E2E account phone is invalid.");
  }
  const authGate = desktopPage.locator('[data-testid="screen-auth"]');
  await expect(authGate).toBeVisible();
  const loginButton = authGate.locator(".agentera-gate-primary");
  await expect(loginButton).toBeVisible();
  await expect(loginButton).toBeEnabled();
  const authorizationURL = await captureExternalURL(app, () =>
    // Four-client organization tests intentionally keep prior Electron
    // devices alive. After visibility/enabled checks, force avoids a
    // redundant scroll/actionability pass stalling behind those renderers.
    loginButton.click({ force: true }),
  );
  expect(new URL(authorizationURL).origin).toBe(productAuthCloudOrigin);

  const page = harness.browserPage;
  await page.goto(authorizationURL);
  await page.waitForURL((url) => productAuthorizationLanding(url) !== null, {
    timeout: 30_000,
  });
  const landing = productAuthorizationLanding(new URL(page.url()));
  if (landing === "authorize") {
    await page.locator('a[href^="/login?next="]').click();
    await page.waitForURL(
      (url) => productAuthorizationLanding(url) === "login",
      { timeout: 30_000 },
    );
  } else if (landing !== "login") {
    throw new Error("Aera E2E authorization landing is invalid.");
  }
  await page.locator('a[href^="/register?next="]').click();
  await page.locator('input[name="kind"]').nth(1).check();
  await page.locator('input[type="tel"]').fill(accountPhone);
  await page.locator("button.secondary-button").first().click();
  await page
    .locator('input[inputmode="numeric"]')
    .fill(await waitForCode(harness, "registration", accountPhone));
  await page.locator(".inline-form button.secondary-button").click();
  const passwords = page.locator('input[type="password"]');
  await expect(passwords).toHaveCount(2);
  await page.locator('input[autocomplete="nickname"]').fill(displayName);
  await passwords.nth(0).fill(password);
  await passwords.nth(1).fill(password);
  await page.locator('input[type="checkbox"]').check();
  await page.locator('button[type="submit"].primary-button').click();

  await expect
    .poll(async () =>
      desktopPage.evaluate(() => window.agenteraAuth.getState()),
    )
    .toMatchObject({ status: "authenticated" });
}

export async function publicFetchAttempts(
  app: ElectronApplication,
): Promise<string[]> {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __agenteraE2EPublicFetchAttempts?: string[];
    };
    return [...(state.__agenteraE2EPublicFetchAttempts ?? [])];
  });
}
