import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeRequest = EventEmitter & {
  end: () => void;
  destroy: () => void;
};

const behavior = vi.hoisted(() => ({
  mode: "error" as "error" | "timeout" | "hold",
  errorCode: "ECONNREFUSED",
}));

function makeRequest(): FakeRequest {
  const request = new EventEmitter() as FakeRequest;
  request.end = () => {
    if (behavior.mode === "error") {
      queueMicrotask(() => {
        const error = Object.assign(new Error("synthetic transport failure"), {
          code: behavior.errorCode,
        });
        request.emit("error", error);
      });
    } else if (behavior.mode === "timeout") {
      queueMicrotask(() => request.emit("timeout"));
    }
  };
  request.destroy = () => {
    if (behavior.mode === "timeout") {
      queueMicrotask(() => {
        const error = Object.assign(new Error("socket reset after timeout"), {
          code: "ECONNRESET",
        });
        request.emit("error", error);
      });
    }
  };
  return request;
}

const request = vi.hoisted(() => vi.fn(() => makeRequest()));

vi.mock("http", () => ({
  default: { request },
  request,
}));
vi.mock("https", () => ({
  default: { request },
  request,
}));

async function loadDiscovery(): Promise<
  typeof import("../src/main/model-discovery")
> {
  vi.resetModules();
  const mod = await import("../src/main/model-discovery");
  mod._clearCache();
  return mod;
}

describe("model discovery transport classification", () => {
  // @lat: [[beta27-reliability-plan#Provider model discovery protocol#Transport and cancellation ownership]]
  beforeEach(() => {
    behavior.mode = "error";
    behavior.errorCode = "ECONNREFUSED";
    request.mockClear();
  });

  it.each([
    ["ENOTFOUND", "dns_error"],
    ["EAI_AGAIN", "dns_error"],
    ["ETIMEDOUT", "timeout"],
    ["ECONNREFUSED", "connection_error"],
    ["ECONNRESET", "connection_error"],
    ["CERT_HAS_EXPIRED", "tls_error"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_error"],
    ["EPROTO", "tls_error"],
  ] as const)("maps Node error %s to %s", async (errorCode, expected) => {
    behavior.errorCode = errorCode;
    const { discoverProviderModels } = await loadDiscovery();
    const result = await discoverProviderModels(
      "custom",
      "https://provider.invalid/v1",
      "sk-test",
      undefined,
    );
    expect(result.status).toBe(expected);
    expect(result.models).toEqual([]);
    expect(result.cached).toBe(false);
    expect(result.statusCode).toBeUndefined();
  });

  it("settles timeout before the socket reset caused by destroying the request", async () => {
    behavior.mode = "timeout";
    const { discoverProviderModels } = await loadDiscovery();
    const result = await discoverProviderModels(
      "custom",
      "http://provider.invalid/v1",
      "sk-test",
      undefined,
      { timeoutMs: 25 },
    );
    expect(result.status).toBe("timeout");
  });

  it("honors an already-aborted signal without opening a request", async () => {
    behavior.mode = "hold";
    const controller = new AbortController();
    controller.abort();
    const { discoverProviderModels } = await loadDiscovery();
    const result = await discoverProviderModels(
      "custom",
      "http://provider.invalid/v1",
      "sk-test",
      undefined,
      { signal: controller.signal },
    );
    expect(result.status).toBe("cancelled");
    expect(request).not.toHaveBeenCalled();
  });

  it("classifies an in-flight abort as cancelled", async () => {
    behavior.mode = "hold";
    const controller = new AbortController();
    const { discoverProviderModels } = await loadDiscovery();
    const pending = discoverProviderModels(
      "custom",
      "http://provider.invalid/v1",
      "sk-test",
      undefined,
      { signal: controller.signal, timeoutMs: 1000 },
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      models: [],
      cached: false,
    });
  });
});
