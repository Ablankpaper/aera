import { useEffect, useState } from "react";
import type {
  AgentDraftDetail,
  AgenteraAgentControlErrorCode,
  ExperienceCandidateDetail,
  ExperienceCandidateImportPreview,
} from "../../../../shared/agentera-agent-control";
import { X } from "../../assets/icons";
import { AppModal, AppModalTitle } from "../../components/modal/AppModal";
import { useI18n } from "../../components/useI18n";

const REJECTION_REASONS = [
  "not_reusable",
  "insufficient_quality",
  "wrong_scope",
  "policy_blocked",
] as const;
const MAX_SAFE_NOTE_LENGTH = 500;

export interface ExperienceReviewDialogProps {
  open: boolean;
  candidateId: string;
  online: boolean;
  onClose: () => void;
  onChanged: () => void;
  onImported: (draft: AgentDraftDetail) => void;
}

function errorKey(code: AgenteraAgentControlErrorCode): string {
  return `agents.control.errors.${code}`;
}

export default function ExperienceReviewDialog({
  open,
  candidateId,
  online,
  onClose,
  onChanged,
  onImported,
}: ExperienceReviewDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [candidate, setCandidate] = useState<ExperienceCandidateDetail | null>(
    null,
  );
  const [decision, setDecision] = useState<"APPROVED" | "REJECTED" | null>(
    null,
  );
  const [reasonCode, setReasonCode] = useState("");
  const [safeNote, setSafeNote] = useState("");
  const [preview, setPreview] =
    useState<ExperienceCandidateImportPreview | null>(null);
  const [confirmedImport, setConfirmedImport] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [baseRefreshed, setBaseRefreshed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prepareImport = async (id: string): Promise<boolean> => {
    setImporting(true);
    setConfirmedImport(false);
    setError(null);
    try {
      const result =
        await window.agenteraAgents.prepareExperienceCandidateImport(id);
      if (!result.ok) {
        setError(errorKey(result.errorCode));
        setPreview(null);
        return false;
      }
      setPreview(result.data);
      return true;
    } catch {
      setError("agents.control.errors.operation_failed");
      setPreview(null);
      return false;
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    let active = true;
    setCandidate(null);
    setDecision(null);
    setReasonCode("");
    setSafeNote("");
    setPreview(null);
    setConfirmedImport(false);
    setBaseRefreshed(false);
    setError(null);
    setLoading(true);
    void window.agenteraAgents
      .getExperienceCandidate(candidateId)
      .then(async (result) => {
        if (!active) return;
        if (!result.ok) {
          setError(errorKey(result.errorCode));
          return;
        }
        setCandidate(result.data);
        if (result.data.reviewStatus === "APPROVED" && online) {
          await prepareImport(candidateId);
        }
      })
      .catch(() => {
        if (active) setError("agents.control.errors.operation_failed");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [candidateId, online, open]);

  const commitReview = async (): Promise<void> => {
    if (
      candidate === null ||
      decision === null ||
      (decision === "REJECTED" && reasonCode.length === 0) ||
      !online ||
      reviewing
    ) {
      return;
    }
    setReviewing(true);
    setError(null);
    try {
      const result = await window.agenteraAgents.reviewExperienceCandidate({
        candidateId,
        decision,
        reasonCode: decision === "REJECTED" ? reasonCode : null,
        safeNote:
          decision === "REJECTED" && safeNote.length > 0 ? safeNote : null,
      });
      if (!result.ok) {
        setError(errorKey(result.errorCode));
        return;
      }
      setCandidate(result.data);
      onChanged();
      if (result.data.reviewStatus === "APPROVED") {
        await prepareImport(candidateId);
      } else {
        onClose();
      }
    } catch {
      setError("agents.control.errors.operation_failed");
    } finally {
      setReviewing(false);
    }
  };

  const createDraft = async (): Promise<void> => {
    if (!preview || !confirmedImport || !online || importing) return;
    setImporting(true);
    setError(null);
    setBaseRefreshed(false);
    try {
      const result =
        await window.agenteraAgents.confirmExperienceCandidateImport({
          importHandle: preview.importHandle,
          confirmation: "apply-approved-skill-to-latest",
        });
      if (!result.ok) {
        if (result.errorCode === "candidate_base_advanced") {
          const refreshed = await prepareImport(candidateId);
          if (refreshed) setBaseRefreshed(true);
          return;
        }
        setError(errorKey(result.errorCode));
        return;
      }
      onChanged();
      onImported(result.data);
      onClose();
    } catch {
      setError("agents.control.errors.operation_failed");
    } finally {
      setImporting(false);
    }
  };

  const canCommitReview =
    candidate?.reviewStatus === "PENDING_REVIEW" &&
    decision !== null &&
    (decision !== "REJECTED" || reasonCode.length > 0) &&
    online &&
    !reviewing;

  return (
    <AppModal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !loading && !reviewing && !importing) onClose();
      }}
      className="agent-control-modal"
      labelledBy="experience-review-dialog-title"
    >
      <header className="agent-control-modal-header">
        <div>
          <AppModalTitle id="experience-review-dialog-title">
            {t("agents.control.experience.reviewTitle")}
          </AppModalTitle>
          <p>{t("agents.control.experience.reviewBoundary")}</p>
        </div>
        <button
          type="button"
          className="agents-row-edit"
          aria-label={t("agents.control.close")}
          onClick={onClose}
          disabled={loading || reviewing || importing}
        >
          <X size={16} />
        </button>
      </header>

      <div className="agent-control-modal-body">
        {loading ? <div className="loading-spinner" /> : null}
        {candidate ? (
          <>
            <dl className="agent-control-preview-grid">
              <div>
                <dt>{t("agents.control.experience.skill")}</dt>
                <dd>{candidate.skillName}</dd>
              </div>
              <div>
                <dt>{t("agents.control.experience.sourceVersion")}</dt>
                <dd>{candidate.sourceAgentVersionId}</dd>
              </div>
              <div>
                <dt>{t("agents.control.experience.digest")}</dt>
                <dd>{candidate.contentDigest}</dd>
              </div>
            </dl>

            {candidate.reviewStatus === "PENDING_REVIEW" ? (
              <>
                <section>
                  {candidate.bundle.assets.map((asset) => (
                    <article key={asset.path}>
                      <strong>{asset.path}</strong>
                      <pre>{asset.content}</pre>
                    </article>
                  ))}
                </section>
                {!online ? (
                  <p className="agent-control-notice">
                    {t("agents.control.experience.onlineToReview")}
                  </p>
                ) : null}
                <div className="agent-control-install-options">
                  <label>
                    <input
                      type="radio"
                      name="experience-review-decision"
                      checked={decision === "APPROVED"}
                      onChange={() => {
                        setDecision("APPROVED");
                        setReasonCode("");
                        setSafeNote("");
                      }}
                    />
                    <span>{t("agents.control.experience.approve")}</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="experience-review-decision"
                      checked={decision === "REJECTED"}
                      onChange={() => setDecision("REJECTED")}
                    />
                    <span>{t("agents.control.experience.reject")}</span>
                  </label>
                </div>
                {decision === "REJECTED" ? (
                  <>
                    <label className="agents-create-field">
                      <span>
                        {t("agents.control.experience.rejectionReason")}
                      </span>
                      <select
                        className="input"
                        aria-label={t(
                          "agents.control.experience.rejectionReason",
                        )}
                        value={reasonCode}
                        onChange={(event) => setReasonCode(event.target.value)}
                      >
                        <option value="">
                          {t("agents.control.experience.chooseReason")}
                        </option>
                        {REJECTION_REASONS.map((reason) => (
                          <option key={reason} value={reason}>
                            {t(`agents.control.experience.reason.${reason}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="agents-create-field">
                      <span>{t("agents.control.experience.safeNote")}</span>
                      <textarea
                        className="input agent-control-textarea"
                        aria-label={t("agents.control.experience.safeNote")}
                        maxLength={MAX_SAFE_NOTE_LENGTH}
                        value={safeNote}
                        onChange={(event) =>
                          setSafeNote(
                            event.target.value.slice(0, MAX_SAFE_NOTE_LENGTH),
                          )
                        }
                      />
                    </label>
                  </>
                ) : null}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canCommitReview}
                  onClick={() => void commitReview()}
                >
                  {t("agents.control.experience.commitReview")}
                </button>
              </>
            ) : null}

            {preview ? (
              <section aria-label={t("agents.control.experience.importTitle")}>
                {preview.replacesExistingSkill ? (
                  <p className="agent-control-notice">
                    {t("agents.control.experience.replacementWarning")}
                  </p>
                ) : null}
                {baseRefreshed ? (
                  <p className="agent-control-notice">
                    {t("agents.control.experience.baseRefreshed")}
                  </p>
                ) : null}
                <p>v{preview.latestVersionNumber}</p>
                <div className="agent-control-columns">
                  <div>
                    <strong>{t("agents.control.experience.addedPaths")}</strong>
                    <ul>
                      {preview.addedPaths.map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <strong>
                      {t("agents.control.experience.replacedPaths")}
                    </strong>
                    <ul>
                      {preview.replacedPaths.map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <strong>
                      {t("agents.control.experience.removedPaths")}
                    </strong>
                    <ul>
                      {preview.removedPaths.map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <label className="agent-control-confirm-row">
                  <input
                    type="checkbox"
                    checked={confirmedImport}
                    disabled={importing}
                    aria-label={t(
                      "agents.control.experience.importConfirmation",
                    )}
                    onChange={(event) =>
                      setConfirmedImport(event.target.checked)
                    }
                  />
                  <span>
                    {t("agents.control.experience.importConfirmation")}
                  </span>
                </label>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!confirmedImport || !online || importing}
                  onClick={() => void createDraft()}
                >
                  {t("agents.control.experience.createDraft")}
                </button>
              </section>
            ) : null}
          </>
        ) : null}
        {error ? <div className="agents-create-error">{t(error)}</div> : null}
      </div>

      <footer className="agent-control-modal-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onClose}
          disabled={loading || reviewing || importing}
        >
          {t("agents.control.close")}
        </button>
      </footer>
    </AppModal>
  );
}
