import { spawnSync } from "node:child_process";

import type { AgentControlHarness } from "./agentera-agent-control-harness";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OBJECT_KEY_PATTERN =
  /^users\/[0-9a-f-]{36}\/backups\/[0-9a-f-]{36}\/[0-9a-f]{64}$/u;

export interface EncryptedBackupCloudRecord {
  missing: boolean;
  state?: string;
  recoveryEnvelopePresent?: boolean;
  wrappedDataKeyPresent?: boolean;
  activeDeviceEnvelopes?: number;
  destroyedDeviceEnvelopes?: number;
}

export interface EncryptedBackupCloudObjects {
  keys: string[];
  stats: Array<Record<string, unknown>>;
  ciphertext: Buffer;
}

function composeEnvironment(harness: AgentControlHarness): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AERA_CLOUD_POSTGRES_BIND: `127.0.0.1:${harness.postgresPort}`,
    AERA_CLOUD_REDIS_BIND: `127.0.0.1:${harness.redisPort}`,
    AERA_CLOUD_MINIO_BIND: `127.0.0.1:${harness.minioPort}`,
  };
}

function command(
  harness: AgentControlHarness,
  executable: string,
  args: string[],
  options: { encoding?: BufferEncoding | null } = {},
): string | Buffer {
  const encoding = options.encoding === undefined ? "utf8" : options.encoding;
  const result = spawnSync(executable, args, {
    cwd: harness.cloudRoot,
    env: composeEnvironment(harness),
    encoding,
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed\n${String(result.stdout)}\n${String(result.stderr)}`,
    );
  }
  return result.stdout;
}

function compose(
  harness: AgentControlHarness,
  args: string[],
  options: { encoding?: BufferEncoding | null } = {},
): string | Buffer {
  return command(
    harness,
    "docker",
    ["compose", "-p", harness.composeProject, ...args],
    options,
  );
}

function postgres(harness: AgentControlHarness, sql: string): string {
  return String(
    compose(harness, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "aera_cloud",
      "-d",
      "aera_cloud",
      "-Atc",
      sql,
    ]),
  ).trim();
}

function identifier(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error("Encrypted backup E2E identifier is invalid.");
  }
  return value;
}

function objectKey(value: string): string {
  if (!OBJECT_KEY_PATTERN.test(value)) {
    throw new Error("Encrypted backup E2E object key is invalid.");
  }
  return value;
}

function minioShell(
  harness: AgentControlHarness,
  script: string,
  parameters: string[] = [],
  options: { encoding?: BufferEncoding | null } = {},
): string | Buffer {
  return compose(
    harness,
    [
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "/bin/sh",
      "encrypted-backup-minio-init",
      "-ec",
      `mc alias set local http://encrypted-backup-minio:9000 aera-backup-dev aera-backup-dev-only >/dev/null 2>&1\n${script}`,
      "agentera-encrypted-backup-e2e",
      ...parameters,
    ],
    options,
  );
}

export function encryptedBackupPostgresDump(
  harness: AgentControlHarness,
): string {
  return String(
    compose(harness, [
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      "aera_cloud",
      "-d",
      "aera_cloud",
      "--data-only",
      "--table=backup_devices",
      "--table=encrypted_profile_backups",
      "--table=encrypted_backup_chunks",
      "--table=encrypted_backup_key_envelopes",
      "--table=encrypted_backup_operations",
    ]),
  );
}

export function encryptedBackupCloudRecord(
  harness: AgentControlHarness,
  backupIdValue: string,
): EncryptedBackupCloudRecord {
  const backupId = identifier(backupIdValue);
  const output = postgres(
    harness,
    `SELECT COALESCE((
      SELECT json_build_object(
        'missing', false,
        'state', backup.state,
        'recoveryEnvelopePresent', backup.recovery_root_key_envelope IS NOT NULL,
        'wrappedDataKeyPresent', backup.wrapped_data_key IS NOT NULL,
        'activeDeviceEnvelopes', (
          SELECT count(*) FROM encrypted_backup_key_envelopes AS envelope
          WHERE envelope.backup_id = backup.id
            AND envelope.root_key_envelope IS NOT NULL
        ),
        'destroyedDeviceEnvelopes', (
          SELECT count(*) FROM encrypted_backup_key_envelopes AS envelope
          WHERE envelope.backup_id = backup.id
            AND envelope.root_key_envelope IS NULL
            AND envelope.destroyed_at IS NOT NULL
        )
      )
      FROM encrypted_profile_backups AS backup
      WHERE backup.id = '${backupId}'::uuid
    ), '{"missing":true}'::json)::text;`,
  );
  return JSON.parse(output) as EncryptedBackupCloudRecord;
}

export function encryptedBackupObjectKeys(
  harness: AgentControlHarness,
  backupIdValue: string,
): string[] {
  const backupId = identifier(backupIdValue);
  const output = postgres(
    harness,
    `WITH inventory AS (
      SELECT backup.user_id, backup.id AS backup_id,
             backup.manifest_object_key AS object_key
      FROM encrypted_profile_backups AS backup
      WHERE backup.id = '${backupId}'::uuid
        AND backup.manifest_object_key IS NOT NULL
      UNION ALL
      SELECT backup.user_id, chunk.backup_id, chunk.object_key
      FROM encrypted_backup_chunks AS chunk
      JOIN encrypted_profile_backups AS backup ON backup.id = chunk.backup_id
      WHERE chunk.backup_id = '${backupId}'::uuid
    )
    SELECT COALESCE(
      json_agg(
        format('users/%s/backups/%s/%s', user_id, backup_id, object_key)
        ORDER BY object_key
      ),
      '[]'::json
    )::text
    FROM inventory;`,
  );
  const parsed = JSON.parse(output) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.some((value) => typeof value !== "string")
  ) {
    throw new Error("Encrypted backup object inventory is invalid.");
  }
  return parsed.map(objectKey);
}

export function inspectEncryptedBackupObjects(
  harness: AgentControlHarness,
  backupId: string,
): EncryptedBackupCloudObjects {
  const keys = encryptedBackupObjectKeys(harness, backupId);
  const statsOutput = String(
    minioShell(
      harness,
      'for key in "$@"; do mc stat --json "local/aera-encrypted-backups/$key"; done',
      keys,
    ),
  );
  const stats = statsOutput
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  if (stats.length !== keys.length) {
    throw new Error("Encrypted backup MinIO inventory is incomplete.");
  }
  const ciphertext = Buffer.from(
    minioShell(
      harness,
      'for key in "$@"; do mc cat "local/aera-encrypted-backups/$key"; done',
      keys,
      { encoding: null },
    ),
  );
  return { keys, stats, ciphertext };
}

export function encryptedBackupObjectCount(
  harness: AgentControlHarness,
  backupIdValue: string,
): number {
  const backupId = identifier(backupIdValue);
  const output = String(
    minioShell(
      harness,
      'mc find "local/aera-encrypted-backups/users" --type f --json | grep -c "/backups/$1/" || true',
      [backupId],
    ),
  ).trim();
  return Number(output || "0");
}

export function tamperEncryptedBackupObject(
  harness: AgentControlHarness,
  keyValue: string,
): void {
  const key = objectKey(keyValue);
  minioShell(
    harness,
    'printf "tampered-ciphertext-e2e" | mc pipe "local/aera-encrypted-backups/$1" >/dev/null',
    [key],
  );
}

export function stopEncryptedBackupMinIO(harness: AgentControlHarness): void {
  compose(harness, ["stop", "encrypted-backup-minio"]);
}

export function startEncryptedBackupMinIO(harness: AgentControlHarness): void {
  compose(harness, ["up", "-d", "--wait", "encrypted-backup-minio"]);
  compose(harness, ["run", "--rm", "--no-deps", "encrypted-backup-minio-init"]);
}
