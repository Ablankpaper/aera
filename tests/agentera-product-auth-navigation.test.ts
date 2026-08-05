import { describe, expect, it } from "vitest";

import {
  productAuthorizationLanding,
  productAuthCloudOrigin,
} from "./e2e/support/agentera-product-auth-harness";

describe("product authorization navigation", () => {
  it("accepts the select-account redirect directly to its login continuation", () => {
    const next = encodeURIComponent("/authorize?request_id=opaque-request");

    expect(
      productAuthorizationLanding(
        new URL(`${productAuthCloudOrigin}/login?next=${next}`),
      ),
    ).toBe("login");
  });

  it("keeps the authorization page as a compatible intermediate landing", () => {
    expect(
      productAuthorizationLanding(
        new URL(
          `${productAuthCloudOrigin}/authorize?request_id=opaque-request`,
        ),
      ),
    ).toBe("authorize");
  });

  it("rejects login pages without an authorization continuation", () => {
    expect(
      productAuthorizationLanding(new URL(`${productAuthCloudOrigin}/login`)),
    ).toBeNull();
    expect(
      productAuthorizationLanding(
        new URL(`${productAuthCloudOrigin}/login?next=%2Fdevices`),
      ),
    ).toBeNull();
    expect(
      productAuthorizationLanding(
        new URL(
          `${productAuthCloudOrigin}/login?next=${encodeURIComponent("http://[")}`,
        ),
      ),
    ).toBeNull();
    expect(
      productAuthorizationLanding(
        new URL(
          "https://example.invalid/login?next=%2Fauthorize%3Frequest_id%3Dx",
        ),
      ),
    ).toBeNull();
  });
});
