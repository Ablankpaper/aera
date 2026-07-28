import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  TEST_KEY_ID,
  TEST_PRIVATE_KEY,
  writeFixtureBundle,
} from "./fixtures/runtime-distribution/fixture";

const verifier = join(
  process.cwd(),
  "scripts",
  "lib",
  "agentera-runtime-protocol.mjs",
);

function runVerifier(
  bundle: ReturnType<typeof writeFixtureBundle>,
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      verifier,
      "verify",
      "--manifest",
      bundle.manifestPath,
      "--signature",
      bundle.signaturePath,
      "--archive",
      bundle.archivePath,
      "--trust",
      bundle.trustPath,
      "--repository",
      "bignormal/aera-runtime",
      "--platform",
      "darwin",
      "--arch",
      "arm64",
      "--desktop-version",
      "0.7.3",
      "--channel",
      "candidate",
    ],
    { encoding: "utf8" },
  );
}

describe("independent Runtime build verifier", () => {
  it("verifies the producer-compatible fixture without TypeScript imports", () => {
    const bundle = writeFixtureBundle();
    try {
      const result = runVerifier(bundle);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        repository: "bignormal/aera-runtime",
        platform: "darwin",
        arch: "arm64",
        verified: true,
      });
    } finally {
      bundle.cleanup();
    }
  });

  it("fails closed when archive bytes drift", () => {
    const bundle = writeFixtureBundle();
    try {
      const bytes = readFileSync(bundle.archivePath);
      bytes[0] ^= 0xff;
      writeFileSync(bundle.archivePath, bytes);
      const result = runVerifier(bundle);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/archive/i);
    } finally {
      bundle.cleanup();
    }
  });

  it("rejects a private key embedded in the build trust document", () => {
    const bundle = writeFixtureBundle();
    try {
      writeFileSync(
        bundle.trustPath,
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
      );
      const result = runVerifier(bundle);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/public key/i);
    } finally {
      bundle.cleanup();
    }
  });

  it("pins an exact candidate tag, source commit, and native asset set", () => {
    const lock = JSON.parse(
      readFileSync(
        join(process.cwd(), "build", "agentera-runtime-seed.lock.json"),
        "utf8",
      ),
    );
    expect(lock).toMatchObject({
      schema_version: 1,
      repository: "bignormal/aera-runtime",
      release_tag: "runtime-v0.18.2-agentera.1-rc.3",
      source_commit: "06c5e8e76cad15b773f32a2543ddd95bbf2388a6",
      runtime_version: "0.18.2-agentera.1",
      channel: "candidate",
    });
    expect(Object.keys(lock.assets).sort()).toEqual([
      "darwin-arm64",
      "windows-x64",
    ]);
    expect(lock.assets).toEqual({
      "darwin-arm64": {
        platform: "darwin",
        arch: "arm64",
        archive: "agentera-runtime-0.18.2-agentera.1-darwin-arm64.tar.zst",
        manifest:
          "agentera-runtime-0.18.2-agentera.1-darwin-arm64.manifest.json",
        signature:
          "agentera-runtime-0.18.2-agentera.1-darwin-arm64.manifest.sig",
      },
      "windows-x64": {
        platform: "windows",
        arch: "x64",
        archive: "agentera-runtime-0.18.2-agentera.1-windows-x64.zip",
        manifest:
          "agentera-runtime-0.18.2-agentera.1-windows-x64.manifest.json",
        signature:
          "agentera-runtime-0.18.2-agentera.1-windows-x64.manifest.sig",
      },
    });
    expect(JSON.stringify(lock)).not.toMatch(/latest|\/releases\/latest/i);
  });
});
