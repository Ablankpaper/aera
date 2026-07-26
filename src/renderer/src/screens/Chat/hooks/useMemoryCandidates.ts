import { useCallback, useEffect, useRef, useState } from "react";
import type { AgenteraMemoryCandidateBatch } from "../../../../../shared/agentera-memory-candidate";
import type {
  ChatBubbleMessage,
  ChatMessage,
  MemoryCandidateMessage,
} from "../types";

interface UseMemoryCandidatesOptions {
  profile?: string;
  isAgentBusy: boolean;
  messages: ChatMessage[];
}

interface UseMemoryCandidatesResult {
  candidateMessages: MemoryCandidateMessage[];
  onNaturalLanguageMessageStarted: (rawText: string, turnId: string) => void;
  confirm: (batchId: string) => Promise<void>;
  reject: (batchId: string) => Promise<void>;
}

interface PendingCandidateExtraction {
  profileId: string;
  turnId: string;
  observedHermesBusy: boolean;
  batch: AgenteraMemoryCandidateBatch | null;
}

function matchingAssistantReply(
  messages: ChatMessage[],
  turnId: string,
): ChatBubbleMessage | undefined {
  return messages.find(
    (message): message is ChatBubbleMessage =>
      message.role === "agent" &&
      "turnId" in message &&
      message.turnId === turnId &&
      (message.kind === undefined || message.kind === "assistant"),
  );
}

function turnCompletedSuccessfully(
  messages: ChatMessage[],
  turnId: string,
): boolean {
  const reply = matchingAssistantReply(messages, turnId);
  return Boolean(
    reply &&
    "content" in reply &&
    reply.content.trim() &&
    !reply.error &&
    !reply.pending,
  );
}

function turnFailed(messages: ChatMessage[], turnId: string): boolean {
  const reply = matchingAssistantReply(messages, turnId);
  return Boolean(reply && "error" in reply && reply.error);
}

function appendCandidate(
  messages: MemoryCandidateMessage[],
  batch: AgenteraMemoryCandidateBatch,
): MemoryCandidateMessage[] {
  if (
    messages.some(
      (message) =>
        message.kind === "memory_candidate" && message.batch.id === batch.id,
    )
  ) {
    return messages;
  }
  const card: MemoryCandidateMessage = {
    id: `memory-candidate-${batch.id}`,
    kind: "memory_candidate",
    role: "agent",
    batch,
    status: "pending",
  };
  return [...messages, card];
}

function updateCandidateStatus(
  messages: MemoryCandidateMessage[],
  batchId: string,
  status: MemoryCandidateMessage["status"],
): MemoryCandidateMessage[] {
  return messages.map((message) =>
    message.kind === "memory_candidate" && message.batch.id === batchId
      ? { ...message, status }
      : message,
  );
}

export function useMemoryCandidates({
  profile,
  isAgentBusy,
  messages,
}: UseMemoryCandidatesOptions): UseMemoryCandidatesResult {
  const [candidateMessages, setCandidateMessages] = useState<
    MemoryCandidateMessage[]
  >([]);
  const inFlight = useRef(new Set<string>());
  const pendingExtractions = useRef<PendingCandidateExtraction[]>([]);
  const profileId = profile?.trim() || "default";
  const activeProfileId = useRef(profileId);
  const displayedProfileId = useRef(profileId);
  const agentBusy = useRef(isAgentBusy);
  const messageSnapshot = useRef(messages);
  activeProfileId.current = profileId;
  agentBusy.current = isAgentBusy;
  messageSnapshot.current = messages;

  useEffect(() => {
    if (displayedProfileId.current !== profileId) {
      displayedProfileId.current = profileId;
      setCandidateMessages([]);
    }
    pendingExtractions.current = pendingExtractions.current.filter(
      (pending) => pending.profileId === profileId,
    );
    if (isAgentBusy) {
      for (const pending of pendingExtractions.current) {
        pending.observedHermesBusy = true;
      }
      return;
    }
    const failed = pendingExtractions.current.filter((pending) =>
      turnFailed(messages, pending.turnId),
    );
    const ready = pendingExtractions.current.filter(
      (pending) =>
        pending.observedHermesBusy &&
        pending.batch &&
        turnCompletedSuccessfully(messages, pending.turnId),
    );
    if (ready.length === 0 && failed.length === 0) return;
    pendingExtractions.current = pendingExtractions.current.filter(
      (pending) => !ready.includes(pending) && !failed.includes(pending),
    );
    setCandidateMessages((messages) =>
      ready.reduce(
        (current, pending) => appendCandidate(current, pending.batch!),
        messages,
      ),
    );
  }, [isAgentBusy, messages, profileId]);

  const onNaturalLanguageMessageStarted = useCallback(
    (rawText: string, turnId: string): void => {
      const api = window.agenteraGlobalProfile;
      if (!api?.extractCandidates || !turnId.trim()) return;
      const pending: PendingCandidateExtraction = {
        profileId,
        turnId,
        observedHermesBusy: agentBusy.current,
        batch: null,
      };
      pendingExtractions.current.push(pending);
      void api
        .extractCandidates(rawText, profileId)
        .then((result) => {
          if (
            !pendingExtractions.current.includes(pending) ||
            activeProfileId.current !== profileId
          ) {
            return;
          }
          if (!result.success || !result.value) {
            pendingExtractions.current = pendingExtractions.current.filter(
              (item) => item !== pending,
            );
            return;
          }
          pending.batch = result.value;
          if (agentBusy.current || !pending.observedHermesBusy) return;
          if (turnFailed(messageSnapshot.current, pending.turnId)) {
            pendingExtractions.current = pendingExtractions.current.filter(
              (item) => item !== pending,
            );
            return;
          }
          if (
            !turnCompletedSuccessfully(messageSnapshot.current, pending.turnId)
          ) {
            return;
          }
          pendingExtractions.current = pendingExtractions.current.filter(
            (item) => item !== pending,
          );
          setCandidateMessages((messages) =>
            appendCandidate(messages, result.value!),
          );
        })
        .catch(() => {
          pendingExtractions.current = pendingExtractions.current.filter(
            (item) => item !== pending,
          );
          // Candidate recognition is additive and must never block or degrade
          // the Hermes reply and self-evolution path.
        });
    },
    [profileId],
  );

  const confirm = useCallback(
    async (batchId: string): Promise<void> => {
      if (isAgentBusy || inFlight.current.has(batchId)) return;
      const api = window.agenteraGlobalProfile;
      if (!api?.confirmCandidates) return;
      inFlight.current.add(batchId);
      setCandidateMessages((messages) =>
        updateCandidateStatus(messages, batchId, "saving"),
      );
      try {
        const result = await api.confirmCandidates(batchId, profileId);
        setCandidateMessages((messages) =>
          updateCandidateStatus(
            messages,
            batchId,
            result.success ? "confirmed" : "error",
          ),
        );
      } catch {
        setCandidateMessages((messages) =>
          updateCandidateStatus(messages, batchId, "error"),
        );
      } finally {
        inFlight.current.delete(batchId);
      }
    },
    [isAgentBusy, profileId],
  );

  const reject = useCallback(
    async (batchId: string): Promise<void> => {
      if (inFlight.current.has(batchId)) return;
      const api = window.agenteraGlobalProfile;
      if (!api?.rejectCandidates) return;
      inFlight.current.add(batchId);
      setCandidateMessages((messages) =>
        updateCandidateStatus(messages, batchId, "saving"),
      );
      try {
        const result = await api.rejectCandidates(batchId, profileId);
        setCandidateMessages((messages) =>
          updateCandidateStatus(
            messages,
            batchId,
            result.success ? "rejected" : "error",
          ),
        );
      } catch {
        setCandidateMessages((messages) =>
          updateCandidateStatus(messages, batchId, "error"),
        );
      } finally {
        inFlight.current.delete(batchId);
      }
    },
    [profileId],
  );

  return {
    candidateMessages,
    onNaturalLanguageMessageStarted,
    confirm,
    reject,
  };
}
