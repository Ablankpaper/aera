import { createHash } from "node:crypto";
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
import type { ProductSpacePublicState } from "../../src/shared/agentera-product-space";
import {
  AgenteraWorkspaceClient,
  type AgenteraWorkspaceClientError,
} from "../../src/main/agentera-workspace/client";
import {
  openAgenteraWorkspaceDatabase,
  type AgenteraWorkspaceDatabase,
  type AgenteraWorkspaceSqliteDatabase,
} from "../../src/main/agentera-workspace/db";
import { WorkspaceInvitationInbox } from "../../src/main/agentera-workspace/deep-link";
import {
  AgenteraWorkspaceManager,
  type AgenteraWorkspaceManagerError,
  type AgenteraWorkspaceSelectionCoordinator,
} from "../../src/main/agentera-workspace/manager";

const ORIGIN = "https://workspace.fixture.invalid";
const ACCOUNT_A = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "10000000-0000-4000-8000-000000000002";
const ACCOUNT_C = "10000000-0000-4000-8000-000000000003";
const PERSONAL_A = "11000000-0000-4000-8000-000000000001";
const PERSONAL_B = "11000000-0000-4000-8000-000000000002";
const DEVICE_ID = "12000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const INVITATION_ID = "30000000-0000-4000-8000-000000000001";
const RUNTIME_BINDING_ID = "40000000-0000-4000-8000-000000000001";
const RUNTIME_PROFILE_ID = "50000000-0000-4000-8000-000000000001";
const ACCESS_A = "fixture-access-account-a";
const ACCESS_B = "fixture-access-account-b";
const RAW_INVITATION_TOKEN = "A".repeat(43);
const INVITATION_LINK = `agentera://workspace-invitation#${RAW_INVITATION_TOKEN}`;
const CREATED_AT = "2026-07-20T10:00:00Z";
const JOINED_AT = "2026-07-20T10:00:00Z";
const INVITATION_CREATED_AT = "2026-07-20T11:00:00Z";
const INVITATION_EXPIRES_AT = "2026-07-27T11:00:00Z";
const ACCEPTED_AT = "2026-07-20T12:00:00Z";
const OFFLINE_EXPIRES_AT = "2026-07-27T12:00:00Z";

type Role = "owner" | "admin" | "member";
type WorkspaceStatus = "active" | "archived";

interface FixtureMembership {
  nickname: string;
  role: Role;
  revision: number;
  joinedAt: string;
}

interface FixtureWorkspace {
  id: string;
  displayName: string;
  ownerId: string;
  status: WorkspaceStatus;
  revision: number;
  archivedAt: string | null;
  members: Map<string, FixtureMembership>;
}

interface FixtureInvitation {
  id: string;
  workspaceId: string;
  token: string;
  status: "pending" | "accepted" | "revoked";
  createdByUserId: string;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
}

interface MutableSession {
  auth: AgenteraAuthPublicState;
  accessToken: string | null;
}

interface TokenAppearance {
  channel: string;
  allowed: boolean;
}

function onlineState(account: "A" | "B"): AgenteraAuthPublicState {
  return {
    status: "authenticated",
    userId: account === "A" ? ACCOUNT_A : ACCOUNT_B,
    personalSpaceId: account === "A" ? PERSONAL_A : PERSONAL_B,
    deviceId: DEVICE_ID,
    offlineExpiresAt: OFFLINE_EXPIRES_AT,
    cloudAvailable: true,
  };
}

function offlineState(account: "A" | "B"): AgenteraAuthPublicState {
  const state = onlineState(account);
  if (state.status !== "authenticated") throw new Error("invalid fixture");
  return { ...state, status: "offline", cloudAvailable: false };
}

function timestampForRevision(revision: number): string {
  return new Date(Date.parse(CREATED_AT) + revision * 1_000).toISOString();
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

class WorkspaceRouteFixture {
  readonly violations: string[] = [];
  readonly exchanges: string[] = [];
  readonly tokenAppearances: TokenAppearance[] = [];
  private readonly workspaces = new Map<string, FixtureWorkspace>();
  private readonly invitations = new Map<string, FixtureInvitation>();
  private readonly workspaceIdempotency = new Map<string, string>();
  private readonly invitationIdempotency = new Map<string, string>();
  private readonly acceptanceIdempotency = new Map<string, string>();

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
          : this.fail("Workspace fixture requires a JSON string body.");
    let body: unknown = undefined;
    if (bodyText !== "") {
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        return this.fail("Workspace fixture received invalid JSON.");
      }
    }

    if (url.origin !== ORIGIN || init?.redirect !== "error") {
      return this.fail(`Unexpected Workspace origin or redirect: ${url.href}.`);
    }
    const actorId = this.actorFor(headers);
    this.assertHeaders(headers, bodyText !== "");
    this.assertNoActorFields(body);
    this.exchanges.push(`${actorId} ${method} ${url.pathname}${url.search}`);

    if (bodyText.includes(RAW_INVITATION_TOKEN)) {
      const allowed =
        method === "POST" &&
        url.pathname === "/api/v1/workspace-invitations/accept" &&
        exactObject(body, ["token"], "invitation acceptance").token ===
          RAW_INVITATION_TOKEN;
      this.tokenAppearances.push({
        channel: allowed ? "accept_request" : "unexpected_request",
        allowed,
      });
    }

    try {
      return this.route(actorId, method, url, headers, body);
    } catch (error) {
      return this.fail(
        error instanceof Error ? error.message : "Workspace route failed.",
      );
    }
  }) as typeof fetch;

  recordProtocolHandoff(raw: string): void {
    const containsToken = raw.includes(RAW_INVITATION_TOKEN);
    this.tokenAppearances.push({
      channel: containsToken ? "protocol_handoff" : "invalid_protocol_handoff",
      allowed: raw === INVITATION_LINK,
    });
  }

  private actorFor(headers: Headers): string {
    const authorization = headers.get("authorization");
    if (authorization === `Bearer ${ACCESS_A}`) return ACCOUNT_A;
    if (authorization === `Bearer ${ACCESS_B}`) return ACCOUNT_B;
    return this.fail("Workspace fixture received an unknown access token.");
  }

  private assertHeaders(headers: Headers, hasBody: boolean): void {
    const allowed = new Set([
      "accept",
      "authorization",
      ...(hasBody ? ["content-type"] : []),
      ...(headers.has("idempotency-key") ? ["idempotency-key"] : []),
    ]);
    const actual = [...headers.keys()].sort();
    if (actual.some((name) => !allowed.has(name))) {
      this.fail(`Unexpected Workspace request headers: ${actual.join(",")}.`);
    }
    if (headers.get("accept") !== "application/json") {
      this.fail("Workspace request is missing its strict Accept header.");
    }
    if (hasBody && headers.get("content-type") !== "application/json") {
      this.fail("Workspace request is missing its JSON Content-Type.");
    }
  }

  private assertNoActorFields(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry) => this.assertNoActorFields(entry));
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
          "user_id",
        ].includes(key)
      ) {
        this.fail(`Renderer supplied forbidden actor field: ${key}.`);
      }
      this.assertNoActorFields(entry);
    }
  }

  private route(
    actorId: string,
    method: string,
    url: URL,
    headers: Headers,
    body: unknown,
  ): Response {
    if (url.pathname === "/api/v1/workspaces" && url.search === "") {
      if (method === "GET") {
        this.requireNoBody(body, "list workspaces");
        return this.json(200, {
          workspaces: [...this.workspaces.values()]
            .filter((workspace) => workspace.members.has(actorId))
            .map((workspace) => this.rawWorkspace(workspace, actorId)),
        });
      }
      if (method === "POST") {
        const request = exactObject(body, ["display_name"], "create workspace");
        const idempotencyKey = this.idempotencyKey(headers);
        const replayId = this.workspaceIdempotency.get(idempotencyKey);
        if (replayId) {
          return this.json(
            200,
            this.rawWorkspace(this.requireWorkspace(replayId), actorId),
          );
        }
        if (request.display_name !== "Research Workspace") {
          return this.fail("Unexpected Workspace display name.");
        }
        const workspace: FixtureWorkspace = {
          id: WORKSPACE_ID,
          displayName: request.display_name,
          ownerId: actorId,
          status: "active",
          revision: 1,
          archivedAt: null,
          members: new Map([
            [
              actorId,
              {
                nickname: "Owner A",
                role: "owner",
                revision: 1,
                joinedAt: JOINED_AT,
              },
            ],
            [
              ACCOUNT_C,
              {
                nickname: "Admin C",
                role: "admin",
                revision: 1,
                joinedAt: JOINED_AT,
              },
            ],
          ]),
        };
        this.workspaces.set(workspace.id, workspace);
        this.workspaceIdempotency.set(idempotencyKey, workspace.id);
        return this.json(201, this.rawWorkspace(workspace, actorId));
      }
    }

    if (
      url.pathname === "/api/v1/workspace-invitations/accept" &&
      url.search === "" &&
      method === "POST"
    ) {
      const request = exactObject(body, ["token"], "accept invitation");
      const idempotencyKey = this.idempotencyKey(headers);
      const replayWorkspaceId = this.acceptanceIdempotency.get(
        `${actorId}\0${idempotencyKey}`,
      );
      if (replayWorkspaceId) {
        const replayWorkspace = this.requireWorkspace(replayWorkspaceId);
        return this.json(200, {
          workspace: this.rawWorkspace(replayWorkspace, actorId),
          member: this.rawMember(actorId, replayWorkspace.members.get(actorId)),
        });
      }
      const invitation = [...this.invitations.values()].find(
        (candidate) => candidate.token === request.token,
      );
      if (!invitation || invitation.status !== "pending") {
        return this.error(409, "invitation_unavailable");
      }
      const workspace = this.requireWorkspace(invitation.workspaceId);
      if (workspace.status !== "active") {
        return this.error(409, "workspace_archived");
      }
      invitation.status = "accepted";
      invitation.acceptedByUserId = actorId;
      invitation.acceptedAt = ACCEPTED_AT;
      workspace.members.set(actorId, {
        nickname: "Member B",
        role: "member",
        revision: 1,
        joinedAt: ACCEPTED_AT,
      });
      this.acceptanceIdempotency.set(
        `${actorId}\0${idempotencyKey}`,
        workspace.id,
      );
      return this.json(200, {
        workspace: this.rawWorkspace(workspace, actorId),
        member: this.rawMember(actorId, workspace.members.get(actorId)),
      });
    }

    const lifecycle = url.pathname.match(
      /^\/api\/v1\/workspaces\/([0-9a-f-]+)\/(archive|restore)$/,
    );
    if (lifecycle && url.search === "" && method === "POST") {
      const workspace = this.requireWorkspace(lifecycle[1]);
      const actor = this.requireMember(workspace, actorId);
      const request = exactObject(body, ["expected_revision"], lifecycle[2]);
      if (actor.role !== "owner") return this.error(403, "workspace_forbidden");
      if (request.expected_revision !== workspace.revision) {
        return this.error(409, "workspace_conflict");
      }
      if (lifecycle[2] === "archive") {
        workspace.status = "archived";
        workspace.archivedAt = timestampForRevision(workspace.revision + 1);
      } else {
        workspace.status = "active";
        workspace.archivedAt = null;
      }
      workspace.revision += 1;
      return this.json(200, this.rawWorkspace(workspace, actorId));
    }

    const members = url.pathname.match(
      /^\/api\/v1\/workspaces\/([0-9a-f-]+)\/members$/,
    );
    if (members && url.search === "" && method === "GET") {
      this.requireNoBody(body, "list members");
      const workspace = this.requireWorkspace(members[1]);
      this.requireMember(workspace, actorId);
      return this.json(200, {
        members: [...workspace.members.entries()].map(([userId, member]) =>
          this.rawMember(userId, member),
        ),
      });
    }

    const memberMutation = url.pathname.match(
      /^\/api\/v1\/workspaces\/([0-9a-f-]+)\/members\/([0-9a-f-]+)$/,
    );
    if (memberMutation) {
      const workspace = this.requireWorkspace(memberMutation[1]);
      const actor = this.requireMember(workspace, actorId);
      const target = this.requireMember(workspace, memberMutation[2]);
      if (method === "PATCH" && url.search === "") {
        const request = exactObject(
          body,
          ["expected_revision", "role"],
          "change member role",
        );
        if (actor.role !== "owner" || target.role === "owner") {
          return this.error(403, "workspace_forbidden");
        }
        if (
          request.expected_revision !== target.revision ||
          (request.role !== "admin" && request.role !== "member")
        ) {
          return this.error(409, "membership_conflict");
        }
        target.role = request.role;
        target.revision += 1;
        return this.json(200, this.rawMember(memberMutation[2], target));
      }
      if (method === "DELETE") {
        this.requireNoBody(body, "remove member");
        const expectedRevision = this.exactRevisionQuery(url);
        if (
          (actor.role !== "owner" && actor.role !== "admin") ||
          target.role === "owner" ||
          (actor.role === "admin" && target.role !== "member")
        ) {
          return this.error(403, "workspace_forbidden");
        }
        if (expectedRevision !== target.revision) {
          return this.error(409, "membership_conflict");
        }
        workspace.members.delete(memberMutation[2]);
        return new Response(null, { status: 204 });
      }
    }

    const leave = url.pathname.match(
      /^\/api\/v1\/workspaces\/([0-9a-f-]+)\/leave$/,
    );
    if (leave && url.search === "" && method === "POST") {
      exactObject(body, [], "leave workspace");
      const workspace = this.requireWorkspace(leave[1]);
      const actor = this.requireMember(workspace, actorId);
      if (actor.role === "owner") return this.error(403, "workspace_forbidden");
      workspace.members.delete(actorId);
      return new Response(null, { status: 204 });
    }

    const invitations = url.pathname.match(
      /^\/api\/v1\/workspaces\/([0-9a-f-]+)\/invitations$/,
    );
    if (invitations && url.search === "") {
      const workspace = this.requireWorkspace(invitations[1]);
      const actor = this.requireMember(workspace, actorId);
      if (method === "GET") {
        this.requireNoBody(body, "list invitations");
        if (actor.role === "member") {
          return this.error(403, "workspace_forbidden");
        }
        return this.json(200, {
          invitations: [...this.invitations.values()]
            .filter((invitation) => invitation.workspaceId === workspace.id)
            .map((invitation) => this.rawInvitation(invitation)),
        });
      }
      if (method === "POST") {
        exactObject(body, [], "create invitation");
        if (actor.role !== "owner" && actor.role !== "admin") {
          return this.error(403, "workspace_forbidden");
        }
        const idempotencyKey = this.idempotencyKey(headers);
        const replayId = this.invitationIdempotency.get(idempotencyKey);
        if (replayId) {
          const replay = this.requireInvitation(replayId);
          return this.json(200, {
            ...this.rawInvitation(replay),
            secret_replayable: false,
          });
        }
        const invitation: FixtureInvitation = {
          id: INVITATION_ID,
          workspaceId: workspace.id,
          token: RAW_INVITATION_TOKEN,
          status: "pending",
          createdByUserId: actorId,
          acceptedByUserId: null,
          acceptedAt: null,
          revokedAt: null,
        };
        this.invitations.set(invitation.id, invitation);
        this.invitationIdempotency.set(idempotencyKey, invitation.id);
        return this.json(
          201,
          {
            ...this.rawInvitation(invitation),
            token: invitation.token,
            invite_url: INVITATION_LINK,
            secret_replayable: false,
          },
          "creation_response",
          true,
        );
      }
    }

    const invitationMutation = url.pathname.match(
      /^\/api\/v1\/workspaces\/([0-9a-f-]+)\/invitations\/([0-9a-f-]+)$/,
    );
    if (invitationMutation && url.search === "" && method === "DELETE") {
      this.requireNoBody(body, "revoke invitation");
      const workspace = this.requireWorkspace(invitationMutation[1]);
      const actor = this.requireMember(workspace, actorId);
      if (actor.role !== "owner" && actor.role !== "admin") {
        return this.error(403, "workspace_forbidden");
      }
      const invitation = this.requireInvitation(invitationMutation[2]);
      if (
        invitation.workspaceId !== workspace.id ||
        invitation.status !== "pending"
      ) {
        return this.error(409, "invitation_unavailable");
      }
      invitation.status = "revoked";
      invitation.revokedAt = timestampForRevision(workspace.revision + 1);
      return new Response(null, { status: 204 });
    }

    const workspaceMatch = url.pathname.match(
      /^\/api\/v1\/workspaces\/([0-9a-f-]+)$/,
    );
    if (workspaceMatch && url.search === "" && method === "PATCH") {
      const workspace = this.requireWorkspace(workspaceMatch[1]);
      const actor = this.requireMember(workspace, actorId);
      const request = exactObject(
        body,
        ["display_name", "expected_revision"],
        "rename workspace",
      );
      if (actor.role !== "owner" && actor.role !== "admin") {
        return this.error(403, "workspace_forbidden");
      }
      if (request.expected_revision !== workspace.revision) {
        return this.error(409, "workspace_conflict");
      }
      if (request.display_name !== "Research Lab") {
        return this.fail("Unexpected renamed Workspace display name.");
      }
      workspace.displayName = request.display_name;
      workspace.revision += 1;
      return this.json(200, this.rawWorkspace(workspace, actorId));
    }

    return this.fail(
      `Unexpected Workspace route: ${actorId} ${method} ${url.pathname}${url.search}.`,
    );
  }

  private rawWorkspace(
    workspace: FixtureWorkspace,
    actorId: string,
  ): Record<string, unknown> {
    const actor = this.requireMember(workspace, actorId);
    return {
      created_at: CREATED_AT,
      display_name: workspace.displayName,
      id: workspace.id,
      member_count: workspace.members.size,
      mutation_state: workspace.status === "archived" ? "archived" : "writable",
      revision: workspace.revision,
      role: actor.role,
      status: workspace.status,
      updated_at: timestampForRevision(workspace.revision),
      ...(workspace.archivedAt === null
        ? {}
        : { archived_at: workspace.archivedAt }),
    };
  }

  private rawMember(
    userId: string,
    member: FixtureMembership | undefined,
  ): Record<string, unknown> {
    if (!member) return this.fail(`Missing fixture member ${userId}.`);
    return {
      joined_at: member.joinedAt,
      nickname: member.nickname,
      revision: member.revision,
      role: member.role,
      user_id: userId,
    };
  }

  private rawInvitation(
    invitation: FixtureInvitation,
  ): Record<string, unknown> {
    return {
      created_at: INVITATION_CREATED_AT,
      created_by_user_id: invitation.createdByUserId,
      expires_at: INVITATION_EXPIRES_AT,
      id: invitation.id,
      status: invitation.status,
      ...(invitation.acceptedByUserId === null
        ? {}
        : { accepted_by_user_id: invitation.acceptedByUserId }),
      ...(invitation.acceptedAt === null
        ? {}
        : { accepted_at: invitation.acceptedAt }),
      ...(invitation.revokedAt === null
        ? {}
        : { revoked_at: invitation.revokedAt }),
    };
  }

  private requireWorkspace(id: string): FixtureWorkspace {
    const workspace = this.workspaces.get(id);
    if (!workspace) return this.fail(`Unknown fixture Workspace ${id}.`);
    return workspace;
  }

  private requireInvitation(id: string): FixtureInvitation {
    const invitation = this.invitations.get(id);
    if (!invitation) return this.fail(`Unknown fixture invitation ${id}.`);
    return invitation;
  }

  private requireMember(
    workspace: FixtureWorkspace,
    userId: string,
  ): FixtureMembership {
    const member = workspace.members.get(userId);
    if (!member) return this.fail(`Actor ${userId} is not a Workspace member.`);
    return member;
  }

  private requireNoBody(body: unknown, label: string): void {
    if (body !== undefined) this.fail(`${label} unexpectedly supplied a body.`);
  }

  private idempotencyKey(headers: Headers): string {
    const value = headers.get("idempotency-key");
    if (!value) return this.fail("Workspace mutation omitted idempotency-key.");
    return value;
  }

  private exactRevisionQuery(url: URL): number {
    if ([...url.searchParams.keys()].join(",") !== "expected_revision") {
      return this.fail(`Unexpected Workspace revision query: ${url.search}.`);
    }
    const raw = url.searchParams.get("expected_revision");
    if (!raw || !/^[1-9][0-9]*$/.test(raw)) {
      return this.fail("Invalid expected_revision query.");
    }
    return Number(raw);
  }

  private json(
    status: number,
    body: unknown,
    channel = "ordinary_response",
    allowToken = false,
  ): Response {
    const raw = JSON.stringify(body);
    if (raw.includes(RAW_INVITATION_TOKEN)) {
      this.tokenAppearances.push({ channel, allowed: allowToken });
    }
    return new Response(raw, {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private error(status: number, code: string): Response {
    return this.json(status, {
      error: { code, request_id: "workspace-fixture-request" },
    });
  }

  private fail(message: string): never {
    this.violations.push(message);
    throw new Error(message);
  }
}

function openWorkspaceManager(
  userDataPath: string,
  fixture: WorkspaceRouteFixture,
  session: MutableSession,
): AgenteraWorkspaceManager {
  const database = openAgenteraWorkspaceDatabase(userDataPath, {
    databaseFactory: (path) =>
      new DatabaseSync(path) as unknown as AgenteraWorkspaceSqliteDatabase,
  });
  const client = new AgenteraWorkspaceClient({
    origin: ORIGIN,
    getAccessToken: () => session.accessToken,
    fetch: fixture.fetch,
  });
  const selectionCoordinator = workspaceSelectionCoordinator(database, session);
  return new AgenteraWorkspaceManager({
    database,
    client,
    getAuthState: () => session.auth,
    selectionCoordinator,
    now: () => "2026-07-20T13:00:00Z",
  });
}

function workspaceSelectionCoordinator(
  database: AgenteraWorkspaceDatabase,
  session: MutableSession,
): AgenteraWorkspaceSelectionCoordinator {
  const listeners = new Set<(state: ProductSpacePublicState) => void>();
  const currentAccess = (): Extract<
    AgenteraAuthPublicState,
    { status: "authenticated" | "offline" }
  > => {
    const access = session.auth;
    if (access.status !== "authenticated" && access.status !== "offline") {
      throw new Error("unauthenticated");
    }
    return access;
  };
  const state = (): ProductSpacePublicState => {
    const access = currentAccess();
    const workspaces = database
      .readWorkspaces(access.userId)
      .workspaces.filter(({ status }) => status === "active");
    const selectedWorkspaceId = database.readSelectedWorkspace(access.userId);
    const selectedWorkspace = workspaces.find(
      ({ id }) => id === selectedWorkspaceId,
    );
    return {
      access: access.status === "offline" ? "offline" : "online",
      stale: access.status === "offline",
      selected: selectedWorkspace
        ? {
            kind: "WORKSPACE",
            workspaceId: selectedWorkspace.id,
            role: selectedWorkspace.role,
          }
        : { kind: "PERSONAL" },
      options: [
        { kind: "PERSONAL" },
        ...workspaces.map((workspace) => ({
          kind: "WORKSPACE" as const,
          workspaceId: workspace.id,
          displayName: workspace.displayName,
          role: workspace.role,
        })),
      ],
    };
  };
  return {
    readSelectedWorkspaceId: (accountUserId) =>
      database.readSelectedWorkspace(accountUserId),
    getAgentContext: () => {
      const selection = state().selected;
      return selection.kind === "WORKSPACE"
        ? {
            scope: "WORKSPACE",
            workspaceId: selection.workspaceId,
            role: selection.role,
          }
        : { scope: "USER" };
    },
    select: async (input) => {
      const access = currentAccess();
      database.writeSelectedWorkspace(
        access.userId,
        input.kind === "WORKSPACE" ? input.workspaceId : null,
        "2026-07-20T13:00:00Z",
      );
      const next = state();
      for (const listener of listeners) listener(next);
      return next;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
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

function writeHermesSentinels(rootPath: string): {
  hermesHome: string;
  bindingPath: string;
} {
  const hermesHome = join(rootPath, "hermes-home");
  const profilePath = join(hermesHome, "profiles", "research-agent");
  for (const directory of [
    profilePath,
    join(profilePath, "sessions"),
    join(profilePath, "files"),
    join(profilePath, "skills", "learned-local"),
    join(profilePath, "curator"),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(hermesHome, "active_profile"), "research-agent\n");
  writeFileSync(join(profilePath, "MEMORY.md"), "private local memory\n");
  writeFileSync(join(profilePath, "USER.md"), "private local user\n");
  writeFileSync(
    join(profilePath, "sessions", "active.json"),
    '{"local":true}\n',
  );
  writeFileSync(join(profilePath, "files", "private.txt"), "private file\n");
  writeFileSync(
    join(profilePath, "skills", "learned-local", "SKILL.md"),
    "# local learned skill\n",
  );
  writeFileSync(join(profilePath, "curator", "state.json"), '{"revision":7}\n');

  const bindingPath = join(rootPath, "agentera-control", "active-binding.json");
  mkdirSync(join(rootPath, "agentera-control"), { recursive: true });
  writeFileSync(
    bindingPath,
    `${JSON.stringify({
      id: RUNTIME_BINDING_ID,
      ownerScope: "USER",
      runtimeProfileId: RUNTIME_PROFILE_ID,
      conversationKey: "unchanged-conversation",
    })}\n`,
  );
  return { hermesHome, bindingPath };
}

function expectClientForbidden(error: unknown): void {
  expect(error as AgenteraWorkspaceClientError).toMatchObject({
    status: 403,
    code: "workspace_forbidden",
  });
}

// @lat: [[agentera-workspaces#Release gate#Deterministic multi-account flow]]
// @lat: [[agentera-workspaces#Release gate#Hermes compatibility boundary]]
test("runs the two-account Workspace lifecycle without changing Hermes state", async () => {
  const rootPath = mkdtempSync(join(tmpdir(), "agentera-workspace-e2e-"));
  const userDataPath = join(rootPath, "user-data");
  const { hermesHome, bindingPath } = writeHermesSentinels(rootPath);
  const hermesBefore = snapshotTree(hermesHome);
  const bindingBefore = readFileSync(bindingPath, "utf8");
  const previousHermesHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = hermesHome;

  const fixture = new WorkspaceRouteFixture();
  const inbox = new WorkspaceInvitationInbox();
  const session: MutableSession = {
    auth: onlineState("A"),
    accessToken: ACCESS_A,
  };
  let manager: AgenteraWorkspaceManager | null = null;

  try {
    manager = openWorkspaceManager(userDataPath, fixture, session);

    const initial = await manager.getState();
    expect(initial.selected).toEqual({
      kind: "personal",
      userId: ACCOUNT_A,
      personalSpaceId: PERSONAL_A,
    });
    expect(initial.workspaces).toEqual([]);
    expect((await manager.refresh()).stale).toBe(false);

    const created = await manager.create({
      displayName: "Research Workspace",
      idempotencyKey: "create-workspace-a",
    });
    expect(created).toMatchObject({
      id: WORKSPACE_ID,
      displayName: "Research Workspace",
      role: "owner",
      status: "active",
    });
    const renamed = await manager.rename({
      workspaceId: WORKSPACE_ID,
      displayName: "Research Lab",
      expectedRevision: created.revision,
    });
    expect(renamed).toMatchObject({ displayName: "Research Lab", revision: 2 });
    expect(
      (await manager.select({ workspaceId: WORKSPACE_ID })).selected,
    ).toEqual({
      kind: "workspace",
      userId: ACCOUNT_A,
      workspaceId: WORKSPACE_ID,
      role: "owner",
    });

    const invitation = await manager.createInvitation({
      workspaceId: WORKSPACE_ID,
      idempotencyKey: "create-member-invitation",
    });
    expect(invitation).toMatchObject({
      id: INVITATION_ID,
      token: RAW_INVITATION_TOKEN,
      inviteUrl: INVITATION_LINK,
      secretReplayable: false,
    });
    const replay = await manager.createInvitation({
      workspaceId: WORKSPACE_ID,
      idempotencyKey: "create-member-invitation",
    });
    expect(replay.token).toBeUndefined();
    expect(replay.inviteUrl).toBeUndefined();
    expect(
      JSON.stringify(
        await manager.listInvitations({ workspaceId: WORKSPACE_ID }),
      ),
    ).not.toContain(RAW_INVITATION_TOKEN);

    session.auth = { status: "unauthenticated", reason: "sign_in_required" };
    session.accessToken = null;
    await manager.notifyAccessStateChanged();
    fixture.recordProtocolHandoff(invitation.inviteUrl!);
    expect(inbox.receiveDeepLink(invitation.inviteUrl)).toBe(true);
    expect(inbox.peek()).toEqual({ token: RAW_INVITATION_TOKEN });

    session.auth = onlineState("B");
    session.accessToken = ACCESS_B;
    await manager.notifyAccessStateChanged();
    const beforeAcceptance = await manager.getState();
    expect(beforeAcceptance.selected).toEqual({
      kind: "personal",
      userId: ACCOUNT_B,
      personalSpaceId: PERSONAL_B,
    });
    expect(beforeAcceptance.workspaces).toEqual([]);

    const accepted = await manager.acceptInvitation({
      token: inbox.peek()!.token,
      idempotencyKey: "accept-member-invitation-b",
    });
    expect(accepted).toMatchObject({
      workspace: { id: WORKSPACE_ID, role: "member" },
      member: { userId: ACCOUNT_B, role: "member" },
    });
    expect(inbox.clearAccepted(RAW_INVITATION_TOKEN)).toBe(true);
    expect(inbox.peek()).toBeNull();
    expect(
      (await manager.select({ workspaceId: WORKSPACE_ID })).selected,
    ).toEqual({
      kind: "workspace",
      userId: ACCOUNT_B,
      workspaceId: WORKSPACE_ID,
      role: "member",
    });

    manager.close();
    manager = openWorkspaceManager(userDataPath, fixture, session);
    const afterReload = await manager.getState();
    expect(afterReload.selected).toMatchObject({
      kind: "workspace",
      userId: ACCOUNT_B,
      workspaceId: WORKSPACE_ID,
      role: "member",
    });

    session.auth = onlineState("A");
    session.accessToken = ACCESS_A;
    await manager.notifyAccessStateChanged();
    const accountAState = await manager.getState();
    expect(accountAState.selected).toMatchObject({
      kind: "workspace",
      userId: ACCOUNT_A,
      workspaceId: WORKSPACE_ID,
      role: "owner",
    });
    expect(accountAState.workspaces).toHaveLength(1);
    expect(accountAState.workspaces[0].role).toBe("owner");

    const membersForOwner = await manager.listMembers({
      workspaceId: WORKSPACE_ID,
    });
    const memberB = membersForOwner.find(({ userId }) => userId === ACCOUNT_B)!;
    const promoted = await manager.changeMemberRole({
      workspaceId: WORKSPACE_ID,
      userId: ACCOUNT_B,
      role: "admin",
      expectedRevision: memberB.revision,
    });
    expect(promoted).toMatchObject({ userId: ACCOUNT_B, role: "admin" });

    session.auth = onlineState("B");
    session.accessToken = ACCESS_B;
    await manager.notifyAccessStateChanged();
    const accountBState = await manager.getState();
    expect(accountBState.selected).toMatchObject({
      kind: "workspace",
      userId: ACCOUNT_B,
      workspaceId: WORKSPACE_ID,
      role: "admin",
    });
    expect(accountBState.workspaces[0].role).toBe("admin");
    const membersForAdmin = await manager.listMembers({
      workspaceId: WORKSPACE_ID,
    });
    const owner = membersForAdmin.find(({ userId }) => userId === ACCOUNT_A)!;
    const otherAdmin = membersForAdmin.find(
      ({ userId }) => userId === ACCOUNT_C,
    )!;
    await manager
      .changeMemberRole({
        workspaceId: WORKSPACE_ID,
        userId: owner.userId,
        role: "member",
        expectedRevision: owner.revision,
      })
      .then(() => {
        throw new Error("Admin unexpectedly managed the Owner.");
      }, expectClientForbidden);
    await manager
      .changeMemberRole({
        workspaceId: WORKSPACE_ID,
        userId: otherAdmin.userId,
        role: "member",
        expectedRevision: otherAdmin.revision,
      })
      .then(() => {
        throw new Error("Admin unexpectedly managed another Admin.");
      }, expectClientForbidden);

    const requestCountBeforeOfflineMutation = fixture.exchanges.length;
    session.auth = offlineState("B");
    session.accessToken = ACCESS_B;
    await manager.notifyAccessStateChanged();
    const offline = await manager.getState();
    expect(offline).toMatchObject({
      access: "offline",
      cloudAvailable: false,
      stale: true,
      selected: { kind: "workspace", workspaceId: WORKSPACE_ID },
    });
    await manager
      .rename({
        workspaceId: WORKSPACE_ID,
        displayName: "Research Lab",
        expectedRevision: renamed.revision,
      })
      .then(
        () => {
          throw new Error("Offline Workspace mutation unexpectedly succeeded.");
        },
        (error: unknown) => {
          expect(error as AgenteraWorkspaceManagerError).toMatchObject({
            code: "online_required",
          });
        },
      );
    expect(fixture.exchanges).toHaveLength(requestCountBeforeOfflineMutation);

    session.auth = onlineState("A");
    session.accessToken = ACCESS_A;
    await manager.notifyAccessStateChanged();
    const beforeArchive = await manager.getState();
    expect(beforeArchive.selected).toMatchObject({
      kind: "workspace",
      workspaceId: WORKSPACE_ID,
      role: "owner",
    });
    const activeWorkspace = beforeArchive.workspaces.find(
      ({ id }) => id === WORKSPACE_ID,
    )!;
    const archived = await manager.archive({
      workspaceId: WORKSPACE_ID,
      expectedRevision: activeWorkspace.revision,
    });
    expect(archived.status).toBe("archived");
    expect((await manager.getState()).selected).toEqual({
      kind: "personal",
      userId: ACCOUNT_A,
      personalSpaceId: PERSONAL_A,
    });
    const restored = await manager.restore({
      workspaceId: WORKSPACE_ID,
      expectedRevision: archived.revision,
    });
    expect(restored.status).toBe("active");
    expect(
      (await manager.select({ workspaceId: WORKSPACE_ID })).selected,
    ).toMatchObject({
      kind: "workspace",
      workspaceId: WORKSPACE_ID,
      role: "owner",
    });

    expect(snapshotTree(hermesHome)).toEqual(hermesBefore);
    expect(readFileSync(bindingPath, "utf8")).toBe(bindingBefore);
    expect(readFileSync(join(hermesHome, "active_profile"), "utf8")).toBe(
      "research-agent\n",
    );
    expect(bindingBefore).toContain(RUNTIME_BINDING_ID);
    expect(bindingBefore).toContain(RUNTIME_PROFILE_ID);

    manager.close();
    manager = null;
    for (const path of filesBelow(userDataPath)) {
      expect(
        readFileSync(path).includes(Buffer.from(RAW_INVITATION_TOKEN)),
      ).toBe(false);
    }
    expect(fixture.violations).toEqual([]);
    expect(fixture.tokenAppearances).toEqual([
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
