// @vitest-environment node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pinnedContract = join(root, "contracts/agentera-cloud.openapi.yaml");
const generatedTypes = join(root, "src/shared/agentera-cloud-api.generated.ts");
const cloudClient = join(root, "src/main/agentera-auth/client.ts");
const siblingContract = resolve(root, "../aera-cloud/api/openapi.yaml");

describe("AgentEra cloud contract pin", () => {
  it("forces byte-hashed contract artifacts to LF on every checkout", () => {
    const attributes = execFileSync(
      "git",
      [
        "check-attr",
        "eol",
        "--",
        "contracts/agentera-cloud.openapi.yaml",
        "src/shared/agentera-cloud-api.generated.ts",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(attributes.trim().split(/\r?\n/)).toEqual([
      "contracts/agentera-cloud.openapi.yaml: eol: lf",
      "src/shared/agentera-cloud-api.generated.ts: eol: lf",
    ]);
  });

  it("pins the reviewed sibling cloud contract byte-for-byte when available", () => {
    expect(existsSync(pinnedContract)).toBe(true);
    if (existsSync(siblingContract)) {
      expect(readFileSync(pinnedContract)).toEqual(
        readFileSync(siblingContract),
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
});
