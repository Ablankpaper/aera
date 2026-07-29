import type { AgentEditableManifest } from "../../../../shared/agentera-agent-control";

export const DEFAULT_AGENT_RUNTIME_VERSION = "v0.18.2-agentera.1";
export const DEFAULT_AGENT_PROVIDER = "openai";
export const DEFAULT_AGENT_MODEL = "gpt-5.6";

export function createDefaultAgentManifest(
  systemPrompt: string,
  provider = DEFAULT_AGENT_PROVIDER,
  model = DEFAULT_AGENT_MODEL,
): AgentEditableManifest {
  return {
    schemaVersion: 1,
    identity: { systemPrompt },
    assets: [],
    modelConstraints: {
      allowedProviders: [provider],
      allowedModels: [model],
    },
    tools: { allowed: [], denied: [] },
    dependencies: [],
    runtimeCompatibility: {
      minimumVersion: DEFAULT_AGENT_RUNTIME_VERSION,
      maximumVersionExclusive: null,
    },
  };
}
