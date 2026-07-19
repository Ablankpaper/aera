import { randomUUID as nodeRandomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentPolicySnapshot, AgentVersion } from "./client";
import type { AgenteraControlPlaneDatabase } from "./db";
import { parseAgentControlJsonObject } from "./manifest";
import {
  AgenteraAgentTrustError,
  canonicalizeAgentVersionContent,
} from "./trust";

export type AgentVersionCacheErrorCode =
  | "cache_not_found"
  | "cache_conflict"
  | "cache_corrupt"
  | "cache_permissions_invalid";

export class AgentVersionCacheError extends Error {
  readonly code: AgentVersionCacheErrorCode;

  constructor(code: AgentVersionCacheErrorCode) {
    super(`AgentEra Agent version cache failed: ${code}.`);
    this.name = "AgentVersionCacheError";
    this.code = code;
  }
}

export interface AgentVersionCacheOptions {
  database: AgenteraControlPlaneDatabase;
  trust: AgentVersionCacheTrust;
  origin: string;
  runtimeVersion: string;
  now?: () => Date;
  randomUUID?: () => string;
  rename?: (source: string, destination: string) => void;
}

export interface AgentVersionCacheTrust {
  verifyVersion(
    version: AgentVersion,
    context: { issuer: string; runtimeVersion: string },
  ): { contentDigest: string };
  verifyPolicy(
    policy: AgentPolicySnapshot,
    context: { runtimeVersion: string },
  ): { contentDigest: string };
}

interface CachedVersionRow {
  version_id: unknown;
  definition_id: unknown;
  version_number: unknown;
  content_digest: unknown;
  version_json: unknown;
  policy_snapshot_json: unknown;
  cache_relative_path: unknown;
  verified_at: unknown;
}

interface CachedPolicyCollection {
  schema_version: 1;
  snapshots: AgentPolicySnapshot[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const MAX_VERSION_FILE_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_FILE_BYTES = 256 * 1024;
const MAX_BUNDLE_FILE_BYTES = 3 * 1024 * 1024;
const MAX_POLICY_CACHE_BYTES = 4 * 1024 * 1024;

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => allowed.has(field))
  );
}

function parseStoredVersion(raw: Buffer): AgentVersion {
  let value: Record<string, unknown>;
  try {
    value = parseAgentControlJsonObject(raw, MAX_VERSION_FILE_BYTES);
  } catch {
    throw new AgentVersionCacheError("cache_corrupt");
  }
  if (
    !exactKeys(
      value,
      [
        "id",
        "definition_id",
        "version_number",
        "manifest",
        "bundle",
        "content_digest",
        "signing_key_id",
        "signature",
        "runtime_minimum_version",
        "published_at",
      ],
      ["runtime_maximum_version_exclusive"],
    ) ||
    !validUuid(value.id) ||
    !validUuid(value.definition_id) ||
    !Number.isSafeInteger(value.version_number) ||
    (value.version_number as number) < 1 ||
    value.manifest === null ||
    typeof value.manifest !== "object" ||
    Array.isArray(value.manifest) ||
    value.bundle === null ||
    typeof value.bundle !== "object" ||
    Array.isArray(value.bundle) ||
    typeof value.content_digest !== "string" ||
    !DIGEST_PATTERN.test(value.content_digest) ||
    typeof value.signing_key_id !== "string" ||
    !KEY_ID_PATTERN.test(value.signing_key_id) ||
    typeof value.signature !== "string" ||
    !SIGNATURE_PATTERN.test(value.signature) ||
    typeof value.runtime_minimum_version !== "string" ||
    value.runtime_minimum_version.length === 0 ||
    value.runtime_minimum_version.length > 64 ||
    (value.runtime_maximum_version_exclusive !== undefined &&
      (typeof value.runtime_maximum_version_exclusive !== "string" ||
        value.runtime_maximum_version_exclusive.length === 0 ||
        value.runtime_maximum_version_exclusive.length > 64)) ||
    !validTimestamp(value.published_at)
  ) {
    throw new AgentVersionCacheError("cache_corrupt");
  }
  return JSON.parse(JSON.stringify(value)) as AgentVersion;
}

function readBounded(path: string, maximumBytes: number): Buffer {
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size < 1 ||
    stats.size > maximumBytes
  ) {
    throw new AgentVersionCacheError("cache_corrupt");
  }
  if (process.platform !== "win32" && (stats.mode & 0o222) !== 0) {
    throw new AgentVersionCacheError("cache_permissions_invalid");
  }
  const bytes = readFileSync(path);
  if (bytes.length !== stats.size) {
    throw new AgentVersionCacheError("cache_corrupt");
  }
  return bytes;
}

function isContained(root: string, child: string): boolean {
  const childRelative = relative(root, child);
  return (
    childRelative === "" ||
    (!childRelative.startsWith("..") && !isAbsolute(childRelative))
  );
}

function writeAndSync(path: string, bytes: Buffer): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is unavailable on some supported filesystems/platforms.
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function removeOwnedCacheTree(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    rmSync(path, { force: true });
    return;
  }
  if (!stats.isDirectory()) {
    chmodSync(path, 0o600);
    rmSync(path, { force: true });
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) {
    removeOwnedCacheTree(join(path, name));
  }
  rmSync(path, { recursive: true, force: true });
}

function nowTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AgentVersionCacheError("cache_corrupt");
  }
  return value.toISOString();
}

function parsePolicyCollection(value: unknown): CachedPolicyCollection {
  if (value === null) return { schema_version: 1, snapshots: [] };
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_POLICY_CACHE_BYTES
  ) {
    throw new AgentVersionCacheError("cache_corrupt");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AgentVersionCacheError("cache_corrupt");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !exactKeys(parsed as Record<string, unknown>, [
      "schema_version",
      "snapshots",
    ]) ||
    (parsed as { schema_version?: unknown }).schema_version !== 1 ||
    !Array.isArray((parsed as { snapshots?: unknown }).snapshots) ||
    (parsed as { snapshots: unknown[] }).snapshots.length > 256
  ) {
    throw new AgentVersionCacheError("cache_corrupt");
  }
  const snapshots = (parsed as { snapshots: unknown[] }).snapshots;
  if (
    snapshots.some(
      (snapshot) =>
        !snapshot ||
        typeof snapshot !== "object" ||
        Array.isArray(snapshot) ||
        !validUuid((snapshot as { id?: unknown }).id),
    ) ||
    new Set(snapshots.map((snapshot) => (snapshot as { id: string }).id))
      .size !== snapshots.length
  ) {
    throw new AgentVersionCacheError("cache_corrupt");
  }
  return {
    schema_version: 1,
    snapshots: JSON.parse(JSON.stringify(snapshots)) as AgentPolicySnapshot[],
  };
}

function stableJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.keys(candidate)
          .sort()
          .map((key) => [
            key,
            normalize((candidate as Record<string, unknown>)[key]),
          ]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

export class AgentVersionCache {
  private readonly database: AgenteraControlPlaneDatabase;
  private readonly trust: AgentVersionCacheTrust;
  private readonly origin: string;
  private readonly runtimeVersion: string;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly rename: (source: string, destination: string) => void;

  constructor(options: AgentVersionCacheOptions) {
    if (
      typeof options.origin !== "string" ||
      options.origin.length === 0 ||
      typeof options.runtimeVersion !== "string" ||
      options.runtimeVersion.length === 0
    ) {
      throw new Error("AgentEra Agent version cache configuration is invalid.");
    }
    this.database = options.database;
    this.trust = options.trust;
    this.origin = options.origin;
    this.runtimeVersion = options.runtimeVersion;
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.rename = options.rename ?? renameSync;
  }

  cacheVerifiedVersion(input: AgentVersion): AgentVersion {
    const version = parseStoredVersion(
      Buffer.from(JSON.stringify(input), "utf8"),
    );
    const verified = this.trust.verifyVersion(version, {
      issuer: this.origin,
      runtimeVersion: this.runtimeVersion,
    });
    const canonical = canonicalizeAgentVersionContent(version);
    if (
      verified.contentDigest !== version.content_digest ||
      canonical.contentDigest !== version.content_digest
    ) {
      throw new AgenteraAgentTrustError("digest_mismatch");
    }

    const existing = this.database.sqlite
      .prepare(
        "SELECT content_digest FROM cached_agent_versions WHERE version_id = ?",
      )
      .get(version.id) as { content_digest?: unknown } | undefined;
    if (existing) {
      if (existing.content_digest !== version.content_digest) {
        throw new AgentVersionCacheError("cache_conflict");
      }
      return this.getVerifiedVersion(version.id);
    }

    const versionRoot = join(this.database.paths.versionsPath, version.id);
    const destination = join(versionRoot, version.content_digest);
    if (existsSync(destination)) {
      throw new AgentVersionCacheError("cache_conflict");
    }
    mkdirSync(versionRoot, { recursive: true, mode: 0o700 });
    const stagingId = this.randomUUID();
    if (!validUuid(stagingId)) {
      throw new AgentVersionCacheError("cache_corrupt");
    }
    const staging = join(versionRoot, `.staging-${stagingId.toLowerCase()}`);
    mkdirSync(staging, { mode: 0o700 });
    let renamed = false;
    try {
      const versionBytes = Buffer.from(JSON.stringify(version), "utf8");
      writeAndSync(join(staging, "version.json"), versionBytes);
      writeAndSync(join(staging, "manifest.json"), canonical.manifestBytes);
      writeAndSync(join(staging, "bundle.json"), canonical.bundleBytes);
      this.verifyDirectory(staging, version.id, version.content_digest, false);
      fsyncDirectory(staging);
      for (const name of ["version.json", "manifest.json", "bundle.json"]) {
        chmodSync(join(staging, name), 0o400);
      }
      chmodSync(staging, 0o500);
      this.rename(staging, destination);
      renamed = true;
      fsyncDirectory(versionRoot);
      const finalized = this.verifyDirectory(
        destination,
        version.id,
        version.content_digest,
        true,
      );

      const relativePath = `${version.id}/${version.content_digest}`;
      this.database.sqlite.exec("BEGIN IMMEDIATE");
      try {
        this.database.sqlite
          .prepare(
            `INSERT INTO cached_agent_versions (
               version_id, definition_id, version_number, content_digest,
               version_json, policy_snapshot_json, cache_relative_path,
               verified_at
             ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            version.id,
            version.definition_id,
            version.version_number,
            version.content_digest,
            JSON.stringify(version),
            relativePath,
            nowTimestamp(this.now),
          );
        this.database.sqlite.exec("COMMIT");
      } catch (error) {
        try {
          this.database.sqlite.exec("ROLLBACK");
        } catch {
          // Preserve the primary database failure.
        }
        throw error;
      }
      return finalized;
    } catch (error) {
      removeOwnedCacheTree(renamed ? destination : staging);
      throw error;
    }
  }

  getVerifiedVersion(versionIdInput: string): AgentVersion {
    if (!validUuid(versionIdInput)) {
      throw new AgentVersionCacheError("cache_not_found");
    }
    const versionId = versionIdInput.toLowerCase();
    const row = this.database.sqlite
      .prepare("SELECT * FROM cached_agent_versions WHERE version_id = ?")
      .get(versionId) as CachedVersionRow | undefined;
    if (!row) throw new AgentVersionCacheError("cache_not_found");
    if (
      row.version_id !== versionId ||
      !validUuid(row.definition_id) ||
      !Number.isSafeInteger(row.version_number) ||
      (row.version_number as number) < 1 ||
      typeof row.content_digest !== "string" ||
      !DIGEST_PATTERN.test(row.content_digest) ||
      typeof row.version_json !== "string" ||
      typeof row.cache_relative_path !== "string" ||
      row.cache_relative_path !== `${versionId}/${row.content_digest}` ||
      !validTimestamp(row.verified_at)
    ) {
      throw new AgentVersionCacheError("cache_corrupt");
    }
    const directory = join(
      this.database.paths.versionsPath,
      versionId,
      row.content_digest,
    );
    let version: AgentVersion;
    try {
      version = this.verifyDirectory(
        directory,
        versionId,
        row.content_digest,
        true,
      );
      if (JSON.stringify(version) !== row.version_json) {
        throw new AgentVersionCacheError("cache_corrupt");
      }
    } catch (error) {
      if (error instanceof AgentVersionCacheError) throw error;
      throw new AgentVersionCacheError("cache_corrupt");
    }
    return version;
  }

  cacheVerifiedPolicySnapshot(
    versionIdInput: string,
    policyInput: AgentPolicySnapshot,
  ): AgentPolicySnapshot {
    const versionId = validUuid(versionIdInput)
      ? versionIdInput.toLowerCase()
      : "";
    if (versionId.length === 0) {
      throw new AgentVersionCacheError("cache_not_found");
    }
    const version = this.getVerifiedVersion(versionId);
    const policy = this.verifyPolicyForVersion(policyInput, version, false);

    this.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.sqlite
        .prepare(
          "SELECT policy_snapshot_json FROM cached_agent_versions WHERE version_id = ?",
        )
        .get(versionId) as { policy_snapshot_json?: unknown } | undefined;
      if (!row) throw new AgentVersionCacheError("cache_not_found");
      const collection = parsePolicyCollection(
        row.policy_snapshot_json === undefined
          ? null
          : row.policy_snapshot_json,
      );
      const existing = collection.snapshots.find(
        (candidate) => candidate.id === policy.id,
      );
      if (existing) {
        if (stableJson(existing) !== stableJson(policy)) {
          throw new AgentVersionCacheError("cache_conflict");
        }
      } else {
        collection.snapshots.push(policy);
        collection.snapshots.sort((left, right) =>
          Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
        );
        this.database.sqlite
          .prepare(
            `UPDATE cached_agent_versions
             SET policy_snapshot_json = ?
             WHERE version_id = ?`,
          )
          .run(JSON.stringify(collection), versionId);
      }
      this.database.sqlite.exec("COMMIT");
    } catch (error) {
      try {
        this.database.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the policy-cache failure.
      }
      throw error;
    }
    return this.getVerifiedPolicySnapshot(versionId, policy.id);
  }

  getVerifiedPolicySnapshot(
    versionIdInput: string,
    policyIdInput: string,
  ): AgentPolicySnapshot {
    if (!validUuid(versionIdInput) || !validUuid(policyIdInput)) {
      throw new AgentVersionCacheError("cache_not_found");
    }
    const versionId = versionIdInput.toLowerCase();
    const policyId = policyIdInput.toLowerCase();
    const version = this.getVerifiedVersion(versionId);
    const row = this.database.sqlite
      .prepare(
        "SELECT policy_snapshot_json FROM cached_agent_versions WHERE version_id = ?",
      )
      .get(versionId) as { policy_snapshot_json?: unknown } | undefined;
    if (!row) throw new AgentVersionCacheError("cache_not_found");
    const collection = parsePolicyCollection(
      row.policy_snapshot_json === undefined ? null : row.policy_snapshot_json,
    );
    const policy = collection.snapshots.find(
      (candidate) => candidate.id === policyId,
    );
    if (!policy) throw new AgentVersionCacheError("cache_not_found");
    return this.verifyPolicyForVersion(policy, version, true);
  }

  private verifyPolicyForVersion(
    policyInput: AgentPolicySnapshot,
    version: AgentVersion,
    stored: boolean,
  ): AgentPolicySnapshot {
    try {
      const policy = JSON.parse(
        JSON.stringify(policyInput),
      ) as AgentPolicySnapshot;
      if (
        !validUuid(policy.id) ||
        !validUuid(policy.installation_id) ||
        !validUuid(policy.agent_version_id) ||
        policy.id !== policy.id.toLowerCase() ||
        policy.agent_version_id !== version.id ||
        policy.issuer !== this.origin ||
        !DIGEST_PATTERN.test(policy.content_digest) ||
        !policy.document ||
        policy.document.agent_definition_id !== version.definition_id ||
        policy.document.agent_version_id !== version.id ||
        policy.document.version_digest !== version.content_digest
      ) {
        throw new AgentVersionCacheError("cache_corrupt");
      }
      const verified = this.trust.verifyPolicy(policy, {
        runtimeVersion: this.runtimeVersion,
      });
      if (verified.contentDigest !== policy.content_digest) {
        throw new AgentVersionCacheError("cache_corrupt");
      }
      return policy;
    } catch (error) {
      if (!stored) throw error;
      throw new AgentVersionCacheError("cache_corrupt");
    }
  }

  private verifyDirectory(
    directory: string,
    expectedVersionId: string,
    expectedDigest: string,
    requireReadOnly: boolean,
  ): AgentVersion {
    const root = realpathSync.native(this.database.paths.versionsPath);
    const directoryStats = lstatSync(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new AgentVersionCacheError("cache_corrupt");
    }
    if (
      requireReadOnly &&
      process.platform !== "win32" &&
      (directoryStats.mode & 0o222) !== 0
    ) {
      throw new AgentVersionCacheError("cache_permissions_invalid");
    }
    const canonicalDirectory = realpathSync.native(directory);
    if (!isContained(root, canonicalDirectory)) {
      throw new AgentVersionCacheError("cache_corrupt");
    }
    if (
      readdirSync(canonicalDirectory).sort().join("\0") !==
      ["bundle.json", "manifest.json", "version.json"].join("\0")
    ) {
      throw new AgentVersionCacheError("cache_corrupt");
    }
    const versionPath = join(canonicalDirectory, "version.json");
    const manifestPath = join(canonicalDirectory, "manifest.json");
    const bundlePath = join(canonicalDirectory, "bundle.json");
    const read = (path: string, maximumBytes: number): Buffer => {
      if (!isContained(canonicalDirectory, resolve(path))) {
        throw new AgentVersionCacheError("cache_corrupt");
      }
      if (!requireReadOnly) {
        const stats = lstatSync(path);
        if (
          stats.isSymbolicLink() ||
          !stats.isFile() ||
          stats.size < 1 ||
          stats.size > maximumBytes
        ) {
          throw new AgentVersionCacheError("cache_corrupt");
        }
        return readFileSync(path);
      }
      return readBounded(path, maximumBytes);
    };
    const version = parseStoredVersion(
      read(versionPath, MAX_VERSION_FILE_BYTES),
    );
    if (
      version.id !== expectedVersionId ||
      version.content_digest !== expectedDigest
    ) {
      throw new AgentVersionCacheError("cache_corrupt");
    }
    let canonical;
    try {
      canonical = canonicalizeAgentVersionContent(version);
      const verified = this.trust.verifyVersion(version, {
        issuer: this.origin,
        runtimeVersion: this.runtimeVersion,
      });
      if (
        verified.contentDigest !== expectedDigest ||
        canonical.contentDigest !== expectedDigest
      ) {
        throw new AgentVersionCacheError("cache_corrupt");
      }
    } catch (error) {
      if (!requireReadOnly) throw error;
      throw new AgentVersionCacheError("cache_corrupt");
    }
    if (
      !read(manifestPath, MAX_MANIFEST_FILE_BYTES).equals(
        canonical.manifestBytes,
      ) ||
      !read(bundlePath, MAX_BUNDLE_FILE_BYTES).equals(canonical.bundleBytes)
    ) {
      throw new AgentVersionCacheError("cache_corrupt");
    }
    return version;
  }
}
