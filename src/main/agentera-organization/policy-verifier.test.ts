import {
  createHash,
  generateKeyPairSync,
  sign as signPayload,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OrganizationPolicySnapshot } from "../../shared/agentera-organization";
import {
  AgenteraOrganizationPolicyVerificationError,
  AgenteraOrganizationPolicyVerifier,
  canonicalizeOrganizationPolicyDocument,
  type OrganizationSigningKeySet,
} from "./policy-verifier";

const ORIGIN = "http://127.0.0.1:8086";
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "50000000-0000-4000-8000-000000000005";
const CREATED_AT = "2026-07-21T00:00:00.000Z";

function fixture(): {
  snapshot: OrganizationPolicySnapshot;
  keys: OrganizationSigningKeySet;
} {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "jwk" }).x!;
  const canonicalJson = JSON.stringify({
    schema_version: 1,
    models: {
      allowlist: [
        { provider: "openai", model: "gpt-5" },
        { provider: "openai", model: "gpt-5-mini" },
      ],
    },
    tools: { allowlist: ["browser.read", "files.read"] },
    experience_candidates: { mode: "manual_review" },
    official_agents: { installation: "allowed" },
  });
  const contentDigest = createHash("sha256")
    .update(canonicalJson, "utf8")
    .digest("hex");
  const payload = Buffer.from(
    `agentera-organization-policy-v1\0${ORGANIZATION_ID}\0${SNAPSHOT_ID}\0${1}\0${contentDigest}`,
    "utf8",
  );
  const signature = signPayload(null, payload, pair.privateKey).toString(
    "base64url",
  );
  const snapshot: OrganizationPolicySnapshot = {
    id: SNAPSHOT_ID,
    policyVersion: 1,
    schemaVersion: 1,
    contentDigest,
    issuer: ORIGIN,
    signingKeyId: "organization-current",
    createdAt: CREATED_AT,
    document: {
      schemaVersion: 1,
      models: {
        allowlist: [
          { provider: "openai", model: "gpt-5" },
          { provider: "openai", model: "gpt-5-mini" },
        ],
      },
      tools: { allowlist: ["browser.read", "files.read"] },
      experienceCandidates: { mode: "manual_review" },
      officialAgents: { installation: "allowed" },
    },
    signature,
  };
  const purposes = [
    "access",
    "offline_entitlement",
    "agent_version",
    "agent_policy",
    "organization_policy",
  ] as const;
  const keys = {
    keys: purposes.map((purpose) => ({
      kid:
        purpose === "organization_policy"
          ? snapshot.signingKeyId
          : `${purpose}-current`,
      kty: "OKP" as const,
      crv: "Ed25519" as const,
      alg: "EdDSA" as const,
      use: "sig" as const,
      purpose,
      x: publicKey,
    })),
  };
  return { snapshot, keys };
}

describe("AgenteraOrganizationPolicyVerifier", () => {
  it("preserves null-inherit and empty-deny as different canonical documents", () => {
    const inherit = canonicalizeOrganizationPolicyDocument({
      schemaVersion: 1,
      models: { allowlist: null },
      tools: { allowlist: null },
      experienceCandidates: { mode: "manual_review" },
      officialAgents: { installation: "allowed" },
    });
    const deny = canonicalizeOrganizationPolicyDocument({
      schemaVersion: 1,
      models: { allowlist: [] },
      tools: { allowlist: [] },
      experienceCandidates: { mode: "manual_review" },
      officialAgents: { installation: "allowed" },
    });

    expect(inherit.canonicalJson).toContain('"allowlist":null');
    expect(deny.canonicalJson).toContain('"allowlist":[]');
    expect(inherit.contentDigest).not.toBe(deny.contentDigest);

    const sorted = canonicalizeOrganizationPolicyDocument({
      schemaVersion: 1,
      models: {
        allowlist: [
          { provider: "openai", model: "gpt-5-mini" },
          { provider: "openai", model: "gpt-5" },
        ],
      },
      tools: { allowlist: ["files.read", "browser.read"] },
      experienceCandidates: { mode: "manual_review" },
      officialAgents: { installation: "allowed" },
    });
    expect(sorted.document.models.allowlist).toEqual([
      { provider: "openai", model: "gpt-5" },
      { provider: "openai", model: "gpt-5-mini" },
    ]);
    expect(sorted.document.tools.allowlist).toEqual([
      "browser.read",
      "files.read",
    ]);
  });

  it("accepts only a canonical digest-bound Organization policy signed by a currently published key", () => {
    const { snapshot, keys } = fixture();
    const verifier = new AgenteraOrganizationPolicyVerifier({ origin: ORIGIN });
    const verified = verifier.verify({
      organizationId: ORGANIZATION_ID,
      snapshot,
      keySet: keys,
    });

    expect(verified).toMatchObject({
      organizationId: ORGANIZATION_ID,
      contentDigest: snapshot.contentDigest,
      snapshot,
    });
    expect(verified.contentDigest).toBe(
      "535ecbc5c6432b47022d61712e7722ad3ff87e8ac4d3ed50b6d082097604c87f",
    );
    expect(verified.canonicalJson).toBe(
      JSON.stringify({
        schema_version: 1,
        models: {
          allowlist: [
            { provider: "openai", model: "gpt-5" },
            { provider: "openai", model: "gpt-5-mini" },
          ],
        },
        tools: { allowlist: ["browser.read", "files.read"] },
        experience_candidates: { mode: "manual_review" },
        official_agents: { installation: "allowed" },
      }),
    );
  });

  it.each([
    [
      "issuer_mismatch",
      (value: ReturnType<typeof fixture>) => {
        value.snapshot.issuer = "https://other.example";
      },
    ],
    [
      "signing_purpose_mismatch",
      (value: ReturnType<typeof fixture>) => {
        const key = value.keys.keys.find(
          (candidate) => candidate.purpose === "organization_policy",
        )!;
        (key as { purpose: string }).purpose = "agent_policy";
      },
    ],
    [
      "unknown_signing_key",
      (value: ReturnType<typeof fixture>) => {
        value.snapshot.signingKeyId = "retired-key";
      },
    ],
    [
      "schema_mismatch",
      (value: ReturnType<typeof fixture>) => {
        value.snapshot.schemaVersion = 2 as 1;
      },
    ],
    [
      "digest_mismatch",
      (value: ReturnType<typeof fixture>) => {
        value.snapshot.contentDigest = "b".repeat(64);
      },
    ],
    [
      "signature_invalid",
      (value: ReturnType<typeof fixture>) => {
        value.snapshot.signature = "A".repeat(86);
      },
    ],
    [
      "canonicalization_mismatch",
      (value: ReturnType<typeof fixture>) => {
        value.snapshot.document!.tools.allowlist = [
          "files.read",
          "browser.read",
        ];
      },
    ],
  ])("rejects %s without producing a cacheable snapshot", (code, mutate) => {
    const value = fixture();
    mutate(value);
    const verifier = new AgenteraOrganizationPolicyVerifier({ origin: ORIGIN });

    let error: unknown;
    try {
      verifier.verify({
        organizationId: ORGANIZATION_ID,
        snapshot: value.snapshot,
        keySet: value.keys,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AgenteraOrganizationPolicyVerificationError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(value.snapshot.signature ?? "");
  });
});
