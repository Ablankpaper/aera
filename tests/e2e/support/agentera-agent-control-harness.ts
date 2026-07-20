import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  _electron as electron,
  chromium,
  expect,
  type Browser,
  type ElectronApplication,
  type Page,
} from "playwright/test";

import type {
  AgenteraAgentControlResult,
  AgenteraAgentInstallationSummary,
} from "../../../src/shared/agentera-agent-control";
import {
  authenticateNewProductAccount,
  type ProductAuthHarness,
} from "./agentera-product-auth-harness";

const desktopRoot = resolve(process.cwd());
const cloudRoot = resolve(desktopRoot, "../aera-cloud");
const cloudPublicOrigin = "http://127.0.0.1:8086";
const password = "AgentEra Runtime E2E battery staple 2026";
const REQUEST_BODY_LIMIT = 8 * 1024 * 1024;

type SMSDelivery = {
  to: string;
  code: string;
  purpose: string;
};

export interface CapturedAgentControlRequest {
  method: string;
  path: string;
  body: unknown;
}

interface CapturedRequest extends CapturedAgentControlRequest {
  contentType: string | null;
  responseStatus?: number;
  responseBody?: unknown;
}

export interface AgentControlDevice {
  name: "A" | "B";
  userData: string;
  hermesHome: string;
  app: ElectronApplication;
  page: Page;
  processOutput: string;
}

export interface AgentControlHarness {
  root: string;
  cloudBinary: string;
  cloudBackendOrigin: string;
  postgresPort: number;
  redisPort: number;
  composeProject: string;
  captureServer: Server;
  captureOrigin: string;
  proxyServer: Server;
  deliveries: SMSDelivery[];
  phone: string;
  cloudProcess: ChildProcess | null;
  browser: Browser;
  browserPage: Page;
  composeStarted: boolean;
  runtimeSeedDirectory: string;
  deviceRoots: Record<"A" | "B", { userData: string; hermesHome: string }>;
  devices: AgentControlDevice[];
  requests: CapturedRequest[];
  failures: string[];
}

export interface CloudAgentControlCounts {
  definitions: number;
  versions: number;
  installations: number;
  runtimeBindings: number;
}

export interface LocalRuntimeBindingState {
  id: string;
  conversationKey: string;
  agentVersionId: string;
  agentInstallationId: string;
  runtimeProfileId: string;
  localAdaptiveStateRevision: string;
}

export interface LocalAgentControlState {
  installations: AgenteraAgentInstallationSummary[];
  bindings: LocalRuntimeBindingState[];
  projectionRoots: string[];
}

type AgenteraMethod =
  | "getState"
  | "listDrafts"
  | "getDraft"
  | "createDraft"
  | "updateDraft"
  | "deleteDraft"
  | "preparePublication"
  | "confirmPublication"
  | "listDefinitions"
  | "listVersions"
  | "listInstallations"
  | "installVersion"
  | "claimVersion"
  | "retryPendingInstallation"
  | "selectInstallationVersion"
  | "archiveInstallation";

function command(
  executable: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): string {
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
  return result.stdout;
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

async function assertPublicPortAvailable(): Promise<void> {
  await new Promise<void>((resolveAvailability, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          "Agent control E2E requires reviewed loopback issuer port 8086 to be free.",
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

async function listen(server: Server, port = 0): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    received += chunk.length;
    if (received > REQUEST_BODY_LIMIT) {
      throw new Error("Captured request body is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseCapturedBody(body: Buffer, contentType: string | null): unknown {
  if (body.length === 0) return null;
  const text = body.toString("utf8");
  if (contentType?.split(";", 1)[0].trim() === "application/json") {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return "[invalid-json]";
    }
  }
  return text;
}

function forwardedHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, raw] of Object.entries(headers)) {
    if (
      raw === undefined ||
      ["host", "connection", "content-length", "accept-encoding"].includes(
        name.toLowerCase(),
      )
    ) {
      continue;
    }
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      result.append(name, value);
    }
  }
  result.set("x-forwarded-host", "127.0.0.1:8086");
  result.set("x-forwarded-proto", "http");
  return result;
}

function copyResponseHeaders(
  upstream: Response,
  response: ServerResponse,
): void {
  const skipped = new Set([
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "set-cookie",
  ]);
  upstream.headers.forEach((value, name) => {
    if (!skipped.has(name.toLowerCase())) response.setHeader(name, value);
  });
  const headersWithCookies = upstream.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const cookies = headersWithCookies.getSetCookie?.() ?? [];
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
}

async function forwardPublicRequest(
  request: IncomingMessage,
  response: ServerResponse,
  backendOrigin: string,
  requests: CapturedRequest[],
  failures: string[],
): Promise<void> {
  try {
    const pathWithQuery = request.url ?? "/";
    const path = new URL(pathWithQuery, cloudPublicOrigin).pathname;
    const body = await requestBody(request);
    const contentType = request.headers["content-type"] ?? null;
    const captured: CapturedRequest = {
      method: request.method ?? "GET",
      path,
      contentType: Array.isArray(contentType)
        ? (contentType[0] ?? null)
        : contentType,
      body: parseCapturedBody(
        body,
        Array.isArray(contentType) ? (contentType[0] ?? null) : contentType,
      ),
    };
    requests.push(captured);

    const failureIndex = failures.findIndex((candidate) => candidate === path);
    if (failureIndex >= 0) {
      failures.splice(failureIndex, 1);
      captured.responseStatus = 503;
      captured.responseBody = { error: { code: "service_unavailable" } };
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":{"code":"service_unavailable"}}');
      return;
    }

    const upstream = await fetch(`${backendOrigin}${pathWithQuery}`, {
      method: request.method,
      headers: forwardedHeaders(request.headers),
      body:
        request.method === "GET" ||
        request.method === "HEAD" ||
        body.length === 0
          ? undefined
          : new Uint8Array(body),
      redirect: "manual",
    });
    const upstreamBytes = Buffer.from(await upstream.arrayBuffer());
    captured.responseStatus = upstream.status;
    captured.responseBody = parseCapturedBody(
      upstreamBytes,
      upstream.headers.get("content-type"),
    );
    copyResponseHeaders(upstream, response);
    response.statusCode = upstream.status;
    response.end(upstreamBytes);
  } catch {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain" });
    }
    response.end("Agent control E2E proxy unavailable");
  }
}

async function createCaptureServer(): Promise<{
  server: Server;
  origin: string;
  deliveries: SMSDelivery[];
}> {
  const deliveries: SMSDelivery[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const body = await requestBody(request);
      if (request.url === "/sms" && request.method === "POST") {
        const parsed = JSON.parse(body.toString("utf8")) as {
          to?: unknown;
          code?: unknown;
          purpose?: unknown;
        };
        if (
          request.headers.authorization !== "Bearer e2e-sms-secret" ||
          typeof parsed.to !== "string" ||
          typeof parsed.code !== "string" ||
          typeof parsed.purpose !== "string"
        ) {
          response.writeHead(400).end();
          return;
        }
        deliveries.push({
          to: parsed.to,
          code: parsed.code,
          purpose: parsed.purpose,
        });
        response.writeHead(202, { "content-type": "application/json" });
        response.end('{"status":"accepted"}');
        return;
      }
      if (request.url === "/captcha" && request.method === "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"success":true}');
        return;
      }
      response.writeHead(404).end();
    })().catch(() => response.writeHead(400).end());
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Agent control verification server did not bind.");
  }
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    deliveries,
  };
}

function composeEnvironment(harness: AgentControlHarness): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AERA_CLOUD_POSTGRES_BIND: `127.0.0.1:${harness.postgresPort}`,
    AERA_CLOUD_REDIS_BIND: `127.0.0.1:${harness.redisPort}`,
  };
}

async function waitForCloud(
  child: ChildProcess,
  backendOrigin: string,
  logs: () => string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`AgentEra cloud exited before readiness.\n${logs()}`);
    }
    try {
      const response = await fetch(`${backendOrigin}/health/ready`);
      if (response.ok) return;
    } catch {
      // The listener is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`AgentEra cloud did not become ready.\n${logs()}`);
}

async function startCloud(harness: AgentControlHarness): Promise<void> {
  const base = parseDevelopmentEnvironment(
    await readFile(join(cloudRoot, ".env.example"), "utf8"),
  );
  const child = spawn(harness.cloudBinary, [], {
    cwd: cloudRoot,
    env: {
      ...process.env,
      ...base,
      AGENTERA_CLOUD_LISTEN_ADDR: new URL(harness.cloudBackendOrigin).host,
      AGENTERA_CLOUD_PUBLIC_URL: cloudPublicOrigin,
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
  await waitForCloud(child, harness.cloudBackendOrigin, () => output);
  harness.cloudProcess = child;
}

async function stopCloud(harness: AgentControlHarness): Promise<void> {
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

async function writePrivateFixture(
  root: string,
  device: "A" | "B",
): Promise<void> {
  const files: Record<string, string> = {
    ".env": `AGENTERA_E2E_PRIVATE_MARKER=DEVICE_${device}_ENV\n`,
    "MEMORY.md": `# Device ${device} native Memory\n`,
    "USER.md": `# Device ${device} native USER\n`,
    "sessions/authoring.json": `{"device":"${device}"}\n`,
    "files/private.txt": `DEVICE_${device}_PRIVATE_FILE\n`,
    "skills/local-authoring/SKILL.md": `# Device ${device} local authoring skill\n`,
    "curator/state.json": `{"device":"${device}","local":true}\n`,
    "adaptive/device-marker.txt": `DEVICE_${device}_ADAPTIVE_MARKER\n`,
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
}

export async function createAgentControlHarness(): Promise<AgentControlHarness> {
  await assertPublicPortAvailable();
  const runtimeSeedDirectory = resolve(
    process.env.AGENTERA_RUNTIME_SEED_DIR?.trim() ||
      join(desktopRoot, "resources", "agentera-runtime-seed"),
  );
  const seedEntries = (await readdir(runtimeSeedDirectory)).filter(
    (entry) => entry !== ".gitkeep",
  );
  if (seedEntries.length !== 3) {
    throw new Error(
      "Prepare the locked native Runtime Seed before Agent control E2E.",
    );
  }

  const root = await mkdtemp(join(tmpdir(), "agentera-agent-control-e2e-"));
  const deviceRoots = {
    A: {
      userData: join(root, "device-a", "electron-user-data"),
      hermesHome: join(root, "device-a", "hermes-home"),
    },
    B: {
      userData: join(root, "device-b", "electron-user-data"),
      hermesHome: join(root, "device-b", "hermes-home"),
    },
  };
  for (const name of ["A", "B"] as const) {
    await mkdir(deviceRoots[name].userData, { recursive: true });
    await mkdir(deviceRoots[name].hermesHome, { recursive: true });
    await writePrivateFixture(deviceRoots[name].hermesHome, name);
  }

  const capture = await createCaptureServer();
  const requests: CapturedRequest[] = [];
  const failures: string[] = [];
  const backendPort = await freePort();
  const cloudBackendOrigin = `http://127.0.0.1:${backendPort}`;
  const proxyServer = createServer((request, response) => {
    void forwardPublicRequest(
      request,
      response,
      cloudBackendOrigin,
      requests,
      failures,
    );
  });
  await listen(proxyServer, 8086);
  const browser = await chromium.launch({ headless: true });
  const browserPage = await (
    await browser.newContext({ locale: "en-US" })
  ).newPage();
  const harness: AgentControlHarness = {
    root,
    cloudBinary: join(root, "aera-cloud"),
    cloudBackendOrigin,
    postgresPort: await freePort(),
    redisPort: await freePort(),
    composeProject: `agentera-agent-control-e2e-${process.pid}`,
    captureServer: capture.server,
    captureOrigin: capture.origin,
    proxyServer,
    deliveries: capture.deliveries,
    phone: "+8613900000031",
    cloudProcess: null,
    browser,
    browserPage,
    composeStarted: false,
    runtimeSeedDirectory,
    deviceRoots,
    devices: [],
    requests,
    failures,
  };
  try {
    command(
      "docker",
      ["compose", "-p", harness.composeProject, "up", "-d", "--wait"],
      { cwd: cloudRoot, env: composeEnvironment(harness) },
    );
    harness.composeStarted = true;
    command("go", ["build", "-o", harness.cloudBinary, "./cmd/aera-cloud"], {
      cwd: cloudRoot,
    });
    await startCloud(harness);
    return harness;
  } catch (error) {
    await closeAgentControlHarness(harness).catch(() => undefined);
    throw error;
  }
}

export async function closeAgentControlHarness(
  harness: AgentControlHarness | null,
): Promise<void> {
  if (!harness) return;
  for (const device of harness.devices.splice(0).reverse()) {
    await device.page
      .evaluate(async () => {
        const profiles = await window.hermesAPI.listProfiles();
        await Promise.all(
          profiles.map(({ id }) =>
            window.hermesAPI.stopDashboard(id).catch(() => false),
          ),
        );
        await window.hermesAPI.stopGateway().catch(() => false);
      })
      .catch(() => undefined);
    await device.app.close().catch(() => undefined);
  }
  await stopCloud(harness).catch(() => undefined);
  await harness.browser.close().catch(() => undefined);
  await closeServer(harness.proxyServer).catch(() => undefined);
  await closeServer(harness.captureServer).catch(() => undefined);
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
    harness.composeStarted = false;
  }
  await makeTreeWritable(harness.root).catch(() => undefined);
  await rm(harness.root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

async function makeTreeWritable(path: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) return;
  if (!stats.isDirectory()) {
    await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  for (const name of await readdir(path)) {
    await makeTreeWritable(join(path, name));
  }
}

export async function launchAgentControlDevice(
  harness: AgentControlHarness,
  name: "A" | "B",
): Promise<AgentControlDevice> {
  const roots = harness.deviceRoots[name];
  const executablePath = process.env.AGENTERA_E2E_EXECUTABLE_PATH?.trim();
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath
      ? [`--user-data-dir=${roots.userData}`]
      : [".", `--user-data-dir=${roots.userData}`],
    cwd: desktopRoot,
    env: {
      ...process.env,
      AGENTERA_CLOUD_PUBLIC_URL: cloudPublicOrigin,
      AGENTERA_RUNTIME_SEED_DIR: harness.runtimeSeedDirectory,
      HERMES_DESKTOP_USER_DATA_DIR: roots.userData,
      HERMES_HOME: roots.hermesHome,
      HERMES_DISABLE_GPU: "1",
      HERMES_OPEN_DEVTOOLS: "0",
      HERMES_DESKTOP_OPEN_DEVTOOLS: "0",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
  });
  let processOutput = "";
  const appendProcessOutput = (chunk: Buffer): void => {
    processOutput = `${processOutput}${chunk.toString("utf8")}`.slice(
      -64 * 1024,
    );
  };
  app.process().stdout?.on("data", appendProcessOutput);
  app.process().stderr?.on("data", appendProcessOutput);
  app.on("console", (message) => {
    appendProcessOutput(Buffer.from(`${message.text()}\n`, "utf8"));
  });
  const page = await app.firstWindow();
  await app.evaluate(({ shell }) => {
    const state = globalThis as typeof globalThis & {
      __agenteraE2EExternalUrls?: string[];
      __agenteraE2EOriginalFetch?: typeof fetch;
    };
    state.__agenteraE2EExternalUrls = [];
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
      throw new TypeError("Public HTTP is blocked by Agent control E2E");
    };
  });
  const device: AgentControlDevice = {
    name,
    userData: roots.userData,
    hermesHome: roots.hermesHome,
    app,
    page,
    get processOutput() {
      return processOutput;
    },
  };
  harness.devices.push(device);
  return device;
}

export function deviceProcessDiagnostics(
  device: AgentControlDevice | null,
): string[] {
  if (!device) return [];
  return device.processOutput
    .split(/\r?\n/)
    .filter((line) => line.includes("[AGENTERA_AGENT_INSTALLATION]"))
    .slice(-8);
}

async function externalURLs(device: AgentControlDevice): Promise<string[]> {
  return device.app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __agenteraE2EExternalUrls?: string[];
    };
    return [...(state.__agenteraE2EExternalUrls ?? [])];
  });
}

async function captureExternalURL(
  device: AgentControlDevice,
  action: () => Promise<void>,
): Promise<string> {
  const before = (await externalURLs(device)).length;
  await action();
  await expect
    .poll(async () => (await externalURLs(device)).length)
    .toBeGreaterThan(before);
  return (await externalURLs(device))[before];
}

export async function authenticateFirstAgentControlDevice(
  harness: AgentControlHarness,
  device: AgentControlDevice,
): Promise<void> {
  await authenticateNewProductAccount(
    harness as unknown as ProductAuthHarness,
    device.app,
    device.page,
  );
}

export async function authenticateExistingAgentControlDevice(
  harness: AgentControlHarness,
  device: AgentControlDevice,
): Promise<void> {
  await expect(
    device.page.locator('[data-testid="screen-auth"]'),
  ).toBeVisible();
  const authorizationURL = await captureExternalURL(device, () =>
    device.page.locator(".agentera-gate-primary").click(),
  );
  const page = harness.browserPage;
  await page.goto(authorizationURL);
  await page.waitForURL(/\/(?:authorize|login)(?:\?|$)/);
  if (await page.locator('input[autocomplete="username"]').isVisible()) {
    await page.locator('input[autocomplete="username"]').fill(harness.phone);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    await page.locator('button[type="submit"].primary-button').click();
    await page.waitForURL(/\/authorize\?request_id=/);
  }
  const approve = page.locator("button.primary-button");
  await expect(approve).toBeVisible();
  await approve.click({ noWaitAfter: true });
  await expect
    .poll(async () =>
      device.page.evaluate(() => window.agenteraAuth.getState()),
    )
    .toMatchObject({ status: "authenticated" });
}

export async function claimDefaultProfile(
  device: AgentControlDevice,
): Promise<void> {
  await expect(
    device.page.locator('[data-testid="screen-profile-claim"]'),
  ).toBeVisible({ timeout: 180_000 });
  await expect
    .poll(() =>
      device.page.evaluate(() => window.agenteraRuntimeDistribution.getState()),
    )
    .toMatchObject({ phase: "current" });
  const claim = device.page.locator(".agentera-profile-actions .btn-primary");
  await expect(claim).toBeEnabled();
  await claim.click();
  await expect
    .poll(() =>
      device.page.evaluate(async () => {
        const result = await window.agenteraAgents.getState();
        return result.ok;
      }),
    )
    .toBe(true);
}

export async function invokeAgentera<T = unknown>(
  device: AgentControlDevice,
  method: AgenteraMethod,
  ...args: unknown[]
): Promise<AgenteraAgentControlResult<T>> {
  return device.page.evaluate(
    async ({ requestedMethod, requestedArgs }) => {
      const api = window.agenteraAgents as unknown as Record<
        string,
        (...parameters: unknown[]) => Promise<unknown>
      >;
      return api[requestedMethod](...requestedArgs) as Promise<
        AgenteraAgentControlResult<T>
      >;
    },
    { requestedMethod: method, requestedArgs: args },
  );
}

export function failNextAgentControlRequest(
  harness: AgentControlHarness,
  path: string,
): void {
  harness.failures.push(path);
}

export function agentControlRequests(
  harness: AgentControlHarness,
): CapturedAgentControlRequest[] {
  return harness.requests
    .filter(
      (request) =>
        request.path.startsWith("/api/v1/agent-") ||
        request.path.startsWith("/api/v1/runtime-binding") ||
        request.path.startsWith("/api/agents"),
    )
    .map(({ method, path, body }) => ({ method, path, body }));
}

export function agentControlExchangeDiagnostics(
  harness: AgentControlHarness,
): unknown[] {
  return harness.requests
    .filter(
      (request) =>
        request.path.startsWith("/api/v1/agent-") ||
        request.path.startsWith("/api/v1/policy-snapshots/") ||
        request.path.startsWith("/.well-known/agentera-signing-keys"),
    )
    .slice(-6)
    .map((request) => ({
      method: request.method,
      path: request.path,
      requestBody: request.body,
      responseStatus: request.responseStatus,
      responseBody: request.responseBody,
    }));
}

export async function cloudAgentControlCounts(
  harness: AgentControlHarness,
): Promise<CloudAgentControlCounts> {
  const query = `SELECT json_build_object(
    'definitions', (SELECT count(*) FROM agent_definitions),
    'versions', (SELECT count(*) FROM agent_versions),
    'installations', (SELECT count(*) FROM installations),
    'runtimeBindings', (SELECT count(*) FROM runtime_binding_records)
  );`;
  const output = command(
    "docker",
    [
      "compose",
      "-p",
      harness.composeProject,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "aera_cloud",
      "-d",
      "aera_cloud",
      "-Atc",
      query,
    ],
    { cwd: cloudRoot, env: composeEnvironment(harness) },
  );
  const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
  return {
    definitions: Number(parsed.definitions),
    versions: Number(parsed.versions),
    installations: Number(parsed.installations),
    runtimeBindings: Number(parsed.runtimeBindings),
  };
}

export function deviceProfilePath(
  device: AgentControlDevice,
  profileId: string,
): string {
  return profileId === "default"
    ? device.hermesHome
    : join(device.hermesHome, "profiles", profileId);
}

async function hashPath(path: string): Promise<string | null> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const hash = createHash("sha256");
  if (stats.isSymbolicLink()) {
    hash.update("symlink\0").update(await readlink(path));
    return hash.digest("hex");
  }
  if (stats.isFile()) {
    hash.update("file\0").update(await readFile(path));
    return hash.digest("hex");
  }
  if (!stats.isDirectory()) return "unsupported";
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = join(directory, entry.name);
      hash.update(relative).update("\0");
      if (entry.isDirectory()) await visit(child, relative);
      else if (entry.isFile()) hash.update(await readFile(child));
      else if (entry.isSymbolicLink()) hash.update(await readlink(child));
      hash.update("\0");
    }
  };
  await visit(path, "");
  return hash.digest("hex");
}

export async function privateProfileSnapshot(
  profilePath: string,
  markers: readonly string[],
): Promise<Record<string, string | null>> {
  const snapshot: Record<string, string | null> = {};
  for (const marker of markers) {
    snapshot[marker] = await hashPath(join(profilePath, marker));
  }
  return snapshot;
}

export async function encryptedDevicePrivateKey(
  device: AgentControlDevice,
): Promise<string> {
  const serialized = JSON.parse(
    await readFile(
      join(device.userData, "agentera-auth", "state.json"),
      "utf8",
    ),
  ) as {
    installation?: { encryptedDevicePrivateKey?: unknown } | null;
  };
  const value = serialized.installation?.encryptedDevicePrivateKey;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Encrypted device private key is unavailable.");
  }
  return value;
}

export async function localAgentControlState(
  device: AgentControlDevice,
): Promise<LocalAgentControlState> {
  const controlRoot = join(device.userData, "agentera-control-plane");
  const database = new DatabaseSync(join(controlRoot, "control-plane.db"), {
    readOnly: true,
  });
  try {
    const installationRows = database
      .prepare(
        `SELECT agent_installation_id, definition_id, selected_version_id,
                runtime_profile_id, policy_snapshot_id, status, retry_code,
                created_at, updated_at
         FROM local_agent_installations
         ORDER BY created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    const installations: AgenteraAgentInstallationSummary[] =
      installationRows.map((row) => ({
        id: String(row.agent_installation_id),
        definitionId: String(row.definition_id),
        selectedVersionId: String(row.selected_version_id),
        runtimeProfileId:
          row.runtime_profile_id === null
            ? null
            : String(row.runtime_profile_id),
        policySnapshotId:
          row.policy_snapshot_id === null
            ? null
            : String(row.policy_snapshot_id),
        status: row.status as "pending" | "active" | "archived",
        retryCode: row.retry_code === null ? null : String(row.retry_code),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }));
    const bindingRows = database
      .prepare(
        `SELECT binding_json FROM runtime_bindings
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as Array<{ binding_json?: unknown }>;
    const bindings = bindingRows.map((row) => {
      if (typeof row.binding_json !== "string") {
        throw new Error("Local RuntimeBinding is corrupt.");
      }
      const parsed = JSON.parse(row.binding_json) as LocalRuntimeBindingState;
      return {
        id: parsed.id,
        conversationKey: parsed.conversationKey,
        agentVersionId: parsed.agentVersionId,
        agentInstallationId: parsed.agentInstallationId,
        runtimeProfileId: parsed.runtimeProfileId,
        localAdaptiveStateRevision: parsed.localAdaptiveStateRevision,
      };
    });
    let projectionRoots: string[] = [];
    const projectionDirectory = join(controlRoot, "projections");
    try {
      projectionRoots = (
        await readdir(projectionDirectory, {
          withFileTypes: true,
        })
      )
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(projectionDirectory, entry.name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { installations, bindings, projectionRoots };
  } finally {
    database.close();
  }
}

export async function startBoundConversation(
  device: AgentControlDevice,
  profileId: string,
  conversationKey: string,
): Promise<void> {
  await device.page.evaluate(
    ({ profile, runId }) => {
      void window.hermesAPI
        .sendMessage(
          "Create the immutable AgentEra RuntimeBinding for this conversation.",
          profile,
          undefined,
          undefined,
          undefined,
          undefined,
          runId,
        )
        .catch(() => undefined);
    },
    { profile: profileId, runId: conversationKey },
  );
}
