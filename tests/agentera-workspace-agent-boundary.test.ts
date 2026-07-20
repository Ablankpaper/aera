// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function productionTypeScriptFiles(relativeDirectory: string): string[] {
  return readdirSync(join(root, relativeDirectory), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => `${relativeDirectory}/${entry.name}`)
    .sort();
}

// @lat: [[agentera-agent-control-plane#Release gate#Workspace Agent isolation]]
// @lat: [[agentera-workspaces#Release gate#Workspace Agent runtime boundary]]
describe("Workspace Agent assets remain outside Hermes private runtime state", () => {
  it("keeps Workspace ownership vocabulary inside the allowlisted Agent asset layer", () => {
    const allowed = new Set([
      "src/main/agentera-agent-control/client.ts",
      "src/main/agentera-agent-control/db.ts",
      "src/main/agentera-agent-control/draft-store.ts",
      "src/main/agentera-agent-control/experience-candidate-importer.ts",
      "src/main/agentera-agent-control/experience-candidate-service.ts",
      "src/main/agentera-agent-control/experience-candidate-store.ts",
      "src/main/agentera-agent-control/installation-manager.ts",
      "src/main/agentera-agent-control/ipc-contract.ts",
      "src/main/agentera-agent-control/manager.ts",
      "src/main/agentera-agent-control/publisher.ts",
    ]);
    const ownershipVocabulary =
      /\bAgentAssetContext\b|\bsourceWorkspaceId\b|\bworkspaceId\b|["']WORKSPACE["']/;

    for (const file of productionTypeScriptFiles(
      "src/main/agentera-agent-control",
    )) {
      if (!ownershipVocabulary.test(source(file))) continue;
      expect(
        allowed,
        `${file} crosses the Workspace asset allowlist`,
      ).toContain(file);
    }
  });

  it("rejects Workspace ownership from Hermes, RuntimeBinding, Profile, sessions, Skills, Curator, and Runtime distribution", () => {
    const isolatedFiles = [
      "src/main/agentera-agent-control/hermes-adapter.ts",
      "src/main/agentera-agent-control/hermes-projection.ts",
      "src/main/agentera-agent-control/runtime-binding-store.ts",
      "src/main/agentera-profile-binding.ts",
      "src/main/sessions.ts",
      "src/main/skills.ts",
      "src/main/agent-sync.ts",
      ...productionTypeScriptFiles("src/main/agentera-runtime-distribution"),
    ];
    const forbidden =
      /agentera-workspace|\bAgentAssetContext\b|\bsourceWorkspaceId\b|\bworkspaceId\b|ownerScope\s*:\s*["']WORKSPACE["']|\/api\/v1\/workspaces\/.+agent-definitions/;

    for (const file of isolatedFiles) {
      expect(
        source(file),
        `${file} gained Workspace runtime ownership`,
      ).not.toMatch(forbidden);
    }
  });

  it("keeps every local RuntimeBinding and physical Profile USER-owned", () => {
    const bindings = source(
      "src/main/agentera-agent-control/runtime-binding-store.ts",
    );
    const adapter = source("src/main/agentera-agent-control/hermes-adapter.ts");
    const profiles = source("src/main/agentera-profile-binding.ts");

    expect(bindings).toContain('ownerScope: "USER"');
    expect(bindings).toContain('input.ownerScope !== "USER"');
    expect(adapter).toContain('binding.ownerScope !== "USER"');
    expect(adapter).toContain('ownerScope: "USER"');
    expect(profiles).toContain('ownerScope: "USER"');
    expect([bindings, adapter, profiles].join("\n")).not.toMatch(
      /ownerScope\s*:\s*["']WORKSPACE["']/,
    );
  });

  it("stages signed assets outside HERMES_HOME and makes the projection read-only", () => {
    const database = source("src/main/agentera-agent-control/db.ts");
    const projection = source(
      "src/main/agentera-agent-control/hermes-projection.ts",
    );

    expect(database).toContain("assertOutsideHermesHome(rootPath)");
    expect(projection).toContain("canonicalizeAgentVersionContent");
    expect(projection).toContain("makeReadOnly(staging)");
    expect(projection).not.toMatch(
      /MEMORY\.md|USER\.md|sessions\/|credentials|curator\/|\.curator/,
    );
  });

  it("does not extend legacy Hermes One sync or Agent mutation IPC with Workspace ownership", () => {
    const legacy = source("src/main/agent-sync.ts");
    const preload = source("src/preload/index.ts");
    const namespace = preload.slice(
      preload.indexOf("const agenteraAgentsAPI"),
      preload.indexOf("if (process.contextIsolated)"),
    );
    const ipcContract = source(
      "src/main/agentera-agent-control/ipc-contract.ts",
    );
    const installParser = ipcContract.slice(
      ipcContract.indexOf("export function parseInstallVersionInput"),
      ipcContract.indexOf("export function parseClaimVersionInput"),
    );

    expect(legacy).not.toContain("/api/v1/workspaces");
    expect(legacy).not.toMatch(/workspace_id|owner_scope/);
    expect(namespace).not.toMatch(/workspaceId|workspace_id|ownerScope|role/);
    expect(installParser).toContain(
      '["definitionId", "versionId", "profileName"]',
    );
    expect(installParser).not.toMatch(
      /workspaceId|workspace_id|ownerScope|role/,
    );
  });

  it("declares the deterministic Workspace Agent E2E release command", () => {
    const packageJson = JSON.parse(source("package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["test:e2e:workspace-agent"]).toBe(
      "npm run build && playwright test tests/e2e/agentera-workspace-agent.e2e.ts",
    );
  });
});
