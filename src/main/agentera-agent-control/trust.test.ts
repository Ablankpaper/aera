// @vitest-environment node

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { components } from "../../shared/agentera-cloud-api.generated";
import { AgenteraAgentTrustError, AgenteraAgentTrustStore } from "./trust";

type AgentVersion = components["schemas"]["AgentVersion"];
type AgentPolicySnapshot = components["schemas"]["AgentPolicySnapshot"];
type SigningKeySet = components["schemas"]["SigningKeySet"];

interface TrustFixture {
  keys: SigningKeySet;
  version: AgentVersion;
  policy: AgentPolicySnapshot;
  officialPolicy: AgentPolicySnapshot;
}

const ORIGIN = "http://127.0.0.1:8086";
const OTHER_ORIGIN = "http://127.0.0.1:8087";
const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const INSTALLATION_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_ID = "44444444-4444-4444-8444-444444444444";
const OFFICIAL_POLICY_ID = "55555555-5555-4555-8555-555555555555";
const KEY_ID = "agent-control-test-v1";
const FETCHED_AT = "2026-07-19T16:00:00.000Z";
const SPKI_PREFIX_LENGTH = 12;

function fixture(schemaVersion: 1 | 2 = 1): TrustFixture {
  const pair = generateKeyPairSync("ed25519");
  const publicDer = Buffer.from(
    pair.publicKey.export({ format: "der", type: "spki" }),
  );
  const publicKey = publicDer
    .subarray(SPKI_PREFIX_LENGTH)
    .toString("base64url");
  const keys: SigningKeySet = {
    keys: [
      {
        kid: KEY_ID,
        kty: "OKP",
        crv: "Ed25519",
        alg: "EdDSA",
        use: "sig",
        purpose: "agent_version",
        x: publicKey,
      },
      {
        kid: KEY_ID,
        kty: "OKP",
        crv: "Ed25519",
        alg: "EdDSA",
        use: "sig",
        purpose: "agent_policy",
        x: publicKey,
      },
    ],
  };
  const manifest: AgentVersion["manifest"] =
    schemaVersion === 1
      ? {
          assets: [],
          dependencies: [],
          identity: { system_prompt: "Research safely" },
          model_constraints: {
            allowed_models: ["gpt-5.6"],
            allowed_providers: ["openai"],
          },
          runtime_compatibility: {
            maximum_version_exclusive: "v0.19.0",
            minimum_version: "v0.18.2-agentera.1",
          },
          schema_version: 1,
          tools: { allowed: ["files.read"], denied: [] },
        }
      : {
          assets: [],
          dependencies: [],
          identity: { system_prompt: "Research safely" },
          model_policy: {
            allowed_models: [],
            allowed_providers: [],
            mode: "user_select",
          },
          runtime_compatibility: {
            maximum_version_exclusive: "v0.19.0",
            minimum_version: "v0.18.2-agentera.1",
          },
          schema_version: 2,
          tools: { allowed: ["files.read"], denied: [] },
        };
  const bundle = { assets: [] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const bundleBytes = Buffer.from(JSON.stringify(bundle));
  const manifestDigest = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  const bundleDigest = createHash("sha256").update(bundleBytes).digest("hex");
  const contentDigest = createHash("sha256")
    .update(manifestBytes)
    .update(Buffer.from([0]))
    .update(bundleBytes)
    .digest("hex");
  const versionPayload = Buffer.from(
    `agentera-agent-version-v1\u0000${DEFINITION_ID}\u0000${VERSION_ID}\u00001\u0000${manifestDigest}\u0000${bundleDigest}`,
  );
  const version: AgentVersion = {
    id: VERSION_ID,
    definition_id: DEFINITION_ID,
    version_number: 1,
    manifest,
    bundle,
    content_digest: contentDigest,
    signing_key_id: KEY_ID,
    signature: sign(null, versionPayload, pair.privateKey).toString(
      "base64url",
    ),
    runtime_minimum_version: "v0.18.2-agentera.1",
    runtime_maximum_version_exclusive: "v0.19.0",
    published_at: FETCHED_AT,
  };
  const document: AgentPolicySnapshot["document"] =
    manifest.schema_version === 1
      ? {
          schema_version: 1,
          agent_definition_id: DEFINITION_ID,
          agent_version_id: VERSION_ID,
          version_digest: contentDigest,
          model_constraints: manifest.model_constraints,
          tools: manifest.tools,
          runtime_compatibility: manifest.runtime_compatibility,
          publication_allowed: false,
          deny_rules: [],
        }
      : {
          schema_version: 2,
          agent_definition_id: DEFINITION_ID,
          agent_version_id: VERSION_ID,
          version_digest: contentDigest,
          model_policy: manifest.model_policy,
          tools: manifest.tools,
          runtime_compatibility: manifest.runtime_compatibility,
          publication_allowed: false,
          deny_rules: [],
        };
  const documentDigest = createHash("sha256")
    .update(JSON.stringify(document))
    .digest("hex");
  const policyPayload = Buffer.from(
    `agentera-agent-policy-v1\u0000${POLICY_ID}\u00001\u0000${documentDigest}`,
  );
  const policy: AgentPolicySnapshot = {
    id: POLICY_ID,
    installation_id: INSTALLATION_ID,
    agent_version_id: VERSION_ID,
    policy_version: 1,
    document,
    content_digest: documentDigest,
    issuer: ORIGIN,
    signing_key_id: KEY_ID,
    signature: sign(null, policyPayload, pair.privateKey).toString("base64url"),
    created_at: FETCHED_AT,
  };
  const officialDocument: AgentPolicySnapshot["document"] = {
    ...document,
    official_context: {
      platform_id: "019f0000-0000-7000-8000-000000000999",
      release_id: "66666666-6666-4666-8666-666666666666",
      release_revision_id: "77777777-7777-4777-8777-777777777777",
      user_id: "88888888-8888-4888-8888-888888888888",
      device_installation_id: "99999999-9999-4999-8999-999999999999",
      installation_id: INSTALLATION_ID,
      product_scope: "USER",
      product_context_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
  };
  const officialDocumentDigest = createHash("sha256")
    .update(JSON.stringify(officialDocument))
    .digest("hex");
  const officialPolicyPayload = Buffer.from(
    `agentera-agent-policy-v1\u0000${OFFICIAL_POLICY_ID}\u00001\u0000${officialDocumentDigest}`,
  );
  const officialPolicy: AgentPolicySnapshot = {
    ...policy,
    id: OFFICIAL_POLICY_ID,
    document: officialDocument,
    content_digest: officialDocumentDigest,
    signature: sign(null, officialPolicyPayload, pair.privateKey).toString(
      "base64url",
    ),
  };
  return { keys, version, policy, officialPolicy };
}

function expectTrustCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("operation unexpectedly succeeded");
  } catch (error) {
    expect(error).toBeInstanceOf(AgenteraAgentTrustError);
    expect(error).toMatchObject({ code });
  }
}

describe("AgenteraAgentTrustStore", () => {
  it("verifies issuer-scoped version and policy signatures and digests", () => {
    const { keys, version, policy } = fixture();
    const trust = new AgenteraAgentTrustStore();
    trust.replaceKeys(ORIGIN, keys, FETCHED_AT);

    expect(
      trust.verifyVersion(version, {
        issuer: ORIGIN,
        runtimeVersion: "v0.18.2-agentera.1",
      }),
    ).toEqual({ contentDigest: version.content_digest });
    expect(trust.verifyPolicy(policy, { runtimeVersion: "v0.18.9" })).toEqual({
      contentDigest: policy.content_digest,
    });
  });

  it("verifies V2 user_select version and policy bytes without a model route", () => {
    const { keys, version, policy } = fixture(2);
    const trust = new AgenteraAgentTrustStore();
    trust.replaceKeys(ORIGIN, keys, FETCHED_AT);

    expect(
      trust.verifyVersion(version, {
        issuer: ORIGIN,
        runtimeVersion: "v0.18.2-agentera.1",
      }),
    ).toEqual({ contentDigest: version.content_digest });
    expect(trust.verifyPolicy(policy, { runtimeVersion: "v0.18.9" })).toEqual({
      contentDigest: policy.content_digest,
    });
  });

  it("verifies a signed official policy with a canonical UUIDv7 platform context", () => {
    const { keys, officialPolicy } = fixture();
    const trust = new AgenteraAgentTrustStore();
    trust.replaceKeys(ORIGIN, keys, FETCHED_AT);

    expect(
      trust.verifyPolicy(officialPolicy, {
        runtimeVersion: "v0.18.9",
      }),
    ).toEqual({ contentDigest: officialPolicy.content_digest });
  });

  it("fails closed across issuer, purpose, key id, digest, and signature", () => {
    const { keys, version } = fixture();

    const issuerTrust = new AgenteraAgentTrustStore();
    issuerTrust.replaceKeys(ORIGIN, keys, FETCHED_AT);
    expectTrustCode(
      () =>
        issuerTrust.verifyVersion(version, {
          issuer: OTHER_ORIGIN,
          runtimeVersion: "v0.18.9",
        }),
      "issuer_mismatch",
    );

    const purposeTrust = new AgenteraAgentTrustStore();
    purposeTrust.replaceKeys(
      ORIGIN,
      { keys: keys.keys.filter((key) => key.purpose === "agent_policy") },
      FETCHED_AT,
    );
    expectTrustCode(
      () =>
        purposeTrust.verifyVersion(version, {
          issuer: ORIGIN,
          runtimeVersion: "v0.18.9",
        }),
      "signing_purpose_mismatch",
    );

    expectTrustCode(
      () =>
        issuerTrust.verifyVersion(
          { ...version, signing_key_id: "unknown-key" },
          { issuer: ORIGIN, runtimeVersion: "v0.18.9" },
        ),
      "unknown_signing_key",
    );
    expectTrustCode(
      () =>
        issuerTrust.verifyVersion(
          { ...version, content_digest: "cd".repeat(32) },
          { issuer: ORIGIN, runtimeVersion: "v0.18.9" },
        ),
      "digest_mismatch",
    );
    expectTrustCode(
      () =>
        issuerTrust.verifyVersion(
          { ...version, signature: "AA".repeat(43) },
          { issuer: ORIGIN, runtimeVersion: "v0.18.9" },
        ),
      "signature_invalid",
    );
  });

  it("enforces the signed Runtime compatibility window", () => {
    const { keys, version, policy } = fixture();
    const trust = new AgenteraAgentTrustStore();
    trust.replaceKeys(ORIGIN, keys, FETCHED_AT);

    for (const runtimeVersion of ["v0.18.1", "v0.19.0", "not-a-version"]) {
      expectTrustCode(
        () => trust.verifyVersion(version, { issuer: ORIGIN, runtimeVersion }),
        "runtime_incompatible",
      );
      expectTrustCode(
        () => trust.verifyPolicy(policy, { runtimeVersion }),
        "runtime_incompatible",
      );
    }
  });

  it("re-verifies offline from a cache containing only scoped public keys and fetch time", () => {
    const { keys, version, policy } = fixture();
    const online = new AgenteraAgentTrustStore();
    online.replaceKeys(ORIGIN, keys, FETCHED_AT);
    const cache = online.exportCache();
    const serialized = JSON.stringify(cache);
    for (const forbidden of [
      "signature",
      "system_prompt",
      "version_digest",
      "access_token",
      "private",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const offline = new AgenteraAgentTrustStore({ cache });
    expect(
      offline.verifyVersion(version, {
        issuer: ORIGIN,
        runtimeVersion: "v0.18.9",
      }),
    ).toEqual({ contentDigest: version.content_digest });
    expect(offline.verifyPolicy(policy, { runtimeVersion: "v0.18.9" })).toEqual(
      { contentDigest: policy.content_digest },
    );
    expect(offline.exportCache()).toEqual(cache);
  });
});
