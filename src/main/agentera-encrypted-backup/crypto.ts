import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english.js";

export const AGENTERA_BACKUP_FORMAT_VERSION = 1 as const;
export const AGENTERA_BACKUP_CIPHER_SUITE =
  "HPKE-X25519-HKDF-SHA256-AES256GCM+ARGON2ID+AES256GCM" as const;
export const AGENTERA_BACKUP_ARGON2_MEMORY_KIB = 64 * 1024;
export const AGENTERA_BACKUP_ARGON2_ITERATIONS = 3;
export const AGENTERA_BACKUP_ARGON2_PARALLELISM = 1;

const AES_KEY_BYTES = 32;
const AES_NONCE_BYTES = 12;
const AES_TAG_BYTES = 16;
const X25519_KEY_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const textEncoder = new TextEncoder();
const hpkeSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

export interface RecoveryRootKeyEnvelopeV1 {
  formatVersion: typeof AGENTERA_BACKUP_FORMAT_VERSION;
  kdf: "argon2id";
  memoryKiB: typeof AGENTERA_BACKUP_ARGON2_MEMORY_KIB;
  iterations: typeof AGENTERA_BACKUP_ARGON2_ITERATIONS;
  parallelism: typeof AGENTERA_BACKUP_ARGON2_PARALLELISM;
  salt: string;
  nonce: string;
  ciphertext: string;
}

export interface DeviceRootKeyEnvelopeV1 {
  formatVersion: typeof AGENTERA_BACKUP_FORMAT_VERSION;
  cipherSuite: typeof AGENTERA_BACKUP_CIPHER_SUITE;
  enc: string;
  ciphertext: string;
}

export interface BackupDeviceKeyPair {
  publicKey: string;
  privateKey: string;
}

function copyBytes(
  value: Uint8Array,
  length: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new Error(`Invalid encrypted backup ${label}.`);
  }
  return new Uint8Array(value);
}

function boundedBytes(
  value: Uint8Array,
  minimum: number,
  maximum: number,
  label: string,
): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < minimum ||
    value.byteLength > maximum
  ) {
    throw new Error(`Invalid encrypted backup ${label}.`);
  }
  return new Uint8Array(value);
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`Invalid encrypted backup ${label}.`);
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`Invalid encrypted backup ${label}.`);
  }
  return object;
}

function lineage(value: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Invalid encrypted backup lineage.");
  }
  return value;
}

export function base64urlEncode(
  value: Uint8Array,
  expectedLength?: number,
): string {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    (expectedLength !== undefined && value.byteLength !== expectedLength)
  ) {
    throw new Error("Invalid encrypted backup base64url bytes.");
  }
  return Buffer.from(value).toString("base64url");
}

export function base64urlDecode(
  value: string,
  expectedLength: number,
): Uint8Array {
  if (
    typeof value !== "string" ||
    !Number.isSafeInteger(expectedLength) ||
    expectedLength < 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new Error("Invalid encrypted backup base64url value.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength !== expectedLength ||
    decoded.toString("base64url") !== value
  ) {
    throw new Error("Invalid encrypted backup base64url value.");
  }
  return new Uint8Array(decoded);
}

export function recoveryPhraseFromEntropy(entropyValue: Uint8Array): string {
  const entropy = copyBytes(entropyValue, 32, "recovery entropy");
  try {
    const phrase = entropyToMnemonic(entropy, englishWordlist);
    if (phrase.split(" ").length !== 24) {
      throw new Error("Invalid encrypted backup recovery phrase.");
    }
    return phrase;
  } catch {
    throw new Error("Invalid encrypted backup recovery phrase.");
  } finally {
    entropy.fill(0);
  }
}

export function recoveryEntropyFromPhrase(phrase: string): Uint8Array {
  if (
    typeof phrase !== "string" ||
    phrase.trim() !== phrase ||
    phrase.split(" ").length !== 24 ||
    /\s{2,}/.test(phrase)
  ) {
    throw new Error("Invalid encrypted backup recovery phrase.");
  }
  try {
    const entropy = mnemonicToEntropy(phrase, englishWordlist);
    if (entropy.byteLength !== 32) throw new Error();
    return new Uint8Array(entropy);
  } catch {
    throw new Error("Invalid encrypted backup recovery phrase.");
  }
}

export function backupKdfLabel(
  scope: "root-recovery" | "manifest" | `chunk/${number}` | string,
): string {
  if (
    scope !== "root-recovery" &&
    scope !== "manifest" &&
    !/^chunk\/(?:0|[1-9][0-9]{0,9})$/.test(scope)
  ) {
    throw new Error("Invalid encrypted backup HKDF label.");
  }
  return `agentera-backup-v1/${scope}`;
}

export function deriveBackupSubkey(
  inputKeyValue: Uint8Array,
  saltValue: Uint8Array,
  scope: "root-recovery" | "manifest" | `chunk/${number}` | string,
): Uint8Array {
  const inputKey = copyBytes(inputKeyValue, 32, "input key");
  const salt = boundedBytes(saltValue, 16, 64, "HKDF salt");
  try {
    return new Uint8Array(
      hkdf(
        sha256,
        inputKey,
        salt,
        textEncoder.encode(backupKdfLabel(scope)),
        32,
      ),
    );
  } finally {
    inputKey.fill(0);
    salt.fill(0);
  }
}

export async function deriveRecoveryWrappingKey(
  phrase: string,
  saltValue: Uint8Array,
): Promise<Uint8Array> {
  const entropy = recoveryEntropyFromPhrase(phrase);
  const salt = boundedBytes(saltValue, 16, 32, "Argon2 salt");
  const phraseBytes = textEncoder.encode(phrase);
  let rawKey: Uint8Array | null = null;
  try {
    entropy.fill(0);
    rawKey = new Uint8Array(
      await argon2idAsync(phraseBytes, salt, {
        t: AGENTERA_BACKUP_ARGON2_ITERATIONS,
        m: AGENTERA_BACKUP_ARGON2_MEMORY_KIB,
        p: AGENTERA_BACKUP_ARGON2_PARALLELISM,
        dkLen: 32,
        maxmem: 128 * 1024 * 1024,
      }),
    );
    return deriveBackupSubkey(rawKey, salt, "root-recovery");
  } catch {
    throw new Error("Encrypted backup recovery key derivation failed.");
  } finally {
    phraseBytes.fill(0);
    rawKey?.fill(0);
    salt.fill(0);
  }
}

export function encryptBackupAesGcm(
  keyValue: Uint8Array,
  nonceValue: Uint8Array,
  plaintextValue: Uint8Array,
  aadValue: Uint8Array,
): Uint8Array {
  const key = copyBytes(keyValue, AES_KEY_BYTES, "AES key");
  const nonce = copyBytes(nonceValue, AES_NONCE_BYTES, "AES nonce");
  const plaintext = boundedBytes(
    plaintextValue,
    0,
    1024 * 1024 * 1024,
    "plaintext",
  );
  const aad = boundedBytes(aadValue, 1, 64 * 1024, "associated data");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AES_TAG_BYTES,
    });
    cipher.setAAD(aad);
    return new Uint8Array(
      Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]),
    );
  } finally {
    key.fill(0);
    plaintext.fill(0);
    nonce.fill(0);
    aad.fill(0);
  }
}

export function decryptBackupAesGcm(
  keyValue: Uint8Array,
  nonceValue: Uint8Array,
  ciphertextValue: Uint8Array,
  aadValue: Uint8Array,
): Uint8Array {
  const key = copyBytes(keyValue, AES_KEY_BYTES, "AES key");
  const nonce = copyBytes(nonceValue, AES_NONCE_BYTES, "AES nonce");
  const ciphertext = boundedBytes(
    ciphertextValue,
    AES_TAG_BYTES,
    1024 * 1024 * 1024 + AES_TAG_BYTES,
    "ciphertext",
  );
  const aad = boundedBytes(aadValue, 1, 64 * 1024, "associated data");
  let plaintext: Buffer | null = null;
  try {
    const body = ciphertext.subarray(0, ciphertext.byteLength - AES_TAG_BYTES);
    const tag = ciphertext.subarray(ciphertext.byteLength - AES_TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AES_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    const authenticated = new Uint8Array(plaintext);
    plaintext.fill(0);
    plaintext = null;
    return authenticated;
  } catch {
    plaintext?.fill(0);
    throw new Error("Encrypted backup authentication failed.");
  } finally {
    key.fill(0);
    nonce.fill(0);
    ciphertext.fill(0);
    aad.fill(0);
  }
}

function recoveryAad(lineageId: string): Uint8Array {
  return textEncoder.encode(
    `agentera-backup-v1/root-recovery\0format=${AGENTERA_BACKUP_FORMAT_VERSION}\0lineage=${lineage(lineageId)}`,
  );
}

export async function wrapRootKeyForRecovery(input: {
  rootKey: Uint8Array;
  phrase: string;
  salt: Uint8Array;
  nonce?: Uint8Array;
  lineageId: string;
}): Promise<RecoveryRootKeyEnvelopeV1> {
  const rootKey = copyBytes(input.rootKey, 32, "root key");
  const salt = boundedBytes(input.salt, 16, 32, "Argon2 salt");
  const nonce = input.nonce
    ? copyBytes(input.nonce, AES_NONCE_BYTES, "AES nonce")
    : new Uint8Array(randomBytes(AES_NONCE_BYTES));
  let wrappingKey: Uint8Array | null = null;
  try {
    wrappingKey = await deriveRecoveryWrappingKey(input.phrase, salt);
    const ciphertext = encryptBackupAesGcm(
      wrappingKey,
      nonce,
      rootKey,
      recoveryAad(input.lineageId),
    );
    return Object.freeze({
      formatVersion: AGENTERA_BACKUP_FORMAT_VERSION,
      kdf: "argon2id",
      memoryKiB: AGENTERA_BACKUP_ARGON2_MEMORY_KIB,
      iterations: AGENTERA_BACKUP_ARGON2_ITERATIONS,
      parallelism: AGENTERA_BACKUP_ARGON2_PARALLELISM,
      salt: base64urlEncode(salt),
      nonce: base64urlEncode(nonce, AES_NONCE_BYTES),
      ciphertext: base64urlEncode(ciphertext, 32 + AES_TAG_BYTES),
    });
  } finally {
    rootKey.fill(0);
    salt.fill(0);
    nonce.fill(0);
    wrappingKey?.fill(0);
  }
}

export async function unwrapRootKeyFromRecovery(input: {
  envelope: RecoveryRootKeyEnvelopeV1;
  phrase: string;
  lineageId: string;
}): Promise<Uint8Array> {
  const envelope = exactObject(
    input.envelope,
    [
      "formatVersion",
      "kdf",
      "memoryKiB",
      "iterations",
      "parallelism",
      "salt",
      "nonce",
      "ciphertext",
    ],
    "recovery envelope",
  );
  if (
    envelope.formatVersion !== AGENTERA_BACKUP_FORMAT_VERSION ||
    envelope.kdf !== "argon2id" ||
    envelope.memoryKiB !== AGENTERA_BACKUP_ARGON2_MEMORY_KIB ||
    envelope.iterations !== AGENTERA_BACKUP_ARGON2_ITERATIONS ||
    envelope.parallelism !== AGENTERA_BACKUP_ARGON2_PARALLELISM
  ) {
    throw new Error("Invalid encrypted backup recovery envelope.");
  }
  const salt = base64urlDecode(String(envelope.salt), 16);
  const nonce = base64urlDecode(String(envelope.nonce), AES_NONCE_BYTES);
  const ciphertext = base64urlDecode(
    String(envelope.ciphertext),
    32 + AES_TAG_BYTES,
  );
  let wrappingKey: Uint8Array | null = null;
  try {
    wrappingKey = await deriveRecoveryWrappingKey(input.phrase, salt);
    return decryptBackupAesGcm(
      wrappingKey,
      nonce,
      ciphertext,
      recoveryAad(input.lineageId),
    );
  } catch {
    throw new Error("Encrypted backup authentication failed.");
  } finally {
    salt.fill(0);
    nonce.fill(0);
    ciphertext.fill(0);
    wrappingKey?.fill(0);
  }
}

export async function wrapRootKeyForDevice(
  recipientPublicKey: string,
  rootKeyValue: Uint8Array,
  aadValue: Uint8Array,
): Promise<DeviceRootKeyEnvelopeV1> {
  const publicKeyBytes = base64urlDecode(recipientPublicKey, X25519_KEY_BYTES);
  const rootKey = copyBytes(rootKeyValue, 32, "root key");
  const aad = boundedBytes(aadValue, 1, 64 * 1024, "associated data");
  try {
    const publicKey = await hpkeSuite.kem.deserializePublicKey(publicKeyBytes);
    const sealed = await hpkeSuite.seal(
      { recipientPublicKey: publicKey },
      rootKey,
      aad,
    );
    return Object.freeze({
      formatVersion: AGENTERA_BACKUP_FORMAT_VERSION,
      cipherSuite: AGENTERA_BACKUP_CIPHER_SUITE,
      enc: base64urlEncode(new Uint8Array(sealed.enc), X25519_KEY_BYTES),
      ciphertext: base64urlEncode(
        new Uint8Array(sealed.ct),
        32 + AES_TAG_BYTES,
      ),
    });
  } catch {
    throw new Error("Encrypted backup device wrap failed.");
  } finally {
    publicKeyBytes.fill(0);
    rootKey.fill(0);
    aad.fill(0);
  }
}

export async function generateBackupDeviceKeyPair(): Promise<BackupDeviceKeyPair> {
  let publicKeyBytes: Uint8Array | null = null;
  let privateKeyBytes: Uint8Array | null = null;
  try {
    const keyPair = await hpkeSuite.kem.generateKeyPair();
    publicKeyBytes = new Uint8Array(
      await hpkeSuite.kem.serializePublicKey(keyPair.publicKey),
    );
    privateKeyBytes = new Uint8Array(
      await hpkeSuite.kem.serializePrivateKey(keyPair.privateKey),
    );
    return Object.freeze({
      publicKey: base64urlEncode(publicKeyBytes, X25519_KEY_BYTES),
      privateKey: base64urlEncode(privateKeyBytes, X25519_KEY_BYTES),
    });
  } catch {
    throw new Error("Encrypted backup device key generation failed.");
  } finally {
    publicKeyBytes?.fill(0);
    privateKeyBytes?.fill(0);
  }
}

export async function unwrapRootKeyForDevice(
  recipientPrivateKey: string,
  envelopeValue: DeviceRootKeyEnvelopeV1,
  aadValue: Uint8Array,
): Promise<Uint8Array> {
  const envelope = exactObject(
    envelopeValue,
    ["formatVersion", "cipherSuite", "enc", "ciphertext"],
    "device envelope",
  );
  if (
    envelope.formatVersion !== AGENTERA_BACKUP_FORMAT_VERSION ||
    envelope.cipherSuite !== AGENTERA_BACKUP_CIPHER_SUITE
  ) {
    throw new Error("Invalid encrypted backup device envelope.");
  }
  const privateKeyBytes = base64urlDecode(
    recipientPrivateKey,
    X25519_KEY_BYTES,
  );
  const enc = base64urlDecode(String(envelope.enc), X25519_KEY_BYTES);
  const ciphertext = base64urlDecode(
    String(envelope.ciphertext),
    32 + AES_TAG_BYTES,
  );
  const aad = boundedBytes(aadValue, 1, 64 * 1024, "associated data");
  let raw: Uint8Array | null = null;
  try {
    const privateKey =
      await hpkeSuite.kem.deserializePrivateKey(privateKeyBytes);
    const opened = await hpkeSuite.open(
      { recipientKey: privateKey, enc },
      ciphertext,
      aad,
    );
    raw = new Uint8Array(opened);
    if (raw.byteLength !== 32) throw new Error();
    return new Uint8Array(raw);
  } catch {
    throw new Error("Encrypted backup authentication failed.");
  } finally {
    raw?.fill(0);
    privateKeyBytes.fill(0);
    enc.fill(0);
    ciphertext.fill(0);
    aad.fill(0);
  }
}
