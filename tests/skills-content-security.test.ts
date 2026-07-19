import { describe, expect, it, vi } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";

const execFileSyncSpy = vi.hoisted(() => vi.fn(() => Buffer.from("")));

const { TEST_HOME, TEST_REPO } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  const home = path.join(os.tmpdir(), `hermes-skill-content-${Date.now()}`);
  return {
    TEST_HOME: home,
    TEST_REPO: path.join(home, "hermes-agent"),
  };
});

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: TEST_HOME,
  getEnhancedPath: () => "",
}));

vi.mock("../src/main/agentera-runtime-distribution/invocation", () => ({
  getRuntimeInvocation: () => ({
    source: "external",
    version: null,
    sourceCommit: null,
    root: TEST_REPO,
    python: "python",
    workingDirectory: TEST_REPO,
    bundledSkillsDirectory: `${TEST_REPO}/skills`,
    webDistDirectory: `${TEST_REPO}/hermes_cli/web_dist`,
    cliArgs: (args: string[] = []) => ["-m", "hermes_cli.main", ...args],
    environment: (base: Record<string, string> = {}) => ({ ...base }),
  }),
}));

vi.mock("child_process", () => ({
  execFileSync: execFileSyncSpy,
  default: { execFileSync: execFileSyncSpy },
}));

import { getSkillContent, installSkill } from "../src/main/skills";

function writeSkill(root: string, content: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), content);
  return root;
}

describe("getSkillContent path validation", () => {
  it("executes named-profile skill installs through the live Runtime invocation", () => {
    execFileSyncSpy.mockClear();

    expect(installSkill("planner", "work")).toEqual({ success: true });
    expect(execFileSyncSpy).toHaveBeenCalledWith(
      "python",
      [
        "-m",
        "hermes_cli.main",
        "-p",
        "work",
        "skills",
        "install",
        "planner",
        "--yes",
      ],
      expect.objectContaining({ cwd: TEST_REPO }),
    );
  });

  it("allows default-profile installed skills", () => {
    const skillPath = writeSkill(
      join(TEST_HOME, "skills", "productivity", "planner"),
      "default skill",
    );

    expect(getSkillContent(skillPath)).toBe("default skill");
  });

  it("allows named-profile installed skills", () => {
    const skillPath = writeSkill(
      join(TEST_HOME, "profiles", "work_1-prod", "skills", "ops", "deploy"),
      "profile skill",
    );

    expect(getSkillContent(skillPath)).toBe("profile skill");
  });

  it("allows bundled skills from the hermes-agent repo", () => {
    const skillPath = writeSkill(
      join(TEST_HOME, "hermes-agent", "skills", "writing", "brief"),
      "bundled skill",
    );

    expect(getSkillContent(skillPath)).toBe("bundled skill");
  });

  it("blocks sibling directory prefix tricks", () => {
    const skillPath = writeSkill(
      join(TEST_HOME, "skills-evil", "productivity", "planner"),
      "not allowed",
    );

    expect(getSkillContent(skillPath)).toBe("");
  });

  it("blocks invalid profile names", () => {
    const skillPath = writeSkill(
      join(TEST_HOME, "profiles", "-bad", "skills", "ops", "deploy"),
      "not allowed",
    );

    expect(getSkillContent(skillPath)).toBe("");
  });

  it("blocks arbitrary absolute paths outside Hermes roots", () => {
    const skillPath = writeSkill(
      join(TEST_HOME, "..", `outside-${Date.now()}`, "skill"),
      "not allowed",
    );

    expect(getSkillContent(skillPath)).toBe("");
  });
});
