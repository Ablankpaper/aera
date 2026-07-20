// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const controlDirectory = "src/main/agentera-agent-control";

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function candidateProductionFiles(): string[] {
  return readdirSync(join(root, controlDirectory), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        (entry.name.startsWith("experience-candidate-") ||
          entry.name === "hermes-skill-candidate-source.ts"),
    )
    .map((entry) => `${controlDirectory}/${entry.name}`)
    .sort();
}

function between(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing boundary start: ${start}`).toBeGreaterThanOrEqual(
    0,
  );
  expect(endIndex, `missing boundary end: ${end}`).toBeGreaterThan(startIndex);
  return contents.slice(startIndex, endIndex);
}

// @lat: [[agentera-self-evolution#Release gate#Controlled promotion boundary]]
// @lat: [[agentera-agent-control-plane#Release gate#ExperienceCandidate boundary]]
describe("ExperienceCandidate remains an explicit adapter outside Hermes private state", () => {
  it("allows physical Profile reads only through the read-only Hermes Skill adapter", () => {
    const files = candidateProductionFiles();
    const profileConsumers = files.filter((file) =>
      /\bprofilePath\b/.test(source(file)),
    );
    expect(profileConsumers).toEqual([
      `${controlDirectory}/experience-candidate-service.ts`,
      `${controlDirectory}/hermes-skill-candidate-source.ts`,
    ]);

    const service = source(
      `${controlDirectory}/experience-candidate-service.ts`,
    );
    expect(service).not.toMatch(/from ["']node:fs/);
    expect(service).toContain("this.options.source.listEligible(profilePath)");
    expect(service).toContain(
      "this.options.source.readCandidate(profilePath, input.skillName)",
    );

    const adapter = source(
      `${controlDirectory}/hermes-skill-candidate-source.ts`,
    );
    expect(adapter).toContain(
      'import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"',
    );
    expect(adapter).not.toMatch(
      /\b(?:writeFile|writeFileSync|appendFile|rm|rmSync|unlink|unlinkSync|rename|renameSync|chmod|chmodSync)\b/,
    );

    for (const file of files) {
      if (profileConsumers.includes(file)) continue;
      expect(source(file), `${file} gained a Profile path input`).not.toMatch(
        /\bprofilePath\b/,
      );
    }

    const dlpPrivatePathVocabulary = files.filter((file) =>
      /HERMES_HOME|\.hermes\[\/\\\\\]profiles/.test(source(file)),
    );
    expect(dlpPrivatePathVocabulary).toEqual([
      `${controlDirectory}/experience-candidate-contract.ts`,
    ]);
    expect(source(dlpPrivatePathVocabulary[0])).not.toMatch(
      /from ["']node:fs|\b(?:readFile|readFileSync|readdir|readdirSync|lstat|lstatSync)\s*\(/,
    );
  });

  it("forbids candidate-domain imports from Hermes mutation, sync, session, Runtime distribution, and binding modules", () => {
    const forbiddenImport =
      /from ["'][^"']*(?:memory|skills|agent-sync|sessions|curator|agentera-runtime-distribution|runtime-binding-store)[^"']*["']/i;
    for (const file of candidateProductionFiles()) {
      const contents = source(file);
      expect(
        contents,
        `${file} gained a forbidden core dependency`,
      ).not.toMatch(forbiddenImport);
      expect(
        contents,
        `${file} gained Workspace-owned runtime state`,
      ).not.toMatch(
        /ownerScope\s*[:=]\s*["']WORKSPACE["']|profileOwnerScope|workspaceOwned(?:Profile|Installation)|LocalRuntimeBinding/,
      );
      expect(contents).not.toContain("/api/agents");
    }

    for (const isolated of [
      "src/main/memory.ts",
      "src/main/skills.ts",
      "src/main/sessions.ts",
      "src/main/agent-sync.ts",
    ]) {
      expect(
        source(isolated),
        `${isolated} imports candidate behavior`,
      ).not.toMatch(/experience-candidate|ExperienceCandidate/);
    }

    const runtimeDistribution = readdirSync(
      join(root, "src/main/agentera-runtime-distribution"),
      { withFileTypes: true },
    )
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts"),
      )
      .map((entry) =>
        source(`src/main/agentera-runtime-distribution/${entry.name}`),
      )
      .join("\n");
    expect(runtimeDistribution).not.toMatch(
      /experience-candidate|ExperienceCandidate/,
    );
  });

  it("keeps every RuntimeBinding and physical Profile USER-owned", () => {
    const bindings = source(
      "src/main/agentera-agent-control/runtime-binding-store.ts",
    );
    const profiles = source("src/main/agentera-profile-binding.ts");
    const adapter = source("src/main/agentera-agent-control/hermes-adapter.ts");

    for (const contents of [bindings, profiles, adapter]) {
      expect(contents).not.toMatch(
        /ownerScope\s*:\s*["']WORKSPACE["']|workspaceOwned(?:Profile|Installation)/,
      );
    }
    expect(bindings).toContain('ownerScope: "USER"');
    expect(bindings).toContain('input.ownerScope !== "USER"');
    expect(profiles).toContain('ownerScope: "USER"');
    expect(adapter).toContain('binding.ownerScope !== "USER"');
  });

  it("locks exact candidate mutation fields and rejects ownership, path, token, origin, and DLP override fields", () => {
    const ipc = source(`${controlDirectory}/ipc-contract.ts`);
    const candidateParsers = between(
      ipc,
      "export function parsePrepareExperienceCandidateInput",
      "function safeFindingPath",
    );
    expect(candidateParsers).toContain('["installationId", "skillName"]');
    expect(candidateParsers).toContain('["candidateId", "confirmation"]');
    expect(candidateParsers).toContain(
      '["candidateId", "decision", "reasonCode", "safeNote"]',
    );
    expect(candidateParsers).toContain('["importHandle", "confirmation"]');
    expect(candidateParsers).toContain('"submit-selected-skill"');
    expect(candidateParsers).toContain('"apply-approved-skill-to-latest"');
    expect(candidateParsers).not.toMatch(
      /workspaceId|workspace_id|ownerScope|owner_scope|profilePath|profile_path|sourcePath|source_path|accessToken|refreshToken|cloudOrigin|dlpOverride|dlpVersion/,
    );

    const preload = source("src/preload/index.ts");
    const candidatePreload = between(
      preload,
      "listEligibleExperienceSkills:",
      "onStateChanged:",
    );
    expect(candidatePreload).not.toMatch(
      /workspaceId|workspace_id|ownerScope|owner_scope|profilePath|profile_path|sourcePath|source_path|accessToken|refreshToken|cloudOrigin|dlpOverride|dlpVersion/,
    );

    const shared = source("src/shared/agentera-agent-control.ts");
    const rendererMutations = between(
      shared,
      "export interface PrepareExperienceCandidateInput",
      "export type ExperienceCandidateLocalStatus",
    );
    expect(rendererMutations).not.toMatch(
      /workspaceId|workspace_id|ownerScope|owner_scope|profilePath|profile_path|sourcePath|source_path|accessToken|refreshToken|cloudOrigin|dlpOverride|dlpVersion/,
    );
  });

  it("declares the isolated ExperienceCandidate E2E release command", () => {
    const packageJson = JSON.parse(source("package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["test:e2e:experience-candidate"]).toBe(
      "npm run build && playwright test tests/e2e/agentera-experience-candidate.e2e.ts",
    );
  });
});
