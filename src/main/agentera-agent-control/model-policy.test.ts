// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { AgentPolicySnapshot, AgentVersion } from "./client";
import {
  modelPolicyForManifest,
  modelPolicyForPolicyDocument,
} from "./model-policy";

const modelPolicy = {
  mode: "allowlist" as const,
  allowed_providers: ["custom:corp"],
  allowed_models: ["gpt-5.6-sol"],
};

describe("Manifest V3 model policy", () => {
  it("reads the V2-compatible model policy from a V3 manifest", () => {
    const manifest: Extract<AgentVersion["manifest"], { schema_version: 3 }> = {
      schema_version: 3,
      identity: { system_prompt: "Use approved capabilities." },
      assets: [],
      model_policy: modelPolicy,
      mcp_requirements: [],
      tools: { allowed: [], denied: [] },
      dependencies: [],
      runtime_compatibility: {
        minimum_version: "v0.18.2-agentera.1",
        maximum_version_exclusive: null,
      },
    };

    expect(modelPolicyForManifest(manifest)).toEqual({
      mode: "allowlist",
      allowedProviders: ["custom:corp"],
      allowedModels: ["gpt-5.6-sol"],
    });
  });

  it("reads the V2-compatible model policy from a V3 policy document", () => {
    const document: Extract<
      AgentPolicySnapshot["document"],
      { schema_version: 3 }
    > = {
      schema_version: 3,
      agent_definition_id: "11111111-1111-4111-8111-111111111111",
      agent_version_id: "22222222-2222-4222-8222-222222222222",
      version_digest: "ab".repeat(32),
      model_policy: modelPolicy,
      mcp_requirements: [],
      tools: { allowed: [], denied: [] },
      deny_rules: [],
      runtime_compatibility: {
        minimum_version: "v0.18.2-agentera.1",
        maximum_version_exclusive: null,
      },
      publication_allowed: false,
    };

    expect(modelPolicyForPolicyDocument(document)).toEqual({
      mode: "allowlist",
      allowedProviders: ["custom:corp"],
      allowedModels: ["gpt-5.6-sol"],
    });
  });
});
