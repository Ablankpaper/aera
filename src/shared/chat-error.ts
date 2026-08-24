export const CHAT_ERROR_CODES = [
  "provider_authentication_rejected",
  "model_switch_runtime_route_unsupported",
  "agent_tool_policy_runtime_unsupported",
  "bound_runtime_unavailable",
  "chat_transport_unavailable",
  "chat_runtime_failed",
] as const;

export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

export interface ChatErrorEvent {
  code: ChatErrorCode;
}

const CHAT_ERROR_CODE_SET = new Set<string>(CHAT_ERROR_CODES);

export function parseChatErrorEvent(value: unknown): ChatErrorEvent {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" && CHAT_ERROR_CODE_SET.has(code)) {
      return { code: code as ChatErrorCode };
    }
  }
  return { code: "chat_runtime_failed" };
}
