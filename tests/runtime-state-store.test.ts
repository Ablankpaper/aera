import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRuntimeDistributionPaths,
  ensureRuntimeDistributionDirectories,
} from "../src/main/agentera-runtime-distribution/paths";
import {
  RuntimeStateStore,
  removeRuntimeOwnedPath,
  type CandidatePointer,
  type RuntimePointer,
} from "../src/main/agentera-runtime-distribution/state-store";

const temporaryDirectories: string[] = [];

function makeStore(
  options?: ConstructorParameters<typeof RuntimeStateStore>[1],
): {
  directory: string;
  paths: ReturnType<typeof createRuntimeDistributionPaths>;
  store: RuntimeStateStore;
} {
  const directory = mkdtempSync(join(tmpdir(), "agentera-runtime-state-"));
  temporaryDirectories.push(directory);
  const paths = createRuntimeDistributionPaths(
    join(directory, "user-data"),
    join(directory, "app-resources", "runtime-seed"),
  );
  return {
    directory,
    paths,
    store: new RuntimeStateStore(paths, options),
  };
}

function pointer(
  versionDirectory: string,
  overrides: Partial<RuntimePointer> = {},
): RuntimePointer {
  return {
    schemaVersion: 1,
    runtimeVersion: `0.18.2-${versionDirectory}`,
    sourceCommit: "f".repeat(40),
    versionDirectory,
    manifestSha256: "a".repeat(64),
    installedAt: "2026-07-18T08:00:00.000Z",
    ...overrides,
  };
}

function candidate(
  versionDirectory: string,
  overrides: Partial<CandidatePointer> = {},
): CandidatePointer {
  return {
    ...pointer(versionDirectory),
    applyOnNextLaunch: true,
    stagedAt: "2026-07-18T08:05:00.000Z",
    ...overrides,
  };
}

async function createVersion(
  paths: ReturnType<typeof createRuntimeDistributionPaths>,
  name: string,
): Promise<void> {
  await ensureRuntimeDistributionDirectories(paths);
  mkdirSync(join(paths.versions, name), { recursive: true });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("AgentEra Runtime pointer state store", () => {
  it("rejects malformed, unknown-schema, and missing-directory pointers", async () => {
    const { paths, store } = makeStore();
    await store.recover();

    writeFileSync(paths.current, "{");
    await expect(store.readState()).rejects.toThrow(/json|pointer|state/i);

    writeFileSync(
      paths.current,
      JSON.stringify({ ...pointer("v1"), schemaVersion: 2 }),
    );
    await expect(store.readState()).rejects.toThrow(/schema/i);

    writeFileSync(paths.current, JSON.stringify(pointer("missing-version")));
    await expect(store.readState()).rejects.toThrow(
      /missing|directory|version/i,
    );
  });

  it("ignores and removes an interrupted pointer temp write", async () => {
    const { paths, store } = makeStore();
    await ensureRuntimeDistributionDirectories(paths);
    writeFileSync(`${paths.current}.tmp`, JSON.stringify(pointer("v1")));

    await store.recover();

    expect(existsSync(`${paths.current}.tmp`)).toBe(false);
    await expect(store.readState()).resolves.toEqual({
      current: null,
      previous: null,
      candidate: null,
    });
  });

  it("does not follow a pre-created pointer temp symlink", async () => {
    const { directory, paths, store } = makeStore();
    await createVersion(paths, "v1");
    const outside = join(directory, "outside-pointer.txt");
    writeFileSync(outside, "keep outside");
    symlinkSync(outside, `${paths.current}.tmp`);

    await store.setCurrent(pointer("v1"));

    expect(readFileSync(outside, "utf8")).toBe("keep outside");
    expect(JSON.parse(readFileSync(paths.current, "utf8"))).toMatchObject({
      versionDirectory: "v1",
    });
  });

  it("rejects and removes a pointer symlink without changing its target", async () => {
    const { directory, paths, store } = makeStore();
    await createVersion(paths, "v1");
    const outside = join(directory, "outside-current.json");
    const outsideValue = `${JSON.stringify(pointer("v1"))}\n`;
    writeFileSync(outside, outsideValue);
    symlinkSync(outside, paths.current);

    await expect(store.readState()).rejects.toThrow(/pointer|symlink|file/i);
    await expect(store.recoverForBootstrap()).resolves.toMatchObject({
      state: { current: null },
      invalidPointers: ["current"],
    });
    expect(readFileSync(outside, "utf8")).toBe(outsideValue);
    expect(existsSync(paths.current)).toBe(false);
  });

  it("preserves a pointer when an operational read error prevents validation", async () => {
    const { paths, store } = makeStore();
    await createVersion(paths, "v1");
    await store.setCurrent(pointer("v1"));
    chmodSync(paths.current, 0o000);

    try {
      await expect(store.recoverForBootstrap()).rejects.toThrow(
        /cannot read Runtime pointer/i,
      );
      expect(existsSync(paths.current)).toBe(true);
    } finally {
      chmodSync(paths.current, 0o600);
    }
  });

  it("promotes current/previous/candidate pointers and rolls back safely", async () => {
    const { paths, store } = makeStore();
    await createVersion(paths, "v1");
    await createVersion(paths, "v2");
    const first = pointer("v1");
    const second = candidate("v2");

    await store.setCurrent(first);
    await store.stageCandidate(second);
    await expect(store.promoteCandidate()).resolves.toMatchObject({
      current: { versionDirectory: "v2" },
      previous: { versionDirectory: "v1" },
      candidate: null,
    });
    await expect(store.rollback()).resolves.toMatchObject({
      current: { versionDirectory: "v1" },
      previous: { versionDirectory: "v2" },
      candidate: null,
    });
    expect(existsSync(`${paths.current}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(paths.current, "utf8"))).toMatchObject({
      schemaVersion: 1,
      versionDirectory: "v1",
    });
  });

  it("retains every referenced version and deletes only unreferenced children", async () => {
    const { directory, paths, store } = makeStore();
    for (const name of ["v1", "v2", "v3", "unreferenced"]) {
      await createVersion(paths, name);
    }
    await store.setCurrent(pointer("v1"));
    await store.stageCandidate(candidate("v2"));
    await store.promoteCandidate();
    await store.stageCandidate(candidate("v3"));
    const hermesHome = join(directory, "hermes-home");
    mkdirSync(hermesHome);
    writeFileSync(join(hermesHome, "MEMORY.md"), "private adaptive state");

    await expect(store.cleanupUnreferencedVersions()).resolves.toEqual([
      "unreferenced",
    ]);

    for (const name of ["v1", "v2", "v3"]) {
      expect(existsSync(join(paths.versions, name))).toBe(true);
    }
    expect(existsSync(join(paths.versions, "unreferenced"))).toBe(false);
    expect(readFileSync(join(hermesHome, "MEMORY.md"), "utf8")).toBe(
      "private adaptive state",
    );
  });

  it("rejects cleanup outside Runtime root", async () => {
    const { directory, paths, store } = makeStore();
    await store.recover();
    const outside = join(directory, "outside.txt");
    writeFileSync(outside, "keep");

    await expect(removeRuntimeOwnedPath(paths.root, outside)).rejects.toThrow(
      /outside|contained|root/i,
    );
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });

  it("rejects cleanup through a parent symlink without touching its target", async () => {
    const { directory, paths, store } = makeStore();
    await store.recover();
    const outside = join(directory, "outside-directory");
    mkdirSync(outside);
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "keep");
    rmSync(paths.staging, { recursive: true });
    symlinkSync(outside, paths.staging, "dir");

    await expect(
      removeRuntimeOwnedPath(paths.root, join(paths.staging, "sentinel.txt")),
    ).rejects.toThrow(/outside|contained|root/i);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("removes only stale Runtime transaction entries during recovery", async () => {
    const now = new Date("2026-07-18T10:00:00.000Z");
    const { paths, store } = makeStore({
      now: () => now,
      staleTransactionAgeMs: 60_000,
    });
    await ensureRuntimeDistributionDirectories(paths);
    const staleStaging = join(paths.staging, "transaction-stale");
    const staleDownload = join(paths.downloads, "runtime-download.tmp");
    const freshStaging = join(paths.staging, "transaction-fresh");
    const resumablePart = join(paths.downloads, "runtime.part");
    mkdirSync(staleStaging);
    writeFileSync(staleDownload, "stale");
    mkdirSync(freshStaging);
    writeFileSync(resumablePart, "keep for resume");
    const old = new Date(now.getTime() - 120_000);
    utimesSync(staleStaging, old, old);
    utimesSync(staleDownload, old, old);

    await store.recover();

    expect(existsSync(staleStaging)).toBe(false);
    expect(existsSync(staleDownload)).toBe(false);
    expect(existsSync(freshStaging)).toBe(true);
    expect(readFileSync(resumablePart, "utf8")).toBe("keep for resume");
  });
});
