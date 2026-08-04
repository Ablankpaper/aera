import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

const TURN_COUNT = 20;
const MODEL = "aera-stream-integrity-e2e";
const PROVIDER_NAME = "stream-integrity-loopback";
const PROVIDER_ENV_KEY = customProviderEnvKey(PROVIDER_NAME);

interface TextMetrics {
  sha256: string;
  utf8Bytes: number;
}

interface CompletionMetrics {
  computedSha256: string;
  finalSeq: number;
  payloadSha256: string;
  streamId: string;
  utf8Bytes: number;
}

interface ProviderState {
  nonStreamingRequests: number;
  requestCount: number;
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

function replyForTurn(turn: number): string {
  const repeated =
    "企业智能体完整传输，重复短语，重复短语；标点：，。！？🙂👨‍👩‍👧‍👦e\u0301。";
  return `第${String(turn).padStart(2, "0")}条确定性回复开始。${repeated.repeat(8)}第${String(turn).padStart(2, "0")}条确定性回复结束。`;
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
  if (result.status !== 0) {
    throw new Error(
      `${executable} failed with exit ${String(result.status)}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function cloneDirectory(source: string, destination: string): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "The isolated stream-integrity Electron gate is macOS-only.",
    );
  }
  command("cp", ["-cR", source, destination]);
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

  const runtimeRoot = join(harness.hermesHome, "hermes-agent");
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

async function startProvider(): Promise<{
  baseUrl: string;
  server: Server;
  state: ProviderState;
}> {
  const state: ProviderState = {
    nonStreamingRequests: 0,
    requestCount: 0,
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
      const payload = JSON.parse(requestBody) as { stream?: unknown };
      state.requestCount += 1;
      if (payload.stream !== true) state.nonStreamingRequests += 1;
      const text = replyForTurn(state.requestCount);
      const id = `chatcmpl-stream-integrity-${state.requestCount}`;

      if (payload.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            model: MODEL,
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: text },
              },
            ],
          }),
        );
        return;
      }

      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });
      const chunks = Array.from(text);
      for (let index = 0; index < chunks.length; index += 1) {
        response.write(
          `data: ${JSON.stringify({
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
          })}\n\n`,
        );
        await new Promise<void>((resolveChunk) => setImmediate(resolveChunk));
      }
      response.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          model: MODEL,
          choices: [{ index: 0, finish_reason: "stop", delta: {} }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: chunks.length,
            total_tokens: chunks.length + 1,
          },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
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
    server,
    state,
  };
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function installCompletionCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const captureWindow = window as typeof window & {
      __AERA_STREAM_COMPLETIONS__?: CompletionMetrics[];
    };
    captureWindow.__AERA_STREAM_COMPLETIONS__ = [];
    const NativeWebSocket = window.WebSocket;

    class CapturingWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
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
            if (params.type !== "message.complete") return;
            const payload =
              params.payload && typeof params.payload === "object"
                ? (params.payload as Record<string, unknown>)
                : {};
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
            const computedSha256 = Array.from(hash)
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
            captureWindow.__AERA_STREAM_COMPLETIONS__?.push({
              computedSha256,
              finalSeq: payload.final_seq,
              payloadSha256: payload.text_sha256,
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

function latestStateDbMetrics(databasePath: string): TextMetrics | null {
  if (!existsSync(databasePath)) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT content
           FROM messages
          WHERE role = 'assistant'
          ORDER BY timestamp DESC, id DESC
          LIMIT 1`,
      )
      .get() as { content?: unknown } | undefined;
    return typeof row?.content === "string" ? metrics(row.content) : null;
  } finally {
    database.close();
  }
}

function runtimeProcessIds(hermesHome: string): number[] {
  const result = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.includes(hermesHome))
    .map((line) => Number.parseInt(line.split(/\s+/u)[0] || "", 10))
    .filter(
      (pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid,
    );
}

function terminateOwnedRuntimeProcesses(hermesHome: string): void {
  for (const pid of runtimeProcessIds(hermesHome)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The isolated process may already have exited.
    }
  }
}

test.setTimeout(1_200_000);

// @lat: [[chat-performance#Chat stream integrity#Real Electron release gate]]
// Playwright requires its fixtures argument to use object destructuring.
// eslint-disable-next-line no-empty-pattern
test("matches visible, completion, and state.db text for 20 isolated one-character Chinese streams", async ({}, testInfo) => {
  const runtimeRepository =
    process.env.AERA_STREAM_INTEGRITY_RUNTIME_REPO?.trim() ?? "";
  const runtimeSha =
    process.env.AERA_STREAM_INTEGRITY_RUNTIME_SHA?.trim() ?? "";
  const runtimeVenv =
    process.env.AERA_STREAM_INTEGRITY_RUNTIME_VENV?.trim() ?? "";
  const runtimeNodeModules =
    process.env.AERA_STREAM_INTEGRITY_RUNTIME_NODE_MODULES?.trim() ?? "";
  const expectedDesktopSha =
    process.env.AERA_STREAM_INTEGRITY_DESKTOP_SHA?.trim() ?? "";
  test.skip(
    !runtimeRepository ||
      !/^[0-9a-f]{40}$/u.test(runtimeSha) ||
      !runtimeVenv ||
      !runtimeNodeModules ||
      !/^[0-9a-f]{40}$/u.test(expectedDesktopSha),
    "Set exact merged Runtime/Desktop identities plus isolated Runtime dependency roots.",
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
  const previousProviderKey = process.env[PROVIDER_ENV_KEY];
  const evidence: Array<{
    completionSha256: string;
    completionUtf8Bytes: number;
    stateDbSha256: string;
    stateDbUtf8Bytes: number;
    turn: number;
    visibleSha256: string;
    visibleUtf8Bytes: number;
  }> = [];

  try {
    const provider = await startProvider();
    providerServer = provider.server;
    process.env[PROVIDER_ENV_KEY] = "isolated-loopback-e2e-only";

    harness = await createProductAuthHarness();
    await prepareExternalRuntime(
      harness,
      runtimeRepository,
      runtimeSha,
      runtimeVenv,
      runtimeNodeModules,
    );
    const emptySeed = join(harness.root, "unused-runtime-seed");
    await mkdir(emptySeed, { recursive: true });

    ({ app } = await launchRuntimeDesktop(harness, emptySeed));
    const page = await app.firstWindow();
    await authenticateNewProductAccount(harness, app, page, {
      displayName: "Stream Integrity Disposable User",
    });

    const profileClaim = page.locator('[data-testid="screen-profile-claim"]');
    const mainLayout = page.locator(".layout");
    await expect(profileClaim.or(mainLayout)).toBeVisible({ timeout: 180_000 });
    if (await profileClaim.isVisible()) {
      await page.locator(".agentera-profile-actions .btn-primary").click();
    }
    await expect(mainLayout).toBeVisible({ timeout: 180_000 });

    const activeProfile = await page.evaluate(async () => {
      const profiles = await window.hermesAPI.listProfiles();
      return profiles.find((profile) => profile.isActive) ?? null;
    });
    if (!activeProfile)
      throw new Error("Isolated active Runtime Profile is missing.");

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
    await expect(mainLayout).toBeVisible({ timeout: 180_000 });
    await installCompletionCapture(page);
    const startupModelPrompt = page.locator(".startup-model-prompt");
    if (await startupModelPrompt.isVisible()) {
      await startupModelPrompt
        .getByRole("button", { name: /^(Later|稍后)$/u })
        .click();
    }

    const chatInput = page.locator("textarea.chat-input:visible");
    const sendButton = page.locator("button.chat-send-btn:visible");
    await expect(chatInput).toBeVisible({ timeout: 180_000 });
    const stateDatabase = join(activeProfile.path, "state.db");

    for (let turn = 1; turn <= TURN_COUNT; turn += 1) {
      const expected = metrics(replyForTurn(turn));
      await chatInput.fill(
        `AERA_STREAM_INTEGRITY_CASE_${String(turn).padStart(2, "0")}`,
      );
      await expect(sendButton).toBeEnabled();
      await sendButton.click();

      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const captureWindow = window as typeof window & {
                __AERA_STREAM_COMPLETIONS__?: CompletionMetrics[];
              };
              return captureWindow.__AERA_STREAM_COMPLETIONS__?.length ?? 0;
            }),
          { timeout: 120_000 },
        )
        .toBe(turn);
      await expect
        .poll(() => visibleMetrics(page), { timeout: 120_000 })
        .toEqual(expected);
      await expect
        .poll(() => latestStateDbMetrics(stateDatabase), { timeout: 120_000 })
        .toEqual(expected);

      const visible = await visibleMetrics(page);
      const stateDb = latestStateDbMetrics(stateDatabase);
      expect(visible).not.toBeNull();
      expect(stateDb).not.toBeNull();

      const completion = await page.evaluate((index) => {
        const captureWindow = window as typeof window & {
          __AERA_STREAM_COMPLETIONS__?: CompletionMetrics[];
        };
        return captureWindow.__AERA_STREAM_COMPLETIONS__?.[index] ?? null;
      }, turn - 1);
      expect(completion).not.toBeNull();
      expect(completion?.payloadSha256).toBe(expected.sha256);
      expect(completion?.computedSha256).toBe(expected.sha256);
      expect(completion?.utf8Bytes).toBe(expected.utf8Bytes);
      expect(completion?.streamId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(completion?.finalSeq).toBeGreaterThan(0);

      evidence.push({
        turn,
        visibleSha256: visible?.sha256 ?? "",
        visibleUtf8Bytes: visible?.utf8Bytes ?? -1,
        completionSha256: completion?.computedSha256 ?? "",
        completionUtf8Bytes: completion?.utf8Bytes ?? -1,
        stateDbSha256: stateDb?.sha256 ?? "",
        stateDbUtf8Bytes: stateDb?.utf8Bytes ?? -1,
      });
    }

    expect(provider.state.requestCount).toBe(TURN_COUNT);
    expect(provider.state.nonStreamingRequests).toBe(0);
    expect(runtimeProcessIds(harness.hermesHome).length).toBeGreaterThan(0);

    const isolatedHermesHome = harness.hermesHome;
    await app.close();
    app = null;
    await expect
      .poll(() => runtimeProcessIds(isolatedHermesHome), {
        timeout: 30_000,
      })
      .toEqual([]);

    await testInfo.attach("chat-stream-integrity-evidence.json", {
      body: Buffer.from(
        `${JSON.stringify(
          {
            desktopSha,
            runtimeSha,
            turnCount: TURN_COUNT,
            providerRequests: provider.state.requestCount,
            oneCharacterSseChunks: true,
            evidence,
          },
          null,
          2,
        )}\n`,
        "utf8",
      ),
      contentType: "application/json",
    });
  } finally {
    await app?.close().catch(() => undefined);
    if (harness) terminateOwnedRuntimeProcesses(harness.hermesHome);
    await closeServer(providerServer);
    await closeProductAuthHarness(harness);
    if (previousProviderKey === undefined) {
      delete process.env[PROVIDER_ENV_KEY];
    } else {
      process.env[PROVIDER_ENV_KEY] = previousProviderKey;
    }
  }
});
