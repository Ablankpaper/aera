import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import type {
  AgenteraWorkspaceErrorCode,
  AgenteraWorkspaceResult,
  WorkspaceInvitation,
  WorkspaceMember,
  WorkspacePublicState,
  WorkspaceSummary,
} from "../../../../shared/agentera-workspace";
import { Copy, Plus, Refresh, Trash, X } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";

type AuthorizedState = Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
>;

interface WorkspaceManagementDialogProps {
  open: boolean;
  authState: AuthorizedState;
  onClose: () => void;
}

interface InvitationSecret {
  inviteUrl: string;
}

function resultError<T>(
  result: AgenteraWorkspaceResult<T>,
): AgenteraWorkspaceErrorCode | null {
  return result.ok ? null : result.errorCode;
}

function roleLabel(role: WorkspaceMember["role"]): string {
  return `navigation.workspace.roles.${role}`;
}

export default function WorkspaceManagementDialog({
  open,
  authState,
  onClose,
}: WorkspaceManagementDialogProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [state, setState] = useState<WorkspacePublicState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<readonly WorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<
    readonly WorkspaceInvitation[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<AgenteraWorkspaceErrorCode | null>(
    null,
  );
  const [createName, setCreateName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [invitationSecret, setInvitationSecret] =
    useState<InvitationSecret | null>(null);
  const [secretUnavailable, setSecretUnavailable] = useState(false);
  const detailsEpoch = useRef(0);
  const dialogContextRef = useRef({
    open,
    userId: authState.userId,
    selectedId,
  });
  dialogContextRef.current = { open, userId: authState.userId, selectedId };

  const selectedWorkspace = useMemo(
    () => state?.workspaces.find((workspace) => workspace.id === selectedId),
    [selectedId, state],
  );
  const online =
    authState.status === "authenticated" &&
    authState.cloudAvailable &&
    state?.access === "online" &&
    state.cloudAvailable;
  const actorRole = selectedWorkspace?.role;
  const archived = selectedWorkspace?.status === "archived";
  const ownerUnavailable =
    selectedWorkspace?.mutationState === "owner_unavailable";
  const workspaceReadOnly = !online || archived || ownerUnavailable;
  const canRename =
    !workspaceReadOnly && (actorRole === "owner" || actorRole === "admin");
  const canManageInvitations =
    !workspaceReadOnly && (actorRole === "owner" || actorRole === "admin");

  const applyState = useCallback(
    (next: WorkspacePublicState, preferredId?: string | null): void => {
      if (next.selected.userId !== authState.userId) return;
      const selected = next.selected;
      setState(next);
      setSelectedId((current) => {
        const candidate = preferredId === undefined ? current : preferredId;
        if (candidate && next.workspaces.some(({ id }) => id === candidate)) {
          return candidate;
        }
        if (
          selected.kind === "workspace" &&
          next.workspaces.some(({ id }) => id === selected.workspaceId)
        ) {
          return selected.workspaceId;
        }
        return next.workspaces[0]?.id ?? null;
      });
    },
    [authState.userId],
  );

  const loadState = useCallback(
    async (refresh: boolean, preferredId?: string | null): Promise<boolean> => {
      const result = refresh
        ? await window.agenteraWorkspace.refresh()
        : await window.agenteraWorkspace.getState();
      if (!result.ok) {
        setErrorCode(result.errorCode);
        return false;
      }
      applyState(result.value, preferredId);
      return true;
    },
    [applyState],
  );

  useEffect(() => {
    if (!open) {
      setInvitationSecret(null);
      setSecretUnavailable(false);
      setErrorCode(null);
      return;
    }
    let current = true;
    setLoading(true);
    setState(null);
    setSelectedId(null);
    setMembers([]);
    setInvitations([]);
    setInvitationSecret(null);
    setSecretUnavailable(false);
    setErrorCode(null);
    setBusy(false);
    void window.agenteraWorkspace
      .getState()
      .then((result) => {
        if (!current) return;
        if (!result.ok) {
          setErrorCode(result.errorCode);
          return;
        }
        applyState(result.value);
      })
      .catch(() => {
        if (current) setErrorCode("cloud_unavailable");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      detailsEpoch.current += 1;
    };
  }, [applyState, authState.personalSpaceId, authState.userId, open]);

  const loadDetails = useCallback(async (workspace: WorkspaceSummary) => {
    const epoch = ++detailsEpoch.current;
    setDetailsLoading(true);
    const memberPromise = window.agenteraWorkspace.listMembers({
      workspaceId: workspace.id,
    });
    const invitationPromise =
      workspace.role === "owner" || workspace.role === "admin"
        ? window.agenteraWorkspace.listInvitations({
            workspaceId: workspace.id,
          })
        : Promise.resolve({ ok: true as const, value: [] });
    try {
      const [memberResult, invitationResult] = await Promise.all([
        memberPromise,
        invitationPromise,
      ]);
      if (epoch !== detailsEpoch.current) return;
      if (memberResult.ok) setMembers(memberResult.value);
      else setErrorCode(memberResult.errorCode);
      if (invitationResult.ok) setInvitations(invitationResult.value);
      else setErrorCode(invitationResult.errorCode);
    } catch {
      if (epoch === detailsEpoch.current) setErrorCode("cloud_unavailable");
    } finally {
      if (epoch === detailsEpoch.current) setDetailsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !selectedWorkspace) {
      setMembers([]);
      setInvitations([]);
      return;
    }
    setRenameName(selectedWorkspace.displayName);
    setInvitationSecret(null);
    setSecretUnavailable(false);
    void loadDetails(selectedWorkspace);
  }, [loadDetails, open, selectedWorkspace]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  const refreshAfterMutation = useCallback(
    async (preferredId?: string | null): Promise<void> => {
      if (online) await loadState(true, preferredId);
    },
    [loadState, online],
  );

  const run = useCallback(
    async <T,>(
      operation: () => Promise<AgenteraWorkspaceResult<T>>,
      after?: (value: T) => Promise<void> | void,
    ): Promise<void> => {
      const startedForUser = dialogContextRef.current.userId;
      setBusy(true);
      setErrorCode(null);
      try {
        const result = await operation();
        if (
          !dialogContextRef.current.open ||
          dialogContextRef.current.userId !== startedForUser
        ) {
          return;
        }
        const failure = resultError(result);
        if (failure) {
          setErrorCode(failure);
          return;
        }
        if (result.ok) await after?.(result.value);
      } catch {
        if (
          dialogContextRef.current.open &&
          dialogContextRef.current.userId === startedForUser
        ) {
          setErrorCode("cloud_unavailable");
        }
      } finally {
        if (
          dialogContextRef.current.open &&
          dialogContextRef.current.userId === startedForUser
        ) {
          setBusy(false);
        }
      }
    },
    [],
  );

  const confirmDestructive = (messageKey: string): boolean =>
    window.confirm(t(messageKey));

  if (!open) return null;

  const mutationDisabled = busy || !online;

  return (
    <div
      className="workspace-management-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="workspace-management-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-management-title"
      >
        <header className="workspace-management-header">
          <div>
            <h2 id="workspace-management-title">
              {t("navigation.workspace.management.title")}
            </h2>
            <p>{t("navigation.workspace.management.description")}</p>
          </div>
          <button
            type="button"
            className="workspace-management-close"
            aria-label={t("navigation.workspace.management.close")}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {!online && (
          <div className="workspace-management-readonly" role="status">
            {t("navigation.workspace.management.offlineReadOnly")}
          </div>
        )}
        {state?.stale && (
          <div className="workspace-management-stale" role="status">
            {t("navigation.workspace.management.staleData")}
          </div>
        )}
        {errorCode && (
          <div className="workspace-management-error" role="alert">
            {t(`navigation.workspace.errors.${errorCode}`)}
          </div>
        )}

        <div className="workspace-management-body">
          <aside className="workspace-management-list">
            <form
              className="workspace-management-create"
              onSubmit={(event) => {
                event.preventDefault();
                const displayName = createName;
                if (!displayName) return;
                void run(
                  () => window.agenteraWorkspace.create({ displayName }),
                  async (created) => {
                    setCreateName("");
                    await refreshAfterMutation(created.id);
                  },
                );
              }}
            >
              <label>
                <span>{t("navigation.workspace.management.createName")}</span>
                <input
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  disabled={mutationDisabled}
                  aria-label={t("navigation.workspace.management.createName")}
                />
              </label>
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={mutationDisabled || createName.length === 0}
                data-testid="workspace-mutation"
              >
                <Plus size={14} aria-hidden="true" />
                {t("navigation.workspace.management.create")}
              </button>
            </form>
            {loading ? (
              <p>{t("navigation.workspace.management.loading")}</p>
            ) : state?.workspaces.length ? (
              <div className="workspace-management-list-items">
                {state.workspaces.map((workspace) => (
                  <button
                    type="button"
                    key={workspace.id}
                    className={workspace.id === selectedId ? "active" : ""}
                    aria-pressed={workspace.id === selectedId}
                    onClick={() => setSelectedId(workspace.id)}
                  >
                    <span>{workspace.displayName}</span>
                    <small>
                      {t(`navigation.workspace.roles.${workspace.role}`)}
                      {workspace.status === "archived"
                        ? ` · ${t("navigation.workspace.management.archived")}`
                        : ""}
                    </small>
                  </button>
                ))}
              </div>
            ) : (
              <p>{t("navigation.workspace.management.empty")}</p>
            )}
          </aside>

          <main className="workspace-management-detail">
            {!selectedWorkspace ? (
              <p>{t("navigation.workspace.management.selectWorkspace")}</p>
            ) : (
              <>
                <section className="workspace-management-section">
                  <div className="workspace-management-title-row">
                    <div>
                      <h3>{selectedWorkspace.displayName}</h3>
                      <span>
                        {t(
                          `navigation.workspace.roles.${selectedWorkspace.role}`,
                        )}
                      </span>
                    </div>
                    {ownerUnavailable && (
                      <strong className="workspace-management-owner-warning">
                        {t("navigation.workspace.management.ownerUnavailable")}
                      </strong>
                    )}
                  </div>

                  {(actorRole === "owner" || actorRole === "admin") && (
                    <form
                      className="workspace-management-rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!selectedWorkspace || !renameName) return;
                        void run(
                          () =>
                            window.agenteraWorkspace.rename({
                              workspaceId: selectedWorkspace.id,
                              displayName: renameName,
                              expectedRevision: selectedWorkspace.revision,
                            }),
                          async () =>
                            refreshAfterMutation(selectedWorkspace.id),
                        );
                      }}
                    >
                      <label>
                        <span>
                          {t("navigation.workspace.management.renameName")}
                        </span>
                        <input
                          value={renameName}
                          onChange={(event) =>
                            setRenameName(event.target.value)
                          }
                          aria-label={t(
                            "navigation.workspace.management.renameName",
                          )}
                          disabled={!canRename || busy}
                        />
                      </label>
                      <button
                        type="submit"
                        className="btn btn-secondary btn-sm"
                        disabled={!canRename || busy || renameName.length === 0}
                        data-testid="workspace-mutation"
                      >
                        {t("navigation.workspace.management.rename")}
                      </button>
                    </form>
                  )}

                  <div className="workspace-management-lifecycle">
                    {actorRole === "owner" && archived && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={mutationDisabled || ownerUnavailable}
                        data-testid="workspace-mutation"
                        onClick={() =>
                          void run(
                            () =>
                              window.agenteraWorkspace.restore({
                                workspaceId: selectedWorkspace.id,
                                expectedRevision: selectedWorkspace.revision,
                              }),
                            async () =>
                              refreshAfterMutation(selectedWorkspace.id),
                          )
                        }
                      >
                        {t("navigation.workspace.management.restore")}
                      </button>
                    )}
                    {actorRole === "owner" && !archived && (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={mutationDisabled || ownerUnavailable}
                        data-testid="workspace-mutation"
                        onClick={() => {
                          if (
                            !confirmDestructive(
                              "navigation.workspace.management.confirmArchive",
                            )
                          )
                            return;
                          void run(
                            () =>
                              window.agenteraWorkspace.archive({
                                workspaceId: selectedWorkspace.id,
                                expectedRevision: selectedWorkspace.revision,
                              }),
                            async () =>
                              refreshAfterMutation(selectedWorkspace.id),
                          );
                        }}
                      >
                        {t("navigation.workspace.management.archive")}
                      </button>
                    )}
                    {actorRole !== "owner" && !archived && (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={mutationDisabled || ownerUnavailable}
                        data-testid="workspace-mutation"
                        onClick={() => {
                          if (
                            !confirmDestructive(
                              "navigation.workspace.management.confirmLeave",
                            )
                          )
                            return;
                          void run(
                            () =>
                              window.agenteraWorkspace.leave({
                                workspaceId: selectedWorkspace.id,
                              }),
                            async () => refreshAfterMutation(null),
                          );
                        }}
                      >
                        {t("navigation.workspace.management.leave")}
                      </button>
                    )}
                  </div>
                </section>

                <section className="workspace-management-section">
                  <h3>{t("navigation.workspace.management.members")}</h3>
                  {detailsLoading ? (
                    <p>{t("navigation.workspace.management.loading")}</p>
                  ) : (
                    <div className="workspace-member-list">
                      {members.map((member) => {
                        const canChangeRole =
                          actorRole === "owner" &&
                          member.role !== "owner" &&
                          member.userId !== authState.userId &&
                          !workspaceReadOnly;
                        const canRemove =
                          member.role !== "owner" &&
                          member.userId !== authState.userId &&
                          !workspaceReadOnly &&
                          (actorRole === "owner" ||
                            (actorRole === "admin" &&
                              member.role === "member"));
                        return (
                          <div
                            className="workspace-member-row"
                            data-testid={`workspace-member-${member.userId}`}
                            key={member.userId}
                          >
                            <div>
                              <strong>
                                {member.nickname ??
                                  `${member.userId.slice(0, 8)}…`}
                              </strong>
                              <span>{t(roleLabel(member.role))}</span>
                            </div>
                            <div className="workspace-member-actions">
                              {canChangeRole && (
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm"
                                  data-testid="workspace-mutation"
                                  disabled={busy || !online}
                                  onClick={() =>
                                    void run(
                                      () =>
                                        window.agenteraWorkspace.changeMemberRole(
                                          {
                                            workspaceId: selectedWorkspace.id,
                                            userId: member.userId,
                                            role:
                                              member.role === "admin"
                                                ? "member"
                                                : "admin",
                                            expectedRevision: member.revision,
                                          },
                                        ),
                                      async () =>
                                        loadDetails(selectedWorkspace),
                                    )
                                  }
                                >
                                  {t(
                                    member.role === "admin"
                                      ? "navigation.workspace.management.demote"
                                      : "navigation.workspace.management.promote",
                                  )}
                                </button>
                              )}
                              {canRemove && (
                                <button
                                  type="button"
                                  className="btn btn-danger btn-sm"
                                  data-testid="workspace-mutation"
                                  disabled={busy || !online}
                                  onClick={() => {
                                    if (
                                      !confirmDestructive(
                                        "navigation.workspace.management.confirmRemove",
                                      )
                                    )
                                      return;
                                    void run(
                                      () =>
                                        window.agenteraWorkspace.removeMember({
                                          workspaceId: selectedWorkspace.id,
                                          userId: member.userId,
                                          expectedRevision: member.revision,
                                        }),
                                      async () =>
                                        loadDetails(selectedWorkspace),
                                    );
                                  }}
                                >
                                  {t(
                                    "navigation.workspace.management.removeMember",
                                  )}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                {(actorRole === "owner" || actorRole === "admin") && (
                  <section className="workspace-management-section">
                    <div className="workspace-management-section-heading">
                      <h3>
                        {t("navigation.workspace.management.invitations")}
                      </h3>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!canManageInvitations || busy}
                        data-testid="workspace-mutation"
                        onClick={() => {
                          setInvitationSecret(null);
                          setSecretUnavailable(false);
                          void run(
                            () =>
                              window.agenteraWorkspace.createInvitation({
                                workspaceId: selectedWorkspace.id,
                              }),
                            async (created) => {
                              if (
                                dialogContextRef.current.selectedId !==
                                selectedWorkspace.id
                              ) {
                                return;
                              }
                              if (created.inviteUrl && created.token) {
                                setInvitationSecret({
                                  inviteUrl: created.inviteUrl,
                                });
                              } else {
                                setSecretUnavailable(true);
                              }
                              const listed =
                                await window.agenteraWorkspace.listInvitations({
                                  workspaceId: selectedWorkspace.id,
                                });
                              if (listed.ok) setInvitations(listed.value);
                              else setErrorCode(listed.errorCode);
                            },
                          );
                        }}
                      >
                        {t("navigation.workspace.management.createInvitation")}
                      </button>
                    </div>
                    {invitationSecret && (
                      <div className="workspace-invitation-secret">
                        <p>
                          {t(
                            "navigation.workspace.management.invitationSecretOnce",
                          )}
                        </p>
                        <code>{invitationSecret.inviteUrl}</code>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          aria-label={t(
                            "navigation.workspace.management.copyInvitation",
                          )}
                          onClick={() =>
                            void navigator.clipboard.writeText(
                              invitationSecret.inviteUrl,
                            )
                          }
                        >
                          <Copy size={14} aria-hidden="true" />
                          {t("navigation.workspace.management.copyInvitation")}
                        </button>
                      </div>
                    )}
                    {secretUnavailable && (
                      <p className="workspace-invitation-replay-note">
                        {t(
                          "navigation.workspace.management.invitationSecretUnavailable",
                        )}
                      </p>
                    )}
                    <div className="workspace-invitation-list">
                      {invitations.map((invitation) => (
                        <div
                          key={invitation.id}
                          className="workspace-invitation-row"
                        >
                          <div>
                            <strong>
                              {t(
                                `navigation.workspace.invitationStatus.${invitation.status}`,
                              )}
                            </strong>
                            <span>{invitation.expiresAt}</span>
                          </div>
                          {invitation.status === "pending" && (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={!canManageInvitations || busy}
                              data-testid="workspace-mutation"
                              onClick={() => {
                                if (
                                  !confirmDestructive(
                                    "navigation.workspace.management.confirmRevoke",
                                  )
                                )
                                  return;
                                void run(
                                  () =>
                                    window.agenteraWorkspace.revokeInvitation({
                                      workspaceId: selectedWorkspace.id,
                                      invitationId: invitation.id,
                                    }),
                                  async () => loadDetails(selectedWorkspace),
                                );
                              }}
                            >
                              <Trash size={13} aria-hidden="true" />
                              {t(
                                "navigation.workspace.management.revokeInvitation",
                              )}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
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
            onClick={() => void loadState(true, selectedId)}
          >
            <Refresh size={14} aria-hidden="true" />
            {t("navigation.workspace.management.refresh")}
          </button>
        </footer>
      </section>
    </div>
  );
}
