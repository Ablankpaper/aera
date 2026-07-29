import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMacUpdateHelperScript,
  compareInternalBetaVersions,
  extractDesktopUpdateZip,
  InternalBetaDesktopUpdater,
  resolveCurrentMacAppPath,
  tryCreateInternalBetaDesktopUpdater,
  type ArtifactDownloadRequest,
  type DesktopUpdateManifest,
  type MetadataTransport,
} from "../src/main/app/internal-beta-updater";
import { canonicalJsonBytes } from "../src/main/agentera-runtime-distribution/manifest";

const BASE_URL = new URL(
  "https://updates.example.test/desktop-updates/internal-beta",
);
const CURRENT_VERSION = "0.7.4-internal-beta.9";
const NEXT_VERSION = "0.7.4-internal-beta.11";
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

function signedRelease(): {
  manifestBytes: Buffer;
  signatureBytes: Buffer;
  publicKeyPem: string;
  windowsBytes: Buffer;
} {
  const macBytes = Buffer.from("signed mac archive");
  const windowsBytes = Buffer.from("signed windows installer");
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
        kind: "nsis",
        name: `Aera-Internal-Beta-${NEXT_VERSION}-windows-x64-setup.exe`,
        ...windowsDigest,
        url: `${BASE_URL.href}/releases/${NEXT_VERSION}/Aera-Internal-Beta-${NEXT_VERSION}-windows-x64-setup.exe`,
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
    onState: vi.fn(),
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
    prepareArtifact: async () => {},
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
        baseUrl: new URL(
          "http://127.0.0.1:8086/desktop-updates/internal-beta",
        ),
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
      error: "更新失败，请稍后重试。",
    });
  });

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
        resolveCurrentMacAppPath(
          "/Applications/Aera.app/Contents/MacOS/Aera",
        ),
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
      await Promise.all([
        mkdir(current),
        mkdir(staged),
        writeFile(journal, "pending"),
      ]);
      await Promise.all([
        writeFile(join(current, "version"), "old"),
        writeFile(join(staged, "version"), "new"),
      ]);

      await expect(
        execFile("/bin/sh", [
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
          "/usr/bin/true",
        ]),
      ).rejects.toThrow();

      await expect(readFile(join(current, "version"), "utf8")).resolves.toBe(
        "old",
      );
      await expect(access(backup)).rejects.toThrow();
      await expect(access(marker)).rejects.toThrow();
      await expect(access(journal)).rejects.toThrow();
    },
  );
});
