import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import type {
  AgenteraOrganizationErrorCode,
  AgenteraOrganizationResult,
  OrganizationAuditEvent,
  OrganizationDepartment,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationPolicyDocument,
  OrganizationPolicySnapshot,
  OrganizationPolicySummary,
  OrganizationPublicState,
} from "../../../../shared/agentera-organization";
import { Copy, Refresh, Trash, X } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";
import OrganizationPolicyPanel from "./OrganizationPolicyPanel";

type AuthorizedState = Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
>;

type Tab =
  "overview" | "members" | "departments" | "invitations" | "policy" | "audit";

interface OrganizationManagementDialogProps {
  open: boolean;
  authState: AuthorizedState;
  onClose: () => void;
}

const DEFAULT_POLICY: OrganizationPolicyDocument = {
  schemaVersion: 1,
  models: { allowlist: null },
  tools: { allowlist: null },
  experienceCandidates: { mode: "manual_review" },
  officialAgents: { installation: "allowed" },
};

function roleKey(role: OrganizationMember["role"]): string {
  return `navigation.organization.roles.${role}`;
}

function canManageOrganization(role: OrganizationMember["role"]): boolean {
  return role === "owner" || role === "admin";
}

function canReviewOrganizationGovernance(
  role: OrganizationMember["role"],
): boolean {
  return canManageOrganization(role) || role === "auditor";
}

export default function OrganizationManagementDialog({
  open,
  authState,
  onClose,
}: OrganizationManagementDialogProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [organizationState, setOrganizationState] =
    useState<OrganizationPublicState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [members, setMembers] = useState<readonly OrganizationMember[]>([]);
  const [departments, setDepartments] = useState<
    readonly OrganizationDepartment[]
  >([]);
  const [invitations, setInvitations] = useState<
    readonly OrganizationInvitation[]
  >([]);
  const [currentPolicy, setCurrentPolicy] =
    useState<OrganizationPolicySnapshot | null>(null);
  const [policyHistory, setPolicyHistory] = useState<
    readonly OrganizationPolicySummary[]
  >([]);
  const [auditEvents, setAuditEvents] = useState<
    readonly OrganizationAuditEvent[]
  >([]);
  const [policyDraft, setPolicyDraft] =
    useState<OrganizationPolicyDocument>(DEFAULT_POLICY);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] =
    useState<AgenteraOrganizationErrorCode | null>(null);
  const [renameName, setRenameName] = useState("");
  const [departmentName, setDepartmentName] = useState("");
  const [invitationSecret, setInvitationSecret] = useState<string | null>(null);
  const [secretUnavailable, setSecretUnavailable] = useState(false);
  const [transferTarget, setTransferTarget] = useState("");
  const [transferConfirmation, setTransferConfirmation] = useState("");
  const [dissolveName, setDissolveName] = useState("");
  const [dissolveConfirmation, setDissolveConfirmation] = useState("");
  const [detailsRefreshToken, setDetailsRefreshToken] = useState(0);
  const detailsEpoch = useRef(0);
  const contextRef = useRef({ open, userId: authState.userId, selectedId });
  contextRef.current = { open, userId: authState.userId, selectedId };

  const governanceOrganizations = useMemo(
    () =>
      organizationState?.organizations.filter((organization) =>
        canReviewOrganizationGovernance(organization.role),
      ) ?? [],
    [organizationState],
  );
  const selectedOrganization = useMemo(
    () =>
      governanceOrganizations.find(
        (organization) => organization.id === selectedId,
      ),
    [governanceOrganizations, selectedId],
  );
  const online =
    authState.status === "authenticated" &&
    authState.cloudAvailable &&
    organizationState?.access === "online" &&
    organizationState.cloudAvailable;
  const role = selectedOrganization?.role;
  const active = selectedOrganization?.status === "active";
  const writable = Boolean(online && active && !busy);
  const ownerTransferWritable = Boolean(
    online && selectedOrganization?.status !== "dissolved" && !busy,
  );
  const dissolutionWritable = Boolean(
    online && selectedOrganization?.status === "archived" && !busy,
  );
  const canAdminister = role === "owner" || role === "admin";
  const canAudit = canAdminister || role === "auditor";
  const isOwner = role === "owner";

  const applyState = useCallback(
    (next: OrganizationPublicState, preferredId?: string | null): void => {
      setOrganizationState(next);
      setSelectedId((current) => {
        const candidate = preferredId === undefined ? current : preferredId;
        if (
          candidate &&
          next.organizations.some(
            (organization) =>
              organization.id === candidate &&
              canReviewOrganizationGovernance(organization.role),
          )
        ) {
          return candidate;
        }
        return (
          next.organizations.find((organization) =>
            canReviewOrganizationGovernance(organization.role),
          )?.id ?? null
        );
      });
    },
    [],
  );

  useEffect(() => {
    if (!open) {
      detailsEpoch.current += 1;
      setInvitationSecret(null);
      setSecretUnavailable(false);
      setErrorCode(null);
      return;
    }
    let current = true;
    setLoading(true);
    setOrganizationState(null);
    setSelectedId(null);
    setTab("overview");
    setErrorCode(null);
    setBusy(false);
    setInvitationSecret(null);
    setSecretUnavailable(false);

    const productUnsubscribe = window.agenteraProductSpace.onStateChanged(
      (state) => {
        if (
          !current ||
          state.selected.kind !== "ORGANIZATION" ||
          !canReviewOrganizationGovernance(state.selected.role)
        ) {
          return;
        }
        setSelectedId(state.selected.organizationId);
        setTab("overview");
      },
    );
    const organizationUnsubscribe = window.agenteraOrganization.onStateChanged(
      (state) => {
        if (!current) return;
        applyState(state);
      },
    );

    void Promise.all([
      window.agenteraOrganization.getState(),
      window.agenteraProductSpace.getState(),
    ])
      .then(([organizationResult, productResult]) => {
        if (!current) return;
        if (!organizationResult.ok) {
          setErrorCode(organizationResult.errorCode);
          return;
        }
        const preferredId =
          productResult.ok &&
          productResult.data.selected.kind === "ORGANIZATION"
            ? productResult.data.selected.organizationId
            : undefined;
        applyState(organizationResult.data, preferredId);
      })
      .catch(() => {
        if (current) setErrorCode("service_unavailable");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      detailsEpoch.current += 1;
      productUnsubscribe();
      organizationUnsubscribe();
    };
  }, [applyState, authState.personalSpaceId, authState.userId, open]);

  useEffect(() => {
    setInvitationSecret(null);
    setSecretUnavailable(false);
    setTransferTarget("");
    setTransferConfirmation("");
    setDissolveName("");
    setDissolveConfirmation("");
  }, [authState.userId, open, selectedId]);

  useEffect(() => {
    if (selectedOrganization?.role !== "auditor") return;
    setTab((current) =>
      current === "policy" || current === "audit" ? current : "policy",
    );
  }, [selectedOrganization?.role, selectedId]);

  useEffect(() => {
    if (!open || !selectedOrganization) {
      setMembers([]);
      setDepartments([]);
      setInvitations([]);
      setCurrentPolicy(null);
      setPolicyHistory([]);
      setAuditEvents([]);
      return;
    }
    const epoch = ++detailsEpoch.current;
    const organizationId = selectedOrganization.id;
    const organizationRole = selectedOrganization.role;
    setRenameName(selectedOrganization.displayName);
    setDetailsLoading(true);
    setMembers([]);
    setDepartments([]);
    setInvitations([]);
    setCurrentPolicy(null);
    setPolicyHistory([]);
    setAuditEvents([]);

    const loadDetails = async (): Promise<void> => {
      try {
        const [memberResult, departmentResult, policyResult] =
          await Promise.all([
            window.agenteraOrganization.listMembers({ organizationId }),
            window.agenteraOrganization.listDepartments({ organizationId }),
            window.agenteraOrganization.getCurrentPolicy({ organizationId }),
          ]);
        if (epoch !== detailsEpoch.current) return;
        if (memberResult.ok) setMembers(memberResult.data.items);
        else setErrorCode(memberResult.errorCode);
        if (departmentResult.ok) setDepartments(departmentResult.data.items);
        else setErrorCode(departmentResult.errorCode);
        if (policyResult.ok) {
          setCurrentPolicy(policyResult.data.policy);
          if (policyResult.data.policy?.document) {
            setPolicyDraft(policyResult.data.policy.document);
          }
        } else {
          setErrorCode(policyResult.errorCode);
        }

        const privilegedOnline =
          online &&
          (organizationRole === "owner" ||
            organizationRole === "admin" ||
            organizationRole === "auditor");
        if (
          online &&
          (organizationRole === "owner" || organizationRole === "admin")
        ) {
          const invitationResult =
            await window.agenteraOrganization.listInvitations({
              organizationId,
            });
          if (epoch !== detailsEpoch.current) return;
          if (invitationResult.ok) setInvitations(invitationResult.data.items);
          else setErrorCode(invitationResult.errorCode);
        }
        if (privilegedOnline) {
          const [historyResult, auditResult] = await Promise.all([
            window.agenteraOrganization.listPolicySnapshots({ organizationId }),
            window.agenteraOrganization.listAuditEvents({
              organizationId,
              limit: 50,
            }),
          ]);
          if (epoch !== detailsEpoch.current) return;
          if (historyResult.ok) setPolicyHistory(historyResult.data);
          else setErrorCode(historyResult.errorCode);
          if (auditResult.ok) setAuditEvents(auditResult.data.items);
          else setErrorCode(auditResult.errorCode);
        }
      } catch {
        if (epoch === detailsEpoch.current) {
          setErrorCode("service_unavailable");
        }
      } finally {
        if (epoch === detailsEpoch.current) setDetailsLoading(false);
      }
    };
    void loadDetails();
  }, [detailsRefreshToken, online, open, selectedId, selectedOrganization]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  const refreshState = useCallback(
    async (preferredId?: string | null): Promise<void> => {
      const result = await window.agenteraOrganization.refresh();
      if (!result.ok) {
        setErrorCode(result.errorCode);
        return;
      }
      applyState(result.data, preferredId);
    },
    [applyState],
  );

  const run = useCallback(
    async <T,>(
      operation: () => Promise<AgenteraOrganizationResult<T>>,
      after?: (data: T) => Promise<void> | void,
    ): Promise<void> => {
      const started = { ...contextRef.current };
      setBusy(true);
      setErrorCode(null);
      try {
        const result = await operation();
        const latest = contextRef.current;
        if (
          !latest.open ||
          latest.userId !== started.userId ||
          latest.selectedId !== started.selectedId
        ) {
          return;
        }
        if (!result.ok) {
          setErrorCode(result.errorCode);
          return;
        }
        await after?.(result.data);
      } catch {
        const latest = contextRef.current;
        if (
          latest.open &&
          latest.userId === started.userId &&
          latest.selectedId === started.selectedId
        ) {
          setErrorCode("service_unavailable");
        }
      } finally {
        const latest = contextRef.current;
        if (
          latest.open &&
          latest.userId === started.userId &&
          latest.selectedId === started.selectedId
        ) {
          setBusy(false);
        }
      }
    },
    [],
  );

  const reloadDetails = (): void => {
    setDetailsRefreshToken((current) => current + 1);
  };

  if (!open) return null;

  const tabs: Tab[] =
    role === "auditor"
      ? ["policy", "audit"]
      : [
          "overview",
          "members",
          "departments",
          "invitations",
          "policy",
          "audit",
        ];

  const ownerMember = members.find((member) => member.role === "owner");
  const transferMember = members.find(
    (member) => member.userId === transferTarget && member.role === "admin",
  );
  const transferReady =
    ownerTransferWritable &&
    Boolean(ownerMember && transferMember) &&
    transferConfirmation === "transfer-organization-owner";
  const dissolveReady =
    dissolutionWritable &&
    dissolveName === selectedOrganization?.displayName &&
    dissolveConfirmation === "dissolve-organization";

  return (
    <div
      className="workspace-management-overlay organization-management-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="workspace-management-dialog organization-management-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="organization-management-title"
      >
        <header className="workspace-management-header">
          <div>
            <h2 id="organization-management-title">
              {t("navigation.organization.management.title")}
            </h2>
            <p>{t("navigation.organization.management.description")}</p>
          </div>
          <button
            type="button"
            className="workspace-management-close"
            aria-label={t("navigation.organization.management.close")}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {!online && (
          <div className="workspace-management-readonly" role="status">
            {t("navigation.organization.management.offlineReadOnly")}
          </div>
        )}
        {organizationState?.stale && (
          <div className="workspace-management-stale" role="status">
            {t("navigation.organization.management.staleData")}
          </div>
        )}
        {errorCode && (
          <div className="workspace-management-error" role="alert">
            {t(`navigation.organization.errors.${errorCode}`)}
          </div>
        )}

        <div className="workspace-management-body">
          <aside className="workspace-management-list">
            {loading ? (
              <p>{t("navigation.organization.management.loading")}</p>
            ) : governanceOrganizations.length ? (
              <div className="workspace-management-list-items">
                {governanceOrganizations.map((organization) => (
                  <button
                    type="button"
                    key={organization.id}
                    className={organization.id === selectedId ? "active" : ""}
                    aria-pressed={organization.id === selectedId}
                    onClick={() => {
                      setSelectedId(organization.id);
                      setTab("overview");
                    }}
                  >
                    <span>{organization.displayName}</span>
                    <small>
                      {t(`navigation.organization.roles.${organization.role}`)}
                      {organization.status !== "active"
                        ? ` · ${t(`navigation.organization.management.${organization.status}`)}`
                        : ""}
                    </small>
                  </button>
                ))}
              </div>
            ) : (
              <p>{t("navigation.organization.management.empty")}</p>
            )}
          </aside>

          <main className="workspace-management-detail organization-management-detail">
            {!selectedOrganization ? (
              <p>{t("navigation.organization.management.select")}</p>
            ) : (
              <>
                <div className="workspace-management-title-row">
                  <strong>{t(`navigation.organization.roles.${role}`)}</strong>
                  <span>
                    {selectedOrganization.memberCount}{" "}
                    {t("navigation.organization.management.members")} ·{" "}
                    {selectedOrganization.departmentCount}{" "}
                    {t("navigation.organization.management.departments")}
                  </span>
                </div>
                <div className="organization-management-tabs" role="tablist">
                  {tabs.map((item) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === item}
                      key={item}
                      onClick={() => setTab(item)}
                    >
                      {t(`navigation.organization.management.${item}`)}
                    </button>
                  ))}
                </div>

                {detailsLoading && (
                  <p>{t("navigation.organization.management.loading")}</p>
                )}

                {tab === "overview" && (
                  <section className="workspace-management-section organization-overview">
                    {canAdminister && (
                      <form
                        className="workspace-management-rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!renameName || !writable) return;
                          void run(
                            () =>
                              window.agenteraOrganization.rename({
                                organizationId: selectedOrganization.id,
                                displayName: renameName,
                                expectedRevision: selectedOrganization.revision,
                              }),
                            async () => refreshState(selectedOrganization.id),
                          );
                        }}
                      >
                        <label>
                          <span>
                            {t("navigation.organization.management.renameName")}
                          </span>
                          <input
                            value={renameName}
                            onChange={(event) =>
                              setRenameName(event.target.value)
                            }
                            disabled={!writable}
                            aria-label={t(
                              "navigation.organization.management.renameName",
                            )}
                          />
                        </label>
                        <button
                          type="submit"
                          className="btn btn-secondary btn-sm"
                          disabled={!writable || !renameName}
                          data-testid="organization-mutation"
                        >
                          {t("navigation.organization.management.rename")}
                        </button>
                      </form>
                    )}

                    <div className="workspace-management-lifecycle">
                      {isOwner && selectedOrganization.status === "active" && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={!writable}
                          data-testid="organization-mutation"
                          onClick={() => {
                            if (
                              !window.confirm(
                                t(
                                  "navigation.organization.management.confirmArchive",
                                ),
                              )
                            )
                              return;
                            void run(
                              () =>
                                window.agenteraOrganization.archive({
                                  organizationId: selectedOrganization.id,
                                  expectedRevision:
                                    selectedOrganization.revision,
                                }),
                              async () => refreshState(selectedOrganization.id),
                            );
                          }}
                        >
                          {t("navigation.organization.management.archive")}
                        </button>
                      )}
                      {isOwner &&
                        selectedOrganization.status === "archived" && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={!online || busy}
                            data-testid="organization-mutation"
                            onClick={() =>
                              void run(
                                () =>
                                  window.agenteraOrganization.restore({
                                    organizationId: selectedOrganization.id,
                                    expectedRevision:
                                      selectedOrganization.revision,
                                  }),
                                async () =>
                                  refreshState(selectedOrganization.id),
                              )
                            }
                          >
                            {t("navigation.organization.management.restore")}
                          </button>
                        )}
                      {!isOwner && (
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={!writable}
                          data-testid="organization-mutation"
                          onClick={() => {
                            if (
                              !window.confirm(
                                t(
                                  "navigation.organization.management.confirmLeave",
                                ),
                              )
                            )
                              return;
                            void run(
                              () =>
                                window.agenteraOrganization.leave({
                                  organizationId: selectedOrganization.id,
                                }),
                              async () => refreshState(null),
                            );
                          }}
                        >
                          {t("navigation.organization.management.leave")}
                        </button>
                      )}
                    </div>

                    {isOwner && (
                      <div className="organization-management-danger-zone">
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (
                              !transferReady ||
                              !ownerMember ||
                              !transferMember
                            )
                              return;
                            void run(
                              () =>
                                window.agenteraOrganization.transferOwner({
                                  organizationId: selectedOrganization.id,
                                  targetUserId: transferMember.userId,
                                  expectedOrganizationRevision:
                                    selectedOrganization.revision,
                                  expectedOwnerRevision: ownerMember.revision,
                                  expectedTargetRevision:
                                    transferMember.revision,
                                  confirmation: "transfer-organization-owner",
                                }),
                              async () => refreshState(selectedOrganization.id),
                            );
                          }}
                        >
                          <label>
                            <span>
                              {t(
                                "navigation.organization.management.transferTarget",
                              )}
                            </span>
                            <input
                              aria-label={t(
                                "navigation.organization.management.transferTarget",
                              )}
                              value={transferTarget}
                              onChange={(event) =>
                                setTransferTarget(event.target.value)
                              }
                              disabled={!ownerTransferWritable}
                            />
                          </label>
                          <label>
                            <span>
                              {t(
                                "navigation.organization.management.transferConfirmation",
                              )}
                            </span>
                            <input
                              aria-label={t(
                                "navigation.organization.management.transferConfirmation",
                              )}
                              value={transferConfirmation}
                              onChange={(event) =>
                                setTransferConfirmation(event.target.value)
                              }
                              disabled={!ownerTransferWritable}
                            />
                          </label>
                          <button
                            type="submit"
                            className="btn btn-danger btn-sm"
                            disabled={!transferReady}
                            data-testid="organization-mutation"
                          >
                            {t(
                              "navigation.organization.management.transferOwner",
                            )}
                          </button>
                        </form>
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (!dissolveReady) return;
                            void run(
                              () =>
                                window.agenteraOrganization.dissolve({
                                  organizationId: selectedOrganization.id,
                                  displayName: selectedOrganization.displayName,
                                  expectedRevision:
                                    selectedOrganization.revision,
                                  confirmation: "dissolve-organization",
                                }),
                              async () => refreshState(null),
                            );
                          }}
                        >
                          <label>
                            <span>
                              {t(
                                "navigation.organization.management.dissolveName",
                              )}
                            </span>
                            <input
                              aria-label={t(
                                "navigation.organization.management.dissolveName",
                              )}
                              value={dissolveName}
                              onChange={(event) =>
                                setDissolveName(event.target.value)
                              }
                              disabled={!dissolutionWritable}
                            />
                          </label>
                          <label>
                            <span>
                              {t(
                                "navigation.organization.management.dissolveConfirmation",
                              )}
                            </span>
                            <input
                              aria-label={t(
                                "navigation.organization.management.dissolveConfirmation",
                              )}
                              value={dissolveConfirmation}
                              onChange={(event) =>
                                setDissolveConfirmation(event.target.value)
                              }
                              disabled={!dissolutionWritable}
                            />
                          </label>
                          <button
                            type="submit"
                            className="btn btn-danger btn-sm"
                            disabled={!dissolveReady}
                            data-testid="organization-mutation"
                          >
                            {t("navigation.organization.management.dissolve")}
                          </button>
                        </form>
                      </div>
                    )}
                  </section>
                )}

                {tab === "members" && (
                  <section className="workspace-management-section">
                    <h3>{t("navigation.organization.management.members")}</h3>
                    <div className="workspace-member-list">
                      {members.map((member) => {
                        const canEdit =
                          (isOwner ||
                            (role === "admin" &&
                              (member.role === "member" ||
                                member.role === "auditor"))) &&
                          member.role !== "owner" &&
                          member.userId !== authState.userId;
                        return (
                          <div
                            className="workspace-member-row"
                            key={member.userId}
                          >
                            <div>
                              <strong>
                                {member.nickname ??
                                  `${member.userId.slice(0, 8)}…`}
                              </strong>
                              <span>{t(roleKey(member.role))}</span>
                            </div>
                            {canEdit && (
                              <div className="workspace-member-actions">
                                <select
                                  aria-label={`${t("navigation.organization.management.role")}:${member.userId}`}
                                  value={member.role}
                                  disabled={!writable}
                                  data-testid="organization-mutation"
                                  onChange={(event) =>
                                    void run(
                                      () =>
                                        window.agenteraOrganization.patchMember(
                                          {
                                            organizationId:
                                              selectedOrganization.id,
                                            userId: member.userId,
                                            patch: {
                                              role: event.target.value as
                                                "admin" | "auditor" | "member",
                                              expectedRevision: member.revision,
                                            },
                                          },
                                        ),
                                      reloadDetails,
                                    )
                                  }
                                >
                                  {isOwner && (
                                    <option value="admin">
                                      {t("navigation.organization.roles.admin")}
                                    </option>
                                  )}
                                  <option value="auditor">
                                    {t("navigation.organization.roles.auditor")}
                                  </option>
                                  <option value="member">
                                    {t("navigation.organization.roles.member")}
                                  </option>
                                </select>
                                <select
                                  aria-label={`${t("navigation.organization.management.department")}:${member.userId}`}
                                  value={member.departmentId ?? ""}
                                  disabled={!writable}
                                  data-testid="organization-mutation"
                                  onChange={(event) =>
                                    void run(
                                      () =>
                                        window.agenteraOrganization.patchMember(
                                          {
                                            organizationId:
                                              selectedOrganization.id,
                                            userId: member.userId,
                                            patch: {
                                              departmentId:
                                                event.target.value || null,
                                              expectedRevision: member.revision,
                                            },
                                          },
                                        ),
                                      reloadDetails,
                                    )
                                  }
                                >
                                  <option value="">
                                    {t(
                                      "navigation.organization.management.noDepartment",
                                    )}
                                  </option>
                                  {departments
                                    .filter(
                                      (department) =>
                                        department.status === "active",
                                    )
                                    .map((department) => (
                                      <option
                                        key={department.id}
                                        value={department.id}
                                      >
                                        {department.displayName}
                                      </option>
                                    ))}
                                </select>
                                <button
                                  type="button"
                                  className="btn btn-danger btn-sm"
                                  disabled={!writable}
                                  data-testid="organization-mutation"
                                  onClick={() => {
                                    if (
                                      !window.confirm(
                                        t(
                                          "navigation.organization.management.confirmRemove",
                                        ),
                                      )
                                    )
                                      return;
                                    void run(
                                      () =>
                                        window.agenteraOrganization.removeMember(
                                          {
                                            organizationId:
                                              selectedOrganization.id,
                                            userId: member.userId,
                                            expectedRevision: member.revision,
                                          },
                                        ),
                                      reloadDetails,
                                    );
                                  }}
                                >
                                  {t(
                                    "navigation.organization.management.removeMember",
                                  )}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                {tab === "departments" && (
                  <section className="workspace-management-section">
                    <div className="workspace-management-section-heading">
                      <h3>
                        {t("navigation.organization.management.departments")}
                      </h3>
                      {canAdminister && (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (!departmentName || !writable) return;
                            void run(
                              () =>
                                window.agenteraOrganization.createDepartment({
                                  organizationId: selectedOrganization.id,
                                  displayName: departmentName,
                                }),
                              () => {
                                setDepartmentName("");
                                reloadDetails();
                              },
                            );
                          }}
                        >
                          <input
                            aria-label={t(
                              "navigation.organization.management.departmentName",
                            )}
                            value={departmentName}
                            onChange={(event) =>
                              setDepartmentName(event.target.value)
                            }
                            disabled={!writable}
                          />
                          <button
                            type="submit"
                            className="btn btn-primary btn-sm"
                            disabled={!writable || !departmentName}
                            data-testid="organization-mutation"
                          >
                            {t(
                              "navigation.organization.management.createDepartment",
                            )}
                          </button>
                        </form>
                      )}
                    </div>
                    <div className="workspace-member-list">
                      {departments.map((department) => (
                        <div
                          className="workspace-member-row"
                          key={department.id}
                        >
                          <div>
                            <strong>{department.displayName}</strong>
                            <span>{department.memberCount}</span>
                          </div>
                          {canAdminister && (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={!writable}
                              data-testid="organization-mutation"
                              onClick={() =>
                                void run(
                                  () =>
                                    department.status === "active"
                                      ? window.agenteraOrganization.archiveDepartment(
                                          {
                                            organizationId:
                                              selectedOrganization.id,
                                            departmentId: department.id,
                                            expectedRevision:
                                              department.revision,
                                          },
                                        )
                                      : window.agenteraOrganization.restoreDepartment(
                                          {
                                            organizationId:
                                              selectedOrganization.id,
                                            departmentId: department.id,
                                            expectedRevision:
                                              department.revision,
                                          },
                                        ),
                                  reloadDetails,
                                )
                              }
                            >
                              {t(
                                department.status === "active"
                                  ? "navigation.organization.management.archiveDepartment"
                                  : "navigation.organization.management.restoreDepartment",
                              )}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {tab === "invitations" && canAdminister && (
                  <section className="workspace-management-section">
                    <div className="workspace-management-section-heading">
                      <h3>
                        {t("navigation.organization.management.invitations")}
                      </h3>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!writable}
                        data-testid="organization-mutation"
                        onClick={() => {
                          setInvitationSecret(null);
                          setSecretUnavailable(false);
                          void run(
                            () =>
                              window.agenteraOrganization.createInvitation({
                                organizationId: selectedOrganization.id,
                              }),
                            async (created) => {
                              if (created.inviteUrl && created.token) {
                                setInvitationSecret(created.inviteUrl);
                              } else {
                                setSecretUnavailable(true);
                              }
                              const result =
                                await window.agenteraOrganization.listInvitations(
                                  {
                                    organizationId: selectedOrganization.id,
                                  },
                                );
                              if (result.ok) setInvitations(result.data.items);
                              else setErrorCode(result.errorCode);
                            },
                          );
                        }}
                      >
                        {t(
                          "navigation.organization.management.createInvitation",
                        )}
                      </button>
                    </div>
                    {invitationSecret && (
                      <div className="workspace-invitation-secret">
                        <p>
                          {t(
                            "navigation.organization.management.invitationSecretOnce",
                          )}
                        </p>
                        <code>{invitationSecret}</code>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          aria-label={t(
                            "navigation.organization.management.copyInvitation",
                          )}
                          onClick={() =>
                            void navigator.clipboard.writeText(invitationSecret)
                          }
                        >
                          <Copy size={14} aria-hidden="true" />
                          {t(
                            "navigation.organization.management.copyInvitation",
                          )}
                        </button>
                      </div>
                    )}
                    {secretUnavailable && (
                      <p>
                        {t(
                          "navigation.organization.management.invitationSecretUnavailable",
                        )}
                      </p>
                    )}
                    <div className="workspace-invitation-list">
                      {invitations.map((invitation) => (
                        <div
                          className="workspace-invitation-row"
                          key={invitation.id}
                        >
                          <div>
                            <strong>
                              {t(
                                `navigation.organization.invitationStatus.${invitation.status}`,
                              )}
                            </strong>
                            <span>{invitation.expiresAt}</span>
                          </div>
                          {invitation.status === "pending" && (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={!writable}
                              data-testid="organization-mutation"
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    t(
                                      "navigation.organization.management.confirmRevoke",
                                    ),
                                  )
                                )
                                  return;
                                void run(
                                  () =>
                                    window.agenteraOrganization.revokeInvitation(
                                      {
                                        organizationId: selectedOrganization.id,
                                        invitationId: invitation.id,
                                      },
                                    ),
                                  reloadDetails,
                                );
                              }}
                            >
                              <Trash size={13} aria-hidden="true" />
                              {t(
                                "navigation.organization.management.revokeInvitation",
                              )}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {tab === "policy" && (
                  <OrganizationPolicyPanel
                    currentPolicy={currentPolicy}
                    currentPolicyVersion={
                      selectedOrganization.currentPolicyVersion
                    }
                    policyHistory={policyHistory}
                    policyDraft={policyDraft}
                    canAdminister={canAdminister}
                    canAudit={canAudit}
                    writable={writable}
                    online={Boolean(online)}
                    detailsLoading={detailsLoading}
                    onDraftChange={setPolicyDraft}
                    onPublish={() =>
                      void run(
                        () =>
                          window.agenteraOrganization.publishPolicy({
                            organizationId: selectedOrganization.id,
                            document: policyDraft,
                            expectedOrganizationRevision:
                              selectedOrganization.revision,
                            expectedPolicyVersion:
                              selectedOrganization.currentPolicyVersion + 1,
                          }),
                        async () => refreshState(selectedOrganization.id),
                      )
                    }
                  />
                )}

                {tab === "audit" && canAudit && (
                  <section className="workspace-management-section">
                    <h3>{t("navigation.organization.management.audit")}</h3>
                    {auditEvents.length === 0 ? (
                      <p>
                        {t("navigation.organization.management.auditEmpty")}
                      </p>
                    ) : (
                      auditEvents.map((event) => (
                        <div className="workspace-member-row" key={event.id}>
                          <div>
                            <strong>{event.eventType}</strong>
                            <span>
                              {event.outcome} · {event.createdAt}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </section>
                )}
              </>
            )}
          </main>
        </div>
        <footer className="workspace-management-footer">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!online || busy}
            onClick={() => void refreshState(selectedId)}
          >
            <Refresh size={14} aria-hidden="true" />
            {t("navigation.organization.management.refresh")}
          </button>
        </footer>
      </section>
    </div>
  );
}
