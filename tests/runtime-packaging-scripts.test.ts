import { createServer, type Server } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import YAML from "yaml";

import {
  TEST_ARCHIVE_BYTES,
  TEST_ARCHIVE_NAME,
  TEST_PUBLIC_KEY,
  TEST_RUNTIME_VERSION,
  TEST_SOURCE_COMMIT,
  createSignedFixture,
} from "./fixtures/runtime-distribution/fixture";

import { prepareRuntimeSeed } from "../scripts/prepare-agentera-runtime-seed.mjs";
import { verifyPackagedRuntimeSeed } from "../scripts/verify-packaged-runtime-seed.mjs";

const REPOSITORY = "bignormal/aera-runtime";
const RELEASE_TAG = `runtime-v${TEST_RUNTIME_VERSION}-rc.1`;
const MANIFEST_NAME = TEST_ARCHIVE_NAME.replace(
  /-darwin-arm64\.tar\.zst$/,
  "-darwin-arm64.manifest.json",
);
const SIGNATURE_NAME = MANIFEST_NAME.replace(/\.json$/, ".sig");
const WINDOWS_ARCHIVE_NAME = `agentera-runtime-${TEST_RUNTIME_VERSION}-windows-x64.zip`;
const WINDOWS_MANIFEST_NAME = `agentera-runtime-${TEST_RUNTIME_VERSION}-windows-x64.manifest.json`;
const WINDOWS_SIGNATURE_NAME = `agentera-runtime-${TEST_RUNTIME_VERSION}-windows-x64.manifest.sig`;

interface FixtureOptions {
  manifest?: Record<string, unknown>;
  lock?: Record<string, unknown>;
  tamperArchive?: boolean;
  tamperSignature?: boolean;
}

interface PackagingFixture {
  root: string;
  sourceDirectory: string;
  destination: string;
  lockPath: string;
  trustPath: string;
  cleanup: () => void;
}

function createPackagingFixture(
  options: FixtureOptions = {},
): PackagingFixture {
  const root = mkdtempSync(join(tmpdir(), "agentera-runtime-packaging-"));
  const sourceDirectory = join(root, "source");
  const destination = join(root, "staged");
  const lockPath = join(root, "seed.lock.json");
  const trustPath = join(root, "trust.json");
  mkdirSync(sourceDirectory);
  mkdirSync(destination);

  const { manifestBytes, signatureBytes } = createSignedFixture(
    options.manifest,
  );
  const archiveBytes = Buffer.from(TEST_ARCHIVE_BYTES);
  if (options.tamperArchive) archiveBytes[0] ^= 0xff;
  const stagedSignature = Buffer.from(signatureBytes);
  if (options.tamperSignature) stagedSignature[0] ^= 0xff;

  writeFileSync(join(sourceDirectory, TEST_ARCHIVE_NAME), archiveBytes);
  writeFileSync(join(sourceDirectory, MANIFEST_NAME), manifestBytes);
  writeFileSync(join(sourceDirectory, SIGNATURE_NAME), stagedSignature);
  writeFileSync(join(sourceDirectory, WINDOWS_ARCHIVE_NAME), "foreign target");
  writeFileSync(join(destination, ".gitkeep"), "");
  writeFileSync(join(destination, "stale-runtime.zip"), "stale");
  writeFileSync(
    join(destination, "previous-valid-marker"),
    "preserve on failure",
  );

  const lock = {
    schema_version: 1,
    repository: REPOSITORY,
    release_tag: RELEASE_TAG,
    source_commit: TEST_SOURCE_COMMIT,
    runtime_version: TEST_RUNTIME_VERSION,
    channel: "candidate",
    assets: {
      "darwin-arm64": {
        platform: "darwin",
        arch: "arm64",
        archive: TEST_ARCHIVE_NAME,
        manifest: MANIFEST_NAME,
        signature: SIGNATURE_NAME,
      },
      "windows-x64": {
        platform: "windows",
        arch: "x64",
        archive: WINDOWS_ARCHIVE_NAME,
        manifest: WINDOWS_MANIFEST_NAME,
        signature: WINDOWS_SIGNATURE_NAME,
      },
    },
    ...options.lock,
  };
  writeFileSync(lockPath, JSON.stringify(lock));
  writeFileSync(
    trustPath,
    JSON.stringify({
      schema_version: 1,
      keys: [
        {
          key_id: "agentera-runtime-test-01",
          algorithm: "Ed25519",
          public_key_pem: TEST_PUBLIC_KEY,
        },
      ],
    }),
  );

  return {
    root,
    sourceDirectory,
    destination,
    lockPath,
    trustPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function stageLocal(
  fixture: ReturnType<typeof createPackagingFixture>,
): Promise<unknown> {
  return prepareRuntimeSeed({
    platform: "darwin",
    arch: "arm64",
    lockPath: fixture.lockPath,
    trustPath: fixture.trustPath,
    destination: fixture.destination,
    localSourceDirectory: fixture.sourceDirectory,
    desktopVersion: "0.7.3",
    ci: false,
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("loopback fixture did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("Runtime Seed packaging scripts", () => {
  it("selects one native target, verifies it, and deletes stale staged artifacts", async () => {
    const fixture = createPackagingFixture();
    try {
      const result = await stageLocal(fixture);
      expect(result).toMatchObject({
        platform: "darwin",
        arch: "arm64",
        runtimeVersion: TEST_RUNTIME_VERSION,
        sourceCommit: TEST_SOURCE_COMMIT,
      });
      expect(readdirSync(fixture.destination).sort()).toEqual(
        [".gitkeep", TEST_ARCHIVE_NAME, MANIFEST_NAME, SIGNATURE_NAME].sort(),
      );
      expect(readdirSync(fixture.destination)).not.toContain(
        WINDOWS_ARCHIVE_NAME,
      );

      await expect(
        verifyPackagedRuntimeSeed({
          directory: fixture.destination,
          lockPath: fixture.lockPath,
          trustPath: fixture.trustPath,
          desktopVersion: "0.7.3",
        }),
      ).resolves.toMatchObject({ verified: true });
    } finally {
      fixture.cleanup();
    }
  });

  it("fetches only the exact locked release assets from a loopback fixture", async () => {
    const fixture = createPackagingFixture();
    const requested: string[] = [];
    const assets = new Map([
      [
        `/${REPOSITORY}/releases/download/${RELEASE_TAG}/${TEST_ARCHIVE_NAME}`,
        readFileSync(join(fixture.sourceDirectory, TEST_ARCHIVE_NAME)),
      ],
      [
        `/${REPOSITORY}/releases/download/${RELEASE_TAG}/${MANIFEST_NAME}`,
        readFileSync(join(fixture.sourceDirectory, MANIFEST_NAME)),
      ],
      [
        `/${REPOSITORY}/releases/download/${RELEASE_TAG}/${SIGNATURE_NAME}`,
        readFileSync(join(fixture.sourceDirectory, SIGNATURE_NAME)),
      ],
    ]);
    const server = createServer((request, response) => {
      requested.push(request.url ?? "");
      const body = assets.get(request.url ?? "");
      if (body === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Length": body.length }).end(body);
    });

    try {
      const port = await listen(server);
      await prepareRuntimeSeed({
        platform: "darwin",
        arch: "arm64",
        lockPath: fixture.lockPath,
        trustPath: fixture.trustPath,
        destination: fixture.destination,
        localSourceDirectory: null,
        releaseOrigin: new URL(`http://127.0.0.1:${port}`),
        desktopVersion: "0.7.3",
        ci: false,
      });
      expect(requested.sort()).toEqual([...assets.keys()].sort());
      expect(requested.join("\n")).not.toMatch(/latest/i);
    } finally {
      await close(server);
      fixture.cleanup();
    }
  });

  it("rejects latest and unsupported target requests before staging", async () => {
    const latest = createPackagingFixture({ lock: { release_tag: "latest" } });
    const unsupported = createPackagingFixture();
    try {
      await expect(stageLocal(latest)).rejects.toThrow(/latest|release tag/i);
      expect(readdirSync(latest.destination).sort()).toEqual(
        [".gitkeep", "previous-valid-marker", "stale-runtime.zip"].sort(),
      );
      await expect(
        prepareRuntimeSeed({
          platform: "darwin",
          arch: "x64",
          lockPath: unsupported.lockPath,
          trustPath: unsupported.trustPath,
          destination: unsupported.destination,
          localSourceDirectory: unsupported.sourceDirectory,
          desktopVersion: "0.7.3",
          ci: false,
        }),
      ).rejects.toThrow(/unsupported|target/i);
    } finally {
      latest.cleanup();
      unsupported.cleanup();
    }
  });

  it.each([
    {
      name: "source commit",
      options: { manifest: { source_commit: "e".repeat(40) } },
      error: /source commit/i,
    },
    {
      name: "Runtime version",
      options: { manifest: { runtime_version: "0.18.2-agentera.2" } },
      error: /runtime version/i,
    },
    {
      name: "release tag",
      options: {
        lock: {
          release_tag: "runtime-v0.18.2-agentera.2-rc.1",
        },
      },
      error: /release tag/i,
    },
  ])(
    "refuses $name drift without replacing the prior stage",
    async ({ options, error }) => {
      const fixture = createPackagingFixture(options);
      try {
        await expect(stageLocal(fixture)).rejects.toThrow(error);
        expect(
          readFileSync(
            join(fixture.destination, "previous-valid-marker"),
            "utf8",
          ),
        ).toBe("preserve on failure");
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each([
    { name: "archive hash/size", options: { tamperArchive: true } },
    { name: "manifest signature", options: { tamperSignature: true } },
  ])("verifies $name before changing the destination", async ({ options }) => {
    const fixture = createPackagingFixture(options);
    try {
      await expect(stageLocal(fixture)).rejects.toThrow(
        /verification|archive|signature/i,
      );
      expect(readdirSync(fixture.destination).sort()).toEqual(
        [".gitkeep", "previous-valid-marker", "stale-runtime.zip"].sort(),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects the local source override in CI", async () => {
    const fixture = createPackagingFixture();
    try {
      await expect(
        prepareRuntimeSeed({
          platform: "darwin",
          arch: "arm64",
          lockPath: fixture.lockPath,
          trustPath: fixture.trustPath,
          destination: fixture.destination,
          localSourceDirectory: fixture.sourceDirectory,
          desktopVersion: "0.7.3",
          ci: true,
        }),
      ).rejects.toThrow(/CI.*local|local.*CI/i);
    } finally {
      fixture.cleanup();
    }
  });

  it("detects byte drift from the verified staging reference", async () => {
    const fixture = createPackagingFixture();
    const packaged = join(fixture.root, "packaged");
    try {
      await stageLocal(fixture);
      mkdirSync(packaged);
      for (const name of [TEST_ARCHIVE_NAME, MANIFEST_NAME, SIGNATURE_NAME]) {
        writeFileSync(
          packaged + "/" + name,
          readFileSync(join(fixture.destination, name)),
        );
      }
      writeFileSync(join(packaged, TEST_ARCHIVE_NAME), "drift");
      await expect(
        verifyPackagedRuntimeSeed({
          directory: packaged,
          referenceDirectory: fixture.destination,
          lockPath: fixture.lockPath,
          trustPath: fixture.trustPath,
          desktopVersion: "0.7.3",
        }),
      ).rejects.toThrow(/byte|archive|hash/i);
    } finally {
      fixture.cleanup();
    }
  });

  it("embeds only the verified Seed staging directory through extraResources", () => {
    const config = YAML.parse(
      readFileSync(join(process.cwd(), "electron-builder.yml"), "utf8"),
    );
    expect(config.extraResources).toEqual([
      {
        from: "resources/agentera-runtime-seed",
        to: "agentera-runtime-seed",
        filter: ["**/*", "!.gitkeep"],
      },
    ]);
    expect(config.files).toContain("!resources/agentera-runtime-seed/**");
    const scripts = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ).scripts;
    expect(scripts).toMatchObject({
      "prepare:runtime-seed": "node scripts/prepare-agentera-runtime-seed.mjs",
      "verify:packaged-runtime-seed":
        "node scripts/verify-packaged-runtime-seed.mjs",
    });
  });

  it("builds and verifies the Runtime Seed only in the signed candidate workflow", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "release-candidate.yml"),
      "utf8",
    );
    expect(workflow).toContain(
      "npm run prepare:runtime-seed -- --platform darwin --arch arm64",
    );
    expect(workflow).toContain(
      "npm run prepare:runtime-seed -- --platform windows --arch x64",
    );
    expect(workflow).toContain("Verify signed macOS candidate");
    expect(workflow).toContain("Verify signed Windows candidate");
    expect(workflow).not.toMatch(/(?:release|beta)_linux:/);
    expect(workflow).not.toMatch(/arch:\s*\[x64,\s*arm64\]/);
    expect(workflow).not.toMatch(/electron-builder --mac[^\n]*--x64/);
    expect(workflow).not.toMatch(
      /action-gh-release|gh release create|git tag/u,
    );
  });

  it.each(["release.yml", "beta-release.yml"])(
    "uses the immutable candidate workflow from %s without rebuilding or publishing",
    (workflowName) => {
      const workflow = readFileSync(
        join(process.cwd(), ".github", "workflows", workflowName),
        "utf8",
      );
      expect(workflow).toContain(
        "uses: ./.github/workflows/release-candidate.yml",
      );
      expect(workflow).not.toMatch(
        /electron-builder|prepare:runtime-seed|action-gh-release|gh release create|git tag/u,
      );
      expect(workflow).not.toMatch(/contents:\s*write/u);
    },
  );
});
