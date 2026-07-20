// @vitest-environment node

import {
  createPublicKey,
  generateKeyPairSync,
  verify as verifySignature,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { InstallationIdentity } from "../agentera-auth/store";
import {
  AgenteraAgentControlClient,
  AgenteraAgentControlClientError,
  type AgentDefinition,
  type AgentInstallation,
  type AgentPolicySnapshot,
  type CloudExperienceCandidateBundle,
  type CloudExperienceCandidateDetail,
  type CloudExperienceCandidateSummary,
} from "./client";

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const PROFILE_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_ID = "55555555-5555-4555-8555-555555555555";
const WORKSPACE_ID = "77777777-7777-4777-8777-777777777777";
const CANDIDATE_ID = "88888888-8888-4888-8888-888888888888";
const REVIEW_ID = "99999999-9999-4999-8999-999999999999";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSION_DIGEST = "ab".repeat(32);
const NOW = new Date("2026-07-19T16:00:00.000Z");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function definition(): AgentDefinition {
  return {
    id: DEFINITION_ID,
    display_name: "Research Agent",
    status: "active" as const,
    latest_version_id: VERSION_ID,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function installation(): AgentInstallation {
  return {
    id: INSTALLATION_ID,
    definition_id: DEFINITION_ID,
    selected_version_id: VERSION_ID,
    runtime_profile_id: PROFILE_ID,
    policy_snapshot_id: POLICY_ID,
    update_policy: "manual" as const,
    status: "active" as const,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    activated_at: NOW.toISOString(),
  };
}

function policySnapshot(): AgentPolicySnapshot {
  return {
    id: POLICY_ID,
    installation_id: INSTALLATION_ID,
    agent_version_id: VERSION_ID,
    issuer: "http://127.0.0.1:8086",
    policy_version: 1,
    document: {
      schema_version: 1,
      agent_definition_id: DEFINITION_ID,
      agent_version_id: VERSION_ID,
      version_digest: VERSION_DIGEST,
      model_constraints: {
        allowed_providers: ["openai"],
        allowed_models: ["gpt-5.6"],
      },
      runtime_compatibility: {
        minimum_version: "v0.18.2-agentera.1",
        maximum_version_exclusive: "v0.19.0",
      },
      tools: { allowed: ["files.read"], denied: [] },
      deny_rules: [],
      publication_allowed: false,
    },
    content_digest: "cd".repeat(32),
    signing_key_id: "policy-test-key",
    signature: "A".repeat(86),
    created_at: NOW.toISOString(),
  };
}

function deviceIdentity(): InstallationIdentity {
  const pair = generateKeyPairSync("ed25519");
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
  const privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
  return {
    installationId: "66666666-6666-4666-8666-666666666666",
    devicePublicKey: Buffer.from(publicDer)
      .subarray(SPKI_PREFIX.length)
      .toString("base64url"),
    devicePrivateKey: Buffer.from(privateDer).toString("base64"),
  };
}

function experienceBundle(): CloudExperienceCandidateBundle {
  return {
    schema_version: 1 as const,
    skill_name: "weekly-summary",
    assets: [
      {
        path: "skills/weekly-summary/SKILL.md",
        media_type: "text/markdown" as const,
        content: "# Weekly summary\n",
      },
    ],
  };
}

function experienceSummary(reviewed = false): CloudExperienceCandidateSummary {
  return {
    id: CANDIDATE_ID,
    workspace_id: WORKSPACE_ID,
    agent_definition_id: DEFINITION_ID,
    source_agent_version_id: VERSION_ID,
    submitted_by_user_id: USER_ID,
    skill_name: "weekly-summary",
    dlp_contract_version: "experience-candidate-dlp-v1" as const,
    content_digest: VERSION_DIGEST,
    created_at: NOW.toISOString(),
    ...(reviewed
      ? {
          review: {
            id: REVIEW_ID,
            reviewed_by_user_id: USER_ID,
            decision: "REJECTED" as const,
            reason_code: "not_reusable",
            safe_note: "Needs a reusable template.",
            reviewed_at: NOW.toISOString(),
          },
        }
      : {}),
  };
}

function experienceDetail(reviewed = false): CloudExperienceCandidateDetail {
  return { ...experienceSummary(reviewed), bundle: experienceBundle() };
}

describe("AgenteraAgentControlClient", () => {
  it("uses only the product access bearer and validates exact response keys", async () => {
    const fetcher = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        jsonResponse({ definitions: [definition()] }),
    );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: fetcher as typeof fetch,
      now: () => NOW,
    });

    await expect(client.listDefinitions()).resolves.toEqual([definition()]);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:8086/api/v1/agent-definitions");
    expect(init?.headers).toMatchObject({
      accept: "application/json",
      authorization: "Bearer agentera-product-access",
    });
    expect(JSON.stringify(init?.headers)).not.toContain("cookie");

    fetcher.mockResolvedValueOnce(
      jsonResponse({ definitions: [{ ...definition(), owner_id: "private" }] }),
    );
    await expect(client.listDefinitions()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  // @lat: [[agentera-agent-control-plane#Trusted Workspace Agent context#Nested Workspace routes]]
  it("uses exact nested Workspace Agent paths and preserves stable authorization errors", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ definitions: [definition()] }))
      .mockResolvedValueOnce(jsonResponse(definition()))
      .mockResolvedValueOnce(jsonResponse({ versions: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "workspace_forbidden" } }, 403),
      );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: fetcher as typeof fetch,
      now: () => NOW,
    });

    await expect(
      client.listWorkspaceDefinitions(WORKSPACE_ID),
    ).resolves.toEqual([definition()]);
    await expect(
      client.getWorkspaceDefinition(WORKSPACE_ID, DEFINITION_ID),
    ).resolves.toEqual(definition());
    await expect(
      client.listWorkspaceVersions(WORKSPACE_ID, DEFINITION_ID),
    ).resolves.toEqual([]);
    await expect(
      client.listWorkspaceDefinitions(WORKSPACE_ID),
    ).rejects.toMatchObject({ status: 403, code: "workspace_forbidden" });

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `http://127.0.0.1:8086/api/v1/workspaces/${WORKSPACE_ID}/agent-definitions`,
      `http://127.0.0.1:8086/api/v1/workspaces/${WORKSPACE_ID}/agent-definitions/${DEFINITION_ID}`,
      `http://127.0.0.1:8086/api/v1/workspaces/${WORKSPACE_ID}/agent-definitions/${DEFINITION_ID}/versions`,
      `http://127.0.0.1:8086/api/v1/workspaces/${WORKSPACE_ID}/agent-definitions`,
    ]);
  });

  it("requires bounded idempotency keys on metadata mutations", async () => {
    const fetcher = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        jsonResponse(installation()),
    );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: fetcher as typeof fetch,
      now: () => NOW,
    });

    await client.archiveInstallation(INSTALLATION_ID, "archive-once");
    const [, init] = fetcher.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      "idempotency-key": "archive-once",
    });
    expect(init?.body).toBe("{}");

    await expect(
      client.archiveInstallation(INSTALLATION_ID, "bad\nkey"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fetches a policy snapshot through the strict AgentEra contract", async () => {
    const fetcher = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        jsonResponse(policySnapshot()),
    );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: fetcher as typeof fetch,
      now: () => NOW,
    });

    await expect(client.getPolicySnapshot(POLICY_ID)).resolves.toEqual(
      policySnapshot(),
    );
    expect(String(fetcher.mock.calls[0][0])).toBe(
      `http://127.0.0.1:8086/api/v1/policy-snapshots/${POLICY_ID}`,
    );

    fetcher.mockResolvedValueOnce(
      jsonResponse({ ...policySnapshot(), physical_profile_path: "/private" }),
    );
    await expect(client.getPolicySnapshot(POLICY_ID)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("applies one timeout and enforces declared and streamed response bounds", async () => {
    const timeoutFetch = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("secret transport detail")),
            { once: true },
          );
        }),
    );
    const timeoutClient = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: timeoutFetch as typeof fetch,
      timeoutMs: 5,
      now: () => NOW,
    });
    await expect(timeoutClient.listDefinitions()).rejects.toMatchObject({
      code: "request_timeout",
    });

    const oversizedClient = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: (async () =>
        new Response("{}", {
          headers: { "content-length": String(5 * 1024 * 1024) },
        })) as typeof fetch,
      now: () => NOW,
    });
    await expect(oversizedClient.listDefinitions()).rejects.toMatchObject({
      code: "response_too_large",
    });

    const streamedClient = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: (async () =>
        new Response("x".repeat(4 * 1024 * 1024 + 1))) as typeof fetch,
      now: () => NOW,
    });
    await expect(streamedClient.listDefinitions()).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("maps only stable server codes and never echoes response bodies", async () => {
    const secret = "server-secret-response-body";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "version_conflict", message: secret } },
          409,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: secret, message: secret } }, 500),
      );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: fetcher as typeof fetch,
      now: () => NOW,
    });

    const first = await client.listDefinitions().catch((error) => error);
    expect(first).toBeInstanceOf(AgenteraAgentControlClientError);
    expect(first).toMatchObject({ status: 409, code: "version_conflict" });
    expect(String(first)).not.toContain(secret);

    const second = await client.listDefinitions().catch((error) => error);
    expect(second).toMatchObject({ status: 500, code: "request_failed" });
    expect(String(second)).not.toContain(secret);
  });

  it("signs the exact activation domain with the existing device key", async () => {
    const identity = deviceIdentity();
    const fetcher = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        jsonResponse(installation()),
    );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => identity,
      fetch: fetcher as typeof fetch,
      now: () => NOW,
    });

    await client.activateInstallation(
      INSTALLATION_ID,
      PROFILE_ID,
      VERSION_DIGEST,
      "activate-once",
    );
    const [url, init] = fetcher.mock.calls[0];
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(String(url)).toContain(`/${INSTALLATION_ID}/activate`);
    expect(Object.keys(payload).sort()).toEqual([
      "device_proof",
      "runtime_profile_id",
      "timestamp",
      "version_digest",
    ]);
    expect(payload).toMatchObject({
      runtime_profile_id: PROFILE_ID,
      version_digest: VERSION_DIGEST,
      timestamp: Math.floor(NOW.getTime() / 1000),
    });
    expect(JSON.stringify(payload)).not.toContain(identity.devicePrivateKey);
    expect(JSON.stringify(payload)).not.toContain("profile_path");

    const publicKey = createPublicKey({
      key: Buffer.concat([
        SPKI_PREFIX,
        Buffer.from(identity.devicePublicKey, "base64url"),
      ]),
      format: "der",
      type: "spki",
    });
    const signed = Buffer.from(
      `agentera-agent-installation-activate-v1\0${INSTALLATION_ID}\0${PROFILE_ID}\0${VERSION_DIGEST}\0${Math.floor(NOW.getTime() / 1000)}`,
      "utf8",
    );
    expect(
      verifySignature(
        null,
        signed,
        publicKey,
        Buffer.from(String(payload.device_proof), "base64url"),
      ),
    ).toBe(true);
  });

  describe("ExperienceCandidate cloud contract", () => {
    it("uses exact nested routes, idempotency keys, and canonical snake-case bodies", async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(experienceDetail(), 201))
        .mockResolvedValueOnce(
          jsonResponse({ candidates: [experienceSummary()] }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ candidates: [experienceSummary()] }),
        )
        .mockResolvedValueOnce(jsonResponse(experienceDetail()))
        .mockResolvedValueOnce(jsonResponse(experienceDetail(true)));
      const client = new AgenteraAgentControlClient({
        origin: "http://127.0.0.1:8086",
        getAccessToken: () => "agentera-product-access",
        getInstallationIdentity: () => deviceIdentity(),
        fetch: fetcher as typeof fetch,
        now: () => NOW,
      });

      await expect(
        client.submitExperienceCandidate(
          WORKSPACE_ID,
          DEFINITION_ID,
          {
            source_version_id: VERSION_ID,
            bundle: experienceBundle(),
            content_digest: VERSION_DIGEST,
          },
          "candidate-submit-once",
        ),
      ).resolves.toEqual(experienceDetail());
      await expect(
        client.listOwnExperienceCandidates(WORKSPACE_ID),
      ).resolves.toEqual([experienceSummary()]);
      await expect(
        client.listWorkspaceExperienceCandidates(WORKSPACE_ID),
      ).resolves.toEqual([experienceSummary()]);
      await expect(
        client.getExperienceCandidate(WORKSPACE_ID, CANDIDATE_ID),
      ).resolves.toEqual(experienceDetail());
      await expect(
        client.reviewExperienceCandidate(
          WORKSPACE_ID,
          CANDIDATE_ID,
          {
            decision: "REJECTED",
            reason_code: "not_reusable",
            safe_note: "Needs a reusable template.",
          },
          "candidate-review-once",
        ),
      ).resolves.toEqual(experienceDetail(true));

      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
        `http://127.0.0.1:8086/api/v1/workspaces/${WORKSPACE_ID}/agent-definitions/${DEFINITION_ID}/experience-candidates`,
        `http://127.0.0.1:8086/api/v1/workspaces/${WORKSPACE_ID}/experience-candidates/mine`,
        `http://127.0.0.1:8086/api/v1/workspaces/${WORKSPACE_ID}/experience-candidates`,
        `http://127.0.0.1:8086/api/v1/workspaces/${WORKSPACE_ID}/experience-candidates/${CANDIDATE_ID}`,
        `http://127.0.0.1:8086/api/v1/workspaces/${WORKSPACE_ID}/experience-candidates/${CANDIDATE_ID}/review`,
      ]);
      const submit = fetcher.mock.calls[0][1];
      expect(submit?.headers).toMatchObject({
        "idempotency-key": "candidate-submit-once",
      });
      expect(JSON.parse(String(submit?.body))).toEqual({
        source_version_id: VERSION_ID,
        bundle: experienceBundle(),
        content_digest: VERSION_DIGEST,
      });
      expect(JSON.stringify(submit?.body)).not.toContain("sourceVersionId");
      const review = fetcher.mock.calls[4][1];
      expect(review?.headers).toMatchObject({
        "idempotency-key": "candidate-review-once",
      });
      expect(JSON.parse(String(review?.body))).toEqual({
        decision: "REJECTED",
        reason_code: "not_reusable",
        safe_note: "Needs a reusable template.",
      });
    });

    it("strictly rejects malformed ExperienceCandidate DTOs", async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            ...experienceDetail(),
            runtime_profile_path: "/private",
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            candidates: [
              {
                ...experienceSummary(),
                review: null,
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            ...experienceDetail(),
            bundle: {
              ...experienceBundle(),
              assets: [
                {
                  ...experienceBundle().assets[0],
                  path: "skills/another-skill/SKILL.md",
                },
              ],
            },
          }),
        );
      const client = new AgenteraAgentControlClient({
        origin: "http://127.0.0.1:8086",
        getAccessToken: () => "agentera-product-access",
        getInstallationIdentity: () => deviceIdentity(),
        fetch: fetcher as typeof fetch,
      });

      await expect(
        client.getExperienceCandidate(WORKSPACE_ID, CANDIDATE_ID),
      ).rejects.toMatchObject({ code: "invalid_response" });
      await expect(
        client.listOwnExperienceCandidates(WORKSPACE_ID),
      ).rejects.toMatchObject({ code: "invalid_response" });
      await expect(
        client.getExperienceCandidate(WORKSPACE_ID, CANDIDATE_ID),
      ).rejects.toMatchObject({ code: "invalid_response" });
    });

    it("parses DLP findings without retaining or echoing raw response evidence", async () => {
      const secret = "sk-proj-client-error-must-never-leak-123456789";
      const fetcher = vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: "candidate_dlp_blocked",
              message: secret,
              request_id: "request-1",
              findings: [
                {
                  code: "credential_api_key",
                  path: "skills/weekly-summary/SKILL.md",
                  line: 4,
                },
              ],
            },
          },
          400,
        ),
      );
      const client = new AgenteraAgentControlClient({
        origin: "http://127.0.0.1:8086",
        getAccessToken: () => "agentera-product-access",
        getInstallationIdentity: () => deviceIdentity(),
        fetch: fetcher as typeof fetch,
      });

      const error = await client
        .submitExperienceCandidate(
          WORKSPACE_ID,
          DEFINITION_ID,
          {
            source_version_id: VERSION_ID,
            bundle: experienceBundle(),
            content_digest: VERSION_DIGEST,
          },
          "candidate-submit-once",
        )
        .catch((failure) => failure);
      expect(error).toBeInstanceOf(AgenteraAgentControlClientError);
      expect(error).toMatchObject({
        status: 400,
        code: "candidate_dlp_blocked",
        findings: [
          {
            code: "credential_api_key",
            path: "skills/weekly-summary/SKILL.md",
            line: 4,
          },
        ],
      });
      expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(secret);
      expect(error).not.toHaveProperty("requestId");
      expect(error).not.toHaveProperty("body");
    });

    it.each([
      [409, "candidate_already_reviewed"],
      [403, "workspace_forbidden"],
      [404, "not_found"],
      [409, "workspace_archived"],
      [409, "workspace_owner_unavailable"],
      [503, "service_unavailable"],
    ])(
      "preserves stable ExperienceCandidate error %s/%s",
      async (status, code) => {
        const fetcher = vi.fn(async () =>
          jsonResponse(
            {
              error: {
                code,
                message: "localized by the client",
                request_id: "request-2",
              },
            },
            status,
          ),
        );
        const client = new AgenteraAgentControlClient({
          origin: "http://127.0.0.1:8086",
          getAccessToken: () => "agentera-product-access",
          getInstallationIdentity: () => deviceIdentity(),
          fetch: fetcher as typeof fetch,
        });
        await expect(
          client.getExperienceCandidate(WORKSPACE_ID, CANDIDATE_ID),
        ).rejects.toMatchObject({ status, code });
      },
    );
  });

  it("is structurally separate from Hermes One Agent sync", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const source = readFileSync(
      resolve(root, "src/main/agentera-agent-control/client.ts"),
      "utf8",
    ).toLowerCase();
    for (const forbidden of [
      "agent-sync",
      '"/api/agents"',
      "hermes one",
      "linkedagentid",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
