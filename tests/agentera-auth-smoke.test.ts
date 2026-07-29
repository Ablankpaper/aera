// @vitest-environment node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface SmokeStep {
  name: string;
  command: string;
  args: string[];
  cwd: string;
}

describe("Aera authentication smoke gate", () => {
  it("pins every malicious callback and contract check in its execution plan", () => {
    const desktopRoot = resolve(import.meta.dirname, "..");
    const output = execFileSync(
      process.execPath,
      [resolve(desktopRoot, "scripts/agentera-auth-smoke.mjs"), "--plan"],
      {
        cwd: desktopRoot,
        encoding: "utf8",
      },
    );
    const steps = JSON.parse(output) as SmokeStep[];

    expect(steps.map((step) => step.name)).toEqual([
      "pinned cloud contract",
      "desktop loopback and client boundaries",
      "cloud OAuth malicious cases",
    ]);
    expect(steps[1].args.join(" ")).toContain(
      "tests/agentera-auth-loopback.test.ts",
    );
    expect(steps[2].args.join(" ")).toContain(
      "TestBeginAuthorizationRequiresFixedClientS256AndExactLoopbackRedirect",
    );
    expect(steps[2].args.join(" ")).toContain(
      "TestExchangeRequiresPKCEAndDeviceProofAndConsumesCodeOnce",
    );
  });
});
