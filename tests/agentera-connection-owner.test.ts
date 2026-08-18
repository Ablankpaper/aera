// @vitest-environment node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgenteraConnectionOwnerStore,
  createAgenteraOwnerSwitchCoordinator,
  type AgenteraOwnerTransitionEvent,
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
  deviceInstallationId: "33333333-3333-4333-8333-333333333333",
};

describe("Aera remote/SSH connection ownership", () => {
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
    ).toThrow(/another Aera owner/i);
    const raw = readFileSync(store.filePath, "utf8");
    expect(raw).not.toContain(contextId);
    expect(raw).not.toContain(owner.ownerId);
    expect(raw).not.toContain("remoteUrl");
    expect(raw).not.toContain("ssh");
  });

  it("migrates encrypted connection ownership from installationId to deviceInstallationId", () => {
    const secureStorage = new FakeSecureStorage();
    const store = new AgenteraConnectionOwnerStore({
      userDataPath: root,
      secureStorage,
    });
    const contextId = "44444444-4444-4444-8444-444444444444";
    const legacy = JSON.stringify([
      {
        connectionContextId: contextId,
        tenantId: owner.tenantId,
        ownerScope: "USER",
        ownerId: owner.ownerId,
        installationId: owner.deviceInstallationId,
        boundAt: "2026-07-18T02:00:00.000Z",
      },
    ]);
    mkdirSync(dirname(store.filePath), { recursive: true });
    writeFileSync(
      store.filePath,
      `${JSON.stringify({
        schema: "agentera-connection-owners",
        version: 1,
        encryptedBindings: secureStorage
          .encryptString(legacy)
          .toString("base64"),
      })}\n`,
    );

    expect(store.verifyConnectionContext(contextId, owner)).toMatchObject({
      deviceInstallationId: owner.deviceInstallationId,
    });
    expect(
      (JSON.parse(readFileSync(store.filePath, "utf8")) as { version: number })
        .version,
    ).toBe(2);
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

  it("tears down cached and running Runtime state before changing owners", async () => {
    const events: string[] = [];
    const coordinator = createAgenteraOwnerSwitchCoordinator({
      stopRuntimeContext: () => events.push("stopped"),
    });

    await coordinator.transitionTo("owner-a");
    expect(events).toEqual([]);
    await coordinator.transitionTo("owner-a");
    expect(events).toEqual([]);
    await coordinator.transitionTo("owner-b");
    expect(events).toEqual(["stopped"]);
    await coordinator.transitionTo(null);
    expect(events).toEqual(["stopped", "stopped"]);
  });

  it("aborts the old lease before teardown and exposes no owner identity", async () => {
    let release: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: AgenteraOwnerTransitionEvent[] = [];
    const coordinator = createAgenteraOwnerSwitchCoordinator({
      stopRuntimeContext: () => cleanup,
      onEvent: (event) => events.push(event),
    });

    const first = await coordinator.transitionTo("owner-a");
    const lease = await coordinator.acquireLease();
    const switching = coordinator.transitionTo("owner-b");

    expect(lease.signal.aborted).toBe(true);
    expect(() => lease.assertCurrent()).toThrowError(
      expect.objectContaining({ code: "model_owner_transition_in_progress" }),
    );
    expect(coordinator.snapshot().epoch).toBe(first.epoch + 1);
    expect(JSON.stringify(coordinator.snapshot())).not.toContain("owner-a");
    expect(JSON.stringify(coordinator.snapshot())).not.toContain("owner-b");
    expect(events.map((event) => event.phase)).toEqual([
      "begin",
      "ready",
      "begin",
    ]);

    release?.();
    const result = await switching;
    expect(result.state).toBe("ready");
    expect(result.epoch).toBe(first.epoch + 1);
    expect(result.diagnosticId).toMatch(/^[0-9a-f]{12}$/);
    expect(events.map((event) => event.phase)).toEqual([
      "begin",
      "ready",
      "begin",
      "ready",
    ]);
  });

  it("serializes concurrent transitions and mounts only the final owner after cleanup", async () => {
    const cleanups: Array<() => void> = [];
    const stopRuntimeContext = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          cleanups.push(resolve);
        }),
    );
    const coordinator = createAgenteraOwnerSwitchCoordinator({
      stopRuntimeContext,
      timeoutMs: 500,
    });

    await coordinator.transitionTo("owner-a");
    const toB = coordinator.transitionTo("owner-b");
    const toC = coordinator.transitionTo("owner-c");
    await vi.waitFor(() => expect(stopRuntimeContext).toHaveBeenCalledTimes(1));
    expect(coordinator.snapshot().state).toBe("transitioning");
    cleanups.shift()?.();
    await vi.waitFor(() => expect(stopRuntimeContext).toHaveBeenCalledTimes(2));
    expect(coordinator.snapshot().state).toBe("transitioning");
    cleanups.shift()?.();

    await expect(toB).resolves.toMatchObject({ state: "ready" });
    await expect(toC).resolves.toMatchObject({ state: "ready" });
    expect(coordinator.snapshot().state).toBe("ready");
    expect(stopRuntimeContext).toHaveBeenCalledTimes(2);
  });

  it("keeps a third transition behind the second transition's cleanup", async () => {
    const cleanups: Array<() => void> = [];
    const stopRuntimeContext = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          cleanups.push(resolve);
        }),
    );
    const coordinator = createAgenteraOwnerSwitchCoordinator({
      stopRuntimeContext,
      timeoutMs: 500,
    });

    await coordinator.transitionTo("owner-a");
    const toB = coordinator.transitionTo("owner-b");
    const toC = coordinator.transitionTo("owner-c");
    await vi.waitFor(() => expect(stopRuntimeContext).toHaveBeenCalledTimes(1));
    cleanups.shift()?.();
    await vi.waitFor(() => expect(stopRuntimeContext).toHaveBeenCalledTimes(2));

    const toD = coordinator.transitionTo("owner-d");
    expect(stopRuntimeContext).toHaveBeenCalledTimes(2);
    cleanups.shift()?.();
    await expect(toB).resolves.toMatchObject({ state: "ready" });
    await expect(toC).resolves.toMatchObject({ state: "ready" });
    await vi.waitFor(() => expect(stopRuntimeContext).toHaveBeenCalledTimes(3));
    cleanups.shift()?.();
    await expect(toD).resolves.toMatchObject({ state: "ready" });
    expect(stopRuntimeContext).toHaveBeenCalledTimes(3);
  });

  it("fails closed on teardown timeout and never activates the requested owner", async () => {
    const events: AgenteraOwnerTransitionEvent[] = [];
    const coordinator = createAgenteraOwnerSwitchCoordinator({
      stopRuntimeContext: () => new Promise<void>(() => undefined),
      timeoutMs: 10,
      onEvent: (event) => events.push(event),
    });

    await coordinator.transitionTo("owner-a");
    await expect(coordinator.transitionTo("owner-b")).rejects.toMatchObject({
      code: "owner_transition_timeout",
    });
    expect(coordinator.snapshot().state).toBe("blocked");
    expect(events.at(-1)?.phase).toBe("timeout");
    await expect(coordinator.acquireLease()).rejects.toMatchObject({
      code: "owner_transition_timeout",
    });
  });

  it("keeps a failed teardown unmounted when the cleanup rejects", async () => {
    const events: AgenteraOwnerTransitionEvent[] = [];
    const coordinator = createAgenteraOwnerSwitchCoordinator({
      stopRuntimeContext: async () => {
        throw new Error("private cleanup detail");
      },
      onEvent: (event) => events.push(event),
    });

    await coordinator.transitionTo("owner-a");
    await expect(coordinator.transitionTo("owner-b")).rejects.toMatchObject({
      code: "owner_transition_failed",
    });
    expect(coordinator.snapshot().state).toBe("blocked");
    expect(JSON.stringify(events)).not.toContain("private cleanup detail");
    await expect(coordinator.acquireLease()).rejects.toMatchObject({
      code: "owner_transition_failed",
    });
  });

  it("waits for an in-flight transition before issuing a new lease", async () => {
    let release: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = createAgenteraOwnerSwitchCoordinator({
      stopRuntimeContext: () => cleanup,
    });
    await coordinator.transitionTo("owner-a");
    const switching = coordinator.transitionTo("owner-b");
    let settled = false;
    const nextLease = coordinator.acquireLease().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release?.();
    await switching;
    await nextLease;
    expect(settled).toBe(true);
  });
});
