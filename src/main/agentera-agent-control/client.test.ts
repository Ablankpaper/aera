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
import type { components } from "../../shared/agentera-cloud-api.generated";
import type { InstallationIdentity } from "../agentera-auth/store";
import { canonicalizeExperienceCandidate } from "./experience-candidate-contract";
import {
  AgenteraAgentControlClient,
  AgenteraAgentControlClientError,
  type AgentDefinition,
  type AgentInstallation,
  type AgentPolicySnapshot,
  type AgentVersion,
  type CloudExperienceCandidateBundle,
  type CloudExperienceCandidateDetail,
  type CloudExperienceCandidateSummary,
  type CloudOrganizationExperienceCandidateDetail,
  type CloudOrganizationExperienceCandidateSummary,
  type OrganizationAgentSubmissionDetailRecord,
  type OrganizationAgentSubmissionRecord,
  type SubmitOrganizationAgentRequest,
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
const ORGANIZATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUBMISSION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORGANIZATION_POLICY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RELEASE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const RELEASE_REVISION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const TARGET_RELEASE_REVISION_ID = "12121212-1212-4212-8212-121212121212";
const TARGET_VERSION_ID = "13131313-1313-4313-8313-131313131313";
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

function officialSummary(): components["schemas"]["OfficialAgentSummary"] {
  return {
    definition_id: DEFINITION_ID,
    display_name: "Official Research Agent",
    official: true as const,
    version_id: VERSION_ID,
    version_number: 1,
    release_id: RELEASE_ID,
    release_revision_id: RELEASE_REVISION_ID,
    channel: "internal" as const,
    runtime_minimum_version: "v0.18.2-agentera.1",
    installation_state: "not_installed" as const,
    update_state: "current" as const,
  };
}

function agentVersion(): AgentVersion {
  return {
    id: VERSION_ID,
    definition_id: DEFINITION_ID,
    version_number: 1,
    manifest: {
      schema_version: 1,
      identity: { system_prompt: "Official research only." },
      assets: [],
      model_constraints: {
        allowed_providers: ["openai"],
        allowed_models: ["gpt-5.6"],
      },
      tools: { allowed: [], denied: [] },
      dependencies: [],
      runtime_compatibility: {
        minimum_version: "v0.18.2-agentera.1",
        maximum_version_exclusive: null,
      },
    },
    bundle: { assets: [] },
    content_digest: VERSION_DIGEST,
    signing_key_id: "official-agent-version-v1",
    signature: "A".repeat(86),
    runtime_minimum_version: "v0.18.2-agentera.1",
    published_at: NOW.toISOString(),
  };
}

function agentVersionV2(): AgentVersion {
  return {
    ...agentVersion(),
    manifest: {
      schema_version: 2,
      identity: { system_prompt: "Select the local runtime model." },
      assets: [],
      model_policy: {
        mode: "user_select",
        allowed_providers: [],
        allowed_models: [],
      },
      tools: { allowed: [], denied: [] },
      dependencies: [],
      runtime_compatibility: {
        minimum_version: "v0.18.2-agentera.1",
        maximum_version_exclusive: null,
      },
    },
  };
}

function managedInstallation(): AgentInstallation {
  return {
    ...installation(),
    selected_version_id: TARGET_VERSION_ID,
    official_release_id: RELEASE_ID,
    selected_release_revision_id: TARGET_RELEASE_REVISION_ID,
    update_policy: "managed",
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

function policySnapshotV2(): AgentPolicySnapshot {
  return {
    ...policySnapshot(),
    document: {
      schema_version: 2,
      agent_definition_id: DEFINITION_ID,
      agent_version_id: VERSION_ID,
      version_digest: VERSION_DIGEST,
      model_policy: {
        mode: "user_select",
        allowed_providers: [],
        allowed_models: [],
      },
      runtime_compatibility: {
        minimum_version: "v0.18.2-agentera.1",
        maximum_version_exclusive: "v0.19.0",
      },
      tools: { allowed: ["files.read"], denied: [] },
      deny_rules: [],
      publication_allowed: false,
    },
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

function organizationExperienceSummary(
  reviewed = false,
): CloudOrganizationExperienceCandidateSummary {
  const { workspace_id: _workspaceId, ...summary } =
    experienceSummary(reviewed);
  return {
    ...summary,
    organization_id: ORGANIZATION_ID,
    content_digest: canonicalizeExperienceCandidate({
      schemaVersion: 1,
      skillName: "weekly-summary",
      assets: [
        {
          path: "skills/weekly-summary/SKILL.md",
          mediaType: "text/markdown",
          content: "# Weekly summary\n",
        },
      ],
    }).contentDigest,
  };
}

function organizationExperienceDetail(
  reviewed = false,
): CloudOrganizationExperienceCandidateDetail {
  return {
    ...organizationExperienceSummary(reviewed),
    bundle: experienceBundle(),
  };
}

function organizationAgentPackage(): Pick<
  Extract<SubmitOrganizationAgentRequest, { kind: "initial" }>,
  "manifest" | "bundle"
> {
  return {
    manifest: {
      schema_version: 1 as const,
      identity: { system_prompt: "Research with care." },
      assets: [
        {
          path: "knowledge/notes.md",
          kind: "knowledge" as const,
          media_type: "text/markdown" as const,
          sha256: "12".repeat(32),
        },
      ],
      model_constraints: {
        allowed_providers: ["openai"],
        allowed_models: ["gpt-5.6"],
      },
      tools: { allowed: ["files.read"], denied: [] },
      dependencies: [],
      runtime_compatibility: {
        minimum_version: "v0.18.2-agentera.1",
        maximum_version_exclusive: null,
      },
    },
    bundle: {
      assets: [{ path: "knowledge/notes.md", content: "# Notes\n" }],
    },
  };
}

function organizationSubmissionDetail(
  reviewed = false,
): OrganizationAgentSubmissionDetailRecord {
  const pkg = organizationAgentPackage();
  return {
    id: SUBMISSION_ID,
    organization_id: ORGANIZATION_ID,
    kind: "initial" as const,
    definition_id: DEFINITION_ID,
    base_version_id: null,
    published_version_id: reviewed ? VERSION_ID : null,
    submitted_by_user_id: USER_ID,
    content_digest: VERSION_DIGEST,
    status: reviewed ? ("approved" as const) : ("pending" as const),
    revision: reviewed ? 2 : 1,
    submitted_at: NOW.toISOString(),
    terminal_at: reviewed ? NOW.toISOString() : null,
    updated_at: NOW.toISOString(),
    review: reviewed
      ? {
          id: REVIEW_ID,
          reviewer_user_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          decision: "approve" as const,
          reason_code: null,
          safe_note: null,
          organization_policy_snapshot_id: ORGANIZATION_POLICY_ID,
          organization_policy_version: 3,
          reviewed_content_digest: VERSION_DIGEST,
          reviewed_at: NOW.toISOString(),
        }
      : null,
    display_name: "Organization Research Agent",
    ...pkg,
    manifest_digest: "cd".repeat(32),
    bundle_digest: "ef".repeat(32),
  };
}

function organizationSubmissionSummary(
  reviewed = false,
): OrganizationAgentSubmissionRecord {
  const detail = organizationSubmissionDetail(reviewed);
  return {
    id: detail.id,
    organization_id: detail.organization_id,
    kind: detail.kind,
    definition_id: detail.definition_id,
    base_version_id: detail.base_version_id,
    published_version_id: detail.published_version_id,
    submitted_by_user_id: detail.submitted_by_user_id,
    content_digest: detail.content_digest,
    status: detail.status,
    revision: detail.revision,
    submitted_at: detail.submitted_at,
    terminal_at: detail.terminal_at,
    updated_at: detail.updated_at,
    review: detail.review,
  };
}

describe("AgenteraAgentControlClient", () => {
  it("accepts Organization policy keys without loading them as Agent control keys", async () => {
    const publicKey = Buffer.alloc(32, 7).toString("base64url");
    const keySet = {
      keys: [
        {
          kid: "agent-control-v1",
          kty: "OKP" as const,
          crv: "Ed25519" as const,
          alg: "EdDSA" as const,
          use: "sig" as const,
          purpose: "agent_version" as const,
          x: publicKey,
        },
        {
          kid: "organization-policy-v1",
          kty: "OKP" as const,
          crv: "Ed25519" as const,
          alg: "EdDSA" as const,
          use: "sig" as const,
          purpose: "organization_policy" as const,
          x: publicKey,
        },
      ],
    };
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: vi.fn(async () => jsonResponse(keySet)) as typeof fetch,
    });

    await expect(client.getSigningKeys()).resolves.toEqual(keySet);
  });

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

  it("uses exact Organization Agent paths and rejects extra response fields", async () => {
    const fetcher = vi.fn(
      async (_url: URL | RequestInfo, _init?: RequestInit) =>
        jsonResponse(
          {
            ...organizationSubmissionDetail(),
            access_token: "must-not-cross",
          },
          201,
        ),
    );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: fetcher as typeof fetch,
      now: () => NOW,
    });
    const pkg = organizationAgentPackage();

    await expect(
      client.submitOrganizationAgent(
        ORGANIZATION_ID,
        {
          kind: "initial",
          display_name: "Organization Research Agent",
          ...pkg,
        },
        "organization-submission-once",
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1:8086/api/v1/organizations/${ORGANIZATION_ID}/agent-publication-submissions`,
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      kind: "initial",
      display_name: "Organization Research Agent",
      ...pkg,
    });
  });

  it("requires an immutable Version only for approved Organization submissions", async () => {
    const approvedWithoutVersion = {
      ...organizationSubmissionSummary(true),
      published_version_id: null,
    };
    const pendingWithVersion = {
      ...organizationSubmissionSummary(),
      published_version_id: VERSION_ID,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ submissions: [approvedWithoutVersion] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ submissions: [pendingWithVersion] }),
      );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: fetcher as typeof fetch,
      now: () => NOW,
    });

    await expect(
      client.listOrganizationAgentSubmissions(ORGANIZATION_ID),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      client.listOrganizationAgentSubmissions(ORGANIZATION_ID),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("validates canonical Organization identifiers before dispatch", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ definitions: [definition()] }),
    );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: fetcher as typeof fetch,
    });

    await expect(
      client.listOrganizationDefinitions(ORGANIZATION_ID.toUpperCase()),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses every Organization discovery and approval route with exact revisions", async () => {
    const withdrawn = {
      ...organizationSubmissionDetail(),
      status: "withdrawn" as const,
      revision: 2,
      terminal_at: NOW.toISOString(),
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ definitions: [definition()] }))
      .mockResolvedValueOnce(jsonResponse(definition()))
      .mockResolvedValueOnce(jsonResponse({ versions: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ submissions: [organizationSubmissionSummary()] }),
      )
      .mockResolvedValueOnce(jsonResponse(organizationSubmissionDetail()))
      .mockResolvedValueOnce(jsonResponse(withdrawn))
      .mockResolvedValueOnce(jsonResponse(organizationSubmissionDetail(true)));
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: fetcher as typeof fetch,
      now: () => NOW,
    });

    await expect(
      client.listOrganizationDefinitions(ORGANIZATION_ID),
    ).resolves.toEqual([definition()]);
    await expect(
      client.getOrganizationDefinition(ORGANIZATION_ID, DEFINITION_ID),
    ).resolves.toEqual(definition());
    await expect(
      client.listOrganizationVersions(ORGANIZATION_ID, DEFINITION_ID),
    ).resolves.toEqual([]);
    await expect(
      client.listOrganizationAgentSubmissions(ORGANIZATION_ID),
    ).resolves.toEqual([organizationSubmissionSummary()]);
    await expect(
      client.getOrganizationAgentSubmission(ORGANIZATION_ID, SUBMISSION_ID),
    ).resolves.toEqual(organizationSubmissionDetail());
    await expect(
      client.withdrawOrganizationAgentSubmission(
        ORGANIZATION_ID,
        SUBMISSION_ID,
        1,
        "withdraw-once",
      ),
    ).resolves.toEqual(withdrawn);
    await expect(
      client.reviewOrganizationAgentSubmission(
        ORGANIZATION_ID,
        SUBMISSION_ID,
        { expected_revision: 1, decision: "approve" },
        "review-once",
      ),
    ).resolves.toEqual(organizationSubmissionDetail(true));

    const root = `http://127.0.0.1:8086/api/v1/organizations/${ORGANIZATION_ID}`;
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${root}/agent-definitions`,
      `${root}/agent-definitions/${DEFINITION_ID}`,
      `${root}/agent-definitions/${DEFINITION_ID}/versions`,
      `${root}/agent-publication-submissions`,
      `${root}/agent-publication-submissions/${SUBMISSION_ID}`,
      `${root}/agent-publication-submissions/${SUBMISSION_ID}/withdraw`,
      `${root}/agent-publication-submissions/${SUBMISSION_ID}/reviews`,
    ]);
    expect(fetcher.mock.calls[5]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "idempotency-key": "withdraw-once" }),
    });
    expect(JSON.parse(String(fetcher.mock.calls[5]?.[1]?.body))).toEqual({
      expected_revision: 1,
    });
    expect(fetcher.mock.calls[6]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "idempotency-key": "review-once" }),
    });
    expect(JSON.parse(String(fetcher.mock.calls[6]?.[1]?.body))).toEqual({
      expected_revision: 1,
      decision: "approve",
    });
  });

  it("preserves the committed Organization superseded error contract", async () => {
    const superseded = {
      ...organizationSubmissionSummary(),
      status: "superseded" as const,
      revision: 2,
      terminal_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    const fetcher = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "organization_submission_superseded",
            message: "localized by the client",
            request_id: "organization-review-request",
          },
          submission: superseded,
        },
        409,
      ),
    );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: fetcher as typeof fetch,
    });

    await expect(
      client.reviewOrganizationAgentSubmission(
        ORGANIZATION_ID,
        SUBMISSION_ID,
        { expected_revision: 1, decision: "approve" },
        "superseded-review-once",
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "organization_submission_superseded",
    });
  });

  it("retains only bounded Organization publication DLP findings", async () => {
    const secret = "sk-proj-organization-client-secret-must-not-leak";
    const fetcher = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "organization_publication_dlp_blocked",
            message: secret,
            request_id: "organization-request",
            findings: [
              {
                code: "credential_api_key",
                path: "knowledge/notes.md",
                line: 2,
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
    const pkg = organizationAgentPackage();

    const error = await client
      .submitOrganizationAgent(
        ORGANIZATION_ID,
        {
          kind: "initial",
          display_name: "Organization Research Agent",
          ...pkg,
        },
        "organization-dlp-once",
      )
      .catch((failure) => failure);
    expect(error).toMatchObject({
      status: 400,
      code: "organization_publication_dlp_blocked",
      findings: [
        {
          code: "credential_api_key",
          path: "knowledge/notes.md",
          line: 2,
        },
      ],
    });
    expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(secret);
    expect(error.findings[0]).not.toHaveProperty("evidence");
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

  it("fetches a policy snapshot through the strict Aera contract", async () => {
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

  it("accepts strict V2 user_select version and policy responses", async () => {
    const responses = [agentVersionV2(), policySnapshotV2()];
    const fetcher = vi.fn(async () => jsonResponse(responses.shift()));
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      fetch: fetcher as typeof fetch,
      now: () => NOW,
    });

    await expect(client.getVersion(VERSION_ID)).resolves.toEqual(
      agentVersionV2(),
    );
    await expect(client.getPolicySnapshot(POLICY_ID)).resolves.toEqual(
      policySnapshotV2(),
    );
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

  describe("Organization ExperienceCandidate cloud contract", () => {
    it("uses the five exact Organization routes and strict canonical bodies", async () => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(organizationExperienceDetail(), 201),
        )
        .mockResolvedValueOnce(
          jsonResponse({ candidates: [organizationExperienceSummary()] }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ candidates: [organizationExperienceSummary()] }),
        )
        .mockResolvedValueOnce(jsonResponse(organizationExperienceDetail()))
        .mockResolvedValueOnce(
          jsonResponse(organizationExperienceDetail(true)),
        );
      const client = new AgenteraAgentControlClient({
        origin: "http://127.0.0.1:8086",
        getAccessToken: () => "agentera-product-access",
        getInstallationIdentity: () => deviceIdentity(),
        fetch: fetcher as typeof fetch,
      });
      const submitBody = {
        source_version_id: VERSION_ID,
        skill_name: "weekly-summary",
        schema_version: 1 as const,
        dlp_contract_version: "experience-candidate-dlp-v1" as const,
        bundle: experienceBundle(),
      };

      await expect(
        client.submitOrganizationExperienceCandidate(
          ORGANIZATION_ID,
          DEFINITION_ID,
          submitBody,
          "organization-candidate-submit-once",
        ),
      ).resolves.toEqual(organizationExperienceDetail());
      await expect(
        client.listOwnOrganizationExperienceCandidates(ORGANIZATION_ID),
      ).resolves.toEqual([organizationExperienceSummary()]);
      await expect(
        client.listOrganizationExperienceCandidates(ORGANIZATION_ID),
      ).resolves.toEqual([organizationExperienceSummary()]);
      await expect(
        client.getOrganizationExperienceCandidate(
          ORGANIZATION_ID,
          CANDIDATE_ID,
        ),
      ).resolves.toEqual(organizationExperienceDetail());
      await expect(
        client.reviewOrganizationExperienceCandidate(
          ORGANIZATION_ID,
          CANDIDATE_ID,
          {
            decision: "REJECTED",
            reason_code: "not_reusable",
            safe_note: "Needs a reusable template.",
          },
          "organization-candidate-review-once",
        ),
      ).resolves.toEqual(organizationExperienceDetail(true));

      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
        `http://127.0.0.1:8086/api/v1/organizations/${ORGANIZATION_ID}/agent-definitions/${DEFINITION_ID}/experience-candidates`,
        `http://127.0.0.1:8086/api/v1/organizations/${ORGANIZATION_ID}/experience-candidates/mine`,
        `http://127.0.0.1:8086/api/v1/organizations/${ORGANIZATION_ID}/experience-candidates`,
        `http://127.0.0.1:8086/api/v1/organizations/${ORGANIZATION_ID}/experience-candidates/${CANDIDATE_ID}`,
        `http://127.0.0.1:8086/api/v1/organizations/${ORGANIZATION_ID}/experience-candidates/${CANDIDATE_ID}/review`,
      ]);
      expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
        "idempotency-key": "organization-candidate-submit-once",
      });
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(
        submitBody,
      );
      expect(JSON.stringify(fetcher.mock.calls[0][1]?.body)).not.toMatch(
        /workspace|profile|token|memory|user\.md/i,
      );
    });

    it("fails closed on cross-Organization, candidate, digest, and review mismatches", async () => {
      const otherOrganizationId = "14141414-1414-4414-8414-141414141414";
      const otherCandidateId = "15151515-1515-4515-8515-151515151515";
      const mismatches = [
        {
          ...organizationExperienceDetail(),
          organization_id: otherOrganizationId,
        },
        { ...organizationExperienceDetail(), id: otherCandidateId },
        { ...organizationExperienceDetail(), content_digest: "cd".repeat(32) },
        {
          ...organizationExperienceDetail(true),
          review: {
            ...organizationExperienceDetail(true).review!,
            decision: "APPROVED" as const,
            reason_code: "unexpected",
          },
        },
      ];
      for (const response of mismatches) {
        const client = new AgenteraAgentControlClient({
          origin: "http://127.0.0.1:8086",
          getAccessToken: () => "agentera-product-access",
          getInstallationIdentity: () => deviceIdentity(),
          fetch: vi.fn(async () => jsonResponse(response)) as typeof fetch,
        });
        await expect(
          client.getOrganizationExperienceCandidate(
            ORGANIZATION_ID,
            CANDIDATE_ID,
          ),
        ).rejects.toMatchObject({ code: "invalid_response" });
      }
    });
  });

  it("uses only trusted main-process headers for the official catalog", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ official_agents: [officialSummary()] }),
    );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      officialAgentChannel: "internal",
      desktopVersion: "0.7.3",
      getAgentContext: () => ({ scope: "USER" }),
      fetch: fetcher as typeof fetch,
    });

    await expect(client.listOfficialAgents()).resolves.toEqual([
      {
        definitionId: DEFINITION_ID,
        displayName: "Official Research Agent",
        iconMediaType: null,
        iconDataBase64Url: null,
        versionId: VERSION_ID,
        versionNumber: 1,
        releaseId: RELEASE_ID,
        releaseRevisionId: RELEASE_REVISION_ID,
        channel: "internal",
        runtimeMinimumVersion: "v0.18.2-agentera.1",
        runtimeMaximumVersionExclusive: null,
        installationState: "not_installed",
        updateState: "current",
      },
    ]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = new Headers(init?.headers);
    expect(String(url)).toBe("http://127.0.0.1:8086/api/v1/official-agents");
    expect(headers.get("x-agentera-official-channel")).toBe("internal");
    expect(headers.get("x-agentera-desktop-version")).toBe("0.7.3");
    expect(headers.get("x-agentera-product-context")).toBe("USER");
    expect(headers.has("x-agentera-product-context-id")).toBe(false);
  });

  it("binds official requests to the selected shared context and rejects private response fields", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ official_agents: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          official_agents: [
            { ...officialSummary(), platform_id: "must-not-cross" },
          ],
        }),
      );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      officialAgentChannel: "stable",
      desktopVersion: "v0.7.3",
      getAgentContext: () => ({
        scope: "WORKSPACE",
        workspaceId: WORKSPACE_ID,
        role: "member",
      }),
      fetch: fetcher as typeof fetch,
    });

    await expect(client.listOfficialAgents()).resolves.toEqual([]);
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-agentera-product-context")).toBe("WORKSPACE");
    expect(headers.get("x-agentera-product-context-id")).toBe(WORKSPACE_ID);
    await expect(client.listOfficialAgents()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("parses exact official detail, release, managed target, and apply responses", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ agent: officialSummary(), version: agentVersion() }),
      )
      .mockResolvedValueOnce(jsonResponse(officialSummary()))
      .mockResolvedValueOnce(
        jsonResponse({
          update_available: true,
          installation_id: INSTALLATION_ID,
          expected_selected_release_revision_id: RELEASE_REVISION_ID,
          target_release_revision_id: TARGET_RELEASE_REVISION_ID,
          target_version_id: TARGET_VERSION_ID,
          runtime_minimum_version: "v0.18.2-agentera.1",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(managedInstallation()));
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      officialAgentChannel: "internal",
      desktopVersion: "0.7.3",
      getAgentContext: () => ({ scope: "USER" }),
      fetch: fetcher as typeof fetch,
    });

    await expect(client.getOfficialAgent(DEFINITION_ID)).resolves.toEqual({
      agent: expect.objectContaining({ definitionId: DEFINITION_ID }),
      version: agentVersion(),
    });
    await expect(client.getOfficialRelease(DEFINITION_ID)).resolves.toEqual(
      expect.objectContaining({ releaseRevisionId: RELEASE_REVISION_ID }),
    );
    await expect(client.getManagedUpdate(INSTALLATION_ID)).resolves.toEqual({
      installationId: INSTALLATION_ID,
      expectedSelectedReleaseRevisionId: RELEASE_REVISION_ID,
      targetReleaseRevisionId: TARGET_RELEASE_REVISION_ID,
      targetVersionId: TARGET_VERSION_ID,
    });
    await expect(
      client.applyManagedUpdate(
        INSTALLATION_ID,
        RELEASE_REVISION_ID,
        TARGET_RELEASE_REVISION_ID,
        "official-managed-update-once",
      ),
    ).resolves.toEqual(managedInstallation());
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({
      expected_selected_release_revision_id: RELEASE_REVISION_ID,
      target_release_revision_id: TARGET_RELEASE_REVISION_ID,
    });
  });

  it("adds official headers only for the strict official Installation source", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "official_agent_not_eligible",
            message: "localized by the client",
            request_id: PROFILE_ID,
          },
        },
        403,
      ),
    );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      officialAgentChannel: "stable",
      desktopVersion: "0.7.3",
      getAgentContext: () => ({ scope: "USER" }),
      fetch: fetcher as typeof fetch,
    });

    await expect(
      client.createInstallation(
        {
          definition_id: DEFINITION_ID,
          official_release_revision_id: RELEASE_REVISION_ID,
        },
        "official-install-once",
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "official_agent_not_eligible",
    });
    expect(
      new Headers(
        (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers,
      ).get("x-agentera-official-channel"),
    ).toBe("stable");

    await expect(
      client.createInstallation(
        {
          definition_id: DEFINITION_ID,
          official_release_revision_id: RELEASE_REVISION_ID,
          version_id: VERSION_ID,
        } as never,
        "official-install-mixed",
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts the platform UUIDv7 in a strict official policy response", async () => {
    const createdInstallation: AgentInstallation = {
      id: INSTALLATION_ID,
      definition_id: DEFINITION_ID,
      selected_version_id: VERSION_ID,
      policy_snapshot_id: POLICY_ID,
      official_release_id: RELEASE_ID,
      selected_release_revision_id: RELEASE_REVISION_ID,
      update_policy: "managed",
      status: "pending",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    const policy: AgentPolicySnapshot = {
      ...policySnapshot(),
      document: {
        ...policySnapshot().document,
        official_context: {
          platform_id: "019f0000-0000-7000-8000-000000000999",
          release_id: RELEASE_ID,
          release_revision_id: RELEASE_REVISION_ID,
          user_id: USER_ID,
          device_installation_id: deviceIdentity().installationId,
          installation_id: INSTALLATION_ID,
          product_scope: "USER",
          product_context_id: USER_ID,
        },
      },
    };
    const fetcher = vi.fn(async () =>
      jsonResponse(
        {
          installation: createdInstallation,
          policy_snapshot: policy,
          replayed: false,
        },
        201,
      ),
    );
    const client = new AgenteraAgentControlClient({
      origin: "http://127.0.0.1:8086",
      getAccessToken: () => "agentera-product-access",
      getInstallationIdentity: () => deviceIdentity(),
      officialAgentChannel: "internal",
      desktopVersion: "0.7.3",
      getAgentContext: () => ({ scope: "USER" }),
      fetch: fetcher as typeof fetch,
    });

    await expect(
      client.createInstallation(
        {
          definition_id: DEFINITION_ID,
          official_release_revision_id: RELEASE_REVISION_ID,
        },
        "official-install-uuidv7",
      ),
    ).resolves.toEqual({
      installation: createdInstallation,
      policy_snapshot: policy,
      replayed: false,
    });
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
