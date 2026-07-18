// @vitest-environment node

import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getOrCreateAgenteraDeviceIdentity,
  signAgenteraDeviceDigest,
} from "../src/main/agentera-auth/device-key";
import {
  AgenteraAuthStore,
  type SecureStorageAdapter,
} from "../src/main/agentera-auth/store";

class FakeSecureStorage implements SecureStorageAdapter {
  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(value: string): Buffer {
    return Buffer.from(`keychain:${value}`, "utf8");
  }

  decryptString(value: Buffer): string {
    return value.toString("utf8").replace(/^keychain:/, "");
  }
}

describe("AgentEra installation device identity", () => {
  let userData = "";

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), "agentera-device-key-"));
  });

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true });
  });

  function store(): AgenteraAuthStore {
    return new AgenteraAuthStore({
      userDataPath: userData,
      secureStorage: new FakeSecureStorage(),
    });
  }

  // @lat: [[agentera-app-authentication#Desktop authentication foundation#Installation device identity]]
  it("generates an Ed25519 key once and preserves it across logout and reload", () => {
    const firstStore = store();
    const first = getOrCreateAgenteraDeviceIdentity(firstStore);

    expect(first.installationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(Buffer.from(first.devicePublicKey, "base64url")).toHaveLength(32);
    expect(
      Buffer.from(first.devicePrivateKey, "base64").length,
    ).toBeGreaterThan(32);

    firstStore.clearProductSession();
    const second = getOrCreateAgenteraDeviceIdentity(store());
    expect(second).toEqual(first);
  });

  it("signs protocol digests with the persisted private key", () => {
    const identity = getOrCreateAgenteraDeviceIdentity(store());
    const digest = Buffer.alloc(32, 7);
    const signature = Buffer.from(
      signAgenteraDeviceDigest(identity.devicePrivateKey, digest),
      "base64url",
    );
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const publicKey = createPublicKey({
      key: Buffer.concat([
        spkiPrefix,
        Buffer.from(identity.devicePublicKey, "base64url"),
      ]),
      format: "der",
      type: "spki",
    });

    expect(verify(null, digest, publicKey, signature)).toBe(true);
    expect(verify(null, Buffer.alloc(32, 8), publicKey, signature)).toBe(false);
  });
});
