// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AGENTERA_BACKUP_CIPHER_SUITE,
  AGENTERA_BACKUP_FORMAT_VERSION,
  backupKdfLabel,
  base64urlDecode,
  base64urlEncode,
  decryptBackupAesGcm,
  decryptRuntimeBindingProvenance,
  deriveBackupSubkey,
  deriveRecoveryWrappingKey,
  encryptBackupAesGcm,
  encryptRuntimeBindingProvenance,
  recoveryEntropyFromPhrase,
  recoveryPhraseFromEntropy,
  unwrapRootKeyForDevice,
  unwrapRootKeyFromRecovery,
  wrapRootKeyForDevice,
  wrapRootKeyForRecovery,
} from "./crypto";

interface CryptoVector {
  formatVersion: number;
  cipherSuite: string;
  entropyHex: string;
  phrase: string;
  argonSaltHex: string;
  argonRawHex: string;
  recoveryKekHex: string;
  rootKeyHex: string;
  hkdfSaltHex: string;
  manifestKeyHex: string;
  chunk7KeyHex: string;
  nonceHex: string;
  lineageId: string;
  aesAad: string;
  aesPlaintext: string;
  aesCiphertextHex: string;
  recoveryCiphertextHex: string;
  hpkePublicKeyHex: string;
  hpkePrivateKeyHex: string;
}

const vector = JSON.parse(
  readFileSync(join(__dirname, "fixtures/crypto-v1.json"), "utf8"),
) as CryptoVector;
const bytes = (hex: string): Uint8Array => Buffer.from(hex, "hex");
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("AgentEra encrypted backup crypto v1", () => {
  it("locks format, suite, BIP39 entropy, and strict base64url encoding", () => {
    expect(AGENTERA_BACKUP_FORMAT_VERSION).toBe(vector.formatVersion);
    expect(AGENTERA_BACKUP_CIPHER_SUITE).toBe(vector.cipherSuite);
    const entropy = bytes(vector.entropyHex);
    expect(recoveryPhraseFromEntropy(entropy)).toBe(vector.phrase);
    expect(hex(recoveryEntropyFromPhrase(vector.phrase))).toBe(
      vector.entropyHex,
    );
    expect(() =>
      recoveryEntropyFromPhrase(vector.phrase.replace(/ art$/, " abandon")),
    ).toThrow(/recovery phrase/i);

    const encoded = base64urlEncode(entropy, 32);
    expect(hex(base64urlDecode(encoded, 32))).toBe(vector.entropyHex);
    expect(() => base64urlDecode(`${encoded}=`, 32)).toThrow(/base64url/i);
    expect(() => base64urlDecode(encoded.slice(1), 32)).toThrow(/base64url/i);
  });

  it("uses the fixed Argon2id cost and recovery HKDF label", async () => {
    expect(backupKdfLabel("root-recovery")).toBe(
      "agentera-backup-v1/root-recovery",
    );
    const key = await deriveRecoveryWrappingKey(
      vector.phrase,
      bytes(vector.argonSaltHex),
    );
    try {
      expect(hex(key)).toBe(vector.recoveryKekHex);
    } finally {
      key.fill(0);
    }
  }, 30_000);

  it("derives stable, domain-separated manifest and chunk keys", () => {
    const rootKey = bytes(vector.rootKeyHex);
    const salt = bytes(vector.hkdfSaltHex);
    const manifest = deriveBackupSubkey(rootKey, salt, "manifest");
    const chunk = deriveBackupSubkey(rootKey, salt, "chunk/7");
    try {
      expect(hex(manifest)).toBe(vector.manifestKeyHex);
      expect(hex(chunk)).toBe(vector.chunk7KeyHex);
      expect(hex(manifest)).not.toBe(hex(chunk));
      expect(backupKdfLabel("manifest")).toBe("agentera-backup-v1/manifest");
      expect(backupKdfLabel("chunk/7")).toBe("agentera-backup-v1/chunk/7");
      expect(() => backupKdfLabel("chunk/-1")).toThrow(/label/i);
    } finally {
      manifest.fill(0);
      chunk.fill(0);
      rootKey.fill(0);
    }
  });

  it("authenticates AES-256-GCM plaintext and associated data", () => {
    const key = bytes(vector.manifestKeyHex);
    const nonce = bytes(vector.nonceHex);
    const plaintext = utf8(vector.aesPlaintext);
    const aad = utf8(vector.aesAad);
    const ciphertext = encryptBackupAesGcm(key, nonce, plaintext, aad);
    expect(hex(ciphertext)).toBe(vector.aesCiphertextHex);
    expect(
      new TextDecoder().decode(
        decryptBackupAesGcm(key, nonce, ciphertext, aad),
      ),
    ).toBe(vector.aesPlaintext);

    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 1;
    expect(() => decryptBackupAesGcm(key, nonce, tampered, aad)).toThrow(
      /authentication/i,
    );
    expect(() =>
      decryptBackupAesGcm(key, nonce, ciphertext, utf8(`${vector.aesAad}!`)),
    ).toThrow(/authentication/i);
  });

  it("encrypts RuntimeBinding provenance under a lineage-separated root-key domain", () => {
    const rootKey = bytes(vector.rootKeyHex);
    const plaintext = utf8(
      '{"sourceInstallationId":"private-canary","bindings":[]}',
    );
    const envelope = encryptRuntimeBindingProvenance({
      rootKey,
      profileLineageId: vector.lineageId,
      plaintext,
      nonce: bytes(vector.nonceHex),
    });
    const serialized = Buffer.from(JSON.stringify(envelope), "utf8");
    expect(serialized.includes(Buffer.from("private-canary"))).toBe(false);
    expect(backupKdfLabel("runtime-binding-provenance")).toBe(
      "agentera-backup-v1/runtime-binding-provenance",
    );
    const opened = decryptRuntimeBindingProvenance({
      rootKey,
      profileLineageId: vector.lineageId,
      envelope,
    });
    try {
      expect(new TextDecoder().decode(opened)).toContain("private-canary");
      expect(() =>
        decryptRuntimeBindingProvenance({
          rootKey,
          profileLineageId: "11111111-1111-4111-8111-111111111112",
          envelope,
        }),
      ).toThrow(/authentication/i);
    } finally {
      rootKey.fill(0);
      plaintext.fill(0);
      opened.fill(0);
      serialized.fill(0);
    }
  });

  // @lat: [[lat.md/agentera-post-official-delivery#AgentEra post-official delivery program#End-to-end encrypted backup V1#Local encrypted-backup acceptance evidence]]
  it("wraps the root key for phrase recovery with lineage-bound AAD", async () => {
    const rootKey = bytes(vector.rootKeyHex);
    const envelope = await wrapRootKeyForRecovery({
      rootKey,
      phrase: vector.phrase,
      salt: bytes(vector.argonSaltHex),
      nonce: bytes(vector.nonceHex),
      lineageId: vector.lineageId,
    });
    expect(hex(base64urlDecode(envelope.ciphertext, 48))).toBe(
      vector.recoveryCiphertextHex,
    );
    const unwrapped = await unwrapRootKeyFromRecovery({
      envelope,
      phrase: vector.phrase,
      lineageId: vector.lineageId,
    });
    try {
      expect(hex(unwrapped)).toBe(vector.rootKeyHex);
    } finally {
      unwrapped.fill(0);
      rootKey.fill(0);
    }
    await expect(
      unwrapRootKeyFromRecovery({
        envelope,
        phrase: vector.phrase,
        lineageId: "11111111-1111-4111-8111-111111111112",
      }),
    ).rejects.toThrow(/authentication/i);
  }, 90_000);

  it("uses RFC 9180 X25519, HKDF-SHA256, and AES-256-GCM device envelopes", async () => {
    const publicKey = base64urlEncode(bytes(vector.hpkePublicKeyHex), 32);
    const privateKey = base64urlEncode(bytes(vector.hpkePrivateKeyHex), 32);
    const rootKey = bytes(vector.rootKeyHex);
    const aad = utf8(`${vector.lineageId}:1`);
    const envelope = await wrapRootKeyForDevice(publicKey, rootKey, aad);
    expect(base64urlDecode(envelope.enc, 32)).toHaveLength(32);
    expect(base64urlDecode(envelope.ciphertext, 48)).toHaveLength(48);
    const unwrapped = await unwrapRootKeyForDevice(privateKey, envelope, aad);
    try {
      expect(hex(unwrapped)).toBe(vector.rootKeyHex);
    } finally {
      unwrapped.fill(0);
      rootKey.fill(0);
    }

    const tampered = {
      ...envelope,
      ciphertext: base64urlEncode(
        Uint8Array.from(base64urlDecode(envelope.ciphertext, 48), (value, i) =>
          i === 0 ? value ^ 1 : value,
        ),
        48,
      ),
    };
    await expect(
      unwrapRootKeyForDevice(privateKey, tampered, aad),
    ).rejects.toThrow(/authentication/i);
  });
});
