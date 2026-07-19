// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
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
      VERSION_ID,
      version.content_digest,
    );
    expect(readdirSync(join(database.paths.versionsPath, VERSION_ID))).toEqual([
      version.content_digest,
    ]);
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
      VERSION_ID,
      version.content_digest,
      "version.json",
    );
    chmodSync(versionFile, 0o600);
    expect(() => store.getVerifiedVersion(VERSION_ID)).toThrowError(
      expect.objectContaining<Partial<AgentVersionCacheError>>({
        code: "cache_permissions_invalid",
      }),
    );

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
    expect(existsSync(join(database.paths.versionsPath, VERSION_ID))).toBe(
      false,
    );
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
        throw new Error("simulated rename failure");
      },
    });
    expect(() => store.cacheVerifiedVersion(version)).toThrow(/rename failure/);
    const parent = join(database.paths.versionsPath, VERSION_ID);
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
      existsSync(join(database.paths.versionsPath, OTHER_VERSION_ID)),
    ).toBe(false);
  });
});
