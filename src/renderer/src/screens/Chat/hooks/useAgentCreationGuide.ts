import { useCallback, useState } from "react";
import type { AgenteraAgentControlContext } from "../../../../../shared/agentera-agent-control";
import type { Attachment } from "../types";
import { createDefaultAgentManifest } from "../../Agents/agentDraftDefaults";
import { parseAgentCreationIntent } from "../agentCreationIntent";
import type { AgentCreationGuideMessage } from "../types";

interface AgentCreationInput {
  name: string;
  purpose: string;
}

interface UseAgentCreationGuideResult {
  guideMessages: AgentCreationGuideMessage[];
  intercept: (
    rawText: string,
    turnId: string,
    attachments?: Attachment[],
  ) => boolean;
  confirm: (messageId: string, input: AgentCreationInput) => Promise<void>;
  dismiss: (messageId: string) => void;
}

function contextKey(context: AgenteraAgentControlContext): string {
  switch (context.scope) {
    case "USER":
      return "USER";
    case "WORKSPACE":
      return `WORKSPACE\0${context.workspaceId}\0${context.role}`;
    case "ORGANIZATION":
      return `ORGANIZATION\0${context.organizationId}\0${context.role}`;
  }
}

function systemPrompt(name: string, purpose: string): string {
  const cleanPurpose = purpose.trim();
  if (!cleanPurpose) {
    return `你是“${name}”，一个可靠、主动且审慎的通用智能体。开始执行前先确认目标和约束，将复杂任务拆成可验证的步骤，遇到关键缺失信息时主动追问，完成后清楚汇报结果、证据与剩余风险。`;
  }
  return `你是“${name}”，主要职责是：${cleanPurpose}。开始执行前先确认目标和约束，将复杂任务拆成可验证的步骤，遇到关键缺失信息时主动追问，完成后清楚汇报结果、证据与剩余风险。`;
}

export function useAgentCreationGuide(): UseAgentCreationGuideResult {
  const [guideMessages, setGuideMessages] = useState<
    AgentCreationGuideMessage[]
  >([]);

  const patchMessage = useCallback(
    (messageId: string, patch: Partial<AgentCreationGuideMessage>): void => {
      setGuideMessages((messages) =>
        messages.map((message) =>
          message.id === messageId ? { ...message, ...patch } : message,
        ),
      );
    },
    [],
  );

  const intercept = useCallback(
    (rawText: string, turnId: string, attachments?: Attachment[]): boolean => {
      if ((attachments?.length ?? 0) > 0) return false;
      const intent = parseAgentCreationIntent(rawText);
      if (!intent) return false;

      const messageId = `agent-creation-guide-${turnId}`;
      setGuideMessages((messages) => [
        ...messages.filter((message) => message.id !== messageId),
        {
          id: messageId,
          kind: "agent_creation_guide",
          role: "agent",
          turnId,
          suggestedName: intent.suggestedName,
          suggestedPurpose: intent.suggestedPurpose,
          target: null,
          status: "resolving",
        },
      ]);

      void window.agenteraAgents
        .getState()
        .then((result) => {
          if (!result.ok) {
            patchMessage(messageId, {
              status: "error",
              errorCode: result.errorCode,
            });
            return;
          }
          patchMessage(messageId, {
            status: "pending",
            target: result.data.context,
            errorCode: undefined,
          });
        })
        .catch(() => {
          patchMessage(messageId, {
            status: "error",
            errorCode: "service_unavailable",
          });
        });
      return true;
    },
    [patchMessage],
  );

  const confirm = useCallback(
    async (messageId: string, input: AgentCreationInput): Promise<void> => {
      const candidate = guideMessages.find(
        (message) => message.id === messageId,
      );
      const name = input.name.trim();
      if (
        !candidate ||
        (candidate.status !== "pending" && candidate.status !== "error") ||
        !candidate.target ||
        !name
      ) {
        return;
      }
      patchMessage(messageId, {
        status: "creating",
        errorCode: undefined,
      });
      try {
        const stateResult = await window.agenteraAgents.getState();
        if (!stateResult.ok) {
          patchMessage(messageId, {
            status: "error",
            errorCode: stateResult.errorCode,
          });
          return;
        }
        if (
          contextKey(stateResult.data.context) !== contextKey(candidate.target)
        ) {
          patchMessage(messageId, {
            status: "error",
            errorCode: "context_changed",
          });
          return;
        }
        const result = await window.agenteraAgents.createDraft({
          sourceAgentDefinitionId: null,
          baseAgentVersionId: null,
          displayName: name,
          icon: null,
          manifest: createDefaultAgentManifest(
            systemPrompt(name, input.purpose),
          ),
          assets: [],
        });
        if (!result.ok) {
          patchMessage(messageId, {
            status: "error",
            errorCode: result.errorCode,
          });
          return;
        }
        patchMessage(messageId, {
          status: "created",
          draftId: result.data.id,
          createdName: result.data.displayName,
          errorCode: undefined,
        });
      } catch {
        patchMessage(messageId, {
          status: "error",
          errorCode: "service_unavailable",
        });
      }
    },
    [guideMessages, patchMessage],
  );

  const dismiss = useCallback((messageId: string): void => {
    setGuideMessages((messages) =>
      messages.filter((message) => message.id !== messageId),
    );
  }, []);

  return {
    guideMessages,
    intercept,
    confirm,
    dismiss,
  };
}

export type { AgentCreationInput };
