import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgenteraOrganizationClient,
  AgenteraOrganizationClientError,
} from "./client";

const ORIGIN = "http://127.0.0.1:8086";
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000002";
const TARGET_USER_ID = "20000000-0000-4000-8000-000000000003";
const DEPARTMENT_ID = "30000000-0000-4000-8000-000000000003";
const INVITATION_ID = "40000000-0000-4000-8000-000000000004";
const POLICY_ID = "50000000-0000-4000-8000-000000000005";
const AUDIT_ID = "60000000-0000-4000-8000-000000000006";
const CREATED_AT = "2026-07-21T00:00:00Z";
const UPDATED_AT = "2026-07-21T01:00:00Z";
const ARCHIVED_AT = "2026-07-21T02:00:00Z";
const EXPIRES_AT = "2026-07-28T00:00:00Z";
const TOKEN = "A".repeat(43);
const CURSOR = Buffer.from('{"kind":"organizations"}', "utf8").toString(
  "base64url",
);
const DIGEST = "a".repeat(64);
const SIGNATURE = "A".repeat(86);
const PUBLIC_KEY = "A".repeat(43);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function summary(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: ORGANIZATION_ID,
    display_name: "Acme Research",
    status: "active",
    revision: 1,
    role: "owner",
    member_count: 2,
    department_count: 1,
    current_policy_version: 1,
    current_policy_digest: DIGEST,
    mutation_state: "writable",
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
    department_id: DEPARTMENT_ID,
    revision: 1,
    joined_at: CREATED_AT,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function department(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: DEPARTMENT_ID,
    display_name: "Research",
    status: "active",
    member_count: 1,
    revision: 1,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
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

function policyDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    models: { allowlist: null },
    tools: { allowlist: ["browser.read"] },
    experience_candidates: { mode: "manual_review" },
    official_agents: { installation: "allowed" },
    ...overrides,
  };
}

function policySummary(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: POLICY_ID,
    policy_version: 1,
    schema_version: 1,
    content_digest: DIGEST,
    issuer: ORIGIN,
    signing_key_id: "organization-key-1",
    created_at: CREATED_AT,
    ...overrides,
  };
}

function policySnapshot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...policySummary(),
    policy_document: policyDocument(),
    signature: SIGNATURE,
    ...overrides,
  };
}

function auditEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: AUDIT_ID,
    event_type: "organization.member.role_changed",
    object_type: "organization_membership",
    object_id: USER_ID,
    outcome: "succeeded",
    reason_code: "role_changed",
    request_id: "request-1",
    actor_display: "Owner",
    subject_display: "Teammate",
    created_at: UPDATED_AT,
    ...overrides,
  };
}

function signingKeys(): Record<string, unknown> {
  return {
    keys: [
      "access",
      "offline_entitlement",
      "agent_version",
      "agent_policy",
      "organization_policy",
    ].map((purpose, index) => ({
      kid: `${purpose}-key-${index}`,
      kty: "OKP",
      crv: "Ed25519",
      alg: "EdDSA",
      use: "sig",
      purpose,
      x: PUBLIC_KEY,
    })),
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

function createClient(fetcher: typeof fetch): AgenteraOrganizationClient {
  return new AgenteraOrganizationClient({
    origin: ORIGIN,
    getAccessToken: () => "access-token",
    fetch: fetcher,
  });
}

describe("AgenteraOrganizationClient", () => {
  it("calls every Organization Foundation route with exact trusted headers, bodies, and pagination", async () => {
    const archived = summary({
      status: "archived",
      mutation_state: "archived",
      revision: 2,
      archived_at: ARCHIVED_AT,
      updated_at: ARCHIVED_AT,
    });
    const dissolved = summary({
      status: "dissolved",
      mutation_state: "dissolved",
      revision: 3,
      archived_at: ARCHIVED_AT,
      updated_at: ARCHIVED_AT,
      member_count: 0,
      department_count: 0,
    });
    const archivedDepartment = department({
      status: "archived",
      member_count: 0,
      revision: 2,
      archived_at: ARCHIVED_AT,
      updated_at: ARCHIVED_AT,
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ items: [summary()], next_cursor: CURSOR }),
      )
      .mockResolvedValueOnce(jsonResponse(summary(), 201))
      .mockResolvedValueOnce(jsonResponse(summary()))
      .mockResolvedValueOnce(
        jsonResponse(summary({ display_name: "Acme Labs", revision: 2 })),
      )
      .mockResolvedValueOnce(jsonResponse(archived))
      .mockResolvedValueOnce(jsonResponse(summary({ revision: 3 })))
      .mockResolvedValueOnce(
        jsonResponse(summary({ role: "admin", revision: 4 })),
      )
      .mockResolvedValueOnce(jsonResponse(dissolved))
      .mockResolvedValueOnce(
        jsonResponse({ items: [member()], next_cursor: CURSOR }),
      )
      .mockResolvedValueOnce(
        jsonResponse(member({ role: "auditor", revision: 2 })),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse({ items: [department()], next_cursor: CURSOR }),
      )
      .mockResolvedValueOnce(jsonResponse(department(), 201))
      .mockResolvedValueOnce(
        jsonResponse(department({ display_name: "Applied Research" })),
      )
      .mockResolvedValueOnce(jsonResponse(archivedDepartment))
      .mockResolvedValueOnce(jsonResponse(department({ revision: 3 })))
      .mockResolvedValueOnce(
        jsonResponse({ items: [invitation()], next_cursor: CURSOR }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            invitation: invitation(),
            token: TOKEN,
            invite_url: `agentera://organization-invitation#${TOKEN}`,
            secret_replayable: false,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse({ organization: summary(), member: member() }),
      )
      .mockResolvedValueOnce(jsonResponse(policySnapshot()))
      .mockResolvedValueOnce(
        jsonResponse({ items: [policySummary()], next_cursor: CURSOR }),
      )
      .mockResolvedValueOnce(
        jsonResponse(policySnapshot({ policy_version: 2 }), 201),
      )
      .mockResolvedValueOnce(jsonResponse(policySnapshot()))
      .mockResolvedValueOnce(
        jsonResponse({ items: [auditEvent()], next_cursor: CURSOR }),
      )
      .mockResolvedValueOnce(jsonResponse(signingKeys()));
    const client = createClient(fetcher as typeof fetch);

    await client.listOrganizations({ limit: 25, cursor: CURSOR });
    await client.createOrganization("Acme Research", "org-create");
    await client.getOrganization(ORGANIZATION_ID);
    await client.renameOrganization(ORGANIZATION_ID, "Acme Labs", 1);
    await client.archiveOrganization(ORGANIZATION_ID, 1, "org-archive");
    await client.restoreOrganization(ORGANIZATION_ID, 2, "org-restore");
    await client.transferOwner(
      ORGANIZATION_ID,
      TARGET_USER_ID,
      3,
      1,
      1,
      "transfer-organization-owner",
      "owner-transfer",
    );
    await client.dissolveOrganization(
      ORGANIZATION_ID,
      "Acme Research",
      2,
      "dissolve-organization",
      "org-dissolve",
    );
    await client.listMembers(ORGANIZATION_ID, { limit: 25, cursor: CURSOR });
    await client.patchMember(ORGANIZATION_ID, USER_ID, {
      role: "auditor",
      departmentId: DEPARTMENT_ID,
      expectedRevision: 1,
    });
    await client.removeMember(ORGANIZATION_ID, USER_ID, 2);
    await client.leaveOrganization(ORGANIZATION_ID);
    await client.listDepartments(ORGANIZATION_ID, {
      limit: 25,
      cursor: CURSOR,
    });
    await client.createDepartment(ORGANIZATION_ID, "Research");
    await client.renameDepartment(
      ORGANIZATION_ID,
      DEPARTMENT_ID,
      "Applied Research",
      1,
    );
    await client.archiveDepartment(ORGANIZATION_ID, DEPARTMENT_ID, 1);
    await client.restoreDepartment(ORGANIZATION_ID, DEPARTMENT_ID, 2);
    await client.listInvitations(ORGANIZATION_ID, {
      limit: 25,
      cursor: CURSOR,
    });
    await client.createInvitation(ORGANIZATION_ID, "invite-create");
    await client.revokeInvitation(ORGANIZATION_ID, INVITATION_ID);
    await client.acceptInvitation(TOKEN, "invite-accept");
    await client.getCurrentPolicy(ORGANIZATION_ID);
    await client.listPolicySnapshots(ORGANIZATION_ID, {
      limit: 25,
      cursor: CURSOR,
    });
    await client.publishPolicy(
      ORGANIZATION_ID,
      {
        schemaVersion: 1,
        models: { allowlist: null },
        tools: { allowlist: ["browser.read"] },
        experienceCandidates: { mode: "manual_review" },
        officialAgents: { installation: "allowed" },
      },
      1,
      2,
      "policy-publish",
    );
    await client.getPolicySnapshot(POLICY_ID);
    await client.listAuditEvents(ORGANIZATION_ID, {
      limit: 25,
      cursor: CURSOR,
    });
    await client.getSigningKeys();

    expect(fetcher).toHaveBeenCalledTimes(27);
    const calls = fetcher.mock.calls.map(([url, init]) => ({
      path: new URL(String(url)).pathname + new URL(String(url)).search,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    }));
    expect(calls.map((call) => call.path)).toEqual([
      `/api/v1/organizations?limit=25&cursor=${CURSOR}`,
      "/api/v1/organizations",
      `/api/v1/organizations/${ORGANIZATION_ID}`,
      `/api/v1/organizations/${ORGANIZATION_ID}`,
      `/api/v1/organizations/${ORGANIZATION_ID}/archive`,
      `/api/v1/organizations/${ORGANIZATION_ID}/restore`,
      `/api/v1/organizations/${ORGANIZATION_ID}/owner-transfer`,
      `/api/v1/organizations/${ORGANIZATION_ID}/dissolve`,
      `/api/v1/organizations/${ORGANIZATION_ID}/members?limit=25&cursor=${CURSOR}`,
      `/api/v1/organizations/${ORGANIZATION_ID}/members/${USER_ID}`,
      `/api/v1/organizations/${ORGANIZATION_ID}/members/${USER_ID}?expected_revision=2`,
      `/api/v1/organizations/${ORGANIZATION_ID}/leave`,
      `/api/v1/organizations/${ORGANIZATION_ID}/departments?limit=25&cursor=${CURSOR}`,
      `/api/v1/organizations/${ORGANIZATION_ID}/departments`,
      `/api/v1/organizations/${ORGANIZATION_ID}/departments/${DEPARTMENT_ID}`,
      `/api/v1/organizations/${ORGANIZATION_ID}/departments/${DEPARTMENT_ID}/archive`,
      `/api/v1/organizations/${ORGANIZATION_ID}/departments/${DEPARTMENT_ID}/restore`,
      `/api/v1/organizations/${ORGANIZATION_ID}/invitations?limit=25&cursor=${CURSOR}`,
      `/api/v1/organizations/${ORGANIZATION_ID}/invitations`,
      `/api/v1/organizations/${ORGANIZATION_ID}/invitations/${INVITATION_ID}`,
      "/api/v1/organization-invitations/accept",
      `/api/v1/organizations/${ORGANIZATION_ID}/policy`,
      `/api/v1/organizations/${ORGANIZATION_ID}/policy-snapshots?limit=25&cursor=${CURSOR}`,
      `/api/v1/organizations/${ORGANIZATION_ID}/policy-snapshots`,
      `/api/v1/organization-policy-snapshots/${POLICY_ID}`,
      `/api/v1/organizations/${ORGANIZATION_ID}/audit-events?limit=25&cursor=${CURSOR}`,
      "/.well-known/agentera-signing-keys.json",
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "PATCH",
      "POST",
      "POST",
      "POST",
      "POST",
      "GET",
      "PATCH",
      "DELETE",
      "POST",
      "GET",
      "POST",
      "PATCH",
      "POST",
      "POST",
      "GET",
      "POST",
      "DELETE",
      "POST",
      "GET",
      "GET",
      "POST",
      "GET",
      "GET",
      "GET",
    ]);
    expect(calls.map((call) => call.body)).toEqual([
      undefined,
      JSON.stringify({ display_name: "Acme Research" }),
      undefined,
      JSON.stringify({ display_name: "Acme Labs", expected_revision: 1 }),
      JSON.stringify({ expected_revision: 1 }),
      JSON.stringify({ expected_revision: 2 }),
      JSON.stringify({
        target_user_id: TARGET_USER_ID,
        expected_organization_revision: 3,
        expected_owner_revision: 1,
        expected_target_revision: 1,
        confirmation: "transfer-organization-owner",
      }),
      JSON.stringify({
        display_name: "Acme Research",
        expected_revision: 2,
        confirmation: "dissolve-organization",
      }),
      undefined,
      JSON.stringify({
        role: "auditor",
        department_id: DEPARTMENT_ID,
        expected_revision: 1,
      }),
      undefined,
      "{}",
      undefined,
      JSON.stringify({ display_name: "Research" }),
      JSON.stringify({
        display_name: "Applied Research",
        expected_revision: 1,
      }),
      JSON.stringify({ expected_revision: 1 }),
      JSON.stringify({ expected_revision: 2 }),
      undefined,
      "{}",
      undefined,
      JSON.stringify({ token: TOKEN }),
      undefined,
      undefined,
      JSON.stringify({
        policy_document: policyDocument(),
        expected_organization_revision: 1,
        expected_policy_version: 2,
      }),
      undefined,
      undefined,
      undefined,
    ]);
    for (const call of calls.slice(0, -1)) {
      expect(call.headers).toMatchObject({
        accept: "application/json",
        authorization: "Bearer access-token",
      });
    }
    expect(calls.at(-1)?.headers).toEqual({ accept: "application/json" });
    expect(
      calls
        .map((call, index) =>
          (call.headers as Record<string, string>)["idempotency-key"]
            ? index
            : null,
        )
        .filter((index) => index !== null),
    ).toEqual([1, 4, 5, 6, 7, 18, 20, 23]);
    expect(calls[0]).toMatchObject({
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer access-token",
      },
      body: undefined,
    });
    expect(calls[1]).toMatchObject({
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: "Bearer access-token",
        "content-type": "application/json",
        "idempotency-key": "org-create",
      },
      body: JSON.stringify({ display_name: "Acme Research" }),
    });
    expect(calls[6].body).toBe(
      JSON.stringify({
        target_user_id: TARGET_USER_ID,
        expected_organization_revision: 3,
        expected_owner_revision: 1,
        expected_target_revision: 1,
        confirmation: "transfer-organization-owner",
      }),
    );
    expect(calls[9].body).toBe(
      JSON.stringify({
        role: "auditor",
        department_id: DEPARTMENT_ID,
        expected_revision: 1,
      }),
    );
    expect(calls[23]).toMatchObject({
      headers: {
        "idempotency-key": "policy-publish",
      },
      body: JSON.stringify({
        policy_document: policyDocument(),
        expected_organization_revision: 1,
        expected_policy_version: 2,
      }),
    });
  });

  it.each([
    summary({ email: "private@example.com" }),
    summary({ profile_path: "/private/profile" }),
    summary({ current_policy_digest: "A".repeat(64) }),
    summary({ updated_at: "yesterday" }),
    summary({ id: "NOT-A-UUID" }),
  ])(
    "rejects malformed, unknown, or private Organization fields",
    async (value) => {
      const client = createClient((async () =>
        jsonResponse({ items: [value] })) as typeof fetch);
      await expect(client.listOrganizations()).rejects.toMatchObject({
        code: "invalid_response",
      });
    },
  );

  it("retrieves the current bearer per request and fails closed when it disappears", async () => {
    const fetcher = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        jsonResponse({ items: [] }),
    );
    const tokens = ["access-one", "access-two", null];
    const client = new AgenteraOrganizationClient({
      origin: ORIGIN,
      getAccessToken: () => tokens.shift() ?? null,
      fetch: fetcher as typeof fetch,
    });

    await client.listOrganizations();
    await client.listOrganizations();
    await expect(client.listOrganizations()).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      authorization: "Bearer access-one",
    });
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({
      authorization: "Bearer access-two",
    });
  });

  it("rejects malformed signatures, unknown policy fields, and non-canonical pagination", async () => {
    const badPolicy = createClient((async () =>
      jsonResponse(
        policySnapshot({
          signature: "not-a-signature",
          policy_document: policyDocument({ api_key: "private" }),
        }),
      )) as typeof fetch);
    await expect(
      badPolicy.getCurrentPolicy(ORGANIZATION_ID),
    ).rejects.toMatchObject({ code: "invalid_response" });

    const fetcher = vi.fn(async () => jsonResponse({ items: [] }));
    const local = createClient(fetcher as typeof fetch);
    await expect(
      local.listOrganizations({ cursor: "not+base64" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(local.listOrganizations({ limit: 101 })).rejects.toMatchObject(
      { code: "invalid_request" },
    );
    expect(fetcher).not.toHaveBeenCalled();

    const oversizedCursor = "A".repeat(684);
    const remote = createClient((async () =>
      jsonResponse({
        items: [],
        next_cursor: oversizedCursor,
      })) as typeof fetch);
    await expect(remote.listOrganizations()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("uses a bounded timeout without exposing transport errors", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("private transport", "AbortError")),
            { once: true },
          );
        }),
    );
    const client = createClient(fetcher as typeof fetch);
    const result = client.listOrganizations().catch((error) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toMatchObject({ code: "request_timeout" });
  });

  it("allows Member policy summaries but requires full immutable snapshot responses", async () => {
    const memberClient = createClient((async () =>
      jsonResponse(policySummary())) as typeof fetch);
    await expect(
      memberClient.getCurrentPolicy(ORGANIZATION_ID),
    ).resolves.toMatchObject({ document: null, signature: null });

    const privilegedClient = createClient((async () =>
      jsonResponse(policySummary())) as typeof fetch);
    await expect(
      privilegedClient.getPolicySnapshot(POLICY_ID),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects duplicate JSON fields and invitation secrets outside first creation", async () => {
    const duplicate = JSON.stringify({ items: [summary()] }).replace(
      `"id":"${ORGANIZATION_ID}"`,
      `"id":"${ORGANIZATION_ID}","id":"${ORGANIZATION_ID}"`,
    );
    const duplicateClient = createClient(
      (async () =>
        new Response(duplicate, {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    );
    await expect(duplicateClient.listOrganizations()).rejects.toMatchObject({
      code: "invalid_response",
    });

    const leaked = createClient((async () =>
      jsonResponse({
        items: [invitation({ token: TOKEN })],
      })) as typeof fetch);
    await expect(leaked.listInvitations(ORGANIZATION_ID)).rejects.toMatchObject(
      { code: "invalid_response" },
    );
  });

  it("bounds response bodies and redacts server details from errors", async () => {
    const tooLarge = createClient(
      (async () =>
        new Response("{}", {
          headers: {
            "content-length": String(256 * 1024 + 1),
            "content-type": "application/json",
          },
        })) as typeof fetch,
    );
    await expect(tooLarge.listOrganizations()).rejects.toMatchObject({
      code: "response_too_large",
    });

    const secret = "server-private-detail";
    const failed = createClient((async () =>
      jsonResponse(
        {
          error: {
            code: "organization_forbidden",
            request_id: secret,
            detail: secret,
          },
        },
        403,
      )) as typeof fetch);
    const error = await failed
      .getOrganization(ORGANIZATION_ID)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(AgenteraOrganizationClientError);
    expect(error).toMatchObject({ status: 403, code: "request_failed" });
    expect(String(error)).not.toContain(secret);

    const validEnvelope = createClient((async () =>
      jsonResponse(
        {
          error: {
            code: "organization_forbidden",
            request_id: secret,
          },
        },
        403,
      )) as typeof fetch);
    const stable = await validEnvelope
      .getOrganization(ORGANIZATION_ID)
      .catch((caught) => caught);
    expect(stable).toMatchObject({
      status: 403,
      code: "organization_forbidden",
    });
    expect(String(stable)).not.toContain(secret);

    for (const [status, code] of [
      [410, "invitation_expired"],
      [410, "invitation_revoked"],
      [409, "invitation_used"],
    ] as const) {
      const invitationFailure = createClient((async () =>
        jsonResponse(
          { error: { code, request_id: "invitation-request" } },
          status,
        )) as typeof fetch);
      await expect(
        invitationFailure.acceptInvitation(TOKEN, `accept-${code}`),
      ).rejects.toMatchObject({ status, code });
    }
  });
});
