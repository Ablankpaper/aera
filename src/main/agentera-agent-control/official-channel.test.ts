// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveOfficialAgentChannel } from "./official-channel";

describe("resolveOfficialAgentChannel", () => {
  it("forces packaged builds onto the stable channel", () => {
    expect(
      resolveOfficialAgentChannel({
        isPackaged: true,
        environment: { AGENTERA_OFFICIAL_AGENT_CHANNEL: "internal" },
      }),
    ).toBe("stable");
  });

  it("defaults unpackaged builds to internal and accepts only trusted channels", () => {
    expect(
      resolveOfficialAgentChannel({ isPackaged: false, environment: {} }),
    ).toBe("internal");
    expect(
      resolveOfficialAgentChannel({
        isPackaged: false,
        environment: { AGENTERA_OFFICIAL_AGENT_CHANNEL: "" },
      }),
    ).toBe("internal");
    expect(
      resolveOfficialAgentChannel({
        isPackaged: false,
        environment: { AGENTERA_OFFICIAL_AGENT_CHANNEL: "stable" },
      }),
    ).toBe("stable");
    expect(() =>
      resolveOfficialAgentChannel({
        isPackaged: false,
        environment: { AGENTERA_OFFICIAL_AGENT_CHANNEL: "beta" },
      }),
    ).toThrow("Invalid official Agent channel.");
  });
});
