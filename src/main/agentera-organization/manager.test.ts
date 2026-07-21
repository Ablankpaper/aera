// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type {
  OrganizationAuditEvent,
  OrganizationDepartment,
  OrganizationInvitation,
  OrganizationInvitationAcceptance,
  OrganizationInvitationCreation,
  OrganizationMember,
  OrganizationPage,
  OrganizationPolicyDocument,
  OrganizationPolicySnapshot,
  OrganizationPolicySummary,
  OrganizationSummary,
} from "../../shared/agentera-organization";
import { AgenteraOrganizationClientError } from "./client";
import {
  openAgenteraOrganizationDatabase,
  type AgenteraOrganizationDatabase,
  type AgenteraOrganizationSqliteDatabase,
} from "./db";
import {
  AgenteraOrganizationPolicyVerificationError,
  canonicalizeOrganizationPolicyDocument,
  type OrganizationSigningKeySet,
  type VerifiedOrganizationPolicySnapshot,
} from "./policy-verifier";
import {
  AgenteraOrganizationManager,
  type AgenteraOrganizationCloudClient,
  type AgenteraOrganizationPolicyVerifierSurface,
} from "./manager";

const ACCOUNT_A = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "10000000-0000-4000-8000-000000000002";
const PERSONAL_A = "11000000-0000-4000-8000-000000000001";
const PERSONAL_B = "11000000-0000-4000-8000-000000000002";
const ORGANIZATION_A = "20000000-0000-4000-8000-000000000001";
const ORGANIZATION_B = "20000000-0000-4000-8000-000000000002";
const ORGANIZATION_MEMBER = "20000000-0000-4000-8000-000000000003";
const ORGANIZATION_AUDITOR = "20000000-0000-4000-8000-000000000004";
const MEMBER_A = "30000000-0000-4000-8000-000000000001";
const DEPARTMENT_A = "40000000-0000-4000-8000-000000000001";
const INVITATION_A = "50000000-0000-4000-8000-000000000001";
const SNAPSHOT_A = "60000000-0000-4000-8000-000000000001";
const SNAPSHOT_B = "60000000-0000-4000-8000-000000000002";
const AUDIT_A = "70000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_A = "80000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_B = "80000000-0000-4000-8000-000000000002";
const CREATED_AT = "2026-07-21T01:00:00Z";
const UPDATED_AT = "2026-07-21T02:00:00Z";
const REFRESHED_AT = "2026-07-21T03:00:00Z";
const NOW = "2026-07-21T04:00:00Z";
const RAW_TOKEN = "A".repeat(43);

const roots: string[] = [];
const managers: AgenteraOrganizationManager[] = [];

function temporaryUserData(): string {
  const root = mkdtempSync(join(tmpdir(), "agentera-organization-manager-"));
  roots.push(root);
  return join(root, "user-data");
}

function databaseFor(
  userDataPath = temporaryUserData(),
): AgenteraOrganizationDatabase {
  return openAgenteraOrganizationDatabase(userDataPath, {
    databaseFactory: (path) =>
      new DatabaseSync(path) as unknown as AgenteraOrganizationSqliteDatabase,
    randomUUID: vi
      .fn<() => string>()
      .mockReturnValueOnce(IDEMPOTENCY_A)
      .mockReturnValue(IDEMPOTENCY_B),
  });
}

function authState(
  user: "A" | "B" = "A",
  status: "authenticated" | "offline" = "authenticated",
  cloudAvailable = status === "authenticated",
): AgenteraAuthPublicState {
  return {
    status,
    userId: user === "A" ? ACCOUNT_A : ACCOUNT_B,
    personalSpaceId: user === "A" ? PERSONAL_A : PERSONAL_B,
    deviceId: "90000000-0000-4000-8000-000000000001",
    offlineExpiresAt: "2026-07-28T04:00:00Z",
    cloudAvailable,
  };
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
  overrides: Partial<OrganizationDepartment> = {},
): OrganizationDepartment {
  return {
    id: DEPARTMENT_A,
    displayName: "Research",
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
  overrides: Partial<OrganizationInvitation> = {},
): OrganizationInvitation {
  return {
    id: INVITATION_A,
    status: "pending",
    createdByUserId: ACCOUNT_A,
    acceptedByUserId: null,
    createdAt: CREATED_AT,
    expiresAt: "2026-07-28T01:00:00Z",
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function policyDocument(): OrganizationPolicyDocument {
  return {
    schemaVersion: 1,
    models: { allowlist: null },
    tools: { allowlist: null },
    experienceCandidates: { mode: "manual_review" },
    officialAgents: { installation: "allowed" },
  };
}

function policySnapshot(
  id = SNAPSHOT_A,
  version = 1,
  full = true,
): OrganizationPolicySnapshot {
  const canonical = canonicalizeOrganizationPolicyDocument(policyDocument());
  return {
    id,
    policyVersion: version,
    schemaVersion: 1,
    contentDigest: canonical.contentDigest,
    issuer: "https://cloud.agentera.example",
    signingKeyId: "organization-policy-2026-01",
    createdAt: CREATED_AT,
    document: full ? canonical.document : null,
    signature: full ? "A".repeat(86) : null,
  };
}

function verifiedPolicy(
  organizationId = ORGANIZATION_A,
  snapshot = policySnapshot(),
): VerifiedOrganizationPolicySnapshot {
  if (snapshot.document === null || snapshot.signature === null) {
    throw new Error("fixture requires a full policy");
  }
  const canonical = canonicalizeOrganizationPolicyDocument(snapshot.document);
  return {
    organizationId,
    snapshot: {
      ...snapshot,
      document: canonical.document,
      signature: snapshot.signature,
    },
    canonicalJson: canonical.canonicalJson,
    contentDigest: canonical.contentDigest,
  };
}

function auditEvent(): OrganizationAuditEvent {
  return {
    id: AUDIT_A,
    eventType: "organization.created",
    objectType: "organization",
    objectId: ORGANIZATION_A,
    outcome: "success",
    reasonCode: null,
    requestId: "request-1",
    actorDisplay: "Owner",
    subjectDisplay: null,
    createdAt: CREATED_AT,
  };
}

function page<T>(items: T[]): OrganizationPage<T> {
  return { items, nextCursor: null };
}

function cloudClient(): AgenteraOrganizationCloudClient {
  return {
    listOrganizations: vi.fn(async () => page([])),
    createOrganization: vi.fn(async (displayName) =>
      organization(ORGANIZATION_A, { displayName }),
    ),
    getOrganization: vi.fn(async (organizationId) =>
      organization(organizationId),
    ),
    renameOrganization: vi.fn(async (organizationId, displayName) =>
      organization(organizationId, { displayName, revision: 2 }),
    ),
    archiveOrganization: vi.fn(async (organizationId) =>
      organization(organizationId, {
        status: "archived",
        mutationState: "archived",
        revision: 2,
        archivedAt: UPDATED_AT,
      }),
    ),
    restoreOrganization: vi.fn(async (organizationId) =>
      organization(organizationId, { revision: 3 }),
    ),
    transferOwner: vi.fn(async (organizationId) =>
      organization(organizationId, { role: "admin", revision: 2 }),
    ),
    dissolveOrganization: vi.fn(async (organizationId) =>
      organization(organizationId, {
        status: "dissolved",
        mutationState: "dissolved",
        revision: 2,
        archivedAt: UPDATED_AT,
      }),
    ),
    listMembers: vi.fn(async () => page([])),
    patchMember: vi.fn(async (_organizationId, userId) => member(userId)),
    removeMember: vi.fn(async () => undefined),
    leaveOrganization: vi.fn(async () => undefined),
    listDepartments: vi.fn(async () => page([])),
    createDepartment: vi.fn(async () => department()),
    renameDepartment: vi.fn(async () => department({ revision: 2 })),
    archiveDepartment: vi.fn(async () =>
      department({
        status: "archived",
        revision: 2,
        archivedAt: UPDATED_AT,
      }),
    ),
    restoreDepartment: vi.fn(async () => department({ revision: 3 })),
    listInvitations: vi.fn(async () => page([])),
    createInvitation: vi.fn(
      async (): Promise<OrganizationInvitationCreation> => ({
        invitation: invitation(),
        token: RAW_TOKEN,
        inviteUrl: `agentera://organization-invitation#${RAW_TOKEN}`,
        secretReplayable: false,
      }),
    ),
    revokeInvitation: vi.fn(async () => undefined),
    acceptInvitation: vi.fn(
      async (): Promise<OrganizationInvitationAcceptance> => ({
        organization: organization(ORGANIZATION_B, { role: "member" }),
        member: member(ACCOUNT_A),
      }),
    ),
    getCurrentPolicy: vi.fn(async () => policySnapshot()),
    listPolicySnapshots: vi.fn(async () => page<OrganizationPolicySummary>([])),
    publishPolicy: vi.fn(async () => policySnapshot(SNAPSHOT_B, 2)),
    getPolicySnapshot: vi.fn(async () => policySnapshot()),
    listAuditEvents: vi.fn(async () => page([])),
    getSigningKeys: vi.fn(
      async () => ({ keys: [] }) as OrganizationSigningKeySet,
    ),
  };
}

function policyVerifier(): AgenteraOrganizationPolicyVerifierSurface {
  return {
    verify: vi.fn(({ organizationId, snapshot }) =>
      verifiedPolicy(organizationId, snapshot),
    ),
  };
}

function managerFor(options: {
  database?: AgenteraOrganizationDatabase;
  client?: AgenteraOrganizationCloudClient;
  verifier?: AgenteraOrganizationPolicyVerifierSurface;
  getAuthState: () => AgenteraAuthPublicState;
}): AgenteraOrganizationManager {
  const manager = new AgenteraOrganizationManager({
    database: options.database ?? databaseFor(),
    client: options.client ?? cloudClient(),
    policyVerifier: options.verifier ?? policyVerifier(),
    getAuthState: options.getAuthState,
    now: () => NOW,
  });
  managers.push(manager);
  return manager;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const manager of managers.splice(0)) manager.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AgenteraOrganizationManager", () => {
  it("refreshes authenticated summaries and exposes the exact stale time", async () => {
    const database = databaseFor();
    const client = cloudClient();
    vi.mocked(client.listOrganizations).mockResolvedValue(
      page([organization(ORGANIZATION_A)]),
    );
    const manager = managerFor({
      database,
      client,
      getAuthState: () => authState(),
    });
    const emitted = vi.fn();
    manager.subscribe(emitted);

    await expect(manager.getState()).resolves.toEqual({
      access: "online",
      cloudAvailable: true,
      stale: true,
      refreshedAt: null,
      organizations: [],
    });
    await expect(manager.refresh()).resolves.toEqual({
      access: "online",
      cloudAvailable: true,
      stale: false,
      refreshedAt: NOW,
      organizations: [organization(ORGANIZATION_A)],
    });
    expect(database.readOrganizations(ACCOUNT_A)).toEqual({
      organizations: [organization(ORGANIZATION_A)],
      refreshedAt: NOW,
    });
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it("serves only approved stale resources offline and creates no mutation queue", async () => {
    const database = databaseFor();
    database.replaceOrganizations(
      ACCOUNT_A,
      [organization(ORGANIZATION_A)],
      REFRESHED_AT,
    );
    database.replaceMembers(
      ACCOUNT_A,
      ORGANIZATION_A,
      [member(MEMBER_A)],
      REFRESHED_AT,
    );
    database.replaceDepartments(
      ACCOUNT_A,
      ORGANIZATION_A,
      [department()],
      REFRESHED_AT,
    );
    database.replaceInvitations(
      ACCOUNT_A,
      ORGANIZATION_A,
      [invitation()],
      REFRESHED_AT,
    );
    database.writeVerifiedPolicy(ACCOUNT_A, verifiedPolicy(), REFRESHED_AT);
    const client = cloudClient();
    const manager = managerFor({
      database,
      client,
      getAuthState: () => authState("A", "offline", false),
    });

    await expect(manager.getState()).resolves.toMatchObject({
      access: "offline",
      cloudAvailable: false,
      stale: true,
      refreshedAt: REFRESHED_AT,
    });
    await expect(
      manager.listMembers({ organizationId: ORGANIZATION_A }),
    ).resolves.toEqual({
      items: [member(MEMBER_A)],
      stale: true,
      refreshedAt: REFRESHED_AT,
    });
    await expect(
      manager.listDepartments({ organizationId: ORGANIZATION_A }),
    ).resolves.toEqual({
      items: [department()],
      stale: true,
      refreshedAt: REFRESHED_AT,
    });
    await expect(
      manager.getCurrentPolicy({ organizationId: ORGANIZATION_A }),
    ).resolves.toMatchObject({
      policy: { id: SNAPSHOT_A, document: policyDocument() },
      stale: true,
      verifiedAt: REFRESHED_AT,
      errorCode: null,
    });

    await expect(
      manager.listInvitations({ organizationId: ORGANIZATION_A }),
    ).rejects.toMatchObject({ code: "online_required" });
    await expect(
      manager.listAuditEvents({ organizationId: ORGANIZATION_A }),
    ).rejects.toMatchObject({ code: "online_required" });
    await expect(
      manager.create({ displayName: "Offline" }),
    ).rejects.toMatchObject({ code: "online_required" });
    const intents = database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM organization_mutation_intents WHERE account_user_id = ?",
      )
      .get(ACCOUNT_A) as { count: number };
    expect(intents.count).toBe(0);
    expect(client.createOrganization).not.toHaveBeenCalled();
  });

  it("fetches role-specific policy and management resources without widening Member data", async () => {
    const database = databaseFor();
    const client = cloudClient();
    const verifier = policyVerifier();
    vi.mocked(client.listOrganizations).mockResolvedValue(
      page([
        organization(ORGANIZATION_A, { role: "owner" }),
        organization(ORGANIZATION_MEMBER, { role: "member" }),
        organization(ORGANIZATION_AUDITOR, { role: "auditor" }),
      ]),
    );
    vi.mocked(client.getCurrentPolicy).mockImplementation(async (id) =>
      id === ORGANIZATION_MEMBER
        ? policySnapshot(SNAPSHOT_B, 1, false)
        : policySnapshot(),
    );
    vi.mocked(client.listInvitations).mockResolvedValue(page([invitation()]));
    vi.mocked(client.listAuditEvents).mockResolvedValue(page([auditEvent()]));
    const manager = managerFor({
      database,
      client,
      verifier,
      getAuthState: () => authState(),
    });
    await manager.refresh();

    await expect(
      manager.getCurrentPolicy({ organizationId: ORGANIZATION_A }),
    ).resolves.toMatchObject({
      policy: { id: SNAPSHOT_A, document: policyDocument() },
      stale: false,
      errorCode: null,
    });
    await expect(
      manager.getCurrentPolicy({ organizationId: ORGANIZATION_MEMBER }),
    ).resolves.toEqual({
      policy: policySnapshot(SNAPSHOT_B, 1, false),
      stale: false,
      verifiedAt: null,
      errorCode: null,
    });
    expect(client.getSigningKeys).toHaveBeenCalledTimes(1);
    expect(verifier.verify).toHaveBeenCalledTimes(1);

    await expect(
      manager.listInvitations({ organizationId: ORGANIZATION_MEMBER }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      manager.listInvitations({ organizationId: ORGANIZATION_A }),
    ).resolves.toMatchObject({ items: [invitation()], stale: false });
    await expect(
      manager.listAuditEvents({ organizationId: ORGANIZATION_MEMBER }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      manager.listAuditEvents({ organizationId: ORGANIZATION_AUDITOR }),
    ).resolves.toEqual(page([auditEvent()]));
  });

  it("discards a late refresh from the previous account generation", async () => {
    const database = databaseFor();
    database.replaceOrganizations(
      ACCOUNT_B,
      [organization(ORGANIZATION_B)],
      REFRESHED_AT,
    );
    const pending = deferred<OrganizationPage<OrganizationSummary>>();
    const client = cloudClient();
    vi.mocked(client.listOrganizations).mockReturnValue(pending.promise);
    let auth = authState("A");
    const manager = managerFor({
      database,
      client,
      getAuthState: () => auth,
    });

    const refresh = manager.refresh();
    auth = authState("B");
    pending.resolve(page([organization(ORGANIZATION_A)]));
    await expect(refresh).resolves.toMatchObject({
      stale: true,
      organizations: [organization(ORGANIZATION_B)],
    });
    expect(database.readOrganizations(ACCOUNT_A).organizations).toEqual([]);
    expect(database.readOrganizations(ACCOUNT_B).organizations).toEqual([
      organization(ORGANIZATION_B),
    ]);
  });

  it("keeps a late successful mutation out of the next account cache", async () => {
    const database = databaseFor();
    const pending = deferred<OrganizationSummary>();
    const client = cloudClient();
    vi.mocked(client.createOrganization).mockReturnValue(pending.promise);
    let auth = authState("A");
    const manager = managerFor({
      database,
      client,
      getAuthState: () => auth,
    });

    const creation = manager.create({ displayName: "Late" });
    auth = authState("B");
    pending.resolve(organization(ORGANIZATION_A, { displayName: "Late" }));
    await expect(creation).rejects.toMatchObject({ code: "unauthenticated" });
    expect(database.readOrganizations(ACCOUNT_A).organizations).toEqual([]);
    expect(database.readOrganizations(ACCOUNT_B).organizations).toEqual([]);
    expect(
      database.readMutationIntent(ACCOUNT_A, "organization.create", ACCOUNT_A)
        ?.idempotencyKey,
    ).toBe(IDEMPOTENCY_A);
  });

  it("retains and returns the previous valid policy on verification failure", async () => {
    const database = databaseFor();
    database.replaceOrganizations(
      ACCOUNT_A,
      [organization(ORGANIZATION_A)],
      REFRESHED_AT,
    );
    const previous = verifiedPolicy();
    database.writeVerifiedPolicy(ACCOUNT_A, previous, REFRESHED_AT);
    const client = cloudClient();
    vi.mocked(client.getCurrentPolicy).mockResolvedValue(
      policySnapshot(SNAPSHOT_B, 2),
    );
    const verifier = policyVerifier();
    vi.mocked(verifier.verify).mockImplementation(() => {
      throw new AgenteraOrganizationPolicyVerificationError(
        "signature_invalid",
      );
    });
    const manager = managerFor({
      database,
      client,
      verifier,
      getAuthState: () => authState(),
    });

    await expect(
      manager.getCurrentPolicy({ organizationId: ORGANIZATION_A }),
    ).resolves.toEqual({
      policy: previous.snapshot,
      stale: true,
      verifiedAt: REFRESHED_AT,
      errorCode: "policy_verification_failed",
    });
    expect(database.readCurrentPolicy(ACCOUNT_A, ORGANIZATION_A)).toEqual({
      policy: previous,
      verifiedAt: REFRESHED_AT,
    });
  });

  it("prunes authoritative removals together with their cached resources", async () => {
    const database = databaseFor();
    database.replaceOrganizations(
      ACCOUNT_A,
      [organization(ORGANIZATION_A)],
      REFRESHED_AT,
    );
    database.replaceMembers(
      ACCOUNT_A,
      ORGANIZATION_A,
      [member(MEMBER_A)],
      REFRESHED_AT,
    );
    database.replaceDepartments(
      ACCOUNT_A,
      ORGANIZATION_A,
      [department()],
      REFRESHED_AT,
    );
    database.writeVerifiedPolicy(ACCOUNT_A, verifiedPolicy(), REFRESHED_AT);
    const client = cloudClient();
    vi.mocked(client.listOrganizations).mockResolvedValue(page([]));
    const manager = managerFor({
      database,
      client,
      getAuthState: () => authState(),
    });

    await manager.refresh();
    expect(database.readOrganizations(ACCOUNT_A).organizations).toEqual([]);
    expect(database.readMembers(ACCOUNT_A, ORGANIZATION_A).members).toEqual([]);
    expect(
      database.readDepartments(ACCOUNT_A, ORGANIZATION_A).departments,
    ).toEqual([]);
    expect(database.readPolicies(ACCOUNT_A, ORGANIZATION_A)).toEqual([]);
  });

  it("reuses a durable idempotency key after ambiguity and rejects changed content", async () => {
    const database = databaseFor();
    const client = cloudClient();
    vi.mocked(client.createOrganization)
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(
        organization(ORGANIZATION_A, { displayName: "Research" }),
      );
    const manager = managerFor({
      database,
      client,
      getAuthState: () => authState(),
    });

    await expect(manager.create({ displayName: "Research" })).rejects.toThrow(
      "connection reset",
    );
    const intent = database.readMutationIntent(
      ACCOUNT_A,
      "organization.create",
      ACCOUNT_A,
    );
    expect(intent?.idempotencyKey).toBe(IDEMPOTENCY_A);
    await expect(
      manager.create({ displayName: "Changed" }),
    ).rejects.toMatchObject({ code: "mutation_pending" });

    await expect(
      manager.create({ displayName: "Research" }),
    ).resolves.toMatchObject({ id: ORGANIZATION_A, displayName: "Research" });
    expect(client.createOrganization).toHaveBeenNthCalledWith(
      1,
      "Research",
      IDEMPOTENCY_A,
    );
    expect(client.createOrganization).toHaveBeenNthCalledWith(
      2,
      "Research",
      IDEMPOTENCY_A,
    );
    expect(
      database.readMutationIntent(ACCOUNT_A, "organization.create", ACCOUNT_A),
    ).toBeNull();
  });

  it("clears a retry intent after a definitive cloud rejection", async () => {
    const database = databaseFor();
    const client = cloudClient();
    vi.mocked(client.createOrganization).mockRejectedValue(
      new AgenteraOrganizationClientError(409, "organization_conflict"),
    );
    const manager = managerFor({
      database,
      client,
      getAuthState: () => authState(),
    });

    await expect(
      manager.create({ displayName: "Rejected" }),
    ).rejects.toMatchObject({ status: 409, code: "organization_conflict" });
    expect(
      database.readMutationIntent(ACCOUNT_A, "organization.create", ACCOUNT_A),
    ).toBeNull();
  });

  it("applies the complete online lifecycle to safe local projections", async () => {
    const database = databaseFor();
    database.replaceOrganizations(
      ACCOUNT_A,
      [organization(ORGANIZATION_A)],
      REFRESHED_AT,
    );
    database.replaceMembers(
      ACCOUNT_A,
      ORGANIZATION_A,
      [member(MEMBER_A)],
      REFRESHED_AT,
    );
    const client = cloudClient();
    const manager = managerFor({
      database,
      client,
      getAuthState: () => authState(),
    });

    await manager.rename({
      organizationId: ORGANIZATION_A,
      displayName: "Renamed",
      expectedRevision: 1,
    });
    await manager.archive({
      organizationId: ORGANIZATION_A,
      expectedRevision: 2,
    });
    await manager.restore({
      organizationId: ORGANIZATION_A,
      expectedRevision: 2,
    });
    await manager.transferOwner({
      organizationId: ORGANIZATION_A,
      targetUserId: MEMBER_A,
      expectedOrganizationRevision: 3,
      expectedOwnerRevision: 1,
      expectedTargetRevision: 1,
      confirmation: "transfer-organization-owner",
    });
    await manager.patchMember({
      organizationId: ORGANIZATION_A,
      userId: MEMBER_A,
      patch: { role: "admin", expectedRevision: 1 },
    });
    await manager.createDepartment({
      organizationId: ORGANIZATION_A,
      displayName: "Research",
    });
    await manager.renameDepartment({
      organizationId: ORGANIZATION_A,
      departmentId: DEPARTMENT_A,
      displayName: "Research Lab",
      expectedRevision: 1,
    });
    await manager.archiveDepartment({
      organizationId: ORGANIZATION_A,
      departmentId: DEPARTMENT_A,
      expectedRevision: 2,
    });
    await manager.restoreDepartment({
      organizationId: ORGANIZATION_A,
      departmentId: DEPARTMENT_A,
      expectedRevision: 2,
    });
    const createdInvitation = await manager.createInvitation({
      organizationId: ORGANIZATION_A,
    });
    expect(createdInvitation.token).toBe(RAW_TOKEN);
    await manager.revokeInvitation({
      organizationId: ORGANIZATION_A,
      invitationId: INVITATION_A,
    });

    await expect(
      manager.publishPolicy({
        organizationId: ORGANIZATION_A,
        document: policyDocument(),
        expectedOrganizationRevision: 3,
        expectedPolicyVersion: 2,
      }),
    ).resolves.toMatchObject({ id: SNAPSHOT_B, policyVersion: 2 });
    expect(
      database.readCurrentPolicy(ACCOUNT_A, ORGANIZATION_A).policy?.snapshot.id,
    ).toBe(SNAPSHOT_B);
    expect(
      database.readInvitations(ACCOUNT_A, ORGANIZATION_A).invitations,
    ).toEqual([]);
    expect(
      database.readDepartments(ACCOUNT_A, ORGANIZATION_A).departments,
    ).toEqual([department({ revision: 3 })]);
    expect(database.readMembers(ACCOUNT_A, ORGANIZATION_A).members).toEqual([
      member(MEMBER_A),
    ]);
    expect(client.archiveOrganization).toHaveBeenCalledTimes(1);
    expect(client.restoreOrganization).toHaveBeenCalledTimes(1);
    expect(client.transferOwner).toHaveBeenCalledTimes(1);
    expect(client.publishPolicy).toHaveBeenCalledTimes(1);

    await manager.leave({ organizationId: ORGANIZATION_A });
    expect(database.readOrganizations(ACCOUNT_A).organizations).toEqual([]);
  });

  it("accepts an invitation without persisting its raw token", async () => {
    const database = databaseFor();
    const client = cloudClient();
    const manager = managerFor({
      database,
      client,
      getAuthState: () => authState(),
    });

    await expect(
      manager.acceptInvitation({ token: RAW_TOKEN }),
    ).resolves.toEqual({
      organization: organization(ORGANIZATION_B, { role: "member" }),
      member: member(ACCOUNT_A),
    });
    expect(client.acceptInvitation).toHaveBeenCalledWith(
      RAW_TOKEN,
      IDEMPOTENCY_A,
    );
    expect(readFileSync(database.databasePath, "utf8")).not.toContain(
      RAW_TOKEN,
    );
    expect(database.readOrganizations(ACCOUNT_A).organizations).toEqual([
      organization(ORGANIZATION_B, { role: "member" }),
    ]);
  });

  it("does not import or invoke Hermes runtime and private-learning domains", () => {
    const source = readFileSync(
      new URL("./manager.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /agentera-agent-control|agentera-workspace|profile_path|runtime_profile|RuntimeBinding|HERMES_HOME|Memory|Curator|legacy-sync|Gateway/i,
    );
  });
});
