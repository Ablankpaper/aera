export const BOUNDARY_TOOL_CALL_ID = "call_aera_stream_boundary_terminal";
export const BOUNDARY_TOOL_RESULT = "AERA_TOOL_BOUNDARY_OK";
export const STALE_STREAM_SENTINEL = "AERA_STALE_STREAM_MUST_NOT_RENDER";

export type StreamIntegrityBoundaryScenario =
  | "tool"
  | "reconnect"
  | "after-restart";

export type StreamIntegrityBoundaryProviderRequest =
  | { kind: "tool"; phase: "call" | "final" }
  | { kind: "reconnect" }
  | { kind: "after-restart" }
  | { kind: "auxiliary" }
  | { kind: "invalid" };

export interface StreamIntegrityBoundaryToolCall {
  function: { arguments: string; name: "terminal" };
  id: typeof BOUNDARY_TOOL_CALL_ID;
  type: "function";
}

const SCENARIO_BY_PROMPT: Readonly<
  Record<string, Exclude<StreamIntegrityBoundaryScenario, "tool">>
> = {
  AERA_STREAM_INTEGRITY_BOUNDARY_RECONNECT: "reconnect",
  AERA_STREAM_INTEGRITY_BOUNDARY_AFTER_RESTART: "after-restart",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lastUserContent(messages: unknown[]): string | null {
  const message = messages.findLast(
    (candidate) => isRecord(candidate) && candidate.role === "user",
  );
  return isRecord(message) && typeof message.content === "string"
    ? message.content
    : null;
}

function hasBoundaryToolResult(messages: unknown[]): boolean {
  return messages.some(
    (message) =>
      isRecord(message) &&
      message.role === "tool" &&
      message.tool_call_id === BOUNDARY_TOOL_CALL_ID &&
      typeof message.content === "string" &&
      message.content.includes(BOUNDARY_TOOL_RESULT),
  );
}

function isCurrentPrompt(content: string, prompt: string): boolean {
  return content
    .split(/\r?\n/u)
    .some((line) => line.trim() === prompt);
}

export function streamIntegrityBoundaryToolCall(): StreamIntegrityBoundaryToolCall {
  return {
    id: BOUNDARY_TOOL_CALL_ID,
    type: "function",
    function: {
      name: "terminal",
      arguments: JSON.stringify({
        command: `printf ${BOUNDARY_TOOL_RESULT}`,
        timeout: 30,
      }),
    },
  };
}

export function streamIntegrityBoundaryReply(
  scenario: StreamIntegrityBoundaryScenario,
): string {
  const label =
    scenario === "tool"
      ? "工具调用后"
      : scenario === "reconnect"
        ? "实际重连后"
        : "冷重启后";
  const repeated =
    "企业智能体边界传输，重复短语，重复短语；标点：，。！？🙂👨‍👩‍👧‍👦e\u0301。";
  return `${label}确定性回复开始。${repeated.repeat(8)}${label}确定性回复结束。`;
}

export function classifyStreamIntegrityBoundaryRequest(
  value: unknown,
): StreamIntegrityBoundaryProviderRequest {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return { kind: "invalid" };
  }
  const prompt = lastUserContent(value.messages);
  if (!prompt) return { kind: "invalid" };

  if (value.stream !== true) return { kind: "auxiliary" };

  if (isCurrentPrompt(prompt, "AERA_STREAM_INTEGRITY_BOUNDARY_TOOL")) {
    return {
      kind: "tool",
      phase: hasBoundaryToolResult(value.messages) ? "final" : "call",
    };
  }

  const scenario = Object.entries(SCENARIO_BY_PROMPT).find(([marker]) =>
    isCurrentPrompt(prompt, marker),
  )?.[1];
  return scenario ? { kind: scenario } : { kind: "invalid" };
}
