// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

const coarseMetadataState = vi.hoisted(() => {
  type FileIdentity = {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mode: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    nlink: bigint;
  };
  const paths = new Set<string>();
  const identities = new Map<string, FileIdentity>();
  return {
    paths,
    identities,
    wrap<T extends object>(path: string, stats: T): T {
      const fileStats = stats as T & FileIdentity;
      const identity = identities.get(path) ?? {
        dev: fileStats.dev,
        ino: fileStats.ino,
        size: fileStats.size,
        mode: fileStats.mode,
        mtimeNs: fileStats.mtimeNs,
        ctimeNs: fileStats.ctimeNs,
        nlink: fileStats.nlink,
      };
      identities.set(path, identity);
      return new Proxy(stats, {
        get(target, property, receiver) {
          if (property in identity) {
            return identity[property as keyof FileIdentity];
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: ((...args: Parameters<typeof actual.lstatSync>) => {
      const stats = actual.lstatSync(...args);
      if (stats === undefined) return stats;
      const path = String(args[0]);
      if (!coarseMetadataState.paths.has(path)) return stats;
      return coarseMetadataState.wrap(path, stats);
    }) as typeof actual.lstatSync,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      if (!coarseMetadataState.paths.has(path)) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "stat") {
            return async (...statArgs: Parameters<typeof target.stat>) => {
              const stats = await target.stat(...statArgs);
              return coarseMetadataState.wrap(path, stats);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof actual.open,
  };
});
import { RuntimeActivityCoordinator } from "../runtime-activity";
import {
  assertUniqueSnapshotPaths,
  normalizeSnapshotRelativePath,
  withEncryptedBackupSnapshot,
  type EncryptedBackupSnapshot,
} from "./snapshot";

const PROFILE_LINEAGE_ID = "30000000-0000-4000-8000-000000000001";
const INSTALLATION_ID = "40000000-0000-4000-8000-000000000001";
const DEFINITION_ID = "50000000-0000-4000-8000-000000000001";
const VERSION_ID = "60000000-0000-4000-8000-000000000001";
const roots: string[] = [];

function temporaryFixture(): {
  root: string;
  profilePath: string;
  transactionsRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), "agentera-backup-snapshot-"));
  roots.push(root);
  const profilePath = join(root, "profile");
  const transactionsRoot = join(root, "userData", "transactions");
  mkdirSync(profilePath, { recursive: true });
  return { root, profilePath, transactionsRoot };
}

function write(
  profilePath: string,
  relativePath: string,
  content: string | Buffer,
): void {
  const path = join(profilePath, ...relativePath.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function snapshotInput(
  profilePath: string,
  transactionsRoot: string,
): Parameters<typeof withEncryptedBackupSnapshot>[0] {
  return {
    profilePath,
    transactionsRoot,
    profileLineageId: PROFILE_LINEAGE_ID,
    provenance: {
      sourceInstallationId: INSTALLATION_ID,
      sourceDefinitionId: DEFINITION_ID,
      sourceVersionId: VERSION_ID,
      baseOwnerScope: "USER",
    },
    encryptedRuntimeBindingProvenance: Buffer.from(
      "opaque-encrypted-binding-provenance",
    ),
    activity: new RuntimeActivityCoordinator(),
    now: () => new Date("2026-07-23T12:00:00.000Z"),
    randomUUID: () => "70000000-0000-4000-8000-000000000001",
    sqlite: {
      backup: async (sourcePath, destinationPath) => {
        const source = new DatabaseSync(sourcePath, { readOnly: true });
        try {
          await backup(source, destinationPath);
        } finally {
          source.close();
        }
      },
      normalize: (path) => {
        const database = new DatabaseSync(path);
        try {
          database.exec("PRAGMA journal_mode = DELETE");
        } finally {
          database.close();
        }
      },
      verify: (path) => {
        const database = new DatabaseSync(path, { readOnly: true });
        try {
          return (
            (
              database.prepare("PRAGMA quick_check").get() as {
                quick_check?: unknown;
              }
            ).quick_check === "ok"
          );
        } finally {
          database.close();
        }
      },
    },
  };
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
  coarseMetadataState.paths.clear();
  coarseMetadataState.identities.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("allowlisted encrypted-backup snapshot", () => {
  it("copies only approved private state, sanitizes config, and uses SQLite online backup", async () => {
    const { profilePath, transactionsRoot } = temporaryFixture();
    write(profilePath, "memories/MEMORY.md", "private memory\n");
    write(profilePath, "memories/USER.md", "private user\n");
    write(profilePath, "skills/learned/SKILL.md", "# Learned\n");
    write(profilePath, "skills/learned/references/notes.md", "private notes\n");
    write(profilePath, ".curator/state.json", '{"durable":true}\n');
    write(profilePath, "curator/archives/one.json", '{"archive":true}\n');
    write(profilePath, "files/image.bin", Buffer.from([1, 2, 3, 4]));
    write(
      profilePath,
      "config.yaml",
      [
        "model: hermes-3",
        "provider: local",
        "temperature: 0.2",
        "api_key: secret-config-canary",
        "api_server:",
        "  token: secret-token-canary",
        "tools:",
        `  external_dirs: [${JSON.stringify(join(profilePath, "shared"))}]`,
        "",
      ].join("\n"),
    );
    for (const [path, content] of [
      [".env", "API_KEY=secret-env-canary"],
      ["auth.json", '{"token":"secret-auth-canary"}'],
      ["logs/runtime.log", "secret-log-canary"],
      ["cache/model.bin", "secret-cache-canary"],
      ["runtime/python", "secret-runtime-canary"],
      ["skills/learned/.env", "API_KEY=skill-secret-canary"],
      ["files/auth.json", '{"token":"attachment-secret-canary"}'],
      ["projections/official/asset.md", "generated projection"],
    ]) {
      write(profilePath, path, content);
    }

    const sourceDatabase = new DatabaseSync(join(profilePath, "state.db"));
    sourceDatabase.exec("PRAGMA journal_mode = WAL");
    sourceDatabase.exec(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, content TEXT NOT NULL)",
    );
    sourceDatabase
      .prepare("INSERT INTO sessions (id, content) VALUES (?, ?)")
      .run("session-1", "private session");
    const beforeMemory = fileDigest(join(profilePath, "memories", "MEMORY.md"));

    let captured: EncryptedBackupSnapshot | null = null;
    try {
      await withEncryptedBackupSnapshot(
        snapshotInput(profilePath, transactionsRoot),
        async (snapshot) => {
          captured = snapshot;
          // Node's POSIX mode projection is not Windows DACL evidence; the
          // DACL remains part of the physical-Windows release gate.
          if (process.platform !== "win32") {
            expect(statSync(snapshot.transactionPath).mode & 0o777).toBe(0o700);
            expect(statSync(snapshot.filesPath).mode & 0o777).toBe(0o700);
            expect(statSync(snapshot.manifestPath).mode & 0o777).toBe(0o600);
          }
          const paths = snapshot.manifest.files.map((file) => file.path);
          expect(paths).toEqual([
            ".curator/state.json",
            "config.yaml",
            "curator/archives/one.json",
            "files/image.bin",
            "memories/MEMORY.md",
            "memories/USER.md",
            "provenance/runtime-bindings.enc",
            "skills/learned/SKILL.md",
            "skills/learned/references/notes.md",
            "state.db",
          ]);
          const serialized = readFileSync(snapshot.manifestPath, "utf8");
          for (const canary of [
            "secret-config-canary",
            "secret-token-canary",
            "secret-env-canary",
            "secret-auth-canary",
            "secret-log-canary",
            "secret-cache-canary",
            "secret-runtime-canary",
            "skill-secret-canary",
            "attachment-secret-canary",
            profilePath,
          ]) {
            expect(serialized).not.toContain(canary);
          }
          const safeConfig = readFileSync(
            join(snapshot.filesPath, "config.yaml"),
            "utf8",
          );
          expect(safeConfig).toContain("model: hermes-3");
          expect(safeConfig).toContain("provider: local");
          expect(safeConfig).not.toMatch(/api_key|token|external_dirs|secret/i);

          const copiedDatabase = new DatabaseSync(
            join(snapshot.filesPath, "state.db"),
            { readOnly: true },
          );
          try {
            expect(
              copiedDatabase
                .prepare("SELECT content FROM sessions WHERE id = ?")
                .get("session-1"),
            ).toEqual({ content: "private session" });
            expect(
              (
                copiedDatabase.prepare("PRAGMA quick_check").get() as {
                  quick_check: string;
                }
              ).quick_check,
            ).toBe("ok");
          } finally {
            copiedDatabase.close();
          }
          expect(existsSync(join(snapshot.filesPath, "state.db-wal"))).toBe(
            false,
          );
          expect(existsSync(join(snapshot.filesPath, "state.db-shm"))).toBe(
            false,
          );
          if (process.platform !== "win32") {
            for (const file of snapshot.manifest.files) {
              expect(
                statSync(join(snapshot.filesPath, ...file.path.split("/")))
                  .mode & 0o777,
              ).toBe(0o600);
            }
          }
        },
      );
    } finally {
      sourceDatabase.close();
    }

    expect(captured).not.toBeNull();
    expect(existsSync(captured!.transactionPath)).toBe(false);
    expect(fileDigest(join(profilePath, "memories", "MEMORY.md"))).toBe(
      beforeMemory,
    );
    expect(
      existsSync(join(profilePath, "state.db-wal")) ||
        existsSync(join(profilePath, "state.db-shm")),
    ).toBe(false);
  });

  it("rejects symlinks, hard links, and special files inside allowed roots", async () => {
    const first = temporaryFixture();
    mkdirSync(join(first.profilePath, "skills"), { recursive: true });
    symlinkSync(
      join(first.root, "outside"),
      join(first.profilePath, "skills", "linked"),
    );
    await expect(
      withEncryptedBackupSnapshot(
        snapshotInput(first.profilePath, first.transactionsRoot),
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "unsafe_entry" });

    const second = temporaryFixture();
    write(second.profilePath, "skills/one/SKILL.md", "# one\n");
    linkSync(
      join(second.profilePath, "skills", "one", "SKILL.md"),
      join(second.profilePath, "skills", "one", "copy.md"),
    );
    await expect(
      withEncryptedBackupSnapshot(
        snapshotInput(second.profilePath, second.transactionsRoot),
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "unsafe_entry" });

    if (process.platform !== "win32") {
      const third = temporaryFixture();
      mkdirSync(join(third.profilePath, "files"), { recursive: true });
      execFileSync("mkfifo", [join(third.profilePath, "files", "pipe")]);
      await expect(
        withEncryptedBackupSnapshot(
          snapshotInput(third.profilePath, third.transactionsRoot),
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: "unsafe_entry" });
    }
  });

  it("normalizes paths and rejects escape, duplicate, case, and Unicode collisions", () => {
    expect(normalizeSnapshotRelativePath("skills/team/SKILL.md")).toBe(
      "skills/team/SKILL.md",
    );
    for (const path of [
      "../escape",
      "/absolute",
      "skills/../escape",
      "skills//double",
      "skills/\0bad",
      "C:\\absolute",
    ]) {
      expect(() => normalizeSnapshotRelativePath(path)).toThrow();
    }
    expect(() =>
      assertUniqueSnapshotPaths(["skills/Alpha/a.md", "skills/alpha/a.md"]),
    ).toThrow("collision");
    expect(() =>
      assertUniqueSnapshotPaths([
        "skills/caf\u00e9/a.md",
        "skills/cafe\u0301/a.md",
      ]),
    ).toThrow("collision");
    expect(() =>
      assertUniqueSnapshotPaths(["files/a.txt", "files/a.txt"]),
    ).toThrow("collision");
  });

  it("retries one changing file, then fails closed after two retries", async () => {
    const stable = temporaryFixture();
    write(stable.profilePath, "files/changing.txt", "v1");
    let stableMutations = 0;
    await expect(
      withEncryptedBackupSnapshot(
        {
          ...snapshotInput(stable.profilePath, stable.transactionsRoot),
          fileHooks: {
            afterRead: (path) => {
              if (path.endsWith("changing.txt") && stableMutations++ === 0) {
                writeFileSync(path, "v2");
              }
            },
          },
        },
        async (snapshot) =>
          readFileSync(
            join(snapshot.filesPath, "files", "changing.txt"),
            "utf8",
          ),
      ),
    ).resolves.toBe("v2");

    const unstable = temporaryFixture();
    write(unstable.profilePath, "files/changing.txt", "v1");
    await expect(
      withEncryptedBackupSnapshot(
        {
          ...snapshotInput(unstable.profilePath, unstable.transactionsRoot),
          fileHooks: {
            afterRead: (path, attempt) => {
              if (path.endsWith("changing.txt")) {
                writeFileSync(path, `changed-${attempt}-${randomUUID()}`);
              }
            },
          },
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "unstable_file" });
    expect(
      existsSync(
        join(unstable.transactionsRoot, "70000000-0000-4000-8000-000000000001"),
      ),
    ).toBe(false);
  });

  // @lat: [[agentera-post-official-delivery#End-to-end encrypted backup V1#Snapshot byte-stability boundary#Copied files detect same-identity byte changes]]
  it("fails closed when changed bytes retain the same observable file identity", async () => {
    const fixture = temporaryFixture();
    write(fixture.profilePath, "files/changing.txt", "0000");
    const sourcePath = realpathSync.native(
      join(fixture.profilePath, "files", "changing.txt"),
    );
    coarseMetadataState.paths.add(sourcePath);
    let mutations = 0;

    await expect(
      withEncryptedBackupSnapshot(
        {
          ...snapshotInput(fixture.profilePath, fixture.transactionsRoot),
          fileHooks: {
            afterRead: (path) => {
              if (path === sourcePath) {
                mutations += 1;
                writeFileSync(path, String(mutations).padStart(4, "0"));
              }
            },
          },
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "unstable_file" });
    expect(mutations).toBe(3);
  });

  // @lat: [[agentera-post-official-delivery#End-to-end encrypted backup V1#Snapshot byte-stability boundary#Sanitized config detects same-identity byte changes]]
  it("fails closed when sanitized config changes behind coarse metadata", async () => {
    const fixture = temporaryFixture();
    write(fixture.profilePath, "config.yaml", "model: a\n");
    const sourcePath = realpathSync.native(
      join(fixture.profilePath, "config.yaml"),
    );
    coarseMetadataState.paths.add(sourcePath);
    let mutations = 0;

    await expect(
      withEncryptedBackupSnapshot(
        {
          ...snapshotInput(fixture.profilePath, fixture.transactionsRoot),
          fileHooks: {
            afterRead: (path) => {
              if (path === sourcePath) {
                mutations += 1;
                writeFileSync(
                  path,
                  `model: ${String.fromCharCode(97 + mutations)}\n`,
                );
              }
            },
          },
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "unstable_file" });
    expect(mutations).toBe(3);
  });

  it("bounds total bytes, honors cancellation, and always removes staging", async () => {
    const tooLarge = temporaryFixture();
    write(tooLarge.profilePath, "files/large.bin", Buffer.alloc(33, 0x41));
    await expect(
      withEncryptedBackupSnapshot(
        {
          ...snapshotInput(tooLarge.profilePath, tooLarge.transactionsRoot),
          maximumBytes: 32,
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "snapshot_too_large" });

    const cancelled = temporaryFixture();
    write(cancelled.profilePath, "files/private.txt", "private");
    const controller = new AbortController();
    controller.abort();
    await expect(
      withEncryptedBackupSnapshot(
        {
          ...snapshotInput(cancelled.profilePath, cancelled.transactionsRoot),
          signal: controller.signal,
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(
      existsSync(
        join(
          cancelled.transactionsRoot,
          "70000000-0000-4000-8000-000000000001",
        ),
      ),
    ).toBe(false);
  });

  it("never invokes the broad Hermes backup path", () => {
    const source = readFileSync(join(__dirname, "snapshot.ts"), "utf8");
    expect(source).not.toContain("runHermesBackup");
    expect(source).not.toMatch(/(?:include|copy).*(?:\\.env|auth\\.json)/i);
    expect(existsSync(join(__dirname, "manifest.ts"))).toBe(true);
  });
});
