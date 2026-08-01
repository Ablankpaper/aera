import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "playwright/test";

import type { AgenteraAuthPublicState } from "../../src/shared/agentera-auth";
import type {
  OrganizationPolicyDocument,
  OrganizationRole,
} from "../../src/shared/agentera-organization";
import {
  AgenteraOrganizationClient,
  type AgenteraOrganizationClientError,
} from "../../src/main/agentera-organization/client";
import {
  openAgenteraOrganizationDatabase,
  type AgenteraOrganizationSqliteDatabase,
} from "../../src/main/agentera-organization/db";
import { parseOrganizationInvitationDeepLink } from "../../src/main/agentera-organization/deep-link";
import { AgenteraOrganizationManager } from "../../src/main/agentera-organization/manager";
import {
  AgenteraOrganizationPolicyVerifier,
  canonicalizeOrganizationPolicyDocument,
} from "../../src/main/agentera-organization/policy-verifier";
import { WorkspaceInvitationInbox } from "../../src/main/agentera-workspace/deep-link";

const ORIGIN = "https://organization.fixture.invalid";
const ACCOUNT_A = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "10000000-0000-4000-8000-000000000002";
const ACCOUNT_C = "10000000-0000-4000-8000-000000000003";
const PERSONAL_A = "11000000-0000-4000-8000-000000000001";
const PERSONAL_B = "11000000-0000-4000-8000-000000000002";
const PERSONAL_C = "11000000-0000-4000-8000-000000000003";
const DEVICE_ID = "12000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const DEPARTMENT_ID = "30000000-0000-4000-8000-000000000001";
const INVITATION_B_ID = "40000000-0000-4000-8000-000000000001";
const INVITATION_C_ID = "40000000-0000-4000-8000-000000000002";
const POLICY_V1_ID = "50000000-0000-4000-8000-000000000001";
const POLICY_V2_ID = "50000000-0000-4000-8000-000000000002";
const RUNTIME_BINDING_ID = "60000000-0000-4000-8000-000000000001";
const RUNTIME_PROFILE_ID = "60000000-0000-4000-8000-000000000002";
const ACCESS_A = "fixture-access-account-a";
const ACCESS_B = "fixture-access-account-b";
const ACCESS_C = "fixture-access-account-c";
const TOKEN_B = "A".repeat(43);
const TOKEN_C = "Q".repeat(43);
const LINK_B = `aera://organization-invitation#${TOKEN_B}`;
const LINK_C = `aera://organization-invitation#${TOKEN_C}`;
const CREATED_AT = "2026-07-21T08:00:00Z";
const OFFLINE_EXPIRES_AT = "2026-07-28T08:00:00Z";

type Account = "A" | "B" | "C";
type OrganizationStatus = "active" | "archived" | "dissolved";
type DepartmentStatus = "active" | "archived";

interface MutableSession {
  auth: AgenteraAuthPublicState;
  accessToken: string | null;
}

interface FixtureMember {
  nickname: string;
  role: OrganizationRole;
  departmentId: string | null;
  revision: number;
  joinedAt: string;
  updatedAt: string;
}

interface FixtureDepartment {
  id: string;
  displayName: string;
  status: DepartmentStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface FixtureInvitation {
  id: string;
  tokenDigest: string;
  status: "pending" | "accepted" | "revoked";
  createdByUserId: string;
  acceptedByUserId: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

interface FixturePolicy {
  id: string;
  version: number;
  document: OrganizationPolicyDocument;
  digest: string;
  signature: string;
  createdAt: string;
}

interface FixtureAudit {
  id: string;
  eventType: string;
  objectType: string;
  objectId: string;
  actorId: string;
  subjectId: string | null;
  createdAt: string;
}

interface FixtureOrganization {
  id: string;
  displayName: string;
  ownerId: string;
  status: OrganizationStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  members: Map<string, FixtureMember>;
  departments: Map<string, FixtureDepartment>;
  invitations: Map<string, FixtureInvitation>;
  policies: FixturePolicy[];
  audits: FixtureAudit[];
}

interface TokenAppearance {
  channel: string;
  allowed: boolean;
}

interface ReplayRecord {
  requestDigest: string;
  status: number;
  body: unknown;
  replayStatus: number;
  replayBody: unknown;
}

function onlineState(account: Account): AgenteraAuthPublicState {
  const identity = {
    A: { userId: ACCOUNT_A, personalSpaceId: PERSONAL_A },
    B: { userId: ACCOUNT_B, personalSpaceId: PERSONAL_B },
    C: { userId: ACCOUNT_C, personalSpaceId: PERSONAL_C },
  }[account];
  return {
    status: "authenticated",
    ...identity,
    deviceId: DEVICE_ID,
    offlineExpiresAt: OFFLINE_EXPIRES_AT,
    cloudAvailable: true,
  };
}

function accessToken(account: Account): string {
  return { A: ACCESS_A, B: ACCESS_B, C: ACCESS_C }[account];
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} fields differ: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}.`,
    );
  }
  return record;
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

class OrganizationRouteFixture {
  readonly violations: string[] = [];
  readonly exchanges: string[] = [];
  readonly tokenAppearances: TokenAppearance[] = [];
  private organization: FixtureOrganization | null = null;
  private clock = Date.parse(CREATED_AT);
  private auditSequence = 0;
  private invitationSequence = 0;
  private readonly idempotency = new Map<string, ReplayRecord>();
  private readonly privateKey: KeyObject;
  private readonly publicKeyX: string;

  constructor() {
    const pair = generateKeyPairSync("ed25519");
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" });
    if (typeof jwk.x !== "string") throw new Error("Missing Ed25519 key.");
    this.publicKeyX = jwk.x;
  }

  readonly fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const bodyText =
      init?.body === undefined
        ? ""
        : typeof init.body === "string"
          ? init.body
          : this.fail("Organization fixture requires a JSON string body.");
    let body: unknown = undefined;
    if (bodyText !== "") {
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        return this.fail("Organization fixture received invalid JSON.");
      }
    }

    if (url.origin !== ORIGIN || init?.redirect !== "error") {
      return this.fail(
        `Unexpected Organization origin or redirect: ${url.href}.`,
      );
    }
    const publicRequest =
      url.pathname === "/.well-known/agentera-signing-keys.json";
    const actorId = publicRequest ? "public" : this.actorFor(headers);
    this.assertHeaders(headers, bodyText !== "", publicRequest);
    this.assertNoAuthorityOrPrivateFields(body);
    this.exchanges.push(`${actorId} ${method} ${url.pathname}${url.search}`);

    for (const token of [TOKEN_B, TOKEN_C]) {
      if (!bodyText.includes(token)) continue;
      const allowed =
        method === "POST" &&
        url.pathname === "/api/v1/organization-invitations/accept" &&
        exactObject(body, ["token"], "invitation acceptance").token === token;
      this.tokenAppearances.push({
        channel: allowed ? "accept_request" : "unexpected_request",
        allowed,
      });
    }

    try {
      return this.route(actorId, method, url, headers, body);
    } catch (error) {
      return this.fail(
        error instanceof Error ? error.message : "Organization route failed.",
      );
    }
  }) as typeof fetch;

  recordProtocolHandoff(raw: string): void {
    const allowed = raw === LINK_B || raw === LINK_C;
    this.tokenAppearances.push({
      channel: allowed ? "protocol_handoff" : "invalid_protocol_handoff",
      allowed,
    });
  }

  private route(
    actorId: string,
    method: string,
    url: URL,
    headers: Headers,
    body: unknown,
  ): Response {
    if (
      url.pathname === "/.well-known/agentera-signing-keys.json" &&
      url.search === "" &&
      method === "GET"
    ) {
      this.requireNoBody(body, "signing keys");
      return this.json(200, this.rawSigningKeys());
    }

    if (url.pathname === "/api/v1/organizations") {
      if (method === "GET") {
        this.requirePage(url);
        this.requireNoBody(body, "list organizations");
        return this.json(200, {
          items:
            this.organization?.members.has(actorId) === true
              ? [this.rawSummary(this.organization, actorId)]
              : [],
        });
      }
      if (method === "POST" && url.search === "") {
        const request = exactObject(
          body,
          ["display_name"],
          "create organization",
        );
        if (request.display_name !== "Aera Research") {
          return this.fail("Unexpected Organization display name.");
        }
        return this.idempotent(
          actorId,
          "organization.create",
          headers,
          request,
          () => {
            if (this.organization !== null) {
              return {
                status: 409,
                body: this.errorBody("organization_conflict"),
              };
            }
            const now = this.tick();
            const organization: FixtureOrganization = {
              id: ORGANIZATION_ID,
              displayName: String(request.display_name),
              ownerId: actorId,
              status: "active",
              revision: 1,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              members: new Map([
                [
                  actorId,
                  {
                    nickname: "Owner A",
                    role: "owner",
                    departmentId: null,
                    revision: 1,
                    joinedAt: now,
                    updatedAt: now,
                  },
                ],
              ]),
              departments: new Map(),
              invitations: new Map(),
              policies: [],
              audits: [],
            };
            organization.policies.push(
              this.makePolicy(
                organization,
                POLICY_V1_ID,
                1,
                {
                  schemaVersion: 1,
                  models: { allowlist: null },
                  tools: { allowlist: null },
                  experienceCandidates: { mode: "disabled" },
                  officialAgents: { installation: "blocked" },
                },
                now,
              ),
            );
            this.organization = organization;
            this.audit(
              organization,
              actorId,
              "organization.created",
              organization.id,
            );
            return {
              status: 201,
              body: this.rawSummary(organization, actorId),
              replayStatus: 200,
            };
          },
        );
      }
    }

    if (
      url.pathname === "/api/v1/organization-invitations/accept" &&
      url.search === "" &&
      method === "POST"
    ) {
      const request = exactObject(body, ["token"], "accept invitation");
      return this.idempotent(
        actorId,
        "organization.invitation.accept",
        headers,
        request,
        () => {
          const organization = this.requireOrganization();
          const digest = tokenDigest(String(request.token));
          const invitation = [...organization.invitations.values()].find(
            (candidate) => candidate.tokenDigest === digest,
          );
          if (!invitation || invitation.status !== "pending") {
            return {
              status: 409,
              body: this.errorBody("invitation_unavailable"),
            };
          }
          if (organization.status !== "active") {
            return {
              status: 409,
              body: this.errorBody("organization_archived"),
            };
          }
          const now = this.tick();
          invitation.status = "accepted";
          invitation.acceptedByUserId = actorId;
          invitation.acceptedAt = now;
          organization.members.set(actorId, {
            nickname: actorId === ACCOUNT_B ? "Member B" : "Member C",
            role: "member",
            departmentId: null,
            revision: 1,
            joinedAt: now,
            updatedAt: now,
          });
          this.audit(
            organization,
            actorId,
            "organization.invitation.accepted",
            invitation.id,
          );
          return {
            status: 200,
            body: {
              organization: this.rawSummary(organization, actorId),
              member: this.rawMember(
                actorId,
                this.requireMember(organization, actorId),
              ),
            },
          };
        },
      );
    }

    const lifecycle = url.pathname.match(
      /^\/api\/v1\/organizations\/([0-9a-f-]+)\/(archive|restore)$/,
    );
    if (lifecycle && url.search === "" && method === "POST") {
      const organization = this.requireOrganization(lifecycle[1]);
      const request = exactObject(body, ["expected_revision"], lifecycle[2]);
      return this.idempotent(
        actorId,
        `organization.${lifecycle[2]}`,
        headers,
        request,
        () => {
          if (actorId !== organization.ownerId) {
            return {
              status: 403,
              body: this.errorBody("organization_forbidden"),
            };
          }
          if (request.expected_revision !== organization.revision) {
            return {
              status: 409,
              body: this.errorBody("organization_conflict"),
            };
          }
          if (
            (lifecycle[2] === "archive" && organization.status !== "active") ||
            (lifecycle[2] === "restore" && organization.status !== "archived")
          ) {
            return {
              status: 409,
              body: this.errorBody("organization_conflict"),
            };
          }
          const now = this.tick();
          organization.status =
            lifecycle[2] === "archive" ? "archived" : "active";
          organization.archivedAt = lifecycle[2] === "archive" ? now : null;
          organization.revision += 1;
          organization.updatedAt = now;
          this.audit(
            organization,
            actorId,
            `organization.${lifecycle[2]}d`,
            organization.id,
          );
          return { status: 200, body: this.rawSummary(organization, actorId) };
        },
      );
    }

    const ownerTransfer = url.pathname.match(
      /^\/api\/v1\/organizations\/([0-9a-f-]+)\/owner-transfer$/,
    );
    if (ownerTransfer && url.search === "" && method === "POST") {
      const organization = this.requireOrganization(ownerTransfer[1]);
      const request = exactObject(
        body,
        [
          "target_user_id",
          "expected_organization_revision",
          "expected_owner_revision",
          "expected_target_revision",
          "confirmation",
        ],
        "owner transfer",
      );
      return this.idempotent(
        actorId,
        "organization.owner.transfer",
        headers,
        request,
        () => {
          const owner = this.requireMember(organization, actorId);
          const targetId = String(request.target_user_id);
          const target = this.requireMember(organization, targetId);
          if (
            actorId !== organization.ownerId ||
            owner.role !== "owner" ||
            target.role !== "admin"
          ) {
            return {
              status: 403,
              body: this.errorBody("organization_forbidden"),
            };
          }
          if (
            request.confirmation !== "transfer-organization-owner" ||
            request.expected_organization_revision !== organization.revision ||
            request.expected_owner_revision !== owner.revision ||
            request.expected_target_revision !== target.revision
          ) {
            return {
              status: 409,
              body: this.errorBody("organization_conflict"),
            };
          }
          const now = this.tick();
          owner.role = "admin";
          owner.revision += 1;
          owner.updatedAt = now;
          target.role = "owner";
          target.revision += 1;
          target.updatedAt = now;
          organization.ownerId = targetId;
          organization.revision += 1;
          organization.updatedAt = now;
          this.audit(
            organization,
            actorId,
            "organization.owner.transferred",
            targetId,
          );
          return { status: 200, body: this.rawSummary(organization, actorId) };
        },
      );
    }

    const dissolve = url.pathname.match(
      /^\/api\/v1\/organizations\/([0-9a-f-]+)\/dissolve$/,
    );
    if (dissolve && url.search === "" && method === "POST") {
      const organization = this.requireOrganization(dissolve[1]);
      const request = exactObject(
        body,
        ["display_name", "expected_revision", "confirmation"],
        "dissolve organization",
      );
      return this.idempotent(
        actorId,
        "organization.dissolve",
        headers,
        request,
        () => {
          const pending = [...organization.invitations.values()].some(
            ({ status }) => status === "pending",
          );
          const departmentsReady = [...organization.departments.values()].every(
            (department) =>
              department.status === "archived" &&
              this.departmentMemberCount(organization, department.id) === 0,
          );
          if (
            actorId !== organization.ownerId ||
            organization.status !== "archived" ||
            organization.members.size !== 1 ||
            pending ||
            !departmentsReady
          ) {
            return { status: 409, body: this.errorBody("dissolution_blocked") };
          }
          if (
            request.display_name !== organization.displayName ||
            request.expected_revision !== organization.revision ||
            request.confirmation !== "dissolve-organization"
          ) {
            return {
              status: 409,
              body: this.errorBody("organization_conflict"),
            };
          }
          const now = this.tick();
          organization.status = "dissolved";
          organization.revision += 1;
          organization.updatedAt = now;
          const response = this.rawSummary(organization, actorId, {
            member_count: 0,
            department_count: 0,
          });
          organization.members.clear();
          organization.departments.clear();
          return { status: 200, body: response };
        },
      );
    }

    const members = url.pathname.match(
      /^\/api\/v1\/organizations\/([0-9a-f-]+)\/members$/,
    );
    if (members && method === "GET") {
      this.requirePage(url);
      this.requireNoBody(body, "list members");
      const organization = this.requireOrganization(members[1]);
      this.requireMember(organization, actorId);
      return this.json(200, {
        items: [...organization.members.entries()].map(([userId, member]) =>
          this.rawMember(userId, member),
        ),
      });
    }

    const memberMutation = url.pathname.match(
      /^\/api\/v1\/organizations\/([0-9a-f-]+)\/members\/([0-9a-f-]+)$/,
    );
    if (memberMutation) {
      const organization = this.requireOrganization(memberMutation[1]);
      const actor = this.requireMember(organization, actorId);
      const targetId = memberMutation[2];
      const target = this.requireMember(organization, targetId);
      if (method === "PATCH" && url.search === "") {
        const request = body as Record<string, unknown>;
        if (
          request === null ||
          typeof request !== "object" ||
          Array.isArray(request) ||
          !Object.hasOwn(request, "expected_revision") ||
          (!Object.hasOwn(request, "role") &&
            !Object.hasOwn(request, "department_id")) ||
          Object.keys(request).some(
            (key) =>
              !["role", "department_id", "expected_revision"].includes(key),
          )
        ) {
          return this.fail("Invalid Organization member patch shape.");
        }
        const ownerCanPatch = actor.role === "owner" && target.role !== "owner";
        const adminCanPatch =
          actor.role === "admin" &&
          (target.role === "member" || target.role === "auditor") &&
          request.role !== "admin";
        if (!ownerCanPatch && !adminCanPatch) {
          return this.error(403, "organization_forbidden");
        }
        if (request.expected_revision !== target.revision) {
          return this.error(409, "membership_conflict");
        }
        if (Object.hasOwn(request, "department_id")) {
          const departmentId = request.department_id;
          if (
            departmentId !== null &&
            !organization.departments.has(String(departmentId))
          ) {
            return this.error(409, "membership_conflict");
          }
          target.departmentId =
            departmentId === null ? null : String(departmentId);
        }
        if (Object.hasOwn(request, "role")) {
          if (
            request.role !== "admin" &&
            request.role !== "auditor" &&
            request.role !== "member"
          ) {
            return this.fail("Invalid assignable Organization role.");
          }
          target.role = request.role;
        }
        target.revision += 1;
        target.updatedAt = this.tick();
        this.audit(
          organization,
          actorId,
          "organization.member.updated",
          targetId,
        );
        return this.json(200, this.rawMember(targetId, target));
      }
      if (method === "DELETE") {
        this.requireNoBody(body, "remove member");
        const expectedRevision = this.exactRevisionQuery(url);
        if (
          target.role === "owner" ||
          (actor.role !== "owner" &&
            !(
              actor.role === "admin" &&
              (target.role === "member" || target.role === "auditor")
            ))
        ) {
          return this.error(403, "organization_forbidden");
        }
        if (expectedRevision !== target.revision) {
          return this.error(409, "membership_conflict");
        }
        organization.members.delete(targetId);
        this.audit(
          organization,
          actorId,
          "organization.member.removed",
          targetId,
        );
        return new Response(null, { status: 204 });
      }
    }

    const leave = url.pathname.match(
      /^\/api\/v1\/organizations\/([0-9a-f-]+)\/leave$/,
    );
    if (leave && url.search === "" && method === "POST") {
      exactObject(body, [], "leave organization");
      const organization = this.requireOrganization(leave[1]);
      const actor = this.requireMember(organization, actorId);
      if (actor.role === "owner")
        return this.error(403, "organization_forbidden");
      organization.members.delete(actorId);
      this.audit(organization, actorId, "organization.member.left", actorId);
      return new Response(null, { status: 204 });
    }

    const departments = url.pathname.match(
      /^\/api\/v1\/organizations\/([0-9a-f-]+)\/departments$/,
    );
    if (departments) {
      const organization = this.requireOrganization(departments[1]);
      const actor = this.requireMember(organization, actorId);
      if (method === "GET") {
        this.requirePage(url);
        this.requireNoBody(body, "list departments");
        return this.json(200, {
          items: [...organization.departments.values()].map((department) =>
            this.rawDepartment(organization, department),
          ),
        });
      }
      if (method === "POST" && url.search === "") {
        const request = exactObject(
          body,
          ["display_name"],
          "create department",
        );
        if (actor.role !== "owner" && actor.role !== "admin") {
          return this.error(403, "organization_forbidden");
        }
        if (organization.status !== "active") {
          return this.error(409, "organization_archived");
        }
        const now = this.tick();
        const department: FixtureDepartment = {
          id: DEPARTMENT_ID,
          displayName: String(request.display_name),
          status: "active",
          revision: 1,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        };
        organization.departments.set(department.id, department);
        this.audit(
          organization,
          actorId,
          "organization.department.created",
          department.id,
        );
        return this.json(201, this.rawDepartment(organization, department));
      }
    }

    const departmentArchive = url.pathname.match(
      /^\/api\/v1\/organizations\/([0-9a-f-]+)\/departments\/([0-9a-f-]+)\/archive$/,
    );
    if (departmentArchive && url.search === "" && method === "POST") {
      const organization = this.requireOrganization(departmentArchive[1]);
      const actor = this.requireMember(organization, actorId);
      const department = this.requireDepartment(
        organization,
        departmentArchive[2],
      );
      const request = exactObject(
        body,
        ["expected_revision"],
        "archive department",
      );
      if (actor.role !== "owner" && actor.role !== "admin") {
        return this.error(403, "organization_forbidden");
      }
      if (this.departmentMemberCount(organization, department.id) !== 0) {
        return this.error(409, "department_not_empty");
      }
      if (request.expected_revision !== department.revision) {
        return this.error(409, "organization_conflict");
      }
      department.status = "archived";
      department.revision += 1;
      department.updatedAt = this.tick();
      department.archivedAt = department.updatedAt;
      this.audit(
        organization,
        actorId,
        "organization.department.archived",
        department.id,
      );
      return this.json(200, this.rawDepartment(organization, department));
    }

    const invitations = url.pathname.match(
      /^\/api\/v1\/organizations\/([0-9a-f-]+)\/invitations$/,
    );
    if (invitations) {
      const organization = this.requireOrganization(invitations[1]);
      const actor = this.requireMember(organization, actorId);
      if (method === "GET") {
        this.requirePage(url);
        this.requireNoBody(body, "list invitations");
        if (actor.role !== "owner" && actor.role !== "admin") {
          return this.error(403, "organization_forbidden");
        }
        return this.json(200, {
          items: [...organization.invitations.values()].map((invitation) =>
            this.rawInvitation(invitation),
          ),
        });
      }
      if (method === "POST" && url.search === "") {
        exactObject(body, [], "create invitation");
        if (actor.role !== "owner" && actor.role !== "admin") {
          return this.error(403, "organization_forbidden");
        }
        if (organization.status !== "active") {
          return this.error(409, "organization_archived");
        }
        return this.idempotent(
          actorId,
          "organization.invitation.create",
          headers,
          body,
          () => {
            const index = this.invitationSequence++;
            if (index > 1) {
              return {
                status: 409,
                body: this.errorBody("invitation_limit_reached"),
              };
            }
            const token = index === 0 ? TOKEN_B : TOKEN_C;
            const now = this.tick();
            const invitation: FixtureInvitation = {
              id: index === 0 ? INVITATION_B_ID : INVITATION_C_ID,
              tokenDigest: tokenDigest(token),
              status: "pending",
              createdByUserId: actorId,
              acceptedByUserId: null,
              createdAt: now,
              expiresAt: new Date(
                Date.parse(now) + 7 * 86_400_000,
              ).toISOString(),
              acceptedAt: null,
              revokedAt: null,
            };
            organization.invitations.set(invitation.id, invitation);
            this.audit(
              organization,
              actorId,
              "organization.invitation.created",
              invitation.id,
            );
            const rawInvitation = this.rawInvitation(invitation);
            return {
              status: 201,
              body: {
                invitation: rawInvitation,
                token,
                invite_url: `agentera://organization-invitation#${token}`,
                secret_replayable: false,
              },
              replayStatus: 200,
              replayBody: {
                invitation: rawInvitation,
                secret_replayable: false,
              },
              tokenChannel: "creation_response",
            };
          },
        );
      }
    }

    const currentPolicy = url.pathname.match(
      /^\/api\/v1\/organizations\/([0-9a-f-]+)\/policy$/,
    );
    if (currentPolicy && url.search === "" && method === "GET") {
      this.requireNoBody(body, "current policy");
      const organization = this.requireOrganization(currentPolicy[1]);
      const actor = this.requireMember(organization, actorId);
      const policy = organization.policies.at(-1)!;
      return this.json(
        200,
        actor.role === "member"
          ? this.rawPolicySummary(policy)
          : this.rawPolicySnapshot(policy),
      );
    }

    const policySnapshots = url.pathname.match(
      /^\/api\/v1\/organizations\/([0-9a-f-]+)\/policy-snapshots$/,
    );
    if (policySnapshots) {
      const organization = this.requireOrganization(policySnapshots[1]);
      const actor = this.requireMember(organization, actorId);
      if (method === "GET") {
        this.requirePage(url);
        this.requireNoBody(body, "policy history");
        if (!["owner", "admin", "auditor"].includes(actor.role)) {
          return this.error(403, "organization_forbidden");
        }
        return this.json(200, {
          items: organization.policies.map((policy) =>
            this.rawPolicySummary(policy),
          ),
        });
      }
      if (method === "POST" && url.search === "") {
        const request = exactObject(
          body,
          [
            "policy_document",
            "expected_organization_revision",
            "expected_policy_version",
          ],
          "publish policy",
        );
        return this.idempotent(
          actorId,
          "organization.policy.publish",
          headers,
          request,
          () => {
            if (actor.role !== "owner" && actor.role !== "admin") {
              return {
                status: 403,
                body: this.errorBody("organization_forbidden"),
              };
            }
            const nextVersion = organization.policies.at(-1)!.version + 1;
            if (
              request.expected_organization_revision !==
                organization.revision ||
              request.expected_policy_version !== nextVersion
            ) {
              return {
                status: 409,
                body: this.errorBody("policy_version_conflict"),
              };
            }
            const document = this.policyDocumentFromRaw(
              request.policy_document,
            );
            const now = this.tick();
            const policy = this.makePolicy(
              organization,
              POLICY_V2_ID,
              nextVersion,
              document,
              now,
            );
            organization.policies.push(policy);
            organization.revision += 1;
            organization.updatedAt = now;
            this.audit(
              organization,
              actorId,
              "organization.policy.published",
              policy.id,
            );
            return { status: 201, body: this.rawPolicySnapshot(policy) };
          },
        );
      }
    }

    const auditEvents = url.pathname.match(
      /^\/api\/v1\/organizations\/([0-9a-f-]+)\/audit-events$/,
    );
    if (auditEvents && url.search === "" && method === "GET") {
      this.requireNoBody(body, "audit events");
      const organization = this.requireOrganization(auditEvents[1]);
      const actor = this.requireMember(organization, actorId);
      if (!["owner", "admin", "auditor"].includes(actor.role)) {
        return this.error(403, "organization_forbidden");
      }
      return this.json(200, {
        items: organization.audits.map((audit) => ({
          id: audit.id,
          event_type: audit.eventType,
          object_type: audit.objectType,
          object_id: audit.objectId,
          outcome: "succeeded",
          reason_code: "authorized",
          request_id: `fixture-request-${audit.id.slice(-4)}`,
          actor_display: this.displayName(audit.actorId),
          ...(audit.subjectId === null
            ? {}
            : { subject_display: this.displayName(audit.subjectId) }),
          created_at: audit.createdAt,
        })),
      });
    }

    return this.fail(
      `Unexpected Organization route: ${actorId} ${method} ${url.pathname}${url.search}.`,
    );
  }

  private actorFor(headers: Headers): string {
    const authorization = headers.get("authorization");
    if (authorization === `Bearer ${ACCESS_A}`) return ACCOUNT_A;
    if (authorization === `Bearer ${ACCESS_B}`) return ACCOUNT_B;
    if (authorization === `Bearer ${ACCESS_C}`) return ACCOUNT_C;
    return this.fail("Organization fixture received an unknown access token.");
  }

  private assertHeaders(
    headers: Headers,
    hasBody: boolean,
    publicRequest: boolean,
  ): void {
    const allowed = new Set([
      "accept",
      ...(publicRequest ? [] : ["authorization"]),
      ...(hasBody ? ["content-type"] : []),
      ...(headers.has("idempotency-key") ? ["idempotency-key"] : []),
    ]);
    const actual = [...headers.keys()].sort();
    if (actual.some((name) => !allowed.has(name))) {
      this.fail(
        `Unexpected Organization request headers: ${actual.join(",")}.`,
      );
    }
    if (headers.get("accept") !== "application/json") {
      this.fail("Organization request is missing its strict Accept header.");
    }
    if (publicRequest && headers.has("authorization")) {
      this.fail("Public signing keys request carried authorization.");
    }
    if (hasBody && headers.get("content-type") !== "application/json") {
      this.fail("Organization request is missing its JSON Content-Type.");
    }
  }

  private assertNoAuthorityOrPrivateFields(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry) => this.assertNoAuthorityOrPrivateFields(entry));
      return;
    }
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (
        [
          "actor",
          "actor_id",
          "authenticated_user_id",
          "owner_id",
          "tenant_id",
        ].includes(key)
      ) {
        this.fail(`Client supplied forbidden authority field: ${key}.`);
      }
      if (
        /profile|runtime_binding|memory|conversation|session|learned_skill|curator|credential|api_key/i.test(
          key,
        )
      ) {
        this.fail(`Client supplied forbidden private field: ${key}.`);
      }
      this.assertNoAuthorityOrPrivateFields(entry);
    }
  }

  private idempotent(
    actorId: string,
    operation: string,
    headers: Headers,
    request: unknown,
    effect: () => {
      status: number;
      body: unknown;
      replayStatus?: number;
      replayBody?: unknown;
      tokenChannel?: string;
    },
  ): Response {
    const key = headers.get("idempotency-key");
    if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
      return this.fail(`${operation} omitted a valid idempotency-key.`);
    }
    const identity = `${actorId}\0${key}`;
    const requestDigest = createHash("sha256")
      .update(`${operation}\0${JSON.stringify(request)}`, "utf8")
      .digest("hex");
    const existing = this.idempotency.get(identity);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        return this.error(409, "idempotency_conflict");
      }
      return this.json(existing.replayStatus, existing.replayBody);
    }
    const result = effect();
    this.idempotency.set(identity, {
      requestDigest,
      status: result.status,
      body: result.body,
      replayStatus: result.replayStatus ?? result.status,
      replayBody: result.replayBody ?? result.body,
    });
    return this.json(
      result.status,
      result.body,
      result.tokenChannel ?? "ordinary_response",
      result.tokenChannel !== undefined,
    );
  }

  private makePolicy(
    organization: FixtureOrganization,
    id: string,
    version: number,
    document: OrganizationPolicyDocument,
    createdAt: string,
  ): FixturePolicy {
    const canonical = canonicalizeOrganizationPolicyDocument(document, {
      requireCanonical: true,
    });
    const payload = Buffer.from(
      `agentera-organization-policy-v1\0${organization.id}\0${id}\0${version}\0${canonical.contentDigest}`,
      "utf8",
    );
    return {
      id,
      version,
      document: canonical.document,
      digest: canonical.contentDigest,
      signature: sign(null, payload, this.privateKey).toString("base64url"),
      createdAt,
    };
  }

  private policyDocumentFromRaw(value: unknown): OrganizationPolicyDocument {
    const raw = exactObject(
      value,
      [
        "schema_version",
        "models",
        "tools",
        "experience_candidates",
        "official_agents",
      ],
      "policy document",
    );
    const models = exactObject(raw.models, ["allowlist"], "model policy");
    const tools = exactObject(raw.tools, ["allowlist"], "tool policy");
    const experience = exactObject(
      raw.experience_candidates,
      ["mode"],
      "experience policy",
    );
    const official = exactObject(
      raw.official_agents,
      ["installation"],
      "official Agent policy",
    );
    return canonicalizeOrganizationPolicyDocument(
      {
        schemaVersion: raw.schema_version,
        models: { allowlist: models.allowlist },
        tools: { allowlist: tools.allowlist },
        experienceCandidates: { mode: experience.mode },
        officialAgents: { installation: official.installation },
      },
      { requireCanonical: true },
    ).document;
  }

  private rawSummary(
    organization: FixtureOrganization,
    actorId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const policy = organization.policies.at(-1)!;
    const member = organization.members.get(actorId);
    return {
      id: organization.id,
      display_name: organization.displayName,
      status: organization.status,
      revision: organization.revision,
      role: member?.role ?? "owner",
      member_count: organization.members.size,
      department_count: organization.departments.size,
      current_policy_version: policy.version,
      current_policy_digest: policy.digest,
      mutation_state:
        organization.status === "active" ? "writable" : organization.status,
      created_at: organization.createdAt,
      updated_at: organization.updatedAt,
      ...(organization.archivedAt === null
        ? {}
        : { archived_at: organization.archivedAt }),
      ...overrides,
    };
  }

  private rawMember(
    userId: string,
    member: FixtureMember,
  ): Record<string, unknown> {
    return {
      user_id: userId,
      nickname: member.nickname,
      role: member.role,
      ...(member.departmentId === null
        ? {}
        : { department_id: member.departmentId }),
      revision: member.revision,
      joined_at: member.joinedAt,
      updated_at: member.updatedAt,
    };
  }

  private rawDepartment(
    organization: FixtureOrganization,
    department: FixtureDepartment,
  ): Record<string, unknown> {
    return {
      id: department.id,
      display_name: department.displayName,
      status: department.status,
      member_count: this.departmentMemberCount(organization, department.id),
      revision: department.revision,
      created_at: department.createdAt,
      updated_at: department.updatedAt,
      ...(department.archivedAt === null
        ? {}
        : { archived_at: department.archivedAt }),
    };
  }

  private rawInvitation(
    invitation: FixtureInvitation,
  ): Record<string, unknown> {
    return {
      id: invitation.id,
      status: invitation.status,
      created_by_user_id: invitation.createdByUserId,
      ...(invitation.acceptedByUserId === null
        ? {}
        : { accepted_by_user_id: invitation.acceptedByUserId }),
      created_at: invitation.createdAt,
      expires_at: invitation.expiresAt,
      ...(invitation.acceptedAt === null
        ? {}
        : { accepted_at: invitation.acceptedAt }),
      ...(invitation.revokedAt === null
        ? {}
        : { revoked_at: invitation.revokedAt }),
    };
  }

  private rawPolicyDocument(
    document: OrganizationPolicyDocument,
  ): Record<string, unknown> {
    return {
      schema_version: 1,
      models: { allowlist: document.models.allowlist },
      tools: { allowlist: document.tools.allowlist },
      experience_candidates: { mode: document.experienceCandidates.mode },
      official_agents: { installation: document.officialAgents.installation },
    };
  }

  private rawPolicySummary(policy: FixturePolicy): Record<string, unknown> {
    return {
      id: policy.id,
      policy_version: policy.version,
      schema_version: 1,
      content_digest: policy.digest,
      issuer: ORIGIN,
      signing_key_id: "organization-policy-key",
      created_at: policy.createdAt,
    };
  }

  private rawPolicySnapshot(policy: FixturePolicy): Record<string, unknown> {
    return {
      ...this.rawPolicySummary(policy),
      policy_document: this.rawPolicyDocument(policy.document),
      signature: policy.signature,
    };
  }

  private rawSigningKeys(): Record<string, unknown> {
    return {
      keys: [
        "access",
        "offline_entitlement",
        "agent_version",
        "agent_policy",
        "organization_policy",
      ].map((purpose) => ({
        kid:
          purpose === "organization_policy"
            ? "organization-policy-key"
            : `${purpose}-key`,
        kty: "OKP",
        crv: "Ed25519",
        alg: "EdDSA",
        use: "sig",
        purpose,
        x: this.publicKeyX,
      })),
    };
  }

  private audit(
    organization: FixtureOrganization,
    actorId: string,
    eventType: string,
    objectId: string,
  ): void {
    this.auditSequence += 1;
    organization.audits.push({
      id: `70000000-0000-4000-8000-${String(this.auditSequence).padStart(12, "0")}`,
      eventType,
      objectType: "organization_resource",
      objectId,
      actorId,
      subjectId: objectId === organization.id ? null : objectId,
      createdAt: this.tick(),
    });
  }

  private displayName(userOrResourceId: string): string {
    if (userOrResourceId === ACCOUNT_A) return "Account A";
    if (userOrResourceId === ACCOUNT_B) return "Account B";
    if (userOrResourceId === ACCOUNT_C) return "Account C";
    return "Organization resource";
  }

  private departmentMemberCount(
    organization: FixtureOrganization,
    departmentId: string,
  ): number {
    return [...organization.members.values()].filter(
      (member) => member.departmentId === departmentId,
    ).length;
  }

  private requireOrganization(id = ORGANIZATION_ID): FixtureOrganization {
    if (!this.organization || this.organization.id !== id) {
      return this.fail(`Unknown fixture Organization ${id}.`);
    }
    return this.organization;
  }

  private requireMember(
    organization: FixtureOrganization,
    userId: string,
  ): FixtureMember {
    const member = organization.members.get(userId);
    if (!member)
      return this.fail(`Actor ${userId} is not an Organization member.`);
    return member;
  }

  private requireDepartment(
    organization: FixtureOrganization,
    departmentId: string,
  ): FixtureDepartment {
    const department = organization.departments.get(departmentId);
    if (!department)
      return this.fail(`Unknown fixture Department ${departmentId}.`);
    return department;
  }

  private requirePage(url: URL): void {
    if (
      [...url.searchParams.keys()].join(",") !== "limit" ||
      url.searchParams.get("limit") !== "100"
    ) {
      this.fail(`Unexpected Organization page query: ${url.search}.`);
    }
  }

  private exactRevisionQuery(url: URL): number {
    if ([...url.searchParams.keys()].join(",") !== "expected_revision") {
      return this.fail(
        `Unexpected Organization revision query: ${url.search}.`,
      );
    }
    const raw = url.searchParams.get("expected_revision");
    if (!raw || !/^[1-9][0-9]*$/.test(raw)) {
      return this.fail("Invalid expected_revision query.");
    }
    return Number(raw);
  }

  private requireNoBody(body: unknown, label: string): void {
    if (body !== undefined) this.fail(`${label} unexpectedly supplied a body.`);
  }

  private tick(): string {
    this.clock += 1_000;
    return new Date(this.clock).toISOString();
  }

  private json(
    status: number,
    body: unknown,
    channel = "ordinary_response",
    allowToken = false,
  ): Response {
    const raw = JSON.stringify(body);
    if (raw.includes(TOKEN_B) || raw.includes(TOKEN_C)) {
      this.tokenAppearances.push({ channel, allowed: allowToken });
    }
    return new Response(raw, {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private errorBody(code: string): Record<string, unknown> {
    return { error: { code, request_id: "organization-fixture-request" } };
  }

  private error(status: number, code: string): Response {
    return this.json(status, this.errorBody(code));
  }

  private fail(message: string): never {
    this.violations.push(message);
    throw new Error(message);
  }
}

function openOrganizationManager(
  userDataPath: string,
  fixture: OrganizationRouteFixture,
  session: MutableSession,
): AgenteraOrganizationManager {
  const database = openAgenteraOrganizationDatabase(userDataPath, {
    databaseFactory: (path) =>
      new DatabaseSync(path) as unknown as AgenteraOrganizationSqliteDatabase,
  });
  const client = new AgenteraOrganizationClient({
    origin: ORIGIN,
    getAccessToken: () => session.accessToken,
    fetch: fixture.fetch,
  });
  return new AgenteraOrganizationManager({
    database,
    client,
    policyVerifier: new AgenteraOrganizationPolicyVerifier({ origin: ORIGIN }),
    getAuthState: () => session.auth,
    now: () => "2026-07-21T09:00:00Z",
  });
}

function filesBelow(rootPath: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) result.push(path);
    }
  };
  visit(rootPath);
  return result.sort();
}

function snapshotTree(rootPath: string): Record<string, string> {
  return Object.fromEntries(
    filesBelow(rootPath).map((path) => [
      relative(rootPath, path),
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
  );
}

interface HermesSentinels {
  hermesHome: string;
  activeProfilePath: string;
  conversationPath: string;
  sessionPath: string;
  bindingPath: string;
  memoryPath: string;
  userPath: string;
  skillPath: string;
  curatorPath: string;
  processIdentityPath: string;
}

interface HermesBoundarySnapshot {
  tree: Record<string, string>;
  selectedProfile: string;
  activeConversation: string;
  activeSession: string;
  runtimeBinding: string;
  memory: string;
  user: string;
  learnedSkill: string;
  curator: string;
  runtimeGatewayIdentity: string;
}

function writeHermesSentinels(rootPath: string): HermesSentinels {
  const hermesHome = join(rootPath, "hermes-home");
  const profilePath = join(hermesHome, "profiles", "research-agent");
  for (const directory of [
    join(profilePath, "sessions"),
    join(profilePath, "conversations"),
    join(profilePath, "files"),
    join(profilePath, "skills", "learned-local"),
    join(profilePath, "curator"),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  const activeProfilePath = join(hermesHome, "active_profile");
  const memoryPath = join(profilePath, "MEMORY.md");
  const userPath = join(profilePath, "USER.md");
  const sessionPath = join(profilePath, "sessions", "active.json");
  const conversationPath = join(profilePath, "conversations", "active.json");
  const skillPath = join(profilePath, "skills", "learned-local", "SKILL.md");
  const curatorPath = join(profilePath, "curator", "state.json");
  writeFileSync(activeProfilePath, "research-agent\n");
  writeFileSync(memoryPath, "private local memory\n");
  writeFileSync(userPath, "private local user\n");
  writeFileSync(sessionPath, '{"session":"unchanged-session"}\n');
  writeFileSync(
    conversationPath,
    '{"conversation":"unchanged-conversation"}\n',
  );
  writeFileSync(join(profilePath, "files", "private.txt"), "private file\n");
  writeFileSync(skillPath, "# local learned skill\n");
  writeFileSync(curatorPath, '{"revision":7,"queue":"local"}\n');

  const controlPath = join(rootPath, "agentera-control");
  mkdirSync(controlPath, { recursive: true });
  const bindingPath = join(controlPath, "active-binding.json");
  const processIdentityPath = join(controlPath, "runtime-gateway.json");
  writeFileSync(
    bindingPath,
    `${JSON.stringify({
      id: RUNTIME_BINDING_ID,
      ownerScope: "USER",
      runtimeProfileId: RUNTIME_PROFILE_ID,
      conversationKey: "unchanged-conversation",
      sessionId: "unchanged-session",
    })}\n`,
  );
  writeFileSync(
    processIdentityPath,
    '{"runtimePid":41001,"gatewayPid":41002,"instance":"unchanged"}\n',
  );
  return {
    hermesHome,
    activeProfilePath,
    conversationPath,
    sessionPath,
    bindingPath,
    memoryPath,
    userPath,
    skillPath,
    curatorPath,
    processIdentityPath,
  };
}

function captureHermesBoundary(
  sentinels: HermesSentinels,
): HermesBoundarySnapshot {
  return {
    tree: snapshotTree(sentinels.hermesHome),
    selectedProfile: readFileSync(sentinels.activeProfilePath, "utf8"),
    activeConversation: readFileSync(sentinels.conversationPath, "utf8"),
    activeSession: readFileSync(sentinels.sessionPath, "utf8"),
    runtimeBinding: readFileSync(sentinels.bindingPath, "utf8"),
    memory: readFileSync(sentinels.memoryPath, "utf8"),
    user: readFileSync(sentinels.userPath, "utf8"),
    learnedSkill: readFileSync(sentinels.skillPath, "utf8"),
    curator: readFileSync(sentinels.curatorPath, "utf8"),
    runtimeGatewayIdentity: readFileSync(sentinels.processIdentityPath, "utf8"),
  };
}

// @lat: [[agentera-organizations#Release gate#Deterministic multi-account flow]]
// @lat: [[agentera-organizations#Release gate#Hermes compatibility boundary]]
test("runs the three-account Organization lifecycle without changing Hermes state", async () => {
  const rootPath = mkdtempSync(join(tmpdir(), "agentera-organization-e2e-"));
  const userDataPath = join(rootPath, "user-data");
  const sentinels = writeHermesSentinels(rootPath);
  const immutableHermes = captureHermesBoundary(sentinels);
  const guardedActions: string[] = [];
  const previousHermesHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = sentinels.hermesHome;

  const fixture = new OrganizationRouteFixture();
  const inbox = new WorkspaceInvitationInbox();
  const session: MutableSession = {
    auth: onlineState("A"),
    accessToken: ACCESS_A,
  };
  let manager: AgenteraOrganizationManager | null = null;

  const guarded = async <T>(
    label: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    expect(captureHermesBoundary(sentinels), `${label}: before`).toEqual(
      immutableHermes,
    );
    try {
      return await operation();
    } finally {
      expect(captureHermesBoundary(sentinels), `${label}: after`).toEqual(
        immutableHermes,
      );
      guardedActions.push(label);
    }
  };

  const switchAccount = async (account: Account): Promise<void> => {
    session.auth = onlineState(account);
    session.accessToken = accessToken(account);
    await manager!.notifyAccessStateChanged();
  };

  try {
    manager = openOrganizationManager(userDataPath, fixture, session);
    expect(
      await guarded("A refreshes empty Organization state", () =>
        manager!.refresh(),
      ),
    ).toMatchObject({ stale: false, organizations: [] });

    const created = await guarded("A creates Organization", () =>
      manager!.create({ displayName: "Aera Research" }),
    );
    expect(created).toMatchObject({
      id: ORGANIZATION_ID,
      role: "owner",
      status: "active",
      currentPolicyVersion: 1,
    });

    const department = await guarded("A creates Department", () =>
      manager!.createDepartment({
        organizationId: ORGANIZATION_ID,
        displayName: "Research",
      }),
    );
    expect(department).toMatchObject({
      id: DEPARTMENT_ID,
      status: "active",
      memberCount: 0,
    });

    const inviteB = await guarded("A creates one-time invitation for B", () =>
      manager!.createInvitation({ organizationId: ORGANIZATION_ID }),
    );
    expect(inviteB).toMatchObject({
      invitation: { id: INVITATION_B_ID, status: "pending" },
      token: TOKEN_B,
      inviteUrl: LINK_B,
      secretReplayable: false,
    });
    const listedInvitations = await guarded(
      "A lists invitation metadata without secrets",
      () => manager!.listInvitations({ organizationId: ORGANIZATION_ID }),
    );
    expect(JSON.stringify(listedInvitations)).not.toContain(TOKEN_B);

    await guarded("protocol hands invitation B to volatile inbox", () => {
      fixture.recordProtocolHandoff(inviteB.inviteUrl!);
      expect(inbox.receiveDeepLink(inviteB.inviteUrl)).toBe(true);
      expect(inbox.peekOrganization()).toEqual({ token: TOKEN_B });
    });
    await guarded("switch to account B", () => switchAccount("B"));
    const acceptedB = await guarded("B accepts invitation", () =>
      manager!.acceptInvitation({ token: inbox.peekOrganization()!.token }),
    );
    expect(acceptedB).toMatchObject({
      organization: { id: ORGANIZATION_ID, role: "member" },
      member: { userId: ACCOUNT_B, role: "member" },
    });
    await guarded("volatile inbox clears accepted invitation B", () => {
      expect(inbox.clearAcceptedOrganization(TOKEN_B)).toBe(true);
    });

    await guarded("switch back to owner A", () => switchAccount("A"));
    let members = await guarded("A reads Organization members", () =>
      manager!.listMembers({ organizationId: ORGANIZATION_ID }),
    );
    let memberB = members.items.find(({ userId }) => userId === ACCOUNT_B)!;
    memberB = await guarded("A assigns B to Department", () =>
      manager!.patchMember({
        organizationId: ORGANIZATION_ID,
        userId: ACCOUNT_B,
        patch: {
          departmentId: DEPARTMENT_ID,
          expectedRevision: memberB.revision,
        },
      }),
    );
    expect(memberB).toMatchObject({ departmentId: DEPARTMENT_ID, revision: 2 });
    memberB = await guarded("A promotes B to Admin", () =>
      manager!.patchMember({
        organizationId: ORGANIZATION_ID,
        userId: ACCOUNT_B,
        patch: { role: "admin", expectedRevision: memberB.revision },
      }),
    );
    expect(memberB).toMatchObject({ role: "admin", revision: 3 });

    await guarded("switch to Admin B", () => switchAccount("B"));
    const inviteC = await guarded("Admin B creates invitation for C", () =>
      manager!.createInvitation({ organizationId: ORGANIZATION_ID }),
    );
    expect(inviteC).toMatchObject({
      invitation: { id: INVITATION_C_ID },
      token: TOKEN_C,
      inviteUrl: LINK_C,
    });
    await guarded("protocol hands invitation C to volatile inbox", () => {
      fixture.recordProtocolHandoff(inviteC.inviteUrl!);
      expect(parseOrganizationInvitationDeepLink(inviteC.inviteUrl)).toBe(
        TOKEN_C,
      );
      expect(inbox.receiveDeepLink(inviteC.inviteUrl)).toBe(true);
    });
    await guarded("switch to account C", () => switchAccount("C"));
    const acceptedC = await guarded("C accepts invitation", () =>
      manager!.acceptInvitation({ token: inbox.peekOrganization()!.token }),
    );
    expect(acceptedC.member).toMatchObject({
      userId: ACCOUNT_C,
      role: "member",
    });
    await guarded("volatile inbox clears accepted invitation C", () => {
      expect(inbox.clearAcceptedOrganization(TOKEN_C)).toBe(true);
    });

    await guarded("switch to Admin B for C management", () =>
      switchAccount("B"),
    );
    members = await guarded("B reads members", () =>
      manager!.listMembers({ organizationId: ORGANIZATION_ID }),
    );
    let memberC = members.items.find(({ userId }) => userId === ACCOUNT_C)!;
    memberC = await guarded("Admin B assigns C to Department", () =>
      manager!.patchMember({
        organizationId: ORGANIZATION_ID,
        userId: ACCOUNT_C,
        patch: {
          departmentId: DEPARTMENT_ID,
          expectedRevision: memberC.revision,
        },
      }),
    );
    memberC = await guarded("Admin B changes C to Auditor", () =>
      manager!.patchMember({
        organizationId: ORGANIZATION_ID,
        userId: ACCOUNT_C,
        patch: { role: "auditor", expectedRevision: memberC.revision },
      }),
    );
    expect(memberC).toMatchObject({
      role: "auditor",
      departmentId: DEPARTMENT_ID,
      revision: 3,
    });

    const stateBeforePolicy = await guarded(
      "B reads current Organization revision",
      () => manager!.getState(),
    );
    const policyV2 = await guarded("Admin B publishes signed policy V2", () =>
      manager!.publishPolicy({
        organizationId: ORGANIZATION_ID,
        document: {
          schemaVersion: 1,
          models: {
            allowlist: [{ provider: "openai", model: "gpt-5.2" }],
          },
          tools: { allowlist: ["browser.read", "files.read"] },
          experienceCandidates: { mode: "manual_review" },
          officialAgents: { installation: "allowed" },
        },
        expectedOrganizationRevision:
          stateBeforePolicy.organizations[0].revision,
        expectedPolicyVersion: 2,
      }),
    );
    expect(policyV2).toMatchObject({ id: POLICY_V2_ID, policyVersion: 2 });

    await guarded("switch to Auditor C", () => switchAccount("C"));
    await expect(
      guarded("Auditor C is denied invitation creation", () =>
        manager!.createInvitation({ organizationId: ORGANIZATION_ID }),
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "organization_forbidden",
    } satisfies Partial<AgenteraOrganizationClientError>);
    const policyHistory = await guarded("Auditor C reads policy history", () =>
      manager!.listPolicySnapshots({ organizationId: ORGANIZATION_ID }),
    );
    expect(policyHistory.map(({ policyVersion }) => policyVersion)).toEqual([
      1, 2,
    ]);
    const currentPolicy = await guarded(
      "Auditor C verifies current policy",
      () => manager!.getCurrentPolicy({ organizationId: ORGANIZATION_ID }),
    );
    expect(currentPolicy).toMatchObject({
      stale: false,
      errorCode: null,
      policy: { id: POLICY_V2_ID, policyVersion: 2 },
    });
    const audit = await guarded("Auditor C reads audit events", () =>
      manager!.listAuditEvents({ organizationId: ORGANIZATION_ID }),
    );
    expect(
      audit.items.some(
        ({ eventType }) => eventType === "organization.policy.published",
      ),
    ).toBe(true);

    await guarded("switch to original Owner A", () => switchAccount("A"));
    members = await guarded("A refreshes member revisions", () =>
      manager!.listMembers({ organizationId: ORGANIZATION_ID }),
    );
    memberB = members.items.find(({ userId }) => userId === ACCOUNT_B)!;
    memberB = await guarded("A clears B Department before owner transfer", () =>
      manager!.patchMember({
        organizationId: ORGANIZATION_ID,
        userId: ACCOUNT_B,
        patch: { departmentId: null, expectedRevision: memberB.revision },
      }),
    );
    const ownerA = members.items.find(({ userId }) => userId === ACCOUNT_A)!;
    const ownerState = await guarded("A reads transfer revision", () =>
      manager!.getState(),
    );
    const transferResult = await guarded(
      "A transfers ownership to Admin B",
      () =>
        manager!.transferOwner({
          organizationId: ORGANIZATION_ID,
          targetUserId: ACCOUNT_B,
          expectedOrganizationRevision: ownerState.organizations[0].revision,
          expectedOwnerRevision: ownerA.revision,
          expectedTargetRevision: memberB.revision,
          confirmation: "transfer-organization-owner",
        }),
    );
    expect(transferResult).toMatchObject({ role: "admin", revision: 3 });

    await guarded("switch to new Owner B", () => switchAccount("B"));
    let ownerBState = await guarded("B reads new owner state", () =>
      manager!.getState(),
    );
    expect(ownerBState.organizations[0].role).toBe("owner");
    const archived = await guarded("new Owner B archives Organization", () =>
      manager!.archive({
        organizationId: ORGANIZATION_ID,
        expectedRevision: ownerBState.organizations[0].revision,
      }),
    );
    expect(archived.status).toBe("archived");
    const restored = await guarded("new Owner B restores Organization", () =>
      manager!.restore({
        organizationId: ORGANIZATION_ID,
        expectedRevision: archived.revision,
      }),
    );
    expect(restored.status).toBe("active");

    await guarded("switch to Auditor C for voluntary leave", () =>
      switchAccount("C"),
    );
    await guarded("C leaves Organization", () =>
      manager!.leave({ organizationId: ORGANIZATION_ID }),
    );
    expect(
      (
        await guarded("C observes removed Organization state", () =>
          manager!.getState(),
        )
      ).organizations,
    ).toEqual([]);

    await guarded("switch to new Owner B for cleanup", () =>
      switchAccount("B"),
    );
    members = await guarded("B reads remaining members", () =>
      manager!.listMembers({ organizationId: ORGANIZATION_ID }),
    );
    const formerOwnerA = members.items.find(
      ({ userId }) => userId === ACCOUNT_A,
    )!;
    await guarded("B removes former Owner A", () =>
      manager!.removeMember({
        organizationId: ORGANIZATION_ID,
        userId: ACCOUNT_A,
        expectedRevision: formerOwnerA.revision,
      }),
    );
    const departments = await guarded("B verifies Department is empty", () =>
      manager!.listDepartments({ organizationId: ORGANIZATION_ID }),
    );
    expect(departments.items[0]).toMatchObject({
      id: DEPARTMENT_ID,
      memberCount: 0,
      status: "active",
    });
    const archivedDepartment = await guarded(
      "B archives empty Department",
      () =>
        manager!.archiveDepartment({
          organizationId: ORGANIZATION_ID,
          departmentId: DEPARTMENT_ID,
          expectedRevision: departments.items[0].revision,
        }),
    );
    expect(archivedDepartment.status).toBe("archived");

    ownerBState = await guarded("B reads final active revision", () =>
      manager!.getState(),
    );
    const finalArchive = await guarded(
      "B archives Organization for dissolution",
      () =>
        manager!.archive({
          organizationId: ORGANIZATION_ID,
          expectedRevision: ownerBState.organizations[0].revision,
        }),
    );
    const dissolved = await guarded("B safely dissolves Organization", () =>
      manager!.dissolve({
        organizationId: ORGANIZATION_ID,
        displayName: "Aera Research",
        expectedRevision: finalArchive.revision,
        confirmation: "dissolve-organization",
      }),
    );
    expect(dissolved).toMatchObject({
      status: "dissolved",
      mutationState: "dissolved",
      memberCount: 0,
      departmentCount: 0,
    });
    expect(
      (
        await guarded("B observes dissolved Organization removal", () =>
          manager!.getState(),
        )
      ).organizations,
    ).toEqual([]);

    expect(guardedActions.length).toBeGreaterThanOrEqual(35);
    expect(captureHermesBoundary(sentinels)).toEqual(immutableHermes);
    expect(immutableHermes.selectedProfile).toBe("research-agent\n");
    expect(immutableHermes.runtimeBinding).toContain(RUNTIME_BINDING_ID);
    expect(immutableHermes.runtimeBinding).toContain(RUNTIME_PROFILE_ID);
    expect(immutableHermes.activeConversation).toContain(
      "unchanged-conversation",
    );
    expect(immutableHermes.activeSession).toContain("unchanged-session");

    manager.close();
    manager = null;
    for (const path of filesBelow(userDataPath)) {
      const bytes = readFileSync(path);
      expect(bytes.includes(Buffer.from(TOKEN_B))).toBe(false);
      expect(bytes.includes(Buffer.from(TOKEN_C))).toBe(false);
    }
    expect(fixture.violations).toEqual([]);
    expect(fixture.tokenAppearances).toEqual([
      { channel: "creation_response", allowed: true },
      { channel: "protocol_handoff", allowed: true },
      { channel: "accept_request", allowed: true },
      { channel: "creation_response", allowed: true },
      { channel: "protocol_handoff", allowed: true },
      { channel: "accept_request", allowed: true },
    ]);
  } finally {
    manager?.close();
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
    rmSync(rootPath, { recursive: true, force: true });
  }
});
