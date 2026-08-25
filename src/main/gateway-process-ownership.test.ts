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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fsCallOrder, fsFailureRef, renameFailureRef } = vi.hoisted(() => ({
  fsCallOrder: [] as string[],
  fsFailureRef: { failNextFileFsync: false },
  renameFailureRef: { nextCode: null as string | null },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (descriptor: number): void => {
      const kind = actual.fstatSync(descriptor).isFile() ? "file" : "directory";
      fsCallOrder.push(`fsync:${kind}`);
      if (kind === "file" && fsFailureRef.failNextFileFsync) {
        fsFailureRef.failNextFileFsync = false;
        const error = new Error("injected fsync failure");
        Object.assign(error, { code: "EIO" });
        throw error;
      }
      actual.fsyncSync(descriptor);
    },
    renameSync: (oldPath: string, newPath: string): void => {
      fsCallOrder.push("rename");
      if (renameFailureRef.nextCode !== null) {
        const code = renameFailureRef.nextCode;
        renameFailureRef.nextCode = null;
        const error = new Error(`injected rename failure: ${code}`);
        Object.assign(error, { code });
        throw error;
      }
      actual.renameSync(oldPath, newPath);
    },
  };
});
import {
  GatewayProcessOwnershipLedger,
  GatewayProcessOwnershipError,
  type GatewayLaunchOwnershipRecord,
} from "./gateway-process-ownership";

const NOW = new Date("2026-08-03T10:00:00.000Z");

describe("GatewayProcessOwnershipLedger", () => {
  let root = "";
  let nextId = 0;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aera-gateway-ownership-"));
    nextId = 0;
    fsCallOrder.length = 0;
    fsFailureRef.failNextFileFsync = false;
    renameFailureRef.nextCode = null;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ledger(desktopPid = 100): GatewayProcessOwnershipLedger {
    return new GatewayProcessOwnershipLedger({
      userDataPath: root,
      desktopPid,
      now: () => NOW,
      randomUUID: () =>
        `10000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    });
  }

  it("persists launch intent before spawn without paths or credentials", () => {
    const current = ledger();
    const intent = current.beginLaunch({
      profileId: "research",
      preLaunchPid: null,
    });

    expect(
      new GatewayProcessOwnershipLedger({
        userDataPath: root,
        desktopPid: 101,
      }).get("research"),
    ).toEqual(intent);
    const stored = readFileSync(
      join(root, "gateway-process-ownership.json"),
      "utf8",
    );
    expect(stored).toContain('"profileId":"research"');
    expect(stored).not.toContain(root);
    expect(stored).not.toMatch(/credential|token|secret|api.?key/i);
  });

  it("records the spawned PID and lists every current-process profile", () => {
    const current = ledger();
    const defaultIntent = current.beginLaunch({
      profileId: "default",
      preLaunchPid: null,
    });
    const namedIntent = current.beginLaunch({
      profileId: "research",
      preLaunchPid: 42,
    });

    current.markSpawned({
      profileId: "default",
      launchId: defaultIntent.launchId,
      spawnedPid: 201,
    });
    current.markSpawned({
      profileId: "research",
      launchId: namedIntent.launchId,
      spawnedPid: 202,
    });

    expect(current.listCurrentProcessProfiles()).toEqual([
      "default",
      "research",
    ]);
  });

  it("atomically transfers wrapper ownership to its daemonized listener", () => {
    const current = ledger();
    const intent = current.beginLaunch({
      profileId: "research",
      preLaunchPid: 42,
    });
    current.markSpawned({
      profileId: "research",
      launchId: intent.launchId,
      spawnedPid: 201,
    });
    const adoptSpawnedPid = (
      current as unknown as {
        adoptSpawnedPid?: (input: {
          profileId: string;
          launchId: string;
          previousSpawnedPid: number;
          spawnedPid: number;
        }) => GatewayLaunchOwnershipRecord;
      }
    ).adoptSpawnedPid;
    expect(adoptSpawnedPid).toBeTypeOf("function");
    if (!adoptSpawnedPid) return;

    const adopted = adoptSpawnedPid.call(current, {
      profileId: "research",
      launchId: intent.launchId,
      previousSpawnedPid: 201,
      spawnedPid: 202,
    });

    expect(adopted.spawnedPid).toBe(202);
    expect(current.get("research")?.spawnedPid).toBe(202);
  });

  it("clears a failed spawn but rejects immutable launch replay drift", () => {
    const current = ledger();
    const intent = current.beginLaunch({
      profileId: "research",
      preLaunchPid: null,
    });

    expect(() =>
      current.beginLaunch({ profileId: "research", preLaunchPid: 99 }),
    ).toThrow(
      expect.objectContaining<Partial<GatewayProcessOwnershipError>>({
        code: "ownership_conflict",
      }),
    );
    current.clearLaunch("research", intent.launchId);
    expect(current.get("research")).toBeNull();
  });

  it("does not advance in-memory ownership when a durable write fails", () => {
    const blockedRoot = join(root, "not-a-directory");
    writeFileSync(blockedRoot, "block ledger persistence", "utf8");
    const current = new GatewayProcessOwnershipLedger({
      userDataPath: blockedRoot,
      desktopPid: 100,
    });

    expect(() =>
      current.beginLaunch({ profileId: "research", preLaunchPid: null }),
    ).toThrow(
      expect.objectContaining<Partial<GatewayProcessOwnershipError>>({
        code: "ownership_persistence_failed",
      }),
    );
    expect(current.get("research")).toBeNull();
  });

  it("keeps the prior in-memory record when replacement persistence fails", () => {
    const current = ledger();
    const intent = current.beginLaunch({
      profileId: "research",
      preLaunchPid: null,
    });
    mkdirSync(join(root, "gateway-process-ownership.pending.json"));

    expect(() =>
      current.markSpawned({
        profileId: "research",
        launchId: intent.launchId,
        spawnedPid: 201,
      }),
    ).toThrow(
      expect.objectContaining<Partial<GatewayProcessOwnershipError>>({
        code: "ownership_persistence_failed",
      }),
    );
    expect(current.get("research")).toEqual(intent);

    expect(() => current.clearLaunch("research", intent.launchId)).toThrow(
      expect.objectContaining<Partial<GatewayProcessOwnershipError>>({
        code: "ownership_persistence_failed",
      }),
    );
    expect(current.get("research")).toEqual(intent);
  });

  it("recovers a fully persisted pending replacement after an interrupted rename", () => {
    const current = ledger();
    current.beginLaunch({ profileId: "existing", preLaunchPid: null });
    const ownershipPath = join(root, "gateway-process-ownership.json");
    const priorBytes = readFileSync(ownershipPath, "utf8");
    current.beginLaunch({ profileId: "research", preLaunchPid: null });
    const replacementBytes = readFileSync(ownershipPath, "utf8");

    writeFileSync(ownershipPath, priorBytes, "utf8");
    writeFileSync(
      join(root, "gateway-process-ownership.pending.json"),
      replacementBytes,
      "utf8",
    );

    const restarted = new GatewayProcessOwnershipLedger({
      userDataPath: root,
      desktopPid: 101,
    });
    expect(restarted.get("research")).not.toBeNull();
    expect(
      existsSync(join(root, "gateway-process-ownership.pending.json")),
    ).toBe(false);
    expect(readFileSync(ownershipPath, "utf8")).toBe(replacementBytes);
  });

  it("discards an incomplete pending write without replacing valid ownership", () => {
    const current = ledger();
    const intent = current.beginLaunch({
      profileId: "existing",
      preLaunchPid: null,
    });
    const pendingPath = join(root, "gateway-process-ownership.pending.json");
    writeFileSync(pendingPath, "{incomplete", "utf8");

    const restarted = new GatewayProcessOwnershipLedger({
      userDataPath: root,
      desktopPid: 101,
    });

    expect(restarted.get("existing")).toEqual(intent);
    expect(restarted.getLoadIssue()).toBe("ownership_persistence_failed");
    expect(existsSync(pendingPath)).toBe(false);
  });

  it("never deletes the only durable pending state when promotion is blocked", () => {
    const sourceRoot = join(root, "source");
    const source = new GatewayProcessOwnershipLedger({
      userDataPath: sourceRoot,
      desktopPid: 100,
    });
    const intent = source.beginLaunch({
      profileId: "existing",
      preLaunchPid: null,
    });
    const durableBytes = readFileSync(
      join(sourceRoot, "gateway-process-ownership.json"),
      "utf8",
    );

    const blockedRoot = join(root, "blocked");
    mkdirSync(blockedRoot);
    const pendingPath = join(
      blockedRoot,
      "gateway-process-ownership.pending.json",
    );
    writeFileSync(pendingPath, durableBytes, "utf8");
    renameFailureRef.nextCode = "EIO";
    const current = new GatewayProcessOwnershipLedger({
      userDataPath: blockedRoot,
      desktopPid: 101,
    });
    expect(current.get("existing")).toEqual(intent);

    renameFailureRef.nextCode = "EIO";
    expect(() =>
      current.beginLaunch({ profileId: "research", preLaunchPid: null }),
    ).toThrow(
      expect.objectContaining<Partial<GatewayProcessOwnershipError>>({
        code: "ownership_persistence_failed",
      }),
    );
    expect(existsSync(pendingPath)).toBe(true);
    expect(
      new GatewayProcessOwnershipLedger({
        userDataPath: blockedRoot,
        desktopPid: 102,
      }).get("existing"),
    ).toEqual(intent);
  });

  it("rejects a pending file that becomes invalid after ledger startup", () => {
    const current = ledger();
    const intent = current.beginLaunch({
      profileId: "existing",
      preLaunchPid: null,
    });
    const ownershipPath = join(root, "gateway-process-ownership.json");
    const canonicalBytes = readFileSync(ownershipPath, "utf8");
    writeFileSync(
      join(root, "gateway-process-ownership.pending.json"),
      "{truncated",
      "utf8",
    );

    expect(() =>
      current.beginLaunch({ profileId: "research", preLaunchPid: null }),
    ).toThrow(
      expect.objectContaining<Partial<GatewayProcessOwnershipError>>({
        code: "ownership_persistence_failed",
      }),
    );
    expect(current.get("existing")).toEqual(intent);
    expect(current.get("research")).toBeNull();
    expect(readFileSync(ownershipPath, "utf8")).toBe(canonicalBytes);
  });

  it("removes only the pending file created by a failed replacement write", () => {
    const current = ledger();
    const intent = current.beginLaunch({
      profileId: "existing",
      preLaunchPid: null,
    });
    const ownershipPath = join(root, "gateway-process-ownership.json");
    const priorBytes = readFileSync(ownershipPath, "utf8");
    const pendingPath = join(root, "gateway-process-ownership.pending.json");
    writeFileSync(pendingPath, priorBytes, "utf8");
    fsFailureRef.failNextFileFsync = true;

    expect(() =>
      current.beginLaunch({ profileId: "research", preLaunchPid: null }),
    ).toThrow(
      expect.objectContaining<Partial<GatewayProcessOwnershipError>>({
        code: "ownership_persistence_failed",
      }),
    );
    expect(existsSync(pendingPath)).toBe(false);
    const restarted = new GatewayProcessOwnershipLedger({
      userDataPath: root,
      desktopPid: 101,
    });
    expect(restarted.get("existing")).toEqual(intent);
    expect(restarted.get("research")).toBeNull();
  });

  it("surfaces corrupt ownership state instead of silently treating it as empty", () => {
    writeFileSync(
      join(root, "gateway-process-ownership.json"),
      "{not valid json",
      "utf8",
    );

    const restarted = ledger(101);

    expect(restarted.getLoadIssue()).toBe("invalid_ownership");
  });

  it("reaps only a changed PID proven to be the spawned process", () => {
    const previous = ledger();
    for (const [profileId, preLaunchPid, spawnedPid] of [
      ["owned", null, 301],
      ["unchanged", 302, 303],
      ["dead", null, 304],
      ["ambiguous", null, 305],
      ["missing_alive", null, 307],
    ] as const) {
      const intent = previous.beginLaunch({ profileId, preLaunchPid });
      previous.markSpawned({
        profileId,
        launchId: intent.launchId,
        spawnedPid,
      });
    }
    const currentPid = new Map<string, number | null>([
      ["owned", 301],
      ["unchanged", 302],
      ["dead", 304],
      ["ambiguous", 306],
      ["missing_alive", null],
    ]);
    const restarted = new GatewayProcessOwnershipLedger({
      userDataPath: root,
      desktopPid: 999,
    });

    const recovery = restarted.reconcileColdStart({
      readCurrentPid: (profileId) => currentPid.get(profileId) ?? null,
      isAlive: (pid) => pid !== 304,
    });

    expect(recovery).toEqual({
      ownedProfiles: ["owned"],
      ambiguousProfiles: ["ambiguous", "missing_alive"],
    });
    expect(restarted.get("owned")).not.toBeNull();
    expect(restarted.get("unchanged")).toBeNull();
    expect(restarted.get("dead")).toBeNull();
    expect(restarted.get("ambiguous")).not.toBeNull();
    expect(restarted.get("missing_alive")).not.toBeNull();
  });

  it("never treats an unrecorded Profile as owned", () => {
    const recovery = ledger().reconcileColdStart({
      readCurrentPid: () => 401,
      isAlive: () => true,
    });

    expect(recovery).toEqual({
      ownedProfiles: [],
      ambiguousProfiles: [],
    });
  });

  it("fsyncs ownership bytes before the atomic rename", () => {
    fsCallOrder.length = 0;

    ledger().beginLaunch({ profileId: "research", preLaunchPid: null });

    expect(fsCallOrder.indexOf("fsync:file")).toBeGreaterThan(-1);
    expect(fsCallOrder.indexOf("fsync:file")).toBeLessThan(
      fsCallOrder.indexOf("rename"),
    );
  });

  it.each(["EACCES", "EBUSY", "EEXIST", "EPERM"])(
    "uses the recoverable replacement path after Windows %s",
    (code) => {
      renameFailureRef.nextCode = code;

      const intent = ledger().beginLaunch({
        profileId: "research",
        preLaunchPid: null,
      });

      expect(
        existsSync(join(root, "gateway-process-ownership.pending.json")),
      ).toBe(false);
      expect(
        new GatewayProcessOwnershipLedger({
          userDataPath: root,
          desktopPid: 101,
        }).get("research"),
      ).toEqual(intent);
    },
  );
});
