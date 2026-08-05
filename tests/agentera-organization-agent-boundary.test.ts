// @vitest-environment node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

const channels = [
  "agentera-agents-prepare-organization-submission",
  "agentera-agents-confirm-organization-submission",
  "agentera-agents-list-organization-submissions",
  "agentera-agents-get-organization-submission",
  "agentera-agents-prepare-organization-review",
  "agentera-agents-confirm-organization-review",
  "agentera-agents-prepare-organization-withdrawal",
  "agentera-agents-confirm-organization-withdrawal",
] as const;

describe("Organization Agent renderer boundary", () => {
  it("registers and invokes every handle-only Organization Agent channel once", () => {
    const register = source("src/main/ipc/register.ts");
    const preload = source("src/preload/index.ts");
    for (const channel of channels) {
      expect(register.match(new RegExp(`"${channel}"`, "g"))).toHaveLength(1);
      expect(preload.match(new RegExp(`"${channel}"`, "g"))).toHaveLength(1);
    }
  });

  // @lat: [[agentera-organizations#AgentEra Organization and Organization Agent V1#Organization Agent approval#Draft working-copy lifecycle]]
  it("keeps restart-safe draft lifecycle actions in the real Electron gate", () => {
    const e2e = source("tests/e2e/agentera-organization-agent.e2e.ts");
    for (const required of [
      '"updateDraft"',
      "UNPUBLISHED_AFTER_SUBMISSION",
      "Published with unpublished changes",
      '"deleteDraft"',
      '"archiveInstallation"',
    ]) {
      expect(e2e).toContain(required);
    }
    expect(e2e).toContain("await owner.device.app.close()");
  });

  it("does not accept renderer assertions of Organization ownership or runtime state", () => {
    const contract = source("src/main/agentera-agent-control/ipc-contract.ts");
    const start = contract.indexOf(
      "export function parseConfirmOrganizationSubmissionInput",
    );
    const end = contract.indexOf("function safeFindingPath", start);
    const parsers = contract.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(parsers).toContain("parseConfirmOrganizationReviewInput");
    expect(parsers).toContain("parseConfirmOrganizationWithdrawalInput");
    expect(parsers).not.toMatch(
      /organizationId|ownerScope|actorUserId|tenantId|role|expectedRevision|accessToken|profilePath|runtimeProfileId|memory|session/i,
    );
  });

  it("keeps Organization publication references free of package and Hermes data", () => {
    const database = source("src/main/agentera-agent-control/db.ts");
    const table = database.slice(
      database.indexOf(
        "CREATE TABLE IF NOT EXISTS organization_agent_submission_refs",
      ),
      database.indexOf(
        "CREATE TABLE IF NOT EXISTS encrypted_backup_restores",
        database.indexOf(
          "CREATE TABLE IF NOT EXISTS organization_agent_submission_refs",
        ),
      ),
    );
    expect(table).toContain("cloud_submission_id");
    expect(table).toContain("content_digest");
    expect(table).not.toMatch(
      /manifest|bundle|prompt|token|credential|profile|memory|conversation|session|skill|curator/i,
    );
  });

  it("leaves Hermes execution and private learning outside Organization IPC", () => {
    const adapter = source("src/main/agentera-agent-control/hermes-adapter.ts");
    const isolatedRuntime = [
      "src/main/agentera-agent-control/hermes-projection.ts",
      "src/main/agentera-agent-control/runtime-binding-store.ts",
      "src/main/agentera-profile-binding.ts",
    ]
      .map(source)
      .join("\n");
    expect(adapter).not.toMatch(
      /organization-publication-service|prepareOrganizationReview|confirmOrganizationSubmission|ownerScope\s*:\s*["']ORGANIZATION["']/,
    );
    expect(isolatedRuntime).not.toMatch(
      /organization-publication-service|prepareOrganizationReview|confirmOrganizationSubmission|\bsourceOrganizationId\b|\borganizationId\b|ownerScope\s*:\s*["']ORGANIZATION["']/,
    );
  });

  it("stops Organization ownership at installation while keeping runtime and Profile USER-scoped", () => {
    const installation = source(
      "src/main/agentera-agent-control/installation-manager.ts",
    );
    const adapter = source("src/main/agentera-agent-control/hermes-adapter.ts");
    const bindings = source(
      "src/main/agentera-agent-control/runtime-binding-store.ts",
    );
    const profiles = source("src/main/agentera-profile-binding.ts");

    expect(installation).toContain(
      'sourceScope: "USER" | "WORKSPACE" | "ORGANIZATION"',
    );
    expect(installation).toContain("sourceOrganizationId");
    expect(adapter).toContain('ownerScope: "USER"');
    expect(adapter).toContain('binding.ownerScope !== "USER"');
    expect(bindings).toContain('ownerScope: "USER"');
    expect(bindings).toContain('input.ownerScope !== "USER"');
    expect(profiles).toContain('ownerScope: "USER"');
    expect([bindings, profiles].join("\n")).not.toMatch(
      /\bsourceOrganizationId\b|\borganizationId\b|ownerScope\s*:\s*["']ORGANIZATION["']/,
    );
    expect(adapter).toContain("sourceOrganizationId");
    expect(adapter).not.toMatch(/ownerScope\s*:\s*["']ORGANIZATION["']/);
  });

  it("stages immutable Organization assets outside HERMES_HOME without touching private learning", () => {
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
});
