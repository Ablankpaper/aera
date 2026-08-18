import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ModelConfigurationStage } from "../shared/model-configuration";
import { HERMES_HOME } from "./installer";
import type { ModelConfigurationDatabase } from "./model-configuration-database";
import { profilePaths } from "./utils";

const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/;
const ABSENT_DIGEST = createHash("sha256")
  .update("aera-model-configuration-absent-v1", "utf8")
  .digest("hex");

export type ModelConfigurationFileRole =
  | "env"
  | "providers"
  | "models"
  | "modelDefinitions"
  | "config";

export interface ModelConfigurationFilePaths {
  env: string;
  providers: string;
  models: string;
  modelDefinitions: string;
  config: string;
}

export interface ModelConfigurationFileSnapshot {
  role: ModelConfigurationFileRole;
  path: string;
  backupPath: string;
  existed: boolean;
  mode: number;
  bytes: Buffer;
  digest: string;
}

export interface ModelConfigurationFilesSnapshot {
  operationId: string;
  profileId: string;
  files: Record<ModelConfigurationFileRole, ModelConfigurationFileSnapshot>;
}

export type ModelConfigurationOperationState =
  | "prepared"
  | "credential"
  | "provider"
  | "model_library"
  | "native_route"
  | "activation"
  | "verification"
  | "committed"
  | "rolled_back"
  | "recovery_required";

export interface ModelConfigurationJournalFile {
  role: ModelConfigurationFileRole;
  existed: boolean;
  mode: number;
}

export interface ModelConfigurationOperationRecord {
  operationId: string;
  ownerHandle: string;
  profileId: string;
  state: ModelConfigurationOperationState;
  stage: ModelConfigurationStage;
  oldRouteKey: string;
  newRouteKey: string;
  files: ModelConfigurationJournalFile[];
  beforeDigests: Partial<Record<ModelConfigurationFileRole, string>>;
  afterDigests: Partial<Record<ModelConfigurationFileRole, string>>;
  createdAt: string;
  updatedAt: string;
}

export interface BeginModelConfigurationOperationInput {
  operationId: string;
  ownerHandle: string;
  profileId: string;
  oldRouteKey: string;
  newRouteKey: string;
  snapshot: ModelConfigurationFilesSnapshot;
}

interface OperationRow {
  operation_id?: unknown;
  owner_handle?: unknown;
  profile_id?: unknown;
  state?: unknown;
  stage?: unknown;
  old_route_key?: unknown;
  new_route_key?: unknown;
  old_route_key_hex?: unknown;
  new_route_key_hex?: unknown;
  file_manifest_json?: unknown;
  before_digest_json?: unknown;
  after_digest_json?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

const FILE_ROLES: readonly ModelConfigurationFileRole[] = [
  "env",
  "providers",
  "models",
  "modelDefinitions",
  "config",
];

const OPERATION_STATES: readonly ModelConfigurationOperationState[] = [
  "prepared",
  "credential",
  "provider",
  "model_library",
  "native_route",
  "activation",
  "verification",
  "committed",
  "rolled_back",
  "recovery_required",
];

const OPERATION_STAGES: readonly ModelConfigurationStage[] = [
  "validation",
  "credential",
  "provider",
  "model_library",
  "native_route",
  "activation",
  "verification",
  "rollback",
  "recovery",
];

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function operationId(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) {
    throw new Error("Invalid model configuration operation id.");
  }
  return value.toLowerCase();
}

function profileId(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    throw new Error("Invalid model configuration Profile id.");
  }
  return value;
}

function bounded(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\r\n]/.test(value)
  ) {
    throw new Error(`Invalid model configuration ${label}.`);
  }
  return value;
}

const ROUTE_STORAGE_PREFIX = "b64v1:";
const OWNER_STORAGE_PREFIX = "nulv1:";

function canonicalRouteKey(value: unknown, label: string): string {
  const route = bounded(value, label, 4096);
  if (route.split("\0").length !== 4) {
    throw new Error(`Invalid model configuration ${label}.`);
  }
  return route;
}

function encodeRouteKey(value: unknown, label: string): string {
  const route = canonicalRouteKey(value, label);
  const encoded = `${ROUTE_STORAGE_PREFIX}${Buffer.from(route, "utf8").toString("base64url")}`;
  if (encoded.length > 4096) {
    throw new Error(`Invalid model configuration ${label}.`);
  }
  return encoded;
}

/**
 * SQLite TEXT is binary-safe, but the Node SQLite bindings used by the
 * Desktop truncate a bound/read TEXT value at the first NUL byte. Runtime
 * owner handles deliberately use NUL-separated fields, so encode only that
 * delimiter while retaining a reversible, bounded journal value. Older rows
 * without the prefix remain readable.
 */
function encodeOwnerHandle(value: unknown): string {
  const owner = bounded(value, "owner handle", 512);
  if (!owner.includes("\0")) return owner;
  const encoded = `${OWNER_STORAGE_PREFIX}${owner.replaceAll("\0", "\x1f")}`;
  if (encoded.length > 512 || encoded.includes("\0")) {
    throw new Error("Invalid model configuration owner handle.");
  }
  return encoded;
}

function decodeOwnerHandle(value: unknown): string {
  const stored = bounded(value, "owner handle", 512);
  if (!stored.startsWith(OWNER_STORAGE_PREFIX)) return stored;
  const payload = stored.slice(OWNER_STORAGE_PREFIX.length);
  if (!payload || payload.includes("\0")) {
    throw new Error("Model configuration operation owner handle is corrupt.");
  }
  const decoded = payload.replaceAll("\x1f", "\0");
  return bounded(decoded, "owner handle", 512);
}

function decodeRouteKeyHex(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16_384 ||
    value.length % 2 !== 0 ||
    !/^[0-9A-F]+$/i.test(value)
  ) {
    throw new Error(`Model configuration operation ${label} is corrupt.`);
  }
  const storedBytes = Buffer.from(value, "hex");
  if (storedBytes.toString("hex").toUpperCase() !== value.toUpperCase()) {
    throw new Error(`Model configuration operation ${label} is corrupt.`);
  }
  const stored = storedBytes.toString("utf8");
  if (!storedBytes.equals(Buffer.from(stored, "utf8"))) {
    throw new Error(`Model configuration operation ${label} is corrupt.`);
  }
  if (!stored.startsWith(ROUTE_STORAGE_PREFIX)) {
    // Compatibility for operations written by the unreleased v1 coordinator:
    // SQLite TEXT readers stop at NUL, while hex() preserves the complete
    // canonical identity needed for deterministic recovery.
    return canonicalRouteKey(stored, label);
  }
  const payload = stored.slice(ROUTE_STORAGE_PREFIX.length);
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new Error(`Model configuration operation ${label} is corrupt.`);
  }
  const decodedBytes = Buffer.from(payload, "base64url");
  if (decodedBytes.toString("base64url") !== payload) {
    throw new Error(`Model configuration operation ${label} is corrupt.`);
  }
  const decoded = decodedBytes.toString("utf8");
  if (!decodedBytes.equals(Buffer.from(decoded, "utf8"))) {
    throw new Error(`Model configuration operation ${label} is corrupt.`);
  }
  return canonicalRouteKey(decoded, label);
}

function isoDate(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Model configuration operation timestamp is corrupt.");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Model configuration operation timestamp is corrupt.");
  }
  return value;
}

function parseFiles(value: unknown): ModelConfigurationJournalFile[] {
  if (!Array.isArray(value) || value.length !== FILE_ROLES.length) {
    throw new Error("Model configuration operation manifest is corrupt.");
  }
  const files = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Model configuration operation manifest is corrupt.");
    }
    const record = entry as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("\0") !==
        ["existed", "mode", "role"].sort().join("\0") ||
      !FILE_ROLES.includes(record.role as ModelConfigurationFileRole) ||
      typeof record.existed !== "boolean" ||
      !Number.isSafeInteger(record.mode) ||
      (record.mode as number) < 0 ||
      (record.mode as number) > 0o777
    ) {
      throw new Error("Model configuration operation manifest is corrupt.");
    }
    return {
      role: record.role as ModelConfigurationFileRole,
      existed: record.existed,
      mode: record.mode as number,
    };
  });
  if (new Set(files.map(({ role }) => role)).size !== FILE_ROLES.length) {
    throw new Error("Model configuration operation manifest is corrupt.");
  }
  return files;
}

function parseDigests(
  value: unknown,
): Partial<Record<ModelConfigurationFileRole, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model configuration operation digests are corrupt.");
  }
  const result: Partial<Record<ModelConfigurationFileRole, string>> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      !FILE_ROLES.includes(key as ModelConfigurationFileRole) ||
      typeof item !== "string" ||
      !/^[0-9a-f]{64}$/.test(item)
    ) {
      throw new Error("Model configuration operation digests are corrupt.");
    }
    result[key as ModelConfigurationFileRole] = item;
  }
  return result;
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") {
    throw new Error(`Model configuration operation ${label} is corrupt.`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Model configuration operation ${label} is corrupt.`);
  }
}

function parseOperationRow(
  row: OperationRow | undefined,
): ModelConfigurationOperationRecord | null {
  if (!row) return null;
  const state = row.state as ModelConfigurationOperationState;
  const stage = row.stage as ModelConfigurationStage;
  if (!OPERATION_STATES.includes(state) || !OPERATION_STAGES.includes(stage)) {
    throw new Error("Model configuration operation state is corrupt.");
  }
  return {
    operationId: operationId(row.operation_id),
    ownerHandle: decodeOwnerHandle(row.owner_handle),
    profileId: profileId(row.profile_id),
    state,
    stage,
    oldRouteKey: decodeRouteKeyHex(row.old_route_key_hex, "old route"),
    newRouteKey: decodeRouteKeyHex(row.new_route_key_hex, "new route"),
    files: parseFiles(parseJson(row.file_manifest_json, "manifest")),
    beforeDigests: parseDigests(
      parseJson(row.before_digest_json, "before digests"),
    ),
    afterDigests: parseDigests(
      parseJson(row.after_digest_json, "after digests"),
    ),
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  };
}

export function defaultModelConfigurationFilePaths(
  profile: string,
): ModelConfigurationFilePaths {
  const resolvedProfile = profileId(profile);
  const paths = profilePaths(resolvedProfile);
  return {
    env: paths.envFile,
    providers: join(paths.home, "providers.json"),
    config: paths.configFile,
    models: join(HERMES_HOME, "models.json"),
    modelDefinitions: join(HERMES_HOME, "model-definitions.json"),
  };
}

function normalizedPaths(
  paths: ModelConfigurationFilePaths,
): ModelConfigurationFilePaths {
  const normalized = Object.fromEntries(
    FILE_ROLES.map((role) => {
      const value = paths[role];
      if (typeof value !== "string" || !isAbsolute(value)) {
        throw new Error("Model configuration file path must be absolute.");
      }
      return [role, resolve(value)];
    }),
  ) as unknown as ModelConfigurationFilePaths;
  if (new Set(Object.values(normalized)).size !== FILE_ROLES.length) {
    throw new Error("Model configuration file paths must be distinct.");
  }
  return normalized;
}

export function captureModelConfigurationFiles(input: {
  profileId: string;
  operationId: string;
  paths?: ModelConfigurationFilePaths;
}): ModelConfigurationFilesSnapshot {
  const id = operationId(input.operationId);
  const targetProfileId = profileId(input.profileId);
  const paths = normalizedPaths(
    input.paths ?? defaultModelConfigurationFilePaths(targetProfileId),
  );
  const entries = FILE_ROLES.map((role) => {
    const path = paths[role];
    const existed = existsSync(path);
    if (existed && lstatSync(path).isSymbolicLink()) {
      throw new Error("Model configuration files cannot be symbolic links.");
    }
    const bytes = existed ? readFileSync(path) : Buffer.alloc(0);
    const mode = existed ? statSync(path).mode & 0o777 : 0o600;
    const file: ModelConfigurationFileSnapshot = {
      role,
      path,
      backupPath: `${path}.aera-model-config-backup.${id}`,
      existed,
      mode,
      bytes,
      digest: existed ? digest(bytes) : ABSENT_DIGEST,
    };
    return [role, file] as const;
  });
  return {
    operationId: id,
    profileId: targetProfileId,
    files: Object.fromEntries(entries) as Record<
      ModelConfigurationFileRole,
      ModelConfigurationFileSnapshot
    >,
  };
}

/**
 * Platform boundary for replacing one managed file. The journal is the
 * recovery authority, but the file/parent flushes close the normal crash
 * window on POSIX. Windows does not expose a portable directory-fsync
 * primitive through Node, so its adapter deliberately leaves flushParent as a
 * documented no-op and relies on the journal during restart recovery.
 */
export interface DurableReplaceAdapter {
  writeTemporary(path: string, bytes: Buffer, mode: number): string;
  replace(temporaryPath: string, targetPath: string): void;
  flushTarget(targetPath: string): void;
  flushParent(parentPath: string): void;
}

function temporaryPathFor(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.model-config.tmp`,
  );
}

function writeDurableTemporary(
  path: string,
  bytes: Buffer,
  mode: number,
): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = temporaryPathFor(path);
  const descriptor = openSync(temporaryPath, "wx", mode || 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporaryPath, mode || 0o600);
  return temporaryPath;
}

function replaceDurableTemporary(
  temporaryPath: string,
  targetPath: string,
): void {
  try {
    renameSync(temporaryPath, targetPath);
  } catch (error) {
    // Node's rename can reject an existing target on Windows. Keep the
    // fallback narrowly scoped to the resolved target; callers still verify
    // bytes and the durable journal on restart.
    if (process.platform !== "win32" || !existsSync(targetPath)) throw error;
    unlinkSync(targetPath);
    renameSync(temporaryPath, targetPath);
  }
}

function flushDurableTarget(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function flushDurableParent(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export const defaultDurableReplaceAdapter: DurableReplaceAdapter = {
  writeTemporary: writeDurableTemporary,
  replace: replaceDurableTemporary,
  flushTarget: flushDurableTarget,
  flushParent: flushDurableParent,
};

export function persistModelConfigurationBackups(
  snapshot: ModelConfigurationFilesSnapshot,
  adapter: DurableReplaceAdapter = defaultDurableReplaceAdapter,
): void {
  for (const role of FILE_ROLES) {
    const file = snapshot.files[role];
    if (!file.existed) continue;
    if (existsSync(file.backupPath)) {
      if (digest(readFileSync(file.backupPath)) !== file.digest) {
        throw new Error("Model configuration backup digest mismatch.");
      }
      continue;
    }
    const temporaryPath = adapter.writeTemporary(
      file.backupPath,
      file.bytes,
      0o600,
    );
    try {
      // A concurrent writer may have created the evidence after the initial
      // check. Never overwrite a backup whose digest we did not capture.
      if (existsSync(file.backupPath)) {
        if (digest(readFileSync(file.backupPath)) !== file.digest) {
          throw new Error("Model configuration backup digest mismatch.");
        }
        unlinkSync(temporaryPath);
        continue;
      }
      adapter.replace(temporaryPath, file.backupPath);
      adapter.flushTarget(file.backupPath);
      adapter.flushParent(dirname(file.backupPath));
    } catch (error) {
      if (existsSync(temporaryPath)) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // Preserve the original backup error.
        }
      }
      throw error;
    }
  }
}

function atomicWriteBytes(
  path: string,
  bytes: Buffer,
  mode: number,
  adapter: DurableReplaceAdapter,
): void {
  const temporary = adapter.writeTemporary(path, bytes, mode || 0o600);
  try {
    adapter.replace(temporary, path);
    chmodSync(path, mode || 0o600);
    adapter.flushTarget(path);
    adapter.flushParent(dirname(path));
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function restoreModelConfigurationFiles(
  snapshot: ModelConfigurationFilesSnapshot,
  adapter: DurableReplaceAdapter = defaultDurableReplaceAdapter,
): void {
  for (const role of [...FILE_ROLES].reverse()) {
    const file = snapshot.files[role];
    if (!file.existed) {
      if (existsSync(file.path)) unlinkSync(file.path);
      continue;
    }
    if (!existsSync(file.backupPath)) {
      throw new Error("Model configuration backup is missing.");
    }
    const bytes = readFileSync(file.backupPath);
    if (digest(bytes) !== file.digest) {
      throw new Error("Model configuration backup digest mismatch.");
    }
    atomicWriteBytes(file.path, bytes, file.mode, adapter);
  }
  for (const role of FILE_ROLES) {
    const file = snapshot.files[role];
    const current = existsSync(file.path)
      ? digest(readFileSync(file.path))
      : ABSENT_DIGEST;
    if (current !== file.digest) {
      throw new Error("Model configuration restore verification failed.");
    }
  }
}

export function removeModelConfigurationBackups(
  snapshot: ModelConfigurationFilesSnapshot,
): void {
  for (const role of FILE_ROLES) {
    const path = snapshot.files[role].backupPath;
    if (existsSync(path)) unlinkSync(path);
  }
}

export function readModelConfigurationFileDigests(
  paths: ModelConfigurationFilePaths,
): Record<ModelConfigurationFileRole, string> {
  const normalized = normalizedPaths(paths);
  return Object.fromEntries(
    FILE_ROLES.map((role) => [
      role,
      existsSync(normalized[role])
        ? digest(readFileSync(normalized[role]))
        : ABSENT_DIGEST,
    ]),
  ) as Record<ModelConfigurationFileRole, string>;
}

export class ModelConfigurationOperationStore {
  private readonly database: ModelConfigurationDatabase;
  private readonly now: () => Date;

  constructor(
    database: ModelConfigurationDatabase,
    options: { now?: () => Date } = {},
  ) {
    this.database = database;
    this.now = options.now ?? (() => new Date());
  }

  begin(
    input: BeginModelConfigurationOperationInput,
  ): ModelConfigurationOperationRecord {
    const id = operationId(input.operationId);
    const targetProfileId = profileId(input.profileId);
    if (
      input.snapshot.operationId !== id ||
      input.snapshot.profileId !== targetProfileId
    ) {
      throw new Error("Model configuration snapshot identity mismatch.");
    }
    const files = FILE_ROLES.map((role) => ({
      role,
      existed: input.snapshot.files[role].existed,
      mode: input.snapshot.files[role].mode,
    }));
    const beforeDigests = Object.fromEntries(
      FILE_ROLES.map((role) => [role, input.snapshot.files[role].digest]),
    );
    const timestamp = this.now().toISOString();
    this.database.sqlite
      .prepare(
        `INSERT INTO desktop_model_configuration_operations (
          operation_id, owner_handle, profile_id, state, stage,
          old_route_key, new_route_key, file_manifest_json,
          before_digest_json, after_digest_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'prepared', 'validation', ?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(
        id,
        encodeOwnerHandle(input.ownerHandle),
        targetProfileId,
        encodeRouteKey(input.oldRouteKey, "old route"),
        encodeRouteKey(input.newRouteKey, "new route"),
        JSON.stringify(files),
        JSON.stringify(beforeDigests),
        timestamp,
        timestamp,
      );
    return this.require(id);
  }

  get(id: string): ModelConfigurationOperationRecord | null {
    return parseOperationRow(
      this.database.sqlite
        .prepare(
          `SELECT operation_id, owner_handle, profile_id, state, stage,
                  old_route_key, new_route_key,
                  hex(old_route_key) AS old_route_key_hex,
                  hex(new_route_key) AS new_route_key_hex, file_manifest_json,
                  before_digest_json, after_digest_json, created_at, updated_at
           FROM desktop_model_configuration_operations
           WHERE operation_id = ?`,
        )
        .get(operationId(id)) as OperationRow | undefined,
    );
  }

  require(id: string): ModelConfigurationOperationRecord {
    const record = this.get(id);
    if (!record) throw new Error("Model configuration operation is missing.");
    return record;
  }

  advance(input: {
    operationId: string;
    state: Exclude<
      ModelConfigurationOperationState,
      "prepared" | "committed" | "rolled_back" | "recovery_required"
    >;
    stage: ModelConfigurationStage;
    afterDigests?: Partial<Record<ModelConfigurationFileRole, string>>;
  }): ModelConfigurationOperationRecord {
    const id = operationId(input.operationId);
    if (!OPERATION_STATES.includes(input.state)) {
      throw new Error("Invalid model configuration operation state.");
    }
    if (!OPERATION_STAGES.includes(input.stage)) {
      throw new Error("Invalid model configuration operation stage.");
    }
    const current = this.require(id);
    const afterDigests = {
      ...current.afterDigests,
      ...(input.afterDigests ?? {}),
    };
    parseDigests(afterDigests);
    this.database.sqlite
      .prepare(
        `UPDATE desktop_model_configuration_operations
         SET state = ?, stage = ?, after_digest_json = ?, updated_at = ?
         WHERE operation_id = ?`,
      )
      .run(
        input.state,
        input.stage,
        JSON.stringify(afterDigests),
        this.now().toISOString(),
        id,
      );
    return this.require(id);
  }

  finish(
    idInput: string,
    state: "committed" | "rolled_back" | "recovery_required",
  ): ModelConfigurationOperationRecord {
    const id = operationId(idInput);
    const stage: ModelConfigurationStage =
      state === "committed"
        ? "verification"
        : state === "rolled_back"
          ? "rollback"
          : "recovery";
    this.require(id);
    this.database.sqlite
      .prepare(
        `UPDATE desktop_model_configuration_operations
         SET state = ?, stage = ?, updated_at = ?
         WHERE operation_id = ?`,
      )
      .run(state, stage, this.now().toISOString(), id);
    return this.require(id);
  }

  listIncomplete(): ModelConfigurationOperationRecord[] {
    return (
      this.database.sqlite
        .prepare(
          `SELECT operation_id, owner_handle, profile_id, state, stage,
                  old_route_key, new_route_key,
                  hex(old_route_key) AS old_route_key_hex,
                  hex(new_route_key) AS new_route_key_hex, file_manifest_json,
                  before_digest_json, after_digest_json, created_at, updated_at
           FROM desktop_model_configuration_operations
           WHERE state NOT IN ('committed', 'rolled_back')
           ORDER BY created_at, operation_id`,
        )
        .all() as OperationRow[]
    ).map((row) => parseOperationRow(row)!);
  }
}
