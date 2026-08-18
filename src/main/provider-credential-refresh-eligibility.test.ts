// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Runtime credential refresh eligibility", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("recognizes only an oauth row with a non-empty Runtime refresh token", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-refresh-eligibility-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    vi.stubEnv("HERMES_HOME", root);
    const {
      getRuntimeCredentialRefreshEligibility,
      getRuntimeProviderCredential,
    } = await import("./config");
    writeFileSync(
      join(root, "auth.json"),
      JSON.stringify({
        credential_pool: {
          "openai-codex": [
            {
              id: "oauth-1",
              auth_type: "oauth",
              refresh_token: "runtime-only-token",
              access_token: "runtime-access",
            },
          ],
        },
      }),
    );

    const result = getRuntimeCredentialRefreshEligibility("openai-codex");
    expect(result).toEqual({
      source: "runtime_pool",
      authType: "oauth",
      hasRefreshToken: true,
    });
    expect(JSON.stringify(result)).not.toContain("runtime-only-token");
    expect(getRuntimeProviderCredential("openai-codex")).toBe("runtime-access");
    expect(
      getRuntimeProviderCredential("openai-codex", undefined, "runtime-access"),
    ).toBeNull();
  });

  it("returns a rotated Runtime access token instead of the previous token", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-refresh-eligibility-"));
    roots.push(root);
    vi.stubEnv("HERMES_HOME", root);
    const { getRuntimeProviderCredential } = await import("./config");
    writeFileSync(
      join(root, "auth.json"),
      JSON.stringify({
        credential_pool: {
          "openai-codex": [
            {
              id: "oauth-1",
              auth_type: "oauth",
              access_token: "rotated-access",
              refresh_token: "refresh-token",
            },
          ],
        },
      }),
    );

    expect(
      getRuntimeProviderCredential("openai-codex", undefined, "old-access"),
    ).toBe("rotated-access");
  });

  it("does not mark static or malformed entries refreshable", async () => {
    const root = mkdtempSync(join(tmpdir(), "aera-refresh-eligibility-"));
    roots.push(root);
    vi.stubEnv("HERMES_HOME", root);
    const { getRuntimeCredentialRefreshEligibility } = await import("./config");
    writeFileSync(
      join(root, "auth.json"),
      JSON.stringify({
        credential_pool: {
          static: [
            { auth_type: "api_key", access_token: "sk-static" },
            { auth_type: "oauth", refresh_token: "" },
          ],
        },
      }),
    );

    expect(getRuntimeCredentialRefreshEligibility("static")).toEqual({
      source: "static_key",
      authType: "api_key",
      hasRefreshToken: false,
    });
    expect(getRuntimeCredentialRefreshEligibility("missing")).toEqual({
      source: "unknown",
      authType: "",
      hasRefreshToken: false,
    });
  });
});
