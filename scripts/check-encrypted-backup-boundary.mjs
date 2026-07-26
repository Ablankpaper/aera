/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function isCloudRepository(path) {
  try {
    const marker = await readFile(resolve(path, "go.mod"), "utf8");
    return marker.includes("module github.com/bignormal/aera-cloud");
  } catch {
    return false;
  }
}

async function resolveCloudRoot() {
  const configured = process.env.AERA_ENCRYPTED_BACKUP_CLOUD_REPO?.trim();
  const candidates = [
    configured,
    resolve(desktopRoot, "../aera-cloud"),
    resolve(desktopRoot, "../../../aera-cloud"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (await isCloudRepository(resolved)) return resolved;
  }
  throw new Error(
    "Encrypted backup boundary failed: set AERA_ENCRYPTED_BACKUP_CLOUD_REPO to the matching aera-cloud checkout.",
  );
}

function fail(message) {
  throw new Error(`Encrypted backup boundary failed: ${message}`);
}

function sourceColumns(sql) {
  const tables = new Map();
  for (const match of sql.matchAll(
    /CREATE TABLE ([a-z][a-z0-9_]*) \(\n([\s\S]*?)\n\);/g,
  )) {
    const columns = match[2]
      .split("\n")
      .map((line) => line.match(/^ {4}([a-z][a-z0-9_]*)\s+/)?.[1] ?? null)
      .filter(Boolean);
    tables.set(match[1], columns);
  }
  return tables;
}

const cloudRoot = await resolveCloudRoot();
const cloudMigrationPath = resolve(
  cloudRoot,
  "migrations/000018_e2ee_profile_backup_v1.sql",
);
const cloudObjectStorePath = resolve(
  cloudRoot,
  "internal/encryptedbackup/object_store.go",
);
const cloudMinIOPath = resolve(
  cloudRoot,
  "internal/encryptedbackup/minio_store.go",
);
const desktopSnapshotPath = resolve(
  desktopRoot,
  "src/main/agentera-encrypted-backup/snapshot.ts",
);

await Promise.all([
  access(cloudMigrationPath),
  access(cloudObjectStorePath),
  access(cloudMinIOPath),
  access(desktopSnapshotPath),
]);

const [migration, objectStore, minioStore, snapshot] = await Promise.all([
  readFile(cloudMigrationPath, "utf8"),
  readFile(cloudObjectStorePath, "utf8"),
  readFile(cloudMinIOPath, "utf8"),
  readFile(desktopSnapshotPath, "utf8"),
]);

const expectedTables = [
  "backup_devices",
  "encrypted_profile_backups",
  "encrypted_backup_chunks",
  "encrypted_backup_key_envelopes",
  "encrypted_backup_operations",
];
const columnsByTable = sourceColumns(migration);
for (const table of expectedTables) {
  if (!columnsByTable.has(table)) fail(`Cloud table ${table} is missing`);
}

const forbiddenColumnFragments = [
  "plaintext",
  "filename",
  "file_path",
  "profile_path",
  "recovery_phrase",
  "device_private_key",
  "data_encryption_key",
  "manifest_json",
  "content_json",
  "prompt",
  "response",
  "memory",
  "session",
  "skill",
  "credential",
];
let cloudColumnCount = 0;
for (const [table, columns] of columnsByTable) {
  if (!expectedTables.includes(table)) continue;
  cloudColumnCount += columns.length;
  for (const column of columns) {
    const forbidden = forbiddenColumnFragments.find((fragment) =>
      column.includes(fragment),
    );
    if (forbidden && column !== "recovery_memory_kib") {
      fail(`Cloud column ${table}.${column} contains ${forbidden}`);
    }
  }
}

for (const required of [
  "manifest_ciphertext_digest",
  "manifest_ciphertext_size",
  "recovery_root_key_envelope",
  "wrapped_data_key",
  "root_key_envelope_digest",
  "ciphertext_digest",
  "ciphertext_size",
]) {
  if (!migration.includes(required)) {
    fail(`Cloud ciphertext field ${required} is missing`);
  }
}

if (
  !objectStore.includes('"users/%s/backups/%s/%s"') ||
  !objectStore.includes("ciphertextObjectIDPattern") ||
  objectStore.includes("filename") ||
  objectStore.includes("profilePath")
) {
  fail("MinIO object keys are not server-owned opaque identifiers");
}
const metadataMatch = minioStore.match(
  /UserMetadata:\s*map\[string\]string\{([\s\S]*?)\n\s*\},/,
);
if (
  !metadataMatch ||
  !metadataMatch[1].includes("ciphertextDigestMetadataKey") ||
  /filename|profile|phrase|root|dek|content/iu.test(metadataMatch[1])
) {
  fail("MinIO user metadata is not digest-only");
}
if (
  !minioStore.includes(
    'const ciphertextDigestMetadataKey = "ciphertext-sha256"',
  ) ||
  !minioStore.includes('ContentType: "application/octet-stream"')
) {
  fail("MinIO ciphertext metadata contract changed");
}

if (/\brunHermesBackup\b/u.test(snapshot)) {
  fail("Desktop snapshot calls the broad Hermes backup path");
}
const forbiddenSegmentsMatch = snapshot.match(
  /const FORBIDDEN_SEGMENTS = new Set\(\[([\s\S]*?)\]\);/,
);
if (
  !forbiddenSegmentsMatch ||
  !forbiddenSegmentsMatch[1].includes('".env"') ||
  !forbiddenSegmentsMatch[1].includes('"auth.json"')
) {
  fail("Desktop snapshot no longer explicitly excludes .env and auth.json");
}
const sourceInventoryMatch = snapshot.match(
  /function collectSourceFiles\([\s\S]*?\n\}/,
);
if (!sourceInventoryMatch) fail("Desktop snapshot inventory is not static");
for (const forbidden of [
  '".env"',
  '"auth.json"',
  '"credentials"',
  '"runtime"',
  '"logs"',
]) {
  if (sourceInventoryMatch[0].includes(forbidden)) {
    fail(`Desktop snapshot inventory includes forbidden source ${forbidden}`);
  }
}
for (const required of [
  '"memories/MEMORY.md"',
  '"memories/USER.md"',
  '"state.db"',
  '"skills"',
  '"provenance/runtime-bindings.enc"',
]) {
  if (!snapshot.includes(required)) {
    fail(`Desktop snapshot allowlist is missing ${required}`);
  }
}

console.log(
  `Encrypted backup boundary verified: ${expectedTables.length} Cloud tables, ${cloudColumnCount} ciphertext/public-metadata columns, digest-only MinIO metadata, and a fixed Desktop allowlist.`,
);
