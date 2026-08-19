import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMacUpdateHelperScript,
  buildWindowsUpdateHelperScript,
  classifyDesktopUpdateDownloadError,
  compareInternalBetaVersions,
  createDesktopUpdateFailureSnapshot,
  extractDesktopUpdateZip,
  InternalBetaDesktopUpdater,
  resolveCurrentMacAppPath,
  validateWindowsInstallPreflight,
  validatePackagedMacRuntimeEntries,
  validatePackagedWindowsRuntimeEntries,
  verifyDesktopUpdateMetadata,
  tryCreateInternalBetaDesktopUpdater,
  type ArtifactDownloadRequest,
  type DesktopUpdateManifest,
  type DesktopUpdateOffer,
  type MetadataTransport,
} from "../src/main/app/internal-beta-updater";
import { canonicalJsonBytes } from "../src/main/agentera-runtime-distribution/manifest";
import {
  RuntimeDownloadCancelledError,
  RuntimeDownloadError,
  RuntimeDownloadIntegrityError,
} from "../src/main/agentera-runtime-distribution/downloader";

const BASE_URL = new URL(
  "https://updates.example.test/desktop-updates/internal-beta",
);
const CURRENT_VERSION = "0.7.4-internal-beta.16";
const NEXT_VERSION = "0.7.4-internal-beta.17";
const KEY_ID = "desktop-update-test";
const createdDirectories: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function digest(bytes: Buffer): {
  size: number;
  sha256: string;
  sha512: string;
} {
  return {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("base64"),
  };
}

function signedRelease(options?: { windowsKind?: "app_zip" | "nsis" }): {
  manifestBytes: Buffer;
  signatureBytes: Buffer;
  publicKeyPem: string;
  macBytes: Buffer;
  windowsBytes: Buffer;
} {
  const macBytes = Buffer.from("signed mac archive");
  const windowsKind = options?.windowsKind ?? "app_zip";
  const windowsName =
    windowsKind === "app_zip"
      ? `Aera-Internal-Beta-${NEXT_VERSION}-windows-x64-app.zip`
      : `Aera-Internal-Beta-${NEXT_VERSION}-windows-x64-setup.exe`;
  const windowsBytes = Buffer.from("signed windows app archive");
  const macDigest = digest(macBytes);
  const windowsDigest = digest(windowsBytes);
  const manifest: DesktopUpdateManifest = {
    schema_version: 1,
    key_id: KEY_ID,
    channel: "internal-beta",
    version: NEXT_VERSION,
    published_at: "2026-07-29T12:00:00Z",
    release_notes: "在线更新闭环测试版本",
    artifacts: [
      {
        platform: "darwin",
        arch: "arm64",
        kind: "zip",
        name: `Aera-Internal-Beta-${NEXT_VERSION}-macos-arm64.zip`,
        ...macDigest,
        url: `${BASE_URL.href}/releases/${NEXT_VERSION}/Aera-Internal-Beta-${NEXT_VERSION}-macos-arm64.zip`,
      },
      {
        platform: "win32",
        arch: "x64",
        kind: windowsKind,
        name: windowsName,
        ...windowsDigest,
        url: `${BASE_URL.href}/releases/${NEXT_VERSION}/${windowsName}`,
      },
    ],
  };
  const manifestBytes = canonicalJsonBytes(manifest);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signature = signBytes(null, manifestBytes, privateKey);
  const signatureBytes = canonicalJsonBytes({
    schema_version: 1,
    key_id: KEY_ID,
    algorithm: "Ed25519",
    signature_base64: signature.toString("base64"),
  });
  return {
    manifestBytes,
    signatureBytes,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    macBytes,
    windowsBytes,
  };
}

function transportFor(
  manifestBytes: Buffer,
  signatureBytes: Buffer,
): MetadataTransport {
  return {
    get: vi.fn(async (url: URL) => {
      if (
        url.href ===
        "https://updates.example.test/desktop-updates/internal-beta/manifest.json"
      ) {
        return manifestBytes;
      }
      if (
        url.href ===
        "https://updates.example.test/desktop-updates/internal-beta/manifest.sig"
      ) {
        return signatureBytes;
      }
      throw new Error(`Unexpected metadata URL: ${url.href}`);
    }),
  };
}

async function createUserData(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aera-desktop-update-"));
  createdDirectories.push(directory);
  return directory;
}

function createUpdater(options: {
  userDataPath: string;
  release: ReturnType<typeof signedRelease>;
  transport?: MetadataTransport;
  onInstall?: () => void;
  onState?: (snapshot: unknown) => void;
  prepareArtifact?: (
    offer: DesktopUpdateOffer,
    artifactPath: string,
    stagingDirectory: string,
  ) => Promise<void>;
}): InternalBetaDesktopUpdater {
  return new InternalBetaDesktopUpdater({
    currentVersion: CURRENT_VERSION,
    platform: "win32",
    arch: "x64",
    userDataPath: options.userDataPath,
    currentAppPath: null,
    baseUrl: BASE_URL,
    trustedPublicKeys: new Map([[KEY_ID, options.release.publicKeyPem]]),
    autoDownload: false,
    onState: options.onState ?? vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    metadataTransport:
      options.transport ??
      transportFor(
        options.release.manifestBytes,
        options.release.signatureBytes,
      ),
    downloadArtifact: async (request: ArtifactDownloadRequest) => {
      await writeFile(request.destination, options.release.windowsBytes);
      request.onProgress(
        options.release.windowsBytes.length,
        options.release.windowsBytes.length,
      );
    },
    prepareArtifact: options.prepareArtifact ?? (async () => {}),
    installArtifact: async () => {
      options.onInstall?.();
    },
  });
}

describe("Internal Beta desktop updater", () => {
  // @lat: [[desktop-updates#Internal Beta signed update channel]]
  it("fails closed when packaged update configuration is invalid", () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    expect(
      tryCreateInternalBetaDesktopUpdater({
        currentVersion: CURRENT_VERSION,
        platform: "win32",
        arch: "x64",
        userDataPath: "/unused",
        currentAppPath: null,
        baseUrl: new URL("http://127.0.0.1:8086/desktop-updates/internal-beta"),
        trustedPublicKeys: new Map(),
        autoDownload: false,
        onState: vi.fn(),
        log,
      }),
    ).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Internal Beta updater configuration is unavailable",
      ),
    );
  });

  it("classifies a missing Cloud origin without exposing the source error", () => {
    const snapshot = createDesktopUpdateFailureSnapshot({
      error: new Error(
        "Aera cloud origin is not configured at /Users/private/profile",
      ),
      fallbackCode: "update_origin_unavailable",
      fallbackStage: "metadata",
      version: null,
      releaseNotes: null,
    });

    expect(snapshot).toMatchObject({
      state: "error",
      errorCode: "update_origin_unavailable",
      stage: "metadata",
      error: "更新服务不可用：云端地址未配置。",
      diagnosticId: expect.stringMatching(/^[0-9a-f]{12}$/u),
    });
    expect(snapshot.error).not.toContain("/Users/private");
  });

  it("checks, verifies, downloads, restores, and installs a signed release", async () => {
    const userDataPath = await createUserData();
    const release = signedRelease();
    const updater = createUpdater({ userDataPath, release });

    await updater.initialize();
    await expect(updater.check()).resolves.toBe(NEXT_VERSION);
    expect(updater.getSnapshot()).toMatchObject({
      state: "available",
      version: NEXT_VERSION,
      releaseNotes: "在线更新闭环测试版本",
    });

    await expect(updater.download()).resolves.toBe(true);
    expect(updater.getSnapshot()).toMatchObject({
      state: "ready",
      version: NEXT_VERSION,
    });

    const onInstall = vi.fn();
    const restarted = createUpdater({ userDataPath, release, onInstall });
    await restarted.initialize();
    expect(restarted.getSnapshot()).toMatchObject({
      state: "ready",
      version: NEXT_VERSION,
    });
    await restarted.install();
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it("re-extracts and revalidates the signed archive when restoring a pending update", async () => {
    const userDataPath = await createUserData();
    const release = signedRelease();
    const prepareArtifact = vi.fn(async () => {});
    const updater = createUpdater({
      userDataPath,
      release,
      prepareArtifact,
    });

    await updater.initialize();
    await updater.check();
    await updater.download();
    expect(prepareArtifact).toHaveBeenCalledOnce();

    const restarted = createUpdater({
      userDataPath,
      release,
      prepareArtifact,
    });
    await restarted.initialize();

    expect(prepareArtifact).toHaveBeenCalledTimes(2);
    expect(restarted.getSnapshot()).toMatchObject({
      state: "ready",
      version: NEXT_VERSION,
    });
  });

  it("rejects an NSIS installer as the Windows online-update payload", () => {
    const release = signedRelease({ windowsKind: "nsis" });

    expect(() =>
      verifyDesktopUpdateMetadata({
        manifestBytes: release.manifestBytes,
        signatureBytes: release.signatureBytes,
        baseUrl: BASE_URL,
        trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
      }),
    ).toThrow(/target|app_zip|payload/iu);
  });

  it("emits the V2 stage sequence for metadata, download, and staging", async () => {
    const userDataPath = await createUserData();
    const release = signedRelease();
    const snapshots: Array<{
      stageEvent?: { stage: string; state: string } | null;
    }> = [];
    const updater = createUpdater({
      userDataPath,
      release,
      onState: (snapshot) => snapshots.push(snapshot as never),
    });

    await updater.initialize();
    await updater.check();
    await updater.download();

    const events = snapshots
      .map((snapshot) => snapshot.stageEvent)
      .filter((event): event is { stage: string; state: string } =>
        Boolean(event),
      );
    const stageStates = events.map(({ stage, state }) => ({ stage, state }));
    expect(stageStates).toEqual(
      expect.arrayContaining([
        { stage: "metadata", state: "started" },
        { stage: "metadata", state: "succeeded" },
        { stage: "verify", state: "succeeded" },
        { stage: "download", state: "started" },
        { stage: "download", state: "succeeded" },
        { stage: "extract", state: "started" },
        { stage: "stage", state: "succeeded" },
      ]),
    );
  });

  it("rejects metadata changed after signing", async () => {
    const userDataPath = await createUserData();
    const release = signedRelease();
    const changed = Buffer.from(
      release.manifestBytes
        .toString("utf8")
        .replace("在线更新闭环测试版本", "被篡改的更新说明"),
      "utf8",
    );
    const updater = createUpdater({
      userDataPath,
      release,
      transport: transportFor(changed, release.signatureBytes),
    });

    await updater.initialize();
    await expect(updater.check()).resolves.toBeNull();
    expect(updater.getSnapshot()).toMatchObject({
      state: "error",
      version: null,
      error: "更新签名校验失败。",
      errorCode: "update_signature_invalid",
      stage: "verify",
      diagnosticId: expect.stringMatching(/^[0-9a-f]{12}$/u),
    });
    expect(updater.getSnapshot().error).not.toContain("被篡改");
  });

  it("classifies an integrity failure separately from metadata errors", async () => {
    const userDataPath = await createUserData();
    const release = signedRelease();
    const updater = createUpdater({ userDataPath, release });

    await updater.initialize();
    await expect(updater.check()).resolves.toBe(NEXT_VERSION);
    const artifactError = new Error("/Users/private/downloads/secret.zip");
    const failing = new InternalBetaDesktopUpdater({
      currentVersion: CURRENT_VERSION,
      platform: "win32",
      arch: "x64",
      userDataPath,
      currentAppPath: null,
      baseUrl: BASE_URL,
      trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
      autoDownload: false,
      onState: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metadataTransport: transportFor(
        release.manifestBytes,
        release.signatureBytes,
      ),
      downloadArtifact: async () => {
        throw artifactError;
      },
      prepareArtifact: async () => {},
      installArtifact: async () => {},
    });
    await failing.initialize();
    await expect(failing.check()).resolves.toBe(NEXT_VERSION);
    await expect(failing.download()).resolves.toBe(false);
    expect(failing.getSnapshot()).toMatchObject({
      state: "error",
      errorCode: "update_artifact_unavailable",
      stage: "download",
      diagnosticId: expect.stringMatching(/^[0-9a-f]{12}$/u),
    });
    expect(failing.getSnapshot().error).not.toContain("/Users/private");
  });

  it("maps downloader failures to the stable update contract", () => {
    expect(
      classifyDesktopUpdateDownloadError(
        new RuntimeDownloadIntegrityError("download size differs"),
      ),
    ).toMatchObject({ code: "update_artifact_size_mismatch", stage: "verify" });
    expect(
      classifyDesktopUpdateDownloadError(
        new RuntimeDownloadIntegrityError("download SHA-256 differs"),
      ),
    ).toMatchObject({ code: "update_artifact_hash_mismatch", stage: "verify" });
    expect(
      classifyDesktopUpdateDownloadError(
        new RuntimeDownloadError("redirect target is not allowed"),
      ),
    ).toMatchObject({ code: "update_redirect_rejected", stage: "download" });
    expect(
      classifyDesktopUpdateDownloadError(new RuntimeDownloadCancelledError()),
    ).toMatchObject({ code: "update_cancelled", stage: "download" });
  });

  it("rejects a staged macOS app missing a startup surface", () => {
    expect(() =>
      validatePackagedMacRuntimeEntries(
        ["out/main/index.js", "out/renderer/index.html"],
        [],
      ),
    ).toThrow(/preload|native/u);
    expect(() =>
      validatePackagedMacRuntimeEntries(
        [
          "out/main/index.js",
          "out/preload/index.js",
          "out/renderer/index.html",
        ],
        ["node_modules/better-sqlite3/build/Release/better_sqlite3.node"],
      ),
    ).not.toThrow();
  });

  it("accepts only a complete x64 Windows app directory with matching native ABI", () => {
    const executable = Buffer.alloc(512);
    executable.writeUInt16LE(0x5a4d, 0);
    executable.writeUInt32LE(0x80, 0x3c);
    executable.writeUInt32LE(0x00004550, 0x80);
    executable.writeUInt16LE(0x8664, 0x84);
    const native = Buffer.concat([
      executable,
      Buffer.from("node_register_module_v145\0", "ascii"),
    ]);
    const input = {
      asarEntries: [
        "out/main/index.js",
        "out/preload/index.js",
        "out/renderer/index.html",
        "package.json",
      ],
      executableBytes: executable,
      packageDocument: {
        name: "agentera-studio",
        version: NEXT_VERSION,
      },
      nativeModules: [
        {
          path: "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
          bytes: native,
        },
      ],
      expectedVersion: NEXT_VERSION,
      expectedElectronAbi: "145",
    } as const;

    expect(() => validatePackagedWindowsRuntimeEntries(input)).not.toThrow();
    expect(() =>
      validatePackagedWindowsRuntimeEntries({
        ...input,
        packageDocument: { ...input.packageDocument, version: CURRENT_VERSION },
      }),
    ).toThrow(/version|identity/iu);
    expect(() =>
      validatePackagedWindowsRuntimeEntries({
        ...input,
        expectedElectronAbi: "146",
      }),
    ).toThrow(/ABI|native/iu);
  });

  it("returns a stable code when install is requested before download", async () => {
    const userDataPath = await createUserData();
    const release = signedRelease();
    const updater = createUpdater({ userDataPath, release });

    await expect(updater.install()).rejects.toMatchObject({
      code: "update_client_bridge_required",
      stage: "stage",
    });
  });

  it.skipIf(process.platform === "win32")(
    "cleans macOS install attempt markers when the helper cannot start",
    async () => {
      const userDataPath = await createUserData();
      const release = signedRelease();
      const currentAppPath = join(userDataPath, "Aera.app");
      await mkdir(currentAppPath);
      const updater = new InternalBetaDesktopUpdater({
        currentVersion: CURRENT_VERSION,
        platform: "darwin",
        arch: "arm64",
        userDataPath,
        currentAppPath,
        baseUrl: BASE_URL,
        trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
        autoDownload: false,
        onState: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        metadataTransport: transportFor(
          release.manifestBytes,
          release.signatureBytes,
        ),
        downloadArtifact: async (request) => {
          await writeFile(request.destination, release.macBytes);
        },
        prepareArtifact: async (_offer, _artifactPath, stagingDirectory) => {
          await mkdir(join(stagingDirectory, "Aera.app"), { recursive: true });
        },
        spawnDetachedProcess: async () => {
          throw new Error("synthetic spawn failure");
        },
      });
      await updater.initialize();
      await expect(updater.check()).resolves.toBe(NEXT_VERSION);
      await expect(updater.download()).resolves.toBe(true);

      await expect(updater.install()).rejects.toMatchObject({
        code: "update_swap_failed",
        stage: "swap",
      });
      const root = join(userDataPath, "desktop-updates");
      const marker = join(
        root,
        `install-success-${NEXT_VERSION}-${process.pid}`,
      );
      await expect(
        access(join(root, "install-journal.json")),
      ).rejects.toThrow();
      await expect(
        access(join(root, "install-failure.json")),
      ).rejects.toThrow();
      await expect(access(marker)).rejects.toThrow();
      await expect(access(join(root, "pending.json"))).resolves.toBeUndefined();
      await expect(
        access(join(root, "staging", NEXT_VERSION, "Aera.app")),
      ).resolves.toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "persists a hash-bound V2 install journal before the macOS helper starts",
    async () => {
      const userDataPath = await createUserData();
      const release = signedRelease();
      const currentAppPath = join(userDataPath, "Aera.app");
      await mkdir(currentAppPath);
      const spawnDetachedProcess = vi.fn(async () => {});
      const updater = new InternalBetaDesktopUpdater({
        currentVersion: CURRENT_VERSION,
        platform: "darwin",
        arch: "arm64",
        userDataPath,
        currentAppPath,
        baseUrl: BASE_URL,
        trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
        autoDownload: false,
        onState: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        metadataTransport: transportFor(
          release.manifestBytes,
          release.signatureBytes,
        ),
        downloadArtifact: async (request) => {
          await writeFile(request.destination, release.macBytes);
        },
        prepareArtifact: async (_offer, _artifactPath, stagingDirectory) => {
          await mkdir(join(stagingDirectory, "Aera.app"), { recursive: true });
        },
        spawnDetachedProcess,
      });
      await updater.initialize();
      await updater.check();
      await updater.download();
      await updater.install();

      const root = join(userDataPath, "desktop-updates");
      const journal = JSON.parse(
        await readFile(join(root, "install-journal.json"), "utf8"),
      ) as Record<string, unknown>;
      const macArtifact = JSON.parse(release.manifestBytes.toString("utf8"))
        .artifacts[0] as Record<string, unknown>;
      expect(journal).toEqual({
        schema_version: 2,
        operation_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
        platform: "darwin",
        source_version: CURRENT_VERSION,
        target_version: NEXT_VERSION,
        artifact_name: macArtifact.name,
        artifact_size: macArtifact.size,
        artifact_sha256: macArtifact.sha256,
        artifact_sha512: macArtifact.sha512,
        current_app_path: currentAppPath,
        staged_app_path: join(root, "staging", NEXT_VERSION, "Aera.app"),
        backup_path: `${currentAppPath}.aera-update-backup-${process.pid}`,
        success_marker: join(
          root,
          `install-success-${NEXT_VERSION}-${process.pid}`,
        ),
        failure_marker: join(root, "install-failure.json"),
        state: "waiting_for_exit",
        rollback_state: "not_started",
        updated_at: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u,
        ),
      });
      expect(spawnDetachedProcess).toHaveBeenCalledOnce();
    },
  );

  it("reports a rolled-back stage after a helper health failure", async () => {
    const userDataPath = await createUserData();
    const release = signedRelease();
    const root = join(userDataPath, "desktop-updates");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "install-failure.json"),
      '{"code":"update_health_timeout","schema_version":1,"target_version":"0.7.4-internal-beta.17"}',
    );
    const snapshots: Array<{
      stageEvent?: { stage: string; state: string } | null;
    }> = [];
    const updater = new InternalBetaDesktopUpdater({
      currentVersion: CURRENT_VERSION,
      platform: "win32",
      arch: "x64",
      userDataPath,
      currentAppPath: null,
      baseUrl: BASE_URL,
      trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
      autoDownload: false,
      onState: (snapshot) => snapshots.push(snapshot as never),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metadataTransport: transportFor(
        release.manifestBytes,
        release.signatureBytes,
      ),
      prepareArtifact: async () => {},
      installArtifact: async () => {},
    });
    await updater.initialize();
    const events = snapshots
      .map((snapshot) => snapshot.stageEvent)
      .filter((event): event is { stage: string; state: string } =>
        Boolean(event),
      )
      .map(({ stage, state }) => ({ stage, state }));
    expect(events).toEqual(
      expect.arrayContaining([
        { stage: "health", state: "failed" },
        { stage: "rollback", state: "rolled_back" },
      ]),
    );
  });

  it("does not report rollback when the helper says restoration failed", async () => {
    const userDataPath = await createUserData();
    const release = signedRelease();
    const root = join(userDataPath, "desktop-updates");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "install-failure.json"),
      `{"code":"update_rollback_failed","schema_version":2,"state":"failed","target_version":"${NEXT_VERSION}"}`,
    );
    const snapshots: Array<{
      stageEvent?: { stage: string; state: string } | null;
    }> = [];
    const updater = new InternalBetaDesktopUpdater({
      currentVersion: CURRENT_VERSION,
      platform: "win32",
      arch: "x64",
      userDataPath,
      currentAppPath: null,
      baseUrl: BASE_URL,
      trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
      autoDownload: false,
      onState: (snapshot) => snapshots.push(snapshot),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metadataTransport: transportFor(
        release.manifestBytes,
        release.signatureBytes,
      ),
      prepareArtifact: async () => {},
      installArtifact: async () => {},
    });
    await updater.initialize();
    const events = snapshots
      .map((snapshot) => snapshot.stageEvent)
      .filter((event): event is { stage: string; state: string } =>
        Boolean(event),
      );
    expect(events).toContainEqual({
      code: "update_rollback_failed",
      diagnosticId: expect.any(String),
      operationId: expect.any(String),
      retryability: "not_retryable",
      schemaVersion: 2,
      stage: "rollback",
      state: "failed",
      targetVersion: NEXT_VERSION,
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ state: "rolled_back" }),
    );
  });

  it("does not mark an install healthy until the renderer is ready", async () => {
    const userDataPath = await createUserData();
    const release = signedRelease();
    const root = join(userDataPath, "desktop-updates");
    const marker = join(root, "health-marker");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "install-journal.json"),
      JSON.stringify({
        backup_path: join(root, "backup"),
        current_app_path: "/Applications/Aera.app",
        schema_version: 1,
        success_marker: marker,
        target_version: CURRENT_VERSION,
      }),
    );
    const updater = new InternalBetaDesktopUpdater({
      currentVersion: CURRENT_VERSION,
      platform: "win32",
      arch: "x64",
      userDataPath,
      currentAppPath: null,
      baseUrl: BASE_URL,
      trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
      autoDownload: false,
      onState: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metadataTransport: transportFor(
        release.manifestBytes,
        release.signatureBytes,
      ),
      prepareArtifact: async () => {},
      installArtifact: async () => {},
    });
    await updater.initialize();
    await expect(access(marker)).rejects.toThrow();
    await updater.markRendererReady();
    await expect(access(marker)).resolves.toBeUndefined();
  });

  it("marks health and finalize after the new process acknowledges startup", async () => {
    const userDataPath = await createUserData();
    const release = signedRelease();
    const root = join(userDataPath, "desktop-updates");
    const marker = join(root, "health-marker");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "install-journal.json"),
      JSON.stringify({
        backup_path: join(root, "backup"),
        current_app_path: "/Applications/Aera.app",
        schema_version: 1,
        success_marker: marker,
        target_version: CURRENT_VERSION,
      }),
    );
    const snapshots: Array<{
      stageEvent?: { stage: string; state: string } | null;
    }> = [];
    const updater = new InternalBetaDesktopUpdater({
      currentVersion: CURRENT_VERSION,
      platform: "win32",
      arch: "x64",
      userDataPath,
      currentAppPath: null,
      baseUrl: BASE_URL,
      trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
      autoDownload: false,
      onState: (snapshot) => snapshots.push(snapshot as never),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      metadataTransport: transportFor(
        release.manifestBytes,
        release.signatureBytes,
      ),
      prepareArtifact: async () => {},
      installArtifact: async () => {},
    });
    await updater.initialize();
    await updater.markRendererReady();
    const events = snapshots
      .map((snapshot) => snapshot.stageEvent)
      .filter((event): event is { stage: string; state: string } =>
        Boolean(event),
      )
      .map(({ stage, state }) => ({ stage, state }));
    expect(events).toEqual(
      expect.arrayContaining([
        { stage: "health", state: "succeeded" },
        { stage: "finalize", state: "succeeded" },
      ]),
    );
  });

  it.skipIf(process.platform === "win32")(
    "reads a V2 install journal and acknowledges only the matching target version",
    async () => {
      const userDataPath = await createUserData();
      const release = signedRelease();
      const root = join(userDataPath, "desktop-updates");
      const marker = join(root, "health-marker-v2");
      await mkdir(root, { recursive: true });
      const artifact = JSON.parse(release.manifestBytes.toString("utf8"))
        .artifacts[0] as Record<string, unknown>;
      await writeFile(
        join(root, "install-journal.json"),
        JSON.stringify({
          schema_version: 2,
          operation_id: "12345678-1234-4234-9234-123456789abc",
          platform: "darwin",
          source_version: "0.7.4-internal-beta.15",
          target_version: CURRENT_VERSION,
          artifact_name: `Aera-Internal-Beta-${CURRENT_VERSION}-macos-arm64.zip`,
          artifact_size: artifact.size,
          artifact_sha256: artifact.sha256,
          artifact_sha512: artifact.sha512,
          current_app_path: "/Applications/Aera.app",
          staged_app_path: join(root, "staging", CURRENT_VERSION, "Aera.app"),
          backup_path: "/Applications/Aera.app.aera-update-backup-1",
          success_marker: marker,
          failure_marker: join(root, "install-failure.json"),
          state: "launched",
          rollback_state: "not_started",
          updated_at: "2026-08-18T07:00:00Z",
        }),
      );
      const updater = new InternalBetaDesktopUpdater({
        currentVersion: CURRENT_VERSION,
        platform: "darwin",
        arch: "arm64",
        userDataPath,
        currentAppPath: "/Applications/Aera.app",
        baseUrl: BASE_URL,
        trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
        autoDownload: false,
        onState: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        metadataTransport: transportFor(
          release.manifestBytes,
          release.signatureBytes,
        ),
        prepareArtifact: async () => {},
        installArtifact: async () => {},
      });

      await updater.initialize();
      await expect(access(marker)).rejects.toThrow();
      await updater.markRendererReady();
      await expect(readFile(marker, "utf8")).resolves.toBe(
        `${CURRENT_VERSION}\n`,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a renderer health handshake for a journal bound to another artifact",
    async () => {
      const userDataPath = await createUserData();
      const release = signedRelease();
      const root = join(userDataPath, "desktop-updates");
      const marker = join(root, "health-marker-invalid-binding");
      await mkdir(root, { recursive: true });
      const artifact = JSON.parse(release.manifestBytes.toString("utf8"))
        .artifacts[0] as Record<string, unknown>;
      await writeFile(
        join(root, "install-journal.json"),
        JSON.stringify({
          schema_version: 2,
          operation_id: "13345678-1234-4234-9234-123456789abc",
          platform: "darwin",
          source_version: "0.7.4-internal-beta.15",
          target_version: CURRENT_VERSION,
          artifact_name: artifact.name,
          artifact_size: artifact.size,
          artifact_sha256: artifact.sha256,
          artifact_sha512: artifact.sha512,
          current_app_path: "/Applications/Aera.app",
          staged_app_path: join(root, "staging", CURRENT_VERSION, "Aera.app"),
          backup_path: "/Applications/Aera.app.aera-update-backup-2",
          success_marker: marker,
          failure_marker: join(root, "install-failure.json"),
          state: "launched",
          rollback_state: "not_started",
          updated_at: "2026-08-18T07:00:00Z",
        }),
      );
      const updater = new InternalBetaDesktopUpdater({
        currentVersion: CURRENT_VERSION,
        platform: "darwin",
        arch: "arm64",
        userDataPath,
        currentAppPath: "/Applications/Aera.app",
        baseUrl: BASE_URL,
        trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
        autoDownload: false,
        onState: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        metadataTransport: transportFor(
          release.manifestBytes,
          release.signatureBytes,
        ),
        prepareArtifact: async () => {},
        installArtifact: async () => {},
      });

      await updater.initialize();
      await expect(updater.markRendererReady()).rejects.toThrow(
        /journal artifact differs/u,
      );
      await expect(access(marker)).rejects.toThrow();
    },
  );

  it.skipIf(process.platform === "win32")(
    "finalizes a healthy journal left behind after the helper exits",
    async () => {
      const userDataPath = await createUserData();
      const release = signedRelease();
      const root = join(userDataPath, "desktop-updates");
      const current = join(userDataPath, "Applications", "Aera.app");
      const backup = `${current}.aera-update-backup-3`;
      const staged = join(root, "staging", CURRENT_VERSION, "Aera.app");
      const marker = join(root, "health-marker-orphaned");
      await Promise.all([
        mkdir(current, { recursive: true }),
        mkdir(backup, { recursive: true }),
        mkdir(staged, { recursive: true }),
        mkdir(root, { recursive: true }),
      ]);
      const artifact = JSON.parse(release.manifestBytes.toString("utf8"))
        .artifacts[0] as Record<string, unknown>;
      await writeFile(
        join(root, "install-journal.json"),
        canonicalJsonBytes({
          schema_version: 2,
          operation_id: "14345678-1234-4234-9234-123456789abc",
          platform: "darwin",
          source_version: "0.7.4-internal-beta.15",
          target_version: CURRENT_VERSION,
          artifact_name: `Aera-Internal-Beta-${CURRENT_VERSION}-macos-arm64.zip`,
          artifact_size: artifact.size,
          artifact_sha256: artifact.sha256,
          artifact_sha512: artifact.sha512,
          current_app_path: current,
          staged_app_path: staged,
          backup_path: backup,
          success_marker: marker,
          failure_marker: join(root, "install-failure.json"),
          state: "healthy",
          rollback_state: "succeeded",
          updated_at: "2026-08-18T07:00:00Z",
        }),
      );
      const updater = new InternalBetaDesktopUpdater({
        currentVersion: CURRENT_VERSION,
        platform: "darwin",
        arch: "arm64",
        userDataPath,
        currentAppPath: current,
        baseUrl: BASE_URL,
        trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
        autoDownload: false,
        onState: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        metadataTransport: transportFor(
          release.manifestBytes,
          release.signatureBytes,
        ),
        prepareArtifact: async () => {},
        installArtifact: async () => {},
      });

      await updater.initialize();
      await updater.markRendererReady();
      await expect(access(backup)).rejects.toThrow();
      await expect(
        access(join(root, "install-journal.json")),
      ).rejects.toThrow();
      await expect(access(marker)).rejects.toThrow();
    },
  );

  it.skipIf(process.platform === "win32")(
    "restores the previous app after a crash at backup_created",
    async () => {
      const userDataPath = await createUserData();
      const release = signedRelease();
      const root = join(userDataPath, "desktop-updates");
      const current = join(userDataPath, "Applications", "Aera.app");
      const backup = `${current}.aera-update-backup-777`;
      const staged = join(root, "staging", NEXT_VERSION, "Aera.app");
      await Promise.all([
        mkdir(backup, { recursive: true }),
        mkdir(staged, { recursive: true }),
        mkdir(root, { recursive: true }),
      ]);
      await writeFile(join(backup, "version"), "old");
      const artifact = JSON.parse(release.manifestBytes.toString("utf8"))
        .artifacts[0] as Record<string, unknown>;
      await writeFile(
        join(root, "install-journal.json"),
        canonicalJsonBytes({
          schema_version: 2,
          operation_id: "12345678-1234-4234-9234-123456789abc",
          platform: "darwin",
          source_version: CURRENT_VERSION,
          target_version: NEXT_VERSION,
          artifact_name: artifact.name,
          artifact_size: artifact.size,
          artifact_sha256: artifact.sha256,
          artifact_sha512: artifact.sha512,
          current_app_path: current,
          staged_app_path: staged,
          backup_path: backup,
          success_marker: join(root, "health-marker-recovery"),
          failure_marker: join(root, "install-failure.json"),
          state: "backup_created",
          rollback_state: "started",
          updated_at: "2026-08-18T07:00:00Z",
        }),
      );
      const updater = new InternalBetaDesktopUpdater({
        currentVersion: CURRENT_VERSION,
        platform: "darwin",
        arch: "arm64",
        userDataPath,
        currentAppPath: current,
        baseUrl: BASE_URL,
        trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
        autoDownload: false,
        onState: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        metadataTransport: transportFor(
          release.manifestBytes,
          release.signatureBytes,
        ),
        prepareArtifact: async () => {},
        installArtifact: async () => {},
      });

      await updater.initialize();
      await expect(readFile(join(current, "version"), "utf8")).resolves.toBe(
        "old",
      );
      await expect(access(backup)).rejects.toThrow();
      await expect(
        access(join(root, "install-journal.json")),
      ).rejects.toThrow();
      expect(updater.getSnapshot()).toMatchObject({
        state: "error",
        errorCode: "update_swap_failed",
        stage: "rollback",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a rollback_failed journal and reports recovery_required without touching app paths",
    async () => {
      const userDataPath = await createUserData();
      const release = signedRelease();
      const root = join(userDataPath, "desktop-updates");
      const current = join(userDataPath, "Applications", "Aera.app");
      const backup = `${current}.aera-update-backup-778`;
      const staged = join(root, "staging", NEXT_VERSION, "Aera.app");
      await Promise.all([
        mkdir(current, { recursive: true }),
        mkdir(staged, { recursive: true }),
        mkdir(root, { recursive: true }),
      ]);
      await writeFile(join(current, "version"), "unknown-current");
      const artifact = JSON.parse(release.manifestBytes.toString("utf8"))
        .artifacts[0] as Record<string, unknown>;
      const journalPath = join(root, "install-journal.json");
      await writeFile(
        journalPath,
        canonicalJsonBytes({
          schema_version: 2,
          operation_id: "22345678-1234-4234-9234-123456789abc",
          platform: "darwin",
          source_version: CURRENT_VERSION,
          target_version: NEXT_VERSION,
          artifact_name: artifact.name,
          artifact_size: artifact.size,
          artifact_sha256: artifact.sha256,
          artifact_sha512: artifact.sha512,
          current_app_path: current,
          staged_app_path: staged,
          backup_path: backup,
          success_marker: join(root, "health-marker-failed"),
          failure_marker: join(root, "install-failure.json"),
          state: "rollback_failed",
          rollback_state: "failed",
          updated_at: "2026-08-18T07:00:00Z",
        }),
      );
      const updater = new InternalBetaDesktopUpdater({
        currentVersion: CURRENT_VERSION,
        platform: "darwin",
        arch: "arm64",
        userDataPath,
        currentAppPath: current,
        baseUrl: BASE_URL,
        trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
        autoDownload: false,
        onState: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        metadataTransport: transportFor(
          release.manifestBytes,
          release.signatureBytes,
        ),
        prepareArtifact: async () => {},
        installArtifact: async () => {},
      });

      await updater.initialize();
      await expect(access(journalPath)).resolves.toBeUndefined();
      await expect(readFile(join(current, "version"), "utf8")).resolves.toBe(
        "unknown-current",
      );
      expect(updater.getSnapshot()).toMatchObject({
        state: "error",
        errorCode: "update_rollback_failed",
        stage: "rollback",
      });
    },
  );

  it("orders Internal Beta versions", () => {
    expect(compareInternalBetaVersions(CURRENT_VERSION, NEXT_VERSION)).toBe(-1);
    expect(compareInternalBetaVersions(NEXT_VERSION, CURRENT_VERSION)).toBe(1);
    expect(compareInternalBetaVersions(NEXT_VERSION, NEXT_VERSION)).toBe(0);
  });

  it("disables Electron ASAR interception while extracting an update", async () => {
    const electronProcess = process as NodeJS.Process & { noAsar?: boolean };
    const previousNoAsar = electronProcess.noAsar;
    electronProcess.noAsar = false;
    const extractor = vi.fn(async () => {
      expect(electronProcess.noAsar).toBe(true);
    });

    try {
      await extractDesktopUpdateZip(
        "/tmp/aera-update.zip",
        "/tmp/aera-update-staging",
        extractor,
      );
      expect(extractor).toHaveBeenCalledOnce();
      expect(electronProcess.noAsar).toBe(false);
    } finally {
      electronProcess.noAsar = previousNoAsar;
    }
  });

  it("restores Electron ASAR interception after extraction fails", async () => {
    const electronProcess = process as NodeJS.Process & { noAsar?: boolean };
    const previousNoAsar = electronProcess.noAsar;
    electronProcess.noAsar = false;

    try {
      await expect(
        extractDesktopUpdateZip(
          "/tmp/aera-update.zip",
          "/tmp/aera-update-staging",
          async () => {
            expect(electronProcess.noAsar).toBe(true);
            throw new Error("fixture extraction failed");
          },
        ),
      ).rejects.toThrow("fixture extraction failed");
      expect(electronProcess.noAsar).toBe(false);
    } finally {
      electronProcess.noAsar = previousNoAsar;
    }
  });

  it.skipIf(process.platform === "win32")(
    "resolves the containing macOS app",
    () => {
      expect(
        resolveCurrentMacAppPath("/Applications/Aera.app/Contents/MacOS/Aera"),
      ).toBe("/Applications/Aera.app");
      expect(resolveCurrentMacAppPath("/usr/local/bin/agentera")).toBeNull();
    },
  );

  it.skipIf(process.platform === "win32")(
    "commits a macOS swap only after the new app reports healthy",
    async () => {
      const root = await createUserData();
      const current = join(root, "Aera.app");
      const staged = join(root, "staged.app");
      const backup = join(root, "backup.app");
      const marker = join(root, "healthy");
      const journal = join(root, "install-journal.json");
      await Promise.all([
        mkdir(current),
        mkdir(staged),
        writeFile(journal, "pending"),
      ]);
      await Promise.all([
        writeFile(join(current, "version"), "old"),
        writeFile(join(staged, "version"), "new"),
      ]);

      const operation = execFile("/bin/sh", [
        "-c",
        buildMacUpdateHelperScript({
          processWaitAttempts: 2,
          healthyWaitAttempts: 20,
        }),
        "aera-desktop-updater-test",
        "99999999",
        current,
        staged,
        backup,
        marker,
        journal,
        "/usr/bin/true",
      ]);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      await writeFile(marker, "healthy");
      await operation;

      await expect(readFile(join(current, "version"), "utf8")).resolves.toBe(
        "new",
      );
      await expect(access(backup)).rejects.toThrow();
      await expect(access(marker)).rejects.toThrow();
      await expect(access(journal)).rejects.toThrow();
    },
  );

  it.skipIf(process.platform === "win32")(
    "rolls a macOS swap back when the new app never reports healthy",
    async () => {
      const root = await createUserData();
      const current = join(root, "Aera.app");
      const staged = join(root, "staged.app");
      const backup = join(root, "backup.app");
      const marker = join(root, "healthy");
      const journal = join(root, "install-journal.json");
      const failure = join(root, "install-failure.json");
      const opener = join(root, "open-test.sh");
      const openLog = join(root, "open.log");
      await Promise.all([
        mkdir(current),
        mkdir(staged),
        writeFile(journal, "pending"),
        writeFile(
          opener,
          '#!/bin/sh\nprintf \'%s\\n\' "$2" >> "$AERA_TEST_OPEN_LOG"\n',
        ),
      ]);
      await chmod(opener, 0o700);
      await Promise.all([
        writeFile(join(current, "version"), "old"),
        writeFile(join(staged, "version"), "new"),
      ]);

      await expect(
        execFile(
          "/bin/sh",
          [
            "-c",
            buildMacUpdateHelperScript({
              processWaitAttempts: 2,
              healthyWaitAttempts: 2,
            }),
            "aera-desktop-updater-test",
            "99999999",
            current,
            staged,
            backup,
            marker,
            journal,
            opener,
          ],
          {
            env: { ...process.env, AERA_TEST_OPEN_LOG: openLog },
          },
        ),
      ).rejects.toThrow();

      await expect(readFile(join(current, "version"), "utf8")).resolves.toBe(
        "old",
      );
      await expect(access(backup)).rejects.toThrow();
      await expect(access(marker)).rejects.toThrow();
      await expect(access(journal)).rejects.toThrow();
      await expect(readFile(failure, "utf8")).resolves.toBe(
        '{"code":"update_health_timeout","schema_version":2,"state":"rolled_back","target_version":"unknown","operation_id":"unknown","stage":"rollback","rollback_state":"succeeded"}',
      );
      await expect(readFile(openLog, "utf8")).resolves.toBe(
        `${current}\n${current}\n`,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports rollback failure when the backup disappears during health wait",
    async () => {
      const root = await createUserData();
      const current = join(root, "Aera.app");
      const staged = join(root, "staged.app");
      const backup = join(root, "backup.app");
      const marker = join(root, "healthy");
      const journal = join(root, "install-journal.json");
      const failure = join(root, "install-failure.json");
      await Promise.all([
        mkdir(current),
        mkdir(staged),
        writeFile(journal, "pending"),
      ]);
      await Promise.all([
        writeFile(join(current, "version"), "old"),
        writeFile(join(staged, "version"), "new"),
      ]);

      const operation = execFile("/bin/sh", [
        "-c",
        buildMacUpdateHelperScript({
          processWaitAttempts: 2,
          healthyWaitAttempts: 30,
        }),
        "aera-desktop-updater-test",
        "99999999",
        current,
        staged,
        backup,
        marker,
        journal,
        failure,
        "/usr/bin/true",
        NEXT_VERSION,
      ]);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          await access(backup);
          break;
        } catch {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
      }
      await rm(backup, { recursive: true, force: true });
      await expect(operation).rejects.toThrow();
      await expect(readFile(failure, "utf8")).resolves.toBe(
        `{"code":"update_rollback_failed","schema_version":2,"state":"failed","target_version":"${NEXT_VERSION}","operation_id":"unknown","stage":"rollback","rollback_state":"failed"}`,
      );
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "terminates a failed macOS candidate before restoring the old app",
    async () => {
      const root = await createUserData();
      const current = join(root, "Aera.app");
      const staged = join(root, "staged.app");
      const backup = join(root, "backup.app");
      const marker = join(root, "healthy");
      const journal = join(root, "install-journal.json");
      const failure = join(root, "install-failure.json");
      const opener = join(root, "open-test.sh");
      const openCount = join(root, "open-count");
      const candidatePid = join(root, "candidate.pid");
      await Promise.all([
        mkdir(join(current, "Contents", "MacOS"), { recursive: true }),
        mkdir(join(staged, "Contents", "MacOS"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(journal, "pending"),
        writeFile(join(current, "version"), "old"),
        writeFile(join(staged, "version"), "new"),
        writeFile(
          join(staged, "Contents", "MacOS", "Aera"),
          [
            "#!/bin/sh",
            'echo $$ > "$AERA_TEST_CANDIDATE_PID"',
            "trap 'exit 0' TERM INT",
            "while :; do sleep 1; done",
            "",
          ].join("\n"),
        ),
        writeFile(
          opener,
          [
            "#!/bin/sh",
            "count=0",
            '[ -f "$AERA_TEST_OPEN_COUNT" ] && count=$(cat "$AERA_TEST_OPEN_COUNT")',
            "count=$((count + 1))",
            'printf \'%s\' "$count" > "$AERA_TEST_OPEN_COUNT"',
            'printf \'%s\\n\' "$2" >> "$AERA_TEST_OPEN_LOG"',
            'if [ "$count" -eq 1 ]; then',
            '  "$2/Contents/MacOS/Aera" </dev/null >/dev/null 2>&1 &',
            '  echo $! > "$AERA_TEST_CANDIDATE_PID"',
            "fi",
            "",
          ].join("\n"),
        ),
      ]);
      await Promise.all([
        chmod(join(staged, "Contents", "MacOS", "Aera"), 0o700),
        chmod(opener, 0o700),
      ]);

      await expect(
        execFile(
          "/bin/sh",
          [
            "-c",
            buildMacUpdateHelperScript({
              processWaitAttempts: 2,
              healthyWaitAttempts: 2,
            }),
            "aera-desktop-updater-test",
            "99999999",
            current,
            staged,
            backup,
            marker,
            journal,
            failure,
            opener,
            NEXT_VERSION,
            "12345678-1234-4234-9234-123456789abc",
          ],
          {
            env: {
              ...process.env,
              AERA_TEST_OPEN_COUNT: openCount,
              AERA_TEST_OPEN_LOG: join(root, "open.log"),
              AERA_TEST_CANDIDATE_PID: candidatePid,
            },
          },
        ),
      ).rejects.toThrow();

      const pid = Number((await readFile(candidatePid, "utf8")).trim());
      const candidateStillRunning = await execFile("/bin/kill", [
        "-0",
        String(pid),
      ]).then(
        () => true,
        () => false,
      );
      if (candidateStillRunning) {
        await execFile("/bin/kill", ["-9", String(pid)]).catch(() => {});
      }
      await expect(readFile(join(current, "version"), "utf8")).resolves.toBe(
        "old",
      );
      await expect(access(backup)).rejects.toThrow();
      await expect(access(journal)).rejects.toThrow();
      await expect(readFile(failure, "utf8")).resolves.toContain(
        '"state":"rolled_back"',
      );
      expect(candidateStillRunning).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps and relaunches the old macOS app when creating the backup fails",
    async () => {
      const root = await createUserData();
      const current = join(root, "Aera.app");
      const staged = join(root, "staged.app");
      const backup = join(root, "missing-parent", "backup.app");
      const marker = join(root, "healthy");
      const journal = join(root, "install-journal.json");
      const failure = join(root, "install-failure.json");
      const opener = join(root, "open-test.sh");
      const openLog = join(root, "open.log");
      await Promise.all([mkdir(current), mkdir(staged)]);
      await Promise.all([
        writeFile(join(current, "version"), "old"),
        writeFile(join(staged, "version"), "new"),
        writeFile(journal, "pending"),
        writeFile(
          opener,
          '#!/bin/sh\nprintf \'%s\\n\' "$2" >> "$AERA_TEST_OPEN_LOG"\n',
        ),
      ]);
      await chmod(opener, 0o700);

      await expect(
        execFile(
          "/bin/sh",
          [
            "-c",
            buildMacUpdateHelperScript({
              processWaitAttempts: 2,
              healthyWaitAttempts: 2,
            }),
            "aera-desktop-updater-test",
            "99999999",
            current,
            staged,
            backup,
            marker,
            journal,
            failure,
            opener,
            NEXT_VERSION,
            "12345678-1234-4234-9234-123456789abc",
          ],
          { env: { ...process.env, AERA_TEST_OPEN_LOG: openLog } },
        ),
      ).rejects.toThrow();

      await expect(readFile(join(current, "version"), "utf8")).resolves.toBe(
        "old",
      );
      await expect(readFile(openLog, "utf8")).resolves.toBe(`${current}\n`);
      await expect(readFile(failure, "utf8")).resolves.toContain(
        '"code":"update_swap_failed"',
      );
      await expect(readFile(failure, "utf8")).resolves.toContain(
        '"state":"failed"',
      );
      await expect(access(journal)).rejects.toThrow();
    },
  );

  it.skipIf(process.platform !== "win32")(
    "executes the Windows helper rollback and relaunches the restored app",
    async () => {
      const root = await createUserData();
      const install = join(root, "installed");
      const staged = join(root, "staged");
      const backup = join(root, "backup");
      const marker = join(root, "healthy");
      const journal = join(root, "install-journal.json");
      const failure = join(root, "install-failure.json");
      const helper = join(root, "update-helper.ps1");
      const executable = join(install, "Aera.exe");
      const shellExecutable = process.env.ComSpec;
      if (!shellExecutable)
        throw new Error("Windows command shell is unavailable");
      await Promise.all([mkdir(install), mkdir(staged)]);
      await Promise.all([
        copyFile(shellExecutable, executable),
        copyFile(shellExecutable, join(staged, "Aera.exe")),
        writeFile(join(install, "version"), "old"),
        writeFile(join(staged, "version"), "new"),
        writeFile(
          journal,
          JSON.stringify({
            state: "prepared",
            rollback_state: "not_started",
            updated_at: "2026-08-18T07:00:00Z",
          }),
        ),
        writeFile(
          helper,
          buildWindowsUpdateHelperScript({
            processWaitAttempts: 20,
            healthyWaitAttempts: 2,
          }),
        ),
      ]);

      const powershell = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      await expect(
        execFile(powershell, [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          helper,
          "99999999",
          install,
          staged,
          backup,
          executable,
          marker,
          journal,
          failure,
          helper,
          NEXT_VERSION,
          "12345678-1234-4234-9234-123456789abc",
        ]),
      ).rejects.toThrow();

      const failureRecord = JSON.parse(await readFile(failure, "utf8")) as {
        code: string;
        state: string;
      };
      expect(failureRecord).toMatchObject({
        code: "update_health_timeout",
        state: "rolled_back",
      });
      await expect(readFile(join(install, "version"), "utf8")).resolves.toBe(
        "old",
      );
      await execFile(powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${executable.replaceAll("'", "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
      ]).catch(() => {});
    },
  );

  it.skipIf(process.platform !== "win32")(
    "cleans up after a pre-swap validation failure without changing the old app",
    async () => {
      const root = await createUserData();
      const install = join(root, "installed");
      const missingStaged = join(root, "staged-missing");
      const backup = join(root, "backup");
      const marker = join(root, "health-marker");
      const journal = join(root, "install-journal.json");
      const failure = join(root, "install-failure.json");
      const helper = join(root, "update-helper.ps1");
      const executable = join(install, "Aera.exe");
      const shellExecutable = process.env.ComSpec;
      if (!shellExecutable)
        throw new Error("Windows command shell is unavailable");
      await mkdir(install, { recursive: true });
      await Promise.all([
        copyFile(shellExecutable, executable),
        writeFile(
          journal,
          JSON.stringify({
            state: "prepared",
            rollback_state: "not_started",
            updated_at: "2026-08-18T07:00:00Z",
          }),
        ),
        writeFile(marker, ""),
        writeFile(failure, ""),
        writeFile(
          helper,
          buildWindowsUpdateHelperScript({ processWaitAttempts: 2 }),
        ),
      ]);

      const powershell = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      await expect(
        execFile(powershell, [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          helper,
          "-ProcessId",
          "99999999",
          "-InstallDirectory",
          install,
          "-StagedDirectory",
          missingStaged,
          "-BackupDirectory",
          backup,
          "-TargetExecutable",
          executable,
          "-MarkerPath",
          marker,
          "-JournalPath",
          journal,
          "-FailurePath",
          failure,
          "-HelperPath",
          helper,
          "-TargetVersion",
          NEXT_VERSION,
          "-OperationId",
          "12345678-1234-4234-9234-123456789abc",
        ]),
      ).rejects.toThrow();

      await expect(readFile(failure, "utf8")).resolves.toContain(
        '"code":"update_staged_identity_invalid"',
      );
      await expect(access(journal)).rejects.toThrow();
      await execFile(powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${executable.replaceAll("'", "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
      ]).catch(() => {});
    },
  );

  it("leaves a stable macOS failure marker after health rollback", () => {
    const script = buildMacUpdateHelperScript();
    expect(script).toContain("update_health_timeout");
    expect(script).toContain("update_rollback_failed");
    expect(script).toContain("install-failure.json");
  });

  it("builds a Windows app-directory swap helper with process, health, and rollback gates", () => {
    const script = buildWindowsUpdateHelperScript({
      processWaitAttempts: 7,
      healthyWaitAttempts: 11,
    });

    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("$StagedDirectory");
    expect(script).not.toContain("/S");
    expect(script).not.toContain("InstallerPath");
    expect(script).toContain("update_health_timeout");
    expect(script).toContain("update_rollback_failed");
    expect(script).toContain("Move-Item -LiteralPath $InstallDirectory");
    expect(script).toContain("Move-Item -LiteralPath $StagedDirectory");
    expect(script).toContain("Start-Process -FilePath $TargetExecutable");
    expect(script).toContain("$HealthyWaitAttempts = 11");
    expect(script).toContain("$ProcessWaitAttempts = 7");
    for (const state of [
      "waiting_for_exit",
      "backup_created",
      "app_swapped",
      "launched",
      "healthy",
      "finalized",
      "rollback_started",
      "rolled_back",
      "rollback_failed",
    ]) {
      expect(script).toContain(state);
    }
    expect(script).toContain(
      "[ordered]@{ code = $Code; schema_version = 2; state = $State; target_version = $TargetVersion; operation_id = $OperationId",
    );
    expect(script).toContain("WriteAllText($FailurePath, $json,");
    expect(script).not.toContain("$json + [Environment]::NewLine");
  });

  it("stops a failed Windows candidate before restoring and relaunches the old app", () => {
    const script = buildWindowsUpdateHelperScript();
    const restoreStart = script.indexOf("function Restore-Install");
    const stopCandidate = script.indexOf(
      "Stop-ProcessTree $newProcess.Id",
      restoreStart,
    );
    const removeCurrent = script.indexOf(
      "Remove-IfExists $InstallDirectory",
      restoreStart,
    );

    expect(restoreStart).toBeGreaterThanOrEqual(0);
    expect(stopCandidate).toBeGreaterThan(restoreStart);
    expect(stopCandidate).toBeLessThan(removeCurrent);
    expect(
      [...script.matchAll(/Start-Process -FilePath \$TargetExecutable/gu)]
        .length,
    ).toBeGreaterThanOrEqual(2);
    expect(script).toContain("$newProcess = $null");
  });

  it("relaunches the old Windows app when preparation fails after it exited", () => {
    const script = buildWindowsUpdateHelperScript();
    const preSwapCatch = script.slice(script.indexOf("if (-not $swapped)"));

    expect(preSwapCatch).toContain("$oldProcessExited");
    expect(preSwapCatch).toMatch(
      /Remove-IfExists \$JournalPath[\s\S]*Start-Process -FilePath \$TargetExecutable/u,
    );
  });

  it("checks the sibling-backup parent before the Windows install directory", async () => {
    const executable =
      process.platform === "win32"
        ? "C:\\opt\\Aera\\Aera.exe"
        : "/opt/Aera/Aera.exe";
    const installDirectory = dirname(resolve(executable));
    const checks: Array<{ path: string; mode: number | undefined }> = [];

    await validateWindowsInstallPreflight(executable, async (path, mode) => {
      checks.push({ path, mode });
    });

    expect(checks).toEqual([
      { path: dirname(installDirectory), mode: expect.any(Number) },
      { path: installDirectory, mode: expect.any(Number) },
    ]);
    expect(checks[0]?.mode).toBe(checks[1]?.mode);
    if (process.platform === "win32") {
      expect(checks.map((check) => check.path)).toEqual([
        "C:\\opt",
        "C:\\opt\\Aera",
      ]);
    }
  });

  it.skipIf(process.platform === "win32")(
    "checks the Windows install parent before spawning the swap helper",
    async () => {
      const userDataPath = await createUserData();
      const installParent = await mkdtemp(
        join(tmpdir(), "aera-install-parent-"),
      );
      createdDirectories.push(installParent);
      const installDirectory = join(installParent, "Aera");
      const executable = join(installDirectory, "Aera.exe");
      await mkdir(installDirectory, { recursive: true });
      await writeFile(executable, "old");
      await chmod(installDirectory, 0o700);
      await chmod(installParent, 0o500);

      const release = signedRelease();
      const spawnDetachedProcess = vi.fn(async () => {});
      const updater = new InternalBetaDesktopUpdater({
        currentVersion: CURRENT_VERSION,
        platform: "win32",
        arch: "x64",
        userDataPath,
        currentAppPath: executable,
        baseUrl: BASE_URL,
        trustedPublicKeys: new Map([[KEY_ID, release.publicKeyPem]]),
        autoDownload: false,
        onState: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        metadataTransport: transportFor(
          release.manifestBytes,
          release.signatureBytes,
        ),
        downloadArtifact: async (request) => {
          await writeFile(request.destination, release.windowsBytes);
          request.onProgress(
            release.windowsBytes.length,
            release.windowsBytes.length,
          );
        },
        prepareArtifact: async () => {},
        spawnDetachedProcess,
      });

      try {
        await updater.initialize();
        await updater.check();
        await updater.download();
        await expect(updater.install()).rejects.toThrow();
        expect(spawnDetachedProcess).not.toHaveBeenCalled();
      } finally {
        await chmod(installParent, 0o700);
      }
    },
  );

  it("rejects invalid Windows helper limits", () => {
    expect(() =>
      buildWindowsUpdateHelperScript({ processWaitAttempts: 0 }),
    ).toThrow();
    expect(() =>
      buildWindowsUpdateHelperScript({ healthyWaitAttempts: -1 }),
    ).toThrow();
  });
});
