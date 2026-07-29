// @vitest-environment node

import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAgenteraOfflineEntitlement } from "../src/main/agentera-auth/entitlement";

const ISSUER = "https://accounts.agentera.example";
const AUDIENCE = "agentera-studio";
const NOW = new Date("2026-07-18T01:00:00.000Z");
const IDS = {
  entitlement: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  user: "11111111-1111-4111-8111-111111111111",
  device: "33333333-3333-4333-8333-333333333333",
  installation: "44444444-4444-4444-8444-444444444444",
  space: "22222222-2222-4222-8222-222222222222",
};

function rawPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return der.subarray(-32).toString("base64url");
}

function issueEntitlement(
  privateKey: KeyObject,
  options: {
    kid?: string;
    payload?: Record<string, unknown>;
    header?: Record<string, unknown>;
  } = {},
): string {
  const iat = Math.floor(NOW.getTime() / 1000);
  const header = {
    alg: "EdDSA",
    kid: options.kid ?? "offline-test-v1",
    typ: "agentera-offline-entitlement+jwt",
    ...options.header,
  };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    jti: IDS.entitlement,
    sub: IDS.user,
    device_id: IDS.device,
    installation_id: IDS.installation,
    personal_space_id: IDS.space,
    policy_version: 1,
    iat,
    exp: iat + 7 * 24 * 60 * 60,
    ...options.payload,
  };
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

describe("Aera signed offline entitlement", () => {
  it("accepts exactly one seven-day entitlement bound to this installation", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const token = issueEntitlement(privateKey);

    const claims = verifyAgenteraOfflineEntitlement({
      serialized: token,
      issuer: ISSUER,
      audience: AUDIENCE,
      publicKeys: { "offline-test-v1": rawPublicKey(publicKey) },
      expectedBinding: {
        userId: IDS.user,
        deviceId: IDS.device,
        installationId: IDS.installation,
        personalSpaceId: IDS.space,
      },
      expectedExpiresAt: "2026-07-25T01:00:00.000Z",
      now: NOW,
    });

    expect(claims).toMatchObject({
      keyId: "offline-test-v1",
      jti: IDS.entitlement,
      userId: IDS.user,
      deviceId: IDS.device,
      installationId: IDS.installation,
      personalSpaceId: IDS.space,
      policyVersion: 1,
      issuedAt: "2026-07-18T01:00:00.000Z",
      expiresAt: "2026-07-25T01:00:00.000Z",
    });
  });

  it.each([
    ["unknown key", { kid: "offline-unknown" }],
    ["copied device", { payload: { device_id: crypto.randomUUID() } }],
    [
      "copied installation",
      { payload: { installation_id: crypto.randomUUID() } },
    ],
    ["wrong issuer", { payload: { iss: "https://attacker.invalid" } }],
    ["wrong audience", { payload: { aud: "another-product" } }],
    ["missing jti", { payload: { jti: null } }],
    ["invalid policy", { payload: { policy_version: 0 } }],
    ["unknown claim", { payload: { unexpected: true } }],
    [
      "future issue time",
      { payload: { iat: Math.floor(NOW.getTime() / 1000) + 61 } },
    ],
    [
      "wrong lifetime",
      {
        payload: {
          exp: Math.floor(NOW.getTime() / 1000) + 6 * 24 * 60 * 60,
        },
      },
    ],
  ])("rejects %s", (_label, mutation) => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const token = issueEntitlement(privateKey, mutation);

    expect(() =>
      verifyAgenteraOfflineEntitlement({
        serialized: token,
        issuer: ISSUER,
        audience: AUDIENCE,
        publicKeys: { "offline-test-v1": rawPublicKey(publicKey) },
        expectedBinding: {
          userId: IDS.user,
          deviceId: IDS.device,
          installationId: IDS.installation,
          personalSpaceId: IDS.space,
        },
        expectedExpiresAt: "2026-07-25T01:00:00.000Z",
        now: NOW,
      }),
    ).toThrow(/offline entitlement/i);
  });

  it("rejects expiry, altered payloads, altered signatures, and non-canonical encodings", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeys = { "offline-test-v1": rawPublicKey(publicKey) };
    const token = issueEntitlement(privateKey);
    const parts = token.split(".");
    const options = {
      issuer: ISSUER,
      audience: AUDIENCE,
      publicKeys,
      expectedBinding: {
        userId: IDS.user,
        deviceId: IDS.device,
        installationId: IDS.installation,
        personalSpaceId: IDS.space,
      },
      expectedExpiresAt: "2026-07-25T01:00:00.000Z",
    } as const;

    expect(() =>
      verifyAgenteraOfflineEntitlement({
        ...options,
        serialized: token,
        now: new Date("2026-07-25T01:00:00.000Z"),
      }),
    ).toThrow(/expired/i);

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    payload.sub = crypto.randomUUID();
    const alteredPayload = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${parts[2]}`;
    const signature = Buffer.from(parts[2], "base64url");
    signature[0] ^= 1;
    const alteredSignature = `${parts[0]}.${parts[1]}.${signature.toString("base64url")}`;
    const padded = `${parts[0]}=.${parts[1]}.${parts[2]}`;

    for (const serialized of [alteredPayload, alteredSignature, padded]) {
      expect(() =>
        verifyAgenteraOfflineEntitlement({
          ...options,
          serialized,
          now: NOW,
        }),
      ).toThrow(/offline entitlement/i);
    }
  });
});
