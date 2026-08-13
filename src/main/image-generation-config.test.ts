// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TEST_HOME, WRITE_FAILURES } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  return {
    TEST_HOME: path.join(os.tmpdir(), `aera-image-config-${process.pid}`),
    WRITE_FAILURES: { config: false },
  };
});

vi.mock("./installer", () => ({
  HERMES_HOME: TEST_HOME,
  HERMES_PYTHON: "/usr/bin/python3",
  HERMES_REPO: "/dev/null",
  hermesCliArgs: (args: string[] = []) => ["/dev/null", ...args],
  getEnhancedPath: () => process.env.PATH || "",
}));

vi.mock("./utils", async () => {
  const actual = await vi.importActual<typeof import("./utils")>("./utils");
  return {
    ...actual,
    safeWriteFile: (...args: Parameters<typeof actual.safeWriteFile>) => {
      if (WRITE_FAILURES.config && args[0].endsWith("config.yaml")) {
        throw new Error("fixture config write failure");
      }
      return actual.safeWriteFile(...args);
    },
  };
});

import { createImageGenerationConfigService } from "./image-generation-config";
import { invalidateSecretsCache } from "./config";

const PROFILE = "work";
const PROFILE_HOME = join(TEST_HOME, "profiles", PROFILE);
const CONFIG_FILE = join(PROFILE_HOME, "config.yaml");
const ENV_FILE = join(PROFILE_HOME, ".env");
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

const draft = {
  enabled: true,
  baseUrl: "https://relay.example/v1/",
  apiKey: "fixture-secret",
  model: "gpt-image-1.5",
  quality: "medium" as const,
  aspectRatio: "square" as const,
};

beforeEach(() => {
  WRITE_FAILURES.config = false;
  invalidateSecretsCache();
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(PROFILE_HOME, { recursive: true });
  writeFileSync(CONFIG_FILE, "model:\n  default: chat-model\n", "utf-8");
});

afterEach(() => {
  invalidateSecretsCache();
  rmSync(TEST_HOME, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("ImageGenerationConfigService", () => {
  it("defaults image generation on without exposing a credential", () => {
    const service = createImageGenerationConfigService();

    const status = service.get(PROFILE);

    expect(status).toMatchObject({
      enabled: true,
      provider: "openai",
      hasApiKey: false,
      status: "credential_required",
    });
    expect(JSON.stringify(status)).not.toContain("apiKey");
  });

  it("saves a secret-free Profile status without making a network request", () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = createImageGenerationConfigService({ fetch: fetcher });

    const result = service.save(PROFILE, draft);

    expect(result).toMatchObject({
      success: true,
      config: {
        enabled: true,
        baseUrl: "https://relay.example/v1",
        model: "gpt-image-1.5",
        quality: "medium",
        aspectRatio: "square",
        hasApiKey: true,
        status: "configured",
      },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(readFileSync(ENV_FILE, "utf-8")).toContain(
      "IMAGE_GEN_OPENAI_API_KEY=fixture-secret",
    );
    expect(readFileSync(CONFIG_FILE, "utf-8")).toContain("chat-model");
    expect(fetcher).not.toHaveBeenCalled();
  });

  // @lat: [[image-generation#Secret-free configuration]]
  it("preserves the existing image credential when its replacement is blank", () => {
    const service = createImageGenerationConfigService();
    expect(service.save(PROFILE, draft).success).toBe(true);

    const result = service.save(PROFILE, {
      ...draft,
      apiKey: "   ",
      model: "gpt-image-2",
    });

    expect(result.success).toBe(true);
    expect(readFileSync(ENV_FILE, "utf-8")).toContain(
      "IMAGE_GEN_OPENAI_API_KEY=fixture-secret",
    );
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  it("does not send or preserve a saved credential for a different relay", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = createImageGenerationConfigService({ fetch: fetcher });
    expect(service.save(PROFILE, draft).success).toBe(true);
    const beforeConfig = readFileSync(CONFIG_FILE, "utf-8");
    const beforeEnv = readFileSync(ENV_FILE, "utf-8");
    const changedRelay = {
      ...draft,
      baseUrl: "https://other-relay.example/v1",
      apiKey: "",
    };

    const discovery = await service.discover(PROFILE, changedRelay);
    const saved = service.save(PROFILE, changedRelay);

    expect(discovery).toEqual({
      success: false,
      errorCode: "credential_required",
    });
    expect(saved).toEqual({
      success: false,
      errorCode: "credential_required",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(readFileSync(CONFIG_FILE, "utf-8")).toBe(beforeConfig);
    expect(readFileSync(ENV_FILE, "utf-8")).toBe(beforeEnv);
  });

  it("does not expose a credential-bearing relay URL from hand-edited config", () => {
    writeFileSync(
      CONFIG_FILE,
      "image_gen:\n  openai:\n    base_url: https://user:secret@relay.example/v1\n",
      "utf-8",
    );
    const service = createImageGenerationConfigService();

    const status = service.get(PROFILE);

    expect(status.baseUrl).toBe("https://api.openai.com/v1");
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("does not write a typed credential into .env for a command-backed Profile", () => {
    writeFileSync(
      CONFIG_FILE,
      [
        "model:",
        "  default: chat-model",
        "secrets:",
        "  provider: command",
        "  command: printf fixture-vault-secret",
        "",
      ].join("\n"),
      "utf-8",
    );
    const beforeConfig = readFileSync(CONFIG_FILE, "utf-8");
    const service = createImageGenerationConfigService();

    const result = service.save(PROFILE, draft);

    expect(result).toEqual({
      success: false,
      errorCode: "secret_provider_read_only",
    });
    expect(readFileSync(CONFIG_FILE, "utf-8")).toBe(beforeConfig);
    expect(existsSync(ENV_FILE)).toBe(false);
  });

  it("classifies invalid save input without changing the Profile", () => {
    const beforeConfig = readFileSync(CONFIG_FILE, "utf-8");
    const service = createImageGenerationConfigService();

    const result = service.save(PROFILE, {
      ...draft,
      baseUrl: "relay.example/v1",
    });

    expect(result).toEqual({
      success: false,
      errorCode: "invalid_configuration",
    });
    expect(readFileSync(CONFIG_FILE, "utf-8")).toBe(beforeConfig);
    expect(existsSync(ENV_FILE)).toBe(false);
  });

  it("preserves the prior complete configuration when YAML persistence fails", () => {
    const service = createImageGenerationConfigService();
    expect(service.save(PROFILE, draft).success).toBe(true);
    const beforeConfig = readFileSync(CONFIG_FILE, "utf-8");
    const beforeEnv = readFileSync(ENV_FILE, "utf-8");
    WRITE_FAILURES.config = true;

    const result = service.save(PROFILE, {
      ...draft,
      apiKey: "replacement-secret",
      model: "gpt-image-2",
    });

    expect(result).toEqual({ success: false, errorCode: "write_failed" });
    expect(readFileSync(CONFIG_FILE, "utf-8")).toBe(beforeConfig);
    expect(readFileSync(ENV_FILE, "utf-8")).toBe(beforeEnv);
  });

  it("discovers image-capable models once without mutating the Profile", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: [
          { id: "chat-model" },
          { id: "gpt-image-1.5" },
          { id: "flux-pro" },
        ],
      }),
    );
    const beforeConfig = readFileSync(CONFIG_FILE, "utf-8");
    const service = createImageGenerationConfigService({ fetch: fetcher });

    const result = await service.discover(PROFILE, draft);

    expect(result).toEqual({
      success: true,
      models: ["flux-pro", "gpt-image-1.5"],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://relay.example/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
    expect(readFileSync(CONFIG_FILE, "utf-8")).toBe(beforeConfig);
    expect(existsSync(ENV_FILE)).toBe(false);
  });

  it("test generation sends one paid request and returns a preview", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ b64_json: PNG_B64 }] }),
    );
    const service = createImageGenerationConfigService({ fetch: fetcher });

    const result = await service.testGeneration(PROFILE, draft);

    expect(result).toEqual({
      success: true,
      imageUrl: `data:image/png;base64,${PNG_B64}`,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://relay.example/v1/images/generations");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-image-1.5",
      quality: "medium",
      size: "1024x1024",
      n: 1,
    });
  });

  it("accepts a relay that returns only one bounded HTTPS image URL", async () => {
    const imageUrl = "https://cdn.example/generated/test.png?signature=fixture";
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ url: imageUrl }] }),
    );
    const service = createImageGenerationConfigService({ fetch: fetcher });

    const result = await service.testGeneration(PROFILE, draft);

    expect(result).toEqual({ success: true, imageUrl });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://cdn.example/generated.png",
    "https://user:password@cdn.example/generated.png",
    "javascript:alert(1)",
  ])("rejects an unsafe relay image URL: %s", async (imageUrl) => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ url: imageUrl }] }),
    );
    const service = createImageGenerationConfigService({ fetch: fetcher });

    const result = await service.testGeneration(PROFILE, draft);

    expect(result).toEqual({
      success: false,
      errorCode: "invalid_response",
    });
  });

  it.each([
    [{ ...draft, baseUrl: "relay.example/v1" }, "invalid_configuration"],
    [
      { ...draft, baseUrl: "https://user:pass@relay.example/v1" },
      "invalid_configuration",
    ],
    [{ ...draft, model: "bad\nmodel" }, "invalid_configuration"],
    [{ ...draft, apiKey: "" }, "credential_required"],
  ] as const)(
    "rejects an invalid request with %s",
    async (request, errorCode) => {
      const fetcher = vi.fn<typeof fetch>();
      const service = createImageGenerationConfigService({ fetch: fetcher });

      const result = await service.discover(PROFILE, request);

      expect(result).toEqual({ success: false, errorCode });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("maps timeout, network, upstream, and malformed responses to stable codes", async () => {
    const timeout = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("fixture prompt and secret", "AbortError")),
          );
        }),
    );
    const network = vi.fn<typeof fetch>(async () => {
      throw new Error("Authorization fixture-secret and raw body");
    });
    const rejected = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "Authorization fixture-secret" }, { status: 401 }),
    );
    const malformed = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ b64_json: "not base64!" }] }),
    );

    const timeoutResult = await createImageGenerationConfigService({
      fetch: timeout,
      timeoutMs: 1,
    }).testGeneration(PROFILE, draft);
    const networkResult = await createImageGenerationConfigService({
      fetch: network,
    }).testGeneration(PROFILE, draft);
    const rejectedResult = await createImageGenerationConfigService({
      fetch: rejected,
    }).testGeneration(PROFILE, draft);
    const malformedResult = await createImageGenerationConfigService({
      fetch: malformed,
    }).testGeneration(PROFILE, draft);

    expect(timeoutResult).toEqual({
      success: false,
      errorCode: "request_timeout",
    });
    expect(networkResult).toEqual({
      success: false,
      errorCode: "network_unavailable",
    });
    expect(rejectedResult).toEqual({
      success: false,
      errorCode: "upstream_rejected",
    });
    expect(malformedResult).toEqual({
      success: false,
      errorCode: "invalid_response",
    });
    const publicResults = JSON.stringify([
      timeoutResult,
      networkResult,
      rejectedResult,
      malformedResult,
    ]);
    expect(publicResults).not.toContain("fixture-secret");
    expect(publicResults).not.toContain("Authorization");
    expect(publicResults).not.toContain("raw body");
  });
});
