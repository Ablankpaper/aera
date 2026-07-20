import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgenteraWorkspaceClient,
  AgenteraWorkspaceClientError,
} from "./client";

const ORIGIN = "http://127.0.0.1:8086";
const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000002";
const INVITATION_ID = "30000000-0000-4000-8000-000000000003";
const CREATED_AT = "2026-07-20T10:00:00Z";
const UPDATED_AT = "2026-07-20T11:00:00Z";
const EXPIRES_AT = "2026-07-27T10:00:00Z";
const RAW_TOKEN = "A".repeat(43);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function summary(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: WORKSPACE_ID,
    display_name: "Team Space",
    status: "active",
    revision: 1,
    mutation_state: "writable",
    role: "owner",
    member_count: 2,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function member(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    user_id: USER_ID,
    nickname: "Teammate",
    role: "member",
    revision: 1,
    joined_at: CREATED_AT,
    ...overrides,
  };
}

function invitation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: INVITATION_ID,
    status: "pending",
    created_by_user_id: USER_ID,
    created_at: CREATED_AT,
    expires_at: EXPIRES_AT,
    ...overrides,
  };
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function clientWith(
  fetcher: typeof fetch,
  getAccessToken: () => string | null = () => "access-one",
): AgenteraWorkspaceClient {
  return new AgenteraWorkspaceClient({
    origin: ORIGIN,
    getAccessToken,
    fetch: fetcher,
  });
}

describe("AgenteraWorkspaceClient", () => {
  it("calls all thirteen routes with exact methods, paths, bodies, and trusted headers", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ workspaces: [summary()] }))
      .mockResolvedValueOnce(jsonResponse(summary(), 201))
      .mockResolvedValueOnce(
        jsonResponse(summary({ display_name: "Renamed", revision: 2 })),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          summary({
            status: "archived",
            mutation_state: "archived",
            revision: 3,
            archived_at: UPDATED_AT,
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(summary({ revision: 4 })))
      .mockResolvedValueOnce(jsonResponse({ members: [member()] }))
      .mockResolvedValueOnce(
        jsonResponse(member({ role: "admin", revision: 2 })),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ invitations: [invitation()] }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ...invitation(),
            token: RAW_TOKEN,
            invite_url: `agentera://workspace-invitation#${RAW_TOKEN}`,
            secret_replayable: false,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse({ workspace: summary(), member: member() }),
      );
    const getAccessToken = vi.fn(() => "access-one");
    const client = clientWith(fetcher as typeof fetch, getAccessToken);

    await client.listWorkspaces();
    await client.createWorkspace("Team Space", "create-key");
    await client.renameWorkspace(WORKSPACE_ID, "Renamed", 1);
    await client.archiveWorkspace(WORKSPACE_ID, 2);
    await client.restoreWorkspace(WORKSPACE_ID, 3);
    await client.listMembers(WORKSPACE_ID);
    await client.changeMemberRole(WORKSPACE_ID, USER_ID, "admin", 1);
    await client.removeMember(WORKSPACE_ID, USER_ID, 2);
    await client.leaveWorkspace(WORKSPACE_ID);
    await client.listInvitations(WORKSPACE_ID);
    const created = await client.createInvitation(WORKSPACE_ID, "invite-key");
    await client.revokeInvitation(WORKSPACE_ID, INVITATION_ID);
    await client.acceptInvitation(RAW_TOKEN, "accept-key");

    expect(created).toMatchObject({
      token: RAW_TOKEN,
      inviteUrl: `agentera://workspace-invitation#${RAW_TOKEN}`,
    });
    expect(getAccessToken).toHaveBeenCalledTimes(13);
    const calls = fetcher.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    }));
    expect(calls).toEqual([
      {
        url: `${ORIGIN}/api/v1/workspaces`,
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer access-one",
        },
        body: undefined,
      },
      {
        url: `${ORIGIN}/api/v1/workspaces`,
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer access-one",
          "content-type": "application/json",
          "idempotency-key": "create-key",
        },
        body: JSON.stringify({ display_name: "Team Space" }),
      },
      {
        url: `${ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}`,
        method: "PATCH",
        headers: {
          accept: "application/json",
          authorization: "Bearer access-one",
          "content-type": "application/json",
        },
        body: JSON.stringify({ display_name: "Renamed", expected_revision: 1 }),
      },
      {
        url: `${ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/archive`,
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer access-one",
          "content-type": "application/json",
        },
        body: JSON.stringify({ expected_revision: 2 }),
      },
      {
        url: `${ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/restore`,
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer access-one",
          "content-type": "application/json",
        },
        body: JSON.stringify({ expected_revision: 3 }),
      },
      {
        url: `${ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/members`,
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer access-one",
        },
        body: undefined,
      },
      {
        url: `${ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/members/${USER_ID}`,
        method: "PATCH",
        headers: {
          accept: "application/json",
          authorization: "Bearer access-one",
          "content-type": "application/json",
        },
        body: JSON.stringify({ role: "admin", expected_revision: 1 }),
      },
      {
        url: `${ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/members/${USER_ID}?expected_revision=2`,
        method: "DELETE",
        headers: {
          accept: "application/json",
          authorization: "Bearer access-one",
        },
        body: undefined,
      },
      {
        url: `${ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/leave`,
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer access-one",
          "content-type": "application/json",
        },
        body: "{}",
      },
      {
        url: `${ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/invitations`,
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer access-one",
        },
        body: undefined,
      },
      {
        url: `${ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/invitations`,
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer access-one",
          "content-type": "application/json",
          "idempotency-key": "invite-key",
        },
        body: "{}",
      },
      {
        url: `${ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/invitations/${INVITATION_ID}`,
        method: "DELETE",
        headers: {
          accept: "application/json",
          authorization: "Bearer access-one",
        },
        body: undefined,
      },
      {
        url: `${ORIGIN}/api/v1/workspace-invitations/accept`,
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer access-one",
          "content-type": "application/json",
          "idempotency-key": "accept-key",
        },
        body: JSON.stringify({ token: RAW_TOKEN }),
      },
    ]);
  });

  it("retrieves the bearer token for each request and fails closed when it is missing", async () => {
    const fetcher = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        jsonResponse({ workspaces: [] }),
    );
    const tokens = ["access-one", "access-two", null];
    const getAccessToken = vi.fn(() => tokens.shift() ?? null);
    const client = clientWith(fetcher as typeof fetch, getAccessToken);

    await client.listWorkspaces();
    await client.listWorkspaces();
    await expect(client.listWorkspaces()).rejects.toMatchObject({
      status: 401,
      code: "session_revoked",
    });
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      authorization: "Bearer access-one",
    });
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({
      authorization: "Bearer access-two",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "session_revoked"],
    [403, "workspace_forbidden"],
    [404, "workspace_not_found"],
    [409, "workspace_conflict"],
    [429, "rate_limited"],
    [503, "service_unavailable"],
  ])(
    "maps stable %i responses without exposing their bodies",
    async (status, code) => {
      const secret = "server-private-detail";
      const fetcher = vi.fn(async () =>
        jsonResponse(
          { error: { code, request_id: secret } },
          status,
          status === 429 ? { "retry-after": "37" } : {},
        ),
      );
      const client = clientWith(fetcher as typeof fetch);

      const error = await client
        .createWorkspace("Team Space", "create-key")
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(AgenteraWorkspaceClientError);
      expect(error).toMatchObject({
        status,
        code,
        retryAfterSeconds: status === 429 ? 37 : null,
      });
      expect(String(error)).not.toContain(secret);
    },
  );

  it("uses a fifteen-second timeout and bounds declared, streamed, and aborted responses", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const pendingFetch = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("transport detail", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const timeoutResult = clientWith(pendingFetch as typeof fetch)
      .listWorkspaces()
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(timeoutResult).resolves.toMatchObject({
      code: "request_timeout",
    });
    vi.useRealTimers();

    const declared = clientWith(
      (async () =>
        new Response("{}", {
          headers: {
            "content-length": String(256 * 1024 + 1),
            "content-type": "application/json",
          },
        })) as typeof fetch,
    );
    await expect(declared.listWorkspaces()).rejects.toMatchObject({
      code: "response_too_large",
    });

    const streamed = clientWith(
      (async () =>
        new Response("x".repeat(256 * 1024 + 1), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    );
    await expect(streamed.listWorkspaces()).rejects.toMatchObject({
      code: "response_too_large",
    });

    const abortedClient = clientWith((async () => {
      throw new DOMException("secret abort", "AbortError");
    }) as typeof fetch);
    await expect(abortedClient.listWorkspaces()).rejects.toMatchObject({
      code: "network_unavailable",
    });
  });

  it.each([
    summary({ role: "superuser" }),
    summary({ status: "deleted" }),
    summary({ mutation_state: "local" }),
    summary({ id: "not-a-uuid" }),
    summary({ updated_at: "yesterday" }),
    summary({ email: "private@example.com" }),
    summary({ phone: "+8613800138000" }),
    summary({ profile_path: "/private/profile" }),
    summary({ Memory: "private" }),
    summary({ session_id: "private" }),
    summary({ token: RAW_TOKEN }),
  ])(
    "rejects invalid or private Workspace summary fields",
    async (candidate) => {
      const client = clientWith((async () =>
        jsonResponse({ workspaces: [candidate] })) as typeof fetch);
      await expect(client.listWorkspaces()).rejects.toMatchObject({
        code: "invalid_response",
      });
    },
  );

  it("rejects duplicate JSON response fields", async () => {
    const duplicate = JSON.stringify({ workspaces: [summary()] }).replace(
      `"id":"${WORKSPACE_ID}"`,
      `"id":"${WORKSPACE_ID}","id":"${WORKSPACE_ID}"`,
    );
    const client = clientWith(
      (async () =>
        new Response(duplicate, {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    );
    await expect(client.listWorkspaces()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("keeps invitation secrets out of lists, replays, and acceptance", async () => {
    const listClient = clientWith((async () =>
      jsonResponse({
        invitations: [invitation({ token: RAW_TOKEN })],
      })) as typeof fetch);
    await expect(
      listClient.listInvitations(WORKSPACE_ID),
    ).rejects.toMatchObject({ code: "invalid_response" });

    for (const missing of [
      {
        ...invitation(),
        invite_url: `agentera://workspace-invitation#${RAW_TOKEN}`,
        secret_replayable: false,
      },
      { ...invitation(), token: RAW_TOKEN, secret_replayable: false },
    ]) {
      const firstClient = clientWith((async () =>
        jsonResponse(missing, 201)) as typeof fetch);
      await expect(
        firstClient.createInvitation(WORKSPACE_ID, "invite-key"),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }

    const replayClient = clientWith((async () =>
      jsonResponse({
        ...invitation(),
        token: RAW_TOKEN,
        invite_url: `agentera://workspace-invitation#${RAW_TOKEN}`,
        secret_replayable: false,
      })) as typeof fetch);
    await expect(
      replayClient.createInvitation(WORKSPACE_ID, "invite-key"),
    ).rejects.toMatchObject({ code: "invalid_response" });

    const acceptanceClient = clientWith((async () =>
      jsonResponse({
        workspace: summary(),
        member: member(),
        token: RAW_TOKEN,
      })) as typeof fetch);
    await expect(
      acceptanceClient.acceptInvitation(RAW_TOKEN, "accept-key"),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects malformed local inputs before transport", async () => {
    const fetcher = vi.fn(async () => jsonResponse(summary()));
    const client = clientWith(fetcher as typeof fetch);
    await expect(
      client.renameWorkspace("NOT-A-UUID", "Name", 1),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      client.archiveWorkspace(WORKSPACE_ID, 0),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.createWorkspace(" ", "key")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(client.createWorkspace("\ud800", "key")).rejects.toMatchObject(
      { code: "invalid_request" },
    );
    await expect(
      client.createWorkspace("Name", "x".repeat(129)),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      client.createWorkspace("Name", "\ud800"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      client.acceptInvitation("not-a-token", "key"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
