// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { AgentPolicySnapshot, AgentVersion } from "./client";
import {
  decideAgentModelRoute,
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

describe("Agent model route decisions", () => {
  it("treats every verified signed model mode as user-selected at runtime", () => {
    const fixed = {
      mode: "fixed" as const,
      allowedProviders: ["openai"],
      allowedModels: ["gpt-5.6"],
    };
    const allowlist = {
      mode: "allowlist" as const,
      allowedProviders: ["openai"],
      allowedModels: ["gpt-5.6"],
    };

    expect(
      decideAgentModelRoute(
        fixed,
        { provider: "custom:petoi", model: "gpt-5.6-sol" },
        "switch",
      ),
    ).toEqual({ allowed: true, reason: null });
    expect(
      decideAgentModelRoute(
        allowlist,
        { provider: "custom:petoi", model: "gpt-5.6-sol" },
        "continue",
      ),
    ).toEqual({ allowed: true, reason: null });
  });

  // @lat: [[model-selection#Installed-Agent switch policy and immutable resume#User-selected routes and legacy policy compatibility]]
  it.each([
    {
      mode: "user_select" as const,
      allowedProviders: [] as string[],
      allowedModels: [] as string[],
      allowed: true,
      reason: null,
    },
    {
      mode: "allowlist" as const,
      allowedProviders: ["custom"] as string[],
      allowedModels: ["gpt-5.6-sol"] as string[],
      allowed: true,
      reason: null,
    },
    {
      mode: "fixed" as const,
      allowedProviders: ["openai"] as string[],
      allowedModels: ["gpt-5.6"] as string[],
      allowed: true,
      reason: null,
    },
  ])("applies $mode when switching a route", (policy) => {
    expect(
      decideAgentModelRoute(
        policy,
        { provider: "custom:petoi", model: "gpt-5.6-sol" },
        "switch",
      ),
    ).toEqual({ allowed: policy.allowed, reason: policy.reason });
  });

  it("does not use historical provider and model lists as runtime denials", () => {
    const policy = {
      mode: "allowlist" as const,
      allowedProviders: ["openai"],
      allowedModels: ["gpt-5.6"],
    };

    expect(
      decideAgentModelRoute(
        policy,
        { provider: "custom:petoi", model: "gpt-5.6" },
        "switch",
      ),
    ).toEqual({ allowed: true, reason: null });
    expect(
      decideAgentModelRoute(
        policy,
        { provider: "openai", model: "gpt-5.6-sol" },
        "continue",
      ),
    ).toEqual({ allowed: true, reason: null });
  });
});
