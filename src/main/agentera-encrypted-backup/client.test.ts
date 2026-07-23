// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgenteraEncryptedBackupClient,
  AgenteraEncryptedBackupClientError,
} from "./client";
import type {
  EncryptedBackupArchive,
  EncryptedBackupInitiateRequest,
  EncryptedBackupObjectSpec,
} from "./archive";

const BACKUP_ID = "70000000-0000-4000-8000-000000000001";
const roots: string[] = [];

function requestFixture(): EncryptedBackupInitiateRequest {
  return {
    envelope: {
      format_version: 1,
      cipher_suite: "HPKE-X25519-HKDF-SHA256-AES256GCM+ARGON2ID+AES256GCM",
      backup_id: BACKUP_ID,
      profile_lineage_id: "30000000-0000-4000-8000-000000000001",
      parent_backup_id: null,
      source_device_id: "20000000-0000-4000-8000-000000000001",
      source_installation_id: "40000000-0000-4000-8000-000000000001",
      source_definition_id: "50000000-0000-4000-8000-000000000001",
      source_version_id: "60000000-0000-4000-8000-000000000001",
      base_owner_scope: "USER",
      key_epoch: 1,
      created_at: "2026-07-23T12:00:00.000Z",
      manifest: {
        object_id: "a".repeat(64),
        ciphertext_digest: Buffer.alloc(32, 0x11).toString("base64url"),
        ciphertext_size: 64,
      },
      chunks: [0, 1].map((index) => ({
        index,
        object_id: (index + 1).toString(16).repeat(64),
        ciphertext_digest: Buffer.alloc(32, index + 1).toString("base64url"),
        ciphertext_size: 64,
      })),
      total_ciphertext_size: 128,
      recovery_envelope_digest: Buffer.alloc(32, 0x12).toString("base64url"),
      wrapped_data_key_digest: Buffer.alloc(32, 0x13).toString("base64url"),
      source_device_envelope_digest: Buffer.alloc(32, 0x14).toString(
        "base64url",
      ),
    },
    signature: Buffer.alloc(64, 0x15).toString("base64url"),
    recovery: {
      salt: Buffer.alloc(16, 0x16).toString("base64url"),
      memory_kib: 65536,
      iterations: 3,
      parallelism: 1,
    },
    recovery_root_key_envelope: Buffer.alloc(64, 0x17).toString("base64url"),
    wrapped_data_key: Buffer.alloc(64, 0x18).toString("base64url"),
    source_device_root_key_envelope: Buffer.alloc(64, 0x19).toString(
      "base64url",
    ),
  };
}

function archiveFixture(): EncryptedBackupArchive {
  const root = mkdtempSync(join(tmpdir(), "agentera-backup-client-"));
  roots.push(root);
  const manifestPath = join(root, "manifest.bin");
  const chunkPaths = [join(root, "chunk-0.bin"), join(root, "chunk-1.bin")];
  const manifestBytes = Buffer.alloc(64, 0x21);
  const chunkBytes = [Buffer.alloc(64, 0x22), Buffer.alloc(64, 0x23)];
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(chunkPaths[0], chunkBytes[0]);
  writeFileSync(chunkPaths[1], chunkBytes[1]);
  const request = requestFixture();
  const object = (bytes: Buffer): EncryptedBackupObjectSpec => {
    const digest = createHash("sha256").update(bytes).digest();
    return {
      object_id: digest.toString("hex"),
      ciphertext_digest: digest.toString("base64url"),
      ciphertext_size: bytes.byteLength,
    };
  };
  request.envelope.manifest = object(manifestBytes);
  request.envelope.chunks = chunkBytes.map((bytes, index) => ({
    index,
    ...object(bytes),
  }));
  request.envelope.total_ciphertext_size = chunkBytes.reduce(
    (size, bytes) => size + bytes.byteLength,
    0,
  );
  return {
    backupId: BACKUP_ID,
    ciphertextPath: root,
    manifest: {
      path: manifestPath,
      object: request.envelope.manifest,
      plaintextSize: 36,
    },
    chunks: request.envelope.chunks.map((object, index) => ({
      index,
      path: chunkPaths[index],
      object,
      plaintextSize: 36,
    })),
    initiateRequest: request,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgenteraEncryptedBackupClient", () => {
  it("initiates, resumes only missing ciphertext, and sends exact binary headers", async () => {
    const requests: Array<{
      url: string;
      method: string;
      headers: Headers;
      body: BodyInit | null | undefined;
    }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      if (String(input).endsWith("/seal")) {
        return Response.json({
          backup_id: BACKUP_ID,
          state: "sealed",
          sealed_at: "2026-07-23T12:01:00Z",
          replayed: false,
        });
      }
      if (String(input).endsWith("/devices/current")) {
        return Response.json({
          device_id: "20000000-0000-4000-8000-000000000001",
          key_epoch: 1,
          revision: 1,
          status: "active",
          replayed: false,
        });
      }
      if ((init?.method ?? "GET") === "POST") {
        return Response.json(
          {
            backup_id: BACKUP_ID,
            state: "initiated",
            upload_expires_at: "2026-07-24T12:00:00Z",
            replayed: false,
          },
          { status: 201 },
        );
      }
      return new Response(null, { status: 204 });
    });
    const client = new AgenteraEncryptedBackupClient({
      origin: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetcher,
    });
    const archive = archiveFixture();

    await expect(
      client.registerCurrentDevice({
        key_epoch: 1,
        revision: 1,
        public_key: Buffer.alloc(32, 0x41).toString("base64url"),
        signature: Buffer.alloc(64, 0x42).toString("base64url"),
      }),
    ).resolves.toMatchObject({
      deviceId: "20000000-0000-4000-8000-000000000001",
      status: "active",
    });
    await expect(
      client.initiate(archive.initiateRequest),
    ).resolves.toMatchObject({ backupId: BACKUP_ID, state: "initiated" });
    await client.uploadArchive(archive, {
      uploadedChunkIndexes: [0],
      manifestUploaded: true,
    });
    await expect(client.seal(BACKUP_ID)).resolves.toMatchObject({
      state: "sealed",
    });

    const binary = requests.filter(
      (request) =>
        request.method === "PUT" &&
        request.headers.get("content-type") === "application/octet-stream",
    );
    expect(binary).toHaveLength(1);
    expect(binary[0].url).toContain(`/chunks/1`);
    expect(binary[0].headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(binary[0].headers.get("x-agentera-ciphertext-size")).toBe("64");
    expect(binary[0].headers.get("x-agentera-ciphertext-sha256")).toBe(
      archive.chunks[1].object.ciphertext_digest,
    );
    expect(binary[0].headers.get("authorization")).toBe("Bearer access-token");
    const registration = requests.find((request) =>
      request.url.endsWith("/devices/current"),
    );
    expect(registration?.method).toBe("PUT");
    expect(registration?.headers.get("content-type")).toBe("application/json");
  });

  it("maps quota and expired uploads to stable retry decisions", async () => {
    const responses = [
      Response.json({ error: "quota_exceeded" }, { status: 413 }),
      Response.json({ error: "upload_expired" }, { status: 410 }),
    ];
    const client = new AgenteraEncryptedBackupClient({
      origin: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: vi.fn(async () => responses.shift()!),
    });
    await expect(client.initiate(requestFixture())).rejects.toMatchObject({
      status: 413,
      code: "quota_exceeded",
      retryable: false,
    });
    await expect(client.uploadArchive(archiveFixture())).rejects.toMatchObject({
      status: 410,
      code: "upload_expired",
      restartRequired: true,
    });
  });

  it("cancels the remaining upload when logout changes the access token", async () => {
    let token: string | null = "access-token";
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      calls += 1;
      token = null;
      return new Response(null, { status: 204 });
    });
    const client = new AgenteraEncryptedBackupClient({
      origin: "https://cloud.example.com",
      getAccessToken: () => token,
      fetch: fetcher,
    });
    await expect(client.uploadArchive(archiveFixture())).rejects.toBeInstanceOf(
      AgenteraEncryptedBackupClientError,
    );
    expect(calls).toBe(1);
  });
});
