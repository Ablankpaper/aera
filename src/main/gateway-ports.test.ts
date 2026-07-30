// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { firstBindablePort } from "./gateway-ports";

describe("gateway port availability", () => {
  it("skips ports occupied by another local Aera instance", async () => {
    const probe = vi.fn(async (port: number) => port === 8646);

    await expect(firstBindablePort([8644, 8645, 8646], probe)).resolves.toBe(
      8646,
    );
    expect(probe.mock.calls.map(([port]) => port)).toEqual([8644, 8645, 8646]);
  });

  it("returns null when the reserved range has no bindable port", async () => {
    await expect(
      firstBindablePort([8644, 8645], async () => false),
    ).resolves.toBeNull();
  });
});
