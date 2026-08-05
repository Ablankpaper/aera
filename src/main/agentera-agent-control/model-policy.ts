import type { AgentPolicySnapshot, AgentVersion } from "./client";

export type AgentModelSelectionMode = "user_select" | "allowlist" | "fixed";

export interface AgentModelPolicy {
  mode: AgentModelSelectionMode;
  allowedProviders: readonly string[];
  allowedModels: readonly string[];
}

export function modelPolicyForManifest(
  manifest: AgentVersion["manifest"],
): AgentModelPolicy {
  if (manifest.schema_version === 2 || manifest.schema_version === 3) {
    return {
      mode: manifest.model_policy.mode,
      allowedProviders: manifest.model_policy.allowed_providers,
      allowedModels: manifest.model_policy.allowed_models,
    };
  }
  return {
    mode: "allowlist",
    allowedProviders: manifest.model_constraints.allowed_providers,
    allowedModels: manifest.model_constraints.allowed_models,
  };
}

export function modelPolicyForPolicyDocument(
  document: AgentPolicySnapshot["document"],
): AgentModelPolicy {
  if (document.schema_version === 2 || document.schema_version === 3) {
    return {
      mode: document.model_policy.mode,
      allowedProviders: document.model_policy.allowed_providers,
      allowedModels: document.model_policy.allowed_models,
    };
  }
  return {
    mode: "allowlist",
    allowedProviders: document.model_constraints.allowed_providers,
    allowedModels: document.model_constraints.allowed_models,
  };
}

export function agentModelPolicyAllowsRoute(
  policy: AgentModelPolicy,
  provider: string,
  model: string,
): boolean {
  if (policy.mode === "user_select") return true;
  const normalizedProvider = provider.trim().toLowerCase();
  const providerAllowed = policy.allowedProviders.some((allowed) => {
    const normalizedAllowed = allowed.trim().toLowerCase();
    return (
      normalizedAllowed === normalizedProvider ||
      (normalizedAllowed === "custom" &&
        normalizedProvider.startsWith("custom:"))
    );
  });
  return providerAllowed && policy.allowedModels.includes(model.trim());
}
