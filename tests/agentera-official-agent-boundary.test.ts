// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

function sourceTree(path: string): string {
  const absolute = join(root, path);
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => !entry.name.endsWith(".test.ts"))
    .flatMap((entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) return sourceTree(child);
      return extname(entry.name) === ".ts" ? [source(child)] : [];
    })
    .join("\n");
}

const officialChannels = [
  "agentera-agents-list-official",
  "agentera-agents-prepare-official-install",
  "agentera-agents-confirm-official-install",
  "agentera-agents-refresh-official-updates",
  "agentera-agents-apply-official-update",
] as const;

const officialPrivateStatePattern =
  /["']PLATFORM["']|officialRelease|OfficialRelease|selectedReleaseRevision|official_release|official_context|officialAgent|OfficialAgent/;

// @lat: [[agentera-self-evolution#Version and adaptive-state layers#Official managed privacy gate]]
describe("Official managed Agent privacy boundary", () => {
  it("keeps PLATFORM provenance in the control plane and USER ownership in runtime state", () => {
    const installation = source(
      "src/main/agentera-agent-control/installation-manager.ts",
    );
    const bindings = source(
      "src/main/agentera-agent-control/runtime-binding-store.ts",
    );
    const profiles = source("src/main/agentera-profile-binding.ts");

    expect(installation).toContain('scope: "PLATFORM"');
    expect(installation).toContain("officialReleaseId");
    expect(installation).toContain('profile.kind !== "fresh"');
    expect(bindings).toContain('ownerScope: "USER"');
    expect(bindings).toContain("officialReleaseRevisionId");
    expect(profiles).toContain('ownerScope: "USER"');
    expect(profiles).not.toMatch(officialPrivateStatePattern);
  });

  it("does not add official control-plane vocabulary to Hermes private stores", () => {
    const privateStores = [
      "src/main/memory.ts",
      "src/main/sessions.ts",
      "src/main/skills.ts",
      "src/main/config.ts",
      "src/main/session-attachment-store.ts",
      "src/main/session-cache.ts",
      "src/main/session-context-folder-store.ts",
      "src/main/session-continuation-store.ts",
      "src/main/session-model-override-store.ts",
      "src/main/agentera-agent-control/hermes-skill-candidate-source.ts",
    ]
      .map(source)
      .join("\n");

    expect(privateStores).not.toMatch(officialPrivateStatePattern);
    expect(privateStores).not.toMatch(
      /official-agent-service|OfficialAgentService/,
    );
  });

  it("keeps official projection read-only and outside HERMES_HOME", () => {
    const database = source("src/main/agentera-agent-control/db.ts");
    const projection = source(
      "src/main/agentera-agent-control/hermes-projection.ts",
    );
    const adapter = source("src/main/agentera-agent-control/hermes-adapter.ts");

    expect(database).toContain("assertOutsideHermesHome(rootPath)");
    expect(projection).toContain("makeReadOnly(staging)");
    expect([projection, adapter].join("\n")).not.toMatch(
      /MEMORY\.md|USER\.md|sessions\/|credentials|curator\/|\.curator/,
    );
  });

  it("does not couple official releases to Runtime distribution or Profile ownership", () => {
    expect(sourceTree("src/main/agentera-runtime-distribution")).not.toMatch(
      officialPrivateStatePattern,
    );
    expect(source("src/main/agentera-profile-binding.ts")).not.toMatch(
      /official-agent-service|OfficialAgentService|officialRelease|selectedReleaseRevision|["']PLATFORM["']/,
    );
  });

  it("keeps official traffic separate from legacy Hermes One Agent sync", () => {
    const officialPath = [
      "src/main/agentera-agent-control/client.ts",
      "src/main/agentera-agent-control/official-agent-service.ts",
      "src/main/agentera-agent-control/installation-manager.ts",
      "src/main/agentera-agent-control/manager.ts",
    ]
      .map(source)
      .join("\n")
      .toLowerCase();
    const legacySync = source("src/main/agent-sync.ts");

    expect(officialPath).not.toContain("agent-sync");
    expect(officialPath).not.toContain('"/api/agents"');
    expect(legacySync).toContain("/api/agents");
    expect(legacySync).not.toMatch(officialPrivateStatePattern);
  });

  it("exposes only the five bounded official renderer operations", () => {
    const register = source("src/main/ipc/register.ts");
    const preload = source("src/preload/index.ts");
    const contract = source("src/main/agentera-agent-control/ipc-contract.ts");
    const parserStart = contract.indexOf(
      "export function parseConfirmOfficialAgentInstallInput",
    );
    const parserEnd = contract.indexOf(
      "export function parseRetryPendingInstallationInput",
      parserStart,
    );
    const parser = contract.slice(parserStart, parserEnd);

    expect(parserStart).toBeGreaterThan(0);
    for (const channel of officialChannels) {
      expect(register.match(new RegExp(`"${channel}"`, "g"))).toHaveLength(1);
      expect(preload.match(new RegExp(`"${channel}"`, "g"))).toHaveLength(1);
    }
    expect(parser).toContain('["installHandle", "confirmation"]');
    expect(parser).not.toMatch(
      /ownerScope|platformId|userId|deviceId|role|channel|versionId|releaseId|profile|token|key|policy|manifest|bundle|memory|session|skill|learning/i,
    );
  });
});
