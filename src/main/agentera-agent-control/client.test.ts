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
} from "./client";

const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const PROFILE_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_ID = "55555555-5555-4555-8555-555555555555";
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
