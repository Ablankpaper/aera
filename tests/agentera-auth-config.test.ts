// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  agenteraCloudUrl,
  parseAgenteraCloudOrigin,
  resolveAgenteraCloudOrigin,
} from "../src/main/agentera-auth/config";

describe("AgentEra cloud endpoint configuration", () => {
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
});
