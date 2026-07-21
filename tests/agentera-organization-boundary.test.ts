// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

function productionTypeScriptFiles(relativeDirectory: string): string[] {
  return readdirSync(join(root, relativeDirectory), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => relative(root, join(root, relativeDirectory, entry.name)))
    .sort();
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

// @lat: [[agentera-organizations#Release gate#Hermes compatibility boundary]]
describe("Organization Foundation stays outside Hermes private runtime state", () => {
  it("has no Organization-domain import path into Hermes execution or adaptive state", () => {
    const organizationFiles = [
      ...productionTypeScriptFiles("src/main/agentera-organization"),
      "src/shared/agentera-organization.ts",
      "src/renderer/src/components/OrganizationInvitationGate.tsx",
      "src/renderer/src/screens/Layout/OrganizationManagementDialog.tsx",
      "src/renderer/src/screens/Layout/ProductSpaceSwitcher.tsx",
    ];
    const forbiddenDependency =
      /(?:^|\/)(?:agent-sync|agentera-agent-control|agentera-profile-binding|hermes|profiles|profile-meta|sessions|skills|curator|installer|runtime-distribution|runtime-manager|runtime-binding)(?:$|[/.])/i;

    const violations = organizationFiles.flatMap((file) =>
      importedModules(source(file))
        .filter((module) => forbiddenDependency.test(module))
        .map((module) => `${file} -> ${module}`),
    );

    expect(violations).toEqual([]);
  });

  it("keeps cached Organization state free of invitation secrets and private runtime fields", () => {
    const database = source("src/main/agentera-organization/db.ts");
    const schema = database.slice(
      database.indexOf("CREATE TABLE organization_summaries"),
      database.indexOf("PRAGMA user_version"),
    );
    expect(schema).not.toMatch(
      /\b(?:token|token_digest|invite_url|api_key|credential|profile_path|memory|user_file|conversation|session|skill|curator|runtime_binding)\b/i,
    );
    expect(database).toContain(
      'databasePath: join(rootPath, "organization.db")',
    );
    expect(database).toContain("assertOutsideHermesHome");

    const ipc = source("src/main/agentera-organization/ipc-contract.ts");
    const publicState = ipc.slice(
      ipc.indexOf("export function serializeOrganizationPublicState"),
      ipc.indexOf("const STABLE_CODES"),
    );
    expect(publicState).not.toMatch(
      /\b(?:token|inviteUrl|apiKey|credential|profilePath|memory|conversation|session|skill|curator|runtimeBinding)\b/,
    );
    const invitationProjection = ipc.slice(
      ipc.indexOf("export function serializeOrganizationInvitationCreation"),
      ipc.indexOf("export function serializeOrganizationInvitationAcceptance"),
    );
    expect(invitationProjection).toContain("secretReplayable: false");
    expect(invitationProjection).toContain(
      "`agentera://organization-invitation#${token}`",
    );
  });

  it("keeps Organization UI away from Hermes and browser persistence APIs", () => {
    const ui = [
      "src/renderer/src/components/OrganizationInvitationGate.tsx",
      "src/renderer/src/screens/Layout/OrganizationManagementDialog.tsx",
      "src/renderer/src/screens/Layout/ProductSpaceSwitcher.tsx",
    ]
      .map(source)
      .join("\n");

    expect(ui).not.toMatch(
      /window\.hermesAPI|setActiveProfile|createProfile|deleteProfile|RuntimeBinding|agentSync|localStorage|sessionStorage/,
    );
  });

  it("does not add Organization ownership to isolated Hermes and Runtime files", () => {
    const adapter = source("src/main/agentera-agent-control/hermes-adapter.ts");
    const isolatedFiles = [
      "src/main/agentera-agent-control/hermes-projection.ts",
      "src/main/agentera-agent-control/runtime-binding-store.ts",
      "src/main/agentera-profile-binding.ts",
      "src/main/sessions.ts",
      "src/main/skills.ts",
      "src/main/agent-sync.ts",
      ...productionTypeScriptFiles("src/main/agentera-runtime-distribution"),
    ];
    const forbidden =
      /agentera-organization|\bsourceOrganizationId\b|\borganizationId\b|ownerScope\s*:\s*["']ORGANIZATION["']|\/api\/v1\/organizations\/.+agent-definitions/;

    expect(adapter).not.toMatch(
      /agentera-organization|ownerScope\s*:\s*["']ORGANIZATION["']|\/api\/v1\/organizations\/.+agent-definitions/,
    );

    for (const file of isolatedFiles) {
      expect(
        source(file),
        `${file} gained Organization runtime ownership`,
      ).not.toMatch(forbidden);
    }
  });

  it("keeps Organization OpenAPI schemas free of Hermes private identifiers", () => {
    const generated = source("src/shared/agentera-cloud-api.generated.ts");
    const organizationSchemas = generated.slice(
      generated.indexOf("readonly OrganizationAuditEvent:"),
      generated.indexOf("readonly PasswordChangeRequest:"),
    );
    const contract = source("contracts/agentera-cloud.openapi.yaml");
    const contractSchemas = contract.slice(
      contract.indexOf("    OrganizationRole:"),
      contract.indexOf("    SigningKeySet:"),
    );
    const forbidden =
      /\b(?:profile_path|runtime_binding|memory|user_file|conversation|session|learned_skill|curator|credential|api_key)\b/i;

    expect(organizationSchemas).toContain("readonly OrganizationSummary:");
    expect(contractSchemas).toContain("OrganizationSummary:");
    expect(organizationSchemas).not.toMatch(forbidden);
    expect(contractSchemas).not.toMatch(forbidden);
  });

  it("declares the deterministic three-account Organization E2E command", () => {
    const packageJson = JSON.parse(source("package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["test:e2e:organization"]).toBe(
      "playwright test tests/e2e/agentera-organization.e2e.ts",
    );
  });
});
