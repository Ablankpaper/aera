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

  it("migrates a legacy v1 record to schema v3 but keeps missing evidence ambiguous", () => {
    writeFileSync(
      join(root, "gateway-process-ownership.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            launchId: "10000000-0000-4000-8000-000000000001",
            desktopInstanceId: "10000000-0000-4000-8000-000000000002",
            desktopPid: 100,
            profileId: "research",
            preLaunchPid: null,
            spawnedPid: 201,
            createdAt: NOW.toISOString(),
          },
        ],
      }),
      "utf8",
    );

    const restarted = ledger(999);
    const stored = JSON.parse(
      readFileSync(join(root, "gateway-process-ownership.json"), "utf8"),
    );

    expect(stored.version).toBe(3);
    expect(stored.entries[0]).toEqual(
      expect.objectContaining({
        spawnedPid: 201,
        spawnedIdentity: null,
        spawnedImage: null,
        listenerPid: null,
        listenerIdentity: null,
        listenerImage: null,
      }),
    );
    expect(
      restarted.reconcileColdStart({
        readCurrentPid: () => null,
        isAlive: () => false,
        readEvidence: () => null,
      }),
    ).toEqual({
      ownedProfiles: [],
      ambiguousProfiles: ["research"],
    });
    expect(restarted.get("research")).not.toBeNull();
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

  it("persists the exact process identity and executable image", () => {
    const current = ledger();
    const intent = current.beginLaunch({
      profileId: "research",
      preLaunchPid: null,
    });

    const recorded = current.markSpawned({
      profileId: "research",
      launchId: intent.launchId,
      spawnedPid: 201,
      spawnedIdentity: "posix:Mon Aug 26 16:00:00 2026",
      spawnedImage: "python3.11",
    });

    expect(recorded).toMatchObject({
      spawnedPid: 201,
      spawnedIdentity: "posix:Mon Aug 26 16:00:00 2026",
      spawnedImage: "python3.11",
    });
    expect(
      new GatewayProcessOwnershipLedger({
        userDataPath: root,
        desktopPid: 101,
      }).get("research"),
    ).toEqual(recorded);
    expect(
      JSON.parse(
        readFileSync(join(root, "gateway-process-ownership.json"), "utf8"),
      ).entries[0],
    ).toMatchObject({
      spawnedIdentity: "posix:Mon Aug 26 16:00:00 2026",
      spawnedImage: "python3.11",
    });
  });

  it("fails closed during cold recovery when listener evidence is missing or changed", () => {
    const previous = ledger();
    const intent = previous.beginLaunch({
      profileId: "research",
      preLaunchPid: null,
    });
    previous.markSpawned({
      profileId: "research",
      launchId: intent.launchId,
      spawnedPid: 201,
      spawnedIdentity: "windows:created-201",
      spawnedImage: "python.exe",
    });

    const restarted = new GatewayProcessOwnershipLedger({
      userDataPath: root,
      desktopPid: 999,
    });
    expect(
      restarted.reconcileColdStart({
        readCurrentPid: () => 201,
        isAlive: () => true,
        readEvidence: () => ({
          identity: "windows:reused-201",
          image: "python.exe",
        }),
      }),
    ).toEqual({ ownedProfiles: [], ambiguousProfiles: ["research"] });

    expect(
      restarted.reconcileColdStart({
        readCurrentPid: () => 201,
        isAlive: () => true,
        readEvidence: () => ({
          identity: "windows:created-201",
          image: "node.exe",
        }),
      }),
    ).toEqual({ ownedProfiles: [], ambiguousProfiles: ["research"] });

    expect(
      restarted.reconcileColdStart({
        readCurrentPid: () => 201,
        isAlive: () => true,
        readEvidence: () => ({
          identity: "windows:created-201",
          image: "python.exe",
        }),
      }),
    ).toEqual({ ownedProfiles: ["research"], ambiguousProfiles: [] });
  });

  it("recovers an adopted listener without requiring evidence from its exited wrapper", () => {
    const previous = ledger();
    const intent = previous.beginLaunch({
      profileId: "research",
      preLaunchPid: null,
    });
    previous.markSpawned({
      profileId: "research",
      launchId: intent.launchId,
      spawnedPid: 201,
      spawnedIdentity: null,
      spawnedImage: null,
    });
    previous.adoptSpawnedPid({
      profileId: "research",
      launchId: intent.launchId,
      previousSpawnedPid: 201,
      spawnedPid: 202,
      spawnedIdentity: "windows:listener-created",
      spawnedImage: "python.exe",
    });

    const restarted = new GatewayProcessOwnershipLedger({
      userDataPath: root,
      desktopPid: 999,
    });

    expect(
      restarted.reconcileColdStart({
        readCurrentPid: () => 202,
        isAlive: (candidate) => candidate === 202,
        readEvidence: () => ({
          identity: "windows:listener-created",
          image: "python.exe",
        }),
      }),
    ).toEqual({ ownedProfiles: ["research"], ambiguousProfiles: [] });
    expect(restarted.get("research")?.listenerPid).toBe(202);
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
      spawnedIdentity: "wrapper-start",
      spawnedImage: "python3",
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
      previousSpawnedIdentity: "wrapper-start",
      previousSpawnedImage: "python3",
      spawnedIdentity: "listener-start",
      spawnedImage: "python3",
    });

    expect(adopted.spawnedPid).toBe(201);
    expect(adopted.spawnedIdentity).toBe("wrapper-start");
    expect(adopted.spawnedImage).toBe("python3");
    expect(adopted.listenerPid).toBe(202);
    expect(adopted.listenerIdentity).toBe("listener-start");
    expect(adopted.listenerImage).toBe("python3");
    expect(current.get("research")?.listenerPid).toBe(202);
  });

  it("starts a durable restart intent without losing the prior listener proof", () => {
    const current = ledger();
    const launch = current.beginLaunch({
      profileId: "research",
      preLaunchPid: null,
    });
    current.markSpawned({
      profileId: "research",
      launchId: launch.launchId,
      spawnedPid: 201,
      spawnedIdentity: "wrapper-old",
      spawnedImage: "python3",
    });
    current.adoptSpawnedPid({
      profileId: "research",
      launchId: launch.launchId,
      previousSpawnedPid: 201,
      previousSpawnedIdentity: "wrapper-old",
      previousSpawnedImage: "python3",
      spawnedPid: 202,
      spawnedIdentity: "listener-old",
      spawnedImage: "python3",
    });

    const restart = current.beginRestart({
      profileId: "research",
      preLaunchPid: 202,
    });
    current.markSpawned({
      profileId: "research",
      launchId: restart.record.launchId,
      spawnedPid: 203,
      spawnedIdentity: "wrapper-new",
      spawnedImage: "python3",
    });
    restart.record = current.get("research")!;

    expect(restart.previous.listenerPid).toBe(202);
    expect(restart.record.launchId).not.toBe(launch.launchId);
    expect(restart.record.spawnedPid).toBe(203);
    expect(restart.record.listenerPid).toBe(202);
    expect(current.get("research")).toEqual(restart.record);

    current.restoreRestart(restart.record.launchId, restart.previous);
    expect(current.get("research")).toEqual(restart.previous);
  });

  it("keeps a cross-PID legacy record ambiguous until listener evidence is adopted", () => {
    const current = ledger();
    const intent = current.beginLaunch({
      profileId: "research",
      preLaunchPid: null,
    });
    current.markSpawned({
      profileId: "research",
      launchId: intent.launchId,
      spawnedPid: 201,
      spawnedIdentity: "wrapper-start",
      spawnedImage: "python3",
    });

    const restarted = new GatewayProcessOwnershipLedger({
      userDataPath: root,
      desktopPid: 999,
    });
    const recovery = restarted.reconcileColdStart({
      readCurrentPid: () => 202,
      isAlive: () => true,
      readEvidence: () => ({
        identity: "listener-start",
        image: "python3",
      }),
    });
    expect(recovery).toEqual({
      ownedProfiles: [],
      ambiguousProfiles: ["research"],
    });
  });

  it("keeps ownership ambiguous when the stale pre-launch pid hides a live wrapper", () => {
    const previous = ledger();
    const intent = previous.beginLaunch({
      profileId: "research",
      preLaunchPid: 200,
    });
    previous.markSpawned({
      profileId: "research",
      launchId: intent.launchId,
      spawnedPid: 201,
      spawnedIdentity: "windows:wrapper-created",
      spawnedImage: "python.exe",
    });

    const restarted = new GatewayProcessOwnershipLedger({
      userDataPath: root,
      desktopPid: 999,
    });
    const recovery = restarted.reconcileColdStart({
      readCurrentPid: () => 200,
      isAlive: (candidate) => candidate === 200 || candidate === 201,
      readEvidence: () => null,
    });

    expect(recovery).toEqual({
      ownedProfiles: [],
      ambiguousProfiles: ["research"],
    });
    expect(restarted.get("research")).not.toBeNull();
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

  it("preserves a legacy pending record when v3 migration cannot fsync", () => {
    const legacy = {
      version: 1,
      entries: [
        {
          launchId: "10000000-0000-4000-8000-000000000001",
          desktopInstanceId: "10000000-0000-4000-8000-000000000002",
          desktopPid: 100,
          profileId: "research",
          preLaunchPid: null,
          spawnedPid: 201,
          createdAt: NOW.toISOString(),
        },
      ],
    };
    const legacyBytes = JSON.stringify(legacy);
    const pendingPath = join(root, "gateway-process-ownership.pending.json");
    writeFileSync(pendingPath, legacyBytes, "utf8");
    fsFailureRef.failNextFileFsync = true;

    const restarted = ledger(999);

    expect(restarted.get("research")).toMatchObject({
      profileId: "research",
      spawnedPid: 201,
      spawnedIdentity: null,
      spawnedImage: null,
    });
    expect(restarted.getLoadIssue()).toBe("ownership_persistence_failed");
    // Migration must use a new fsynced pending file and an atomic promotion;
    // an interrupted rewrite may never destroy the only legacy evidence.
    expect(
      readFileSync(join(root, "gateway-process-ownership.json"), "utf8"),
    ).toBe(legacyBytes);
    expect(existsSync(pendingPath)).toBe(false);
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
        spawnedIdentity: `identity-${spawnedPid}`,
        spawnedImage: "python3",
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
      readEvidence: (pid) => ({
        identity: `identity-${pid}`,
        image: "python3",
      }),
    });

    expect(recovery).toEqual({
      ownedProfiles: ["owned"],
      ambiguousProfiles: ["ambiguous", "missing_alive", "unchanged"],
    });
    expect(restarted.get("owned")).not.toBeNull();
    expect(restarted.get("unchanged")).not.toBeNull();
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
