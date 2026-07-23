import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export const AGENTERA_CONTROL_PLANE_SCHEMA_VERSION = 7;

export type AgentAssetContext =
  | { scope: "USER" }
  | {
      scope: "WORKSPACE";
      workspaceId: string;
      role: "owner" | "admin" | "member";
    }
  | {
      scope: "ORGANIZATION";
      organizationId: string;
      role: "owner" | "admin" | "auditor" | "member";
    };

export interface AgenteraSqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface AgenteraSqliteStatement {
  run(...parameters: unknown[]): AgenteraSqliteRunResult;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export interface AgenteraSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): AgenteraSqliteStatement;
  close(): void;
}

export interface AgenteraControlPlanePaths {
  rootPath: string;
  databasePath: string;
  draftsPath: string;
  candidatesPath: string;
  versionsPath: string;
  projectionsPath: string;
}

export interface OpenAgenteraControlPlaneDatabaseOptions {
  databaseFactory?: (path: string) => AgenteraSqliteDatabase;
}

const localRequire = createRequire(
  typeof __filename === "string"
    ? __filename
    : join(process.cwd(), "package.json"),
);

function defaultDatabaseFactory(path: string): AgenteraSqliteDatabase {
  const loaded = localRequire("better-sqlite3") as
    | (new (databasePath: string) => AgenteraSqliteDatabase)
    | { default: new (databasePath: string) => AgenteraSqliteDatabase };
  const Constructor = typeof loaded === "function" ? loaded : loaded.default;
  return new Constructor(path);
}

function isPathInside(parent: string, child: string): boolean {
  const childRelative = relative(resolve(parent), resolve(child));
  return (
    childRelative === "" ||
    (!childRelative.startsWith("..") && !isAbsolute(childRelative))
  );
}

function canonicalPotentialPath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  let canonical = existing;
  try {
    canonical = realpathSync.native(existing);
  } catch {
    canonical = resolve(existing);
  }
  return join(canonical, ...missing);
}

function assertOutsideHermesHome(controlPlaneRoot: string): void {
  const hermesHome = process.env.HERMES_HOME;
  if (
    typeof hermesHome === "string" &&
    hermesHome.length > 0 &&
    isPathInside(
      canonicalPotentialPath(hermesHome),
      canonicalPotentialPath(controlPlaneRoot),
    )
  ) {
    throw new Error(
      "AgentEra control-plane path must remain outside HERMES_HOME.",
    );
  }
}

export function resolveAgenteraControlPlanePaths(
  userDataPath: string,
): AgenteraControlPlanePaths {
  if (typeof userDataPath !== "string" || !isAbsolute(userDataPath)) {
    throw new Error("Electron userData path must be absolute.");
  }
  const rootPath = join(resolve(userDataPath), "agentera-control-plane");
  assertOutsideHermesHome(rootPath);
  return {
    rootPath,
    databasePath: join(rootPath, "control-plane.db"),
    draftsPath: join(rootPath, "drafts"),
    candidatesPath: join(rootPath, "candidates"),
    versionsPath: join(rootPath, "versions"),
    projectionsPath: join(rootPath, "projections"),
  };
}

function initializeSchema(sqlite: AgenteraSqliteDatabase): void {
  const current = sqlite.prepare("PRAGMA user_version").get() as
    | Record<string, unknown>
    | undefined;
  const currentVersion = current ? Number(Object.values(current)[0]) : 0;
  if (
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 0 ||
    currentVersion > AGENTERA_CONTROL_PLANE_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported AgentEra control-plane database version.");
  }

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    if (currentVersion === 3) {
      const draftColumns = sqlite
        .prepare("PRAGMA table_info(agent_drafts)")
        .all() as Array<{ name?: unknown }>;
      const sparseLegacyDrafts = !draftColumns.some(
        ({ name }) => name === "tenant_id",
      );
      if (sparseLegacyDrafts) {
        sqlite.exec(`
          CREATE TABLE agent_drafts_v3_compat (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            target_scope TEXT NOT NULL,
            workspace_id TEXT,
            source_agent_definition_id TEXT,
            base_agent_version_id TEXT,
            display_name TEXT NOT NULL,
            icon_media_type TEXT,
            icon_data_base64 TEXT,
            manifest_json TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK (revision >= 1),
            publication_attempt_revision INTEGER,
            publication_attempted_at TEXT,
            publication_idempotency_key TEXT,
            publication_error_code TEXT,
            publication_error_summary TEXT,
            published_definition_id TEXT,
            published_version_id TEXT,
            published_revision INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK ((target_scope = 'USER' AND workspace_id IS NULL)
                OR (target_scope = 'WORKSPACE' AND workspace_id IS NOT NULL))
          );
          INSERT INTO agent_drafts_v3_compat (
            id, tenant_id, owner_id, target_scope, workspace_id,
            display_name, manifest_json, revision, created_at, updated_at
          )
          SELECT id, '__legacy_unowned__', '__legacy_unowned__', 'USER', NULL,
            display_name, '{}', 1,
            '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
          FROM agent_drafts;
          DROP TABLE agent_drafts;
          ALTER TABLE agent_drafts_v3_compat RENAME TO agent_drafts;

          CREATE TABLE IF NOT EXISTS draft_assets (
            draft_id TEXT NOT NULL REFERENCES agent_drafts(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK (revision >= 1),
            kind TEXT NOT NULL,
            media_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
            sha256 TEXT NOT NULL,
            PRIMARY KEY (draft_id, path)
          );
          CREATE TABLE IF NOT EXISTS local_agent_installations (
            agent_installation_id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            device_installation_id TEXT NOT NULL,
            source_scope TEXT NOT NULL,
            source_workspace_id TEXT,
            definition_id TEXT NOT NULL,
            selected_version_id TEXT NOT NULL,
            runtime_profile_id TEXT,
            policy_snapshot_id TEXT,
            status TEXT NOT NULL,
            retry_code TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK ((source_scope = 'USER' AND source_workspace_id IS NULL)
                OR (source_scope = 'WORKSPACE' AND source_workspace_id IS NOT NULL))
          );
        `);
      }
    }
    if (currentVersion === 0) {
      sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_drafts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
		target_scope TEXT NOT NULL,
		workspace_id TEXT,
        organization_id TEXT,
        source_agent_definition_id TEXT,
        base_agent_version_id TEXT,
        display_name TEXT NOT NULL,
        icon_media_type TEXT,
        icon_data_base64 TEXT,
        manifest_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        publication_attempt_revision INTEGER,
        publication_attempted_at TEXT,
        publication_idempotency_key TEXT,
        publication_error_code TEXT,
        publication_error_summary TEXT,
        published_definition_id TEXT,
        published_version_id TEXT,
        published_revision INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((icon_media_type IS NULL) = (icon_data_base64 IS NULL)),
        CHECK ((publication_attempt_revision IS NULL) = (publication_attempted_at IS NULL)),
		CHECK ((publication_attempt_revision IS NULL) = (publication_idempotency_key IS NULL)),
		CHECK ((target_scope = 'USER' AND workspace_id IS NULL AND organization_id IS NULL)
		    OR (target_scope = 'WORKSPACE' AND workspace_id IS NOT NULL AND organization_id IS NULL)
		    OR (target_scope = 'ORGANIZATION' AND workspace_id IS NULL AND organization_id IS NOT NULL))
      );

      CREATE TABLE IF NOT EXISTS draft_assets (
        draft_id TEXT NOT NULL REFERENCES agent_drafts(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        kind TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT NOT NULL,
        PRIMARY KEY (draft_id, path)
      );

      CREATE TABLE IF NOT EXISTS cached_agent_versions (
		version_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        definition_id TEXT NOT NULL,
        version_number INTEGER NOT NULL CHECK (version_number >= 1),
        content_digest TEXT NOT NULL,
        version_json TEXT NOT NULL,
        policy_snapshot_json TEXT,
        cache_relative_path TEXT NOT NULL,
		verified_at TEXT NOT NULL,
		PRIMARY KEY (tenant_id, owner_id, version_id)
      );

      CREATE TABLE IF NOT EXISTS local_agent_installations (
        agent_installation_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        device_installation_id TEXT NOT NULL,
		 source_scope TEXT NOT NULL,
		 source_workspace_id TEXT,
        source_organization_id TEXT,
        official_release_id TEXT,
        selected_release_revision_id TEXT,
        update_policy TEXT NOT NULL,
        definition_id TEXT NOT NULL,
        selected_version_id TEXT NOT NULL,
        runtime_profile_id TEXT,
        policy_snapshot_id TEXT,
        status TEXT NOT NULL,
        retry_code TEXT,
        created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		CHECK (
          (source_scope = 'USER' AND source_workspace_id IS NULL AND source_organization_id IS NULL
            AND official_release_id IS NULL AND selected_release_revision_id IS NULL AND update_policy = 'manual')
		    OR (source_scope = 'WORKSPACE' AND source_workspace_id IS NOT NULL AND source_organization_id IS NULL
            AND official_release_id IS NULL AND selected_release_revision_id IS NULL AND update_policy = 'manual')
		    OR (source_scope = 'ORGANIZATION' AND source_workspace_id IS NULL AND source_organization_id IS NOT NULL
            AND official_release_id IS NULL AND selected_release_revision_id IS NULL AND update_policy = 'manual')
          OR (source_scope = 'PLATFORM' AND source_workspace_id IS NULL AND source_organization_id IS NULL
            AND official_release_id IS NOT NULL AND selected_release_revision_id IS NOT NULL AND update_policy = 'managed')
        )
      );

      CREATE TABLE IF NOT EXISTS runtime_bindings (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        device_installation_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL UNIQUE,
        hermes_session_id TEXT UNIQUE,
        binding_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signing_key_cache (
        origin TEXT NOT NULL,
        purpose TEXT NOT NULL,
        key_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (origin, purpose, key_id)
      );

      CREATE TABLE IF NOT EXISTS pending_sanitized_records (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        device_installation_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_experience_candidates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        device_installation_id TEXT NOT NULL,
        agent_installation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        agent_definition_id TEXT NOT NULL,
        source_agent_version_id TEXT NOT NULL,
        runtime_profile_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        source_relative_path TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        dlp_contract_version TEXT NOT NULL,
        snapshot_relative_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PREPARED', 'UPLOAD_FAILED', 'SUBMITTED')),
        cloud_candidate_id TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        submitted_at TEXT,
        UNIQUE (
          tenant_id, owner_id, device_installation_id,
          workspace_id, agent_definition_id, content_digest
        ),
        CHECK (
          (status IN ('PREPARED', 'UPLOAD_FAILED')
            AND cloud_candidate_id IS NULL AND submitted_at IS NULL)
          OR
          (status = 'SUBMITTED'
            AND cloud_candidate_id IS NOT NULL AND submitted_at IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS local_experience_candidate_imports (
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        device_installation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        agent_definition_id TEXT NOT NULL,
        base_agent_version_id TEXT NOT NULL,
        candidate_content_digest TEXT NOT NULL,
        draft_id TEXT NOT NULL REFERENCES agent_drafts(id) ON DELETE CASCADE,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, owner_id, device_installation_id, candidate_id)
      );

      CREATE TABLE IF NOT EXISTS organization_agent_submission_refs (
        local_draft_id TEXT NOT NULL,
        local_draft_revision INTEGER NOT NULL CHECK (local_draft_revision > 0),
        organization_id TEXT NOT NULL,
        cloud_submission_id TEXT NOT NULL UNIQUE,
        content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
        cloud_status TEXT NOT NULL CHECK (
          cloud_status IN ('pending','approved','rejected','withdrawn','superseded')
        ),
        cloud_revision INTEGER NOT NULL CHECK (cloud_revision > 0),
        submitted_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        PRIMARY KEY (local_draft_id, local_draft_revision, organization_id)
      );

      CREATE TABLE IF NOT EXISTS encrypted_backup_restores (
        backup_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        device_installation_id TEXT NOT NULL,
        source_installation_id TEXT NOT NULL,
        agent_installation_id TEXT NOT NULL UNIQUE,
        runtime_profile_id TEXT NOT NULL UNIQUE,
        profile_lineage_id TEXT NOT NULL,
        encrypted_runtime_binding_provenance BLOB NOT NULL
          CHECK (
            length(encrypted_runtime_binding_provenance) > 0
            AND length(encrypted_runtime_binding_provenance) <= 1048576
          ),
        historical_sessions_read_only INTEGER NOT NULL DEFAULT 1
          CHECK (historical_sessions_read_only = 1),
        restored_at TEXT NOT NULL,
        PRIMARY KEY (
          tenant_id, owner_id, device_installation_id, backup_id
        )
      );

      PRAGMA user_version = ${AGENTERA_CONTROL_PLANE_SCHEMA_VERSION};
    `);
    }
    if (currentVersion === 1) {
      sqlite.exec(`
        ALTER TABLE agent_drafts ADD COLUMN tenant_id TEXT;
        ALTER TABLE agent_drafts ADD COLUMN owner_id TEXT;
        ALTER TABLE cached_agent_versions ADD COLUMN tenant_id TEXT;
        ALTER TABLE cached_agent_versions ADD COLUMN owner_id TEXT;
        ALTER TABLE local_agent_installations ADD COLUMN tenant_id TEXT;
        ALTER TABLE local_agent_installations ADD COLUMN owner_id TEXT;
        ALTER TABLE local_agent_installations ADD COLUMN device_installation_id TEXT;
        ALTER TABLE runtime_bindings ADD COLUMN tenant_id TEXT;
        ALTER TABLE runtime_bindings ADD COLUMN owner_id TEXT;
        ALTER TABLE runtime_bindings ADD COLUMN device_installation_id TEXT;
        ALTER TABLE pending_sanitized_records ADD COLUMN tenant_id TEXT;
        ALTER TABLE pending_sanitized_records ADD COLUMN owner_id TEXT;
        ALTER TABLE pending_sanitized_records ADD COLUMN device_installation_id TEXT;
        UPDATE runtime_bindings
        SET tenant_id = json_extract(binding_json, '$.tenantId'),
            owner_id = json_extract(binding_json, '$.ownerId'),
            device_installation_id = json_extract(binding_json, '$.deviceId');
        UPDATE pending_sanitized_records
        SET tenant_id = (SELECT tenant_id FROM runtime_bindings WHERE runtime_bindings.id = pending_sanitized_records.id),
            owner_id = (SELECT owner_id FROM runtime_bindings WHERE runtime_bindings.id = pending_sanitized_records.id),
            device_installation_id = (SELECT device_installation_id FROM runtime_bindings WHERE runtime_bindings.id = pending_sanitized_records.id)
        WHERE record_type = 'runtime_binding';
		PRAGMA user_version = 2;
      `);
    }
    if (currentVersion === 1 || currentVersion === 2) {
      sqlite.exec(`
		CREATE TABLE agent_drafts_v3 (
		  id TEXT PRIMARY KEY,
		  tenant_id TEXT NOT NULL,
		  owner_id TEXT NOT NULL,
		  target_scope TEXT NOT NULL,
		  workspace_id TEXT,
		  source_agent_definition_id TEXT,
		  base_agent_version_id TEXT,
		  display_name TEXT NOT NULL,
		  icon_media_type TEXT,
		  icon_data_base64 TEXT,
		  manifest_json TEXT NOT NULL,
		  revision INTEGER NOT NULL CHECK (revision >= 1),
		  publication_attempt_revision INTEGER,
		  publication_attempted_at TEXT,
		  publication_idempotency_key TEXT,
		  publication_error_code TEXT,
		  publication_error_summary TEXT,
		  published_definition_id TEXT,
		  published_version_id TEXT,
		  published_revision INTEGER,
		  created_at TEXT NOT NULL,
		  updated_at TEXT NOT NULL,
		  CHECK ((icon_media_type IS NULL) = (icon_data_base64 IS NULL)),
		  CHECK ((publication_attempt_revision IS NULL) = (publication_attempted_at IS NULL)),
		  CHECK ((publication_attempt_revision IS NULL) = (publication_idempotency_key IS NULL)),
		  CHECK ((target_scope = 'USER' AND workspace_id IS NULL)
		      OR (target_scope = 'WORKSPACE' AND workspace_id IS NOT NULL))
		);
		INSERT INTO agent_drafts_v3 (
		  id, tenant_id, owner_id, target_scope, workspace_id,
		  source_agent_definition_id, base_agent_version_id, display_name,
		  icon_media_type, icon_data_base64, manifest_json, revision,
		  publication_attempt_revision, publication_attempted_at,
		  publication_idempotency_key, publication_error_code,
		  publication_error_summary, published_definition_id,
		  published_version_id, published_revision, created_at, updated_at
		)
		SELECT id, tenant_id, owner_id, 'USER', NULL,
		  source_agent_definition_id, base_agent_version_id, display_name,
		  icon_media_type, icon_data_base64, manifest_json, revision,
		  publication_attempt_revision, publication_attempted_at,
		  publication_idempotency_key, publication_error_code,
		  publication_error_summary, published_definition_id,
		  published_version_id, published_revision, created_at, updated_at
		FROM agent_drafts;

		CREATE TABLE draft_assets_v3 (
		  draft_id TEXT NOT NULL REFERENCES agent_drafts_v3(id) ON DELETE CASCADE,
		  path TEXT NOT NULL,
		  revision INTEGER NOT NULL CHECK (revision >= 1),
		  kind TEXT NOT NULL,
		  media_type TEXT NOT NULL,
		  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
		  sha256 TEXT NOT NULL,
		  PRIMARY KEY (draft_id, path)
		);
		INSERT INTO draft_assets_v3 (
		  draft_id, path, revision, kind, media_type, size_bytes, sha256
		)
		SELECT draft_id, path, revision, kind, media_type, size_bytes, sha256
		FROM draft_assets;

		CREATE TABLE cached_agent_versions_v3 (
		  version_id TEXT NOT NULL,
		  tenant_id TEXT NOT NULL,
		  owner_id TEXT NOT NULL,
		  definition_id TEXT NOT NULL,
		  version_number INTEGER NOT NULL CHECK (version_number >= 1),
		  content_digest TEXT NOT NULL,
		  version_json TEXT NOT NULL,
		  policy_snapshot_json TEXT,
		  cache_relative_path TEXT NOT NULL,
		  verified_at TEXT NOT NULL,
		  PRIMARY KEY (tenant_id, owner_id, version_id)
		);
		INSERT INTO cached_agent_versions_v3 (
		  version_id, tenant_id, owner_id, definition_id, version_number,
		  content_digest, version_json, policy_snapshot_json,
		  cache_relative_path, verified_at
		)
		SELECT version_id, tenant_id, owner_id, definition_id, version_number,
		  content_digest, version_json, policy_snapshot_json,
		  cache_relative_path, verified_at
		FROM cached_agent_versions;

		CREATE TABLE local_agent_installations_v3 (
		  agent_installation_id TEXT PRIMARY KEY,
		  tenant_id TEXT NOT NULL,
		  owner_id TEXT NOT NULL,
		  device_installation_id TEXT NOT NULL,
		  source_scope TEXT NOT NULL,
		  source_workspace_id TEXT,
		  definition_id TEXT NOT NULL,
		  selected_version_id TEXT NOT NULL,
		  runtime_profile_id TEXT,
		  policy_snapshot_id TEXT,
		  status TEXT NOT NULL,
		  retry_code TEXT,
		  created_at TEXT NOT NULL,
		  updated_at TEXT NOT NULL,
		  CHECK ((source_scope = 'USER' AND source_workspace_id IS NULL)
		      OR (source_scope = 'WORKSPACE' AND source_workspace_id IS NOT NULL))
		);
		INSERT INTO local_agent_installations_v3 (
		  agent_installation_id, tenant_id, owner_id, device_installation_id,
		  source_scope, source_workspace_id, definition_id, selected_version_id,
		  runtime_profile_id, policy_snapshot_id, status, retry_code,
		  created_at, updated_at
		)
		SELECT agent_installation_id, tenant_id, owner_id, device_installation_id,
		  'USER', NULL, definition_id, selected_version_id,
		  runtime_profile_id, policy_snapshot_id, status, retry_code,
		  created_at, updated_at
		FROM local_agent_installations;

		DROP TABLE draft_assets;
		DROP TABLE agent_drafts;
		ALTER TABLE agent_drafts_v3 RENAME TO agent_drafts;
		ALTER TABLE draft_assets_v3 RENAME TO draft_assets;
		DROP TABLE cached_agent_versions;
		ALTER TABLE cached_agent_versions_v3 RENAME TO cached_agent_versions;
		DROP TABLE local_agent_installations;
		ALTER TABLE local_agent_installations_v3 RENAME TO local_agent_installations;
		PRAGMA user_version = 3;
	  `);
    }
    if (currentVersion >= 1 && currentVersion <= 3) {
      sqlite.exec(`
        CREATE TABLE local_experience_candidates (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          device_installation_id TEXT NOT NULL,
          agent_installation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          agent_definition_id TEXT NOT NULL,
          source_agent_version_id TEXT NOT NULL,
          runtime_profile_id TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          source_relative_path TEXT NOT NULL,
          content_digest TEXT NOT NULL,
          dlp_contract_version TEXT NOT NULL,
          snapshot_relative_path TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('PREPARED', 'UPLOAD_FAILED', 'SUBMITTED')),
          cloud_candidate_id TEXT,
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          submitted_at TEXT,
          UNIQUE (
            tenant_id, owner_id, device_installation_id,
            workspace_id, agent_definition_id, content_digest
          ),
          CHECK (
            (status IN ('PREPARED', 'UPLOAD_FAILED')
              AND cloud_candidate_id IS NULL AND submitted_at IS NULL)
            OR
            (status = 'SUBMITTED'
              AND cloud_candidate_id IS NOT NULL AND submitted_at IS NOT NULL)
          )
        );

        CREATE TABLE local_experience_candidate_imports (
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          device_installation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL,
          agent_definition_id TEXT NOT NULL,
          base_agent_version_id TEXT NOT NULL,
          candidate_content_digest TEXT NOT NULL,
          draft_id TEXT NOT NULL REFERENCES agent_drafts(id) ON DELETE CASCADE,
          imported_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, owner_id, device_installation_id, candidate_id)
        );

        PRAGMA user_version = 4;
      `);
    }
    if (currentVersion >= 1 && currentVersion <= 4) {
      sqlite.exec(`
        CREATE TABLE agent_drafts_v5 (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          target_scope TEXT NOT NULL,
          workspace_id TEXT,
          organization_id TEXT,
          source_agent_definition_id TEXT,
          base_agent_version_id TEXT,
          display_name TEXT NOT NULL,
          icon_media_type TEXT,
          icon_data_base64 TEXT,
          manifest_json TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          publication_attempt_revision INTEGER,
          publication_attempted_at TEXT,
          publication_idempotency_key TEXT,
          publication_error_code TEXT,
          publication_error_summary TEXT,
          published_definition_id TEXT,
          published_version_id TEXT,
          published_revision INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK ((icon_media_type IS NULL) = (icon_data_base64 IS NULL)),
          CHECK ((publication_attempt_revision IS NULL) = (publication_attempted_at IS NULL)),
          CHECK ((publication_attempt_revision IS NULL) = (publication_idempotency_key IS NULL)),
          CHECK (
            (target_scope = 'USER' AND workspace_id IS NULL AND organization_id IS NULL)
            OR (target_scope = 'WORKSPACE' AND workspace_id IS NOT NULL AND organization_id IS NULL)
            OR (target_scope = 'ORGANIZATION' AND workspace_id IS NULL AND organization_id IS NOT NULL)
          )
        );
        INSERT INTO agent_drafts_v5 (
          id, tenant_id, owner_id, target_scope, workspace_id, organization_id,
          source_agent_definition_id, base_agent_version_id, display_name,
          icon_media_type, icon_data_base64, manifest_json, revision,
          publication_attempt_revision, publication_attempted_at,
          publication_idempotency_key, publication_error_code,
          publication_error_summary, published_definition_id,
          published_version_id, published_revision, created_at, updated_at
        )
        SELECT id, tenant_id, owner_id, target_scope, workspace_id, NULL,
          source_agent_definition_id, base_agent_version_id, display_name,
          icon_media_type, icon_data_base64, manifest_json, revision,
          publication_attempt_revision, publication_attempted_at,
          publication_idempotency_key, publication_error_code,
          publication_error_summary, published_definition_id,
          published_version_id, published_revision, created_at, updated_at
        FROM agent_drafts;

        CREATE TABLE draft_assets_v5 (
          draft_id TEXT NOT NULL REFERENCES agent_drafts_v5(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          kind TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          sha256 TEXT NOT NULL,
          PRIMARY KEY (draft_id, path)
        );
        INSERT INTO draft_assets_v5 (
          draft_id, path, revision, kind, media_type, size_bytes, sha256
        )
        SELECT draft_id, path, revision, kind, media_type, size_bytes, sha256
        FROM draft_assets;

        CREATE TABLE local_experience_candidate_imports_v5 (
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          device_installation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL,
          agent_definition_id TEXT NOT NULL,
          base_agent_version_id TEXT NOT NULL,
          candidate_content_digest TEXT NOT NULL,
          draft_id TEXT NOT NULL REFERENCES agent_drafts_v5(id) ON DELETE CASCADE,
          imported_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, owner_id, device_installation_id, candidate_id)
        );
        INSERT INTO local_experience_candidate_imports_v5 (
          tenant_id, owner_id, device_installation_id, workspace_id,
          candidate_id, agent_definition_id, base_agent_version_id,
          candidate_content_digest, draft_id, imported_at
        )
        SELECT tenant_id, owner_id, device_installation_id, workspace_id,
          candidate_id, agent_definition_id, base_agent_version_id,
          candidate_content_digest, draft_id, imported_at
        FROM local_experience_candidate_imports;

        CREATE TABLE local_agent_installations_v5 (
          agent_installation_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          device_installation_id TEXT NOT NULL,
          source_scope TEXT NOT NULL,
          source_workspace_id TEXT,
          source_organization_id TEXT,
          official_release_id TEXT,
          selected_release_revision_id TEXT,
          update_policy TEXT NOT NULL,
          definition_id TEXT NOT NULL,
          selected_version_id TEXT NOT NULL,
          runtime_profile_id TEXT,
          policy_snapshot_id TEXT,
          status TEXT NOT NULL,
          retry_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (
            (source_scope = 'USER' AND source_workspace_id IS NULL AND source_organization_id IS NULL
              AND official_release_id IS NULL AND selected_release_revision_id IS NULL AND update_policy = 'manual')
            OR (source_scope = 'WORKSPACE' AND source_workspace_id IS NOT NULL AND source_organization_id IS NULL
              AND official_release_id IS NULL AND selected_release_revision_id IS NULL AND update_policy = 'manual')
            OR (source_scope = 'ORGANIZATION' AND source_workspace_id IS NULL AND source_organization_id IS NOT NULL
              AND official_release_id IS NULL AND selected_release_revision_id IS NULL AND update_policy = 'manual')
            OR (source_scope = 'PLATFORM' AND source_workspace_id IS NULL AND source_organization_id IS NULL
              AND official_release_id IS NOT NULL AND selected_release_revision_id IS NOT NULL AND update_policy = 'managed')
          )
        );
        INSERT INTO local_agent_installations_v5 (
          agent_installation_id, tenant_id, owner_id, device_installation_id,
          source_scope, source_workspace_id, source_organization_id,
          official_release_id, selected_release_revision_id, update_policy,
          definition_id, selected_version_id, runtime_profile_id,
          policy_snapshot_id, status, retry_code, created_at, updated_at
        )
        SELECT agent_installation_id, tenant_id, owner_id, device_installation_id,
          source_scope, source_workspace_id, NULL, NULL, NULL, 'manual', definition_id,
          selected_version_id, runtime_profile_id, policy_snapshot_id,
          status, retry_code, created_at, updated_at
        FROM local_agent_installations;

        DROP TABLE local_experience_candidate_imports;
        DROP TABLE draft_assets;
        DROP TABLE agent_drafts;
        ALTER TABLE agent_drafts_v5 RENAME TO agent_drafts;
        ALTER TABLE draft_assets_v5 RENAME TO draft_assets;
        ALTER TABLE local_experience_candidate_imports_v5
          RENAME TO local_experience_candidate_imports;
        DROP TABLE local_agent_installations;
        ALTER TABLE local_agent_installations_v5
          RENAME TO local_agent_installations;

        CREATE TABLE organization_agent_submission_refs (
          local_draft_id TEXT NOT NULL,
          local_draft_revision INTEGER NOT NULL CHECK (local_draft_revision > 0),
          organization_id TEXT NOT NULL,
          cloud_submission_id TEXT NOT NULL UNIQUE,
          content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
          cloud_status TEXT NOT NULL CHECK (
            cloud_status IN ('pending','approved','rejected','withdrawn','superseded')
          ),
          cloud_revision INTEGER NOT NULL CHECK (cloud_revision > 0),
          submitted_at TEXT NOT NULL,
          last_verified_at TEXT NOT NULL,
          PRIMARY KEY (local_draft_id, local_draft_revision, organization_id)
        );

        PRAGMA user_version = ${AGENTERA_CONTROL_PLANE_SCHEMA_VERSION};
      `);
    }
    if (currentVersion === 5) {
      sqlite.exec(`
        CREATE TABLE local_agent_installations_v6 (
          agent_installation_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          device_installation_id TEXT NOT NULL,
          source_scope TEXT NOT NULL,
          source_workspace_id TEXT,
          source_organization_id TEXT,
          official_release_id TEXT,
          selected_release_revision_id TEXT,
          update_policy TEXT NOT NULL,
          definition_id TEXT NOT NULL,
          selected_version_id TEXT NOT NULL,
          runtime_profile_id TEXT,
          policy_snapshot_id TEXT,
          status TEXT NOT NULL,
          retry_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (
            (source_scope = 'USER' AND source_workspace_id IS NULL AND source_organization_id IS NULL
              AND official_release_id IS NULL AND selected_release_revision_id IS NULL AND update_policy = 'manual')
            OR (source_scope = 'WORKSPACE' AND source_workspace_id IS NOT NULL AND source_organization_id IS NULL
              AND official_release_id IS NULL AND selected_release_revision_id IS NULL AND update_policy = 'manual')
            OR (source_scope = 'ORGANIZATION' AND source_workspace_id IS NULL AND source_organization_id IS NOT NULL
              AND official_release_id IS NULL AND selected_release_revision_id IS NULL AND update_policy = 'manual')
            OR (source_scope = 'PLATFORM' AND source_workspace_id IS NULL AND source_organization_id IS NULL
              AND official_release_id IS NOT NULL AND selected_release_revision_id IS NOT NULL AND update_policy = 'managed')
          )
        );
        INSERT INTO local_agent_installations_v6 (
          agent_installation_id, tenant_id, owner_id, device_installation_id,
          source_scope, source_workspace_id, source_organization_id,
          official_release_id, selected_release_revision_id, update_policy,
          definition_id, selected_version_id, runtime_profile_id,
          policy_snapshot_id, status, retry_code, created_at, updated_at
        )
        SELECT agent_installation_id, tenant_id, owner_id, device_installation_id,
          source_scope, source_workspace_id, source_organization_id,
          NULL, NULL, 'manual', definition_id, selected_version_id,
          runtime_profile_id, policy_snapshot_id, status, retry_code,
          created_at, updated_at
        FROM local_agent_installations;
        DROP TABLE local_agent_installations;
        ALTER TABLE local_agent_installations_v6
          RENAME TO local_agent_installations;
        PRAGMA user_version = ${AGENTERA_CONTROL_PLANE_SCHEMA_VERSION};
      `);
    }
    if (currentVersion >= 1 && currentVersion <= 6) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS encrypted_backup_restores (
          backup_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          device_installation_id TEXT NOT NULL,
          source_installation_id TEXT NOT NULL,
          agent_installation_id TEXT NOT NULL UNIQUE,
          runtime_profile_id TEXT NOT NULL UNIQUE,
          profile_lineage_id TEXT NOT NULL,
          encrypted_runtime_binding_provenance BLOB NOT NULL
            CHECK (
              length(encrypted_runtime_binding_provenance) > 0
              AND length(encrypted_runtime_binding_provenance) <= 1048576
            ),
          historical_sessions_read_only INTEGER NOT NULL DEFAULT 1
            CHECK (historical_sessions_read_only = 1),
          restored_at TEXT NOT NULL,
          PRIMARY KEY (
            tenant_id, owner_id, device_installation_id, backup_id
          )
        );
        PRAGMA user_version = ${AGENTERA_CONTROL_PLANE_SCHEMA_VERSION};
      `);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

export class AgenteraControlPlaneDatabase {
  readonly databasePath: string;
  readonly paths: AgenteraControlPlanePaths;
  readonly sqlite: AgenteraSqliteDatabase;
  private closed = false;

  constructor(
    paths: AgenteraControlPlanePaths,
    sqlite: AgenteraSqliteDatabase,
  ) {
    this.paths = paths;
    this.databasePath = paths.databasePath;
    this.sqlite = sqlite;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sqlite.close();
  }
}

export function openAgenteraControlPlaneDatabase(
  userDataPath: string,
  options: OpenAgenteraControlPlaneDatabaseOptions = {},
): AgenteraControlPlaneDatabase {
  const paths = resolveAgenteraControlPlanePaths(userDataPath);
  mkdirSync(paths.rootPath, { recursive: true, mode: 0o700 });
  chmodSync(paths.rootPath, 0o700);
  assertOutsideHermesHome(realpathSync.native(paths.rootPath));
  mkdirSync(paths.draftsPath, { recursive: true, mode: 0o700 });
  mkdirSync(paths.candidatesPath, { recursive: true, mode: 0o700 });
  chmodSync(paths.candidatesPath, 0o700);
  mkdirSync(paths.versionsPath, { recursive: true, mode: 0o700 });
  mkdirSync(paths.projectionsPath, { recursive: true, mode: 0o700 });

  const sqlite = (options.databaseFactory ?? defaultDatabaseFactory)(
    paths.databasePath,
  );
  try {
    sqlite.exec("PRAGMA journal_mode=WAL");
    sqlite.exec("PRAGMA foreign_keys=ON");
    sqlite.exec("PRAGMA busy_timeout=5000");
    initializeSchema(sqlite);
    return new AgenteraControlPlaneDatabase(paths, sqlite);
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Preserve the initialization failure.
    }
    throw error;
  }
}
