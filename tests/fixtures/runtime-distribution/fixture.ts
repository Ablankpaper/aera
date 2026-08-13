import { createHash, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_KEY_ID = "agentera-runtime-test-01";
export const TEST_RUNTIME_VERSION = "0.18.2-agentera.1";
export const TEST_SOURCE_COMMIT = "f".repeat(40);
export const TEST_ARCHIVE_NAME =
  "agentera-runtime-0.18.2-agentera.1-darwin-arm64.tar.zst";
export const TEST_ARCHIVE_BYTES = Buffer.from(
  "agentera-runtime-test-archive\n",
  "utf8",
);

const FIXTURE_DIRECTORY = join(
  process.cwd(),
  "tests",
  "fixtures",
  "runtime-distribution",
);

export const TEST_PRIVATE_KEY = readFileSync(
  join(FIXTURE_DIRECTORY, "test-private.pem"),
  "utf8",
);
export const TEST_PUBLIC_KEY = readFileSync(
  join(FIXTURE_DIRECTORY, "test-public.pem"),
  "utf8",
);

export interface RuntimeFixtureManifest {
  schema_version: number;
  key_id: string;
  runtime_version: string;
  source_repository: string;
  source_commit: string;
  channel: string;
  platform: string;
  arch: string;
  archive_name: string;
  archive_size: number;
  archive_sha256: string;
  python_version: string;
  entrypoints: Record<string, string>;
  minimum_desktop_version: string;
  compatibility_gate_revision: number;
  created_at: string;
  files: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

export function fixtureCanonicalBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(sortJson(value)), "utf8");
}

export function createFixtureManifest(
  overrides: Partial<RuntimeFixtureManifest> = {},
): RuntimeFixtureManifest {
  return {
    schema_version: 1,
    key_id: TEST_KEY_ID,
    runtime_version: TEST_RUNTIME_VERSION,
    source_repository: "Ablankpaper/aera-runtime",
    source_commit: TEST_SOURCE_COMMIT,
    channel: "candidate",
    platform: "darwin",
    arch: "arm64",
    archive_name: TEST_ARCHIVE_NAME,
    archive_size: TEST_ARCHIVE_BYTES.length,
    archive_sha256: createHash("sha256")
      .update(TEST_ARCHIVE_BYTES)
      .digest("hex"),
    python_version: "3.11.15",
    entrypoints: {
      python: "python/bin/python3",
      hermes: "runtime/hermes",
      module: "hermes_cli.main",
    },
    minimum_desktop_version: "0.7.3",
    compatibility_gate_revision: 1,
    created_at: "2026-07-18T04:05:06Z",
    files: [
      {
        path: "python/bin/python3",
        kind: "file",
        size: 17,
        sha256: "a".repeat(64),
        mode: 0o755,
        link_target: null,
      },
      {
        path: "runtime/hermes",
        kind: "file",
        size: 13,
        sha256: "b".repeat(64),
        mode: 0o755,
        link_target: null,
      },
    ],
    ...overrides,
  };
}

export function createSignedFixture(
  overrides: Partial<RuntimeFixtureManifest> = {},
): { manifestBytes: Buffer; signatureBytes: Buffer } {
  const manifestBytes = fixtureCanonicalBytes(createFixtureManifest(overrides));
  const signature = sign(null, manifestBytes, TEST_PRIVATE_KEY);
  const signatureBytes = fixtureCanonicalBytes({
    schema_version: 1,
    key_id: TEST_KEY_ID,
    algorithm: "Ed25519",
    signature_base64: signature.toString("base64"),
  });
  return { manifestBytes, signatureBytes };
}

export function writeFixtureBundle(
  overrides: Partial<RuntimeFixtureManifest> = {},
): {
  directory: string;
  archivePath: string;
  manifestPath: string;
  signaturePath: string;
  trustPath: string;
  cleanup: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "agentera-runtime-fixture-"));
  const { manifestBytes, signatureBytes } = createSignedFixture(overrides);
  const archivePath = join(directory, TEST_ARCHIVE_NAME);
  const manifestPath = join(directory, `${TEST_ARCHIVE_NAME}.manifest.json`);
  const signaturePath = join(directory, `${TEST_ARCHIVE_NAME}.manifest.sig`);
  const trustPath = join(directory, "trust.json");
  writeFileSync(archivePath, TEST_ARCHIVE_BYTES);
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(signaturePath, signatureBytes);
  writeFileSync(
    trustPath,
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
  );
  return {
    directory,
    archivePath,
    manifestPath,
    signaturePath,
    trustPath,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
