// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

describe("AgentEra control plane remains outside the Hermes adaptive core", () => {
  it("keeps the Hermes transport envelope generic and free of AgentEra control-plane imports", () => {
    const hermes = source("src/main/hermes.ts");
    expect(hermes).toContain("export interface HermesConversationEnvelope");
    expect(hermes).not.toMatch(/from ["']\.\/agentera-agent-control/);
    expect(hermes).not.toContain("LocalRuntimeBinding");
    expect(hermes).not.toContain("AgentVersion");
    expect(hermes).not.toContain("PolicySnapshot");
  });

  it("does not read, write, delete, or hash Hermes private/adaptive files in the adapter", () => {
    const adapter = source("src/main/agentera-agent-control/hermes-adapter.ts");
    expect(adapter).not.toMatch(
      /\b(?:readFile|readFileSync|writeFile|writeFileSync|rmSync|unlinkSync|readdirSync)\b/,
    );
    expect(adapter).not.toMatch(/profilePath\s*,\s*["'](?:MEMORY|USER)/);
    const digestFunction = adapter.slice(
      adapter.indexOf("export function digestToolPermissionDeclaration"),
      adapter.indexOf("function parseInstallation"),
    );
    expect(digestFunction).not.toContain("profilePath");
    expect(adapter).toContain(
      "Hermes remains the sole execution and adaptive-learning engine",
    );
  });

  it("prevents the bound path from selecting TUI or CLI while retaining both legacy branches", () => {
    const hermes = source("src/main/hermes.ts");
    expect(hermes).toContain("!envelope?.requireBoundApiTransport");
    expect(hermes).toContain(
      'throw new Error("Bound Hermes API transport is unavailable.")',
    );
    expect(hermes).toMatch(/return await sendMessageViaTuiGateway\(/);
    expect(hermes).toMatch(/return (?:await )?sendMessageViaCli\(/);
  });

  it("keeps legacy Hermes One sync separate from AgentEra versions, installations and bindings", () => {
    const legacySync = source("src/main/agent-sync.ts");
    expect(legacySync).not.toContain("agentera-agent-control");
    expect(legacySync).not.toContain("RuntimeBinding");
    expect(legacySync).not.toContain("AgentVersion");
    expect(legacySync).not.toContain("policySnapshot");
  });
});
