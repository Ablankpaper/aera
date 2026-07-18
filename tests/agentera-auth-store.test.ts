// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgenteraAuthStore,
  createAgenteraAuthStoreForApp,
  type PendingSelfRevocation,
  type ProductSession,
  type SecureStorageAdapter,
} from "../src/main/agentera-auth/store";
import { serializeAgenteraAuthPublicState } from "../src/shared/agentera-auth";

class FakeSecureStorage implements SecureStorageAdapter {
  available = true;

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(value: string): Buffer {
    return Buffer.from(`protected:${value}`, "utf8");
  }

  decryptString(value: Buffer): string {
    const encoded = value.toString("utf8");
    if (!encoded.startsWith("protected:")) {
      throw new Error("invalid protected value");
    }
    return encoded.slice("protected:".length);
  }
}

describe("AgentEra app-level authentication store", () => {
  let root = "";
  let userData = "";
  let hermesHome = "";
  let secureStorage: FakeSecureStorage;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-auth-store-"));
    userData = join(root, "electron-user-data");
    hermesHome = join(root, "hermes-profile");
    secureStorage = new FakeSecureStorage();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function createStore(
    overrides: Partial<{
      secureStorage: SecureStorageAdapter;
      writeFile: (path: string, content: string) => void;
    }> = {},
  ): AgenteraAuthStore {
    return new AgenteraAuthStore({
      userDataPath: userData,
      secureStorage: overrides.secureStorage ?? secureStorage,
      writeFile: overrides.writeFile,
    });
  }

  const session: ProductSession = {
    userId: "user-01",
    personalSpaceId: "space-01",
    deviceId: "device-01",
    refreshToken: "refresh-secret-value",
    offlineEntitlement: "offline-secret-value",
    offlineExpiresAt: "2026-07-25T00:00:00.000Z",
    lastTrustedServerTime: "2026-07-18T00:00:00.000Z",
  };

  const pendingRevocation: PendingSelfRevocation = {
    deviceId: "device-01",
    installationId: "installation-01",
    timestamp: "2026-07-18T00:01:00.000Z",
    nonce: "revocation-nonce-secret",
    signature: "revocation-signature-secret",
  };

  // @lat: [[agentera-app-authentication#Desktop authentication foundation#App-level secure store]]
  it("writes one atomic app-level envelope with all product secrets encrypted", () => {
    const writes: Array<{ path: string; content: string }> = [];
    const store = createStore({
      writeFile: (path, content) => {
        writes.push({ path, content });
        writeFileSync(path, content, "utf8");
      },
    });

    store.saveInstallation({
      installationId: "installation-01",
      devicePublicKey: "device-public-key",
      devicePrivateKey: "device-private-key-secret",
    });
    writes.length = 0;
    store.replaceProductSession(
      {
        ...session,
        accessToken: "memory-only-access-secret",
      } as ProductSession,
      pendingRevocation,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(store.filePath);
    expect(store.filePath).toBe(join(userData, "agentera-auth", "state.json"));
    expect(store.filePath).not.toBe(
      join(hermesHome, "agentera-auth", "state.json"),
    );
    expect(existsSync(join(hermesHome, "agentera-auth.json"))).toBe(false);

    const raw = readFileSync(store.filePath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      schema: "agentera-product-auth",
      version: 1,
    });
    for (const forbidden of [
      "device-private-key-secret",
      session.refreshToken,
      session.offlineEntitlement,
      pendingRevocation.nonce,
      pendingRevocation.signature,
      "memory-only-access-secret",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    expect(store.getProductSession()).toEqual(session);
    expect(store.getPendingRevocation()).toEqual(pendingRevocation);
  });

  it("logout clears only product session material and preserves installation and Profile data", () => {
    const profileSentinel = join(hermesHome, "MEMORY.md");
    mkdirSync(hermesHome, { recursive: true });
    writeFileSync(profileSentinel, "Hermes learning remains local\n", "utf8");
    const store = createStore();
    store.saveInstallation({
      installationId: "installation-01",
      devicePublicKey: "device-public-key",
      devicePrivateKey: "device-private-key-secret",
    });
    store.replaceProductSession(session, null);

    store.clearProductSession();

    expect(store.getProductSession()).toBeNull();
    expect(store.getInstallation()).toEqual({
      installationId: "installation-01",
      devicePublicKey: "device-public-key",
      devicePrivateKey: "device-private-key-secret",
    });
    expect(readFileSync(profileSentinel, "utf8")).toBe(
      "Hermes learning remains local\n",
    );
  });

  it("can atomically retain an encrypted self-revocation while clearing login material", () => {
    const writes: string[] = [];
    const store = createStore({
      writeFile: (path, content) => {
        writes.push(content);
        writeFileSync(path, content, "utf8");
      },
    });
    store.saveInstallation({
      installationId: "installation-01",
      devicePublicKey: "device-public-key",
      devicePrivateKey: "device-private-key-secret",
    });
    store.replaceProductSession(session, null);
    writes.length = 0;

    store.clearProductSession(pendingRevocation);

    expect(writes).toHaveLength(1);
    expect(store.getProductSession()).toBeNull();
    expect(store.getPendingRevocation()).toEqual(pendingRevocation);
    expect(writes[0]).not.toContain(pendingRevocation.signature);
  });

  it("refuses secret persistence when platform encryption is unavailable", () => {
    secureStorage.available = false;
    const store = createStore();

    expect(() =>
      store.saveInstallation({
        installationId: "installation-01",
        devicePublicKey: "device-public-key",
        devicePrivateKey: "device-private-key-secret",
      }),
    ).toThrow(/secure storage/i);
    expect(() => store.replaceProductSession(session, null)).toThrow(
      /secure storage/i,
    );
    expect(existsSync(store.filePath)).toBe(false);
  });

  it("requires an absolute Electron userData directory", () => {
    expect(
      () =>
        new AgenteraAuthStore({
          userDataPath: "relative-user-data",
          secureStorage,
        }),
    ).toThrow(/absolute/i);
  });

  it("derives the production store root from Electron app.getPath(userData)", () => {
    const requested: string[] = [];
    const store = createAgenteraAuthStoreForApp(
      {
        getPath(name) {
          requested.push(name);
          return userData;
        },
      },
      secureStorage,
    );

    expect(requested).toEqual(["userData"]);
    expect(store.filePath).toBe(join(userData, "agentera-auth", "state.json"));
  });

  it("serializes public state by allowlist and strips runtime secret-shaped extras", () => {
    const serialized = serializeAgenteraAuthPublicState({
      status: "authenticated",
      userId: "user-01",
      personalSpaceId: "space-01",
      deviceId: "device-01",
      offlineExpiresAt: "2026-07-25T00:00:00.000Z",
      cloudAvailable: true,
      refreshToken: "renderer-must-not-see-refresh",
      offlineEntitlement: "renderer-must-not-see-entitlement",
      devicePrivateKey: "renderer-must-not-see-key",
      code: "renderer-must-not-see-code",
      verifier: "renderer-must-not-see-verifier",
      encryptedBlob: "renderer-must-not-see-blob",
    } as never);

    expect(serialized).toEqual({
      status: "authenticated",
      userId: "user-01",
      personalSpaceId: "space-01",
      deviceId: "device-01",
      offlineExpiresAt: "2026-07-25T00:00:00.000Z",
      cloudAvailable: true,
    });
    expect(JSON.stringify(serialized)).not.toMatch(
      /token|entitlement|private|code|verifier|encrypted/i,
    );
  });
});
