import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  INTERNAL_BETA_UPDATE_KEY_ID,
  INTERNAL_BETA_UPDATE_PUBLIC_KEYS,
  isInternalBetaDesktopVersion,
} from "./update-channel";

describe("desktop update channel", () => {
  // @lat: [[desktop-updates#Desktop Updates]]
  it("routes only numbered internal Beta builds to the private update channel", () => {
    expect(isInternalBetaDesktopVersion("0.7.4-internal-beta.5")).toBe(true);
    expect(isInternalBetaDesktopVersion(" 0.7.4-internal-beta.5 ")).toBe(true);

    expect(isInternalBetaDesktopVersion("0.7.4")).toBe(false);
    expect(isInternalBetaDesktopVersion("0.7.4-beta.3")).toBe(false);
    expect(isInternalBetaDesktopVersion("0.7.4-internal-beta")).toBe(false);
    expect(isInternalBetaDesktopVersion("0.7.4-internal-beta.0")).toBe(false);
    expect(isInternalBetaDesktopVersion("internal-beta.3")).toBe(false);
  });

  it("pins the same Desktop update trust root as the release verifier", async () => {
    const reviewed = await readFile(
      resolve("build/desktop-update-signing-public.pem"),
      "utf8",
    );
    expect(
      INTERNAL_BETA_UPDATE_PUBLIC_KEYS.get(INTERNAL_BETA_UPDATE_KEY_ID),
    ).toBe(reviewed);
  });
});
