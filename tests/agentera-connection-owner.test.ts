// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgenteraConnectionOwnerStore,
  createAgenteraOwnerSwitchCoordinator,
} from "../src/main/agentera-connection-owner";
import type { SecureStorageAdapter } from "../src/main/agentera-auth/store";
import type { AgenteraRuntimeOwner } from "../src/main/agentera-profile-binding";

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

const owner: AgenteraRuntimeOwner = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  installationId: "33333333-3333-4333-8333-333333333333",
};

describe("AgentEra remote/SSH connection ownership", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-connection-owner-"));
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("binds only the opaque connection context and rejects another owner", () => {
    const store = new AgenteraConnectionOwnerStore({
      userDataPath: root,
      secureStorage: new FakeSecureStorage(),
      now: () => new Date("2026-07-18T02:00:00.000Z"),
    });
    const contextId = "44444444-4444-4444-8444-444444444444";
    const binding = store.bindConnectionContext(contextId, owner);

    expect(store.verifyConnectionContext(contextId, owner)).toEqual(binding);
    expect(() =>
      store.verifyConnectionContext(contextId, {
        ...owner,
        ownerId: "55555555-5555-4555-8555-555555555555",
      }),
    ).toThrow(/another AgentEra owner/i);
    const raw = readFileSync(store.filePath, "utf8");
    expect(raw).not.toContain(contextId);
    expect(raw).not.toContain(owner.ownerId);
    expect(raw).not.toContain("remoteUrl");
    expect(raw).not.toContain("ssh");
  });

  it("rotates connectionContextId when remote or SSH identity material changes", async () => {
    vi.stubEnv("HERMES_HOME", root);
    const {
      getConnectionConfig,
      rotateConnectionContextId,
      setConnectionConfig,
    } = await import("../src/main/config");
    const initial = getConnectionConfig();
    expect(initial.connectionContextId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);

    setConnectionConfig({
      ...initial,
      mode: "remote",
      remoteUrl: "https://runtime-one.example",
      apiKey: "first-key",
    });
    const remote = getConnectionConfig();
    expect(remote.connectionContextId).not.toBe(initial.connectionContextId);

    setConnectionConfig({ ...remote });
    expect(getConnectionConfig().connectionContextId).toBe(
      remote.connectionContextId,
    );

    setConnectionConfig({
      ...remote,
      remoteUrl: "https://runtime-two.example",
    });
    const changedRemote = getConnectionConfig();
    expect(changedRemote.connectionContextId).not.toBe(
      remote.connectionContextId,
    );

    setConnectionConfig({
      ...changedRemote,
      mode: "ssh",
      ssh: {
        ...changedRemote.ssh,
        host: "ssh.example",
        username: "agentera",
        keyPath: "/keys/agentera_ed25519",
      },
    });
    const ssh = getConnectionConfig();
    expect(ssh.connectionContextId).not.toBe(changedRemote.connectionContextId);

    setConnectionConfig({
      ...ssh,
      ssh: { ...ssh.ssh, keyPath: "/keys/rotated_ed25519" },
    });
    expect(getConnectionConfig().connectionContextId).not.toBe(
      ssh.connectionContextId,
    );

    const beforeCredentialRotation = getConnectionConfig().connectionContextId;
    expect(rotateConnectionContextId()).not.toBe(beforeCredentialRotation);
    expect(getConnectionConfig().connectionContextId).not.toBe(
      beforeCredentialRotation,
    );
  });

  it("tears down cached and running Runtime state before changing owners", () => {
    const events: string[] = [];
    const coordinator = createAgenteraOwnerSwitchCoordinator({
      stopRuntimeContext: () => events.push("stopped"),
    });

    coordinator.transitionTo("owner-a");
    expect(events).toEqual([]);
    coordinator.transitionTo("owner-a");
    expect(events).toEqual([]);
    coordinator.transitionTo("owner-b");
    expect(events).toEqual(["stopped"]);
    coordinator.transitionTo(null);
    expect(events).toEqual(["stopped", "stopped"]);
  });
});
