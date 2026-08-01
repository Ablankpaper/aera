// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { AgentEditableManifest } from "../../shared/agentera-agent-control";
import { canonicalizeEditableAgent } from "./manifest";

function manifestV2(
  mode: "user_select" | "allowlist" | "fixed" = "user_select",
): AgentEditableManifest {
  return {
    schemaVersion: 2,
    identity: { systemPrompt: "Answer with evidence." },
    assets: [],
    modelPolicy: {
      mode,
      allowedProviders: mode === "user_select" ? [] : ["openai"],
      allowedModels: mode === "user_select" ? [] : ["gpt-5.6"],
    },
    tools: { allowed: [], denied: [] },
    dependencies: [],
    runtimeCompatibility: {
      minimumVersion: "v0.18.2-agentera.1",
      maximumVersionExclusive: null,
    },
  };
}

describe("Agent Manifest V2", () => {
  it("canonicalizes user_select without binding private runtime routing", () => {
    const canonical = canonicalizeEditableAgent(manifestV2(), []);
    expect(JSON.parse(canonical.manifestBytes.toString("utf8"))).toEqual({
      assets: [],
      dependencies: [],
      identity: { system_prompt: "Answer with evidence." },
      model_policy: {
        allowed_models: [],
        allowed_providers: [],
        mode: "user_select",
      },
      runtime_compatibility: {
        maximum_version_exclusive: null,
        minimum_version: "v0.18.2-agentera.1",
      },
      schema_version: 2,
      tools: { allowed: [], denied: [] },
    });
    expect(canonical.normalizedManifest).toEqual(manifestV2());
  });

  it("rejects policy shapes that do not match their mode", () => {
    const invalid = manifestV2("fixed");
    if (invalid.schemaVersion !== 2) throw new Error("fixture mismatch");
    invalid.modelPolicy.allowedModels.push("gpt-5.5");
    expect(() => canonicalizeEditableAgent(invalid, [])).toThrow(
      /invalid_agent_content/,
    );
  });

  it("canonicalizes every selected provider and model in a multi-route allowlist", () => {
    const input = manifestV2("allowlist");
    if (input.schemaVersion !== 2) throw new Error("fixture mismatch");
    input.modelPolicy.allowedProviders = ["custom:yundu.lat", "custom:petoi"];
    input.modelPolicy.allowedModels = ["gpt-5.6-sol", "claude-opus-4-6"];

    const canonical = canonicalizeEditableAgent(input, []);
    expect(JSON.parse(canonical.manifestBytes.toString("utf8"))).toMatchObject({
      model_policy: {
        mode: "allowlist",
        allowed_providers: ["custom:petoi", "custom:yundu.lat"],
        allowed_models: ["claude-opus-4-6", "gpt-5.6-sol"],
      },
    });
    expect(canonical.normalizedManifest).toMatchObject({
      modelPolicy: {
        mode: "allowlist",
        allowedProviders: ["custom:petoi", "custom:yundu.lat"],
        allowedModels: ["claude-opus-4-6", "gpt-5.6-sol"],
      },
    });
  });
});
