import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyInstallTarget } from "../src/main/installer";

// Pre-install inspection (issue #272): classify what the installer will do
// to the target `hermes-agent` directory so the renderer can warn first.
describe("classifyInstallTarget", () => {
  it("reports a fresh install when nothing is at the target", () => {
    expect(classifyInstallTarget(false, false)).toBe("fresh");
    // repoIsGitRepo is meaningless when the directory doesn't exist.
    expect(classifyInstallTarget(false, true)).toBe("fresh");
  });

  it("reports an in-place update for an existing valid git checkout", () => {
    expect(classifyInstallTarget(true, true)).toBe("update");
  });

  it("reports a destructive replace when the dir is not a git repo", () => {
    // install.sh / install.ps1 delete-and-reclone a non-repo directory.
    expect(classifyInstallTarget(true, false)).toBe("replace");
  });
});

describe("authenticated local Runtime preparation", () => {
  it("routes start-install only to the packaged Seed installer", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "main", "ipc", "register.ts"),
      "utf8",
    );
    const start = source.indexOf('ipcMain.handle("start-install"');
    const end = source.indexOf("// Pre-install inspection", start);
    const handler = source.slice(start, end);

    expect(handler).toContain("runPackagedSeedInstall");
    expect(handler).not.toMatch(/\bawait\s+runInstall\s*\(/);
    expect(handler).not.toMatch(
      /curl|Invoke-WebRequest|github\.com|git\s+clone/i,
    );
  });
});
