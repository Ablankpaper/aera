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
