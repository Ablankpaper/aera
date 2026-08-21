import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type {
  PrepareAgenteraHermesTurnInput,
  PreparedAgenteraConversationRuntime,
} from "../agentera-agent-control/manager";
import type {
  OwnerModelRouteSelection,
  PublicModelRouteIdentity,
} from "../../shared/model-configuration";
import type { SessionModelOverride } from "../../shared/model-override";
import type { AgentModelSegmentLifecycle } from "../agent-model-execution-lease";

export type AgentModelRouteMode = "configured" | "dynamic";

/**
 * Resolve the local Gateway Profile for a bound Agent turn. The visible chat
 * Profile is a logical conversation namespace; an installed Agent may resolve
 * its model from a different owner Profile. Main has already authenticated
 * that source Profile in the immutable binding, so startup must use it too.
 * Legacy bindings and ordinary chats retain the caller's requested Profile.
 */
export function resolveAgentGatewayProfile(
  requestedProfile: string | undefined,
  binding: { modelRoute?: { sourceProfileId?: string | null } | null } | null,
): string | undefined {
  const sourceProfileId = binding?.modelRoute?.sourceProfileId?.trim();
  return sourceProfileId || requestedProfile;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLocaleLowerCase();
}

/**
 * A configured route is safe to send through the profile's existing Runtime
 * transport only when all wire-routing fields match. Anything else requires
 * the explicit request-scoped Runtime capability and is therefore dynamic.
 */
export function classifyAgentModelRoute(
  route: PublicModelRouteIdentity,
  configured: SessionModelOverride,
): AgentModelRouteMode {
  return route.provider === configured.provider &&
    route.model === configured.model &&
    normalizeBaseUrl(route.baseUrl) === normalizeBaseUrl(configured.baseUrl)
    ? "configured"
    : "dynamic";
}

export interface AgentModelSendControl {
  prepareConversationRuntime(
    input: PrepareAgenteraHermesTurnInput,
  ): Promise<PreparedAgenteraConversationRuntime>;
}

export interface PrepareAgentModelSendInput {
  control: AgentModelSendControl;
  conversationKey: string;
  profilePath: string;
  owner: AgenteraRuntimeOwner;
  resumeSessionId: string | null;
  history?: ReadonlyArray<{ role: string; content: string }>;
  requestedModelSelection?: OwnerModelRouteSelection;
}

function visibleHistoryCount(
  history: PrepareAgentModelSendInput["history"],
): number {
  if (!history) return 0;
  return history.filter(
    (message) =>
      message.role === "user" ||
      message.role === "agent" ||
      message.role === "assistant",
  ).length;
}

/**
 * Keep the real send handler's Manager input construction in one testable
 * boundary. Renderer selections remain opaque until Manager resolves them.
 */
export function prepareConversationRuntime(
  input: PrepareAgentModelSendInput,
): Promise<PreparedAgenteraConversationRuntime> {
  return input.control.prepareConversationRuntime({
    conversationKey: input.conversationKey,
    profilePath: input.profilePath,
    owner: input.owner,
    resumeSessionId: input.resumeSessionId,
    ...(input.requestedModelSelection
      ? { requestedModelSelection: input.requestedModelSelection }
      : {}),
    visibleHistoryCount: visibleHistoryCount(input.history),
  });
}

/**
 * A candidate Segment exists before the real transport is started. Keep every
 * setup step after that durable write behind one guard so a gateway, tunnel,
 * or lease failure cannot leave a stale `preparing` candidate behind.
 */
export async function runAgentModelSegmentPreflight<T>(
  lifecycle: AgentModelSegmentLifecycle | null,
  operation: () => T | Promise<T>,
): Promise<T> {
  lifecycle?.emitPreparing();
  try {
    return await operation();
  } catch (error) {
    lifecycle?.fail(error);
    throw error;
  }
}

/** Backward-compatible name for focused send-boundary tests and callers. */
export const prepareAgentModelSend = prepareConversationRuntime;
