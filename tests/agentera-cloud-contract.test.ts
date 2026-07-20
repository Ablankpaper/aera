// @vitest-environment node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pinnedContract = join(root, "contracts/agentera-cloud.openapi.yaml");
const pinnedCandidateVectors = join(
  root,
  "contracts/experience-candidate-v1-vectors.json",
);
const generatedTypes = join(root, "src/shared/agentera-cloud-api.generated.ts");
const cloudClient = join(root, "src/main/agentera-auth/client.ts");
const siblingContract = process.env.AGENTERA_CLOUD_CONTRACT_SOURCE
  ? resolve(root, process.env.AGENTERA_CLOUD_CONTRACT_SOURCE)
  : resolve(root, "../aera-cloud/api/openapi.yaml");
const siblingCandidateVectors = join(
  dirname(siblingContract),
  "experience-candidate-v1-vectors.json",
);

function generatedSchemaBlock(source: string, schema: string): string {
  const start = source.indexOf(`    readonly ${schema}: {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n    readonly ", start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

describe("AgentEra cloud contract pin", () => {
  it("forces byte-hashed contract artifacts to LF on every checkout", () => {
    const attributes = execFileSync(
      "git",
      [
        "check-attr",
        "eol",
        "--",
        "contracts/agentera-cloud.openapi.yaml",
        "contracts/experience-candidate-v1-vectors.json",
        "src/shared/agentera-cloud-api.generated.ts",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(attributes.trim().split(/\r?\n/)).toEqual([
      "contracts/agentera-cloud.openapi.yaml: eol: lf",
      "contracts/experience-candidate-v1-vectors.json: eol: lf",
      "src/shared/agentera-cloud-api.generated.ts: eol: lf",
    ]);
  });

  it("pins the reviewed sibling cloud contract byte-for-byte when available", () => {
    expect(existsSync(pinnedContract)).toBe(true);
    if (existsSync(siblingContract)) {
      expect(readFileSync(pinnedContract)).toEqual(
        readFileSync(siblingContract),
      );
      expect(existsSync(pinnedCandidateVectors)).toBe(true);
      expect(existsSync(siblingCandidateVectors)).toBe(true);
      expect(readFileSync(pinnedCandidateVectors)).toEqual(
        readFileSync(siblingCandidateVectors),
      );
    }
  });

  it("keeps generated TypeScript deterministic and current", () => {
    expect(existsSync(generatedTypes)).toBe(true);
    const before = readFileSync(generatedTypes, "utf8");
    execFileSync(
      process.execPath,
      ["scripts/generate-agentera-cloud-types.mjs"],
      { cwd: root, stdio: "pipe" },
    );
    const first = readFileSync(generatedTypes, "utf8");
    execFileSync(
      process.execPath,
      ["scripts/generate-agentera-cloud-types.mjs"],
      { cwd: root, stdio: "pipe" },
    );
    expect(readFileSync(generatedTypes, "utf8")).toBe(first);
    expect(first).toBe(before);
    execFileSync(
      process.execPath,
      ["scripts/check-agentera-cloud-contract.mjs"],
      {
        cwd: root,
        env: { ...process.env, AGENTERA_SKIP_SIBLING_CONTRACT: "1" },
        stdio: "pipe",
      },
    );
  }, 20_000);

  it("uses the generated schemas at every desktop token endpoint", () => {
    const source = readFileSync(cloudClient, "utf8");
    expect(source).toContain(
      'import type { components } from "../../shared/agentera-cloud-api.generated";',
    );
    expect(source).toContain(
      'type RawTokenResponse = components["schemas"]["TokenResponse"]',
    );
    expect(source).toMatch(
      /type\s+AuthorizationCodeExchangeRequest\s*=\s*components\["schemas"\]\["AuthorizationCodeExchangeRequest"\]/,
    );
    expect(source).toContain(
      'type RefreshTokenRequest = components["schemas"]["RefreshTokenRequest"]',
    );
    expect(source).toMatch(
      /type\s+DeviceSelfRevokeRequest\s*=\s*components\["schemas"\]\["DeviceSelfRevokeRequest"\]/,
    );
    expect(source).not.toMatch(/interface\s+RawTokenResponse/);
  });

  it("generates the reviewed Agent control schemas without a cloud draft", () => {
    const source = readFileSync(generatedTypes, "utf8");
    for (const schema of [
      "AgentDefinition",
      "AgentVersion",
      "AgentPolicySnapshot",
      "AgentInstallation",
      "RuntimeBindingRecord",
      "PublishInitialAgentRequest",
      "PublishNextAgentVersionRequest",
    ]) {
      expect(source).toContain(`${schema}:`);
    }
    expect(source).not.toContain("AgentDraft");
    expect(source).not.toContain("agent_draft");
  });

  it("generates strict Workspace control schemas without Hermes private state", () => {
    const source = readFileSync(generatedTypes, "utf8");
    for (const schema of [
      "WorkspaceSummary",
      "WorkspaceMember",
      "WorkspaceInvitation",
      "WorkspaceInvitationCreation",
      "WorkspaceInvitationAcceptance",
      "WorkspaceListResponse",
      "WorkspaceMemberListResponse",
      "WorkspaceInvitationListResponse",
      "CreateWorkspaceRequest",
      "RenameWorkspaceRequest",
      "WorkspaceRevisionRequest",
      "ChangeWorkspaceMemberRoleRequest",
      "AcceptWorkspaceInvitationRequest",
    ]) {
      expect(source).toContain(`${schema}:`);
    }
    for (const forbidden of [
      "owner_scope",
      "profile_path",
      "credential",
      "api_key",
      "raw_token",
    ]) {
      expect(source).not.toMatch(
        new RegExp(`readonly\\s+(?:"${forbidden}"|${forbidden})\\??:`),
      );
    }
  });

  it("generates the reviewed ExperienceCandidate schemas without local identity or paths", () => {
    const source = readFileSync(generatedTypes, "utf8");
    const candidateSchemas = [
      "ExperienceCandidateAsset",
      "ExperienceCandidateBundle",
      "ExperienceCandidateSummary",
      "ExperienceCandidateDetail",
      "ExperienceCandidateListResponse",
      "ExperienceCandidateFinding",
      "ExperienceCandidateErrorEnvelope",
      "SubmitExperienceCandidateRequest",
      "ReviewExperienceCandidateRequest",
    ];
    for (const schema of candidateSchemas) {
      expect(source).toContain(`${schema}:`);
    }
    const candidateSource = candidateSchemas
      .map((schema) => generatedSchemaBlock(source, schema))
      .join("\n");
    for (const forbidden of [
      "owner_scope",
      "profile_path",
      "runtime_profile_id",
      "source_path",
      "submitted_from_device_id",
      "dlp_override",
    ]) {
      expect(candidateSource).not.toMatch(
        new RegExp(`readonly\\s+(?:"${forbidden}"|${forbidden})\\??:`),
      );
    }
  });
});
