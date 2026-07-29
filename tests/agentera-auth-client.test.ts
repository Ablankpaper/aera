// @vitest-environment node

import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgenteraCloudClient,
  AgenteraCloudClientError,
} from "../src/main/agentera-auth/client";
import { getOrCreateAgenteraDeviceIdentity } from "../src/main/agentera-auth/device-key";
import { createAgenteraPkceAttempt } from "../src/main/agentera-auth/pkce";
import { createPendingAgenteraSelfRevocation } from "../src/main/agentera-auth/lifecycle";
import {
  AgenteraAuthStore,
  type InstallationIdentity,
  type SecureStorageAdapter,
} from "../src/main/agentera-auth/store";

class FakeSecureStorage implements SecureStorageAdapter {
  isEncryptionAvailable(): boolean {
    return true;
  }
  encryptString(value: string): Buffer {
    return Buffer.from(`protected:${value}`, "utf8");
  }
  decryptString(value: Buffer): string {
    return value.toString("utf8").replace(/^protected:/, "");
  }
}

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  space: "22222222-2222-4222-8222-222222222222",
  device: "33333333-3333-4333-8333-333333333333",
};
const authorizationCode = Buffer.alloc(32, 10).toString("base64url");
const accessToken = "access-token-value";
const refreshToken = Buffer.alloc(32, 11).toString("base64url");
const rotatedRefreshToken = Buffer.alloc(32, 12).toString("base64url");
const offlineEntitlement = "offline-entitlement-value";

function tokenResponse(refresh = refreshToken): Record<string, string> {
  return {
    access_token: accessToken,
    access_expires_at: "2026-07-18T01:15:00Z",
    refresh_token: refresh,
    refresh_expires_at: "2026-08-17T01:00:00Z",
    offline_entitlement: offlineEntitlement,
    offline_expires_at: "2026-07-25T01:00:00Z",
    user_id: ids.user,
    personal_space_id: ids.space,
    device_id: ids.device,
  };
}

describe("Aera cloud desktop client", () => {
  let root = "";
  let identity: InstallationIdentity;
  let server: Server | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-client-"));
    identity = getOrCreateAgenteraDeviceIdentity(
      new AgenteraAuthStore({
        userDataPath: root,
        secureStorage: new FakeSecureStorage(),
      }),
    );
  });

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    rmSync(root, { recursive: true, force: true });
  });

  async function listen(
    handler: Parameters<typeof createHttpServer>[0],
  ): Promise<string> {
    server = createHttpServer(handler);
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    return `http://127.0.0.1:${address.port}`;
  }

  // @lat: [[agentera-app-authentication#Browser sign-in#Cloud token exchange]]
  it("builds the fixed authorization request without putting any secret in its URL", async () => {
    const origin = await listen((_request, response) => response.end());
    const client = new AgenteraCloudClient({ origin });
    const pkce = createAgenteraPkceAttempt();
    const authorizationUrl = client.createAuthorizationUrl({
      redirectUri: "http://127.0.0.1:43123/agentera/oauth/callback",
      pkce,
      identity,
      deviceName: "Aera Test Mac",
      platform: "darwin",
      appVersion: "0.7.3",
      forceAccountSelection: true,
    });

    expect(authorizationUrl.origin).toBe(origin);
    expect(authorizationUrl.pathname).toBe("/oauth/authorize");
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "agentera-studio",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:43123/agentera/oauth/callback",
    );
    expect(authorizationUrl.searchParams.get("code_challenge")).toBe(
      pkce.challenge,
    );
    expect(authorizationUrl.searchParams.get("prompt")).toBe("select_account");
    const serialized = authorizationUrl.href;
    expect(serialized).not.toContain(identity.devicePrivateKey);
    expect(serialized).not.toContain(pkce.verifier);
    expect(serialized).not.toContain("token");
  });

  it("signs the exchange digest and maps the strict token response", async () => {
    let verifiedDeviceProof = false;
    const origin = await listen(async (request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/v1/oauth/token");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as Record<string, string>;
      expect(body.authorization_code).toBe(authorizationCode);
      expect(body.installation_id).toBe(identity.installationId);
      const digest = createHash("sha256")
        .update(
          `${authorizationCode}\0${body.code_verifier}\0${identity.installationId}`,
        )
        .digest();
      const spki = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(identity.devicePublicKey, "base64url"),
      ]);
      const publicKey: KeyObject = createPublicKey({
        key: spki,
        format: "der",
        type: "spki",
      });
      verifiedDeviceProof = verify(
        null,
        digest,
        publicKey,
        Buffer.from(body.device_proof, "base64url"),
      );
      response.setHeader("content-type", "application/json");
      response.setHeader("date", "Sat, 18 Jul 2026 01:00:00 GMT");
      response.end(JSON.stringify(tokenResponse()));
    });
    const client = new AgenteraCloudClient({ origin });
    const pkce = createAgenteraPkceAttempt();

    const result = await client.exchangeAuthorizationCode({
      authorizationCode,
      codeVerifier: pkce.verifier,
      identity,
    });

    expect(verifiedDeviceProof).toBe(true);
    expect(result).toMatchObject({
      accessToken,
      refreshToken,
      offlineEntitlement,
      userId: ids.user,
      personalSpaceId: ids.space,
      deviceId: ids.device,
      trustedServerTime: "2026-07-18T01:00:00.000Z",
    });
  });

  it("rotates and revokes refresh tokens only in POST bodies", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const origin = await listen(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ url: request.url ?? "", body });
      if (request.url === "/api/v1/oauth/refresh") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(tokenResponse(rotatedRefreshToken)));
      } else {
        response.statusCode = 204;
        response.end();
      }
    });
    const client = new AgenteraCloudClient({ origin });

    expect((await client.refreshSession(refreshToken)).refreshToken).toBe(
      rotatedRefreshToken,
    );
    await client.revokeSession(rotatedRefreshToken);

    expect(requests.map((request) => request.url)).toEqual([
      "/api/v1/oauth/refresh",
      "/api/v1/oauth/revoke",
    ]);
    expect(requests[0].url).not.toContain(refreshToken);
    expect(JSON.parse(requests[0].body)).toEqual({
      refresh_token: refreshToken,
    });
    expect(JSON.parse(requests[1].body)).toEqual({
      refresh_token: rotatedRefreshToken,
    });
  });

  it("returns bounded cloud errors without echoing token-bearing bodies", async () => {
    const origin = await listen((_request, response) => {
      response.statusCode = 401;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ error: "session_revoked", detail: refreshToken }),
      );
    });
    const client = new AgenteraCloudClient({ origin });

    let caught: unknown;
    try {
      await client.refreshSession(refreshToken);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgenteraCloudClientError);
    expect((caught as AgenteraCloudClientError).status).toBe(401);
    expect(String(caught)).toContain("session_revoked");
    expect(String(caught)).not.toContain(refreshToken);
  });

  it("delivers a bearer-free device-signed self-revocation", async () => {
    let requestHeaders: Record<string, string | string[] | undefined> = {};
    let requestBody: Record<string, unknown> = {};
    const origin = await listen(async (request, response) => {
      requestHeaders = request.headers;
      let raw = "";
      for await (const chunk of request) raw += chunk;
      requestBody = JSON.parse(raw) as Record<string, unknown>;
      response.statusCode = 204;
      response.end();
    });
    const client = new AgenteraCloudClient({ origin });
    const record = createPendingAgenteraSelfRevocation({
      deviceId: ids.device,
      identity,
      now: new Date("2026-07-18T01:00:00.000Z"),
      nonce: Buffer.alloc(32, 9),
    });

    await client.deliverSelfRevocation(record);

    expect(requestHeaders.authorization).toBeUndefined();
    expect(requestBody).toEqual({
      device_id: ids.device,
      installation_id: identity.installationId,
      timestamp: Math.floor(Date.parse("2026-07-18T01:00:00.000Z") / 1000),
      nonce: record.nonce,
      signature: record.signature,
    });
  });

  it("understands the cloud contract's nested bounded error envelope", async () => {
    const origin = await listen((_request, response) => {
      response.statusCode = 401;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: {
            code: "account_pending_deletion",
            message: "localized by the client",
            request_id: crypto.randomUUID(),
          },
        }),
      );
    });
    const client = new AgenteraCloudClient({ origin });

    await expect(client.refreshSession(refreshToken)).rejects.toMatchObject({
      status: 401,
      code: "account_pending_deletion",
    });
  });
});
