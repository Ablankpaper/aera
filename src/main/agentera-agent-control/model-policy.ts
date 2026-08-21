import type { AgentPolicySnapshot, AgentVersion } from "./client";

export type AgentModelSelectionMode = "user_select" | "allowlist" | "fixed";

export interface AgentModelPolicy {
  mode: AgentModelSelectionMode;
  allowedProviders: readonly string[];
  allowedModels: readonly string[];
}

export type AgentModelRouteDecisionReason =
  | "model_switch_fixed_policy"
  | "model_switch_provider_denied"
  | "model_switch_model_denied";

export interface AgentModelRouteDecision {
  allowed: boolean;
  reason: AgentModelRouteDecisionReason | null;
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
  return decideAgentModelRoute(policy, { provider, model }, "continue").allowed;
}

export function decideAgentModelRoute(
  _policy: AgentModelPolicy,
  _route: { provider: string; model: string },
  _intent: "continue" | "switch",
): AgentModelRouteDecision {
  return { allowed: true, reason: null };
}
