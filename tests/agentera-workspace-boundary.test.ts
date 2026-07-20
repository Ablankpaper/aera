// @vitest-environment node

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

function workspaceDomainFiles(): string[] {
  const mainDirectory = join(root, "src/main/agentera-workspace");
  const mainFiles = readdirSync(mainDirectory)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => relative(root, join(mainDirectory, name)));
  return [
    ...mainFiles,
    "src/shared/agentera-workspace.ts",
    "src/renderer/src/screens/Layout/WorkspaceSwitcher.tsx",
    "src/renderer/src/screens/Layout/WorkspaceManagementDialog.tsx",
    "src/renderer/src/components/WorkspaceInvitationGate.tsx",
  ];
}

function importedModules(contents: string): string[] {
  const modules: string[] = [];
  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of contents.matchAll(pattern)) modules.push(match[1]);
  }
  return modules;
}

// @lat: [[agentera-workspaces#Release gate#Hermes compatibility boundary]]
describe("AgentEra Workspace remains outside the Hermes adaptive core", () => {
  it("has no Workspace-domain import path into Hermes execution or private state", () => {
    const forbiddenDependency =
      /(?:^|\/)(?:agent-sync|agentera-agent-control|agentera-profile-binding|hermes|profiles|profile-meta|sessions|skills|curator|installer|runtime-distribution|runtime-manager|runtime-binding)(?:$|[/.])/i;

    const violations = workspaceDomainFiles().flatMap((file) =>
      importedModules(source(file))
        .filter((module) => forbiddenDependency.test(module))
        .map((module) => `${file} -> ${module}`),
    );

    expect(violations).toEqual([]);
  });

  it("keeps the Workspace cache and public state free of secrets and Hermes-private fields", () => {
    const database = source("src/main/agentera-workspace/db.ts");
    const schema = database.slice(
      database.indexOf("CREATE TABLE workspace_cache"),
      database.indexOf("PRAGMA user_version"),
    );
    expect(schema).not.toMatch(
      /\b(?:token|invite_url|api_key|credential|profile_path|memory|user_file|session|skill|curator|runtime_binding)\b/i,
    );
    expect(database).toContain('databasePath: join(rootPath, "workspace.db")');
    expect(database).toContain("assertOutsideHermesHome");

    const shared = source("src/shared/agentera-workspace.ts");
    const publicState = shared.slice(
      shared.indexOf("export type AgenteraSpaceContext"),
      shared.indexOf("export type AgenteraWorkspaceErrorCode"),
    );
    expect(publicState).not.toMatch(
      /\b(?:token|inviteUrl|apiKey|credential|profilePath|memory|session|skill|curator|runtimeBinding)\b/i,
    );
  });

  it("limits product-space selection to the dedicated Workspace namespace", () => {
    const switcher = source(
      "src/renderer/src/screens/Layout/WorkspaceSwitcher.tsx",
    );
    const selection = switcher.slice(
      switcher.indexOf("const handleSelect"),
      switcher.indexOf("return (", switcher.indexOf("const handleSelect")),
    );
    expect(selection).toContain("window.agenteraWorkspace.select");
    expect(selection.match(/agenteraWorkspace\.select/g)).toHaveLength(1);
    expect(selection).not.toMatch(
      /(?:setActiveProfile|createProfile|deleteProfile|sendMessage|RuntimeBinding|agenteraAgentControl|agentSync|localStorage|sessionStorage)/,
    );

    const startup = source("src/main/app/start.ts");
    const workspaceComposition = startup.slice(
      startup.indexOf("let agenteraWorkspaceDatabase"),
      startup.indexOf("const ownerSwitchCoordinator"),
    );
    expect(workspaceComposition).toContain("new AgenteraWorkspaceManager");
    expect(workspaceComposition).not.toMatch(
      /(?:ProfileBinding|agenteraAgentControl|runtimeDistribution|stopActiveRuntimeContext|sendMessage)/,
    );
  });

  it("does not extend the legacy Hermes One Agent sync protocol", () => {
    const legacySync = source("src/main/agent-sync.ts");
    expect(legacySync).toContain('"/api/agents"');
    expect(legacySync).not.toContain("agentera-workspace");

    const workspaceSources = workspaceDomainFiles()
      .map((file) => source(file))
      .join("\n");
    expect(workspaceSources).not.toContain("agent-sync");
    expect(workspaceSources).not.toContain("/api/agents");
  });

  it("leaves Agent control and RuntimeBinding V1 strictly USER-owned", () => {
    const sharedControl = source("src/shared/agentera-agent-control.ts");
    const publisher = source("src/main/agentera-agent-control/publisher.ts");
    const bindings = source(
      "src/main/agentera-agent-control/runtime-binding-store.ts",
    );
    const adapter = source("src/main/agentera-agent-control/hermes-adapter.ts");
    const controlPlane = [sharedControl, publisher, bindings, adapter].join(
      "\n",
    );

    expect(sharedControl).toContain('targetScope: "USER"');
    expect(publisher).toContain('targetScope: "USER"');
    expect(bindings).toContain('ownerScope: "USER"');
    expect(bindings).toContain('input.ownerScope !== "USER"');
    expect(adapter).toContain('binding.ownerScope !== "USER"');
    expect(controlPlane).not.toMatch(
      /(?:ownerScope|targetScope)\s*:\s*["']WORKSPACE["']/,
    );
  });

  it("keeps the pre-existing RuntimeBinding compatibility test unchanged", () => {
    const path = "tests/agentera-runtime-binding.test.ts";
    const baseline = execFileSync("git", ["show", `main:${path}`], {
      cwd: root,
      encoding: "utf8",
    });
    expect(source(path)).toBe(baseline);
  });
});
