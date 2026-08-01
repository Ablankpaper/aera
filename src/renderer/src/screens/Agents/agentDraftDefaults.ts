import type { AgentEditableManifest } from "../../../../shared/agentera-agent-control";

export const DEFAULT_AGENT_RUNTIME_VERSION = "v0.18.2-agentera.1";

export function createDefaultAgentManifest(
  systemPrompt: string,
): AgentEditableManifest {
  return {
    schemaVersion: 2,
    identity: { systemPrompt },
    assets: [],
    modelPolicy: {
      mode: "user_select",
      allowedProviders: [],
      allowedModels: [],
    },
    tools: { allowed: [], denied: [] },
    dependencies: [],
    runtimeCompatibility: {
      minimumVersion: DEFAULT_AGENT_RUNTIME_VERSION,
      maximumVersionExclusive: null,
    },
  };
}
