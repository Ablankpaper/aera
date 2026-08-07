import { describe, expect, it } from "vitest";

import { RUNTIME_INSTALL_WAIT_OPTIONS } from "./e2e/support/agentera-agent-control-harness";

describe("Agent Control Runtime installation wait contract", () => {
  it("uses the installation-aware 180 second poll window", () => {
    expect(RUNTIME_INSTALL_WAIT_OPTIONS).toEqual({
      timeout: 180_000,
      intervals: [250, 500, 1_000],
    });
  });
});
