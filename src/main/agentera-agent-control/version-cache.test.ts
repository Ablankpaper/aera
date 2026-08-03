// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDraftAssetInput,
  AgentEditableManifest,
} from "../../shared/agentera-agent-control";
import type { components } from "../../shared/agentera-cloud-api.generated";
import type { AgentPolicySnapshot, AgentVersion } from "./client";
import {
  openAgenteraControlPlaneDatabase,
  type AgenteraControlPlaneDatabase,
  type AgenteraSqliteDatabase,
} from "./db";
import { canonicalizeEditableAgent } from "./manifest";
import { AgenteraAgentTrustStore } from "./trust";
import { AgentVersionCache, AgentVersionCacheError } from "./version-cache";

const ORIGIN = "http://127.0.0.1:8086";
const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const STAGING_ID = "44444444-4444-4444-8444-444444444444";
const STALE_STAGING_ID = "99999999-9999-4999-8999-999999999999";
const WINNER_STAGING_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INSTALLATION_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_INSTALLATION_ID = "66666666-6666-4666-8666-666666666666";
const POLICY_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_POLICY_ID = "88888888-8888-4888-8888-888888888888";
const NOW = new Date("2026-07-19T18:30:00.000Z");
const KEY_ID = "agent-cache-test-v1";
const SPKI_PREFIX_LENGTH = 12;

function nodeSqliteFactory(path: string): AgenteraSqliteDatabase {
  return new DatabaseSync(path) as unknown as AgenteraSqliteDatabase;
}

function makeTreeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    chmodSync(path, 0o600);
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) {
    makeTreeWritable(join(path, name));
  }
}

function manifest(): AgentEditableManifest {
  return {
    schemaVersion: 1,
    identity: { systemPrompt: "Cache only verified bytes" },
    assets: [
      {
        path: "skills/research/SKILL.md",
        kind: "skill",
        mediaType: "text/markdown",
      },
    ],
    modelConstraints: {
      allowedProviders: ["openai"],
      allowedModels: ["gpt-5.6"],
    },
    tools: { allowed: ["files.read"], denied: [] },
    dependencies: [],
    runtimeCompatibility: {
      minimumVersion: "v0.18.2-agentera.1",
      maximumVersionExclusive: "v0.19.0",
    },
  };
}

function assets(): AgentDraftAssetInput[] {
  return [{ path: "skills/research/SKILL.md", content: "# Research\n" }];
}

function signedFixture(): {
  version: AgentVersion;
  keys: components["schemas"]["SigningKeySet"];
} {
  const canonical = canonicalizeEditableAgent(manifest(), assets());
  const pair = generateKeyPairSync("ed25519");
  const publicDer = Buffer.from(
    pair.publicKey.export({ format: "der", type: "spki" }),
  );
  const payload = Buffer.from(
    [
      "agentera-agent-version-v1",
      DEFINITION_ID,
      VERSION_ID,
      "1",
      canonical.manifestDigest,
      canonical.bundleDigest,
    ].join("\0"),
    "utf8",
  );
  return {
    version: {
      id: VERSION_ID,
      definition_id: DEFINITION_ID,
      version_number: 1,
      manifest: JSON.parse(
        canonical.manifestBytes.toString("utf8"),
      ) as AgentVersion["manifest"],
      bundle: JSON.parse(
        canonical.bundleBytes.toString("utf8"),
      ) as AgentVersion["bundle"],
      content_digest: canonical.contentDigest,
      signing_key_id: KEY_ID,
      signature: sign(null, payload, pair.privateKey).toString("base64url"),
      runtime_minimum_version: "v0.18.2-agentera.1",
      runtime_maximum_version_exclusive: "v0.19.0",
      published_at: NOW.toISOString(),
    },
    keys: {
      keys: [
        {
          kid: KEY_ID,
          kty: "OKP",
          crv: "Ed25519",
          alg: "EdDSA",
          use: "sig",
          purpose: "agent_version",
          x: publicDer.subarray(SPKI_PREFIX_LENGTH).toString("base64url"),
        },
      ],
    },
  };
}

function policySnapshot(
  version: AgentVersion,
  id = POLICY_ID,
  installationId = INSTALLATION_ID,
): AgentPolicySnapshot {
  if (version.manifest.schema_version !== 1) {
    throw new Error("V1 policy fixture requires a V1 manifest");
  }
  return {
    id,
    installation_id: installationId,
    agent_version_id: version.id,
    issuer: ORIGIN,
    policy_version: 1,
    document: {
      schema_version: 1,
      agent_definition_id: version.definition_id,
      agent_version_id: version.id,
      version_digest: version.content_digest,
      model_constraints: version.manifest.model_constraints,
      runtime_compatibility: version.manifest.runtime_compatibility,
      tools: version.manifest.tools,
      deny_rules: [],
      publication_allowed: false,
    },
    content_digest: "cd".repeat(32),
    signing_key_id: "policy-cache-test-key",
    signature: "A".repeat(86),
    created_at: NOW.toISOString(),
  };
}

describe("verified immutable Agent version cache", () => {
  const owner = { tenantId: DEFINITION_ID, ownerId: INSTALLATION_ID } as const;
  let root = "";
  let database: AgenteraControlPlaneDatabase;
  let trust: AgenteraAgentTrustStore;
  let version: AgentVersion;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-version-cache-"));
    database = openAgenteraControlPlaneDatabase(join(root, "user-data"), {
      databaseFactory: nodeSqliteFactory,
    });
    const fixture = signedFixture();
    version = fixture.version;
    trust = new AgenteraAgentTrustStore();
    trust.replaceKeys(ORIGIN, fixture.keys, NOW.toISOString());
  });

  afterEach(() => {
    database.close();
    makeTreeWritable(root);
    rmSync(root, { recursive: true, force: true });
  });

  function cache(runtimeVersion = "v0.18.2-agentera.1"): AgentVersionCache {
    return new AgentVersionCache({
      database,
      owner,
      trust,
      origin: ORIGIN,
      runtimeVersion,
      now: () => NOW,
      randomUUID: () => STAGING_ID,
    });
  }

  it("stages, fsyncs, atomically renames, and re-verifies read-only cached bytes", () => {
    const store = cache();
    const verify = vi.spyOn(trust, "verifyVersion");
    expect(store.cacheVerifiedVersion(version)).toEqual(version);
    const callsAfterCache = verify.mock.calls.length;
    const destination = join(
      database.paths.versionsPath,
      "accounts",
      owner.tenantId,
      owner.ownerId,
      VERSION_ID,
      version.content_digest,
    );
    expect(
      readdirSync(
        join(
          database.paths.versionsPath,
          "accounts",
          owner.tenantId,
          owner.ownerId,
          VERSION_ID,
        ),
      ),
    ).toEqual([version.content_digest]);
    for (const name of ["version.json", "manifest.json", "bundle.json"]) {
      const mode = statSync(join(destination, name)).mode & 0o777;
      expect(mode & 0o222).toBe(0);
    }
    expect(store.getVerifiedVersion(VERSION_ID)).toEqual(version);
    expect(verify.mock.calls.length).toBeGreaterThan(callsAfterCache);
    expect(Object.keys(store.getVerifiedVersion(VERSION_ID))).not.toContain(
      "cachePath",
    );
  });

  // @lat: [[agentera-agent-control-plane#Immutable publication#Durable local version cache]]
  it("recovers a verified directory that has no SQLite row after cold restart", () => {
    cache().cacheVerifiedVersion(version);
    database.sqlite
      .prepare(
        `DELETE FROM cached_agent_versions
         WHERE version_id = ? AND tenant_id = ? AND owner_id = ?`,
      )
      .run(version.id, owner.tenantId, owner.ownerId);

    const restarted = cache();
    expect(restarted.getVerifiedVersion(version.id)).toEqual(version);
    expect(
      database.sqlite
        .prepare(
          `SELECT count(*) AS count FROM cached_agent_versions
           WHERE version_id = ? AND tenant_id = ? AND owner_id = ?`,
        )
        .get(version.id, owner.tenantId, owner.ownerId),
    ).toEqual({ count: 1 });
  });

  it("rebuilds a missing immutable directory from a verified SQLite row", () => {
    cache().cacheVerifiedVersion(version);
    const row = database.sqlite
      .prepare(
        `SELECT cache_relative_path FROM cached_agent_versions
         WHERE version_id = ? AND tenant_id = ? AND owner_id = ?`,
      )
      .get(version.id, owner.tenantId, owner.ownerId) as {
      cache_relative_path: string;
    };
    const directory = join(
      database.paths.versionsPath,
      ...row.cache_relative_path.split("/"),
    );
    makeTreeWritable(directory);
    rmSync(directory, { recursive: true, force: true });

    const restarted = cache();
    expect(restarted.getVerifiedVersion(version.id)).toEqual(version);
    expect(lstatSync(directory).mode & 0o222).toBe(0);
  });

  it("reports an incomplete row-backed reconstruction with a bounded recovery code", () => {
    cache().cacheVerifiedVersion(version);
    const row = database.sqlite
      .prepare(
        `SELECT cache_relative_path FROM cached_agent_versions
         WHERE version_id = ? AND tenant_id = ? AND owner_id = ?`,
      )
      .get(version.id, owner.tenantId, owner.ownerId) as {
      cache_relative_path: string;
    };
    const destination = join(
      database.paths.versionsPath,
      ...row.cache_relative_path.split("/"),
    );
    makeTreeWritable(destination);
    rmSync(destination, { recursive: true, force: true });
    const restarted = new AgentVersionCache({
      database,
      owner,
      trust,
      origin: ORIGIN,
      runtimeVersion: "v0.18.2-agentera.1",
      now: () => NOW,
      randomUUID: () => STAGING_ID,
      rename: (source, target) => {
        renameSync(source, target);
        makeTreeWritable(target);
        rmSync(join(target, "bundle.json"), { force: true });
      },
    });

    let failure: unknown;
    try {
      restarted.getVerifiedVersion(version.id);
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(
      expect.objectContaining<Partial<AgentVersionCacheError>>({
        code: "cache_recovery_failed",
      }),
    );
    expect((failure as Error).message).not.toContain(destination);
    expect(
      database.sqlite
        .prepare(
          `SELECT version_id FROM cached_agent_versions
           WHERE version_id = ? AND tenant_id = ? AND owner_id = ?`,
        )
        .get(version.id, owner.tenantId, owner.ownerId),
    ).toBeDefined();
    expect(existsSync(destination)).toBe(false);
    expect(cache().getVerifiedVersion(version.id)).toEqual(version);
  });

  it("retains verified bytes when a deferred SQLite commit fails and recovers on retry", () => {
    database.sqlite.exec(`
      CREATE TABLE cache_commit_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE cache_commit_child (
        id INTEGER,
        FOREIGN KEY (id) REFERENCES cache_commit_parent(id)
          DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TRIGGER fail_cache_commit
      AFTER INSERT ON cached_agent_versions
      BEGIN
        INSERT INTO cache_commit_child (id) VALUES (1);
      END;
    `);
    const rename = vi.fn(renameSync);
    const store = new AgentVersionCache({
      database,
      owner,
      trust,
      origin: ORIGIN,
      runtimeVersion: "v0.18.2-agentera.1",
      now: () => NOW,
      randomUUID: () => STAGING_ID,
      rename,
    });
    const destination = join(
      database.paths.versionsPath,
      "accounts",
      owner.tenantId,
      owner.ownerId,
      version.id,
      version.content_digest,
    );

    let failure: unknown;
    try {
      store.cacheVerifiedVersion(version);
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(
      expect.objectContaining<Partial<AgentVersionCacheError>>({
        code: "cache_database_failed",
      }),
    );
    expect(
      database.sqlite
        .prepare(
          `SELECT version_id FROM cached_agent_versions
           WHERE version_id = ? AND tenant_id = ? AND owner_id = ?`,
        )
        .get(version.id, owner.tenantId, owner.ownerId),
    ).toBeUndefined();
    expect(existsSync(destination)).toBe(true);

    database.sqlite.exec("DROP TRIGGER fail_cache_commit");
    expect(store.cacheVerifiedVersion(version)).toEqual(version);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("removes only a recognized stale staging tree before retrying the cache write", () => {
    const versionRoot = join(
      database.paths.versionsPath,
      "accounts",
      owner.tenantId,
      owner.ownerId,
      version.id,
    );
    const stale = join(versionRoot, `.staging-${STALE_STAGING_ID}`);
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "partial.json"), "partial");

    expect(cache().cacheVerifiedVersion(version)).toEqual(version);
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(versionRoot)).toEqual([version.content_digest]);
  });

  it("replaces an incomplete cache-owned destination from a freshly verified version", () => {
    const destination = join(
      database.paths.versionsPath,
      "accounts",
      owner.tenantId,
      owner.ownerId,
      version.id,
      version.content_digest,
    );
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "partial.json"), "partial");

    expect(cache().cacheVerifiedVersion(version)).toEqual(version);
    expect(readdirSync(destination).sort()).toEqual([
      "bundle.json",
      "manifest.json",
      "version.json",
    ]);
    expect(cache().getVerifiedVersion(version.id)).toEqual(version);
  });

  it.each(["EACCES", "EPERM"] as const)(
    "maps %s rename denial to a bounded filesystem code and removes staging",
    (code) => {
      const store = new AgentVersionCache({
        database,
        owner,
        trust,
        origin: ORIGIN,
        runtimeVersion: "v0.18.2-agentera.1",
        now: () => NOW,
        randomUUID: () => STAGING_ID,
        rename: () => {
          throw Object.assign(new Error("private filesystem detail"), { code });
        },
      });

      let failure: unknown;
      try {
        store.cacheVerifiedVersion(version);
      } catch (error) {
        failure = error;
      }
      expect(failure).toEqual(
        expect.objectContaining<Partial<AgentVersionCacheError>>({
          code: "cache_filesystem_denied",
        }),
      );
      expect((failure as Error).message).not.toContain(
        "private filesystem detail",
      );
      const versionRoot = join(
        database.paths.versionsPath,
        "accounts",
        owner.tenantId,
        owner.ownerId,
        version.id,
      );
      expect(existsSync(versionRoot) ? readdirSync(versionRoot) : []).toEqual(
        [],
      );
      expect(
        database.sqlite
          .prepare("SELECT version_id FROM cached_agent_versions")
          .get(),
      ).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "maps an account-directory creation denial to the bounded filesystem code",
    () => {
      chmodSync(database.paths.versionsPath, 0o500);

      let failure: unknown;
      try {
        cache().cacheVerifiedVersion(version);
      } catch (error) {
        failure = error;
      }
      expect(failure).toEqual(
        expect.objectContaining<Partial<AgentVersionCacheError>>({
          code: "cache_filesystem_denied",
        }),
      );
      expect((failure as Error).message).not.toContain(
        database.paths.versionsPath,
      );
    },
  );

  it("converges when another cache instance wins the destination rename", () => {
    const winner = new AgentVersionCache({
      database,
      owner,
      trust,
      origin: ORIGIN,
      runtimeVersion: "v0.18.2-agentera.1",
      now: () => NOW,
      randomUUID: () => WINNER_STAGING_ID,
    });
    const losingRename = vi.fn(() => {
      expect(winner.cacheVerifiedVersion(version)).toEqual(version);
      throw Object.assign(new Error("private destination collision"), {
        code: "EEXIST",
      });
    });
    const loser = new AgentVersionCache({
      database,
      owner,
      trust,
      origin: ORIGIN,
      runtimeVersion: "v0.18.2-agentera.1",
      now: () => NOW,
      randomUUID: () => STAGING_ID,
      rename: losingRename,
    });

    expect(loser.cacheVerifiedVersion(version)).toEqual(version);
    expect(losingRename).toHaveBeenCalledTimes(1);
    expect(
      database.sqlite
        .prepare(
          `SELECT count(*) AS count FROM cached_agent_versions
           WHERE version_id = ? AND tenant_id = ? AND owner_id = ?`,
        )
        .get(version.id, owner.tenantId, owner.ownerId),
    ).toEqual({ count: 1 });
    const versionRoot = join(
      database.paths.versionsPath,
      "accounts",
      owner.tenantId,
      owner.ownerId,
      version.id,
    );
    expect(readdirSync(versionRoot)).toEqual([version.content_digest]);
  });

  it("converges when the winner removes the losing staging tree before rename", () => {
    const winner = new AgentVersionCache({
      database,
      owner,
      trust,
      origin: ORIGIN,
      runtimeVersion: "v0.18.2-agentera.1",
      now: () => NOW,
      randomUUID: () => WINNER_STAGING_ID,
    });
    const losingRename = vi.fn((source: string, destination: string) => {
      expect(winner.cacheVerifiedVersion(version)).toEqual(version);
      expect(existsSync(source)).toBe(false);
      renameSync(source, destination);
    });
    const loser = new AgentVersionCache({
      database,
      owner,
      trust,
      origin: ORIGIN,
      runtimeVersion: "v0.18.2-agentera.1",
      now: () => NOW,
      randomUUID: () => STAGING_ID,
      rename: losingRename,
    });

    expect(loser.cacheVerifiedVersion(version)).toEqual(version);
    expect(losingRename).toHaveBeenCalledTimes(1);
    expect(cache().getVerifiedVersion(version.id)).toEqual(version);
  });

  it("fails closed without deleting either directory when multiple digests exist", () => {
    cache().cacheVerifiedVersion(version);
    database.sqlite
      .prepare(
        `DELETE FROM cached_agent_versions
         WHERE version_id = ? AND tenant_id = ? AND owner_id = ?`,
      )
      .run(version.id, owner.tenantId, owner.ownerId);
    const versionRoot = join(
      database.paths.versionsPath,
      "accounts",
      owner.tenantId,
      owner.ownerId,
      version.id,
    );
    const conflictingDigest = "ef".repeat(32);
    mkdirSync(join(versionRoot, conflictingDigest));

    expect(() => cache().getVerifiedVersion(version.id)).toThrowError(
      expect.objectContaining<Partial<AgentVersionCacheError>>({
        code: "cache_conflict",
      }),
    );
    expect(readdirSync(versionRoot).sort()).toEqual(
      [version.content_digest, conflictingDigest].sort(),
    );
  });

  it("rejects a second digest directory even when the SQLite row is valid", () => {
    cache().cacheVerifiedVersion(version);
    const versionRoot = join(
      database.paths.versionsPath,
      "accounts",
      owner.tenantId,
      owner.ownerId,
      version.id,
    );
    const conflictingDigest = "ef".repeat(32);
    mkdirSync(join(versionRoot, conflictingDigest));

    expect(() => cache().getVerifiedVersion(version.id)).toThrowError(
      expect.objectContaining<Partial<AgentVersionCacheError>>({
        code: "cache_conflict",
      }),
    );
    expect(readdirSync(versionRoot).sort()).toEqual(
      [version.content_digest, conflictingDigest].sort(),
    );
  });

  it("maps SQLite read failures to a bounded database code", () => {
    database.sqlite.exec("DROP TABLE cached_agent_versions");

    let failure: unknown;
    try {
      cache().getVerifiedVersion(version.id);
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(
      expect.objectContaining<Partial<AgentVersionCacheError>>({
        code: "cache_database_failed",
      }),
    );
    expect((failure as Error).message).not.toContain("cached_agent_versions");
  });

  it("does not expose a verified USER version cache across account switches", () => {
    cache().cacheVerifiedVersion(version);
    const other = new AgentVersionCache({
      database,
      owner: {
        tenantId: "12121212-1212-4121-8121-121212121212",
        ownerId: "13131313-1313-4131-8131-131313131313",
      },
      trust,
      origin: ORIGIN,
      runtimeVersion: "v0.18.2-agentera.1",
    });
    expect(() => other.getVerifiedVersion(version.id)).toThrow(
      expect.objectContaining({ code: "cache_not_found" }),
    );
    expect(cache().getVerifiedVersion(version.id)).toEqual(version);
  });

  it("stores the same immutable version in distinct account paths and rows", () => {
    const first = cache();
    const secondOwner = {
      tenantId: "12121212-1212-4121-8121-121212121212",
      ownerId: "13131313-1313-4131-8131-131313131313",
    } as const;
    const second = new AgentVersionCache({
      database,
      owner: secondOwner,
      trust,
      origin: ORIGIN,
      runtimeVersion: "v0.18.2-agentera.1",
      now: () => NOW,
      randomUUID: () => STAGING_ID,
    });

    expect(first.cacheVerifiedVersion(version)).toEqual(version);
    expect(second.cacheVerifiedVersion(version)).toEqual(version);
    expect(first.getVerifiedVersion(version.id)).toEqual(version);
    expect(second.getVerifiedVersion(version.id)).toEqual(version);
    const rows = database.sqlite
      .prepare(
        "SELECT tenant_id, owner_id, cache_relative_path FROM cached_agent_versions WHERE version_id = ? ORDER BY tenant_id, owner_id",
      )
      .all(version.id) as Array<{
      tenant_id: string;
      owner_id: string;
      cache_relative_path: string;
    }>;
    expect(rows).toEqual([
      {
        tenant_id: owner.tenantId,
        owner_id: owner.ownerId,
        cache_relative_path: `accounts/${owner.tenantId}/${owner.ownerId}/${VERSION_ID}/${version.content_digest}`,
      },
      {
        tenant_id: secondOwner.tenantId,
        owner_id: secondOwner.ownerId,
        cache_relative_path: `accounts/${secondOwner.tenantId}/${secondOwner.ownerId}/${VERSION_ID}/${version.content_digest}`,
      },
    ]);
  });

  it("normalizes a valid cloud RFC3339 timestamp before persisting the immutable version", () => {
    const cloudVersion: AgentVersion = {
      ...version,
      published_at: "2026-07-20T03:24:18.287961+08:00",
    };
    const cached = cache().cacheVerifiedVersion(cloudVersion);

    expect(cached.published_at).toBe("2026-07-19T19:24:18.287Z");
    expect(cache().getVerifiedVersion(VERSION_ID).published_at).toBe(
      "2026-07-19T19:24:18.287Z",
    );
  });

  it("rejects corrupted or writable cache content on every use", () => {
    const store = cache();
    store.cacheVerifiedVersion(version);
    const versionFile = join(
      database.paths.versionsPath,
      "accounts",
      owner.tenantId,
      owner.ownerId,
      VERSION_ID,
      version.content_digest,
      "version.json",
    );
    // Windows cache integrity is still enforced by signatures and digests;
    // writable POSIX mode rejection is meaningful only on POSIX hosts.
    if (process.platform !== "win32") {
      chmodSync(versionFile, 0o600);
      expect(() => store.getVerifiedVersion(VERSION_ID)).toThrowError(
        expect.objectContaining<Partial<AgentVersionCacheError>>({
          code: "cache_permissions_invalid",
        }),
      );
    }

    chmodSync(versionFile, 0o600);
    writeFileSync(versionFile, "{}", { mode: 0o400 });
    chmodSync(versionFile, 0o400);
    expect(() => store.getVerifiedVersion(VERSION_ID)).toThrowError(
      expect.objectContaining<Partial<AgentVersionCacheError>>({
        code: "cache_corrupt",
      }),
    );
  });

  it("rejects signature, digest, and Runtime-policy mismatch before staging", () => {
    const store = cache();
    for (const candidate of [
      { ...version, signature: "AA".repeat(43) },
      { ...version, content_digest: "ab".repeat(32) },
    ]) {
      expect(() => store.cacheVerifiedVersion(candidate)).toThrow();
    }
    expect(() => cache("v0.19.0").cacheVerifiedVersion(version)).toThrow(
      /runtime_incompatible/,
    );
    expect(
      existsSync(
        join(
          database.paths.versionsPath,
          "accounts",
          owner.tenantId,
          owner.ownerId,
          VERSION_ID,
        ),
      ),
    ).toBe(false);
  });

  it("retains multiple installation-scoped policies and re-verifies each cached read", () => {
    const store = cache();
    store.cacheVerifiedVersion(version);
    const verifyPolicy = vi
      .spyOn(trust, "verifyPolicy")
      .mockImplementation((policy) => ({
        contentDigest: policy.content_digest,
      }));
    const first = policySnapshot(version);
    const second = policySnapshot(
      version,
      OTHER_POLICY_ID,
      OTHER_INSTALLATION_ID,
    );

    expect(store.cacheVerifiedPolicySnapshot(version.id, first)).toEqual(first);
    expect(store.cacheVerifiedPolicySnapshot(version.id, second)).toEqual(
      second,
    );
    const callsAfterWrites = verifyPolicy.mock.calls.length;
    expect(store.getVerifiedPolicySnapshot(version.id, first.id)).toEqual(
      first,
    );
    expect(store.getVerifiedPolicySnapshot(version.id, second.id)).toEqual(
      second,
    );
    expect(verifyPolicy.mock.calls.length).toBeGreaterThan(callsAfterWrites);
    const row = database.sqlite
      .prepare(
        "SELECT policy_snapshot_json FROM cached_agent_versions WHERE version_id = ?",
      )
      .get(version.id) as { policy_snapshot_json: string };
    const stored = JSON.parse(row.policy_snapshot_json) as {
      snapshots: AgentPolicySnapshot[];
    };
    expect(stored.snapshots.map(({ id }) => id)).toEqual([
      POLICY_ID,
      OTHER_POLICY_ID,
    ]);

    database.sqlite
      .prepare(
        "UPDATE cached_agent_versions SET policy_snapshot_json = '{}' WHERE version_id = ?",
      )
      .run(version.id);
    expect(() =>
      store.getVerifiedPolicySnapshot(version.id, first.id),
    ).toThrowError(
      expect.objectContaining<Partial<AgentVersionCacheError>>({
        code: "cache_corrupt",
      }),
    );
  });

  it("cleans staging and leaves no database row when atomic rename fails", () => {
    const store = new AgentVersionCache({
      database,
      owner,
      trust,
      origin: ORIGIN,
      runtimeVersion: "v0.18.2-agentera.1",
      now: () => NOW,
      randomUUID: () => STAGING_ID,
      rename: () => {
        throw Object.assign(new Error("private rename failure"), {
          code: "EIO",
        });
      },
    });
    let failure: unknown;
    try {
      store.cacheVerifiedVersion(version);
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(
      expect.objectContaining<Partial<AgentVersionCacheError>>({
        code: "cache_filesystem_failed",
      }),
    );
    expect((failure as Error).message).not.toContain("private rename failure");
    const parent = join(
      database.paths.versionsPath,
      "accounts",
      owner.tenantId,
      owner.ownerId,
      VERSION_ID,
    );
    expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
    const row = database.sqlite
      .prepare("SELECT version_id FROM cached_agent_versions")
      .get();
    expect(row).toBeUndefined();
  });

  it("preserves the last good version when a later version fails verification", () => {
    const store = cache();
    store.cacheVerifiedVersion(version);
    const badLaterVersion: AgentVersion = {
      ...version,
      id: OTHER_VERSION_ID,
      version_number: 2,
    };
    expect(() => store.cacheVerifiedVersion(badLaterVersion)).toThrow();
    expect(store.getVerifiedVersion(VERSION_ID)).toEqual(version);
    expect(
      existsSync(
        join(
          database.paths.versionsPath,
          "accounts",
          owner.tenantId,
          owner.ownerId,
          OTHER_VERSION_ID,
        ),
      ),
    ).toBe(false);
  });
});
