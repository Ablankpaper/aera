// @vitest-environment node

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_EXPERIENCE_CANDIDATE_FILE_BYTES } from "./experience-candidate-contract";
import {
  HermesSkillCandidateSourceError,
  ReadOnlyHermesSkillCandidateSource,
  type HermesSkillCandidateFileIO,
} from "./hermes-skill-candidate-source";

let root = "";
let profilePath = "";
let skillsPath = "";

function writeUsage(records: Record<string, unknown>): void {
  writeFileSync(join(skillsPath, ".usage.json"), JSON.stringify(records));
}

function writeSkill(
  relativeDirectory: string,
  options: {
    name?: string;
    description?: string;
    files?: Record<string, string | Buffer>;
  } = {},
): string {
  const skillDirectory = join(skillsPath, ...relativeDirectory.split("/"));
  mkdirSync(skillDirectory, { recursive: true });
  const name = options.name ?? relativeDirectory.split("/").at(-1)!;
  const description = options.description ?? `${name} description`;
  writeFileSync(
    join(skillDirectory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
  );
  for (const [path, content] of Object.entries(options.files ?? {})) {
    const destination = join(skillDirectory, ...path.split("/"));
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, content);
  }
  return skillDirectory;
}

function treeDigest(path: string): string {
  const hash = createHash("sha256");
  const visit = (current: string): void => {
    const stat = lstatSync(current);
    const name = relative(path, current).split("\\").join("/");
    hash.update(name);
    hash.update(`:${stat.mode & 0o777}:${stat.size}:`);
    if (stat.isSymbolicLink()) {
      hash.update(`link:${readlinkSync(current)}`);
      return;
    }
    if (stat.isFile()) {
      hash.update(readFileSync(current));
      return;
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(current).sort()) {
        visit(join(current, child));
      }
    }
  };
  visit(path);
  return hash.digest("hex");
}

function nodeIO(): HermesSkillCandidateFileIO {
  return {
    lstat: (path) => lstatSync(path),
    realpath: (path) => realpathSync.native(path),
    readdir: (path) => readdirSync(path),
    readFile: (path) => readFileSync(path),
  };
}

function expectIneligible(action: () => unknown): void {
  expect(action).toThrowError(
    new HermesSkillCandidateSourceError("candidate_source_ineligible"),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentera-hermes-candidate-source-"));
  profilePath = join(root, "selected-profile");
  skillsPath = join(profilePath, "skills");
  mkdirSync(skillsPath, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ReadOnlyHermesSkillCandidateSource", () => {
  it("lists only persisted agent-created records and supports both provenance markers", () => {
    writeSkill("modern", { description: "Modern learned workflow" });
    writeSkill("category/legacy", { description: "Legacy learned workflow" });
    writeSkill("manual");
    writeSkill("untracked");
    writeUsage({
      modern: { created_by: "agent", state: "active", use_count: 17 },
      legacy: { agent_created: true, view_count: 22 },
      manual: { created_by: null, state: "active" },
    });

    const before = treeDigest(profilePath);
    expect(
      new ReadOnlyHermesSkillCandidateSource().listEligible(profilePath),
    ).toEqual([
      { skillName: "legacy", description: "Legacy learned workflow" },
      { skillName: "modern", description: "Modern learned workflow" },
    ]);
    expect(treeDigest(profilePath)).toBe(before);
  });

  it("excludes archived, bundled, hub, external, projected, duplicate, missing, and deep-layout Skills", () => {
    writeSkill("archived");
    writeSkill("bundled");
    writeSkill("hub-category/hubbed");
    writeSkill("agentera.12345678.v1.projected", {
      name: "agentera.12345678.v1.projected",
    });
    writeSkill("duplicate-one", { name: "duplicate" });
    writeSkill("category/duplicate-two", { name: "duplicate" });
    writeSkill("too/deep/nested", { name: "nested" });
    mkdirSync(join(skillsPath, ".archive", "old"), { recursive: true });
    writeFileSync(join(skillsPath, ".archive", "old", "SKILL.md"), "# old\n");
    const outside = join(root, "external-skills", "external");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "---\nname: external\n---\n");
    symlinkSync(outside, join(skillsPath, "external"));
    mkdirSync(join(skillsPath, ".hub"), { recursive: true });
    writeFileSync(join(skillsPath, ".bundled_manifest"), "bundled:abc123\n");
    writeFileSync(
      join(skillsPath, ".hub", "lock.json"),
      JSON.stringify({
        version: 1,
        installed: {
          hubbed: { install_path: "hub-category/hubbed" },
        },
      }),
    );
    writeUsage({
      archived: { created_by: "agent", state: "archived" },
      bundled: { created_by: "agent", state: "active" },
      hubbed: { created_by: "agent", state: "active" },
      external: { created_by: "agent", state: "active" },
      "agentera.12345678.v1.projected": {
        created_by: "agent",
        state: "active",
      },
      duplicate: { created_by: "agent", state: "active" },
      missing: { created_by: "agent", state: "active" },
      nested: { created_by: "agent", state: "active" },
      old: { created_by: "agent", state: "active" },
    });

    const before = treeDigest(root);
    const source = new ReadOnlyHermesSkillCandidateSource();
    expect(source.listEligible(profilePath)).toEqual([]);
    for (const name of [
      "archived",
      "bundled",
      "hubbed",
      "external",
      "agentera.12345678.v1.projected",
      "duplicate",
      "missing",
      "nested",
      "old",
    ]) {
      expectIneligible(() => source.readCandidate(profilePath, name));
    }
    expect(treeDigest(root)).toBe(before);
  });

  it("reads one exact flat or category Skill beneath only the selected Profile", () => {
    writeSkill("flat-skill", {
      files: {
        "references/checklist.md": "# Checklist\n",
        "notes.txt": "note\n",
      },
    });
    writeSkill("writing/weekly-summary", {
      files: { "references/template.md": "# Template\n" },
    });
    writeSkill("unrelated", { files: { "secret.txt": "do not include\n" } });
    writeUsage({
      "flat-skill": { created_by: "agent" },
      "weekly-summary": { created_by: "agent" },
      unrelated: { created_by: "agent" },
    });
    const otherProfile = join(root, "other-profile");
    const otherSkills = join(otherProfile, "skills");
    mkdirSync(otherSkills, { recursive: true });
    writeFileSync(
      join(otherSkills, ".usage.json"),
      JSON.stringify({ "other-only": { created_by: "agent" } }),
    );
    mkdirSync(join(otherSkills, "other-only"));
    writeFileSync(
      join(otherSkills, "other-only", "SKILL.md"),
      "---\nname: other-only\n---\n",
    );

    const before = treeDigest(root);
    const source = new ReadOnlyHermesSkillCandidateSource();
    const flat = source.readCandidate(profilePath, "flat-skill");
    expect(flat.sourceRelativePath).toBe("skills/flat-skill");
    expect(flat.bundle.skillName).toBe("flat-skill");
    expect(
      flat.bundle.assets.map((asset) => [asset.path, asset.mediaType]),
    ).toEqual([
      ["skills/flat-skill/SKILL.md", "text/markdown"],
      ["skills/flat-skill/notes.txt", "text/plain"],
      ["skills/flat-skill/references/checklist.md", "text/markdown"],
    ]);
    expect(JSON.stringify(flat)).not.toContain(".usage.json");
    expect(JSON.stringify(flat)).not.toContain("use_count");
    expect(JSON.stringify(flat)).not.toContain("unrelated");
    expect(JSON.stringify(flat)).not.toContain(profilePath);

    const nested = source.readCandidate(profilePath, "weekly-summary");
    expect(nested.sourceRelativePath).toBe("skills/writing/weekly-summary");
    expectIneligible(() => source.readCandidate(profilePath, "other-only"));
    expect(treeDigest(root)).toBe(before);
  });

  it.each([
    ["hidden file", ".private", "secret\n"],
    ["dependency tree", "node_modules/pkg/index.txt", "package\n"],
    ["cache tree", "__pycache__/state.txt", "state\n"],
    ["binary bytes", "payload.txt", Buffer.from([0, 1, 2, 3])],
    ["invalid UTF-8", "broken.txt", Buffer.from([0xc3, 0x28])],
  ])("rejects %s without modifying source bytes", (_label, path, content) => {
    writeSkill("unsafe", { files: { [path]: content } });
    writeUsage({ unsafe: { created_by: "agent" } });
    const before = treeDigest(profilePath);
    expectIneligible(() =>
      new ReadOnlyHermesSkillCandidateSource().readCandidate(
        profilePath,
        "unsafe",
      ),
    );
    expect(treeDigest(profilePath)).toBe(before);
  });

  it("rejects symlinks, special entries, and realpath escape before reading their bytes", () => {
    const skillDirectory = writeSkill("unsafe", {
      files: { "safe.txt": "safe\n", "special.txt": "must not read\n" },
    });
    writeUsage({ unsafe: { created_by: "agent" } });
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(skillDirectory, "linked.txt"));
    const beforeLinkFailure = treeDigest(root);
    expectIneligible(() =>
      new ReadOnlyHermesSkillCandidateSource().readCandidate(
        profilePath,
        "unsafe",
      ),
    );
    expect(treeDigest(root)).toBe(beforeLinkFailure);

    rmSync(join(skillDirectory, "linked.txt"));
    const beforeInjectedFailures = treeDigest(root);
    const base = nodeIO();
    const specialPath = realpathSync.native(
      join(skillDirectory, "special.txt"),
    );
    let specialRead = false;
    const specialIO: HermesSkillCandidateFileIO = {
      ...base,
      lstat: (path) =>
        path === specialPath
          ? {
              isFile: () => false,
              isDirectory: () => false,
              isSymbolicLink: () => false,
              size: 12,
            }
          : base.lstat(path),
      readFile: (path) => {
        if (path === specialPath) specialRead = true;
        return base.readFile(path);
      },
    };
    expectIneligible(() =>
      new ReadOnlyHermesSkillCandidateSource(specialIO).readCandidate(
        profilePath,
        "unsafe",
      ),
    );
    expect(specialRead).toBe(false);

    const escapedPath = realpathSync.native(join(skillDirectory, "safe.txt"));
    let escapedRead = false;
    const escapeIO: HermesSkillCandidateFileIO = {
      ...base,
      realpath: (path) =>
        path === escapedPath ? outside : base.realpath(path),
      readFile: (path) => {
        if (path === escapedPath) escapedRead = true;
        return base.readFile(path);
      },
    };
    expectIneligible(() =>
      new ReadOnlyHermesSkillCandidateSource(escapeIO).readCandidate(
        profilePath,
        "unsafe",
      ),
    );
    expect(escapedRead).toBe(false);
    expect(treeDigest(root)).toBe(beforeInjectedFailures);
  });

  it("enforces file-count and byte limits before returning a candidate", () => {
    writeSkill("oversized", {
      files: {
        "large.txt": Buffer.alloc(
          MAX_EXPERIENCE_CANDIDATE_FILE_BYTES + 1,
          0x61,
        ),
      },
    });
    const manyFiles = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [
        `references/file-${index}.md`,
        `# ${index}\n`,
      ]),
    );
    writeSkill("too-many", { files: manyFiles });
    writeUsage({
      oversized: { created_by: "agent" },
      "too-many": { agent_created: true },
    });
    const before = treeDigest(profilePath);
    const source = new ReadOnlyHermesSkillCandidateSource();
    expectIneligible(() => source.readCandidate(profilePath, "oversized"));
    expectIneligible(() => source.readCandidate(profilePath, "too-many"));
    expect(treeDigest(profilePath)).toBe(before);
  });

  it("remains read-only when an injected filesystem read fails", () => {
    const skillDirectory = writeSkill("flaky", {
      files: { "references/checklist.md": "# Checklist\n" },
    });
    writeUsage({ flaky: { created_by: "agent" } });
    const before = treeDigest(profilePath);
    const base = nodeIO();
    const failingPath = realpathSync.native(
      join(skillDirectory, "references", "checklist.md"),
    );
    const io: HermesSkillCandidateFileIO = {
      ...base,
      readFile: (path) => {
        if (path === failingPath) throw new Error("injected read failure");
        return base.readFile(path);
      },
    };

    expectIneligible(() =>
      new ReadOnlyHermesSkillCandidateSource(io).readCandidate(
        profilePath,
        "flaky",
      ),
    );
    expect(treeDigest(profilePath)).toBe(before);
  });

  it("rejects non-absolute, symlinked, and missing Profile roots", () => {
    const source = new ReadOnlyHermesSkillCandidateSource();
    expectIneligible(() => source.listEligible("relative-profile"));
    expectIneligible(() => source.listEligible(join(root, "missing")));
    const link = join(root, "profile-link");
    symlinkSync(profilePath, link);
    expect(isAbsolute(link)).toBe(true);
    expectIneligible(() => source.listEligible(link));
  });
});
