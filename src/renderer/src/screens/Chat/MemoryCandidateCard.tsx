import { memo } from "react";
import { Check, UserRound, UsersRound, X } from "lucide-react";
import { useI18n } from "../../components/useI18n";
import type { MemoryCandidateMessage } from "./types";

interface MemoryCandidateCardProps {
  message: MemoryCandidateMessage;
  isAgentBusy: boolean;
  onConfirm: (batchId: string) => void;
  onReject: (batchId: string) => void;
}

export const MemoryCandidateCard = memo(function MemoryCandidateCard({
  message,
  isAgentBusy,
  onConfirm,
  onReject,
}: MemoryCandidateCardProps): React.JSX.Element {
  const { t } = useI18n();
  const { batch, status } = message;
  const resolved = status === "confirmed" || status === "rejected";
  const submitting = status === "saving";

  return (
    <section
      className={`chat-memory-candidate chat-memory-candidate--${status}`}
    >
      <div className="chat-memory-candidate-heading">
        <div>
          <div className="chat-memory-candidate-title">
            {t("chat.memoryCandidate.title")}
          </div>
          {!resolved && (
            <div className="chat-memory-candidate-subtitle">
              {t("chat.memoryCandidate.subtitle")}
            </div>
          )}
        </div>
        {resolved && (
          <div className="chat-memory-candidate-receipt">
            {status === "confirmed" ? <Check size={15} /> : <X size={15} />}
            {t(
              status === "confirmed"
                ? "chat.memoryCandidate.saved"
                : "chat.memoryCandidate.notSaved",
            )}
          </div>
        )}
      </div>

      <div className="chat-memory-candidate-items">
        {batch.proposals.map((proposal) => (
          <div
            className="chat-memory-candidate-item"
            key={`${batch.id}-${proposal.kind}`}
          >
            <span className="chat-memory-candidate-icon" aria-hidden="true">
              {proposal.kind === "agent_identity" ? (
                <UserRound size={16} />
              ) : (
                <UsersRound size={16} />
              )}
            </span>
            <span className="chat-memory-candidate-label">
              {t(
                proposal.kind === "agent_identity"
                  ? "chat.memoryCandidate.agentName"
                  : "chat.memoryCandidate.userAddress",
              )}
            </span>
            <strong className="chat-memory-candidate-value">
              {proposal.kind === "agent_identity"
                ? proposal.proposedDisplayName
                : proposal.proposedValue}
            </strong>
          </div>
        ))}
      </div>

      {!resolved && (
        <>
          {status === "error" && (
            <div className="chat-memory-candidate-error" role="alert">
              {t("chat.memoryCandidate.error")}
            </div>
          )}
          {isAgentBusy && (
            <div className="chat-memory-candidate-wait">
              {t("chat.memoryCandidate.waitForReply")}
            </div>
          )}
          <div className="chat-memory-candidate-actions">
            <button
              type="button"
              className="chat-memory-candidate-reject"
              disabled={submitting}
              onClick={() => onReject(batch.id)}
            >
              {t("chat.memoryCandidate.reject")}
            </button>
            <button
              type="button"
              className="chat-memory-candidate-confirm"
              disabled={submitting || isAgentBusy}
              onClick={() => onConfirm(batch.id)}
            >
              {t(
                submitting
                  ? "chat.memoryCandidate.saving"
                  : "chat.memoryCandidate.confirm",
              )}
            </button>
          </div>
        </>
      )}
    </section>
  );
});
