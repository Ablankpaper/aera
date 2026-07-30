import { sign } from "node:crypto";

import {
  TEST_ARCHIVE_NAME,
  TEST_PRIVATE_KEY,
  TEST_PUBLIC_KEY,
  TEST_RUNTIME_VERSION,
  TEST_SOURCE_COMMIT,
  createFixtureManifest,
  createSignedFixture,
  fixtureCanonicalBytes,
} from "./fixtures/runtime-distribution/fixture";

import {
  FetchRuntimeMetadataTransport,
  RuntimeUpdateUrlError,
  assertAllowedRuntimeUpdateUrl,
  checkStableRuntimeUpdate,
  type RuntimeMetadataTransport,
} from "../src/main/agentera-runtime-distribution/update-client";

const REPOSITORY = "bignormal/aera-runtime";
const RELEASE_TAG = `runtime-v${TEST_RUNTIME_VERSION}`;
const MANIFEST_NAME = TEST_ARCHIVE_NAME.replace(
  /-darwin-arm64\.tar\.zst$/,
  "-darwin-arm64.manifest.json",
);
const SIGNATURE_NAME = MANIFEST_NAME.replace(/\.json$/, ".sig");
const INDEX_NAME = "agentera-runtime-stable.index.json";
const INDEX_SIGNATURE_NAME = "agentera-runtime-stable.index.sig";
const LATEST_INDEX_URL = `https://github.com/${REPOSITORY}/releases/latest/download/${INDEX_NAME}`;
const LATEST_INDEX_SIGNATURE_URL = `https://github.com/${REPOSITORY}/releases/latest/download/${INDEX_SIGNATURE_NAME}`;
const RELEASE_PREFIX = `https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}`;

interface UpdateFixtureOptions {
  runtimeVersion?: string;
  sourceCommit?: string;
  minimumDesktopVersion?: string;
  tamperIndexSignature?: boolean;
  manifestOverrides?: Record<string, unknown>;
}

interface UpdateFixture {
  transport: RuntimeMetadataTransport;
  requests: string[];
  archiveUrl: string;
  context: {
    currentVersion: string;
    currentSourceCommit: string;
    repository: string;
    platform: "darwin";
    arch: "arm64";
    desktopVersion: string;
    trustedPublicKeys: ReadonlyMap<string, string>;
    signal: AbortSignal;
    transport: RuntimeMetadataTransport;
  };
}

function signatureEnvelope(raw: Buffer): Buffer {
  return fixtureCanonicalBytes({
    schema_version: 1,
    key_id: "agentera-runtime-test-01",
    algorithm: "Ed25519",
    signature_base64: sign(null, raw, TEST_PRIVATE_KEY).toString("base64"),
  });
}

function createUpdateFixture(
  options: UpdateFixtureOptions = {},
): UpdateFixture {
  const runtimeVersion = options.runtimeVersion ?? TEST_RUNTIME_VERSION;
  const sourceCommit = options.sourceCommit ?? TEST_SOURCE_COMMIT;
  const releaseTag = `runtime-v${runtimeVersion}`;
  const archiveName = `agentera-runtime-${runtimeVersion}-darwin-arm64.tar.zst`;
  const manifestName = `agentera-runtime-${runtimeVersion}-darwin-arm64.manifest.json`;
  const signatureName = `agentera-runtime-${runtimeVersion}-darwin-arm64.manifest.sig`;
  const manifest = createFixtureManifest({
    runtime_version: runtimeVersion,
    source_commit: sourceCommit,
    channel: "stable",
    archive_name: archiveName,
    minimum_desktop_version: options.minimumDesktopVersion ?? "0.7.3",
    ...options.manifestOverrides,
  });
  const { manifestBytes, signatureBytes } = createSignedFixture(manifest);
  const indexBytes = fixtureCanonicalBytes({
    schema_version: 1,
    key_id: "agentera-runtime-test-01",
    channel: "stable",
    runtime_version: runtimeVersion,
    source_repository: REPOSITORY,
    source_commit: sourceCommit,
    release_tag: releaseTag,
    created_at: "2026-07-18T04:05:06Z",
    targets: [
      {
        platform: "darwin",
        arch: "arm64",
        archive_name: archiveName,
        manifest_name: manifestName,
        signature_name: signatureName,
        archive_sha256: manifest.archive_sha256,
      },
      {
        platform: "windows",
        arch: "x64",
        archive_name: `agentera-runtime-${runtimeVersion}-windows-x64.zip`,
        manifest_name: `agentera-runtime-${runtimeVersion}-windows-x64.manifest.json`,
        signature_name: `agentera-runtime-${runtimeVersion}-windows-x64.manifest.sig`,
        archive_sha256: "c".repeat(64),
      },
    ],
  });
  const indexSignature = Buffer.from(signatureEnvelope(indexBytes));
  if (options.tamperIndexSignature) indexSignature[0] ^= 0xff;

  const releasePrefix = `https://github.com/${REPOSITORY}/releases/download/${releaseTag}`;
  const assets = new Map<string, Buffer>([
    [LATEST_INDEX_URL, indexBytes],
    [LATEST_INDEX_SIGNATURE_URL, indexSignature],
    [`${releasePrefix}/${manifestName}`, manifestBytes],
    [`${releasePrefix}/${signatureName}`, signatureBytes],
  ]);
  const requests: string[] = [];
  const transport: RuntimeMetadataTransport = {
    async get(url): Promise<Buffer> {
      requests.push(url.href);
      const body = assets.get(url.href);
      if (body === undefined) throw new Error(`fixture 404: ${url.href}`);
      return body;
    },
  };
  return {
    transport,
    requests,
    archiveUrl: `${releasePrefix}/${archiveName}`,
    context: {
      currentVersion: "0.18.1",
      currentSourceCommit: "e".repeat(40),
      repository: REPOSITORY,
      platform: "darwin",
      arch: "arm64",
      desktopVersion: "0.7.3",
      trustedPublicKeys: new Map([
        ["agentera-runtime-test-01", TEST_PUBLIC_KEY],
      ]),
      signal: new AbortController().signal,
      transport,
    },
  };
}

describe("Runtime stable update client", () => {
  it("uses an injected Chromium-network fetcher for metadata", async () => {
    const requests: Array<{
      url: string;
      redirect: string;
      userAgent: string | undefined;
    }> = [];
    const transport = new FetchRuntimeMetadataTransport(async (url, init) => {
      requests.push({
        url,
        redirect: init.redirect,
        userAgent: init.headers["User-Agent"],
      });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Length": "3" },
      });
    });

    await expect(
      transport.get(new URL(LATEST_INDEX_URL), new AbortController().signal),
    ).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(requests).toEqual([
      {
        url: LATEST_INDEX_URL,
        redirect: "follow",
        userAgent: "Aera-Studio-Runtime-Updater",
      },
    ]);
  });

  it("fetches only signed index/manifest metadata and returns an offer", async () => {
    const fixture = createUpdateFixture();
    const offer = await checkStableRuntimeUpdate(fixture.context);
    expect(offer).toMatchObject({
      runtimeVersion: TEST_RUNTIME_VERSION,
      sourceCommit: TEST_SOURCE_COMMIT,
      releaseTag: RELEASE_TAG,
      archiveName: TEST_ARCHIVE_NAME,
      archiveSize: expect.any(Number),
      archiveSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      archiveUrl: new URL(fixture.archiveUrl),
      manifestUrl: new URL(`${RELEASE_PREFIX}/${MANIFEST_NAME}`),
      signatureUrl: new URL(`${RELEASE_PREFIX}/${SIGNATURE_NAME}`),
    });
    expect(fixture.requests).toEqual([
      LATEST_INDEX_URL,
      LATEST_INDEX_SIGNATURE_URL,
      `${RELEASE_PREFIX}/${MANIFEST_NAME}`,
      `${RELEASE_PREFIX}/${SIGNATURE_NAME}`,
    ]);
    expect(fixture.requests).not.toContain(fixture.archiveUrl);
  });

  it.each([
    { name: "equal", currentVersion: TEST_RUNTIME_VERSION },
    { name: "older", currentVersion: "0.19.0" },
  ])(
    "returns no offer for an $name available version",
    async ({ currentVersion }) => {
      const fixture = createUpdateFixture();
      await expect(
        checkStableRuntimeUpdate({ ...fixture.context, currentVersion }),
      ).resolves.toBeNull();
      expect(fixture.requests).not.toContain(fixture.archiveUrl);
    },
  );

  it("returns no offer when the signed manifest requires a newer desktop", async () => {
    const fixture = createUpdateFixture({ minimumDesktopVersion: "99.0.0" });
    const errors: string[] = [];
    await expect(
      checkStableRuntimeUpdate({
        ...fixture.context,
        onCheckError: (code) => errors.push(code),
      }),
    ).resolves.toBeNull();
    expect(errors).toEqual([]);
    expect(fixture.requests).not.toContain(fixture.archiveUrl);
  });

  it("keeps the current Runtime usable when GitHub metadata is unavailable", async () => {
    const fixture = createUpdateFixture();
    const errors: string[] = [];
    const transport: RuntimeMetadataTransport = {
      async get(): Promise<Buffer> {
        throw new Error("GitHub unavailable");
      },
    };
    await expect(
      checkStableRuntimeUpdate({
        ...fixture.context,
        transport,
        onCheckError: (code) => errors.push(code),
      }),
    ).resolves.toBeNull();
    expect(errors).toEqual(["runtime_update_unavailable"]);
  });

  it("rejects invalid signed metadata without requesting the archive", async () => {
    const fixture = createUpdateFixture({ tamperIndexSignature: true });
    const errors: string[] = [];
    await expect(
      checkStableRuntimeUpdate({
        ...fixture.context,
        onCheckError: (code) => errors.push(code),
      }),
    ).resolves.toBeNull();
    expect(errors).toEqual(["runtime_update_metadata_invalid"]);
    expect(fixture.requests).not.toContain(fixture.archiveUrl);
  });

  it.each([
    "http://github.com/bignormal/aera-runtime/releases/download/runtime-v1/asset",
    "https://github.com/other/aera-runtime/releases/download/runtime-v1/asset",
    "https://github.com/bignormal/aera-runtime/releases/latest/download/runtime.zip",
    "https://github.com/bignormal/aera-runtime/releases/download/runtime-v1/asset?token=secret",
  ])("rejects an unapproved Runtime update URL: %s", (value) => {
    expect(() =>
      assertAllowedRuntimeUpdateUrl(new URL(value), "release-asset"),
    ).toThrow(RuntimeUpdateUrlError);
  });

  it("accepts only the reviewed stable-index redirect and exact release assets", () => {
    expect(() =>
      assertAllowedRuntimeUpdateUrl(new URL(LATEST_INDEX_URL), "stable-index"),
    ).not.toThrow();
    expect(() =>
      assertAllowedRuntimeUpdateUrl(
        new URL(`${RELEASE_PREFIX}/${MANIFEST_NAME}`),
        "release-asset",
      ),
    ).not.toThrow();
  });
});
