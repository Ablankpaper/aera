import {
  parseChatErrorEvent,
  type ChatErrorCode,
} from "../../../../shared/chat-error";

const CHAT_ERROR_MESSAGE_KEYS = {
  provider_authentication_rejected:
    "chat.errors.providerAuthenticationRejected",
  model_switch_runtime_route_unsupported:
    "chat.errors.runtimeRouteUnsupported",
  agent_tool_policy_runtime_unsupported:
    "chat.errors.runtimeToolPolicyUnsupported",
  bound_runtime_unavailable: "chat.errors.runtimeUnavailable",
  chat_transport_unavailable: "chat.errors.transportUnavailable",
  chat_runtime_failed: "chat.errors.runtimeFailed",
} as const satisfies Record<ChatErrorCode, string>;

/** Return an i18n key only; arbitrary Main/Runtime text is never rendered. */
export function chatErrorMessageKey(value: unknown): string {
  return CHAT_ERROR_MESSAGE_KEYS[parseChatErrorEvent(value).code];
}
