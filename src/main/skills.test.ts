// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ hermesHome: "" }));

vi.mock("./installer", () => ({
  get HERMES_HOME() {
    return testState.hermesHome;
  },
  getEnhancedPath: () => process.env.PATH ?? "",
}));

import { listInstalledSkills } from "./skills";

describe("listInstalledSkills", () => {
  beforeEach(() => {
    testState.hermesHome = mkdtempSync(join(tmpdir(), "aera-skills-"));
  });

  afterEach(() => {
    rmSync(testState.hermesHome, { recursive: true, force: true });
  });

  it("lists a flat Hermes Skill directly beneath the Profile skills root", () => {
    const skillPath = join(testState.hermesHome, "skills", "research");
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(
      join(skillPath, "SKILL.md"),
      "---\nname: research\ndescription: Local research workflow\n---\n",
      "utf8",
    );

    expect(listInstalledSkills("default")).toEqual([
      {
        name: "research",
        category: "",
        description: "Local research workflow",
        path: skillPath,
      },
    ]);
  });
});
