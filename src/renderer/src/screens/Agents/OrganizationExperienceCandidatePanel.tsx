import { useEffect, useState } from "react";
import type {
  AgentDraftDetail,
  AgenteraAgentControlErrorCode,
  AgenteraAgentInstallationSummary,
  EligibleExperienceSkill,
  OrganizationExperienceCandidateDetail,
  OrganizationExperienceCandidateImportPreview,
  OrganizationExperienceCandidatePreview,
  OrganizationExperienceCandidateSummary,
} from "../../../../shared/agentera-agent-control";
import { AppModal, AppModalTitle } from "../../components/modal/AppModal";
import { useI18n } from "../../components/useI18n";

const REJECTION_REASONS = [
  "not_reusable",
  "insufficient_quality",
  "wrong_scope",
  "policy_blocked",
] as const;
const MAX_SAFE_NOTE_LENGTH = 240;

type OrganizationRole = "owner" | "admin" | "auditor" | "member";

export interface OrganizationExperienceContributionTarget {
  installation: AgenteraAgentInstallationSummary;
  agentName: string;
}

export interface OrganizationExperienceCandidatePanelProps {
  online: boolean;
  role: OrganizationRole;
  contextKey: string;
  refreshToken: number;
  contributionTarget: OrganizationExperienceContributionTarget | null;
  onCloseContribution: () => void;
  onDraftReady: (draft: AgentDraftDetail) => void;
}

interface SelectedCandidate {
  candidateId: string;
  reviewHandle: string | null;
  canReview: boolean;
}

function errorKey(code: AgenteraAgentControlErrorCode): string {
  return `agents.control.errors.${code}`;
}

function canGovern(role: OrganizationRole): boolean {
  return role === "owner" || role === "admin";
}

function OrganizationExperienceReviewDialog({
  selected,
  online,
  onClose,
  onChanged,
  onImported,
}: {
  selected: SelectedCandidate;
  online: boolean;
  onClose: () => void;
  onChanged: () => void;
  onImported: (draft: AgentDraftDetail) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [candidate, setCandidate] =
    useState<OrganizationExperienceCandidateDetail | null>(null);
  const [decision, setDecision] = useState<"APPROVED" | "REJECTED" | null>(
    null,
  );
  const [reasonCode, setReasonCode] = useState("");
  const [safeNote, setSafeNote] = useState("");
  const [preview, setPreview] =
    useState<OrganizationExperienceCandidateImportPreview | null>(null);
  const [confirmedImport, setConfirmedImport] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prepareImport = async (): Promise<void> => {
    setBusy(true);
    setConfirmedImport(false);
    setError(null);
    try {
      const result =
        await window.agenteraAgents.prepareOrganizationExperienceImport(
          selected.candidateId,
        );
      if (!result.ok) {
        setPreview(null);
        setError(errorKey(result.errorCode));
        return;
      }
      setPreview(result.data);
    } catch {
      setPreview(null);
      setError("agents.control.errors.operation_failed");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setCandidate(null);
    setPreview(null);
    setDecision(null);
    setReasonCode("");
    setSafeNote("");
    setConfirmedImport(false);
    setError(null);
    void window.agenteraAgents
      .getOrganizationExperienceCandidate(selected.candidateId)
      .then(async (result) => {
        if (!active) return;
        if (!result.ok) {
          setError(errorKey(result.errorCode));
          return;
        }
        setCandidate(result.data);
        if (
          selected.canReview &&
          result.data.reviewStatus === "APPROVED" &&
          online
        ) {
          await prepareImport();
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
  }, [online, selected.canReview, selected.candidateId]);

  const commitReview = async (): Promise<void> => {
    if (
      !selected.canReview ||
      selected.reviewHandle === null ||
      decision === null ||
      !online ||
      busy ||
      (decision === "REJECTED" && !reasonCode)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result =
        await window.agenteraAgents.reviewOrganizationExperienceCandidate({
          reviewHandle: selected.reviewHandle,
          confirmation:
            decision === "APPROVED"
              ? "approve-organization-experience"
              : "reject-organization-experience",
          reasonCode: decision === "REJECTED" ? reasonCode : null,
          safeNote: decision === "REJECTED" && safeNote ? safeNote : null,
        });
      if (!result.ok) {
        setError(errorKey(result.errorCode));
        return;
      }
      setCandidate(result.data);
      onChanged();
      if (result.data.reviewStatus === "APPROVED") {
        await prepareImport();
      } else {
        onClose();
      }
    } catch {
      setError("agents.control.errors.operation_failed");
    } finally {
      setBusy(false);
    }
  };

  const createDraft = async (): Promise<void> => {
    if (
      !selected.canReview ||
      !preview ||
      !confirmedImport ||
      !online ||
      busy
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result =
        await window.agenteraAgents.confirmOrganizationExperienceImport({
          importHandle: preview.importHandle,
          confirmation: "apply-approved-skill-to-organization-draft",
        });
      if (!result.ok) {
        if (result.errorCode === "candidate_base_advanced") {
          await prepareImport();
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
      setBusy(false);
    }
  };

  const canCommit =
    selected.canReview &&
    candidate?.reviewStatus === "PENDING_REVIEW" &&
    decision !== null &&
    (decision !== "REJECTED" || reasonCode.length > 0) &&
    online &&
    !busy;

  return (
    <AppModal
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      className="agent-control-modal"
      labelledBy="organization-experience-review-title"
    >
      <header className="agent-control-modal-header">
        <div>
          <AppModalTitle id="organization-experience-review-title">
            {t("agents.control.organizationExperience.reviewTitle")}
          </AppModalTitle>
          <p>{t("agents.control.organizationExperience.reviewBoundary")}</p>
        </div>
      </header>
      <div className="agent-control-modal-body">
        {loading ? <div className="loading-spinner" /> : null}
        {candidate ? (
          <>
            <dl className="agent-control-preview-grid">
              <div>
                <dt>{t("agents.control.organizationExperience.skill")}</dt>
                <dd>{candidate.skillName}</dd>
              </div>
              <div>
                <dt>
                  {t("agents.control.organizationExperience.sourceVersion")}
                </dt>
                <dd>{candidate.sourceAgentVersionId}</dd>
              </div>
            </dl>
            {candidate.bundle.assets.map((asset) => (
              <article key={asset.path}>
                <strong>{asset.path}</strong>
                <pre>{asset.content}</pre>
              </article>
            ))}
            {selected.canReview &&
            candidate.reviewStatus === "PENDING_REVIEW" ? (
              <>
                <div className="agent-control-install-options">
                  <label>
                    <input
                      type="radio"
                      name="organization-experience-decision"
                      checked={decision === "APPROVED"}
                      onChange={() => {
                        setDecision("APPROVED");
                        setReasonCode("");
                        setSafeNote("");
                      }}
                    />
                    <span>
                      {t("agents.control.organizationExperience.approve")}
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="organization-experience-decision"
                      checked={decision === "REJECTED"}
                      onChange={() => setDecision("REJECTED")}
                    />
                    <span>
                      {t("agents.control.organizationExperience.reject")}
                    </span>
                  </label>
                </div>
                {decision === "REJECTED" ? (
                  <>
                    <label className="agents-create-field">
                      <span>
                        {t(
                          "agents.control.organizationExperience.rejectionReason",
                        )}
                      </span>
                      <select
                        className="input"
                        value={reasonCode}
                        onChange={(event) => setReasonCode(event.target.value)}
                      >
                        <option value="" />
                        {REJECTION_REASONS.map((reason) => (
                          <option key={reason} value={reason}>
                            {t(
                              `agents.control.organizationExperience.reason.${reason}`,
                            )}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="agents-create-field">
                      <span>
                        {t("agents.control.organizationExperience.safeNote")}
                      </span>
                      <textarea
                        className="input agent-control-textarea"
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
                  disabled={!canCommit}
                  onClick={() => void commitReview()}
                >
                  {t("agents.control.organizationExperience.commitReview")}
                </button>
              </>
            ) : null}
            {preview && selected.canReview ? (
              <section>
                {preview.replacesExistingSkill ? (
                  <p className="agent-control-notice">
                    {t(
                      "agents.control.organizationExperience.replacementWarning",
                    )}
                  </p>
                ) : null}
                <ul>
                  {[
                    ...preview.addedPaths,
                    ...preview.replacedPaths,
                    ...preview.removedPaths,
                  ].map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
                <label className="agent-control-confirm-row">
                  <input
                    type="checkbox"
                    checked={confirmedImport}
                    disabled={busy}
                    aria-label={t(
                      "agents.control.organizationExperience.importConfirmation",
                    )}
                    onChange={(event) =>
                      setConfirmedImport(event.target.checked)
                    }
                  />
                  <span>
                    {t(
                      "agents.control.organizationExperience.importConfirmation",
                    )}
                  </span>
                </label>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!confirmedImport || !online || busy}
                  onClick={() => void createDraft()}
                >
                  {t("agents.control.organizationExperience.createDraft")}
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
          disabled={busy}
          onClick={onClose}
        >
          {t("agents.control.close")}
        </button>
      </footer>
    </AppModal>
  );
}

function OrganizationExperienceContributionDialog({
  target,
  online,
  onClose,
  onSubmitted,
}: {
  target: OrganizationExperienceContributionTarget;
  online: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [skills, setSkills] = useState<EligibleExperienceSkill[]>([]);
  const [skillName, setSkillName] = useState("");
  const [preview, setPreview] =
    useState<OrganizationExperienceCandidatePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSkills([]);
    setSkillName("");
    setPreview(null);
    setConfirmed(false);
    setError(null);
    if (
      target.installation.status !== "active" ||
      target.installation.sourceScope !== "ORGANIZATION"
    ) {
      setError("agents.control.errors.candidate_source_ineligible");
      return () => {
        active = false;
      };
    }
    void window.agenteraAgents
      .listEligibleOrganizationExperienceSkills(target.installation.id)
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setError(errorKey(result.errorCode));
          return;
        }
        setSkills(result.data);
      })
      .catch(() => {
        if (active) setError("agents.control.errors.operation_failed");
      });
    return () => {
      active = false;
    };
  }, [
    target.installation.id,
    target.installation.sourceScope,
    target.installation.status,
  ]);

  const prepare = async (): Promise<void> => {
    if (!skillName || busy) return;
    setBusy(true);
    setPreview(null);
    setConfirmed(false);
    setError(null);
    try {
      const result =
        await window.agenteraAgents.prepareOrganizationExperienceCandidate({
          installationId: target.installation.id,
          skillName,
        });
      if (!result.ok) {
        setError(errorKey(result.errorCode));
        return;
      }
      setPreview(result.data);
    } catch {
      setError("agents.control.errors.operation_failed");
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!preview || !confirmed || !online || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        await window.agenteraAgents.submitOrganizationExperienceCandidate({
          candidateHandle: preview.candidateHandle,
          confirmation: "submit-selected-organization-skill",
        });
      if (!result.ok) {
        setError(errorKey(result.errorCode));
        return;
      }
      onSubmitted();
      onClose();
    } catch {
      setError("agents.control.errors.operation_failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppModal
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      className="agent-control-modal"
      labelledBy="organization-experience-contribution-title"
    >
      <header className="agent-control-modal-header">
        <div>
          <AppModalTitle id="organization-experience-contribution-title">
            {t("agents.control.organizationExperience.contributionTitle")}
          </AppModalTitle>
          <p>{t("agents.control.organizationExperience.privateBoundary")}</p>
        </div>
      </header>
      <div className="agent-control-modal-body">
        <label className="agents-create-field">
          <span>{t("agents.control.organizationExperience.skill")}</span>
          <select
            className="input"
            aria-label={t("agents.control.organizationExperience.skill")}
            value={skillName}
            disabled={busy}
            onChange={(event) => {
              setSkillName(event.target.value);
              setPreview(null);
              setConfirmed(false);
            }}
          >
            <option value="">
              {t("agents.control.organizationExperience.chooseSkill")}
            </option>
            {skills.map((skill) => (
              <option key={skill.skillName} value={skill.skillName}>
                {skill.skillName}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!skillName || busy}
          onClick={() => void prepare()}
        >
          {t("agents.control.organizationExperience.preparePreview")}
        </button>
        {preview ? (
          <section>
            <dl className="agent-control-preview-grid">
              <div>
                <dt>
                  {t("agents.control.organizationExperience.sourceAgent")}
                </dt>
                <dd>{target.agentName}</dd>
              </div>
              <div>
                <dt>
                  {t("agents.control.organizationExperience.sourceVersion")}
                </dt>
                <dd>{preview.sourceAgentVersionId}</dd>
              </div>
              <div>
                <dt>{t("agents.control.totalBytes")}</dt>
                <dd>{preview.totalBytes}</dd>
              </div>
            </dl>
            <ul>
              {preview.assets.map((asset) => (
                <li key={asset.path}>{asset.path}</li>
              ))}
            </ul>
            <p>{t("agents.control.organizationExperience.dlpPassed")}</p>
            {!online ? (
              <p className="agent-control-notice">
                {t("agents.control.organizationExperience.onlineToSubmit")}
              </p>
            ) : null}
            <label className="agent-control-confirm-row">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy || preview.findings.length > 0}
                aria-label={t(
                  "agents.control.organizationExperience.submitConfirmation",
                )}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                {t("agents.control.organizationExperience.submitConfirmation")}
              </span>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!online || !confirmed || busy}
              onClick={() => void submit()}
            >
              {t("agents.control.organizationExperience.submitForReview")}
            </button>
          </section>
        ) : null}
        {error ? <div className="agents-create-error">{t(error)}</div> : null}
      </div>
      <footer className="agent-control-modal-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={onClose}
        >
          {t("agents.control.cancel")}
        </button>
      </footer>
    </AppModal>
  );
}

export default function OrganizationExperienceCandidatePanel({
  online,
  role,
  contextKey,
  refreshToken,
  contributionTarget,
  onCloseContribution,
  onDraftReady,
}: OrganizationExperienceCandidatePanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [own, setOwn] = useState<OrganizationExperienceCandidateSummary[]>([]);
  const [queue, setQueue] = useState<OrganizationExperienceCandidateSummary[]>(
    [],
  );
  const [selected, setSelected] = useState<SelectedCandidate | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(false);
  const [retryingHandle, setRetryingHandle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reviewer = canGovern(role);

  useEffect(() => {
    setSelected(null);
  }, [contextKey, refreshToken]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (role === "auditor") {
          setOwn([]);
        } else {
          const ownResult =
            await window.agenteraAgents.listMyOrganizationExperienceCandidates();
          if (!active) return;
          if (!ownResult.ok) {
            setError(errorKey(ownResult.errorCode));
            return;
          }
          setOwn(ownResult.data);
        }
        if (role === "member" || !online) {
          setQueue([]);
          return;
        }
        const queueResult =
          await window.agenteraAgents.listOrganizationExperienceReviewQueue();
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
  }, [contextKey, online, refreshToken, reloadToken, role]);

  const retryUpload = async (candidateHandle: string): Promise<void> => {
    if (!online || retryingHandle !== null) return;
    setRetryingHandle(candidateHandle);
    setError(null);
    try {
      const result =
        await window.agenteraAgents.submitOrganizationExperienceCandidate({
          candidateHandle,
          confirmation: "submit-selected-organization-skill",
        });
      if (!result.ok) {
        setError(errorKey(result.errorCode));
        return;
      }
      setReloadToken((value) => value + 1);
    } catch {
      setError("agents.control.errors.operation_failed");
    } finally {
      setRetryingHandle(null);
    }
  };

  const openCandidate = (
    candidate: OrganizationExperienceCandidateSummary,
    allowReview: boolean,
  ): void => {
    if (!candidate.cloudCandidateId) return;
    setSelected({
      candidateId: candidate.cloudCandidateId,
      reviewHandle: candidate.reviewHandle,
      canReview: allowReview,
    });
  };

  const card = (
    candidate: OrganizationExperienceCandidateSummary,
    source: "own" | "queue",
  ): React.JSX.Element => {
    const canRetry =
      source === "own" &&
      candidate.candidateHandle !== null &&
      (candidate.localStatus === "PREPARED" ||
        candidate.localStatus === "UPLOAD_FAILED");
    const canOpen =
      candidate.cloudCandidateId !== null &&
      (source === "queue" ||
        (reviewer && candidate.reviewStatus === "APPROVED"));
    return (
      <article
        key={`${source}-${candidate.cloudCandidateId ?? candidate.candidateHandle}`}
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
        {canRetry ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!online || retryingHandle !== null}
            onClick={() => void retryUpload(candidate.candidateHandle!)}
          >
            {t("agents.control.organizationExperience.retryUpload")}
          </button>
        ) : null}
        {canOpen ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!online}
            onClick={() => openCandidate(candidate, reviewer)}
          >
            {t(
              reviewer && candidate.reviewStatus === "PENDING_REVIEW"
                ? "agents.control.organizationExperience.review"
                : "agents.control.organizationExperience.view",
            )}
          </button>
        ) : null}
      </article>
    );
  };

  return (
    <section className="agent-control-group agent-control-installations">
      {role !== "auditor" ? (
        <section className="agent-control-group">
          <div className="agent-control-group-title">
            <h3>{t("agents.control.organizationExperience.myCandidates")}</h3>
            <span>{own.length}</span>
          </div>
          {loading && own.length === 0 ? (
            <div className="loading-spinner" />
          ) : own.length === 0 ? (
            <p className="agent-control-empty">
              {t("agents.control.organizationExperience.noCandidates")}
            </p>
          ) : (
            own.map((candidate) => card(candidate, "own"))
          )}
        </section>
      ) : null}
      {role !== "member" ? (
        <section className="agent-control-group">
          <div className="agent-control-group-title">
            <h3>{t("agents.control.organizationExperience.reviewQueue")}</h3>
            <span>{queue.length}</span>
          </div>
          {!online ? (
            <p className="agent-control-empty">
              {t("agents.control.organizationExperience.onlineToReview")}
            </p>
          ) : queue.length === 0 ? (
            <p className="agent-control-empty">
              {t("agents.control.organizationExperience.noReviewItems")}
            </p>
          ) : (
            queue.map((candidate) => card(candidate, "queue"))
          )}
        </section>
      ) : null}
      {error ? <div className="agents-create-error">{t(error)}</div> : null}
      {selected ? (
        <OrganizationExperienceReviewDialog
          selected={selected}
          online={online}
          onClose={() => setSelected(null)}
          onChanged={() => setReloadToken((value) => value + 1)}
          onImported={onDraftReady}
        />
      ) : null}
      {contributionTarget ? (
        <OrganizationExperienceContributionDialog
          target={contributionTarget}
          online={online}
          onClose={onCloseContribution}
          onSubmitted={() => setReloadToken((value) => value + 1)}
        />
      ) : null}
    </section>
  );
}
