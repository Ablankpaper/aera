// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgenteraAuthController,
  type AgenteraAuthControllerRuntime,
} from "../src/main/agentera-auth/controller";
import type {
  AgenteraAuthorizationRequest,
  AgenteraCloudClientPort,
  AgenteraTokenSet,
} from "../src/main/agentera-auth/client";
import type {
  AgenteraLoopbackListener,
  AgenteraLoopbackOptions,
} from "../src/main/agentera-auth/loopback";
import type { AgenteraPkceAttempt } from "../src/main/agentera-auth/pkce";
import {
  AgenteraAuthStore,
  type SecureStorageAdapter,
} from "../src/main/agentera-auth/store";

class FakeSecureStorage implements SecureStorageAdapter {
  isEncryptionAvailable(): boolean {
    return true;
  }
  encryptString(value: string): Buffer {
    return Buffer.from(`protected:${value}`, "utf8");
  }
  decryptString(value: Buffer): string {
    return value.toString("utf8").replace(/^protected:/, "");
  }
}

const tokenSet: AgenteraTokenSet = {
  accessToken: "memory-only-access-token",
  accessExpiresAt: "2026-07-18T01:15:00.000Z",
  refreshToken: Buffer.alloc(32, 21).toString("base64url"),
  refreshExpiresAt: "2026-08-17T01:00:00.000Z",
  offlineEntitlement: "encrypted-at-rest-entitlement",
  offlineExpiresAt: "2026-07-25T01:00:00.000Z",
  userId: "11111111-1111-4111-8111-111111111111",
  personalSpaceId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
  trustedServerTime: "2026-07-18T01:00:00.000Z",
};

class FakeCloudClient implements AgenteraCloudClientPort {
  readonly origin = "https://accounts.agentera.example";
  readonly authorizationRequests: AgenteraAuthorizationRequest[] = [];
  readonly exchanged: string[] = [];
  readonly refreshed: string[] = [];
  readonly revoked: string[] = [];

  createAuthorizationUrl(request: AgenteraAuthorizationRequest): URL {
    this.authorizationRequests.push(request);
    const url = new URL("/oauth/authorize", this.origin);
    url.searchParams.set("state", request.pkce.state);
    if (request.forceAccountSelection) {
      url.searchParams.set("prompt", "select_account");
    }
    return url;
  }

  async exchangeAuthorizationCode(input: {
    authorizationCode: string;
    codeVerifier: string;
  }): Promise<AgenteraTokenSet> {
    this.exchanged.push(`${input.authorizationCode}:${input.codeVerifier}`);
    return tokenSet;
  }

  async refreshSession(refreshToken: string): Promise<AgenteraTokenSet> {
    this.refreshed.push(refreshToken);
    return {
      ...tokenSet,
      refreshToken: `${tokenSet.refreshToken.slice(0, 42)}A`,
    };
  }

  async revokeSession(refreshToken: string): Promise<void> {
    this.revoked.push(refreshToken);
  }
}

function pkce(fill: number): AgenteraPkceAttempt {
  return {
    state: Buffer.alloc(32, fill).toString("base64url"),
    verifier: Buffer.alloc(32, fill + 1).toString("base64url"),
    challenge: Buffer.alloc(32, fill + 2).toString("base64url"),
  };
}

describe("AgentEra authentication controller", () => {
  let root = "";
  let store: AgenteraAuthStore;
  let cloud: FakeCloudClient;
  let opened: string[];
  let focused: number;
  let attempts: AgenteraPkceAttempt[];
  let callbacks: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-controller-"));
    store = new AgenteraAuthStore({
      userDataPath: root,
      secureStorage: new FakeSecureStorage(),
    });
    cloud = new FakeCloudClient();
    opened = [];
    focused = 0;
    attempts = [pkce(31), pkce(41), pkce(51)];
    callbacks = [
      Buffer.alloc(32, 61).toString("base64url"),
      Buffer.alloc(32, 62).toString("base64url"),
    ];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runtime(
    loopbackFactory?: AgenteraAuthControllerRuntime["startLoopback"],
  ): AgenteraAuthControllerRuntime {
    return {
      store,
      getCloudClient: () => cloud,
      createPkce: () => {
        const next = attempts.shift();
        if (!next) throw new Error("no PKCE attempt");
        return next;
      },
      startLoopback:
        loopbackFactory ??
        (async (_options: AgenteraLoopbackOptions) => {
          const code = callbacks.shift();
          if (!code) throw new Error("no callback code");
          return {
            redirectUri: "http://127.0.0.1:43123/agentera/oauth/callback",
            callback: Promise.resolve({ authorizationCode: code }),
            cancel: vi.fn(),
            close: vi.fn(),
          } satisfies AgenteraLoopbackListener;
        }),
      openExternal: (url, expectedOrigin) => {
        expect(new URL(url).origin).toBe(expectedOrigin);
        opened.push(url);
      },
      bringMainWindowToFront: () => {
        focused += 1;
      },
      getDeviceMetadata: () => ({
        deviceName: "AgentEra Test Mac",
        platform: "darwin",
        appVersion: "0.7.3",
      }),
    };
  }

  // @lat: [[agentera-app-authentication#Browser authorization#Main-process controller]]
  it("completes browser login, persists only protected long-lived material, and publishes an allowlisted state", async () => {
    const controller = createAgenteraAuthController(runtime());
    const observed: unknown[] = [];
    const unsubscribe = controller.subscribe((state) => observed.push(state));

    expect(await controller.initialize()).toEqual({
      status: "unauthenticated",
      reason: "sign_in_required",
    });
    await controller.startBrowserLogin();

    expect(opened).toHaveLength(1);
    expect(focused).toBe(1);
    expect(cloud.exchanged).toHaveLength(1);
    expect(controller.getPublicState()).toEqual({
      status: "authenticated",
      userId: tokenSet.userId,
      personalSpaceId: tokenSet.personalSpaceId,
      deviceId: tokenSet.deviceId,
      offlineExpiresAt: tokenSet.offlineExpiresAt,
      cloudAvailable: true,
    });
    expect(observed.at(-1)).toEqual(controller.getPublicState());
    const raw = readFileSync(store.filePath, "utf8");
    expect(raw).not.toContain(tokenSet.accessToken);
    expect(raw).not.toContain(tokenSet.refreshToken);
    expect(raw).not.toContain(tokenSet.offlineEntitlement);
    unsubscribe();
  });

  it("creates fresh state/listener material and requests account selection on retry", async () => {
    const controller = createAgenteraAuthController(runtime());
    await controller.startBrowserLogin();
    await controller.logout();
    await controller.startBrowserLogin({ forceAccountSelection: true });

    expect(cloud.authorizationRequests).toHaveLength(2);
    expect(cloud.authorizationRequests[0].pkce.state).not.toBe(
      cloud.authorizationRequests[1].pkce.state,
    );
    expect(cloud.authorizationRequests[0].pkce.verifier).not.toBe(
      cloud.authorizationRequests[1].pkce.verifier,
    );
    expect(new URL(opened[1]).searchParams.get("prompt")).toBe(
      "select_account",
    );
    expect(cloud.revoked).toEqual([tokenSet.refreshToken]);
    expect(store.getInstallation()).not.toBeNull();
  });

  it("cancels an in-flight browser attempt without accepting a later callback", async () => {
    let rejectCallback: (error: Error) => void = () => undefined;
    const listener: AgenteraLoopbackListener = {
      redirectUri: "http://127.0.0.1:43123/agentera/oauth/callback",
      callback: new Promise((_resolve, reject) => {
        rejectCallback = reject;
      }),
      cancel: vi.fn(() => rejectCallback(new Error("cancelled"))),
      close: vi.fn(),
    };
    const controller = createAgenteraAuthController(
      runtime(async () => listener),
    );

    const login = controller.startBrowserLogin();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    await controller.cancelBrowserLogin();

    await expect(login).rejects.toThrow(/cancelled/i);
    expect(listener.cancel).toHaveBeenCalledOnce();
    expect(cloud.exchanged).toHaveLength(0);
    expect(controller.getPublicState()).toEqual({
      status: "unauthenticated",
      reason: "sign_in_required",
    });
  });

  it("does not open the browser when cancellation wins the listener-start race", async () => {
    let resolveListener: (listener: AgenteraLoopbackListener) => void = () =>
      undefined;
    let rejectCallback: (error: Error) => void = () => undefined;
    const listener: AgenteraLoopbackListener = {
      redirectUri: "http://127.0.0.1:43123/agentera/oauth/callback",
      callback: new Promise((_resolve, reject) => {
        rejectCallback = reject;
      }),
      cancel: vi.fn(() => rejectCallback(new Error("cancelled"))),
      close: vi.fn(),
    };
    const listenerStarting = new Promise<AgenteraLoopbackListener>(
      (resolve) => {
        resolveListener = resolve;
      },
    );
    const controller = createAgenteraAuthController(
      runtime(async () => listenerStarting),
    );

    const login = controller.startBrowserLogin();
    await controller.cancelBrowserLogin();
    resolveListener(listener);

    await expect(login).rejects.toThrow(/cancelled/i);
    expect(listener.cancel).toHaveBeenCalledOnce();
    expect(opened).toHaveLength(0);
    expect(cloud.authorizationRequests).toHaveLength(0);
  });

  it("rotates a stored session on online initialization", async () => {
    store.saveInstallation({
      installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      devicePublicKey: Buffer.alloc(32, 70).toString("base64url"),
      devicePrivateKey: "private-key",
    });
    store.replaceProductSession(
      {
        userId: tokenSet.userId,
        personalSpaceId: tokenSet.personalSpaceId,
        deviceId: tokenSet.deviceId,
        refreshToken: tokenSet.refreshToken,
        offlineEntitlement: tokenSet.offlineEntitlement,
        offlineExpiresAt: tokenSet.offlineExpiresAt,
        lastTrustedServerTime: tokenSet.trustedServerTime,
      },
      null,
    );
    const controller = createAgenteraAuthController(runtime());

    expect(await controller.initialize()).toMatchObject({
      status: "authenticated",
      cloudAvailable: true,
    });
    expect(cloud.refreshed).toEqual([tokenSet.refreshToken]);
    expect(store.getProductSession()?.refreshToken).not.toBe(
      tokenSet.refreshToken,
    );
  });
});
