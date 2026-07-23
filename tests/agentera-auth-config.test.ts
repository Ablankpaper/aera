// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  agenteraCloudUrl,
  getBundledAgenteraOfflinePublicKeys,
  parseAgenteraCloudOrigin,
  parseAgenteraOfflinePublicKeysBuildConfig,
  parseAgenteraRechargePublicUrl,
  resolveAgenteraCloudOrigin,
  resolveBundledAgenteraOfflinePublicKeys,
} from "../src/main/agentera-auth/config";

describe("AgentEra cloud endpoint configuration", () => {
  const betaIssuer = "https://203.0.113.10";
  const betaPublicKey = Buffer.alloc(32, 73).toString("base64url");

  function betaTrustJson(input: Record<string, unknown> = {}): string {
    return JSON.stringify({
      issuer: betaIssuer,
      keys: [
        {
          keyId: "offline-beta-2026-07",
          publicKey: betaPublicKey,
        },
      ],
      ...input,
    });
  }

  // @lat: [[agentera-app-authentication#Desktop authentication foundation#Cloud origin boundary]]
  it("accepts trusted HTTPS and loopback-only development HTTP", () => {
    expect(parseAgenteraCloudOrigin("https://accounts.agentera.example/")).toBe(
      "https://accounts.agentera.example",
    );
    expect(parseAgenteraCloudOrigin("http://127.0.0.1:8086")).toBe(
      "http://127.0.0.1:8086",
    );
    expect(parseAgenteraCloudOrigin("http://localhost:8086")).toBe(
      "http://localhost:8086",
    );
    expect(parseAgenteraCloudOrigin("http://[::1]:8086")).toBe(
      "http://[::1]:8086",
    );
  });

  it("rejects insecure remote HTTP and non-HTTP protocols", () => {
    expect(() =>
      parseAgenteraCloudOrigin("http://accounts.agentera.example"),
    ).toThrow(/https/i);
    expect(() =>
      parseAgenteraCloudOrigin("file:///tmp/agentera-cloud"),
    ).toThrow(/https/i);
  });

  it("rejects credentials and anything other than an exact origin", () => {
    expect(() =>
      parseAgenteraCloudOrigin(
        "https://desktop-user:desktop-pass@accounts.agentera.example",
      ),
    ).toThrow(/credentials/i);
    expect(() =>
      parseAgenteraCloudOrigin("https://accounts.agentera.example/api/v1"),
    ).toThrow(/origin/i);
    expect(() =>
      parseAgenteraCloudOrigin("https://accounts.agentera.example/?mode=login"),
    ).toThrow(/origin/i);
    expect(() =>
      parseAgenteraCloudOrigin("https://accounts.agentera.example/#login"),
    ).toThrow(/origin/i);
  });

  it("refuses to reuse any configured recharge-site origin", () => {
    expect(() =>
      parseAgenteraCloudOrigin("https://pay.agentera.example", {
        rechargePublicUrls: [
          "https://pay.agentera.example/recharge",
          "https://billing.agentera.example",
        ],
      }),
    ).toThrow(/recharge/i);
  });

  it("uses runtime configuration before build configuration", () => {
    expect(
      resolveAgenteraCloudOrigin({
        runtimePublicUrl: "https://runtime-auth.agentera.example",
        buildPublicUrl: "https://build-auth.agentera.example",
      }),
    ).toBe("https://runtime-auth.agentera.example");
    expect(
      resolveAgenteraCloudOrigin({
        buildPublicUrl: "https://build-auth.agentera.example",
      }),
    ).toBe("https://build-auth.agentera.example");
    expect(() => resolveAgenteraCloudOrigin({})).toThrow(/not configured/i);
  });

  it("constructs only paths that remain on the configured origin", () => {
    const origin = "https://accounts.agentera.example";
    expect(agenteraCloudUrl(origin, "/api/v1/legal/current").href).toBe(
      "https://accounts.agentera.example/api/v1/legal/current",
    );
    expect(() =>
      agenteraCloudUrl(origin, "https://evil.example/token"),
    ).toThrow(/origin/i);
    expect(() => agenteraCloudUrl(origin, "//evil.example/token")).toThrow(
      /origin/i,
    );
  });

  it("scopes the local development offline key to its exact loopback issuer", () => {
    expect(
      getBundledAgenteraOfflinePublicKeys("http://127.0.0.1:8086"),
    ).toHaveProperty("offline-dev-v1");
    expect(
      getBundledAgenteraOfflinePublicKeys("https://accounts.agentera.example"),
    ).toEqual({});
    expect(
      getBundledAgenteraOfflinePublicKeys("http://localhost:8086"),
    ).toEqual({});
  });

  it("accepts reviewed build-time Ed25519 keys for one canonical HTTPS IP issuer", () => {
    const roots = parseAgenteraOfflinePublicKeysBuildConfig(
      betaTrustJson(),
      betaIssuer,
    );

    expect(roots).toEqual({
      "offline-beta-2026-07": {
        publicKey: betaPublicKey,
        allowedIssuers: [betaIssuer],
      },
    });
    expect(Object.isFrozen(roots)).toBe(true);
    expect(Object.isFrozen(roots["offline-beta-2026-07"])).toBe(true);
    expect(Object.isFrozen(roots["offline-beta-2026-07"].allowedIssuers)).toBe(
      true,
    );
  });

  it.each([
    ["malformed JSON", "{", betaIssuer],
    [
      "an unknown top-level field",
      betaTrustJson({ unexpected: true }),
      betaIssuer,
    ],
    [
      "an unknown key field",
      JSON.stringify({
        issuer: betaIssuer,
        keys: [
          {
            keyId: "offline-beta-2026-07",
            publicKey: betaPublicKey,
            algorithm: "Ed25519",
          },
        ],
      }),
      betaIssuer,
    ],
    [
      "duplicate key IDs",
      JSON.stringify({
        issuer: betaIssuer,
        keys: [
          {
            keyId: "offline-beta-2026-07",
            publicKey: betaPublicKey,
          },
          {
            keyId: "offline-beta-2026-07",
            publicKey: Buffer.alloc(32, 74).toString("base64url"),
          },
        ],
      }),
      betaIssuer,
    ],
    [
      "remote HTTP",
      betaTrustJson({ issuer: "http://203.0.113.10" }),
      "http://203.0.113.10",
    ],
    [
      "an issuer path",
      betaTrustJson({ issuer: `${betaIssuer}/oauth` }),
      betaIssuer,
    ],
    [
      "a DNS issuer",
      betaTrustJson({ issuer: "https://beta.agentera.example" }),
      "https://beta.agentera.example",
    ],
    [
      "noncanonical base64url",
      betaTrustJson({
        keys: [
          {
            keyId: "offline-beta-2026-07",
            publicKey: `${betaPublicKey}=`,
          },
        ],
      }),
      betaIssuer,
    ],
    [
      "the wrong Ed25519 key length",
      betaTrustJson({
        keys: [
          {
            keyId: "offline-beta-2026-07",
            publicKey: Buffer.alloc(31, 73).toString("base64url"),
          },
        ],
      }),
      betaIssuer,
    ],
    [
      "a build Cloud origin different from the issuer",
      betaTrustJson(),
      "https://203.0.113.11",
    ],
  ])(
    "rejects %s in the baked Beta trust configuration",
    (_name, raw, origin) => {
      expect(() =>
        parseAgenteraOfflinePublicKeysBuildConfig(raw, origin),
      ).toThrow(/offline|issuer|key|json|field|https|origin/i);
    },
  );

  it("does not read runtime process variables as offline trust roots", () => {
    const previous = process.env.MAIN_VITE_AGENTERA_OFFLINE_PUBLIC_KEYS_JSON;
    process.env.MAIN_VITE_AGENTERA_OFFLINE_PUBLIC_KEYS_JSON = betaTrustJson();
    try {
      const roots = resolveBundledAgenteraOfflinePublicKeys({});
      expect(roots).toHaveProperty("offline-dev-v1");
      expect(roots).not.toHaveProperty("offline-beta-2026-07");
    } finally {
      if (previous === undefined) {
        delete process.env.MAIN_VITE_AGENTERA_OFFLINE_PUBLIC_KEYS_JSON;
      } else {
        process.env.MAIN_VITE_AGENTERA_OFFLINE_PUBLIC_KEYS_JSON = previous;
      }
    }
  });

  it("accepts a separate HTTPS recharge page and loopback development URL", () => {
    expect(
      parseAgenteraRechargePublicUrl(
        "https://pay.agentera.example/recharge?source=desktop",
      ),
    ).toBe("https://pay.agentera.example/recharge?source=desktop");
    expect(parseAgenteraRechargePublicUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080/",
    );
    expect(() =>
      parseAgenteraRechargePublicUrl("http://pay.agentera.example"),
    ).toThrow(/https/i);
    expect(() =>
      parseAgenteraRechargePublicUrl("https://user:pass@pay.example"),
    ).toThrow(/https/i);
  });
});
