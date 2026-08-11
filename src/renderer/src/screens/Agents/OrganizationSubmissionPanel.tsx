import { useState } from "react";
import type {
  AgenteraAgentControlErrorCode,
  AgenteraAgentControlResult,
  DisconnectOrganizationSubmissionReferenceInput,
  OrganizationAgentSubmissionDetail,
  OrganizationAgentSubmissionListItem,
  OrganizationSubmissionListIssue,
  OrganizationWithdrawalPreview,
} from "../../../../shared/agentera-agent-control";
import { useI18n } from "../../components/useI18n";
import OrganizationReviewDialog from "./OrganizationReviewDialog";

export interface OrganizationSubmissionPanelProps {
  online: boolean;
  canAuthor: boolean;
  canReview: boolean;
  submissions: OrganizationAgentSubmissionListItem[];
  issues: OrganizationSubmissionListIssue[];
  loading: boolean;
  onRefresh: () => void | Promise<void>;
  onDisconnect: (
    input: DisconnectOrganizationSubmissionReferenceInput,
  ) => Promise<AgenteraAgentControlResult<OrganizationAgentSubmissionListItem>>;
}

function errorKey(code: AgenteraAgentControlErrorCode): string {
  return `agents.control.errors.${code}`;
}

export default function OrganizationSubmissionPanel({
  online,
  canAuthor,
  canReview,
  submissions,
  issues,
  loading,
  onRefresh,
  onDisconnect,
}: OrganizationSubmissionPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [reviewDetail, setReviewDetail] =
    useState<OrganizationAgentSubmissionDetail | null>(null);
  const [reviewChanged, setReviewChanged] = useState(false);
  const [withdrawal, setWithdrawal] =
    useState<OrganizationWithdrawalPreview | null>(null);
  const [disconnectTarget, setDisconnectTarget] =
    useState<OrganizationAgentSubmissionListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    await onRefresh();
  };

  const confirmDisconnect = async (): Promise<void> => {
    if (!disconnectTarget || busy) return;
    setBusy(true);
    setError(null);
    const result = await onDisconnect({
      submissionId: disconnectTarget.id,
      confirmation: "disconnect-local-draft-link",
    });
    setBusy(false);
    if (!result.ok) {
      setError(errorKey(result.errorCode));
      return;
    }
    setDisconnectTarget(null);
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
      {issues.length > 0 ? (
        <div className="agent-control-notice">
          {t("agents.control.organization.submissionRecordUnavailable")}
        </div>
      ) : null}
      {online && !loading && submissions.length === 0 ? (
        <p className="agent-control-empty">
          {t("agents.control.organization.noSubmissions")}
        </p>
      ) : null}
      {submissions.map((submission) => (
        <article
          key={submission.id}
          className="agent-control-card"
          data-submission-id={submission.id}
        >
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
            {submission.referenceState.kind === "quarantined" ? (
              <div
                className="agent-control-notice"
                data-testid={`submission-reference-conflict:${submission.id}`}
              >
                {t("agents.control.organization.referenceConflict")}
              </div>
            ) : null}
          </div>
          {online &&
          ((submission.status === "pending" && (canReview || canAuthor)) ||
            (canAuthor && submission.referenceState.kind === "quarantined")) ? (
            <div className="agent-control-inline-actions">
              {submission.status === "pending" && canReview ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => void openReview(submission.id)}
                >
                  {t("agents.control.organization.review")}
                </button>
              ) : null}
              {submission.status === "pending" && canAuthor ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => void prepareWithdrawal(submission.id)}
                >
                  {t("agents.control.organization.withdraw")}
                </button>
              ) : null}
              {canAuthor && submission.referenceState.kind === "quarantined" ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => setDisconnectTarget(submission)}
                >
                  {t("agents.control.organization.disconnectReference")}
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
            if (reviewChanged) void onRefresh();
          }}
          onCompleted={() => {
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

      {disconnectTarget ? (
        <div className="agent-control-dialog-backdrop">
          <div
            className="agent-control-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="organization-disconnect-reference-title"
          >
            <h3 id="organization-disconnect-reference-title">
              {t("agents.control.organization.disconnectReferenceTitle")}
            </h3>
            <p>{disconnectTarget.contentDigest}</p>
            <p>
              {t("agents.control.organization.disconnectReferenceBoundary")}
            </p>
            <div className="agent-control-dialog-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDisconnectTarget(null)}
                disabled={busy}
              >
                {t("agents.control.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void confirmDisconnect()}
                disabled={busy}
              >
                {t("agents.control.organization.confirmDisconnectReference")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
