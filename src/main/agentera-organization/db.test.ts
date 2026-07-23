// @vitest-environment node

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  OrganizationDepartment,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationSummary,
} from "../../shared/agentera-organization";
import { canonicalizeOrganizationPolicyDocument } from "./policy-verifier";
import type { VerifiedOrganizationPolicySnapshot } from "./policy-verifier";
import {
  AGENTERA_ORGANIZATION_SCHEMA_VERSION,
  openAgenteraOrganizationDatabase,
  resolveAgenteraOrganizationPaths,
  type AgenteraOrganizationDatabase,
  type AgenteraOrganizationSqliteDatabase,
} from "./db";

const ACCOUNT_A = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "10000000-0000-4000-8000-000000000002";
const ORGANIZATION_A = "20000000-0000-4000-8000-000000000001";
const ORGANIZATION_B = "20000000-0000-4000-8000-000000000002";
const MEMBER_A = "30000000-0000-4000-8000-000000000001";
const MEMBER_B = "30000000-0000-4000-8000-000000000002";
const DEPARTMENT_A = "40000000-0000-4000-8000-000000000001";
const DEPARTMENT_B = "40000000-0000-4000-8000-000000000002";
const INVITATION_A = "50000000-0000-4000-8000-000000000001";
const INVITATION_B = "50000000-0000-4000-8000-000000000002";
const SNAPSHOT_A = "60000000-0000-4000-8000-000000000001";
const SNAPSHOT_B = "60000000-0000-4000-8000-000000000002";
const IDEMPOTENCY_A = "70000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_B = "70000000-0000-4000-8000-000000000002";
const CREATED_AT = "2026-07-21T01:00:00Z";
const UPDATED_AT = "2026-07-21T02:00:00Z";
const REFRESHED_AT = "2026-07-21T03:00:00Z";
const VERIFIED_AT = "2026-07-21T03:01:00Z";
const REQUEST_DIGEST_A = "a".repeat(64);
const REQUEST_DIGEST_B = "b".repeat(64);

const roots: string[] = [];
const databases: AgenteraOrganizationDatabase[] = [];
const ORIGINAL_HERMES_HOME = process.env.HERMES_HOME;

function temporaryUserData(): string {
  const root = mkdtempSync(join(tmpdir(), "agentera-organization-db-"));
  roots.push(root);
  return join(root, "user-data");
}

function databaseFor(
  userDataPath = temporaryUserData(),
  idempotencyKeys: string[] = [IDEMPOTENCY_A, IDEMPOTENCY_B],
): AgenteraOrganizationDatabase {
  const database = openAgenteraOrganizationDatabase(userDataPath, {
    databaseFactory: (path) =>
      new DatabaseSync(path) as unknown as AgenteraOrganizationSqliteDatabase,
    randomUUID: () => idempotencyKeys.shift() ?? IDEMPOTENCY_B,
  });
  databases.push(database);
  return database;
}

function organization(
  id: string,
  overrides: Partial<OrganizationSummary> = {},
): OrganizationSummary {
  return {
    id,
    displayName: `Organization ${id.slice(-1)}`,
    status: "active",
    revision: 1,
    role: "owner",
    memberCount: 1,
    departmentCount: 0,
    currentPolicyVersion: 1,
    currentPolicyDigest: "c".repeat(64),
    mutationState: "writable",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    archivedAt: null,
    ...overrides,
  };
}

function member(
  userId: string,
  overrides: Partial<OrganizationMember> = {},
): OrganizationMember {
  return {
    userId,
    nickname: `Member ${userId.slice(-1)}`,
    role: "member",
    departmentId: null,
    revision: 1,
    joinedAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function department(
  id: string,
  overrides: Partial<OrganizationDepartment> = {},
): OrganizationDepartment {
  return {
    id,
    displayName: `Department ${id.slice(-1)}`,
    status: "active",
    memberCount: 0,
    revision: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    archivedAt: null,
    ...overrides,
  };
}

function invitation(
  id: string,
  overrides: Partial<OrganizationInvitation> = {},
): OrganizationInvitation {
  return {
    id,
    status: "pending",
    createdByUserId: MEMBER_A,
    acceptedByUserId: null,
    createdAt: CREATED_AT,
    expiresAt: "2026-07-28T01:00:00Z",
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function verifiedPolicy(
  organizationId: string,
  snapshotId: string,
  policyVersion = 1,
): VerifiedOrganizationPolicySnapshot {
  const canonical = canonicalizeOrganizationPolicyDocument({
    schemaVersion: 1,
    models: { allowlist: null },
    tools: { allowlist: null },
    experienceCandidates: { mode: "manual_review" },
    officialAgents: { installation: "allowed" },
  });
  return {
    organizationId,
    snapshot: {
      id: snapshotId,
      policyVersion,
      schemaVersion: 1,
      contentDigest: canonical.contentDigest,
      issuer: "https://cloud.agentera.example",
      signingKeyId: "organization-policy-2026-01",
      createdAt: CREATED_AT,
      document: canonical.document,
      signature: "A".repeat(86),
    },
    canonicalJson: canonical.canonicalJson,
    contentDigest: canonical.contentDigest,
  };
}

afterEach(() => {
  delete process.env.HERMES_HOME;
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  if (ORIGINAL_HERMES_HOME !== undefined) {
    process.env.HERMES_HOME = ORIGINAL_HERMES_HOME;
  }
});

describe("AgenteraOrganizationDatabase", () => {
  it("resolves an absolute mode-restricted database outside HERMES_HOME", () => {
    expect(() => resolveAgenteraOrganizationPaths("relative/path")).toThrow(
      "absolute",
    );

    const userDataPath = temporaryUserData();
    const paths = resolveAgenteraOrganizationPaths(userDataPath);
    expect(paths).toEqual({
      rootPath: join(userDataPath, "agentera-organization"),
      databasePath: join(
        userDataPath,
        "agentera-organization",
        "organization.db",
      ),
    });

    process.env.HERMES_HOME = join(userDataPath, "agentera-organization");
    expect(() => resolveAgenteraOrganizationPaths(userDataPath)).toThrow(
      "outside HERMES_HOME",
    );
    delete process.env.HERMES_HOME;

    const database = databaseFor(userDataPath);
    // Node's POSIX mode projection is not Windows DACL evidence.
    if (process.platform !== "win32") {
      expect(statSync(database.paths.rootPath).mode & 0o777).toBe(0o700);
      expect(statSync(database.databasePath).mode & 0o777).toBe(0o600);
    }
  });

  it("creates only the exact account-partitioned schema", () => {
    const database = databaseFor();
    const version = database.sqlite.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(AGENTERA_ORGANIZATION_SCHEMA_VERSION);

    const tables = database.sqlite
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string; sql: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "organization_departments",
      "organization_invitations",
      "organization_members",
      "organization_mutation_intents",
      "organization_policies",
      "organization_summaries",
    ]);
    expect(tables.every(({ sql }) => sql.includes("account_user_id"))).toBe(
      true,
    );
    expect(tables.map(({ sql }) => sql).join("\n")).not.toMatch(
      /audit|invitation_token|token_digest|profile|memory|session|credential/i,
    );

    const expectedColumns: Record<string, string[]> = {
      organization_summaries: [
        "account_user_id",
        "organization_id",
        "json",
        "refreshed_at",
      ],
      organization_members: [
        "account_user_id",
        "organization_id",
        "user_id",
        "json",
        "refreshed_at",
      ],
      organization_departments: [
        "account_user_id",
        "organization_id",
        "department_id",
        "json",
        "refreshed_at",
      ],
      organization_invitations: [
        "account_user_id",
        "organization_id",
        "invitation_id",
        "json",
        "refreshed_at",
      ],
      organization_policies: [
        "account_user_id",
        "organization_id",
        "snapshot_id",
        "policy_version",
        "json",
        "verified_at",
        "current",
      ],
      organization_mutation_intents: [
        "account_user_id",
        "operation",
        "resource_id",
        "idempotency_key",
        "request_digest",
        "created_at",
      ],
    };
    for (const [table, columns] of Object.entries(expectedColumns)) {
      const actual = database.sqlite
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      expect(actual.map(({ name }) => name)).toEqual(columns);
    }
  });

  it("rejects a database symlink that escapes its protected root", () => {
    const userDataPath = temporaryUserData();
    const paths = resolveAgenteraOrganizationPaths(userDataPath);
    const externalRoot = join(userDataPath, "hermes-data");
    const externalDatabase = join(externalRoot, "organization.db");
    mkdirSync(paths.rootPath, { recursive: true });
    mkdirSync(externalRoot, { recursive: true });
    const raw = new DatabaseSync(externalDatabase);
    raw.close();
    symlinkSync(externalDatabase, paths.databasePath);

    process.env.HERMES_HOME = externalRoot;
    expect(() => databaseFor(userDataPath)).toThrow("outside HERMES_HOME");
    delete process.env.HERMES_HOME;
  });

  it("isolates every cached kind and mutation intent by account", () => {
    const database = databaseFor();
    database.replaceOrganizations(
      ACCOUNT_A,
      [organization(ORGANIZATION_A, { displayName: "Account A" })],
      REFRESHED_AT,
    );
    database.replaceOrganizations(
      ACCOUNT_B,
      [organization(ORGANIZATION_A, { displayName: "Account B" })],
      UPDATED_AT,
    );
    database.replaceMembers(
      ACCOUNT_A,
      ORGANIZATION_A,
      [member(MEMBER_A)],
      REFRESHED_AT,
    );
    database.replaceMembers(
      ACCOUNT_B,
      ORGANIZATION_A,
      [member(MEMBER_B)],
      UPDATED_AT,
    );
    database.replaceDepartments(
      ACCOUNT_A,
      ORGANIZATION_A,
      [department(DEPARTMENT_A)],
      REFRESHED_AT,
    );
    database.replaceDepartments(
      ACCOUNT_B,
      ORGANIZATION_A,
      [department(DEPARTMENT_B)],
      UPDATED_AT,
    );
    database.replaceInvitations(
      ACCOUNT_A,
      ORGANIZATION_A,
      [invitation(INVITATION_A)],
      REFRESHED_AT,
    );
    database.replaceInvitations(
      ACCOUNT_B,
      ORGANIZATION_A,
      [invitation(INVITATION_B)],
      UPDATED_AT,
    );
    database.writeVerifiedPolicy(
      ACCOUNT_A,
      verifiedPolicy(ORGANIZATION_A, SNAPSHOT_A),
      VERIFIED_AT,
    );
    database.writeVerifiedPolicy(
      ACCOUNT_B,
      verifiedPolicy(ORGANIZATION_A, SNAPSHOT_B),
      UPDATED_AT,
    );
    const intentA = database.acquireMutationIntent(ACCOUNT_A, {
      operation: "organization.rename",
      resourceId: ORGANIZATION_A,
      requestDigest: REQUEST_DIGEST_A,
      createdAt: CREATED_AT,
    });
    const intentB = database.acquireMutationIntent(ACCOUNT_B, {
      operation: "organization.rename",
      resourceId: ORGANIZATION_A,
      requestDigest: REQUEST_DIGEST_A,
      createdAt: CREATED_AT,
    });

    expect(database.readOrganizations(ACCOUNT_A)).toMatchObject({
      organizations: [{ displayName: "Account A" }],
      refreshedAt: REFRESHED_AT,
    });
    expect(database.readOrganizations(ACCOUNT_B)).toMatchObject({
      organizations: [{ displayName: "Account B" }],
      refreshedAt: UPDATED_AT,
    });
    expect(database.readMembers(ACCOUNT_A, ORGANIZATION_A).members).toEqual([
      member(MEMBER_A),
    ]);
    expect(database.readMembers(ACCOUNT_B, ORGANIZATION_A).members).toEqual([
      member(MEMBER_B),
    ]);
    expect(
      database.readDepartments(ACCOUNT_A, ORGANIZATION_A).departments,
    ).toEqual([department(DEPARTMENT_A)]);
    expect(
      database.readDepartments(ACCOUNT_B, ORGANIZATION_A).departments,
    ).toEqual([department(DEPARTMENT_B)]);
    expect(
      database.readInvitations(ACCOUNT_A, ORGANIZATION_A).invitations,
    ).toEqual([invitation(INVITATION_A)]);
    expect(
      database.readInvitations(ACCOUNT_B, ORGANIZATION_A).invitations,
    ).toEqual([invitation(INVITATION_B)]);
    expect(
      database.readCurrentPolicy(ACCOUNT_A, ORGANIZATION_A).policy?.snapshot.id,
    ).toBe(SNAPSHOT_A);
    expect(
      database.readCurrentPolicy(ACCOUNT_B, ORGANIZATION_A).policy?.snapshot.id,
    ).toBe(SNAPSHOT_B);
    expect(intentA.idempotencyKey).toBe(IDEMPOTENCY_A);
    expect(intentB.idempotencyKey).toBe(IDEMPOTENCY_B);
  });

  it("replaces atomically, prunes removed children, and preserves other accounts", () => {
    const database = databaseFor();
    database.replaceOrganizations(
      ACCOUNT_A,
      [organization(ORGANIZATION_A), organization(ORGANIZATION_B)],
      CREATED_AT,
    );
    database.replaceOrganizations(
      ACCOUNT_B,
      [organization(ORGANIZATION_B)],
      CREATED_AT,
    );
    for (const account of [ACCOUNT_A, ACCOUNT_B]) {
      database.replaceMembers(
        account,
        ORGANIZATION_B,
        [member(MEMBER_B)],
        CREATED_AT,
      );
      database.replaceDepartments(
        account,
        ORGANIZATION_B,
        [department(DEPARTMENT_B)],
        CREATED_AT,
      );
      database.replaceInvitations(
        account,
        ORGANIZATION_B,
        [invitation(INVITATION_B)],
        CREATED_AT,
      );
      database.writeVerifiedPolicy(
        account,
        verifiedPolicy(ORGANIZATION_B, SNAPSHOT_B),
        VERIFIED_AT,
      );
    }

    database.replaceOrganizations(
      ACCOUNT_A,
      [organization(ORGANIZATION_A, { revision: 2 })],
      REFRESHED_AT,
    );
    expect(database.readOrganizations(ACCOUNT_A)).toEqual({
      organizations: [organization(ORGANIZATION_A, { revision: 2 })],
      refreshedAt: REFRESHED_AT,
    });
    expect(database.readMembers(ACCOUNT_A, ORGANIZATION_B).members).toEqual([]);
    expect(
      database.readDepartments(ACCOUNT_A, ORGANIZATION_B).departments,
    ).toEqual([]);
    expect(
      database.readInvitations(ACCOUNT_A, ORGANIZATION_B).invitations,
    ).toEqual([]);
    expect(database.readPolicies(ACCOUNT_A, ORGANIZATION_B)).toEqual([]);
    expect(
      database.readMembers(ACCOUNT_B, ORGANIZATION_B).members,
    ).toHaveLength(1);

    database.replaceMembers(
      ACCOUNT_A,
      ORGANIZATION_A,
      [member(MEMBER_A), member(MEMBER_B)],
      CREATED_AT,
    );
    database.replaceMembers(
      ACCOUNT_A,
      ORGANIZATION_A,
      [member(MEMBER_B, { revision: 2 })],
      UPDATED_AT,
    );
    expect(database.readMembers(ACCOUNT_A, ORGANIZATION_A)).toEqual({
      members: [member(MEMBER_B, { revision: 2 })],
      refreshedAt: UPDATED_AT,
    });

    expect(() =>
      database.replaceMembers(
        ACCOUNT_A,
        ORGANIZATION_A,
        [member(MEMBER_A), member(MEMBER_A)],
        REFRESHED_AT,
      ),
    ).toThrow("Duplicate");
    expect(database.readMembers(ACCOUNT_A, ORGANIZATION_A)).toEqual({
      members: [member(MEMBER_B, { revision: 2 })],
      refreshedAt: UPDATED_AT,
    });
  });

  it("retains the last verified policy when a replacement is invalid", () => {
    const database = databaseFor();
    database.replaceOrganizations(
      ACCOUNT_A,
      [organization(ORGANIZATION_A)],
      REFRESHED_AT,
    );
    const first = verifiedPolicy(ORGANIZATION_A, SNAPSHOT_A, 1);
    database.writeVerifiedPolicy(ACCOUNT_A, first, VERIFIED_AT);

    const invalid = {
      ...verifiedPolicy(ORGANIZATION_A, SNAPSHOT_B, 2),
      contentDigest: REQUEST_DIGEST_A,
    } as VerifiedOrganizationPolicySnapshot;
    expect(() =>
      database.writeVerifiedPolicy(ACCOUNT_A, invalid, UPDATED_AT),
    ).toThrow("verified policy");
    expect(database.readCurrentPolicy(ACCOUNT_A, ORGANIZATION_A)).toEqual({
      policy: first,
      verifiedAt: VERIFIED_AT,
    });

    expect(() =>
      database.writeVerifiedPolicy(
        ACCOUNT_A,
        verifiedPolicy(ORGANIZATION_A, SNAPSHOT_B, 1),
        UPDATED_AT,
      ),
    ).toThrow("stale");
    expect(database.readCurrentPolicy(ACCOUNT_A, ORGANIZATION_A)).toEqual({
      policy: first,
      verifiedAt: VERIFIED_AT,
    });

    const second = verifiedPolicy(ORGANIZATION_A, SNAPSHOT_B, 2);
    database.writeVerifiedPolicy(ACCOUNT_A, second, UPDATED_AT);
    expect(database.readCurrentPolicy(ACCOUNT_A, ORGANIZATION_A)).toEqual({
      policy: second,
      verifiedAt: UPDATED_AT,
    });
    expect(() =>
      database.writeVerifiedPolicy(ACCOUNT_A, first, REFRESHED_AT),
    ).toThrow("stale");
    expect(database.readCurrentPolicy(ACCOUNT_A, ORGANIZATION_A)).toEqual({
      policy: second,
      verifiedAt: UPDATED_AT,
    });
    expect(database.readPolicies(ACCOUNT_A, ORGANIZATION_A)).toEqual([
      { policy: first, verifiedAt: VERIFIED_AT, current: false },
      { policy: second, verifiedAt: UPDATED_AT, current: true },
    ]);
  });

  it("persists only reusable non-secret mutation intents", () => {
    const database = databaseFor();
    const input = {
      operation: "organization.rename",
      resourceId: ORGANIZATION_A,
      requestDigest: REQUEST_DIGEST_A,
      createdAt: CREATED_AT,
    };
    const first = database.acquireMutationIntent(ACCOUNT_A, input);
    const replay = database.acquireMutationIntent(ACCOUNT_A, {
      ...input,
      createdAt: UPDATED_AT,
    });
    expect(replay).toEqual(first);
    expect(() =>
      database.acquireMutationIntent(ACCOUNT_A, {
        ...input,
        requestDigest: REQUEST_DIGEST_B,
      }),
    ).toThrow("conflicting mutation intent");
    expect(
      database.readMutationIntent(
        ACCOUNT_A,
        "organization.rename",
        ORGANIZATION_A,
      ),
    ).toEqual(first);

    database.completeMutationIntent(ACCOUNT_A, first.idempotencyKey);
    expect(
      database.readMutationIntent(
        ACCOUNT_A,
        "organization.rename",
        ORGANIZATION_A,
      ),
    ).toBeNull();

    expect(() =>
      database.acquireMutationIntent(ACCOUNT_A, {
        operation: "organization.invitation.accept",
        resourceId: "raw-secret-token",
        requestDigest: REQUEST_DIGEST_A,
        createdAt: CREATED_AT,
      }),
    ).toThrow("resource ID");
  });

  it("purges one account and closes idempotently", () => {
    const database = databaseFor();
    database.replaceOrganizations(
      ACCOUNT_A,
      [organization(ORGANIZATION_A)],
      REFRESHED_AT,
    );
    database.replaceOrganizations(
      ACCOUNT_B,
      [organization(ORGANIZATION_B)],
      REFRESHED_AT,
    );
    database.replaceMembers(
      ACCOUNT_A,
      ORGANIZATION_A,
      [member(MEMBER_A)],
      REFRESHED_AT,
    );
    database.acquireMutationIntent(ACCOUNT_A, {
      operation: "organization.rename",
      resourceId: ORGANIZATION_A,
      requestDigest: REQUEST_DIGEST_A,
      createdAt: CREATED_AT,
    });

    database.purgeAccount(ACCOUNT_A);
    expect(database.readOrganizations(ACCOUNT_A).organizations).toEqual([]);
    expect(database.readMembers(ACCOUNT_A, ORGANIZATION_A).members).toEqual([]);
    expect(database.readOrganizations(ACCOUNT_B).organizations).toHaveLength(1);

    database.close();
    database.close();
    expect(() => database.readOrganizations(ACCOUNT_B)).toThrow("closed");
  });

  it("rejects invitation secrets and keeps forbidden domains out of the cache", () => {
    const database = databaseFor();
    const secret = "SENSITIVE_INVITATION_TOKEN_MUST_NOT_PERSIST";
    const unsafe = {
      ...invitation(INVITATION_A),
      token: secret,
      inviteUrl: `agentera://organization-invitation#${secret}`,
    } as unknown as OrganizationInvitation;
    expect(() =>
      database.replaceInvitations(
        ACCOUNT_A,
        ORGANIZATION_A,
        [unsafe],
        REFRESHED_AT,
      ),
    ).toThrow("fields");
    expect(readFileSync(database.databasePath, "utf8")).not.toContain(secret);

    const source = readFileSync(new URL("./db.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /agentera-agent-control|agentera-workspace|profile_path|runtime_profile|RuntimeBinding|Curator|legacy-sync/i,
    );
  });

  it("rejects unsupported schema versions and repairs restrictive modes", () => {
    const userDataPath = temporaryUserData();
    const first = databaseFor(userDataPath);
    const databasePath = first.databasePath;
    first.close();
    chmodSync(databasePath, 0o666);

    const reopened = databaseFor(userDataPath);
    if (process.platform !== "win32") {
      expect(statSync(reopened.databasePath).mode & 0o777).toBe(0o600);
    }
    reopened.close();

    const raw = new DatabaseSync(databasePath);
    raw.exec("PRAGMA user_version = 2");
    raw.close();
    expect(() => databaseFor(userDataPath)).toThrow("Unsupported");
  });
});
