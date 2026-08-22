// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

describe("Aera control plane remains outside the Hermes adaptive core", () => {
  it("keeps the Hermes transport envelope generic and free of Aera control-plane imports", () => {
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
      "Aera Runtime remains the sole execution and adaptive-learning engine",
    );
  });

  it("prevents the bound path from selecting TUI or CLI while retaining both legacy branches", () => {
    const hermes = source("src/main/hermes.ts");
    expect(hermes).toContain("!envelope?.requireBoundApiTransport");
    expect(hermes).toContain("const boundTransportReady =");
    expect(hermes).toContain("await startGatewayWithRecovery(profile, 30_000)");
    expect(hermes).toContain(
      "throw new Error(BOUND_API_TRANSPORT_UNAVAILABLE)",
    );
    expect(hermes).toMatch(/return await sendMessageViaTuiGateway\(/);
    expect(hermes).toMatch(/return (?:await )?sendMessageViaCli\(/);
  });

  // @lat: [[agentera-runtime-distribution#Desktop TUI backend lifecycle#Port reuse across restarts]]
  it("launches the send-message gateway through recovery only", () => {
    const register = source("src/main/ipc/register.ts");
    const start = register.indexOf(
      "await runAgentModelSegmentPreflight(segmentLifecycle,",
    );
    expect(start).toBeGreaterThan(-1);
    const preflight = register.slice(
      start,
      register.indexOf('if (conn.mode === "ssh" && conn.ssh)', start),
    );
    expect(preflight.length).toBeGreaterThan(0);
    expect(preflight).toContain("await startGatewayWithRecovery(");
    // Recovery reconciles the port and spawns itself. A plain launch in front of
    // it makes recovery SIGTERM the gateway it just created, and the replacement
    // then races the dying process for the same port.
    expect(preflight).not.toContain("startGatewayDetailed(");
  });

  it("keeps legacy Hermes One sync separate from Aera versions, installations and bindings", () => {
    const legacySync = source("src/main/agent-sync.ts");
    expect(legacySync).not.toContain("agentera-agent-control");
    expect(legacySync).not.toContain("RuntimeBinding");
    expect(legacySync).not.toContain("AgentVersion");
    expect(legacySync).not.toContain("policySnapshot");
  });
});
