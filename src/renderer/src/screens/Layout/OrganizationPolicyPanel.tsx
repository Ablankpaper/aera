import type {
  OrganizationPolicyDocument,
  OrganizationPolicySnapshot,
  OrganizationPolicySummary,
} from "../../../../shared/agentera-organization";
import { ApprovalIcon, Bot, Check, Clock, Sparkles } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";

interface OrganizationPolicyPanelProps {
  currentPolicy: OrganizationPolicySnapshot | null;
  currentPolicyVersion: number;
  policyHistory: readonly OrganizationPolicySummary[];
  policyDraft: OrganizationPolicyDocument;
  canAdminister: boolean;
  canAudit: boolean;
  writable: boolean;
  online: boolean;
  detailsLoading: boolean;
  onDraftChange: (document: OrganizationPolicyDocument) => void;
  onPublish: () => void;
}

function formatPolicyTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function experienceModeKey(mode: "disabled" | "manual_review"): string {
  return mode === "manual_review" ? "manualReview" : "disabled";
}

export default function OrganizationPolicyPanel({
  currentPolicy,
  currentPolicyVersion,
  policyHistory,
  policyDraft,
  canAdminister,
  canAudit,
  writable,
  online,
  detailsLoading,
  onDraftChange,
  onPublish,
}: OrganizationPolicyPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const activeDocument = currentPolicy?.document;
  const activeVersion = currentPolicy?.policyVersion ?? currentPolicyVersion;

  return (
    <section className="workspace-management-section organization-policy-panel">
      <div
        className="organization-policy-overview"
        data-testid="organization-policy-overview"
      >
        <div className="organization-policy-overview-icon">
          <ApprovalIcon size={20} aria-hidden="true" />
        </div>
        <div className="organization-policy-overview-body">
          <div className="organization-policy-overview-heading">
            <span>{t("navigation.organization.management.currentPolicy")}</span>
            {currentPolicy ? (
              <span className="organization-policy-status">
                <Check size={12} aria-hidden="true" />
                {t("navigation.organization.management.verifiedActive")}
              </span>
            ) : null}
          </div>
          <h3>
            {t("navigation.organization.management.policyVersion", {
              version: activeVersion,
            })}
          </h3>
          <p>
            {t("navigation.organization.management.currentPolicyDescription")}
          </p>
          {activeDocument ? (
            <dl className="organization-policy-active-values">
              <div>
                <dt>
                  {t("navigation.organization.management.experienceMode")}
                </dt>
                <dd>
                  {t(
                    `navigation.organization.management.${experienceModeKey(activeDocument.experienceCandidates.mode)}`,
                  )}
                </dd>
              </div>
              <div>
                <dt>
                  {t("navigation.organization.management.officialAgents")}
                </dt>
                <dd>
                  {t(
                    `navigation.organization.management.${activeDocument.officialAgents.installation}`,
                  )}
                </dd>
              </div>
            </dl>
          ) : null}
        </div>
        {currentPolicy?.createdAt ? (
          <time
            className="organization-policy-overview-time"
            dateTime={currentPolicy.createdAt}
          >
            {t("navigation.organization.management.policyUpdatedAt")}
            <strong>{formatPolicyTimestamp(currentPolicy.createdAt)}</strong>
          </time>
        ) : null}
      </div>

      {!detailsLoading && !activeDocument ? (
        <div className="organization-policy-restricted">
          <ApprovalIcon size={18} aria-hidden="true" />
          <div>
            <strong>
              {t("navigation.organization.management.policySummaryOnly")}
            </strong>
            <p>{t("navigation.organization.management.restricted")}</p>
          </div>
        </div>
      ) : null}

      {canAdminister && activeDocument ? (
        <div className="organization-policy-settings-block">
          <div className="organization-policy-section-heading">
            <div>
              <h3>{t("navigation.organization.management.policySettings")}</h3>
              <p>
                {t(
                  "navigation.organization.management.policySettingsDescription",
                )}
              </p>
            </div>
            <span>{t("navigation.organization.management.draftPolicy")}</span>
          </div>

          <div className="organization-policy-settings">
            <article className="organization-policy-setting-card">
              <div className="organization-policy-setting-header">
                <span className="organization-policy-setting-icon">
                  <Sparkles size={17} aria-hidden="true" />
                </span>
                <div>
                  <h4>
                    {t("navigation.organization.management.experienceMode")}
                  </h4>
                  <p>
                    {t(
                      "navigation.organization.management.experiencePolicyDescription",
                    )}
                  </p>
                </div>
              </div>
              <div className="organization-policy-current-setting">
                <span>
                  {t("navigation.organization.management.currentSetting")}
                </span>
                <strong>
                  {t(
                    `navigation.organization.management.${experienceModeKey(activeDocument.experienceCandidates.mode)}`,
                  )}
                </strong>
              </div>
              <label className="organization-policy-control">
                <span>
                  {t("navigation.organization.management.newVersionSetting")}
                </span>
                <select
                  aria-label={t(
                    "navigation.organization.management.experienceMode",
                  )}
                  value={policyDraft.experienceCandidates.mode}
                  disabled={!writable}
                  data-testid="organization-mutation"
                  onChange={(event) =>
                    onDraftChange({
                      ...policyDraft,
                      experienceCandidates: {
                        mode: event.target.value as
                          | "disabled"
                          | "manual_review",
                      },
                    })
                  }
                >
                  <option value="manual_review">
                    {t("navigation.organization.management.manualReview")}
                  </option>
                  <option value="disabled">
                    {t("navigation.organization.management.disabled")}
                  </option>
                </select>
              </label>
            </article>

            <article className="organization-policy-setting-card">
              <div className="organization-policy-setting-header">
                <span className="organization-policy-setting-icon">
                  <Bot size={17} aria-hidden="true" />
                </span>
                <div>
                  <h4>
                    {t("navigation.organization.management.officialAgents")}
                  </h4>
                  <p>
                    {t(
                      "navigation.organization.management.officialAgentsPolicyDescription",
                    )}
                  </p>
                </div>
              </div>
              <div className="organization-policy-current-setting">
                <span>
                  {t("navigation.organization.management.currentSetting")}
                </span>
                <strong>
                  {t(
                    `navigation.organization.management.${activeDocument.officialAgents.installation}`,
                  )}
                </strong>
              </div>
              <label className="organization-policy-control">
                <span>
                  {t("navigation.organization.management.newVersionSetting")}
                </span>
                <select
                  aria-label={t(
                    "navigation.organization.management.officialAgents",
                  )}
                  value={policyDraft.officialAgents.installation}
                  disabled={!writable}
                  data-testid="organization-mutation"
                  onChange={(event) =>
                    onDraftChange({
                      ...policyDraft,
                      officialAgents: {
                        installation: event.target.value as
                          | "allowed"
                          | "blocked",
                      },
                    })
                  }
                >
                  <option value="allowed">
                    {t("navigation.organization.management.allowed")}
                  </option>
                  <option value="blocked">
                    {t("navigation.organization.management.blocked")}
                  </option>
                </select>
              </label>
            </article>
          </div>

          <div
            className="organization-policy-publish-bar"
            data-testid="organization-policy-publish-bar"
          >
            <span className="organization-policy-publish-icon">
              <ApprovalIcon size={18} aria-hidden="true" />
            </span>
            <div>
              <strong>
                {t("navigation.organization.management.publishNewPolicy")}
              </strong>
              <p>
                {t("navigation.organization.management.nextPolicyVersion", {
                  version: currentPolicyVersion + 1,
                })}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!writable}
              data-testid="organization-mutation"
              onClick={onPublish}
            >
              {t("navigation.organization.management.publishPolicy")}
            </button>
          </div>
        </div>
      ) : null}

      {canAudit ? (
        <div className="organization-policy-history">
          <div className="organization-policy-section-heading">
            <div>
              <h3>{t("navigation.organization.management.policyHistory")}</h3>
              <p>
                {t(
                  "navigation.organization.management.policyHistoryDescription",
                )}
              </p>
            </div>
            {policyHistory.length > 0 ? (
              <span>{policyHistory.length}</span>
            ) : null}
          </div>
          <div
            className="organization-policy-history-list"
            data-testid="organization-policy-history-list"
          >
            {policyHistory.length === 0 ? (
              <p className="organization-policy-history-empty">
                {t(
                  online
                    ? "navigation.organization.management.policyHistoryEmpty"
                    : "navigation.organization.management.policyHistoryOnlineOnly",
                )}
              </p>
            ) : (
              policyHistory.map((policy) => {
                const isCurrent = policy.policyVersion === activeVersion;
                return (
                  <article
                    className="organization-policy-history-item"
                    key={policy.id}
                    aria-current={isCurrent ? "true" : undefined}
                  >
                    <span className="organization-policy-history-icon">
                      <Clock size={15} aria-hidden="true" />
                    </span>
                    <div className="organization-policy-history-copy">
                      <strong>
                        {t("navigation.organization.management.policyVersion", {
                          version: policy.policyVersion,
                        })}
                      </strong>
                      <span>{formatPolicyTimestamp(policy.createdAt)}</span>
                      <small
                        title={`${t("navigation.organization.management.policyIssuer")}: ${policy.issuer}\n${t("navigation.organization.management.policyDigest")}: ${policy.contentDigest}`}
                      >
                        {t(
                          "navigation.organization.management.policySignatureVerified",
                        )}
                      </small>
                    </div>
                    {isCurrent ? (
                      <span className="organization-policy-current-version">
                        <Check size={11} aria-hidden="true" />
                        {t("navigation.organization.management.currentVersion")}
                      </span>
                    ) : null}
                  </article>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
