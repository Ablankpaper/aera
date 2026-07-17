import { createHash } from "node:crypto";
import { agenteraCloudUrl, parseAgenteraCloudOrigin } from "./config";
import { signAgenteraDeviceDigest } from "./device-key";
import type { AgenteraPkceAttempt } from "./pkce";
import type { InstallationIdentity } from "./store";

const RESPONSE_LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface AgenteraTokenSet {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  offlineEntitlement: string;
  offlineExpiresAt: string;
  userId: string;
  personalSpaceId: string;
  deviceId: string;
  trustedServerTime: string;
}

export interface AgenteraDeviceMetadata {
  deviceName: string;
  platform: "darwin" | "windows" | "linux";
  appVersion: string;
}

export interface AgenteraAuthorizationRequest extends AgenteraDeviceMetadata {
  redirectUri: string;
  pkce: AgenteraPkceAttempt;
  identity: InstallationIdentity;
  forceAccountSelection?: boolean;
}

export interface AgenteraAuthorizationExchange {
  authorizationCode: string;
  codeVerifier: string;
  identity: InstallationIdentity;
}

export interface AgenteraCloudClientPort {
  readonly origin: string;
  createAuthorizationUrl(request: AgenteraAuthorizationRequest): URL;
  exchangeAuthorizationCode(
    input: AgenteraAuthorizationExchange,
  ): Promise<AgenteraTokenSet>;
  refreshSession(refreshToken: string): Promise<AgenteraTokenSet>;
  revokeSession(refreshToken: string): Promise<void>;
}

export interface AgenteraCloudClientOptions {
  origin: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export class AgenteraCloudClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`AgentEra cloud request failed: ${code}.`);
    this.name = "AgenteraCloudClientError";
    this.status = status;
    this.code = code;
  }
}

interface RawTokenResponse {
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
  offline_entitlement: string;
  offline_expires_at: string;
  user_id: string;
  personal_space_id: string;
  device_id: string;
}

const TOKEN_KEYS = [
  "access_expires_at",
  "access_token",
  "device_id",
  "offline_entitlement",
  "offline_expires_at",
  "personal_space_id",
  "refresh_expires_at",
  "refresh_token",
  "user_id",
] as const;

function canonicalDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function validRawTokenResponse(value: unknown): value is RawTokenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== TOKEN_KEYS.join("\0")) {
    return false;
  }
  return (
    typeof record.access_token === "string" &&
    record.access_token.length > 0 &&
    record.access_token.length <= 8192 &&
    canonicalDate(record.access_expires_at) !== null &&
    typeof record.refresh_token === "string" &&
    SECRET_PATTERN.test(record.refresh_token) &&
    canonicalDate(record.refresh_expires_at) !== null &&
    typeof record.offline_entitlement === "string" &&
    record.offline_entitlement.length > 0 &&
    record.offline_entitlement.length <= 8192 &&
    canonicalDate(record.offline_expires_at) !== null &&
    typeof record.user_id === "string" &&
    UUID_PATTERN.test(record.user_id) &&
    typeof record.personal_space_id === "string" &&
    UUID_PATTERN.test(record.personal_space_id) &&
    typeof record.device_id === "string" &&
    UUID_PATTERN.test(record.device_id)
  );
}

function safeErrorCode(body: string): string {
  if (body.length > RESPONSE_LIMIT) return "response_too_large";
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (
      typeof parsed.error === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/.test(parsed.error)
    ) {
      return parsed.error;
    }
  } catch {
    // Return a bounded generic code; never echo a token-bearing response body.
  }
  return "request_failed";
}

export class AgenteraCloudClient implements AgenteraCloudClientPort {
  readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: AgenteraCloudClientOptions) {
    this.origin = parseAgenteraCloudOrigin(options.origin);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    if (
      typeof this.fetcher !== "function" ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000
    ) {
      throw new Error("AgentEra cloud client configuration is invalid.");
    }
  }

  createAuthorizationUrl(request: AgenteraAuthorizationRequest): URL {
    const url = agenteraCloudUrl(this.origin, "/oauth/authorize");
    url.searchParams.set("client_id", "agentera-studio");
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("code_challenge", request.pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", request.pkce.state);
    url.searchParams.set("installation_id", request.identity.installationId);
    url.searchParams.set("device_public_key", request.identity.devicePublicKey);
    url.searchParams.set("device_name", request.deviceName);
    url.searchParams.set("platform", request.platform);
    url.searchParams.set("app_version", request.appVersion);
    if (request.forceAccountSelection) {
      url.searchParams.set("prompt", "select_account");
    }
    return url;
  }

  async exchangeAuthorizationCode(
    input: AgenteraAuthorizationExchange,
  ): Promise<AgenteraTokenSet> {
    if (
      !SECRET_PATTERN.test(input.authorizationCode) ||
      input.codeVerifier.length < 43 ||
      input.codeVerifier.length > 128 ||
      !/^[A-Za-z0-9._~-]+$/.test(input.codeVerifier)
    ) {
      throw new AgenteraCloudClientError(0, "invalid_authorization_material");
    }
    const digest = createHash("sha256")
      .update(
        `${input.authorizationCode}\0${input.codeVerifier}\0${input.identity.installationId}`,
        "utf8",
      )
      .digest();
    const deviceProof = signAgenteraDeviceDigest(
      input.identity.devicePrivateKey,
      digest,
    );
    return this.postForTokenSet("/api/v1/oauth/token", {
      authorization_code: input.authorizationCode,
      code_verifier: input.codeVerifier,
      installation_id: input.identity.installationId,
      device_proof: deviceProof,
    });
  }

  async refreshSession(refreshToken: string): Promise<AgenteraTokenSet> {
    if (!SECRET_PATTERN.test(refreshToken)) {
      throw new AgenteraCloudClientError(0, "invalid_refresh_token");
    }
    return this.postForTokenSet("/api/v1/oauth/refresh", {
      refresh_token: refreshToken,
    });
  }

  async revokeSession(refreshToken: string): Promise<void> {
    if (!SECRET_PATTERN.test(refreshToken)) {
      throw new AgenteraCloudClientError(0, "invalid_refresh_token");
    }
    const response = await this.post("/api/v1/oauth/revoke", {
      refresh_token: refreshToken,
    });
    if (response.status !== 204) {
      const body = await response.text();
      throw new AgenteraCloudClientError(response.status, safeErrorCode(body));
    }
  }

  private async postForTokenSet(
    path: string,
    body: Record<string, string>,
  ): Promise<AgenteraTokenSet> {
    const response = await this.post(path, body);
    const rawBody = await response.text();
    if (!response.ok) {
      throw new AgenteraCloudClientError(
        response.status,
        safeErrorCode(rawBody),
      );
    }
    if (rawBody.length > RESPONSE_LIMIT) {
      throw new AgenteraCloudClientError(0, "response_too_large");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new AgenteraCloudClientError(0, "invalid_response");
    }
    if (!validRawTokenResponse(parsed)) {
      throw new AgenteraCloudClientError(0, "invalid_response");
    }
    const serverDate = response.headers.get("date");
    const trustedServerTime =
      canonicalDate(serverDate) ?? this.now().toISOString();
    return {
      accessToken: parsed.access_token,
      accessExpiresAt: canonicalDate(parsed.access_expires_at) as string,
      refreshToken: parsed.refresh_token,
      refreshExpiresAt: canonicalDate(parsed.refresh_expires_at) as string,
      offlineEntitlement: parsed.offline_entitlement,
      offlineExpiresAt: canonicalDate(parsed.offline_expires_at) as string,
      userId: parsed.user_id,
      personalSpaceId: parsed.personal_space_id,
      deviceId: parsed.device_id,
      trustedServerTime,
    };
  }

  private async post(
    path: string,
    body: Record<string, string>,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      return await this.fetcher(agenteraCloudUrl(this.origin, path), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new AgenteraCloudClientError(0, "network_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
