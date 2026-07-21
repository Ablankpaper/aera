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
        "PRAGMA user_version",
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
    const runtime = [
      "src/main/agentera-agent-control/hermes-adapter.ts",
      "src/main/agentera-agent-control/hermes-projection.ts",
      "src/main/agentera-agent-control/runtime-binding-store.ts",
      "src/main/agentera-profile-binding.ts",
    ]
      .map(source)
      .join("\n");
    expect(runtime).not.toMatch(
      /organization-publication-service|prepareOrganizationReview|confirmOrganizationSubmission|ownerScope\s*:\s*["']ORGANIZATION["']/,
    );
  });
});
