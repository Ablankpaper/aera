#!/usr/bin/env node

import { extractFile } from "@electron/asar";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { canonicalJSONStringify } from "./candidate-manifest.mjs";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^0\.7\.4-internal-beta\.\d+$/u;
const STARTUP_EVENTS = Object.freeze([
  "main_loaded",
  "preload_loaded",
  "renderer_loaded",
  "first_window_visible",
  "health_marked",
]);

function fail(message) {
  throw new Error(`Packaged startup verification failed: ${message}`);
}

function requiredString(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value))
    fail(`${label} is invalid`);
  return value;
}

export function validateRendererProbe(value, expectedVersion) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Renderer probe is invalid");
  }
  if (!["interactive", "complete"].includes(value.readyState)) {
    fail("Renderer document did not finish loading");
  }
  if (value.visibilityState !== "visible") fail("first window is not visible");
  if (value.locationProtocol !== "file:")
    fail("Renderer did not load packaged bytes");
  if (
    !Number.isSafeInteger(value.bodyTextLength) ||
    value.bodyTextLength <= 0
  ) {
    fail("Renderer body is blank");
  }
  if (value.hasHermesApi !== true || value.hasRendererReadyBridge !== true) {
    fail("Preload bridge is unavailable");
  }
  if (value.rendererReadyAccepted !== true)
    fail("Renderer health handshake was rejected");
  if (value.appVersion !== expectedVersion)
    fail("Renderer app version differs");
  return {
    readyState: value.readyState,
    visibilityState: value.visibilityState,
    locationProtocol: value.locationProtocol,
    bodyTextLength: value.bodyTextLength,
    rendererReadyAccepted: true,
    appVersion: expectedVersion,
  };
}

export function buildPackagedStartupEvidence(input) {
  const sourceSha = requiredString(input.sourceSha, "source SHA", SHA_PATTERN);
  const version = requiredString(input.version, "version", VERSION_PATTERN);
  if (!["darwin", "win32"].includes(input.platform))
    fail("platform is invalid");
  if (!["arm64", "x64"].includes(input.architecture))
    fail("architecture is invalid");
  const hash = (value, label) => requiredString(value, label, HASH_PATTERN);
  if (input.renderer?.appVersion !== version)
    fail("Renderer evidence version differs");
  return {
    schemaVersion: 1,
    sourceSha,
    version,
    platform: input.platform,
    architecture: input.architecture,
    executable: { sha256: hash(input.executableSha256, "executable hash") },
    appAsar: { sha256: hash(input.appAsarSha256, "app.asar hash") },
    entries: {
      main: { sha256: hash(input.entryHashes?.main, "Main entry hash") },
      preload: {
        sha256: hash(input.entryHashes?.preload, "Preload entry hash"),
      },
      renderer: {
        sha256: hash(input.entryHashes?.renderer, "Renderer entry hash"),
      },
    },
    renderer: { ...input.renderer },
    events: [...STARTUP_EVENTS],
  };
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resolveApplication(appPath, platform) {
  const root = resolve(appPath);
  if (platform === "darwin") {
    if (!root.endsWith(".app"))
      fail("macOS application must be an .app directory");
    const executableDirectory = join(root, "Contents", "MacOS");
    const executableNames = (await readdir(executableDirectory)).filter(
      (name) => !name.startsWith("."),
    );
    if (executableNames.length !== 1)
      fail("macOS application executable is ambiguous");
    return {
      executablePath: join(executableDirectory, executableNames[0]),
      appAsarPath: join(root, "Contents", "Resources", "app.asar"),
    };
  }
  const executableNames = (await readdir(root)).filter(
    (name) =>
      name.toLowerCase().endsWith(".exe") &&
      !name.toLowerCase().includes("uninstall"),
  );
  if (executableNames.length !== 1)
    fail("Windows application executable is ambiguous");
  return {
    executablePath: join(root, executableNames[0]),
    appAsarPath: join(root, "resources", "app.asar"),
  };
}

async function unusedPort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  if (!Number.isSafeInteger(port) || port <= 0)
    fail("debug port allocation failed");
  return port;
}

async function devtoolsTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) return [];
  const body = await response.json();
  return Array.isArray(body) ? body : [];
}

async function evaluateRenderer(webSocketDebuggerUrl) {
  return new Promise((accept, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Renderer probe timed out"));
    }, 5_000);
    socket.once("error", reject);
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            awaitPromise: true,
            returnByValue: true,
            expression: `(async () => {
              const api = window.hermesAPI;
              const hasRendererReadyBridge = typeof api?.markRendererReady === "function";
              let rendererReadyAccepted = false;
              let appVersion = null;
              if (hasRendererReadyBridge) {
                rendererReadyAccepted = await api.markRendererReady();
              }
              if (typeof api?.getAppVersion === "function") {
                appVersion = await api.getAppVersion();
              }
              return {
                readyState: document.readyState,
                visibilityState: document.visibilityState,
                locationProtocol: location.protocol,
                bodyTextLength: (document.body?.innerText ?? "").trim().length,
                hasHermesApi: typeof api === "object" && api !== null,
                hasRendererReadyBridge,
                rendererReadyAccepted,
                appVersion,
              };
            })()`,
          },
        }),
      );
    });
    socket.on("message", (bytes) => {
      const message = JSON.parse(String(bytes));
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.exceptionDetails || !message.result?.result?.value) {
        reject(new Error("Renderer probe evaluation failed"));
        return;
      }
      accept(message.result.result.value);
    });
  });
}

async function waitForRenderer(port, expectedVersion, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      fail("application exited before health");
    try {
      const targets = await devtoolsTargets(port);
      const page = targets.find(
        (target) =>
          target?.type === "page" &&
          typeof target.webSocketDebuggerUrl === "string",
      );
      if (page) {
        const probe = await evaluateRenderer(page.webSocketDebuggerUrl);
        return validateRendererProbe(probe, expectedVersion);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((accept) => setTimeout(accept, 250));
  }
  fail(
    lastError instanceof Error
      ? lastError.message
      : "Renderer startup timed out",
  );
}

async function stopApplication(child, platform) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (platform === "win32") {
    await new Promise((accept) => {
      execFile("taskkill", ["/F", "/T", "/PID", String(child.pid)], () =>
        accept(),
      );
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((accept) => setTimeout(accept, 500));
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

function parseArguments(arguments_) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      fail("arguments are invalid");
    result[key.slice(2).replaceAll("-", "_")] = value;
  }
  return result;
}

export function buildPackagedStartupEnvironment(
  baseEnvironment,
  hermesHome,
  port,
) {
  return {
    ...baseEnvironment,
    HERMES_HOME: hermesHome,
    ENABLE_CDP: "1",
    CDP_PORT: String(port),
  };
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const platform = values.platform ?? process.platform;
  const architecture = values.architecture ?? process.arch;
  const version = requiredString(
    values.desktop_version,
    "version",
    VERSION_PATTERN,
  );
  const sourceSha = requiredString(
    values.source_sha,
    "source SHA",
    SHA_PATTERN,
  );
  if (!values.app || !values.output) fail("--app and --output are required");
  const { executablePath, appAsarPath } = await resolveApplication(
    values.app,
    platform,
  );
  if (!(await stat(executablePath)).isFile())
    fail("application executable is missing");
  if (!(await stat(appAsarPath)).isFile()) fail("app.asar is missing");
  const port = await unusedPort();
  const userData = await mkdtemp(join(tmpdir(), "aera-packaged-startup-"));
  const child = spawn(
    executablePath,
    [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
    {
      cwd: dirname(executablePath),
      detached: platform !== "win32",
      env: buildPackagedStartupEnvironment(
        process.env,
        join(userData, "hermes-home"),
        port,
      ),
      stdio: "ignore",
    },
  );
  try {
    const renderer = await waitForRenderer(port, version, child, 60_000);
    const entry = (path) => sha256Bytes(extractFile(appAsarPath, path));
    const evidence = buildPackagedStartupEvidence({
      sourceSha,
      version,
      platform,
      architecture,
      executableSha256: await sha256File(executablePath),
      appAsarSha256: await sha256File(appAsarPath),
      entryHashes: {
        main: entry("out/main/index.js"),
        preload: entry("out/preload/index.js"),
        renderer: entry("out/renderer/index.html"),
      },
      renderer,
    });
    await writeFile(
      resolve(values.output),
      `${canonicalJSONStringify(evidence)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  } finally {
    await stopApplication(child, platform);
    await rm(userData, { recursive: true, force: true });
  }
}

const isEntry =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
