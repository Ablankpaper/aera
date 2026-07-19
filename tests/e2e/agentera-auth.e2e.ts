import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  _electron as electron,
  chromium,
  expect,
  test,
  type Browser,
  type ElectronApplication,
  type Page,
} from "playwright/test";

const desktopRoot = resolve(process.cwd());
const cloudRoot = resolve(desktopRoot, "../aera-cloud");
const cloudOrigin = "http://127.0.0.1:8086";
const password = "AgentEra E2E battery staple 2026";
const firstPhone = "+8613900000001";
const secondPhone = "+8613900000002";

type PublicAuthState = {
  status: string;
  reason?: string;
  userId?: string;
  personalSpaceId?: string;
  deviceId?: string;
  offlineExpiresAt?: string;
};

type SMSDelivery = {
  to: string;
  code: string;
  purpose: string;
};

type Harness = {
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
  boundaryFiles: string[];
};

let harness: Harness | null = null;
let cloudProcess: ChildProcess | null = null;
let browser: Browser | null = null;
let browserPage: Page | null = null;
let desktopApp: ElectronApplication | null = null;
let desktopPage: Page | null = null;

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
      `${executable} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
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

async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    const server = createServer();
    server.once("error", () => resolveAvailability(false));
    server.listen(port, "127.0.0.1", () =>
      server.close(() => resolveAvailability(true)),
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

async function writeHermesBoundaryFixture(root: string): Promise<string[]> {
  const files: Record<string, string> = {
    ".env": "OPENAI_API_KEY=e2e-synthetic-only\n",
    "MEMORY.md": "# Synthetic E2E memory boundary\n",
    "USER.md": "# Synthetic E2E user boundary\n",
    "sessions/session.json": '{"synthetic":true}\n',
    "files/note.txt": "synthetic fixture only\n",
    "skills/example/SKILL.md": "# Synthetic skill boundary\n",
    "curator/state.json": '{"synthetic":true}\n',
  };
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }

  const python = join(root, "hermes-agent/venv/bin/python");
  const hermes = join(root, "hermes-agent/hermes");
  await mkdir(dirname(python), { recursive: true });
  await writeFile(
    python,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Python 3.11.0"; fi\nexit 0\n',
    "utf8",
  );
  await writeFile(hermes, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(python, 0o755);
  await chmod(hermes, 0o755);
  return Object.keys(files).sort();
}

async function boundaryHashes(
  hermesHome: string,
  files: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const relative of files) {
    result[relative] = createHash("sha256")
      .update(await readFile(join(hermesHome, relative)))
      .digest("hex");
  }
  return result;
}

function composeEnvironment(current: Harness): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AERA_CLOUD_POSTGRES_BIND: `127.0.0.1:${current.postgresPort}`,
    AERA_CLOUD_REDIS_BIND: `127.0.0.1:${current.redisPort}`,
  };
}

function startCompose(current: Harness): void {
  command(
    "docker",
    ["compose", "-p", current.composeProject, "up", "-d", "--wait"],
    { cwd: cloudRoot, env: composeEnvironment(current) },
  );
}

function stopCompose(current: Harness): void {
  command(
    "docker",
    ["compose", "-p", current.composeProject, "down", "-v", "--remove-orphans"],
    { cwd: cloudRoot, env: composeEnvironment(current) },
  );
}

async function waitForReady(
  process: ChildProcess,
  logs: () => string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`AgentEra cloud exited before readiness.\n${logs()}`);
    }
    try {
      const response = await fetch(`${cloudOrigin}/health/ready`);
      if (response.ok) return;
    } catch {
      // The listener is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`AgentEra cloud did not become ready.\n${logs()}`);
}

async function startCloud(current: Harness): Promise<ChildProcess> {
  const base = parseDevelopmentEnvironment(
    await readFile(join(cloudRoot, ".env.example"), "utf8"),
  );
  const child = spawn(current.cloudBinary, [], {
    cwd: cloudRoot,
    env: {
      ...process.env,
      ...base,
      AGENTERA_CLOUD_LISTEN_ADDR: "127.0.0.1:8086",
      AGENTERA_CLOUD_PUBLIC_URL: cloudOrigin,
      AGENTERA_CLOUD_DATABASE_URL: `postgres://aera_cloud:aera-cloud-dev-only@127.0.0.1:${current.postgresPort}/aera_cloud?sslmode=disable`,
      AGENTERA_CLOUD_REDIS_ADDR: `127.0.0.1:${current.redisPort}`,
      AGENTERA_CLOUD_SMS_ENDPOINT: `${current.captureOrigin}/sms`,
      AGENTERA_CLOUD_SMS_API_KEY: "e2e-sms-secret",
      AGENTERA_CLOUD_CAPTCHA_ENDPOINT: `${current.captureOrigin}/captcha`,
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
  return child;
}

async function stopCloud(child: ChildProcess | null): Promise<void> {
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

async function launchDesktop(current: Harness): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const executablePath = process.env.AGENTERA_E2E_EXECUTABLE_PATH?.trim();
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath
      ? [`--user-data-dir=${current.userData}`]
      : [".", `--user-data-dir=${current.userData}`],
    cwd: desktopRoot,
    env: {
      ...process.env,
      AGENTERA_CLOUD_PUBLIC_URL: cloudOrigin,
      HERMES_HOME: current.hermesHome,
      HERMES_OPEN_DEVTOOLS: "0",
      HERMES_DESKTOP_OPEN_DEVTOOLS: "0",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
  });
  // Electron can still be replacing its initial inspector context while the
  // application module creates the first window. Wait for that stable context
  // before installing the external-navigation capture hook.
  const page = await app.firstWindow();
  await app.evaluate(({ shell }) => {
    const globalState = globalThis as typeof globalThis & {
      __agenteraE2EExternalUrls?: string[];
    };
    globalState.__agenteraE2EExternalUrls = [];
    shell.openExternal = async (url: string): Promise<void> => {
      globalState.__agenteraE2EExternalUrls?.push(url);
    };
  });
  return { app, page };
}

async function expectSecureAuthStorage(
  current: Harness,
  app: ElectronApplication,
): Promise<void> {
  await expect(
    app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable()),
  ).resolves.toBe(true);

  const serialized = await readFile(
    join(current.userData, "agentera-auth", "state.json"),
    "utf8",
  );
  const envelope = JSON.parse(serialized) as {
    installation?: Record<string, unknown> | null;
    productSession?: Record<string, unknown> | null;
  };
  expect(serialized).not.toContain(password);
  expect(serialized).not.toContain(firstPhone);
  expect(serialized).not.toMatch(
    /"(?:devicePrivateKey|refreshToken|offlineEntitlement)"\s*:/,
  );
  expect(envelope.installation?.encryptedDevicePrivateKey).toMatch(
    /^[A-Za-z0-9+/]+={0,2}$/,
  );
  expect(envelope.productSession?.encryptedRefreshToken).toMatch(
    /^[A-Za-z0-9+/]+={0,2}$/,
  );
  expect(envelope.productSession?.encryptedOfflineEntitlement).toMatch(
    /^[A-Za-z0-9+/]+={0,2}$/,
  );
}

async function externalURLs(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const globalState = globalThis as typeof globalThis & {
      __agenteraE2EExternalUrls?: string[];
    };
    return [...(globalState.__agenteraE2EExternalUrls ?? [])];
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

async function authState(page: Page): Promise<PublicAuthState> {
  return page.evaluate(() => window.agenteraAuth.getState());
}

async function waitForCode(
  current: Harness,
  destination: string,
  purpose: string,
): Promise<string> {
  await expect
    .poll(
      () =>
        current.deliveries.findLast(
          (delivery) =>
            delivery.to === destination && delivery.purpose === purpose,
        )?.code ?? "",
    )
    .toMatch(/^\d{6}$/);
  return current.deliveries.findLast(
    (delivery) => delivery.to === destination && delivery.purpose === purpose,
  )?.code as string;
}

async function registerPhoneAccount(
  page: Page,
  current: Harness,
  phone: string,
  nickname: string,
): Promise<void> {
  await page.locator('input[name="kind"]').nth(1).check();
  await page.locator('input[type="tel"]').fill(phone);
  await page.locator("button.secondary-button").first().click();
  const code = await waitForCode(current, phone, "registration");
  await page.locator('input[inputmode="numeric"]').fill(code);
  await page.locator(".inline-form button.secondary-button").click();
  const passwords = page.locator('input[type="password"]');
  await expect(passwords).toHaveCount(2);
  await page.locator('input[autocomplete="nickname"]').fill(nickname);
  await passwords.nth(0).fill(password);
  await passwords.nth(1).fill(password);
  await page.locator('input[type="checkbox"]').check();
  await page.locator('button[type="submit"].primary-button').click();
  await expect(page.locator(".completion-card")).toBeVisible();
}

async function loginBrowser(page: Page, phone: string): Promise<void> {
  await page.locator('input[autocomplete="username"]').fill(phone);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator('button[type="submit"].primary-button').click();
}

async function approveAuthorization(page: Page): Promise<void> {
  const approve = page.locator("button.primary-button");
  await expect(approve).toBeVisible();
  await approve.click({ noWaitAfter: true });
}

test.beforeAll(async () => {
  if (!(await portAvailable(8086))) {
    throw new Error(
      "AgentEra E2E requires the reviewed loopback issuer port 8086 to be free.",
    );
  }
  const root = await mkdtemp(join(tmpdir(), "agentera-auth-e2e-"));
  const userData = join(root, "electron-user-data");
  const hermesHome = join(root, "hermes-boundary");
  await mkdir(userData, { recursive: true });
  await mkdir(hermesHome, { recursive: true });
  const capture = await createCaptureServer();
  harness = {
    root,
    userData,
    hermesHome,
    cloudBinary: join(root, "aera-cloud"),
    postgresPort: await freePort(),
    redisPort: await freePort(),
    composeProject: `agentera-auth-e2e-${process.pid}`,
    captureServer: capture.server,
    captureOrigin: capture.origin,
    deliveries: capture.deliveries,
    boundaryFiles: await writeHermesBoundaryFixture(hermesHome),
  };
  startCompose(harness);
  command("go", ["build", "-o", harness.cloudBinary, "./cmd/aera-cloud"], {
    cwd: cloudRoot,
  });
  cloudProcess = await startCloud(harness);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US" });
  browserPage = await context.newPage();
});

test.afterAll(async () => {
  await desktopApp?.close().catch(() => undefined);
  desktopApp = null;
  desktopPage = null;
  await browser?.close().catch(() => undefined);
  browser = null;
  browserPage = null;
  await stopCloud(cloudProcess);
  cloudProcess = null;
  if (harness) {
    await new Promise<void>((resolveClose) =>
      harness?.captureServer.close(() => resolveClose()),
    );
    stopCompose(harness);
    await rm(harness.root, { recursive: true, force: true });
    harness = null;
  }
});

test("browser registration, offline renewal, ownership isolation, revoke, and deletion preserve Hermes boundaries", async () => {
  if (!harness || !browserPage) throw new Error("E2E harness is unavailable.");
  const initialHashes = await boundaryHashes(
    harness.hermesHome,
    harness.boundaryFiles,
  );

  ({ app: desktopApp, page: desktopPage } = await launchDesktop(harness));
  await expect(
    desktopPage.locator('[data-testid="screen-auth"]'),
  ).toBeVisible();
  const firstAuthorizationURL = await captureExternalURL(
    desktopApp,
    () =>
      desktopPage?.locator(".agentera-gate-primary").click() ??
      Promise.resolve(),
  );
  expect(new URL(firstAuthorizationURL).origin).toBe(cloudOrigin);

  await browserPage.goto(firstAuthorizationURL);
  await browserPage.waitForURL(/\/authorize\?request_id=/);
  const firstApprovalURL = browserPage.url();
  await browserPage.locator('a[href^="/login?next="]').click();
  await browserPage.locator('a[href="/register"]').click();
  await registerPhoneAccount(
    browserPage,
    harness,
    firstPhone,
    "First E2E User",
  );
  await browserPage.locator("button.primary-button").click();
  await loginBrowser(browserPage, firstPhone);
  await browserPage.waitForURL(/\/account$/);
  await browserPage.goto(firstApprovalURL);
  await approveAuthorization(browserPage);

  await expect(
    desktopPage.locator('[data-testid="screen-profile-claim"]'),
  ).toBeVisible();
  await desktopPage.locator(".agentera-profile-actions .btn-primary").click();
  await expect(desktopPage.locator(".layout")).toBeVisible();
  const firstOnline = await authState(desktopPage);
  expect(firstOnline.status).toBe("authenticated");
  expect(firstOnline.offlineExpiresAt).toBeTruthy();
  await expectSecureAuthStorage(harness, desktopApp);
  await desktopPage.evaluate(() =>
    window.hermesAPI.abortChat("agentera-e2e-noop"),
  );
  expect(
    await boundaryHashes(harness.hermesHome, harness.boundaryFiles),
  ).toEqual(initialHashes);

  await desktopApp.close();
  desktopApp = null;
  desktopPage = null;
  await stopCloud(cloudProcess);
  cloudProcess = null;

  ({ app: desktopApp, page: desktopPage } = await launchDesktop(harness));
  await expect(desktopPage.locator(".layout")).toBeVisible();
  const offline = await authState(desktopPage);
  expect(offline.status).toBe("offline");
  await expect(desktopPage.locator(".agentera-offline-banner")).toBeVisible();
  await desktopPage.evaluate(() =>
    window.hermesAPI.abortChat("agentera-e2e-offline-noop"),
  );

  cloudProcess = await startCloud(harness);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
  const recovered = await desktopPage.evaluate(() =>
    window.agenteraAuth.retryOnline(),
  );
  expect(recovered.status).toBe("authenticated");
  expect(Date.parse(recovered.offlineExpiresAt ?? "")).toBeGreaterThan(
    Date.parse(firstOnline.offlineExpiresAt ?? ""),
  );
  await expect(desktopPage.locator(".agentera-offline-banner")).toHaveCount(0);

  await browserPage.goto(`${cloudOrigin}/devices`);
  await expect(browserPage.locator(".device-row")).toHaveCount(1);
  await browserPage.locator(".device-row button.danger-outline").click();
  await browserPage.locator("button.danger-button").click();
  await expect(browserPage.locator(".device-row")).toHaveCount(0);
  const revoked = await desktopPage.evaluate(() =>
    window.agenteraAuth.retryOnline(),
  );
  expect(revoked.status).toBe("blocked");
  expect(revoked.reason).toBe("device_revoked");
  await expect(
    desktopPage.locator('[data-testid="screen-auth"]'),
  ).toBeVisible();

  const sameAccountAuthorizationURL = await captureExternalURL(
    desktopApp,
    () =>
      desktopPage?.locator(".agentera-gate-primary").click() ??
      Promise.resolve(),
  );
  await browserPage.goto(sameAccountAuthorizationURL);
  await browserPage.waitForURL(/\/authorize\?request_id=/);
  await approveAuthorization(browserPage);
  await expect(desktopPage.locator(".layout")).toBeVisible();
  expect(
    await boundaryHashes(harness.hermesHome, harness.boundaryFiles),
  ).toEqual(initialHashes);

  await browserPage.goto(`${cloudOrigin}/register`);
  await registerPhoneAccount(
    browserPage,
    harness,
    secondPhone,
    "Second E2E User",
  );
  const secondAccountAuthorizationURL = await captureExternalURL(
    desktopApp,
    async () => {
      await desktopPage?.locator(".agentera-account-trigger").click();
      await desktopPage?.locator('[role="menuitem"]').nth(3).click();
    },
  );
  await browserPage.goto(secondAccountAuthorizationURL);
  await browserPage.waitForURL(/\/login\?next=/);
  await loginBrowser(browserPage, secondPhone);
  await browserPage.waitForURL(/\/authorize\?request_id=/);
  await approveAuthorization(browserPage);
  await expect(
    desktopPage.locator('[data-testid="screen-profile-claim"]'),
  ).toBeVisible();
  await expect(desktopPage.locator(".layout")).toHaveCount(0);

  await browserPage.goto(`${cloudOrigin}/delete-account`);
  await browserPage.locator("form input").first().fill(secondPhone);
  await browserPage.locator("button.secondary-button").first().click();
  const deletionCode = await waitForCode(
    harness,
    secondPhone,
    "account_deletion",
  );
  await browserPage.locator('input[inputmode="numeric"]').fill(deletionCode);
  await browserPage.locator("button.secondary-button").last().click();
  await browserPage.locator('input[type="password"]').fill(password);
  await browserPage.locator('input[type="checkbox"]').check();
  await browserPage.locator('button[type="submit"].danger-button').click();
  await expect(browserPage.locator(".status.status-success")).toBeVisible();

  const deleted = await desktopPage.evaluate(() =>
    window.agenteraAuth.retryOnline(),
  );
  expect(deleted.status).toBe("blocked");
  expect(deleted.reason).toBe("account_pending_deletion");
  await desktopPage.evaluate(() => window.agenteraAuth.logout());
  await expect(
    desktopPage.locator('[data-testid="screen-auth"]'),
  ).toBeVisible();
  expect(
    await boundaryHashes(harness.hermesHome, harness.boundaryFiles),
  ).toEqual(initialHashes);
});
