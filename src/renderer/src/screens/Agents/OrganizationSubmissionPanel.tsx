import { useCallback, useEffect, useState } from "react";
import type {
  AgenteraAgentControlErrorCode,
  OrganizationAgentSubmissionDetail,
  OrganizationAgentSubmissionSummary,
  OrganizationWithdrawalPreview,
} from "../../../../shared/agentera-agent-control";
import { useI18n } from "../../components/useI18n";
import OrganizationReviewDialog from "./OrganizationReviewDialog";

export interface OrganizationSubmissionPanelProps {
  online: boolean;
  canAuthor: boolean;
  canReview: boolean;
  contextKey: string;
  refreshToken?: number;
  onChanged?: () => void;
}

function errorKey(code: AgenteraAgentControlErrorCode): string {
  return `agents.control.errors.${code}`;
}

export default function OrganizationSubmissionPanel({
  online,
  canAuthor,
  canReview,
  contextKey,
  refreshToken = 0,
  onChanged = () => undefined,
}: OrganizationSubmissionPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [submissions, setSubmissions] = useState<
    OrganizationAgentSubmissionSummary[]
  >([]);
  const [reviewDetail, setReviewDetail] =
    useState<OrganizationAgentSubmissionDetail | null>(null);
  const [reviewChanged, setReviewChanged] = useState(false);
  const [withdrawal, setWithdrawal] =
    useState<OrganizationWithdrawalPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!online) return;
    setError(null);
    const result = await window.agenteraAgents.listOrganizationSubmissions();
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setSubmissions(result.data);
  }, [online]);

  useEffect(() => {
    setReviewDetail(null);
    setReviewChanged(false);
    setWithdrawal(null);
    setSubmissions([]);
    void load();
  }, [contextKey, load, refreshToken]);

  const openReview = async (submissionId: string): Promise<void> => {
    if (!online || !canReview || busy) return;
    setBusy(true);
    setError(null);
    const result =
      await window.agenteraAgents.getOrganizationSubmission(submissionId);
    setBusy(false);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setReviewDetail(result.data);
    setReviewChanged(false);
  };

  const prepareWithdrawal = async (submissionId: string): Promise<void> => {
    if (!online || !canAuthor || busy) return;
    setBusy(true);
    setError(null);
    const result =
      await window.agenteraAgents.prepareOrganizationWithdrawal(submissionId);
    setBusy(false);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setWithdrawal(result.data);
  };

  const confirmWithdrawal = async (): Promise<void> => {
    if (!withdrawal || busy) return;
    setBusy(true);
    setError(null);
    const result = await window.agenteraAgents.confirmOrganizationWithdrawal({
      withdrawalHandle: withdrawal.withdrawalHandle,
      confirmation: "withdraw-organization-agent",
    });
    setBusy(false);
    setWithdrawal(null);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setSubmissions((current) =>
      current.map((item) => (item.id === result.data.id ? result.data : item)),
    );
    onChanged();
  };

  return (
    <section className="agent-control-group agent-control-installations">
      <div className="agent-control-group-title">
        <h3>{t("agents.control.organization.reviewTitle")}</h3>
        <span>{submissions.length}</span>
      </div>
      {!online ? (
        <div className="agent-control-notice">
          {t("agents.control.organization.cachedReadOnly")}
        </div>
      ) : null}
      {error ? <div className="agents-create-error">{t(error)}</div> : null}
      {online && submissions.length === 0 ? (
        <p className="agent-control-empty">
          {t("agents.control.organization.noSubmissions")}
        </p>
      ) : null}
      {submissions.map((submission) => (
        <article key={submission.id} className="agent-control-card">
          <div>
            <strong>
              {t(
                `agents.control.organization.statusValue.${submission.status}`,
              )}
            </strong>
            <p>{submission.contentDigest}</p>
            <p>
              {t("agents.control.organization.author")}:{" "}
              {submission.submittedByUserId}
            </p>
            <p>
              {t("agents.control.revision")} {submission.revision} ·{" "}
              {submission.submittedAt}
            </p>
            {submission.review ? (
              <>
                <p>
                  {t("agents.control.organization.reviewedBy")}:{" "}
                  {submission.review.reviewerUserId} ·{" "}
                  {submission.review.decision} · {submission.review.reviewedAt}
                </p>
                <p>
                  {t("agents.control.organization.policyVersion")}{" "}
                  {submission.review.organizationPolicyVersion}
                  {submission.review.reasonCode
                    ? ` · ${submission.review.reasonCode}`
                    : ""}
                  {submission.review.safeNote
                    ? ` · ${submission.review.safeNote}`
                    : ""}
                </p>
              </>
            ) : null}
          </div>
          {online && submission.status === "pending" ? (
            <div className="agent-control-inline-actions">
              {canReview ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => void openReview(submission.id)}
                >
                  {t("agents.control.organization.review")}
                </button>
              ) : null}
              {canAuthor ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => void prepareWithdrawal(submission.id)}
                >
                  {t("agents.control.organization.withdraw")}
                </button>
              ) : null}
            </div>
          ) : null}
        </article>
      ))}

      {reviewDetail ? (
        <OrganizationReviewDialog
          open
          detail={reviewDetail}
          onClose={() => {
            setReviewDetail(null);
            if (reviewChanged) onChanged();
          }}
          onCompleted={(submission) => {
            setSubmissions((current) =>
              current.map((item) =>
                item.id === submission.id ? submission : item,
              ),
            );
            setReviewChanged(true);
          }}
        />
      ) : null}

      {withdrawal ? (
        <div className="agent-control-dialog-backdrop">
          <div
            className="agent-control-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="organization-withdrawal-title"
          >
            <h3 id="organization-withdrawal-title">
              {t("agents.control.organization.withdraw")}
            </h3>
            <p>{withdrawal.contentDigest}</p>
            <p>{t("agents.control.organization.withdrawalBoundary")}</p>
            <div className="agent-control-dialog-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setWithdrawal(null)}
                disabled={busy}
              >
                {t("agents.control.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void confirmWithdrawal()}
                disabled={busy}
              >
                {t("agents.control.organization.confirmWithdrawal")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
