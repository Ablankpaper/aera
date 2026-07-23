export const AGENTERA_ENCRYPTED_BACKUP_SNAPSHOT_VERSION = 1 as const;
export const AGENTERA_ENCRYPTED_BACKUP_MAXIMUM_BYTES = 1024 * 1024 * 1024;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const FILE_KINDS = new Set<EncryptedBackupSnapshotFileKind>([
  "memory",
  "user",
  "session_database",
  "private_skill",
  "curator",
  "profile_configuration",
  "managed_attachment",
  "runtime_binding_provenance",
]);
const FORBIDDEN_RESTORE_SEGMENTS = new Set([
  ".env",
  "auth.json",
  "credentials",
  "credentials.json",
  ".ssh",
  ".usage.json",
  "cache",
  ".cache",
  "logs",
  "log",
  "tmp",
  "temp",
  "runtime",
  "projections",
  "gateway.pid",
  "gateway.log",
  "dashboard.log",
]);

export type EncryptedBackupSnapshotFileKind =
  | "memory"
  | "user"
  | "session_database"
  | "private_skill"
  | "curator"
  | "profile_configuration"
  | "managed_attachment"
  | "runtime_binding_provenance";

export interface EncryptedBackupSnapshotFile {
  path: string;
  kind: EncryptedBackupSnapshotFileKind;
  modeClass: "owner-read-write";
  size: number;
  sha256: string;
}

export interface EncryptedBackupSnapshotProvenance {
  sourceInstallationId: string;
  sourceDefinitionId: string;
  sourceVersionId: string;
  baseOwnerScope: "USER";
}

export interface EncryptedBackupSnapshotManifest {
  formatVersion: typeof AGENTERA_ENCRYPTED_BACKUP_SNAPSHOT_VERSION;
  profileLineageId: string;
  createdAt: string;
  provenance: EncryptedBackupSnapshotProvenance;
  files: readonly EncryptedBackupSnapshotFile[];
  totalPlaintextSize: number;
}

function uuid(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    throw new Error(`Invalid encrypted backup snapshot ${label}.`);
  }
  return value;
}

function canonicalTime(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid encrypted backup snapshot time.");
  }
  return value.toISOString();
}

export function createEncryptedBackupSnapshotManifest(input: {
  profileLineageId: string;
  createdAt: Date;
  provenance: EncryptedBackupSnapshotProvenance;
  files: readonly EncryptedBackupSnapshotFile[];
}): EncryptedBackupSnapshotManifest {
  const profileLineageId = uuid(input.profileLineageId, "profile lineage ID");
  const provenance: EncryptedBackupSnapshotProvenance = {
    sourceInstallationId: uuid(
      input.provenance.sourceInstallationId,
      "source Installation ID",
    ),
    sourceDefinitionId: uuid(
      input.provenance.sourceDefinitionId,
      "source Definition ID",
    ),
    sourceVersionId: uuid(
      input.provenance.sourceVersionId,
      "source Version ID",
    ),
    baseOwnerScope:
      input.provenance.baseOwnerScope === "USER"
        ? "USER"
        : (() => {
            throw new Error("Invalid encrypted backup snapshot owner scope.");
          })(),
  };
  const files = [...input.files]
    .map((file): EncryptedBackupSnapshotFile => {
      if (
        typeof file.path !== "string" ||
        file.path.length < 1 ||
        file.path !== file.path.normalize("NFC") ||
        !FILE_KINDS.has(file.kind) ||
        file.modeClass !== "owner-read-write" ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !DIGEST_PATTERN.test(file.sha256)
      ) {
        throw new Error("Invalid encrypted backup snapshot file.");
      }
      return {
        path: file.path,
        kind: file.kind,
        modeClass: "owner-read-write",
        size: file.size,
        sha256: file.sha256,
      };
    })
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  const totalPlaintextSize = files.reduce((sum, file) => sum + file.size, 0);
  if (
    !Number.isSafeInteger(totalPlaintextSize) ||
    totalPlaintextSize > AGENTERA_ENCRYPTED_BACKUP_MAXIMUM_BYTES
  ) {
    throw new Error("Encrypted backup snapshot is too large.");
  }
  return Object.freeze({
    formatVersion: AGENTERA_ENCRYPTED_BACKUP_SNAPSHOT_VERSION,
    profileLineageId,
    createdAt: canonicalTime(input.createdAt),
    provenance: Object.freeze(provenance),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    totalPlaintextSize,
  });
}

export function serializeEncryptedBackupSnapshotManifest(
  manifest: EncryptedBackupSnapshotManifest,
): Buffer {
  const canonical = {
    formatVersion: manifest.formatVersion,
    profileLineageId: manifest.profileLineageId,
    createdAt: manifest.createdAt,
    provenance: {
      sourceInstallationId: manifest.provenance.sourceInstallationId,
      sourceDefinitionId: manifest.provenance.sourceDefinitionId,
      sourceVersionId: manifest.provenance.sourceVersionId,
      baseOwnerScope: manifest.provenance.baseOwnerScope,
    },
    files: manifest.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      modeClass: file.modeClass,
      size: file.size,
      sha256: file.sha256,
    })),
    totalPlaintextSize: manifest.totalPlaintextSize,
  };
  return Buffer.from(JSON.stringify(canonical), "utf8");
}

function exactObject(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Invalid encrypted backup snapshot manifest.");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  const expected = [...fields].sort();
  if (
    keys.length !== expected.length ||
    keys.some((field, index) => field !== expected[index])
  ) {
    throw new Error("Invalid encrypted backup snapshot manifest.");
  }
  return object;
}

function validRestoredPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1024 ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    value !== value.normalize("NFC") ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => {
    const folded = segment.toLocaleLowerCase("en-US");
    return (
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !FORBIDDEN_RESTORE_SEGMENTS.has(folded) &&
      !folded.endsWith(".pem") &&
      !folded.endsWith(".key")
    );
  });
}

function pathMatchesKind(
  path: string,
  kind: EncryptedBackupSnapshotFileKind,
): boolean {
  switch (kind) {
    case "memory":
      return path === "memories/MEMORY.md";
    case "user":
      return path === "memories/USER.md";
    case "session_database":
      return path === "state.db";
    case "profile_configuration":
      return path === "config.yaml";
    case "runtime_binding_provenance":
      return path === "provenance/runtime-bindings.enc";
    case "private_skill":
      return path.startsWith("skills/");
    case "curator":
      return path.startsWith("curator/") || path.startsWith(".curator/");
    case "managed_attachment":
      return path.startsWith("files/");
  }
}

export function parseEncryptedBackupSnapshotManifest(
  bytesValue: Uint8Array,
): EncryptedBackupSnapshotManifest {
  if (
    !(bytesValue instanceof Uint8Array) ||
    bytesValue.byteLength < 2 ||
    bytesValue.byteLength > 16 * 1024 * 1024
  ) {
    throw new Error("Invalid encrypted backup snapshot manifest.");
  }
  const bytes = Buffer.from(bytesValue);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    bytes.fill(0);
    throw new Error("Invalid encrypted backup snapshot manifest.");
  }
  try {
    const manifest = exactObject(parsed, [
      "formatVersion",
      "profileLineageId",
      "createdAt",
      "provenance",
      "files",
      "totalPlaintextSize",
    ]);
    const provenance = exactObject(manifest.provenance, [
      "sourceInstallationId",
      "sourceDefinitionId",
      "sourceVersionId",
      "baseOwnerScope",
    ]);
    if (
      manifest.formatVersion !== AGENTERA_ENCRYPTED_BACKUP_SNAPSHOT_VERSION ||
      typeof manifest.createdAt !== "string" ||
      new Date(manifest.createdAt).toISOString() !== manifest.createdAt ||
      !Array.isArray(manifest.files)
    ) {
      throw new Error("Invalid encrypted backup snapshot manifest.");
    }
    const files = manifest.files.map((value) => {
      const file = exactObject(value, [
        "path",
        "kind",
        "modeClass",
        "size",
        "sha256",
      ]);
      if (
        !validRestoredPath(file.path) ||
        !FILE_KINDS.has(file.kind as EncryptedBackupSnapshotFileKind) ||
        !pathMatchesKind(
          file.path,
          file.kind as EncryptedBackupSnapshotFileKind,
        )
      ) {
        throw new Error("Invalid encrypted backup snapshot file.");
      }
      return {
        path: file.path,
        kind: file.kind as EncryptedBackupSnapshotFileKind,
        modeClass: file.modeClass as "owner-read-write",
        size: Number(file.size),
        sha256: String(file.sha256),
      };
    });
    const exactPaths = new Set<string>();
    const foldedPaths = new Set<string>();
    for (const file of files) {
      const folded = file.path.toLocaleLowerCase("en-US");
      if (exactPaths.has(file.path) || foldedPaths.has(folded)) {
        throw new Error("Invalid encrypted backup snapshot path collision.");
      }
      exactPaths.add(file.path);
      foldedPaths.add(folded);
    }
    const restored = createEncryptedBackupSnapshotManifest({
      profileLineageId: String(manifest.profileLineageId),
      createdAt: new Date(manifest.createdAt),
      provenance: {
        sourceInstallationId: String(provenance.sourceInstallationId),
        sourceDefinitionId: String(provenance.sourceDefinitionId),
        sourceVersionId: String(provenance.sourceVersionId),
        baseOwnerScope: provenance.baseOwnerScope as "USER",
      },
      files,
    });
    if (
      manifest.totalPlaintextSize !== restored.totalPlaintextSize ||
      !serializeEncryptedBackupSnapshotManifest(restored).equals(bytes)
    ) {
      throw new Error("Invalid encrypted backup snapshot manifest.");
    }
    return restored;
  } catch {
    throw new Error("Invalid encrypted backup snapshot manifest.");
  } finally {
    bytes.fill(0);
  }
}
