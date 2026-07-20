import { useEffect, useState } from "react";
import type {
  AgentDraftDetail,
  AgenteraAgentControlErrorCode,
  ExperienceCandidateSummary,
} from "../../../../shared/agentera-agent-control";
import { useI18n } from "../../components/useI18n";
import ExperienceReviewDialog from "./ExperienceReviewDialog";

export interface ExperienceCandidatePanelProps {
  online: boolean;
  canReview: boolean;
  contextKey: string;
  refreshToken: number;
  onDraftReady: (draft: AgentDraftDetail) => void;
}

function errorKey(code: AgenteraAgentControlErrorCode): string {
  return `agents.control.errors.${code}`;
}

function candidateId(candidate: ExperienceCandidateSummary): string | null {
  return candidate.cloudCandidateId ?? candidate.localCandidateId;
}

export default function ExperienceCandidatePanel({
  online,
  canReview,
  contextKey,
  refreshToken,
  onDraftReady,
}: ExperienceCandidatePanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [own, setOwn] = useState<ExperienceCandidateSummary[]>([]);
  const [queue, setQueue] = useState<ExperienceCandidateSummary[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
    null,
  );
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedCandidateId(null);
  }, [contextKey, refreshToken]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const ownResult =
          await window.agenteraAgents.listMyExperienceCandidates();
        if (!active) return;
        if (!ownResult.ok) {
          setError(errorKey(ownResult.errorCode));
          return;
        }
        setOwn(ownResult.data);
        if (!canReview || !online) {
          setQueue([]);
          return;
        }
        const queueResult =
          await window.agenteraAgents.listExperienceReviewQueue();
        if (!active) return;
        if (!queueResult.ok) {
          setError(errorKey(queueResult.errorCode));
          return;
        }
        setQueue(queueResult.data);
      } catch {
        if (active) setError("agents.control.errors.operation_failed");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [canReview, contextKey, online, refreshToken, reloadToken]);

  const candidateCard = (
    candidate: ExperienceCandidateSummary,
    action: "review" | "retry" | null,
  ): React.JSX.Element => {
    const id = candidateId(candidate);
    return (
      <article
        key={`${candidate.cloudCandidateId ?? "local"}-${candidate.localCandidateId ?? "remote"}`}
        className="agent-control-card"
      >
        <div>
          <strong>{candidate.skillName}</strong>
          <p>
            {t(
              `agents.control.experience.status.${candidate.reviewStatus ?? candidate.localStatus ?? "PREPARED"}`,
            )}
          </p>
        </div>
        {action && id ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!online}
            onClick={() => setSelectedCandidateId(id)}
          >
            {t(
              action === "review"
                ? "agents.control.experience.review"
                : "agents.control.experience.createDraftRetry",
            )}
          </button>
        ) : null}
      </article>
    );
  };

  return (
    <section className="agent-control-group agent-control-installations">
      <div className="agent-control-group-title">
        <h3>{t("agents.control.experience.myCandidates")}</h3>
        <span>{own.length}</span>
      </div>
      {loading && own.length === 0 ? (
        <div className="loading-spinner" />
      ) : own.length === 0 ? (
        <p className="agent-control-empty">
          {t("agents.control.experience.noCandidates")}
        </p>
      ) : (
        own.map((candidate) =>
          candidateCard(
            candidate,
            canReview && candidate.reviewStatus === "APPROVED" ? "retry" : null,
          ),
        )
      )}

      {canReview ? (
        <section className="agent-control-group">
          <div className="agent-control-group-title">
            <h3>{t("agents.control.experience.reviewQueue")}</h3>
            <span>{queue.length}</span>
          </div>
          {!online ? (
            <p className="agent-control-empty">
              {t("agents.control.experience.onlineToReview")}
            </p>
          ) : queue.length === 0 ? (
            <p className="agent-control-empty">
              {t("agents.control.experience.noReviewItems")}
            </p>
          ) : (
            queue.map((candidate) => candidateCard(candidate, "review"))
          )}
        </section>
      ) : null}

      {error ? <div className="agents-create-error">{t(error)}</div> : null}

      {selectedCandidateId ? (
        <ExperienceReviewDialog
          open
          candidateId={selectedCandidateId}
          online={online}
          onClose={() => setSelectedCandidateId(null)}
          onChanged={() => setReloadToken((value) => value + 1)}
          onImported={onDraftReady}
        />
      ) : null}
    </section>
  );
}
