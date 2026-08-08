import { afterEach, describe, expect, it } from "vitest";
import {
  parseAgenteraRechargePublicUrl,
  resolveAgenteraRechargePublicUrl,
} from "./config";

describe("Agentera recharge URL", () => {
  afterEach(() => {
    // The resolver tests are pure; this keeps the process environment untouched
    // for the rest of the main-process suite.
  });

  it("uses the production Petoi fallback", () => {
    expect(resolveAgenteraRechargePublicUrl({})).toBe("https://petoi.cn/");
  });

  it("prefers runtime configuration over build configuration", () => {
    expect(
      resolveAgenteraRechargePublicUrl({
        runtimePublicUrl: "https://runtime.example/recharge",
        buildPublicUrl: "https://build.example/recharge",
      }),
    ).toBe("https://runtime.example/recharge");
  });

  it("canonicalizes a configured HTTPS URL", () => {
    expect(parseAgenteraRechargePublicUrl(" https://petoi.cn/path ")).toBe(
      "https://petoi.cn/path",
    );
  });

  it("rejects unsafe recharge URLs", () => {
    expect(() => parseAgenteraRechargePublicUrl("javascript:alert(1)")).toThrow(
      "requires HTTPS",
    );
    expect(() =>
      parseAgenteraRechargePublicUrl("https://user:pass@petoi.cn"),
    ).toThrow("requires HTTPS");
  });
});
