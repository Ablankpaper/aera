import { describe, expect, it } from "vitest";
import { isInternalBetaDesktopVersion } from "./update-channel";

describe("desktop update channel", () => {
  // @lat: [[desktop-updates#Desktop Updates]]
  it("keeps internal Beta builds off the public GitHub release updater", () => {
    expect(isInternalBetaDesktopVersion("0.7.4-internal-beta.4")).toBe(true);
    expect(isInternalBetaDesktopVersion(" 0.7.4-internal-beta.4 ")).toBe(true);

    expect(isInternalBetaDesktopVersion("0.7.4")).toBe(false);
    expect(isInternalBetaDesktopVersion("0.7.4-beta.3")).toBe(false);
    expect(isInternalBetaDesktopVersion("0.7.4-internal-beta")).toBe(false);
    expect(isInternalBetaDesktopVersion("internal-beta.3")).toBe(false);
  });
});
