// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

function productionFiles(directory: string): string[] {
  return readdirSync(join(root, directory))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `${directory}/${name}`)
    .sort();
}

// @lat: [[agentera-organizations#Release gate#Product-space isolation]]
describe("Product Space selection is metadata, never a Hermes Profile switch", () => {
  it("stores only Personal, Workspace, or Organization identity", () => {
    const shared = source("src/shared/agentera-product-space.ts");
    const stored = shared.slice(
      shared.indexOf("export type StoredProductSpaceSelection"),
      shared.indexOf("export type ProductSpaceSelection"),
    );

    expect(stored).toContain('{ kind: "PERSONAL" }');
    expect(stored).toContain('{ kind: "WORKSPACE"; workspaceId: string }');
    expect(stored).toContain(
      '{ kind: "ORGANIZATION"; organizationId: string }',
    );
    expect(stored).not.toMatch(
      /Department|departmentId|Profile|profileId|Runtime|runtimeId/,
    );

    const database = source("src/main/agentera-product-space/db.ts");
    expect(database).toContain("assertOutsideHermesHome(rootPath)");
    expect(database).not.toMatch(
      /setActiveProfile|createProfile|deleteProfile|RuntimeBinding|MEMORY\.md|USER\.md|sessions\/|skills\/|curator\//,
    );
  });

  it("keeps the switcher on the single Product Space selection bridge", () => {
    const switcher = source(
      "src/renderer/src/screens/Layout/ProductSpaceSwitcher.tsx",
    );
    const selection = switcher.slice(
      switcher.indexOf("const handleSelect"),
      switcher.indexOf(
        "if (status ===",
        switcher.indexOf("const handleSelect"),
      ),
    );

    expect(selection).toContain("window.agenteraProductSpace.select");
    expect(selection.match(/agenteraProductSpace\.select/g)).toHaveLength(1);
    expect(selection).not.toMatch(
      /agenteraWorkspace\.select|window\.hermesAPI|setActiveProfile|createProfile|RuntimeBinding|localStorage|sessionStorage/,
    );
  });

  it("maps Organization to an explicit unavailable Agent context before stores or Profiles", () => {
    const productManager = source("src/main/agentera-product-space/manager.ts");
    const contextMapping = productManager.slice(
      productManager.indexOf("private contextFromSelection"),
      productManager.indexOf("private rememberAndEmit"),
    );
    expect(contextMapping).toContain('scope: "ORGANIZATION_UNAVAILABLE"');
    expect(contextMapping).not.toMatch(
      /Profile|RuntimeBinding|draft|installation|publish|install/,
    );

    const agentManager = source("src/main/agentera-agent-control/manager.ts");
    const availabilityGuard = agentManager.slice(
      agentManager.indexOf("private assetContext"),
      agentManager.indexOf("private operationContextKey"),
    );
    expect(availabilityGuard).toContain(
      'throw codedError("organization_agent_not_enabled")',
    );
    expect(
      availabilityGuard.indexOf("organization_agent_not_enabled"),
    ).toBeLessThan(availabilityGuard.indexOf("return context"));
  });

  it("keeps Product Space production code free of runtime mutation dependencies", () => {
    const forbiddenImport =
      /agentera-profile-binding|agentera-runtime-distribution|runtime-binding|hermes-adapter|profiles|sessions|skills|curator|agent-sync/;
    for (const file of productionFiles("src/main/agentera-product-space")) {
      const imports = [
        ...source(file).matchAll(/\bfrom\s+["']([^"']+)["']/g),
      ].map((match) => match[1]);
      expect(
        imports.filter((module) => forbiddenImport.test(module)),
        `${file} imported a runtime mutation dependency`,
      ).toEqual([]);
    }
  });

  it("keeps startup composition passive and legacy Workspace selection delegated", () => {
    const startup = source("src/main/app/start.ts");
    const composition = startup.slice(
      startup.indexOf("if (agenteraWorkspace && agenteraOrganization)"),
      startup.indexOf(
        "agenteraAgentControlDatabase = openAgenteraControlPlaneDatabase",
      ),
    );
    expect(composition).toContain("new AgenteraProductSpaceManager");
    expect(composition).toContain(
      "agenteraWorkspace.attachProductSpaceCoordinator(agenteraProductSpace)",
    );
    expect(composition).not.toMatch(
      /setActiveProfile|createProfile|stopActiveRuntimeContext|RuntimeBinding|runtimeDistribution/,
    );

    const workspaceManager = source("src/main/agentera-workspace/manager.ts");
    expect(workspaceManager).toContain("attachProductSpaceCoordinator(");
    expect(workspaceManager).toContain(
      "this.selectionCoordinator.readSelectedWorkspaceId(access.userId)",
    );
  });
});
