// @vitest-environment node

import { createHash, randomBytes } from "node:crypto";
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
import { brotliDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  base64urlDecode,
  base64urlEncode,
  unwrapBackupDataKey,
  wrapBackupDataKey,
  type DeviceRootKeyEnvelopeV1,
  type RecoveryRootKeyEnvelopeV1,
} from "./crypto";
import {
  createEncryptedBackupSnapshotManifest,
  serializeEncryptedBackupSnapshotManifest,
  type EncryptedBackupSnapshotFile,
} from "./manifest";
import {
  AGENTERA_ENCRYPTED_BACKUP_CHUNK_BYTES,
  createEncryptedBackupArchive,
  decryptEncryptedBackupChunk,
  decryptEncryptedBackupManifest,
  encryptedBackupPublicEnvelopeSigningDigest,
  type EncryptedBackupArchive,
} from "./archive";
import type { EncryptedBackupSnapshot } from "./snapshot";

const PROFILE_LINEAGE_ID = "30000000-0000-4000-8000-000000000001";
const INSTALLATION_ID = "40000000-0000-4000-8000-000000000001";
const DEFINITION_ID = "50000000-0000-4000-8000-000000000001";
const VERSION_ID = "60000000-0000-4000-8000-000000000001";
const DEVICE_ID = "20000000-0000-4000-8000-000000000001";
const BACKUP_ID = "70000000-0000-4000-8000-000000000001";
const ROOT_KEY = Buffer.alloc(32, 0x51);
const roots: string[] = [];

const recoveryEnvelope: RecoveryRootKeyEnvelopeV1 = {
  formatVersion: 1,
  kdf: "argon2id",
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 1,
  salt: Buffer.alloc(16, 0x61).toString("base64url"),
  nonce: Buffer.alloc(12, 0x62).toString("base64url"),
  ciphertext: Buffer.alloc(48, 0x63).toString("base64url"),
};
const sourceDeviceEnvelope: DeviceRootKeyEnvelopeV1 = {
  formatVersion: 1,
  cipherSuite: "HPKE-X25519-HKDF-SHA256-AES256GCM+ARGON2ID+AES256GCM",
  enc: Buffer.alloc(32, 0x64).toString("base64url"),
  ciphertext: Buffer.alloc(48, 0x65).toString("base64url"),
};

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotFixture(contents: readonly Buffer[]): {
  snapshot: EncryptedBackupSnapshot;
  concatenated: Buffer;
} {
  const root = mkdtempSync(join(tmpdir(), "agentera-backup-archive-"));
  roots.push(root);
  const transactionPath = join(root, "transaction");
  const filesPath = join(transactionPath, "plaintext");
  mkdirSync(filesPath, { recursive: true, mode: 0o700 });
  const files: EncryptedBackupSnapshotFile[] = contents.map(
    (content, index) => {
      const relativePath = `files/${index.toString().padStart(2, "0")}.bin`;
      const path = join(filesPath, ...relativePath.split("/"));
      mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(path, content, { mode: 0o600 });
      return {
        path: relativePath,
        kind: "managed_attachment",
        modeClass: "owner-read-write",
        size: content.byteLength,
        sha256: sha256(content),
      };
    },
  );
  const manifest = createEncryptedBackupSnapshotManifest({
    profileLineageId: PROFILE_LINEAGE_ID,
    createdAt: new Date("2026-07-23T12:00:00.000Z"),
    provenance: {
      sourceInstallationId: INSTALLATION_ID,
      sourceDefinitionId: DEFINITION_ID,
      sourceVersionId: VERSION_ID,
      baseOwnerScope: "USER",
    },
    files,
  });
  const manifestBytes = serializeEncryptedBackupSnapshotManifest(manifest);
  const manifestPath = join(transactionPath, "manifest.json");
  writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
  return {
    snapshot: {
      transactionId: "71000000-0000-4000-8000-000000000001",
      transactionPath,
      filesPath,
      manifestPath,
      manifest,
      manifestBytes,
    },
    concatenated: Buffer.concat(contents),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgentEra encrypted backup archive", () => {
  it("streams canonical files into fixed 8 MiB independently encrypted chunks", async () => {
    const contents = [
      Buffer.from("private-canary-before-random\n"),
      randomBytes(AGENTERA_ENCRYPTED_BACKUP_CHUNK_BYTES + 257),
    ];
    const fixture = snapshotFixture(contents);
    let capturedDataKey: Buffer | null = null;
    let signedDigest: Uint8Array | null = null;
    let nonceCounter = 0;
    const archive = await createEncryptedBackupArchive({
      snapshot: fixture.snapshot,
      sourceDeviceId: DEVICE_ID,
      keyEpoch: 1,
      parentBackupId: null,
      recoveryRootKeyEnvelope: recoveryEnvelope,
      sourceDeviceRootKeyEnvelope: sourceDeviceEnvelope,
      wrapDataKey: async ({ backupId, dataKey }) => {
        capturedDataKey = Buffer.from(dataKey);
        return wrapBackupDataKey(ROOT_KEY, dataKey, backupId, {
          nonce: Buffer.alloc(12, 0x70),
        });
      },
      signDigest: (digest) => {
        signedDigest = new Uint8Array(digest);
        return Buffer.alloc(64, 0x71).toString("base64url");
      },
      randomUUID: () => BACKUP_ID,
      randomBytes: (size) => Buffer.alloc(size, (0x80 + nonceCounter++) & 0xff),
      now: () => new Date("2026-07-23T12:00:00.000Z"),
    });

    expect(archive.chunks.length).toBeGreaterThan(1);
    expect(
      archive.chunks
        .slice(0, -1)
        .every(
          (chunk) =>
            chunk.plaintextSize === AGENTERA_ENCRYPTED_BACKUP_CHUNK_BYTES,
        ),
    ).toBe(true);
    expect(
      new Set(archive.chunks.map((chunk) => chunk.object.object_id)).size,
    ).toBe(archive.chunks.length);
    expect(
      new Set(
        archive.chunks.map((chunk) =>
          readFileSync(chunk.path).subarray(0, 12).toString("hex"),
        ),
      ).size,
    ).toBe(archive.chunks.length);
    expect(Buffer.from(signedDigest!)).toEqual(
      Buffer.from(
        encryptedBackupPublicEnvelopeSigningDigest(
          archive.initiateRequest.envelope,
        ),
      ),
    );

    const wrapped = JSON.parse(
      Buffer.from(
        archive.initiateRequest.wrapped_data_key,
        "base64url",
      ).toString("utf8"),
    );
    const unwrapped = unwrapBackupDataKey(ROOT_KEY, wrapped, BACKUP_ID);
    expect(Buffer.from(unwrapped)).toEqual(capturedDataKey);
    unwrapped.fill(0);

    const manifestPlaintext = decryptEncryptedBackupManifest({
      dataKey: capturedDataKey!,
      backupId: BACKUP_ID,
      object: archive.manifest,
    });
    expect(Buffer.from(manifestPlaintext)).toEqual(
      fixture.snapshot.manifestBytes,
    );
    manifestPlaintext.fill(0);

    const compressed = Buffer.concat(
      archive.chunks.map((chunk) =>
        Buffer.from(
          decryptEncryptedBackupChunk({
            dataKey: capturedDataKey!,
            backupId: BACKUP_ID,
            manifestCiphertextDigest: archive.manifest.object.ciphertext_digest,
            chunk,
          }),
        ),
      ),
    );
    const restored = brotliDecompressSync(compressed);
    expect(restored.byteLength).toBe(fixture.concatenated.byteLength);
    expect(sha256(restored)).toBe(sha256(fixture.concatenated));
    restored.fill(0);
    compressed.fill(0);
    if (capturedDataKey !== null) {
      (capturedDataKey as Buffer).fill(0);
    }

    expect(existsSync(fixture.snapshot.filesPath)).toBe(false);
    const ciphertext = Buffer.concat([
      readFileSync(archive.manifest.path),
      ...archive.chunks.map((chunk) => readFileSync(chunk.path)),
    ]);
    expect(ciphertext.includes(Buffer.from("private-canary"))).toBe(false);
  }, 30_000);

  it("rejects reorder, duplication, truncation, and tampering", async () => {
    const fixture = snapshotFixture([
      randomBytes(AGENTERA_ENCRYPTED_BACKUP_CHUNK_BYTES + 64),
    ]);
    let dataKey = Buffer.alloc(0);
    const archive = await createEncryptedBackupArchive({
      snapshot: fixture.snapshot,
      sourceDeviceId: DEVICE_ID,
      keyEpoch: 1,
      parentBackupId: null,
      recoveryRootKeyEnvelope: recoveryEnvelope,
      sourceDeviceRootKeyEnvelope: sourceDeviceEnvelope,
      wrapDataKey: async ({ backupId, dataKey: value }) => {
        dataKey = Buffer.from(value);
        return wrapBackupDataKey(ROOT_KEY, value, backupId);
      },
      signDigest: () => Buffer.alloc(64, 0x72).toString("base64url"),
      randomUUID: () => BACKUP_ID,
    });
    expect(archive.chunks).toHaveLength(2);

    expect(() =>
      decryptEncryptedBackupChunk({
        dataKey,
        backupId: BACKUP_ID,
        manifestCiphertextDigest: archive.manifest.object.ciphertext_digest,
        chunk: { ...archive.chunks[0], index: 1 },
      }),
    ).toThrow();
    expect(() =>
      decryptEncryptedBackupChunk({
        dataKey,
        backupId: BACKUP_ID,
        manifestCiphertextDigest: archive.manifest.object.ciphertext_digest,
        chunk: {
          ...archive.chunks[0],
          object: { ...archive.chunks[1].object },
          path: archive.chunks[1].path,
        },
      }),
    ).toThrow();

    const original = readFileSync(archive.chunks[0].path);
    writeFileSync(archive.chunks[0].path, original.subarray(0, -1));
    expect(() =>
      decryptEncryptedBackupChunk({
        dataKey,
        backupId: BACKUP_ID,
        manifestCiphertextDigest: archive.manifest.object.ciphertext_digest,
        chunk: archive.chunks[0],
      }),
    ).toThrow();
    const tampered = Buffer.from(original);
    tampered[20] ^= 1;
    writeFileSync(archive.chunks[0].path, tampered);
    expect(() =>
      decryptEncryptedBackupChunk({
        dataKey,
        backupId: BACKUP_ID,
        manifestCiphertextDigest: archive.manifest.object.ciphertext_digest,
        chunk: archive.chunks[0],
      }),
    ).toThrow();
    dataKey.fill(0);
  });

  it("binds all opaque envelopes and exact public metadata without plaintext fields", async () => {
    const fixture = snapshotFixture([Buffer.from("small private state")]);
    const archive: EncryptedBackupArchive = await createEncryptedBackupArchive({
      snapshot: fixture.snapshot,
      sourceDeviceId: DEVICE_ID,
      keyEpoch: 3,
      parentBackupId: null,
      recoveryRootKeyEnvelope: recoveryEnvelope,
      sourceDeviceRootKeyEnvelope: sourceDeviceEnvelope,
      wrapDataKey: ({ backupId, dataKey }) =>
        wrapBackupDataKey(ROOT_KEY, dataKey, backupId),
      signDigest: () => Buffer.alloc(64, 0x73).toString("base64url"),
      randomUUID: () => BACKUP_ID,
    });
    const request = archive.initiateRequest;
    expect(request.envelope).toMatchObject({
      format_version: 1,
      backup_id: BACKUP_ID,
      profile_lineage_id: PROFILE_LINEAGE_ID,
      source_device_id: DEVICE_ID,
      source_installation_id: INSTALLATION_ID,
      source_definition_id: DEFINITION_ID,
      source_version_id: VERSION_ID,
      base_owner_scope: "USER",
      key_epoch: 3,
      created_at: "2026-07-23T12:00:00.000Z",
    });
    expect(request.envelope.total_ciphertext_size).toBe(
      archive.chunks.reduce(
        (sum, chunk) => sum + chunk.object.ciphertext_size,
        0,
      ),
    );
    expect(
      base64urlDecode(request.envelope.recovery_envelope_digest, 32),
    ).toHaveLength(32);
    expect(
      base64urlDecode(request.envelope.wrapped_data_key_digest, 32),
    ).toHaveLength(32);
    expect(
      base64urlDecode(request.envelope.source_device_envelope_digest, 32),
    ).toHaveLength(32);
    const serialized = JSON.stringify(request);
    for (const forbidden of [
      "private state",
      "files/00.bin",
      "recoveryPhrase",
      "rootKey",
      "dataKey",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(
      base64urlEncode(Buffer.from(request.signature, "base64url"), 64),
    ).toBe(request.signature);
  });
});
