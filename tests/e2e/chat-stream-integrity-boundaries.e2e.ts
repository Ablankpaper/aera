import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "playwright/test";

import { customProviderRuntimeRoute } from "../../src/shared/custom-providers";
import { customProviderEnvKey } from "../../src/shared/url-key-map";
import {
  authenticateNewProductAccount,
  closeProductAuthHarness,
  createProductAuthHarness,
  launchRuntimeDesktop,
  type ProductAuthHarness,
} from "./support/agentera-product-auth-harness";
import {
  BOUNDARY_TOOL_CALL_ID,
  BOUNDARY_TOOL_RESULT,
  classifyStreamIntegrityBoundaryRequest,
  STALE_STREAM_SENTINEL,
  streamIntegrityBoundaryReply,
  streamIntegrityBoundaryToolCall,
  type StreamIntegrityBoundaryScenario,
} from "./support/chat-stream-integrity-boundaries-provider";

const MODEL = "aera-stream-integrity-boundaries-e2e";
const PROVIDER_NAME = "stream-integrity-boundaries-loopback";
const PROVIDER_ENV_KEY = customProviderEnvKey(PROVIDER_NAME);

interface TextMetrics {
  sha256: string;
  utf8Bytes: number;
}

interface StateDbMetrics extends TextMetrics {
  sessionId: string;
}

interface CompletionMetrics extends TextMetrics {
  finalSeq: number;
  payloadSha256: string;
  socketIndex: number;
  streamId: string;
}

interface StreamStartCapture {
  socketIndex: number;
  streamId: string;
}

interface BoundaryCaptureSnapshot {
  completions: CompletionMetrics[];
  socketCount: number;
  socketReadyStates: number[];
  starts: StreamStartCapture[];
}

interface BoundaryProviderState {
  afterRestartRequestCount: number;
  auxiliaryRequestCount: number;
  invalidRequestCount: number;
  reconnectHoldReached: boolean;
  reconnectReleased: boolean;
  reconnectRequestCount: number;
  toolCallRequestCount: number;
  toolFinalRequestCount: number;
}

interface ToolDbEvidence {
  assistantToolCallRows: number;
  exactTerminalCallRows: number;
  exactToolResultRows: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function metrics(text: string): TextMetrics {
  return {
    sha256: sha256(text),
    utf8Bytes: Buffer.byteLength(text, "utf8"),
  };
}

function command(
  executable: string,
  args: string[],
  options: { cwd?: string } = {},
): string {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw new Error(`${executable} could not be started.`);
  if (result.signal) {
    throw new Error(`${executable} was terminated by ${result.signal}.`);
  }
  if (result.status === null) {
    throw new Error(`${executable} completed without an exit status.`);
  }
  if (result.status !== 0) {
    throw new Error(`${executable} failed with exit ${String(result.status)}.`);
  }
  return result.stdout.trim();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredAbsolutePathEnvironment(name: string): string {
  const value = requiredEnvironment(name);
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return resolve(value);
}

function requiredShaEnvironment(name: string): string {
  const value = requiredEnvironment(name);
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${name} must be a lowercase 40-character Git SHA.`);
  }
  return value;
}

function cloneDirectory(source: string, destination: string): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "The isolated stream-integrity boundary Electron gate is macOS-only.",
    );
  }
  command("cp", ["-cR", source, destination]);
}

function assertDescendant(parent: string, candidate: string): void {
  const pathFromParent = relative(parent, candidate);
  if (
    !pathFromParent ||
    pathFromParent === ".." ||
    pathFromParent.startsWith(`..${sep}`) ||
    isAbsolute(pathFromParent)
  ) {
    throw new Error("The isolated Runtime root is outside its test harness.");
  }
}

function isolatedRuntimeRoot(harness: ProductAuthHarness): string {
  const harnessRoot = resolve(harness.root);
  const runtimeRoot = resolve(harness.hermesHome, "hermes-agent");
  assertDescendant(harnessRoot, runtimeRoot);
  return runtimeRoot;
}

function validateOwnedRuntimeRoot(
  harness: ProductAuthHarness,
  runtimeRoot: string,
): void {
  const expectedRuntimeRoot = isolatedRuntimeRoot(harness);
  if (runtimeRoot !== expectedRuntimeRoot) {
    throw new Error("The isolated Runtime root does not match this harness.");
  }
  if (existsSync(runtimeRoot)) {
    assertDescendant(realpathSync(harness.root), realpathSync(runtimeRoot));
  }
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function ownedRuntimeProcessIds(runtimeRoot: string): number[] {
  if (!isAbsolute(runtimeRoot) || resolve(runtimeRoot) !== runtimeRoot) {
    throw new Error("The isolated Runtime root must be an absolute path.");
  }
  const result = spawnSync("ps", ["-ww", "-axo", "pid=,command="], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) {
    throw new Error("Unable to enumerate isolated Runtime processes.");
  }
  if (result.signal) {
    throw new Error(
      `Runtime process enumeration was terminated by ${result.signal}.`,
    );
  }
  if (result.status === null) {
    throw new Error("Runtime process enumeration returned no exit status.");
  }
  if (result.status !== 0) {
    throw new Error(
      `Runtime process enumeration failed with exit ${String(result.status)}.`,
    );
  }
  const exactRoot = new RegExp(
    `(?:^|[\\s"'=])${regexEscape(runtimeRoot)}(?:$|[\\s/"'])`,
    "u",
  );
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .map((line): { commandLine: string; pid: number } | null => {
      const match = /^(\d+)\s+(.+)$/u.exec(line);
      if (!match) return null;
      const pid = Number.parseInt(match[1], 10);
      return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid
        ? { commandLine: match[2], pid }
        : null;
    })
    .filter((row): row is { commandLine: string; pid: number } => row !== null)
    .filter((row) => exactRoot.test(row.commandLine))
    .map((row) => row.pid);
}

function terminateOwnedRuntimeProcesses(
  harness: ProductAuthHarness,
  runtimeRoot: string,
): void {
  validateOwnedRuntimeRoot(harness, runtimeRoot);
  for (const pid of ownedRuntimeProcessIds(runtimeRoot)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function prepareExternalRuntime(
  harness: ProductAuthHarness,
  runtimeRepository: string,
  runtimeSha: string,
  runtimeVenv: string,
  runtimeNodeModules: string,
): Promise<void> {
  const repository = resolve(runtimeRepository);
  if (command("git", ["-C", repository, "status", "--porcelain"])) {
    throw new Error("AERA_STREAM_INTEGRITY_RUNTIME_REPO must be clean.");
  }
  if (
    command("git", ["-C", repository, "rev-parse", "origin/main"]) !==
    runtimeSha
  ) {
    throw new Error("Runtime expected SHA is not the current origin/main.");
  }
  command("git", [
    "-C",
    repository,
    "cat-file",
    "-e",
    `${runtimeSha}^{commit}`,
  ]);

  const runtimeRoot = isolatedRuntimeRoot(harness);
  command("git", [
    "clone",
    "--shared",
    "--no-checkout",
    repository,
    runtimeRoot,
  ]);
  command("git", ["-C", runtimeRoot, "checkout", "--detach", runtimeSha]);
  if (command("git", ["-C", runtimeRoot, "status", "--porcelain"])) {
    throw new Error(
      "Prepared Runtime source is not clean before dependencies.",
    );
  }

  cloneDirectory(resolve(runtimeVenv), join(runtimeRoot, "venv"));
  cloneDirectory(
    resolve(runtimeNodeModules),
    join(runtimeRoot, "node_modules"),
  );
  command("npm", ["run", "build", "--workspace", "web"], {
    cwd: runtimeRoot,
  });

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

function writeSse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function beginSse(response: ServerResponse): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
}

async function writeTextStream(
  response: ServerResponse,
  id: string,
  scenario: StreamIntegrityBoundaryScenario,
  holdAfterFirstChunk?: () => Promise<void>,
): Promise<void> {
  const text = streamIntegrityBoundaryReply(scenario);
  const chunks = Array.from(text);
  beginSse(response);
  for (let index = 0; index < chunks.length; index += 1) {
    writeSse(response, {
      id,
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: {
            ...(index === 0 ? { role: "assistant" } : {}),
            content: chunks[index],
          },
        },
      ],
    });
    if (index === 0 && holdAfterFirstChunk) await holdAfterFirstChunk();
    await new Promise<void>((resolveChunk) => setImmediate(resolveChunk));
  }
  writeSse(response, {
    id,
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [{ index: 0, finish_reason: "stop", delta: {} }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: chunks.length,
      total_tokens: chunks.length + 1,
    },
  });
  response.end("data: [DONE]\n\n");
}

async function writeToolCallStream(response: ServerResponse): Promise<void> {
  const toolCall = streamIntegrityBoundaryToolCall();
  beginSse(response);
  writeSse(response, {
    id: "chatcmpl-stream-integrity-boundary-tool-call",
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [
      {
        index: 0,
        finish_reason: null,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: toolCall.id,
              type: toolCall.type,
              function: toolCall.function,
            },
          ],
        },
      },
    ],
  });
  await new Promise<void>((resolveChunk) => setImmediate(resolveChunk));
  writeSse(response, {
    id: "chatcmpl-stream-integrity-boundary-tool-call",
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }],
  });
  response.end("data: [DONE]\n\n");
}

async function startBoundaryProvider(): Promise<{
  baseUrl: string;
  releaseReconnect: () => void;
  server: Server;
  state: BoundaryProviderState;
}> {
  const state: BoundaryProviderState = {
    afterRestartRequestCount: 0,
    auxiliaryRequestCount: 0,
    invalidRequestCount: 0,
    reconnectHoldReached: false,
    reconnectReleased: false,
    reconnectRequestCount: 0,
    toolCallRequestCount: 0,
    toolFinalRequestCount: 0,
  };
  let resolveReconnect: (() => void) | null = null;
  const reconnectGate = new Promise<void>((resolveGate) => {
    resolveReconnect = resolveGate;
  });
  const releaseReconnect = (): void => {
    if (state.reconnectReleased) return;
    state.reconnectReleased = true;
    resolveReconnect?.();
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [{ id: MODEL, object: "model", owned_by: "aera-e2e" }],
          }),
        );
        return;
      }
      if (
        request.method !== "POST" ||
        url.pathname !== "/v1/chat/completions"
      ) {
        response.writeHead(404).end();
        return;
      }

      let requestBody = "";
      for await (const chunk of request) requestBody += String(chunk);
      const classified = classifyStreamIntegrityBoundaryRequest(
        JSON.parse(requestBody) as unknown,
      );

      if (classified.kind === "invalid") {
        state.invalidRequestCount += 1;
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Unclassified stream-integrity boundary request",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }

      if (classified.kind === "auxiliary") {
        state.auxiliaryRequestCount += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: `chatcmpl-stream-integrity-boundary-aux-${state.auxiliaryRequestCount}`,
            object: "chat.completion",
            model: MODEL,
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "边界完整性验收" },
              },
            ],
          }),
        );
        return;
      }

      if (classified.kind === "tool") {
        if (classified.phase === "call") {
          state.toolCallRequestCount += 1;
          await writeToolCallStream(response);
        } else {
          state.toolFinalRequestCount += 1;
          await writeTextStream(
            response,
            "chatcmpl-stream-integrity-boundary-tool-final",
            "tool",
          );
        }
        return;
      }

      if (classified.kind === "reconnect") {
        state.reconnectRequestCount += 1;
        await writeTextStream(
          response,
          "chatcmpl-stream-integrity-boundary-reconnect",
          "reconnect",
          async () => {
            state.reconnectHoldReached = true;
            await reconnectGate;
          },
        );
        return;
      }

      state.afterRestartRequestCount += 1;
      await writeTextStream(
        response,
        "chatcmpl-stream-integrity-boundary-after-restart",
        "after-restart",
      );
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
    throw new Error("Loopback provider did not expose a TCP port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    releaseReconnect,
    server,
    state,
  };
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function installBoundaryWebSocketCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    type CaptureWindow = typeof window & {
      __AERA_STREAM_BOUNDARY_CAPTURE__?: {
        completions: CompletionMetrics[];
        sockets: WebSocket[];
        starts: StreamStartCapture[];
      };
    };
    const captureWindow = window as CaptureWindow;
    const NativeWebSocket = window.WebSocket;
    const capture = {
      completions: [] as CompletionMetrics[],
      sockets: [] as WebSocket[],
      starts: [] as StreamStartCapture[],
    };
    captureWindow.__AERA_STREAM_BOUNDARY_CAPTURE__ = capture;

    class CapturingWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const socketIndex = capture.sockets.push(this) - 1;
        this.addEventListener("message", (event) => {
          void (async () => {
            if (typeof event.data !== "string") return;
            let value: unknown;
            try {
              value = JSON.parse(event.data);
            } catch {
              return;
            }
            if (!value || typeof value !== "object") return;
            const row = value as Record<string, unknown>;
            const params =
              row.method === "event" &&
              row.params &&
              typeof row.params === "object"
                ? (row.params as Record<string, unknown>)
                : row;
            const payload =
              params.payload && typeof params.payload === "object"
                ? (params.payload as Record<string, unknown>)
                : {};
            if (
              params.type === "message.start" &&
              typeof payload.stream_id === "string"
            ) {
              capture.starts.push({
                socketIndex,
                streamId: payload.stream_id,
              });
              return;
            }
            if (params.type !== "message.complete") return;
            if (
              typeof payload.stream_id !== "string" ||
              typeof payload.final_seq !== "number" ||
              typeof payload.text !== "string" ||
              typeof payload.text_sha256 !== "string"
            ) {
              return;
            }
            const bytes = new TextEncoder().encode(payload.text);
            const hash = new Uint8Array(
              await crypto.subtle.digest("SHA-256", bytes),
            );
            capture.completions.push({
              finalSeq: payload.final_seq,
              payloadSha256: payload.text_sha256,
              sha256: Array.from(hash)
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join(""),
              socketIndex,
              streamId: payload.stream_id,
              utf8Bytes: bytes.byteLength,
            });
          })();
        });
      }
    }

    window.WebSocket = CapturingWebSocket;
  });
}

async function boundaryCaptureSnapshot(
  page: Page,
): Promise<BoundaryCaptureSnapshot> {
  return page.evaluate(() => {
    const captureWindow = window as typeof window & {
      __AERA_STREAM_BOUNDARY_CAPTURE__?: {
        completions: CompletionMetrics[];
        sockets: WebSocket[];
        starts: StreamStartCapture[];
      };
    };
    const capture = captureWindow.__AERA_STREAM_BOUNDARY_CAPTURE__;
    if (!capture) {
      return {
        completions: [],
        socketCount: 0,
        socketReadyStates: [],
        starts: [],
      };
    }
    return {
      completions: [...capture.completions],
      socketCount: capture.sockets.length,
      socketReadyStates: capture.sockets.map((socket) => socket.readyState),
      starts: [...capture.starts],
    };
  });
}

async function closeCapturedSocket(
  page: Page,
  socketIndex: number,
): Promise<void> {
  await page.evaluate((index) => {
    const captureWindow = window as typeof window & {
      __AERA_STREAM_BOUNDARY_CAPTURE__?: { sockets: WebSocket[] };
    };
    const socket =
      captureWindow.__AERA_STREAM_BOUNDARY_CAPTURE__?.sockets[index];
    if (!socket) throw new Error("Captured WebSocket is missing.");
    socket.close(4000, "isolated boundary reconnect");
  }, socketIndex);
}

async function injectStaleStreamDelta(
  page: Page,
  input: { seq: number; socketIndex: number; streamId: string },
): Promise<void> {
  await page.evaluate(
    async ({ seq, socketIndex, streamId, text }) => {
      const captureWindow = window as typeof window & {
        __AERA_STREAM_BOUNDARY_CAPTURE__?: { sockets: WebSocket[] };
      };
      const socket =
        captureWindow.__AERA_STREAM_BOUNDARY_CAPTURE__?.sockets[socketIndex];
      if (!socket) throw new Error("Old captured WebSocket is missing.");
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            method: "event",
            params: {
              type: "message.delta",
              payload: { stream_id: streamId, seq, text },
            },
          }),
        }),
      );
      await new Promise<void>((resolveFrame) =>
        requestAnimationFrame(() => resolveFrame()),
      );
      await new Promise<void>((resolveFrame) =>
        requestAnimationFrame(() => resolveFrame()),
      );
    },
    { ...input, text: STALE_STREAM_SENTINEL },
  );
}

async function visibleMetrics(page: Page): Promise<TextMetrics | null> {
  const bubble = page.locator(".chat-message-agent .chat-bubble-agent").last();
  if ((await bubble.count()) === 0) return null;
  return bubble.evaluate(async (element) => {
    const text = (element as HTMLElement).innerText;
    const bytes = new TextEncoder().encode(text);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return {
      sha256: Array.from(hash)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      utf8Bytes: bytes.byteLength,
    };
  });
}

function latestStateDbMetrics(
  databasePath: string,
  sessionId: string | null,
): StateDbMetrics | null {
  if (!existsSync(databasePath)) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const statement = database.prepare(
      sessionId
        ? `SELECT session_id, content
             FROM messages
            WHERE role = 'assistant' AND session_id = ?
            ORDER BY timestamp DESC, id DESC
            LIMIT 1`
        : `SELECT session_id, content
             FROM messages
            WHERE role = 'assistant'
            ORDER BY timestamp DESC, id DESC
            LIMIT 1`,
    );
    const row = (sessionId ? statement.get(sessionId) : statement.get()) as
      | { content?: unknown; session_id?: unknown }
      | undefined;
    if (
      typeof row?.content !== "string" ||
      typeof row.session_id !== "string" ||
      row.session_id.length === 0
    ) {
      return null;
    }
    return { ...metrics(row.content), sessionId: row.session_id };
  } finally {
    database.close();
  }
}

function toolDbEvidence(
  databasePath: string,
  sessionId: string,
): ToolDbEvidence {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT role, content, tool_call_id, tool_calls
           FROM messages
          WHERE session_id = ?
          ORDER BY id ASC`,
      )
      .all(sessionId) as Array<{
      content?: unknown;
      role?: unknown;
      tool_call_id?: unknown;
      tool_calls?: unknown;
    }>;
    let assistantToolCallRows = 0;
    let exactTerminalCallRows = 0;
    let exactToolResultRows = 0;
    for (const row of rows) {
      if (row.role === "assistant" && typeof row.tool_calls === "string") {
        let toolCalls: unknown;
        try {
          toolCalls = JSON.parse(row.tool_calls) as unknown;
        } catch {
          toolCalls = null;
        }
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          assistantToolCallRows += 1;
          if (
            toolCalls.some(
              (toolCall) =>
                toolCall &&
                typeof toolCall === "object" &&
                (toolCall as { id?: unknown }).id === BOUNDARY_TOOL_CALL_ID &&
                (toolCall as { function?: { name?: unknown } }).function
                  ?.name === "terminal",
            )
          ) {
            exactTerminalCallRows += 1;
          }
        }
      }
      if (
        row.role === "tool" &&
        row.tool_call_id === BOUNDARY_TOOL_CALL_ID &&
        typeof row.content === "string" &&
        row.content.includes(BOUNDARY_TOOL_RESULT)
      ) {
        exactToolResultRows += 1;
      }
    }
    return {
      assistantToolCallRows,
      exactTerminalCallRows,
      exactToolResultRows,
    };
  } finally {
    database.close();
  }
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const chatInput = page.locator("textarea.chat-input:visible");
  const sendButton = page.locator("button.chat-send-btn:visible");
  await expect(chatInput).toBeVisible({ timeout: 180_000 });
  await chatInput.fill(prompt);
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
}

async function waitForReplyAgreement(
  page: Page,
  databasePath: string,
  sessionId: string | null,
  scenario: StreamIntegrityBoundaryScenario,
  completionIndex: number,
): Promise<{
  completion: CompletionMetrics;
  sessionId: string;
  stateDb: TextMetrics;
  visible: TextMetrics;
}> {
  const expected = metrics(streamIntegrityBoundaryReply(scenario));
  await expect
    .poll(
      async () => (await boundaryCaptureSnapshot(page)).completions.length,
      { timeout: 120_000 },
    )
    .toBe(completionIndex + 1);
  await expect
    .poll(() => visibleMetrics(page), { timeout: 120_000 })
    .toEqual(expected);

  let boundSessionId = sessionId;
  await expect
    .poll(
      () => {
        const stateDb = latestStateDbMetrics(databasePath, boundSessionId);
        if (
          !boundSessionId &&
          stateDb?.sha256 === expected.sha256 &&
          stateDb.utf8Bytes === expected.utf8Bytes
        ) {
          boundSessionId = stateDb.sessionId;
        }
        return stateDb
          ? { sha256: stateDb.sha256, utf8Bytes: stateDb.utf8Bytes }
          : null;
      },
      { timeout: 120_000 },
    )
    .toEqual(expected);
  if (!boundSessionId) {
    throw new Error("The isolated state.db session could not be bound.");
  }

  const capture = await boundaryCaptureSnapshot(page);
  const completion = capture.completions[completionIndex];
  expect(completion).toBeDefined();
  expect(completion.payloadSha256).toBe(expected.sha256);
  expect(completion.sha256).toBe(expected.sha256);
  expect(completion.utf8Bytes).toBe(expected.utf8Bytes);
  expect(completion.streamId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(completion.finalSeq).toBeGreaterThan(0);

  return {
    completion,
    sessionId: boundSessionId,
    stateDb: expected,
    visible: expected,
  };
}

async function enterMainLayout(page: Page): Promise<void> {
  const profileClaim = page.locator('[data-testid="screen-profile-claim"]');
  const mainLayout = page.locator(".layout");
  await expect(profileClaim.or(mainLayout)).toBeVisible({ timeout: 180_000 });
  if (await profileClaim.isVisible()) {
    await page.locator(".agentera-profile-actions .btn-primary").click();
  }
  await expect(mainLayout).toBeVisible({ timeout: 180_000 });
}

async function dismissStartupModelPrompt(page: Page): Promise<void> {
  const prompt = page.locator(".startup-model-prompt");
  if (await prompt.isVisible()) {
    await prompt.getByRole("button", { name: /^(Later|稍后)$/u }).click();
  }
}

test.setTimeout(1_200_000);

// @lat: [[chat-performance#Chat stream integrity#Supplemental real Electron boundaries]]
// Playwright requires its fixtures argument to use object destructuring.
// eslint-disable-next-line no-empty-pattern
test("preserves tool replies, rejects a stale stream after reconnect, and survives a cold restart", async ({}, testInfo) => {
  const runtimeRepository = requiredAbsolutePathEnvironment(
    "AERA_STREAM_INTEGRITY_RUNTIME_REPO",
  );
  const runtimeSha = requiredShaEnvironment(
    "AERA_STREAM_INTEGRITY_RUNTIME_SHA",
  );
  const runtimeVenv = requiredAbsolutePathEnvironment(
    "AERA_STREAM_INTEGRITY_RUNTIME_VENV",
  );
  const runtimeNodeModules = requiredAbsolutePathEnvironment(
    "AERA_STREAM_INTEGRITY_RUNTIME_NODE_MODULES",
  );
  const expectedDesktopSha = requiredShaEnvironment(
    "AERA_STREAM_INTEGRITY_DESKTOP_SHA",
  );
  const desktopSha = command("git", ["rev-parse", "HEAD"], {
    cwd: resolve(process.cwd()),
  });
  expect(desktopSha).toBe(expectedDesktopSha);
  expect(
    command("git", ["status", "--porcelain"], { cwd: process.cwd() }),
  ).toBe("");

  let harness: ProductAuthHarness | null = null;
  let app: ElectronApplication | null = null;
  let providerServer: Server | null = null;
  let runtimeRoot: string | null = null;
  let releaseReconnect: (() => void) | null = null;
  const launchedRuntimeProcessIds = new Set<number>();
  const previousProviderKey = process.env[PROVIDER_ENV_KEY];
  const evidence: Record<
    StreamIntegrityBoundaryScenario,
    { sha256: string; utf8Bytes: number }
  > = {
    tool: metrics(streamIntegrityBoundaryReply("tool")),
    reconnect: metrics(streamIntegrityBoundaryReply("reconnect")),
    "after-restart": metrics(streamIntegrityBoundaryReply("after-restart")),
  };
  let toolEvidence: ToolDbEvidence | null = null;
  let staleDeltaRejected = false;
  let coldRestartPersisted = false;

  try {
    const provider = await startBoundaryProvider();
    providerServer = provider.server;
    releaseReconnect = provider.releaseReconnect;
    process.env[PROVIDER_ENV_KEY] = "isolated-loopback-e2e-only";

    harness = await createProductAuthHarness();
    runtimeRoot = isolatedRuntimeRoot(harness);
    await prepareExternalRuntime(
      harness,
      runtimeRepository,
      runtimeSha,
      runtimeVenv,
      runtimeNodeModules,
    );
    const emptySeed = join(harness.root, "unused-runtime-seed");
    await mkdir(emptySeed, { recursive: true });
    const preparedRuntimeRoot = runtimeRoot;
    validateOwnedRuntimeRoot(harness, preparedRuntimeRoot);
    expect(ownedRuntimeProcessIds(preparedRuntimeRoot)).toEqual([]);

    ({ app } = await launchRuntimeDesktop(harness, emptySeed));
    let page = await app.firstWindow();
    await authenticateNewProductAccount(harness, app, page, {
      displayName: "Stream Boundary Disposable User",
    });
    await enterMainLayout(page);

    const activeProfile = await page.evaluate(async () => {
      const profiles = await window.hermesAPI.listProfiles();
      return profiles.find((profile) => profile.isActive) ?? null;
    });
    if (!activeProfile) {
      throw new Error("Isolated active Runtime Profile is missing.");
    }

    const configured = await page.evaluate(
      async ({ baseUrl, model, profileId, providerName }) => {
        await window.hermesAPI.upsertCustomProvider(profileId, {
          name: providerName,
          baseUrl,
        });
        await window.hermesAPI.addModel(
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
        return window.hermesAPI.getModelConfig(profileId);
      },
      {
        baseUrl: provider.baseUrl,
        model: MODEL,
        profileId: activeProfile.id,
        providerName: PROVIDER_NAME,
      },
    );
    expect(configured).toEqual({
      provider: customProviderRuntimeRoute(PROVIDER_NAME),
      model: MODEL,
      baseUrl: provider.baseUrl,
    });

    await page.reload();
    await enterMainLayout(page);
    await installBoundaryWebSocketCapture(page);
    await dismissStartupModelPrompt(page);
    const stateDatabase = join(activeProfile.path, "state.db");

    await sendPrompt(page, "AERA_STREAM_INTEGRITY_BOUNDARY_TOOL");
    await expect
      .poll(() => provider.state.toolCallRequestCount, { timeout: 120_000 })
      .toBe(1);
    await expect
      .poll(() => provider.state.toolFinalRequestCount, { timeout: 120_000 })
      .toBe(1);
    await expect
      .poll(() => ownedRuntimeProcessIds(preparedRuntimeRoot).length, {
        timeout: 120_000,
      })
      .toBeGreaterThan(0);
    for (const pid of ownedRuntimeProcessIds(preparedRuntimeRoot)) {
      launchedRuntimeProcessIds.add(pid);
    }
    expect(launchedRuntimeProcessIds.size).toBeGreaterThan(0);

    const toolAgreement = await waitForReplyAgreement(
      page,
      stateDatabase,
      null,
      "tool",
      0,
    );
    await expect
      .poll(() => page.locator(".chat-tool-group").count(), {
        timeout: 120_000,
      })
      .toBeGreaterThan(0);
    toolEvidence = toolDbEvidence(stateDatabase, toolAgreement.sessionId);
    expect(toolEvidence).toEqual({
      assistantToolCallRows: 1,
      exactTerminalCallRows: 1,
      exactToolResultRows: 1,
    });

    const toolCapture = await boundaryCaptureSnapshot(page);
    const toolStart = toolCapture.starts.find(
      (start) => start.streamId === toolAgreement.completion.streamId,
    );
    expect(toolStart).toBeDefined();
    expect(toolStart?.socketIndex).toBe(toolAgreement.completion.socketIndex);
    await closeCapturedSocket(page, toolAgreement.completion.socketIndex);
    await expect
      .poll(
        async () =>
          (await boundaryCaptureSnapshot(page)).socketReadyStates[
            toolAgreement.completion.socketIndex
          ],
        { timeout: 30_000 },
      )
      .toBe(3);

    await sendPrompt(page, "AERA_STREAM_INTEGRITY_BOUNDARY_RECONNECT");
    await expect
      .poll(() => provider.state.reconnectHoldReached, { timeout: 120_000 })
      .toBe(true);
    await expect
      .poll(async () => (await boundaryCaptureSnapshot(page)).socketCount, {
        timeout: 120_000,
      })
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(async () => (await boundaryCaptureSnapshot(page)).starts.length, {
        timeout: 120_000,
      })
      .toBeGreaterThanOrEqual(2);

    const reconnectCapture = await boundaryCaptureSnapshot(page);
    const reconnectStart = reconnectCapture.starts.at(-1);
    expect(reconnectStart).toBeDefined();
    expect(reconnectStart?.streamId).not.toBe(
      toolAgreement.completion.streamId,
    );
    expect(reconnectStart?.socketIndex).not.toBe(
      toolAgreement.completion.socketIndex,
    );
    await injectStaleStreamDelta(page, {
      socketIndex: toolAgreement.completion.socketIndex,
      streamId: toolAgreement.completion.streamId,
      seq: toolAgreement.completion.finalSeq + 1,
    });
    await expect(
      page.getByText(STALE_STREAM_SENTINEL, { exact: false }),
    ).toHaveCount(0);
    staleDeltaRejected = true;
    provider.releaseReconnect();

    const reconnectAgreement = await waitForReplyAgreement(
      page,
      stateDatabase,
      toolAgreement.sessionId,
      "reconnect",
      1,
    );
    expect(reconnectAgreement.completion.streamId).toBe(
      reconnectStart?.streamId,
    );
    expect(provider.state.reconnectRequestCount).toBe(1);
    expect(provider.state.invalidRequestCount).toBe(0);

    await app.close();
    app = null;
    await expect
      .poll(() => ownedRuntimeProcessIds(preparedRuntimeRoot), {
        timeout: 30_000,
      })
      .toEqual([]);

    ({ app, page } = await launchRuntimeDesktop(harness, emptySeed));
    await expect
      .poll(() => page.evaluate(() => window.agenteraAuth.getState()), {
        timeout: 120_000,
      })
      .toMatchObject({ status: "authenticated" });
    await enterMainLayout(page);
    await installBoundaryWebSocketCapture(page);
    await dismissStartupModelPrompt(page);

    const recentSession = page.locator(".sidebar-recent-session").first();
    await expect(recentSession).toBeVisible({ timeout: 120_000 });
    await recentSession.click();
    await expect(recentSession).toHaveClass(/active/u, { timeout: 120_000 });
    await expect
      .poll(() => visibleMetrics(page), { timeout: 120_000 })
      .toEqual(evidence.reconnect);
    const restartedStateDb = latestStateDbMetrics(
      stateDatabase,
      reconnectAgreement.sessionId,
    );
    expect(restartedStateDb).toMatchObject(evidence.reconnect);
    coldRestartPersisted = true;

    await sendPrompt(page, "AERA_STREAM_INTEGRITY_BOUNDARY_AFTER_RESTART");
    await expect
      .poll(() => provider.state.afterRestartRequestCount, {
        timeout: 120_000,
      })
      .toBe(1);
    await expect
      .poll(() => ownedRuntimeProcessIds(preparedRuntimeRoot).length, {
        timeout: 120_000,
      })
      .toBeGreaterThan(0);
    const restartAgreement = await waitForReplyAgreement(
      page,
      stateDatabase,
      reconnectAgreement.sessionId,
      "after-restart",
      0,
    );
    expect(restartAgreement.sessionId).toBe(reconnectAgreement.sessionId);
    expect(provider.state.invalidRequestCount).toBe(0);

    await app.close();
    app = null;
    await expect
      .poll(() => ownedRuntimeProcessIds(preparedRuntimeRoot), {
        timeout: 30_000,
      })
      .toEqual([]);

    await testInfo.attach("chat-stream-integrity-boundaries-evidence.json", {
      body: Buffer.from(
        `${JSON.stringify(
          {
            desktopSha,
            runtimeSha,
            metrics: evidence,
            toolEvidence,
            staleDeltaRejected,
            coldRestartPersisted,
            actualSocketReconnect: true,
            providerAuxiliaryRequests: provider.state.auxiliaryRequestCount,
            providerInvalidRequests: provider.state.invalidRequestCount,
            providerToolCallRequests: provider.state.toolCallRequestCount,
            providerToolFinalRequests: provider.state.toolFinalRequestCount,
            providerReconnectRequests: provider.state.reconnectRequestCount,
            providerAfterRestartRequests:
              provider.state.afterRestartRequestCount,
            runtimeObservedBeforeBothCloses: true,
            runtimeAbsentAfterBothCloses: true,
          },
          null,
          2,
        )}\n`,
        "utf8",
      ),
      contentType: "application/json",
    });
  } finally {
    releaseReconnect?.();
    try {
      try {
        await app?.close().catch(() => undefined);
        if (harness && runtimeRoot) {
          terminateOwnedRuntimeProcesses(harness, runtimeRoot);
        }
      } finally {
        await closeServer(providerServer);
      }
    } finally {
      try {
        await closeProductAuthHarness(harness);
      } finally {
        if (previousProviderKey === undefined) {
          delete process.env[PROVIDER_ENV_KEY];
        } else {
          process.env[PROVIDER_ENV_KEY] = previousProviderKey;
        }
      }
    }
  }
});
