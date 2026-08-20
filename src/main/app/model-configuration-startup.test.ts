import { describe, expect, it } from "vitest";
import { prepareModelConfigurationAfterAuth } from "./model-configuration-startup";

describe("prepareModelConfigurationAfterAuth", () => {
  it("does not prepare model configuration until authentication has settled", async () => {
    const events: string[] = [];

    const result = await prepareModelConfigurationAfterAuth(
      async () => {
        events.push("auth-start");
        await Promise.resolve();
        events.push("auth-ready");
        return { status: "authenticated" as const };
      },
      async () => {
        events.push("owner-ready");
      },
      async (state) => {
        events.push(`prepare-${state.status}`);
        return "ready";
      },
    );

    expect(result).toBe("ready");
    expect(events).toEqual([
      "auth-start",
      "auth-ready",
      "owner-ready",
      "prepare-authenticated",
    ]);
  });
});
