// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { AgentEditableManifestV3 } from "../../shared/agentera-agent-control";
import { createDefaultAgentManifest } from "../../renderer/src/screens/Agents/agentDraftDefaults";
import {
  canonicalizeEditableAgent,
  decodeEditableAgentManifest,
} from "./manifest";

function manifestV3(): AgentEditableManifestV3 {
  return {
    schemaVersion: 3,
    identity: { systemPrompt: "Use only approved capabilities." },
    assets: [],
    modelPolicy: {
      mode: "user_select",
      allowedProviders: [],
      allowedModels: [],
    },
    mcpRequirements: [
      {
        logicalName: "docs-read",
        tools: ["files.read"],
        required: false,
        permissionReason: "Read selected documents",
      },
      {
        logicalName: "calendar-write",
        tools: ["calendar.read", "calendar.create"],
        required: true,
        permissionReason: "Create approved calendar events",
      },
    ],
    tools: {
      allowed: ["files.read", "calendar.read", "calendar.create"],
      denied: ["shell.exec"],
    },
    dependencies: [],
    runtimeCompatibility: {
      minimumVersion: "0.18.2-agentera.1",
      maximumVersionExclusive: null,
    },
  };
}

describe("Agent Manifest V3", () => {
  // @lat: [[agentera-agent-control-plane#Agent Manifest V3 capability contract]]
  it("round-trips and canonicalizes logical MCP requirements without connection data", () => {
    const input = manifestV3();
    const decoded = decodeEditableAgentManifest(
      Buffer.from(JSON.stringify(input), "utf8"),
    );
    expect(decoded).toEqual(input);

    const canonical = canonicalizeEditableAgent(input, []);
    expect(canonical.manifestBytes.toString("utf8")).toBe(
      '{"assets":[],"dependencies":[],"identity":{"system_prompt":"Use only approved capabilities."},"mcp_requirements":[{"logical_name":"calendar-write","permission_reason":"Create approved calendar events","required":true,"tools":["calendar.create","calendar.read"]},{"logical_name":"docs-read","permission_reason":"Read selected documents","required":false,"tools":["files.read"]}],"model_policy":{"allowed_models":[],"allowed_providers":[],"mode":"user_select"},"runtime_compatibility":{"maximum_version_exclusive":null,"minimum_version":"v0.18.2-agentera.1"},"schema_version":3,"tools":{"allowed":["calendar.create","calendar.read","files.read"],"denied":["shell.exec"]}}',
    );
    expect(canonical.normalizedManifest).toEqual({
      ...manifestV3(),
      mcpRequirements: [
        manifestV3().mcpRequirements[1],
        manifestV3().mcpRequirements[0],
      ].map((requirement) => ({
        ...requirement,
        tools: [...requirement.tools].sort(),
      })),
      tools: {
        allowed: ["calendar.create", "calendar.read", "files.read"],
        denied: ["shell.exec"],
      },
      runtimeCompatibility: {
        minimumVersion: "v0.18.2-agentera.1",
        maximumVersionExclusive: null,
      },
    });
    expect(canonical.manifestBytes.toString("utf8")).not.toMatch(
      /url|command|args|env|headers|token|auth|credential_ref|profile_path|local_path/,
    );
  });

  it("rejects invalid or secret-bearing logical MCP requirements", () => {
    const cases: Array<[string, (value: AgentEditableManifestV3) => void]> = [
      [
        "duplicate logical name",
        (value) => {
          value.mcpRequirements[1].logicalName = "docs-read";
        },
      ],
      [
        "duplicate tool",
        (value) => {
          value.mcpRequirements[0].tools = ["files.read", "files.read"];
        },
      ],
      [
        "empty tool",
        (value) => {
          value.mcpRequirements[0].tools = [];
        },
      ],
      [
        "tool outside allowlist",
        (value) => {
          value.mcpRequirements[0].tools = ["files.delete"];
        },
      ],
      [
        "empty permission reason",
        (value) => {
          value.mcpRequirements[0].permissionReason = "";
        },
      ],
      [
        "oversized UTF-8 reason",
        (value) => {
          value.mcpRequirements[0].permissionReason = "界".repeat(101);
        },
      ],
      [
        "secret permission reason",
        (value) => {
          value.mcpRequirements[0].permissionReason =
            "OPENAI_API_KEY=sk-this-is-a-real-looking-secret-value";
        },
      ],
      [
        "too many requirements",
        (value) => {
          value.mcpRequirements = Array.from({ length: 33 }, (_, index) => ({
            logicalName: `requirement-${index}`,
            tools: ["files.read"],
            required: true,
            permissionReason: "Read selected documents",
          }));
        },
      ],
      [
        "too many tools",
        (value) => {
          const tools = Array.from(
            { length: 129 },
            (_, index) => `tool.${index}`,
          );
          value.tools.allowed = tools;
          value.mcpRequirements[0].tools = tools;
        },
      ],
    ];

    for (const [name, mutate] of cases) {
      const input = manifestV3();
      mutate(input);
      expect(() => canonicalizeEditableAgent(input, []), name).toThrow(
        /invalid_agent_content|secret_detected/,
      );
    }

    const leaked = manifestV3() as unknown as Record<string, unknown>;
    const requirement = (
      leaked.mcpRequirements as Array<Record<string, unknown>>
    )[0];
    requirement.url = "https://private.example.test";
    expect(() =>
      decodeEditableAgentManifest(Buffer.from(JSON.stringify(leaked), "utf8")),
    ).toThrow(/invalid_agent_content/);
  });

  it("defaults new drafts to an empty V3 capability declaration", () => {
    expect(createDefaultAgentManifest("Draft identity")).toEqual({
      schemaVersion: 3,
      identity: { systemPrompt: "Draft identity" },
      assets: [],
      modelPolicy: {
        mode: "user_select",
        allowedProviders: [],
        allowedModels: [],
      },
      mcpRequirements: [],
      tools: { allowed: [], denied: [] },
      dependencies: [],
      runtimeCompatibility: {
        minimumVersion: "v0.18.2-agentera.1",
        maximumVersionExclusive: null,
      },
    });
  });
});
