import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalJsonBytes,
  parseRuntimeManifest,
  verifyRuntimeArtifact,
  verifyRuntimeManifestSignature,
} from "../src/main/agentera-runtime-distribution/manifest";
import {
  loadRuntimeTrustFile,
  parseRuntimeTrustDocument,
} from "../src/main/agentera-runtime-distribution/trust";
import {
  TEST_ARCHIVE_BYTES,
  TEST_KEY_ID,
  TEST_PRIVATE_KEY,
  TEST_PUBLIC_KEY,
  createFixtureManifest,
  createSignedFixture,
  fixtureCanonicalBytes,
  writeFixtureBundle,
} from "./fixtures/runtime-distribution/fixture";

const context = {
  repository: "bignormal/aera-runtime",
  platform: "darwin" as const,
  arch: "arm64" as const,
  desktopVersion: "0.7.3",
  allowedChannels: new Set(["candidate" as const]),
};

const testTrust = new Map([[TEST_KEY_ID, TEST_PUBLIC_KEY]]);

describe("Aera Runtime manifest protocol", () => {
  it("uses the producer canonical JSON representation", () => {
    expect(canonicalJsonBytes({ z: 1, a: { d: 4, b: 2 } })).toEqual(
      Buffer.from('{"a":{"b":2,"d":4},"z":1}'),
    );
    expect(() =>
      parseRuntimeManifest(
        Buffer.from(JSON.stringify(createFixtureManifest(), null, 2)),
      ),
    ).toThrow(/canonical/i);
  });

  it("verifies exact manifest bytes and the matching archive", async () => {
    const fixture = writeFixtureBundle();
    try {
      const verified = await verifyRuntimeArtifact({
        manifestBytes: createSignedFixture().manifestBytes,
        signatureBytes: createSignedFixture().signatureBytes,
        archivePath: fixture.archivePath,
        trustedPublicKeys: testTrust,
        context,
      });
      expect(verified.key_id).toBe(TEST_KEY_ID);
      expect(verified.archive_size).toBe(TEST_ARCHIVE_BYTES.length);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects tampered bytes, unknown keys, and key-id mismatch", () => {
    const { manifestBytes, signatureBytes } = createSignedFixture();
    expect(() =>
      verifyRuntimeManifestSignature({
        manifestBytes: Buffer.concat([manifestBytes, Buffer.from("\n")]),
        signatureBytes,
        trustedPublicKeys: testTrust,
        context,
      }),
    ).toThrow();
    expect(() =>
      verifyRuntimeManifestSignature({
        manifestBytes,
        signatureBytes,
        trustedPublicKeys: new Map(),
        context,
      }),
    ).toThrow(/unknown/i);
    expect(() =>
      verifyRuntimeManifestSignature({
        ...createSignedFixture({ key_id: "agentera-runtime-test-02" }),
        trustedPublicKeys: testTrust,
        context,
      }),
    ).toThrow();
  });

  it.each([
    ["unknown schema", { schema_version: 2 }],
    ["wrong repository", { source_repository: "NousResearch/hermes-agent" }],
    [
      "wrong target",
      {
        platform: "windows",
        arch: "x64",
        archive_name: "agentera-runtime-0.18.2-agentera.1-windows-x64.zip",
      },
    ],
    ["incompatible desktop", { minimum_desktop_version: "0.7.4" }],
    ["short commit", { source_commit: "f".repeat(39) }],
    ["invalid runtime version", { runtime_version: "0.18.2/evil" }],
  ])("rejects %s", (_label, overrides) => {
    const signed = createSignedFixture(overrides);
    expect(() =>
      verifyRuntimeManifestSignature({
        ...signed,
        trustedPublicKeys: testTrust,
        context,
      }),
    ).toThrow();
  });

  it("rejects archive size and hash drift", async () => {
    const fixture = writeFixtureBundle();
    try {
      writeFileSync(fixture.archivePath, Buffer.from("tampered"));
      const signed = createSignedFixture();
      await expect(
        verifyRuntimeArtifact({
          ...signed,
          archivePath: fixture.archivePath,
          trustedPublicKeys: testTrust,
          context,
        }),
      ).rejects.toThrow(/archive/i);
    } finally {
      fixture.cleanup();
    }
  });

  it("requires a sorted unique inventory with real entrypoints", () => {
    const reversed = [...createFixtureManifest().files].reverse();
    const duplicate = [
      ...createFixtureManifest().files,
      { ...createFixtureManifest().files[1] },
    ];
    for (const files of [reversed, duplicate]) {
      expect(() =>
        verifyRuntimeManifestSignature({
          ...createSignedFixture({ files }),
          trustedPublicKeys: testTrust,
          context,
        }),
      ).toThrow(/files|inventory/i);
    }
  });

  it("loads an exact trust schema and production trust rejects the test key", () => {
    const fixtureTrust = parseRuntimeTrustDocument(
      Buffer.from(
        JSON.stringify({
          schema_version: 1,
          keys: [
            {
              key_id: TEST_KEY_ID,
              algorithm: "Ed25519",
              public_key_pem: TEST_PUBLIC_KEY,
            },
          ],
        }),
      ),
    );
    expect(fixtureTrust.get(TEST_KEY_ID)).toBe(TEST_PUBLIC_KEY);
    expect(() =>
      parseRuntimeTrustDocument(
        Buffer.from(
          JSON.stringify({
            schema_version: 1,
            keys: [
              {
                key_id: TEST_KEY_ID,
                algorithm: "Ed25519",
                public_key_pem: TEST_PRIVATE_KEY,
              },
            ],
          }),
        ),
      ),
    ).toThrow(/public key/i);

    const productionTrust = loadRuntimeTrustFile(
      join(process.cwd(), "resources", "agentera-runtime-trust.json"),
    );
    expect([...productionTrust.keys()]).toEqual(["agentera-runtime-2026-01"]);
    expect(productionTrust.has(TEST_KEY_ID)).toBe(false);
    expect(() =>
      verifyRuntimeManifestSignature({
        ...createSignedFixture(),
        trustedPublicKeys: productionTrust,
        context,
      }),
    ).toThrow(/unknown/i);
  });

  it("rejects duplicate JSON keys instead of normalizing them", () => {
    const raw = fixtureCanonicalBytes(createFixtureManifest());
    const duplicate = Buffer.from(
      raw.toString("utf8").replace('{"arch":', '{"arch":"arm64","arch":'),
    );
    expect(() => parseRuntimeManifest(duplicate)).toThrow(/duplicate/i);
  });
});
