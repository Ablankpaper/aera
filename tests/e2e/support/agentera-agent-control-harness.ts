import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
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
  requireCleanE2ERepository,
  type ProductAuthHarness,
} from "./agentera-product-auth-harness";

const desktopRoot = resolve(process.cwd());
const defaultCloudRoot = resolve(
  process.env.AGENTERA_E2E_CLOUD_ROOT?.trim() ||
    resolve(desktopRoot, "../aera-cloud"),
);
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

export type AgentControlDeviceName = "A" | "B" | "C" | "D";

export interface AgentControlDevice {
  name: AgentControlDeviceName;
  userData: string;
  hermesHome: string;
  app: ElectronApplication;
  page: Page;
  processOutput: string;
}

export interface AgentControlHarness {
  root: string;
  cloudRoot: string;
  cloudBinary: string;
  cloudBackendOrigin: string;
  postgresPort: number;
  redisPort: number;
  minioPort: number;
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
  deviceRoots: Record<
    AgentControlDeviceName,
    { userData: string; hermesHome: string }
  >;
  devices: AgentControlDevice[];
  requests: CapturedRequest[];
  failures: string[];
  encryptedBackupEnabled: boolean;
  official: OfficialManagedAgentHarnessState | null;
}

export interface OfficialManagedAgentHarnessState {
  adminRoot: string;
  adminBinary: string;
  adminBootstrapBinary: string;
  cloudE2EBinary: string;
  adminBaseURL: string;
  cloudInternalOrigin: string;
  adminPostgresPort: number;
  adminRedisPort: number;
  adminComposeProject: string;
  adminComposeStarted: boolean;
  adminProcess: ChildProcess | null;
  adminFixtureFile: string;
  cloudFixtureFile: string;
  cloudLogFile: string;
  adminLogFile: string;
  cloudPIDFile: string;
  pkiDirectory: string;
  environment: NodeJS.ProcessEnv;
}

export interface CloudAgentControlCounts {
  definitions: number;
  versions: number;
  installations: number;
  runtimeBindings: number;
}

export interface CloudExperienceCandidateCounts {
  candidates: number;
  reviews: number;
}

export interface ExperienceCandidateProfileFixture {
  selectedSkillName: string;
  unsafeSkillName: string;
  unselectedSkillName: string;
  selectedMarker: string;
  unsafeSecret: string;
  unselectedSecret: string;
  privateMarkers: readonly string[];
}

export interface LocalRuntimeBindingState {
  id: string;
  conversationKey: string;
  agentVersionId: string;
  agentInstallationId: string;
  runtimeProfileId: string;
  localAdaptiveStateRevision: string;
  officialReleaseRevisionId: string | null;
}

export interface LocalAgentControlState {
  installations: AgenteraAgentInstallationSummary[];
  bindings: LocalRuntimeBindingState[];
  projectionRoots: string[];
}

export interface LocalInstallationOwnerRow {
  tenantId: string;
  ownerId: string;
  deviceInstallationId: string;
  sourceScope: "USER" | "WORKSPACE" | "ORGANIZATION" | "PLATFORM";
  sourceWorkspaceId: string | null;
  sourceOrganizationId: string | null;
  officialReleaseId: string | null;
  selectedReleaseRevisionId: string | null;
  updatePolicy: "manual" | "managed";
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
  | "prepareOrganizationSubmission"
  | "confirmOrganizationSubmission"
  | "listOrganizationSubmissions"
  | "getOrganizationSubmission"
  | "prepareOrganizationReview"
  | "confirmOrganizationReview"
  | "prepareOrganizationWithdrawal"
  | "confirmOrganizationWithdrawal"
  | "listDefinitions"
  | "listOfficialAgents"
  | "prepareOfficialInstall"
  | "confirmOfficialInstall"
  | "refreshOfficialUpdates"
  | "applyOfficialUpdate"
  | "listVersions"
  | "listInstallations"
  | "installVersion"
  | "claimVersion"
  | "retryPendingInstallation"
  | "selectInstallationVersion"
  | "archiveInstallation"
  | "listEligibleExperienceSkills"
  | "prepareExperienceCandidate"
  | "submitExperienceCandidate"
  | "listMyExperienceCandidates"
  | "listExperienceReviewQueue"
  | "getExperienceCandidate"
  | "reviewExperienceCandidate"
  | "prepareExperienceCandidateImport"
  | "confirmExperienceCandidateImport";

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
    const spawnError =
      result.error instanceof Error
        ? `${result.error.name}: ${result.error.message}`
        : "no spawn error was reported";
    throw new Error(
      `${executable} ${args.join(" ")} failed\n${spawnError}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
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

    const failureIndex = failures.findIndex(
      (candidate) =>
        candidate === path ||
        (candidate === "__encrypted_backup_chunk_upload__" &&
          request.method === "PUT" &&
          /^\/api\/v1\/encrypted-profile-backups\/[0-9a-f-]{36}\/chunks\/0$/u.test(
            path,
          )),
    );
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
    AERA_CLOUD_MINIO_BIND: `127.0.0.1:${harness.minioPort}`,
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
    await readFile(join(harness.cloudRoot, ".env.example"), "utf8"),
  );
  const child = spawn(harness.cloudBinary, [], {
    cwd: harness.cloudRoot,
    env: {
      ...process.env,
      ...base,
      ...(harness.official?.environment ?? {}),
      AGENTERA_CLOUD_LISTEN_ADDR: new URL(harness.cloudBackendOrigin).host,
      AGENTERA_CLOUD_PUBLIC_URL: cloudPublicOrigin,
      AGENTERA_CLOUD_DATABASE_URL: `postgres://aera_cloud:aera-cloud-dev-only@127.0.0.1:${harness.postgresPort}/aera_cloud?sslmode=disable`,
      AGENTERA_CLOUD_REDIS_ADDR: `127.0.0.1:${harness.redisPort}`,
      AGENTERA_CLOUD_SMS_ENDPOINT: `${harness.captureOrigin}/sms`,
      AGENTERA_CLOUD_SMS_API_KEY: "e2e-sms-secret",
      AGENTERA_CLOUD_CAPTCHA_ENDPOINT: `${harness.captureOrigin}/captcha`,
      AGENTERA_CLOUD_CAPTCHA_SECRET: "e2e-captcha-secret",
      ...(harness.encryptedBackupEnabled
        ? {
            AGENTERA_CLOUD_ENCRYPTED_BACKUP_ENABLED: "true",
            AGENTERA_CLOUD_ENCRYPTED_BACKUP_ENDPOINT: `127.0.0.1:${harness.minioPort}`,
            AGENTERA_CLOUD_ENCRYPTED_BACKUP_BUCKET: "aera-encrypted-backups",
            AGENTERA_CLOUD_ENCRYPTED_BACKUP_REGION: "us-east-1",
            AGENTERA_CLOUD_ENCRYPTED_BACKUP_ACCESS_KEY: "aera-backup-dev",
            AGENTERA_CLOUD_ENCRYPTED_BACKUP_SECRET_KEY: "aera-backup-dev-only",
            AGENTERA_CLOUD_ENCRYPTED_BACKUP_USE_TLS: "false",
          }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString("utf8")}`.slice(-128 * 1024);
    if (harness.official) {
      appendFileSync(harness.official.cloudLogFile, chunk);
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  await waitForCloud(child, harness.cloudBackendOrigin, () => output);
  harness.cloudProcess = child;
  if (harness.official && child.pid) {
    writeFileSync(harness.official.cloudPIDFile, `${child.pid}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
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

export async function stopAgentControlCloud(
  harness: AgentControlHarness,
): Promise<void> {
  await stopCloud(harness);
}

export async function startAgentControlCloud(
  harness: AgentControlHarness,
): Promise<void> {
  if (harness.cloudProcess?.exitCode === null) return;
  await startCloud(harness);
}

async function writePrivateFixture(
  root: string,
  device: AgentControlDeviceName,
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

function createDeviceRoots(root: string): AgentControlHarness["deviceRoots"] {
  return {
    A: {
      userData: join(root, "device-a", "electron-user-data"),
      hermesHome: join(root, "device-a", "hermes-home"),
    },
    B: {
      userData: join(root, "device-b", "electron-user-data"),
      hermesHome: join(root, "device-b", "hermes-home"),
    },
    C: {
      userData: join(root, "device-c", "electron-user-data"),
      hermesHome: join(root, "device-c", "hermes-home"),
    },
    D: {
      userData: join(root, "device-d", "electron-user-data"),
      hermesHome: join(root, "device-d", "hermes-home"),
    },
  };
}

function randomKey(): string {
  return randomBytes(32).toString("base64");
}

function adminComposeEnvironment(
  official: OfficialManagedAgentHarnessState,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AERA_ADMIN_POSTGRES_BIND: `127.0.0.1:${official.adminPostgresPort}`,
    AERA_ADMIN_REDIS_BIND: `127.0.0.1:${official.adminRedisPort}`,
  };
}

async function generateOfficialPKI(
  official: OfficialManagedAgentHarnessState,
): Promise<void> {
  await mkdir(official.pkiDirectory, { recursive: true, mode: 0o700 });
  const caKey = join(official.pkiDirectory, "ca-key.pem");
  const caCertificate = join(official.pkiDirectory, "ca.pem");
  const cloudKey = join(official.pkiDirectory, "cloud-key.pem");
  const cloudRequest = join(official.pkiDirectory, "cloud.csr");
  const cloudExtensions = join(official.pkiDirectory, "cloud.ext");
  const cloudCertificate = join(official.pkiDirectory, "cloud.pem");
  const clientKey = join(official.pkiDirectory, "client-key.pem");
  const clientRequest = join(official.pkiDirectory, "client.csr");
  const clientExtensions = join(official.pkiDirectory, "client.ext");
  const clientCertificate = join(official.pkiDirectory, "client.pem");
  const serviceKey = join(official.pkiDirectory, "service-key.pem");
  const servicePublic = join(official.pkiDirectory, "service-public.pem");

  command(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=AgentEra Official E2E CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      caKey,
      "-out",
      caCertificate,
    ],
    { cwd: official.pkiDirectory },
  );
  command(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:3072",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      cloudKey,
      "-out",
      cloudRequest,
    ],
    { cwd: official.pkiDirectory },
  );
  await writeFile(
    cloudExtensions,
    "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
    { encoding: "utf8", mode: 0o600 },
  );
  command(
    "openssl",
    [
      "x509",
      "-req",
      "-days",
      "1",
      "-in",
      cloudRequest,
      "-CA",
      caCertificate,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-extfile",
      cloudExtensions,
      "-out",
      cloudCertificate,
    ],
    { cwd: official.pkiDirectory },
  );
  command(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:3072",
      "-nodes",
      "-subj",
      "/CN=aera-admin-official-e2e",
      "-keyout",
      clientKey,
      "-out",
      clientRequest,
    ],
    { cwd: official.pkiDirectory },
  );
  await writeFile(clientExtensions, "extendedKeyUsage=clientAuth\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  command(
    "openssl",
    [
      "x509",
      "-req",
      "-days",
      "1",
      "-in",
      clientRequest,
      "-CA",
      caCertificate,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-extfile",
      clientExtensions,
      "-out",
      clientCertificate,
    ],
    { cwd: official.pkiDirectory },
  );
  command("openssl", ["genpkey", "-algorithm", "ED25519", "-out", serviceKey], {
    cwd: official.pkiDirectory,
  });
  command(
    "openssl",
    ["pkey", "-in", serviceKey, "-pubout", "-out", servicePublic],
    { cwd: official.pkiDirectory },
  );
}

function officialEnvironment(
  harness: AgentControlHarness,
  official: OfficialManagedAgentHarnessState,
): NodeJS.ProcessEnv {
  const keyRing = (key: string): string =>
    JSON.stringify({
      active_key_id: "official-e2e-v1",
      keys: { "official-e2e-v1": key },
    });
  const cloudKeyRing = (key: string): string =>
    JSON.stringify({ "official-e2e-v1": key });
  const caCertificate = join(official.pkiDirectory, "ca.pem");
  const cloudCertificate = join(official.pkiDirectory, "cloud.pem");
  const cloudKey = join(official.pkiDirectory, "cloud-key.pem");
  const clientCertificate = join(official.pkiDirectory, "client.pem");
  const clientKey = join(official.pkiDirectory, "client-key.pem");
  const serviceKey = join(official.pkiDirectory, "service-key.pem");
  const servicePublic = join(official.pkiDirectory, "service-public.pem");
  const adminDatabase = `postgres://aera_admin:aera-admin-dev-only@127.0.0.1:${official.adminPostgresPort}/aera_admin?sslmode=disable`;

  return {
    ...process.env,
    AGENTERA_CLOUD_ENVIRONMENT: "test",
    AGENTERA_CLOUD_LISTEN_ADDR: new URL(harness.cloudBackendOrigin).host,
    AGENTERA_CLOUD_PUBLIC_URL: cloudPublicOrigin,
    AGENTERA_CLOUD_DATABASE_URL: `postgres://aera_cloud:aera-cloud-dev-only@127.0.0.1:${harness.postgresPort}/aera_cloud?sslmode=disable`,
    AGENTERA_CLOUD_REDIS_ADDR: `127.0.0.1:${harness.redisPort}`,
    AGENTERA_CLOUD_REDIS_USERNAME: "aera_cloud",
    AGENTERA_CLOUD_REDIS_PASSWORD: "aera-cloud-dev-only",
    AGENTERA_CLOUD_REDIS_DB: "9",
    AGENTERA_CLOUD_SMS_ENDPOINT: `${harness.captureOrigin}/sms`,
    AGENTERA_CLOUD_SMS_API_KEY: "e2e-sms-secret",
    AGENTERA_CLOUD_CAPTCHA_ENDPOINT: `${harness.captureOrigin}/captcha`,
    AGENTERA_CLOUD_CAPTCHA_SECRET: "e2e-captcha-secret",
    AGENTERA_CLOUD_IDENTITY_ENCRYPTION_ACTIVE_KEY_ID: "official-e2e-v1",
    AGENTERA_CLOUD_IDENTITY_ENCRYPTION_KEYS: cloudKeyRing(randomKey()),
    AGENTERA_CLOUD_IDENTITY_LOOKUP_ACTIVE_KEY_ID: "official-e2e-v1",
    AGENTERA_CLOUD_IDENTITY_LOOKUP_KEYS: cloudKeyRing(randomKey()),
    AGENTERA_CLOUD_VERIFICATION_CODE_ACTIVE_KEY_ID: "official-e2e-v1",
    AGENTERA_CLOUD_VERIFICATION_CODE_KEYS: cloudKeyRing(randomKey()),
    AGENTERA_CLOUD_VERIFICATION_RECEIPT_ACTIVE_KEY_ID: "official-e2e-v1",
    AGENTERA_CLOUD_VERIFICATION_RECEIPT_KEYS: cloudKeyRing(randomKey()),
    AGENTERA_CLOUD_VERIFICATION_REQUEST_HMAC_KEY: randomKey(),
    AGENTERA_CLOUD_BROWSER_SESSION_HMAC_KEY: randomKey(),
    AGENTERA_CLOUD_LOGIN_RATE_HMAC_KEY: randomKey(),
    AGENTERA_CLOUD_OAUTH_STATE_ENCRYPTION_ACTIVE_KEY_ID: "official-e2e-v1",
    AGENTERA_CLOUD_OAUTH_STATE_ENCRYPTION_KEYS: cloudKeyRing(randomKey()),
    AGENTERA_CLOUD_OAUTH_STATE_HMAC_KEY: randomKey(),
    AGENTERA_CLOUD_REFRESH_TOKEN_HMAC_KEY: randomKey(),
    AGENTERA_CLOUD_INTERNAL_ADMIN_ENABLED: "true",
    AGENTERA_CLOUD_INTERNAL_ADMIN_LISTEN_ADDR: new URL(
      official.cloudInternalOrigin,
    ).host,
    AGENTERA_CLOUD_INTERNAL_ADMIN_SERVER_CERT_FILE: cloudCertificate,
    AGENTERA_CLOUD_INTERNAL_ADMIN_SERVER_KEY_FILE: cloudKey,
    AGENTERA_CLOUD_INTERNAL_ADMIN_CLIENT_CA_FILE: caCertificate,
    AGENTERA_CLOUD_INTERNAL_ADMIN_JWT_PUBLIC_KEY_FILE: servicePublic,
    AGENTERA_CLOUD_INTERNAL_ADMIN_JWT_ISSUER: "aera-admin",
    AGENTERA_CLOUD_INTERNAL_ADMIN_JWT_SUBJECT: "aera-admin-official-e2e",
    AGENTERA_CLOUD_INTERNAL_ADMIN_HMAC_ACTIVE_KEY_ID: "official-e2e-v1",
    AGENTERA_CLOUD_INTERNAL_ADMIN_HMAC_KEYS: cloudKeyRing(randomKey()),
    AGENTERA_CLOUD_OFFICIAL_AGENTS_ENABLED: "true",
    AGENTERA_CLOUD_PLATFORM_ID: "019f0000-0000-7000-8000-000000000999",
    AGENTERA_CLOUD_PLATFORM_KEY: `agentera_official_e2e_${process.pid}`,
    AGENTERA_CLOUD_PLATFORM_DISPLAY_NAME: "AgentEra Official E2E",
    AGENTERA_CLOUD_OFFICIAL_ROLLOUT_HMAC_ACTIVE_KEY_ID: "official-e2e-v1",
    AGENTERA_CLOUD_OFFICIAL_ROLLOUT_HMAC_KEYS: cloudKeyRing(randomKey()),
    AERA_ADMIN_ENVIRONMENT: "test",
    AERA_ADMIN_LISTEN_ADDR: new URL(official.adminBaseURL).host,
    AERA_ADMIN_PUBLIC_URL: official.adminBaseURL,
    AERA_ADMIN_DATABASE_URL: adminDatabase,
    AERA_ADMIN_REDIS_ADDR: `127.0.0.1:${official.adminRedisPort}`,
    AERA_ADMIN_TRUSTED_PROXY_CIDRS: "[]",
    AERA_ADMIN_IDENTITY_ENCRYPTION_KEYS: keyRing(randomKey()),
    AERA_ADMIN_IDENTITY_LOOKUP_KEYS: keyRing(randomKey()),
    AERA_ADMIN_TOTP_ENCRYPTION_KEYS: keyRing(randomKey()),
    AERA_ADMIN_SESSION_HMAC_KEY: randomKey(),
    AERA_ADMIN_CSRF_HMAC_KEY: randomKey(),
    AERA_ADMIN_OPERATION_HMAC_KEY: randomKey(),
    AERA_ADMIN_CLOUD_ENABLED: "true",
    AERA_ADMIN_CLOUD_BASE_URL: official.cloudInternalOrigin,
    AERA_ADMIN_CLOUD_CA_FILE: caCertificate,
    AERA_ADMIN_CLOUD_CLIENT_CERT_FILE: clientCertificate,
    AERA_ADMIN_CLOUD_CLIENT_KEY_FILE: clientKey,
    AERA_ADMIN_CLOUD_JWT_SIGNING_KEY_FILE: serviceKey,
    AERA_ADMIN_CLOUD_JWT_ISSUER: "aera-admin",
    AERA_ADMIN_CLOUD_JWT_SUBJECT: "aera-admin-official-e2e",
    AERA_ADMIN_CLOUD_SCOPES:
      '["users:read","devices:write","sessions:write","accounts:write","operations:read","official_agents:read","official_agent_drafts:write","official_agent_reviews:write","official_agent_releases:write","official_agent_audit:read"]',
    AERA_ADMIN_E2E_ARTIFACT_DIR: join(harness.root, "admin-test-results"),
    AERA_ADMIN_E2E_BASE_URL: official.adminBaseURL,
    AERA_ADMIN_E2E_BOOTSTRAP_BINARY: official.adminBootstrapBinary,
    AERA_ADMIN_E2E_DATABASE_URL: adminDatabase,
    AERA_ADMIN_E2E_FIXTURE_FILE: official.adminFixtureFile,
    AERA_ADMIN_E2E_REPO_ROOT: official.adminRoot,
    AERA_ADMIN_E2E_SERVER_LOG: official.adminLogFile,
    AERA_ADMIN_E2E_CLOUD_LOG: official.cloudLogFile,
    AERA_ADMIN_E2E_CLOUD_FIXTURE_FILE: official.cloudFixtureFile,
    AERA_ADMIN_E2E_CLOUD_VERIFY_BINARY: official.cloudE2EBinary,
    AERA_ADMIN_E2E_CLOUD_BINARY: harness.cloudBinary,
    AERA_ADMIN_E2E_CLOUD_PID_FILE: official.cloudPIDFile,
  };
}

async function createOfficialState(
  harness: AgentControlHarness,
  adminRoot: string,
): Promise<OfficialManagedAgentHarnessState> {
  const internalPort = await freePort();
  const adminPort = await freePort();
  const official: OfficialManagedAgentHarnessState = {
    adminRoot,
    adminBinary: join(harness.root, "aera-admin"),
    adminBootstrapBinary: join(harness.root, "aera-admin-bootstrap"),
    cloudE2EBinary: join(harness.root, "aera-cloud-e2e"),
    adminBaseURL: `http://localhost:${adminPort}`,
    cloudInternalOrigin: `https://127.0.0.1:${internalPort}`,
    adminPostgresPort: await freePort(),
    adminRedisPort: await freePort(),
    adminComposeProject: `agentera-official-admin-e2e-${process.pid}`,
    adminComposeStarted: false,
    adminProcess: null,
    adminFixtureFile: join(harness.root, "admin-fixtures.json"),
    cloudFixtureFile: join(harness.root, "cloud-fixture.json"),
    cloudLogFile: join(harness.root, "cloud.log"),
    adminLogFile: join(harness.root, "admin.log"),
    cloudPIDFile: join(harness.root, "cloud.pid"),
    pkiDirectory: join(harness.root, "pki"),
    environment: {},
  };
  await generateOfficialPKI(official);
  await writeFile(official.cloudLogFile, "", { encoding: "utf8", mode: 0o600 });
  await writeFile(official.adminLogFile, "", { encoding: "utf8", mode: 0o600 });
  official.environment = {
    ...parseDevelopmentEnvironment(
      await readFile(join(harness.cloudRoot, ".env.example"), "utf8"),
    ),
    ...officialEnvironment(harness, official),
  };
  return official;
}

async function waitForInternalCloud(
  harness: AgentControlHarness,
): Promise<void> {
  const official = harness.official;
  if (!official) return;
  const endpoint = new URL(official.cloudInternalOrigin).host;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (harness.cloudProcess?.exitCode !== null) {
      throw new Error(
        "Official Cloud stopped before its Internal Admin listener became ready.",
      );
    }
    const probe = spawnSync(
      "openssl",
      [
        "s_client",
        "-tls1_3",
        "-connect",
        endpoint,
        "-verify_return_error",
        "-verify_ip",
        "127.0.0.1",
        "-CAfile",
        join(official.pkiDirectory, "ca.pem"),
        "-cert",
        join(official.pkiDirectory, "client.pem"),
        "-key",
        join(official.pkiDirectory, "client-key.pem"),
      ],
      { encoding: "utf8", input: "", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (
      probe.status === 0 &&
      `${probe.stdout}${probe.stderr}`.includes("Verify return code: 0 (ok)")
    ) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    "Official Cloud Internal Admin listener did not become ready.",
  );
}

async function startOfficialAdmin(harness: AgentControlHarness): Promise<void> {
  const official = harness.official;
  if (!official) return;
  const child = spawn(official.adminBinary, [], {
    cwd: official.adminRoot,
    env: official.environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  official.adminProcess = child;
  let output = "";
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString("utf8")}`.slice(-128 * 1024);
    appendFileSync(official.adminLogFile, chunk);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Aera Admin stopped before readiness.\n${output}`);
    }
    try {
      const response = await fetch(`${official.adminBaseURL}/health/ready`);
      if (response.ok) {
        return;
      }
    } catch {
      // The Admin listener is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  child.kill("SIGTERM");
  throw new Error(`Aera Admin did not become ready.\n${output}`);
}

async function stopOfficialAdmin(harness: AgentControlHarness): Promise<void> {
  const child = harness.official?.adminProcess;
  if (harness.official) harness.official.adminProcess = null;
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

async function bootstrapOfficialAdminFixtures(
  harness: AgentControlHarness,
): Promise<void> {
  const official = harness.official;
  if (!official) return;
  const configPath = join(
    harness.root,
    "admin-bootstrap.playwright.config.mjs",
  );
  await writeFile(
    configPath,
    `export default ${JSON.stringify(
      {
        globalSetup: join(official.adminRoot, "e2e", "global-setup.ts"),
        outputDir: join(harness.root, "admin-bootstrap-results"),
        reporter: [["list"]],
        testDir: join(official.adminRoot, "e2e"),
        testMatch: "auth.spec.ts",
        timeout: 45_000,
        use: { baseURL: official.adminBaseURL },
        workers: 1,
      },
      null,
      2,
    )};\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  command(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      configPath,
      "--grep",
      "password-only authentication never creates an administrator session",
    ],
    { cwd: official.adminRoot, env: official.environment },
  );
}

export async function createAgentControlHarness(
  options: { officialManagedAgent?: boolean; encryptedBackup?: boolean } = {},
): Promise<AgentControlHarness> {
  await assertPublicPortAvailable();
  let selectedCloudRoot = defaultCloudRoot;
  let selectedAdminRoot: string | null = null;
  if (options.officialManagedAgent) {
    selectedCloudRoot = requireCleanE2ERepository({
      environmentName: "AERA_OFFICIAL_AGENT_E2E_CLOUD_REPO",
      markerPath: "go.mod",
      expectedMarker: "module github.com/bignormal/aera-cloud",
    });
    selectedAdminRoot = requireCleanE2ERepository({
      environmentName: "AERA_OFFICIAL_AGENT_E2E_ADMIN_REPO",
      markerPath: "go.mod",
      expectedMarker: "module github.com/bignormal/aera-admin",
    });
    const [adminContract, cloudContract] = await Promise.all([
      readFile(join(selectedAdminRoot, "api/openapi/cloud-admin-client.yaml")),
      readFile(join(selectedCloudRoot, "api/openapi/internal-admin.yaml")),
    ]);
    if (!adminContract.equals(cloudContract)) {
      throw new Error("Aera Admin and Cloud Internal Admin contracts differ.");
    }
  }
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
  const deviceRoots = createDeviceRoots(root);
  for (const name of ["A", "B", "C", "D"] as const) {
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
  let browser: Browser | undefined;
  let browserPage: Page | undefined;
  try {
    await listen(proxyServer, 8086);
    browser = await chromium.launch({ headless: true });
    browserPage = await (
      await browser.newContext({ locale: "en-US" })
    ).newPage();
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await closeServer(proxyServer).catch(() => undefined);
    await closeServer(capture.server).catch(() => undefined);
    await makeTreeWritable(root).catch(() => undefined);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    }).catch(() => undefined);
    throw error;
  }
  if (!browser || !browserPage) {
    throw new Error("Agent control E2E browser initialization was incomplete.");
  }
  const harness: AgentControlHarness = {
    root,
    cloudRoot: selectedCloudRoot,
    cloudBinary: join(root, "aera-cloud"),
    cloudBackendOrigin,
    postgresPort: await freePort(),
    redisPort: await freePort(),
    minioPort: await freePort(),
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
    encryptedBackupEnabled: options.encryptedBackup === true,
    official: null,
  };
  try {
    if (selectedAdminRoot) {
      harness.official = await createOfficialState(harness, selectedAdminRoot);
    }
    const cloudDependencies = ["postgres", "redis"];
    if (harness.encryptedBackupEnabled) {
      cloudDependencies.push("encrypted-backup-minio");
    }
    command(
      "docker",
      [
        "compose",
        "-p",
        harness.composeProject,
        "up",
        "-d",
        "--wait",
        ...cloudDependencies,
      ],
      { cwd: harness.cloudRoot, env: composeEnvironment(harness) },
    );
    harness.composeStarted = true;
    if (harness.encryptedBackupEnabled) {
      command(
        "docker",
        [
          "compose",
          "-p",
          harness.composeProject,
          "run",
          "--rm",
          "--no-deps",
          "encrypted-backup-minio-init",
        ],
        { cwd: harness.cloudRoot, env: composeEnvironment(harness) },
      );
    }
    if (harness.official) {
      command(
        "docker",
        [
          "compose",
          "-p",
          harness.official.adminComposeProject,
          "up",
          "-d",
          "--wait",
          "postgres",
          "redis",
        ],
        {
          cwd: harness.official.adminRoot,
          env: adminComposeEnvironment(harness.official),
        },
      );
      harness.official.adminComposeStarted = true;
    }
    command("go", ["build", "-o", harness.cloudBinary, "./cmd/aera-cloud"], {
      cwd: harness.cloudRoot,
    });
    if (harness.official) {
      command(
        "go",
        [
          "build",
          "-tags",
          "e2e",
          "-trimpath",
          "-o",
          harness.official.cloudE2EBinary,
          "./cmd/aera-cloud-e2e",
        ],
        { cwd: harness.cloudRoot },
      );
      command("pnpm", ["--filter", "@aera/admin-web", "build"], {
        cwd: harness.official.adminRoot,
        env: harness.official.environment,
      });
      command(
        "go",
        [
          "build",
          "-tags",
          "release",
          "-trimpath",
          "-o",
          harness.official.adminBinary,
          "./cmd/aera-admin",
        ],
        { cwd: harness.official.adminRoot },
      );
      command(
        "go",
        [
          "build",
          "-trimpath",
          "-o",
          harness.official.adminBootstrapBinary,
          "./cmd/aera-admin-bootstrap",
        ],
        { cwd: harness.official.adminRoot },
      );
      command(
        harness.official.cloudE2EBinary,
        ["seed", "--output", harness.official.cloudFixtureFile],
        { cwd: harness.cloudRoot, env: harness.official.environment },
      );
    }
    await startCloud(harness);
    if (harness.official) {
      await waitForInternalCloud(harness);
      await startOfficialAdmin(harness);
      await bootstrapOfficialAdminFixtures(harness);
    }
    return harness;
  } catch (error) {
    await closeAgentControlHarness(harness).catch(() => undefined);
    throw error;
  }
}

export async function createOfficialManagedAgentHarness(): Promise<AgentControlHarness> {
  return createAgentControlHarness({ officialManagedAgent: true });
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
  await stopOfficialAdmin(harness).catch(() => undefined);
  await stopCloud(harness).catch(() => undefined);
  await harness.browser.close().catch(() => undefined);
  await closeServer(harness.proxyServer).catch(() => undefined);
  await closeServer(harness.captureServer).catch(() => undefined);
  if (harness.official?.adminComposeStarted) {
    command(
      "docker",
      [
        "compose",
        "-p",
        harness.official.adminComposeProject,
        "down",
        "-v",
        "--remove-orphans",
      ],
      {
        cwd: harness.official.adminRoot,
        env: adminComposeEnvironment(harness.official),
      },
    );
    harness.official.adminComposeStarted = false;
  }
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
      { cwd: harness.cloudRoot, env: composeEnvironment(harness) },
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
  name: AgentControlDeviceName,
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
      AGENTERA_OFFICIAL_AGENT_CHANNEL: "internal",
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
  options: { displayName?: string; phone?: string } = {},
): Promise<void> {
  try {
    await authenticateNewProductAccount(
      harness as unknown as ProductAuthHarness,
      device.app,
      device.page,
      options,
    );
  } catch (error) {
    const exchanges = harness.requests
      .filter((request) => request.path.startsWith("/api/v1/oauth/"))
      .slice(-6)
      .map((request) => {
        const response =
          request.responseBody && typeof request.responseBody === "object"
            ? (request.responseBody as {
                error?: { code?: unknown };
                code?: unknown;
              })
            : null;
        const code = response?.error?.code ?? response?.code;
        return {
          method: request.method,
          path: request.path,
          responseStatus: request.responseStatus,
          ...(typeof code === "string" ? { errorCode: code } : {}),
        };
      });
    const browserLocation = new URL(harness.browserPage.url());
    throw new Error(
      `${String(error)}\nAgentEra OAuth diagnostics: ${JSON.stringify({
        browserLocation: `${browserLocation.origin}${browserLocation.pathname}`,
        exchanges,
      })}`,
    );
  }
}

export async function authenticateExistingAgentControlDevice(
  harness: AgentControlHarness,
  device: AgentControlDevice,
): Promise<void> {
  const authGate = device.page.locator('[data-testid="screen-auth"]');
  await expect(authGate).toBeVisible();
  const loginButton = authGate.locator(".agentera-gate-primary");
  await expect(loginButton).toBeVisible();
  await expect(loginButton).toBeEnabled();
  const authorizationURL = await captureExternalURL(device, () =>
    loginButton.click({ force: true }),
  );
  const page = harness.browserPage;
  await page.goto(authorizationURL);
  await page.waitForURL(/\/(?:authorize|login)(?:\?|$)/);
  const loginLink = page.locator('a[href^="/login?next="]');
  if (await loginLink.isVisible()) {
    await loginLink.click();
    await page.waitForURL(/\/login(?:\?|$)/);
  }
  const username = page.locator('input[autocomplete="username"]');
  if (/\/login(?:\?|$)/.test(page.url()) || (await username.isVisible())) {
    await expect(username).toBeVisible();
    await username.fill(harness.phone);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    await page.locator('button[type="submit"].primary-button').click();
    await page.waitForURL(/\/authorize\?request_id=/);
  }
  const callbackPath = /\/agentera\/oauth\/callback(?:\?|$)/u;
  const approve = page.locator("button.primary-button");
  await expect
    .poll(
      async () => callbackPath.test(page.url()) || (await approve.isVisible()),
    )
    .toBe(true);
  if (!callbackPath.test(page.url())) {
    await approve.click({ noWaitAfter: true });
  }
  await expect
    .poll(async () =>
      device.page.evaluate(() => window.agenteraAuth.getState()),
    )
    .toMatchObject({ status: "authenticated" });
}

export async function claimDefaultProfile(
  device: AgentControlDevice,
): Promise<void> {
  const agentControlIsReady = async (): Promise<boolean> =>
    device.page.evaluate(async () => {
      const result = await window.agenteraAgents.getState();
      return result.ok;
    });
  const claimScreen = device.page.locator(
    '[data-testid="screen-profile-claim"]',
  );

  await expect
    .poll(() =>
      device.page.evaluate(() => window.agenteraRuntimeDistribution.getState()),
    )
    .toMatchObject({ phase: "current" });

  // @lat: [[agentera-agent-control-plane#AgentEra Agent control plane V1#Trusted Workspace Agent context#Product-facing Agent projection]]
  // Fresh installations now bind their empty local Runtime automatically. The
  // legacy ownership screen remains only for an exceptional data/owner
  // conflict, so the E2E helper must accept either safe path.
  await expect
    .poll(
      async () =>
        (await agentControlIsReady()) || (await claimScreen.isVisible()),
      { timeout: 180_000 },
    )
    .toBe(true);
  if (await agentControlIsReady()) return;

  const claim = device.page.locator(".agentera-profile-actions .btn-primary");
  await expect
    .poll(
      async () =>
        (await agentControlIsReady()) ||
        ((await claim.count()) === 1 && (await claim.isEnabled())),
    )
    .toBe(true);
  if (await agentControlIsReady()) return;

  await claim.click();
  await expect.poll(agentControlIsReady).toBe(true);
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

export function failNextEncryptedBackupChunkUpload(
  harness: AgentControlHarness,
): void {
  harness.failures.push("__encrypted_backup_chunk_upload__");
}

export function agentControlRequests(
  harness: AgentControlHarness,
): CapturedAgentControlRequest[] {
  return harness.requests
    .filter(
      (request) =>
        request.path.startsWith("/api/v1/agent-") ||
        request.path.startsWith("/api/v1/official-agents") ||
        /^\/api\/v1\/workspaces\/[^/]+\/agent-definitions(?:\/|$)/.test(
          request.path,
        ) ||
        /^\/api\/v1\/workspaces\/[^/]+\/experience-candidates(?:\/|$)/.test(
          request.path,
        ) ||
        /^\/api\/v1\/organizations\/[^/]+\/agent-(?:definitions|publication-submissions)(?:\/|$)/.test(
          request.path,
        ) ||
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
        request.path.startsWith("/api/v1/official-agents") ||
        /^\/api\/v1\/workspaces\/[^/]+\/agent-definitions(?:\/|$)/.test(
          request.path,
        ) ||
        /^\/api\/v1\/workspaces\/[^/]+\/experience-candidates(?:\/|$)/.test(
          request.path,
        ) ||
        /^\/api\/v1\/organizations\/[^/]+\/agent-(?:definitions|publication-submissions)(?:\/|$)/.test(
          request.path,
        ) ||
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
    { cwd: harness.cloudRoot, env: composeEnvironment(harness) },
  );
  const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
  return {
    definitions: Number(parsed.definitions),
    versions: Number(parsed.versions),
    installations: Number(parsed.installations),
    runtimeBindings: Number(parsed.runtimeBindings),
  };
}

export async function cloudExperienceCandidateCounts(
  harness: AgentControlHarness,
): Promise<CloudExperienceCandidateCounts> {
  const query = `SELECT json_build_object(
    'candidates', (SELECT count(*) FROM experience_candidates),
    'reviews', (SELECT count(*) FROM experience_candidate_reviews)
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
    { cwd: harness.cloudRoot, env: composeEnvironment(harness) },
  );
  const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
  return {
    candidates: Number(parsed.candidates),
    reviews: Number(parsed.reviews),
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

export function localInstallationOwner(
  device: AgentControlDevice,
  installationId: string,
): LocalInstallationOwnerRow {
  const database = new DatabaseSync(
    join(device.userData, "agentera-control-plane", "control-plane.db"),
    { readOnly: true },
  );
  try {
    const row = database
      .prepare(
        `SELECT tenant_id, owner_id, device_installation_id, source_scope,
                source_workspace_id, source_organization_id,
                official_release_id, selected_release_revision_id, update_policy
         FROM local_agent_installations
         WHERE agent_installation_id = ?`,
      )
      .get(installationId) as Record<string, string | null> | undefined;
    if (!row) throw new Error("Agent installation is missing.");
    if (
      row.source_scope !== "USER" &&
      row.source_scope !== "WORKSPACE" &&
      row.source_scope !== "ORGANIZATION" &&
      row.source_scope !== "PLATFORM"
    ) {
      throw new Error("Agent installation source is invalid.");
    }
    if (row.update_policy !== "manual" && row.update_policy !== "managed") {
      throw new Error("Agent installation update policy is invalid.");
    }
    return {
      tenantId: String(row.tenant_id),
      ownerId: String(row.owner_id),
      deviceInstallationId: String(row.device_installation_id),
      sourceScope: row.source_scope,
      sourceWorkspaceId: row.source_workspace_id,
      sourceOrganizationId: row.source_organization_id,
      officialReleaseId: row.official_release_id,
      selectedReleaseRevisionId: row.selected_release_revision_id,
      updatePolicy: row.update_policy,
    };
  } finally {
    database.close();
  }
}

export async function seedExperienceCandidateProfile(
  profilePath: string,
): Promise<ExperienceCandidateProfileFixture> {
  const selectedSkillName = "learned-research";
  const unsafeSkillName = "unsafe-private";
  const unselectedSkillName = "unselected-private";
  const selectedMarker = "SELECTED_AGENT_CREATED_SKILL_2026_07_20";
  const unsafeSecret = "sk-agentera-e2e-private-token-20260720";
  const unselectedSecret = "UNSELECTED_PRIVATE_SKILL_2026_07_20";
  const skillsRoot = join(profilePath, "skills");
  const files: Record<string, string> = {
    [`skills/${selectedSkillName}/SKILL.md`]: [
      "---",
      `name: ${selectedSkillName}`,
      "description: Safe agent-created research workflow",
      "---",
      "",
      "# Learned research",
      selectedMarker,
      "",
    ].join("\n"),
    [`skills/${selectedSkillName}/references/checklist.md`]: [
      "# Research checklist",
      "Use verified sources and record uncertainty.",
      "",
    ].join("\n"),
    [`skills/${unsafeSkillName}/SKILL.md`]: [
      "---",
      `name: ${unsafeSkillName}`,
      "description: Secret-bearing local fixture",
      "---",
      "",
      `Never upload ${unsafeSecret}`,
      "",
    ].join("\n"),
    [`skills/${unselectedSkillName}/SKILL.md`]: [
      "---",
      `name: ${unselectedSkillName}`,
      "description: Unselected private learning fixture",
      "---",
      "",
      unselectedSecret,
      "",
    ].join("\n"),
    "MEMORY.md": "# Member private Memory\nMEMBER_MEMORY_PRIVATE_2026_07_20\n",
    "USER.md": "# Member private USER\nMEMBER_USER_PRIVATE_2026_07_20\n",
    "sessions/experience.json":
      '{"session_id":"private","messages":["MEMBER_SESSION_PRIVATE_2026_07_20"]}\n',
    "curator/experience.json":
      '{"curator_state":"MEMBER_CURATOR_PRIVATE_2026_07_20"}\n',
    ".env": "MEMBER_PRIVATE_TOKEN=never-upload-this-value\n",
    "files/experience-private.txt": "MEMBER_LOCAL_FILE_PRIVATE_2026_07_20\n",
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(profilePath, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  await mkdir(skillsRoot, { recursive: true });
  await writeFile(
    join(skillsRoot, ".usage.json"),
    JSON.stringify(
      {
        [selectedSkillName]: { created_by: "agent", state: "active" },
        [unsafeSkillName]: { created_by: "agent", state: "active" },
        [unselectedSkillName]: { created_by: "agent", state: "active" },
      },
      null,
      2,
    ),
    "utf8",
  );
  return {
    selectedSkillName,
    unsafeSkillName,
    unselectedSkillName,
    selectedMarker,
    unsafeSecret,
    unselectedSecret,
    privateMarkers: [
      ".env",
      "MEMORY.md",
      "USER.md",
      "sessions/experience.json",
      "curator/experience.json",
      "files/experience-private.txt",
      "skills/.usage.json",
      `skills/${selectedSkillName}`,
      `skills/${unsafeSkillName}`,
      `skills/${unselectedSkillName}`,
    ],
  };
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
                source_scope, official_release_id, selected_release_revision_id,
                update_policy, runtime_profile_id, policy_snapshot_id, status, retry_code,
                created_at, updated_at
         FROM local_agent_installations
         ORDER BY created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    const installations: AgenteraAgentInstallationSummary[] =
      installationRows.map((row) => ({
        id: String(row.agent_installation_id),
        sourceScope:
          row.source_scope as AgenteraAgentInstallationSummary["sourceScope"],
        officialReleaseId:
          row.official_release_id === null
            ? null
            : String(row.official_release_id),
        selectedReleaseRevisionId:
          row.selected_release_revision_id === null
            ? null
            : String(row.selected_release_revision_id),
        updatePolicy:
          row.update_policy as AgenteraAgentInstallationSummary["updatePolicy"],
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
        officialReleaseRevisionId: parsed.officialReleaseRevisionId ?? null,
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
