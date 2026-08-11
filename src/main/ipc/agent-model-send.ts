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

export type AgentModelRouteMode = "configured" | "dynamic";

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
export function prepareAgentModelSend(
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
