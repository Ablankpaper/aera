// @vitest-environment node

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgenteraAuthLifecycle,
  createPendingAgenteraSelfRevocation,
} from "../src/main/agentera-auth/lifecycle";
import { createAgenteraAuthController } from "../src/main/agentera-auth/controller";
import {
  AgenteraCloudClientError,
  type AgenteraCloudClientPort,
  type AgenteraTokenSet,
} from "../src/main/agentera-auth/client";
import { createProductAccessGuard } from "../src/main/ipc/auth-guard";
import {
  AgenteraAuthStore,
  type InstallationIdentity,
  type PendingSelfRevocation,
  type SecureStorageAdapter,
} from "../src/main/agentera-auth/store";

class FakeSecureStorage implements SecureStorageAdapter {
  isEncryptionAvailable(): boolean {
    return true;
  }
  encryptString(value: string): Buffer {
    return Buffer.from(`protected:${value}`);
  }
  decryptString(value: Buffer): string {
    return value.toString().replace(/^protected:/, "");
  }
}

const IDS = {
  user: "11111111-1111-4111-8111-111111111111",
  space: "22222222-2222-4222-8222-222222222222",
  device: "33333333-3333-4333-8333-333333333333",
  installation: "44444444-4444-4444-8444-444444444444",
  jti: "55555555-5555-4555-8555-555555555555",
};
const START = Date.parse("2026-07-18T01:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function createStore(): AgenteraAuthStore {
  const root = mkdtempSync(join(tmpdir(), "agentera-lifecycle-"));
  roots.push(root);
  return new AgenteraAuthStore({
    userDataPath: root,
    secureStorage: new FakeSecureStorage(),
  });
}

function issueTokens(now: number): {
  tokens: AgenteraTokenSet;
  publicKey: string;
  identity: InstallationIdentity;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const identityPair = generateKeyPairSync("ed25519");
  const identityPrivate = identityPair.privateKey.export({
    format: "der",
    type: "pkcs8",
  }) as Buffer;
  const identityPublic = identityPair.publicKey.export({
    format: "der",
    type: "spki",
  }) as Buffer;
  const identity: InstallationIdentity = {
    installationId: IDS.installation,
    devicePublicKey: identityPublic.subarray(-32).toString("base64url"),
    devicePrivateKey: identityPrivate.toString("base64"),
  };
  const iat = Math.floor(now / 1000);
  const exp = iat + 7 * 24 * 60 * 60;
  const header = Buffer.from(
    JSON.stringify({
      alg: "EdDSA",
      kid: "offline-test-v1",
      typ: "agentera-offline-entitlement+jwt",
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://accounts.agentera.example",
      aud: "agentera-studio",
      jti: IDS.jti,
      sub: IDS.user,
      device_id: IDS.device,
      installation_id: IDS.installation,
      personal_space_id: IDS.space,
      policy_version: 1,
      iat,
      exp,
    }),
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const entitlement = `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    publicKey: publicDer.subarray(-32).toString("base64url"),
    identity,
    tokens: {
      accessToken: "memory-only-access",
      accessExpiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
      refreshToken: Buffer.alloc(32, 8).toString("base64url"),
      refreshExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
      offlineEntitlement: entitlement,
      offlineExpiresAt: new Date(exp * 1000).toISOString(),
      userId: IDS.user,
      personalSpaceId: IDS.space,
      deviceId: IDS.device,
      trustedServerTime: new Date(now).toISOString(),
    },
  };
}

class FakeClient implements AgenteraCloudClientPort {
  readonly origin = "https://accounts.agentera.example";
  refreshResult: AgenteraTokenSet | Error;
  delivered: PendingSelfRevocation[] = [];

  constructor(tokens: AgenteraTokenSet) {
    this.refreshResult = tokens;
  }

  createAuthorizationUrl(): URL {
    return new URL("https://accounts.agentera.example/oauth/authorize");
  }
  async exchangeAuthorizationCode(): Promise<AgenteraTokenSet> {
    if (this.refreshResult instanceof Error) throw this.refreshResult;
    return this.refreshResult;
  }
  async refreshSession(): Promise<AgenteraTokenSet> {
    if (this.refreshResult instanceof Error) throw this.refreshResult;
    return this.refreshResult;
  }
  async revokeSession(): Promise<void> {
    return undefined;
  }
  async deliverSelfRevocation(record: PendingSelfRevocation): Promise<void> {
    this.delivered.push(record);
    if (this.refreshResult instanceof Error) throw this.refreshResult;
  }
}

describe("Aera authorization lifecycle", () => {
  it("schedules fifteen-minute validation and bounded jittered recovery", async () => {
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const validateOnline = vi.fn().mockResolvedValue(undefined);
    const lifecycle = new AgenteraAuthLifecycle({
      validateOnline,
      random: () => 0.5,
      setTimer: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
      clearTimer: vi.fn(),
    });

    lifecycle.noteOnlineValidationSucceeded();
    expect(scheduled.at(-1)?.delay).toBe(15 * 60 * 1000);
    scheduled.at(-1)?.callback();
    await vi.waitFor(() => expect(validateOnline).toHaveBeenCalledOnce());

    lifecycle.noteControlPlaneUnavailable();
    expect(scheduled.at(-1)?.delay).toBe(1_000);
    lifecycle.noteControlPlaneUnavailable();
    expect(scheduled.at(-1)?.delay).toBe(2_000);
    for (let index = 0; index < 20; index += 1) {
      lifecycle.noteControlPlaneUnavailable();
    }
    expect(scheduled.at(-1)?.delay).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it("uses a signed entitlement during an outage, then blocks new work at expiry without touching Hermes data", async () => {
    let wall = START;
    let monotonic = 1_000;
    const issued = issueTokens(START);
    const store = createStore();
    store.saveInstallation(issued.identity);
    store.replaceProductSession(
      {
        userId: issued.tokens.userId,
        personalSpaceId: issued.tokens.personalSpaceId,
        deviceId: issued.tokens.deviceId,
        refreshToken: issued.tokens.refreshToken,
        offlineEntitlement: issued.tokens.offlineEntitlement,
        offlineExpiresAt: issued.tokens.offlineExpiresAt,
        lastTrustedServerTime: issued.tokens.trustedServerTime,
      },
      null,
    );
    const client = new FakeClient(issued.tokens);
    client.refreshResult = new AgenteraCloudClientError(
      0,
      "network_unavailable",
    );
    const safeStop = vi.fn();
    const profileSentinel = join(store.filePath, "..", "..", "MEMORY.md");
    writeFileSync(profileSentinel, "Hermes learning remains local\n");
    const controller = createAgenteraAuthController({
      store,
      getCloudClient: () => client,
      offlinePublicKeys: { "offline-test-v1": issued.publicKey },
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      onProductAccessLost: safeStop,
      openExternal: vi.fn(),
      bringMainWindowToFront: vi.fn(),
      getDeviceMetadata: () => ({
        deviceName: "Test Mac",
        platform: "darwin",
        appVersion: "0.7.3",
      }),
    });

    expect(await controller.initialize()).toMatchObject({
      status: "offline",
      cloudAvailable: false,
    });
    const guard = createProductAccessGuard({
      getAuthState: () => controller.getPublicState(),
      isRuntimeContextBound: () => true,
      assertCurrentEntitlement: () => controller.assertCanStartNewTask(),
    });
    expect(() => guard.assert("bound-profile")).not.toThrow();

    wall += 7 * 24 * 60 * 60 * 1000;
    monotonic += 7 * 24 * 60 * 60 * 1000;
    expect(() => guard.assert("bound-profile")).toThrow(/offline access/i);
    expect(controller.getPublicState()).toEqual({
      status: "blocked",
      reason: "offline_expired",
    });
    expect(safeStop).toHaveBeenCalledOnce();
    expect(readFileSync(profileSentinel, "utf8")).toBe(
      "Hermes learning remains local\n",
    );
  });

  it("maps online revocation immediately and leaves all Profile bytes unchanged", async () => {
    const issued = issueTokens(START);
    const store = createStore();
    store.saveInstallation(issued.identity);
    store.replaceProductSession(
      {
        userId: issued.tokens.userId,
        personalSpaceId: issued.tokens.personalSpaceId,
        deviceId: issued.tokens.deviceId,
        refreshToken: issued.tokens.refreshToken,
        offlineEntitlement: issued.tokens.offlineEntitlement,
        offlineExpiresAt: issued.tokens.offlineExpiresAt,
        lastTrustedServerTime: issued.tokens.trustedServerTime,
      },
      null,
    );
    const client = new FakeClient(issued.tokens);
    client.refreshResult = new AgenteraCloudClientError(401, "session_revoked");
    const safeStop = vi.fn();
    const profile = join(store.filePath, "..", "..", "profile-fixture.bin");
    writeFileSync(profile, Buffer.from([1, 2, 3, 4]));
    const before = createHash("sha256")
      .update(readFileSync(profile))
      .digest("hex");
    const controller = createAgenteraAuthController({
      store,
      getCloudClient: () => client,
      offlinePublicKeys: { "offline-test-v1": issued.publicKey },
      wallNow: () => START,
      monotonicNow: () => 1_000,
      onProductAccessLost: safeStop,
      openExternal: vi.fn(),
      bringMainWindowToFront: vi.fn(),
      getDeviceMetadata: () => ({
        deviceName: "Test Mac",
        platform: "darwin",
        appVersion: "0.7.3",
      }),
    });

    expect(await controller.initialize()).toEqual({
      status: "blocked",
      reason: "device_revoked",
    });
    expect(store.getProductSession()).toBeNull();
    expect(safeStop).not.toHaveBeenCalled();
    expect(
      createHash("sha256").update(readFileSync(profile)).digest("hex"),
    ).toBe(before);
  });

  it("clears local login material before an unreachable logout and retains only a device-signed retry", async () => {
    const issued = issueTokens(START);
    const store = createStore();
    store.saveInstallation(issued.identity);
    store.replaceProductSession(
      {
        userId: issued.tokens.userId,
        personalSpaceId: issued.tokens.personalSpaceId,
        deviceId: issued.tokens.deviceId,
        refreshToken: issued.tokens.refreshToken,
        offlineEntitlement: issued.tokens.offlineEntitlement,
        offlineExpiresAt: issued.tokens.offlineExpiresAt,
        lastTrustedServerTime: issued.tokens.trustedServerTime,
      },
      null,
    );
    const client = new FakeClient(issued.tokens);
    client.refreshResult = new AgenteraCloudClientError(
      0,
      "network_unavailable",
    );
    const controller = createAgenteraAuthController({
      store,
      getCloudClient: () => client,
      offlinePublicKeys: { "offline-test-v1": issued.publicKey },
      wallNow: () => START,
      monotonicNow: () => 1_000,
      openExternal: vi.fn(),
      bringMainWindowToFront: vi.fn(),
      getDeviceMetadata: () => ({
        deviceName: "Test Mac",
        platform: "darwin",
        appVersion: "0.7.3",
      }),
    });

    await controller.logout();

    expect(store.getProductSession()).toBeNull();
    expect(store.getPendingRevocation()).toMatchObject({
      deviceId: IDS.device,
      installationId: IDS.installation,
    });
    expect(JSON.stringify(store.getPendingRevocation())).not.toContain(
      issued.tokens.refreshToken,
    );
    expect(controller.getPublicState()).toEqual({
      status: "unauthenticated",
      reason: "sign_in_required",
    });
  });

  it("creates the exact device-signed self-revocation protocol record", () => {
    const issued = issueTokens(START);
    const record = createPendingAgenteraSelfRevocation({
      deviceId: IDS.device,
      identity: issued.identity,
      now: new Date(START),
      nonce: Buffer.alloc(32, 9),
    });
    expect(record).toMatchObject({
      deviceId: IDS.device,
      installationId: IDS.installation,
      timestamp: String(Math.floor(START / 1000)),
      nonce: Buffer.alloc(32, 9).toString("base64url"),
    });
    expect(record.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });
});
