import { EventEmitter } from "events";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";

const gatewayRecoveryTestTimeoutMs =
  process.platform === "win32" ? 20_000 : 5_000;

const {
  spawned,
  TEST_HOME,
  TEST_REPO,
  healthStatuses,
  healthSteadyStatusRef,
  apiRequests,
  apiRequestErrors,
  requestEvents,
  modelConfig,
  profileEnv,
  modelRows,
  ownershipMarkSpawnFailureRef,
  deferGatewayCloseRef,
  publishGatewayPidOnSpawnRef,
  nextListenerPidRef,
  liveListenerPids,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  return {
    spawned: [] as Array<
      EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        killed: boolean;
        kill: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
        spawnArgs?: string[];
        spawnOptions?: { env?: Record<string, string> };
      }
    >,
    TEST_HOME: path.join(os.tmpdir(), `hermes-cli-session-test-${Date.now()}`),
    TEST_REPO: path.join(os.tmpdir(), `hermes-cli-session-repo-${Date.now()}`),
    healthStatuses: [] as number[],
    healthSteadyStatusRef: { value: 503 },
    apiRequests: [] as Array<{
      body: string;
      headers: Record<string, string>;
    }>,
    apiRequestErrors: [] as string[],
    requestEvents: [] as string[],
    modelConfig: {
      model: "test-model",
      provider: "openrouter",
      baseUrl: "",
    },
    profileEnv: {} as Record<string, string>,
    modelRows: [] as Array<{
      id: string;
      name: string;
      provider: string;
      model: string;
      baseUrl: string;
      providerLabel?: string;
      createdAt: number;
    }>,
    ownershipMarkSpawnFailureRef: { fail: false },
    deferGatewayCloseRef: { value: false },
    publishGatewayPidOnSpawnRef: { value: false },
    nextListenerPidRef: { value: 20_000 },
    liveListenerPids: new Set<number>(),
  };
});

vi.mock("http", () => ({
  default: {
    request: (
      _url: string,
      _options: Record<string, unknown>,
      cb?: (res: {
        statusCode: number;
        headers?: Record<string, string>;
        resume?: () => void;
        on?: (event: string, handler: (...args: unknown[]) => void) => void;
      }) => void,
    ) => {
      let body = "";
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const req = {
        write: (chunk: string | Buffer) => {
          body += chunk.toString();
        },
        end: () => {
          if (_url.endsWith("/health") || _url.endsWith("/v1/capabilities")) {
            const isReadinessProbe =
              _url.endsWith("/health") || _options.timeout === 1500;
            if (isReadinessProbe) requestEvents.push("health");
            const statusCode = isReadinessProbe
              ? (healthStatuses.shift() ?? healthSteadyStatusRef.value)
              : 200;
            const res = Object.assign(new EventEmitter(), {
              statusCode,
              headers: {},
              resume: () => {},
            });
            cb?.(res);
            queueMicrotask(() => {
              res.emit("data", Buffer.from("{}"));
              res.emit("end");
            });
            return;
          }

          if (_url.endsWith("/v1/chat/completions")) {
            requestEvents.push("chat");
            const requestError = apiRequestErrors.shift();
            if (requestError === "HANG") {
              return;
            }
            if (requestError === "HANG_ACCEPTED") {
              apiRequests.push({
                body,
                headers: (_options.headers as Record<string, string>) || {},
              });
              return;
            }
            if (requestError === "TIMEOUT_ACCEPTED") {
              apiRequests.push({
                body,
                headers: (_options.headers as Record<string, string>) || {},
              });
              queueMicrotask(() => {
                handlers.get("timeout")?.();
              });
              return;
            }
            if (requestError?.startsWith("STATUS:")) {
              const [, status = "500", message = "API error"] =
                requestError.split(":");
              apiRequests.push({
                body,
                headers: (_options.headers as Record<string, string>) || {},
              });
              const res = new EventEmitter() as EventEmitter & {
                statusCode: number;
                headers: Record<string, string>;
              };
              res.statusCode = Number(status);
              res.headers = {};
              cb?.(res);
              queueMicrotask(() => {
                res.emit(
                  "data",
                  Buffer.from(JSON.stringify({ error: { message } })),
                );
                res.emit("end");
              });
              return;
            }
            if (requestError?.startsWith("STREAM_ERROR:")) {
              const message = requestError.slice("STREAM_ERROR:".length);
              apiRequests.push({
                body,
                headers: (_options.headers as Record<string, string>) || {},
              });
              const res = new EventEmitter() as EventEmitter & {
                statusCode: number;
                headers: Record<string, string>;
              };
              res.statusCode = 200;
              res.headers = { "x-hermes-session-id": "desk-cold-gateway" };
              cb?.(res);
              queueMicrotask(() => {
                res.emit(
                  "data",
                  Buffer.from(
                    'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n',
                  ),
                );
                res.emit("error", new Error(message));
              });
              return;
            }
            if (requestError === "STREAM_AUTH_REJECTED") {
              apiRequests.push({
                body,
                headers: (_options.headers as Record<string, string>) || {},
              });
              const res = new EventEmitter() as EventEmitter & {
                statusCode: number;
                headers: Record<string, string>;
              };
              res.statusCode = 200;
              res.headers = { "x-hermes-session-id": "desk-cold-gateway" };
              cb?.(res);
              queueMicrotask(() => {
                res.emit(
                  "data",
                  Buffer.from(
                    `data: ${JSON.stringify({
                      choices: [
                        { index: 0, delta: {}, finish_reason: "error" },
                      ],
                      error: {
                        message:
                          "The model provider rejected the current credential.",
                        type: "agent_error",
                      },
                      hermes: {
                        completed: false,
                        partial: false,
                        failed: true,
                        error:
                          "The model provider rejected the current credential.",
                        error_code: "provider_authentication_rejected",
                      },
                    })}\n\n`,
                  ),
                );
                res.emit("data", Buffer.from("data: [DONE]\n\n"));
                res.emit("end");
              });
              return;
            }
            if (requestError) {
              queueMicrotask(() => {
                handlers.get("error")?.(new Error(requestError));
              });
              return;
            }

            apiRequests.push({
              body,
              headers: (_options.headers as Record<string, string>) || {},
            });
            const res = new EventEmitter() as EventEmitter & {
              statusCode: number;
              headers: Record<string, string>;
            };
            res.statusCode = 200;
            res.headers = { "x-hermes-session-id": "desk-cold-gateway" };
            cb?.(res);
            queueMicrotask(() => {
              res.emit(
                "data",
                Buffer.from(
                  'data: {"choices":[{"delta":{"content":"Hi from API"}}]}\n\n',
                ),
              );
              res.emit("data", Buffer.from("data: [DONE]\n\n"));
              res.emit("end");
            });
          }
        },
        on: (event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, handler);
          return req;
        },
        destroy: () => {
          handlers.get("error")?.(new Error("destroyed"));
        },
      };
      return req;
    },
  },
}));

vi.mock("https", () => ({
  default: {
    request: () => ({
      write: () => {},
      end: () => {},
      on: () => {},
      destroy: () => {},
    }),
  },
}));

vi.mock("child_process", () => ({
  default: {
    spawn: vi.fn((_cmd: string, args?: string[], options?: unknown) => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        pid: process.pid,
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: vi.fn(),
        unref: vi.fn(),
        spawnArgs: args,
        spawnOptions: options,
      });
      proc.kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
        proc.killed = true;
        if (!deferGatewayCloseRef.value) {
          proc.signalCode = signal;
          queueMicrotask(() => proc.emit("close", null, signal));
        }
        return true;
      });
      proc.stderr.pipe = vi.fn();
      spawned.push(proc);
      if (publishGatewayPidOnSpawnRef.value && args?.includes("gateway")) {
        const listenerPid = nextListenerPidRef.value++;
        liveListenerPids.add(listenerPid);
        writeFileSync(
          `${TEST_HOME}/gateway.pid`,
          JSON.stringify({ pid: listenerPid }),
        );
      }
      return proc;
    }),
  },
  spawn: vi.fn((_cmd: string, args?: string[], options?: unknown) => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: process.pid,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: vi.fn(),
      unref: vi.fn(),
      spawnArgs: args,
      spawnOptions: options,
    });
    proc.kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      proc.killed = true;
      if (!deferGatewayCloseRef.value) {
        proc.signalCode = signal;
        queueMicrotask(() => proc.emit("close", null, signal));
      }
      return true;
    });
    proc.stderr.pipe = vi.fn();
    spawned.push(proc);
    if (publishGatewayPidOnSpawnRef.value && args?.includes("gateway")) {
      const listenerPid = nextListenerPidRef.value++;
      liveListenerPids.add(listenerPid);
      writeFileSync(
        `${TEST_HOME}/gateway.pid`,
        JSON.stringify({ pid: listenerPid }),
      );
    }
    return proc;
  }),
}));

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: TEST_HOME,
  getEnhancedPath: () => process.env.PATH || "",
}));

vi.mock("../src/main/agentera-runtime-distribution/invocation", () => ({
  getRuntimeInvocation: () => ({
    source: "external",
    version: null,
    sourceCommit: null,
    root: TEST_REPO,
    python: process.execPath,
    workingDirectory: TEST_REPO,
    bundledSkillsDirectory: `${TEST_REPO}/skills`,
    webDistDirectory: `${TEST_REPO}/hermes_cli/web_dist`,
    cliArgs: (extra?: string[]) => ["/dev/null", ...(extra || [])],
    environment: (base: Record<string, string> = {}) => ({ ...base }),
  }),
}));

vi.mock("../src/main/config", () => ({
  ensureLocalApiServerKey: () => ({
    generated: false,
    key: "internal-test-token",
  }),
  getModelConfig: () => modelConfig,
  getConfigValue: () => "",
  readEnv: () => profileEnv,
  // Gateway launch now consumes a credential prepared by the managed
  // bootstrap transaction; this fixture represents that prepared state.
  getApiServerKey: () => "internal-test-token",
  getConnectionConfig: () => ({ mode: "local" as const }),
}));

vi.mock("../src/main/gateway-managed-config", () => ({
  prepareGatewayManagedConfiguration: async () => ({
    key: "internal-test-token",
    port: 8642,
  }),
}));

vi.mock("../src/main/ssh-tunnel", () => ({
  getSshTunnelUrl: () => null,
  isSshTunnelActive: () => false,
  isSshTunnelHealthy: () => Promise.resolve(false),
  startSshTunnel: () => Promise.resolve(),
}));

vi.mock("../src/main/utils", () => ({
  stripAnsi: (s: string) => s,
  pidIsAliveAs: (pid: number) =>
    liveListenerPids.has(pid) ||
    spawned.some(
      (proc) =>
        proc.pid === pid && proc.exitCode === null && proc.signalCode === null,
    ),
  getActiveProfileNameSync: () => "default",
  normalizeProfileName: (p?: string) =>
    p === undefined || p === "" || p === "default" ? undefined : p,
  profileHome: () => TEST_HOME,
  profilePaths: () => ({
    home: TEST_HOME,
    envFile: `${TEST_HOME}/.env`,
    configFile: `${TEST_HOME}/config.yaml`,
  }),
}));

vi.mock("../src/main/process-identity", () => ({
  normalizeProcessImage: (value: unknown) =>
    typeof value === "string" && value.trim()
      ? value.trim().replaceAll("\\", "/").split("/").at(-1)!.toLowerCase()
      : null,
  processImageMatchesExecutable: (observed: string, expected: string) =>
    observed.toLowerCase().replaceAll("\\", "/").split("/").at(-1) ===
    expected.toLowerCase().replaceAll("\\", "/").split("/").at(-1),
  processEvidenceMatches: (
    actual: { identity: string; image: string } | null,
    expected: { identity: string; image: string } | null,
  ) =>
    actual?.identity === expected?.identity &&
    actual?.image === expected?.image,
  readProcessIdentityEvidence: (pid: number) => ({
    identity: `test-created-${pid}`,
    image: process.execPath,
  }),
}));

vi.mock("../src/main/models", () => ({
  readModels: () => modelRows,
}));

vi.mock("../src/main/process-options", () => ({
  HIDDEN_SUBPROCESS_OPTIONS: {},
}));

vi.mock("../src/main/gateway-process-ownership", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/main/gateway-process-ownership")
    >();
  return {
    ...actual,
    GatewayProcessOwnershipLedger: class
      extends actual.GatewayProcessOwnershipLedger
    {
      override markSpawned(
        input: Parameters<
          InstanceType<
            typeof actual.GatewayProcessOwnershipLedger
          >["markSpawned"]
        >[0],
      ): ReturnType<
        InstanceType<typeof actual.GatewayProcessOwnershipLedger>["markSpawned"]
      > {
        if (ownershipMarkSpawnFailureRef.fail) {
          throw new actual.GatewayProcessOwnershipError(
            "ownership_persistence_failed",
          );
        }
        return super.markSpawned(input);
      }
    },
  };
});

import {
  configureGatewayManagedConfiguration,
  configureGatewayProcessOwnership,
  sendMessage,
  startGateway,
  stopGateway,
  stopHealthPolling,
} from "../src/main/hermes";

describe("CLI fallback session id propagation", () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_HOME, { recursive: true });
    configureGatewayProcessOwnership(TEST_HOME);
    configureGatewayManagedConfiguration({
      modelMutationPort: { mutate: vi.fn() },
    });
    healthStatuses.length = 0;
    healthSteadyStatusRef.value = 503;
    apiRequests.length = 0;
    apiRequestErrors.length = 0;
    requestEvents.length = 0;
    modelConfig.model = "test-model";
    modelConfig.provider = "openrouter";
    modelConfig.baseUrl = "";
    for (const key of Object.keys(profileEnv)) {
      delete profileEnv[key];
    }
    modelRows.length = 0;
    ownershipMarkSpawnFailureRef.fail = false;
    deferGatewayCloseRef.value = false;
    publishGatewayPidOnSpawnRef.value = false;
    nextListenerPidRef.value = 20_000;
    liveListenerPids.clear();
    rmSync(TEST_REPO, { recursive: true, force: true });
  });

  it("keeps a failed spawned-PID commit until the child exit is confirmed", async () => {
    mkdirSync(TEST_REPO, { recursive: true });
    ownershipMarkSpawnFailureRef.fail = true;
    deferGatewayCloseRef.value = true;

    expect(startGateway()).toBe(false);
    expect(spawned).toHaveLength(1);
    const proc = spawned[0];
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(
      JSON.parse(
        readFileSync(`${TEST_HOME}/gateway-process-ownership.json`, "utf8"),
      ).entries,
    ).toEqual([
      expect.objectContaining({ profileId: "default", spawnedPid: null }),
    ]);

    proc.signalCode = "SIGTERM";
    proc.emit("close", null, "SIGTERM");
    await vi.waitFor(() => {
      expect(
        JSON.parse(
          readFileSync(`${TEST_HOME}/gateway-process-ownership.json`, "utf8"),
        ).entries,
      ).toEqual([]);
    });
  });

  afterEach(() => {
    configureGatewayManagedConfiguration(null);
    stopGateway(undefined, true);
    stopHealthPolling();
    spawned.length = 0;
  });

  it("captures the quiet CLI session id from stderr so the next desktop turn can resume it", async () => {
    modelConfig.provider = "aimlapi";
    const done = new Promise<string | undefined>((resolve) => {
      sendMessage("hi", {
        onChunk: () => {},
        onDone: resolve,
        onError: () => {},
      }).then(() => {
        const proc = spawned[0];
        proc.stdout.emit("data", Buffer.from("Hi there"));
        proc.stderr.emit(
          "data",
          Buffer.from("\nsession_id: 20260527_143413_10df4c\n"),
        );
        proc.emit("close", 0);
      });
    });

    await expect(done).resolves.toBe("20260527_143413_10df4c");
  });

  it("runs AIML API through the CLI custom provider bridge", async () => {
    modelConfig.model = "gpt-4o-mini";
    modelConfig.provider = "aimlapi";
    modelConfig.baseUrl = "https://api.aimlapi.com/v1";
    profileEnv.AIMLAPI_API_KEY = "sk-aiml-test";

    const done = new Promise<string | undefined>((resolve) => {
      sendMessage("hi", {
        onChunk: () => {},
        onDone: resolve,
        onError: () => {},
      }).then(() => {
        const proc = spawned[0];
        proc.stdout.emit("data", Buffer.from("Hi there"));
        proc.emit("close", 0);
      });
    });

    await expect(done).resolves.toBeUndefined();

    const proc = spawned[0];
    expect(proc.spawnArgs).toEqual(
      expect.arrayContaining(["-m", "gpt-4o-mini", "--provider", "custom"]),
    );
    expect(proc.spawnOptions?.env).toMatchObject({
      AIMLAPI_API_KEY: "sk-aiml-test",
      OPENAI_API_KEY: "sk-aiml-test",
      OPENAI_BASE_URL: "https://api.aimlapi.com/v1",
      CUSTOM_BASE_URL: "https://api.aimlapi.com/v1",
      HERMES_INFERENCE_PROVIDER: "custom",
    });
  });

  it("bridges a named custom-provider key into the Runtime host slot on CLI fallback", async () => {
    profileEnv.CUSTOM_PROVIDER_ANHEPRO_COM_KEY = "named-provider-secret";
    modelRows.push({
      id: "anhepro-gpt-5.6-sol",
      name: "gpt-5.6-sol",
      provider: "custom",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.anhepro.com/v1",
      providerLabel: "anhepro.com",
      createdAt: 1,
    });

    const done = new Promise<string | undefined>((resolve) => {
      sendMessage(
        "hi",
        {
          onChunk: () => {},
          onDone: resolve,
          onError: () => {},
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          provider: "custom",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.anhepro.com/v1",
        },
      ).then(() => {
        const proc = spawned[0];
        proc.stdout.emit("data", Buffer.from("Hi there"));
        proc.emit("close", 0);
      });
    });

    await expect(done).resolves.toBeUndefined();
    expect(spawned[0].spawnOptions?.env?.ANHEPRO_API_KEY).toBe(
      "named-provider-secret",
    );
  });

  it("continues a CLI-created timestamp session over the API instead of minting a desk id", async () => {
    const cliSessionId = "20260527_143413_10df4c";
    modelConfig.provider = "aimlapi";
    const firstDone = new Promise<string | undefined>((resolve) => {
      sendMessage("hi", {
        onChunk: () => {},
        onDone: resolve,
        onError: () => {},
      }).then(() => {
        const proc = spawned[0];
        proc.stdout.emit("data", Buffer.from("Hi there"));
        proc.stderr.emit(
          "data",
          Buffer.from(`\nsession_id: ${cliSessionId}\n`),
        );
        proc.emit("close", 0);
      });
    });

    await expect(firstDone).resolves.toBe(cliSessionId);

    modelConfig.provider = "openrouter";
    healthStatuses.push(200);
    await expect(
      new Promise<string | undefined>((resolve, reject) => {
        sendMessage(
          "what time is it?",
          {
            onChunk: () => {},
            onDone: resolve,
            onError: reject,
          },
          undefined,
          cliSessionId,
        ).catch(reject);
      }),
    ).resolves.toBe("desk-cold-gateway");

    expect(apiRequests).toHaveLength(1);
    expect(apiRequests[0].headers["X-Hermes-Session-Id"]).toBe(cliSessionId);
    expect(JSON.parse(apiRequests[0].body)).toMatchObject({
      session_id: cliSessionId,
      messages: [{ role: "user", content: "what time is it?" }],
      stream: true,
    });
  });

  it("uses a healthy running gateway API instead of falling back to CLI", async () => {
    mkdirSync(TEST_REPO, { recursive: true });
    healthStatuses.push(200);

    expect(startGateway()).toBe(true);
    expect(spawned).toHaveLength(1);

    const chunks: string[] = [];
    const done = new Promise<string | undefined>((resolve, reject) => {
      sendMessage("hi", {
        onChunk: (chunk) => chunks.push(chunk),
        onDone: resolve,
        onError: reject,
      }).catch(reject);
    });

    await expect(done).resolves.toBe("desk-cold-gateway");
    expect(chunks.join("")).toBe("Hi from API");
    expect(spawned).toHaveLength(1);
    expect(apiRequests).toHaveLength(1);
    expect(JSON.parse(apiRequests[0].body)).toMatchObject({
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
  });

  it("recovers a stopped local gateway before sending via the API", async () => {
    mkdirSync(TEST_REPO, { recursive: true });
    healthStatuses.push(503, 503, 200);
    publishGatewayPidOnSpawnRef.value = true;

    const chunks: string[] = [];
    const done = new Promise<string | undefined>((resolve, reject) => {
      sendMessage("hi after update", {
        onChunk: (chunk) => chunks.push(chunk),
        onDone: resolve,
        onError: reject,
      }).catch(reject);
    });

    await expect(done).resolves.toBe("desk-cold-gateway");
    expect(chunks.join("")).toBe("Hi from API");
    expect(spawned).toHaveLength(1);
    expect(apiRequests).toHaveLength(1);
    expect(JSON.parse(apiRequests[0].body)).toMatchObject({
      messages: [{ role: "user", content: "hi after update" }],
      stream: true,
    });
  });

  it("restarts a tracked but unhealthy local gateway before sending via the API", async () => {
    mkdirSync(TEST_REPO, { recursive: true });
    expect(startGateway()).toBe(true);
    expect(spawned).toHaveLength(1);
    publishGatewayPidOnSpawnRef.value = true;
    healthStatuses.push(503, 503, 503, 200);

    const chunks: string[] = [];
    const done = new Promise<string | undefined>((resolve, reject) => {
      sendMessage("hi after stale gateway", {
        onChunk: (chunk) => chunks.push(chunk),
        onDone: resolve,
        onError: reject,
      }).catch(reject);
    });

    await expect(done).resolves.toBe("desk-cold-gateway");
    expect(chunks.join("")).toBe("Hi from API");
    expect(spawned).toHaveLength(2);
    expect(apiRequests).toHaveLength(1);
    expect(JSON.parse(apiRequests[0].body)).toMatchObject({
      messages: [{ role: "user", content: "hi after stale gateway" }],
      stream: true,
    });
  });

  it("recovers after a stale ready cache without slowing the normal API send path", async () => {
    mkdirSync(TEST_REPO, { recursive: true });
    healthStatuses.push(200);

    await expect(
      new Promise<string | undefined>((resolve, reject) => {
        sendMessage("warmup", {
          onChunk: () => {},
          onDone: resolve,
          onError: reject,
        }).catch(reject);
      }),
    ).resolves.toBe("desk-cold-gateway");
    expect(apiRequests).toHaveLength(1);
    expect(requestEvents).toEqual(["health", "chat"]);

    apiRequestErrors.push("connect ECONNREFUSED 127.0.0.1:8765");
    healthStatuses.push(503, 200);
    publishGatewayPidOnSpawnRef.value = true;
    const secondSendStart = requestEvents.length;

    const chunks: string[] = [];
    await expect(
      new Promise<string | undefined>((resolve, reject) => {
        sendMessage("hi after restart", {
          onChunk: (chunk) => chunks.push(chunk),
          onDone: resolve,
          onError: reject,
        }).catch(reject);
      }),
    ).resolves.toBe("desk-cold-gateway");

    expect(chunks.join("")).toBe("Hi from API");
    expect(spawned).toHaveLength(1);
    expect(apiRequests).toHaveLength(2);
    expect(requestEvents[secondSendStart]).toBe("chat");
    expect(requestEvents.at(-1)).toBe("chat");
    expect(JSON.parse(apiRequests[1].body)).toMatchObject({
      messages: [{ role: "user", content: "hi after restart" }],
      stream: true,
    });
  });

  it("retries a reset local API socket once after gateway recovery", async () => {
    mkdirSync(TEST_REPO, { recursive: true });
    healthStatuses.push(200);

    await expect(
      new Promise<string | undefined>((resolve, reject) => {
        sendMessage("warmup", {
          onChunk: () => {},
          onDone: resolve,
          onError: reject,
        }).catch(reject);
      }),
    ).resolves.toBe("desk-cold-gateway");

    apiRequestErrors.push("read ECONNRESET");
    healthStatuses.push(503, 200);
    publishGatewayPidOnSpawnRef.value = true;

    const chunks: string[] = [];
    await expect(
      new Promise<string | undefined>((resolve, reject) => {
        sendMessage("hi after reset", {
          onChunk: (chunk) => chunks.push(chunk),
          onDone: resolve,
          onError: reject,
        }).catch(reject);
      }),
    ).resolves.toBe("desk-cold-gateway");

    expect(chunks.join("")).toBe("Hi from API");
    expect(apiRequests).toHaveLength(2);
    expect(JSON.parse(apiRequests[1].body)).toMatchObject({
      messages: [{ role: "user", content: "hi after reset" }],
      stream: true,
    });
  });

  it("preserves API response errors when recovery succeeds", async () => {
    mkdirSync(TEST_REPO, { recursive: true });
    healthStatuses.push(200);

    await expect(
      new Promise<string | undefined>((resolve, reject) => {
        sendMessage("warmup", {
          onChunk: () => {},
          onDone: resolve,
          onError: reject,
        }).catch(reject);
      }),
    ).resolves.toBe("desk-cold-gateway");

    apiRequestErrors.push("STATUS:401:Authentication failed");
    healthStatuses.push(503, 200);
    publishGatewayPidOnSpawnRef.value = true;
    const startedSessions: string[] = [];

    await expect(
      new Promise<string | undefined>((resolve, reject) => {
        sendMessage("bad key", {
          onChunk: () => {},
          onDone: resolve,
          onSessionStarted: (sessionId) => startedSessions.push(sessionId),
          onError: reject,
        }).catch(reject);
      }),
    ).rejects.toThrow("Authentication failed");

    expect(startedSessions).toEqual([]);
    expect(apiRequests).toHaveLength(2);
    expect(JSON.parse(apiRequests[1].body)).toMatchObject({
      messages: [{ role: "user", content: "bad key" }],
      stream: true,
    });
  });

  it("keeps the live Gateway untouched when an SSE auth failure carries its stable Hermes code", async () => {
    mkdirSync(TEST_REPO, { recursive: true });
    expect(startGateway()).toBe(true);
    healthStatuses.push(200);

    await expect(
      new Promise<string | undefined>((resolve, reject) => {
        sendMessage("warmup", {
          onChunk: () => {},
          onDone: resolve,
          onError: reject,
        }).catch(reject);
      }),
    ).resolves.toBe("desk-cold-gateway");

    apiRequestErrors.push("STREAM_AUTH_REJECTED");
    healthStatuses.push(503, 503, 503, 200);
    const secondSendStart = requestEvents.length;

    await expect(
      new Promise<string | undefined>((resolve, reject) => {
        sendMessage("bad provider credential", {
          onChunk: () => {},
          onDone: resolve,
          onError: reject,
        }).catch(reject);
      }),
    ).rejects.toThrow("provider_authentication_rejected");

    expect(requestEvents.slice(secondSendStart)).toEqual(["chat"]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].kill).not.toHaveBeenCalled();
    expect(healthStatuses).toEqual([503, 503, 503, 200]);
  });

  it("reports a mid-stream API disconnect without replaying partial output", async () => {
    mkdirSync(TEST_REPO, { recursive: true });
    healthStatuses.push(200);

    await expect(
      new Promise<string | undefined>((resolve, reject) => {
        sendMessage("warmup", {
          onChunk: () => {},
          onDone: resolve,
          onError: reject,
        }).catch(reject);
      }),
    ).resolves.toBe("desk-cold-gateway");

    apiRequestErrors.push("STREAM_ERROR:read ECONNRESET");
    healthStatuses.push(503, 200);
    publishGatewayPidOnSpawnRef.value = true;
    const secondSendStart = requestEvents.length;

    const chunks: string[] = [];
    await expect(
      new Promise<string | undefined>((resolve, reject) => {
        sendMessage("partial stream", {
          onChunk: (chunk) => chunks.push(chunk),
          onDone: resolve,
          onError: reject,
        }).catch(reject);
      }),
    ).rejects.toThrow("Stream error: read ECONNRESET");

    expect(chunks.join("")).toBe("Partial");
    expect(apiRequests).toHaveLength(2);
    expect(requestEvents[secondSendStart]).toBe("chat");
    await vi.waitFor(() => {
      expect(spawned).toHaveLength(1);
      expect(healthStatuses).toHaveLength(0);
      expect(requestEvents.slice(secondSendStart + 1)).toContain("health");
    });
    expect(JSON.parse(apiRequests[1].body)).toMatchObject({
      messages: [{ role: "user", content: "partial stream" }],
      stream: true,
    });
  });

  it(
    "recovers an accepted timed-out request without replaying the user message",
    async () => {
      mkdirSync(TEST_REPO, { recursive: true });
      healthStatuses.push(200);

      await expect(
        new Promise<string | undefined>((resolve, reject) => {
          sendMessage("warmup", {
            onChunk: () => {},
            onDone: resolve,
            onError: reject,
          }).catch(reject);
        }),
      ).resolves.toBe("desk-cold-gateway");
      expect(requestEvents).toEqual(["health", "chat"]);

      apiRequestErrors.push("TIMEOUT_ACCEPTED");
      healthStatuses.push(503, 503);
      healthSteadyStatusRef.value = 200;
      publishGatewayPidOnSpawnRef.value = true;
      const secondSendStart = requestEvents.length;

      const chunks: string[] = [];
      await expect(
        new Promise<string | undefined>((resolve, reject) => {
          sendMessage("hi after hung gateway", {
            onChunk: (chunk) => chunks.push(chunk),
            onDone: resolve,
            onError: reject,
          }).catch(reject);
        }),
      ).rejects.toThrow(
        "API request timed out. Check the SSH tunnel and remote Aera Runtime gateway.",
      );

      expect(chunks).toEqual([]);
      expect(spawned).toHaveLength(1);
      expect(apiRequests).toHaveLength(2);
      expect(requestEvents[secondSendStart]).toBe("chat");
      expect(requestEvents.slice(secondSendStart + 1)).toContain("health");
      expect(JSON.parse(apiRequests[1].body)).toMatchObject({
        messages: [{ role: "user", content: "hi after hung gateway" }],
        stream: true,
      });
    },
    gatewayRecoveryTestTimeoutMs,
  );
});
