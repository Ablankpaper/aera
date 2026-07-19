import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePackagedRuntimeSeedDirectory } from "../src/main/agentera-runtime-distribution/seed-path";

describe("packaged Runtime Seed path", () => {
  // @lat: [[agentera-runtime-distribution#Native packaging gate]]
  it("uses the application Resources directory in packaged builds", () => {
    expect(
      resolvePackagedRuntimeSeedDirectory({
        isPackaged: true,
        resourcesPath: "/Applications/AgentEra Studio.app/Contents/Resources",
        workingDirectory: "/source/aera",
        developmentOverride: "/tmp/development-seed",
      }),
    ).toBe(
      join(
        "/Applications/AgentEra Studio.app/Contents/Resources",
        "agentera-runtime-seed",
      ),
    );
  });

  it("uses an explicit absolute Seed directory in development", () => {
    expect(
      resolvePackagedRuntimeSeedDirectory({
        isPackaged: false,
        resourcesPath: "/electron/Resources",
        workingDirectory: "/source/aera",
        developmentOverride: "/tmp/development-seed",
      }),
    ).toBe(resolve("/tmp/development-seed"));
  });

  it("defaults development builds to the source staging directory", () => {
    expect(
      resolvePackagedRuntimeSeedDirectory({
        isPackaged: false,
        resourcesPath: "/electron/Resources",
        workingDirectory: "/source/aera",
      }),
    ).toBe(join("/source/aera", "resources", "agentera-runtime-seed"));
  });

  it("rejects a relative development override", () => {
    expect(() =>
      resolvePackagedRuntimeSeedDirectory({
        isPackaged: false,
        resourcesPath: "/electron/Resources",
        workingDirectory: "/source/aera",
        developmentOverride: "resources/agentera-runtime-seed",
      }),
    ).toThrow(/must be an absolute path/i);
  });
});
