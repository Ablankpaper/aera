import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import type {
  AgenteraWorkspaceErrorCode,
  WorkspacePublicState,
  WorkspaceRole,
  WorkspaceSummary,
} from "../../../../shared/agentera-workspace";
import { Alert, ChevronDown, Settings, User, Users } from "../../assets/icons";

type AuthorizedState = Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
>;

interface WorkspaceSwitcherProps {
  authState: AuthorizedState;
  compact?: boolean;
  onManage?: () => void;
}

type FocusTarget = "selected" | "first" | "last";
type LoadStatus = "loading" | "ready" | "error";

const ROLE_LABEL: Readonly<Record<WorkspaceRole, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

function compareWorkspaces(
  left: WorkspaceSummary,
  right: WorkspaceSummary,
): number {
  const leftName = left.displayName.toLowerCase();
  const rightName = right.displayName.toLowerCase();
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  return left.id.localeCompare(right.id);
}

function selectedWorkspace(
  state: WorkspacePublicState,
): WorkspaceSummary | undefined {
  const selected = state.selected;
  if (selected.kind !== "workspace") return undefined;
  return state.workspaces.find(
    (workspace) => workspace.id === selected.workspaceId,
  );
}

export default function WorkspaceSwitcher({
  authState,
  compact = false,
  onManage,
}: WorkspaceSwitcherProps): React.JSX.Element {
  const [workspaceState, setWorkspaceState] =
    useState<WorkspacePublicState | null>(null);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [open, setOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] =
    useState<AgenteraWorkspaceErrorCode | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusTargetRef = useRef<FocusTarget>("selected");

  useEffect(() => {
    let current = true;
    let unsubscribe = (): void => {};
    setWorkspaceState(null);
    setLoadStatus("loading");
    setSelectionError(null);
    setOpen(false);

    try {
      unsubscribe = window.agenteraWorkspace.onStateChanged((next) => {
        if (!current || next.selected.userId !== authState.userId) return;
        setWorkspaceState(next);
        setLoadStatus("ready");
        setSelectionError(null);
      });
    } catch {
      // The request below still provides a safe renderer state if listener
      // registration is temporarily unavailable.
    }

    void window.agenteraWorkspace
      .getState()
      .then((result) => {
        if (!current) return;
        if (!result.ok || result.value.selected.userId !== authState.userId) {
          setLoadStatus("error");
          return;
        }
        setWorkspaceState(result.value);
        setLoadStatus("ready");
      })
      .catch(() => {
        if (current) setLoadStatus("error");
      });

    return () => {
      current = false;
      unsubscribe();
    };
  }, [authState.personalSpaceId, authState.userId]);

  const activeWorkspaces = useMemo(
    () =>
      (workspaceState?.workspaces ?? [])
        .filter((workspace) => workspace.status === "active")
        .slice()
        .sort(compareWorkspaces),
    [workspaceState],
  );
  const archivedCount = useMemo(
    () =>
      (workspaceState?.workspaces ?? []).filter(
        (workspace) => workspace.status === "archived",
      ).length,
    [workspaceState],
  );
  const activeWorkspace = workspaceState
    ? selectedWorkspace(workspaceState)
    : undefined;
  const isPersonal = workspaceState?.selected.kind !== "workspace";
  const currentName =
    activeWorkspace?.displayName ??
    (isPersonal ? "Personal space" : "Workspace");
  const currentRole =
    activeWorkspace?.role ??
    (workspaceState?.selected.kind === "workspace"
      ? workspaceState.selected.role
      : undefined);
  const offline =
    workspaceState?.access === "offline" ||
    workspaceState?.cloudAvailable === false ||
    authState.status === "offline";
  const stale = workspaceState?.stale === true;
  const ownerUnavailable =
    activeWorkspace?.mutationState === "owner_unavailable";

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback((target: FocusTarget = "selected") => {
    focusTargetRef.current = target;
    setOpen(true);
    setSelectionError(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const choices = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitemradio"]',
      ) ?? [],
    );
    if (choices.length === 0) return;
    const target =
      focusTargetRef.current === "first"
        ? choices[0]
        : focusTargetRef.current === "last"
          ? choices.at(-1)
          : (choices.find(
              (choice) => choice.getAttribute("aria-checked") === "true",
            ) ?? choices[0]);
    target?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        closeMenu(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeMenu, open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const choices = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitemradio"]:not(:disabled)',
      ) ?? [],
    );
    if (choices.length === 0) return;
    event.preventDefault();
    const currentIndex = choices.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? choices.length - 1
          : event.key === "ArrowDown"
            ? (Math.max(currentIndex, -1) + 1) % choices.length
            : currentIndex <= 0
              ? choices.length - 1
              : currentIndex - 1;
    choices[nextIndex]?.focus();
  };

  const handleSelect = async (workspaceId: string | null): Promise<void> => {
    const currentId =
      workspaceState?.selected.kind === "workspace"
        ? workspaceState.selected.workspaceId
        : null;
    if (workspaceId === currentId) {
      closeMenu(true);
      return;
    }

    setSelecting(true);
    setSelectionError(null);
    try {
      const result = await window.agenteraWorkspace.select({ workspaceId });
      if (!result.ok) {
        setSelectionError(result.errorCode);
        return;
      }
      if (result.value.selected.userId === authState.userId) {
        setWorkspaceState(result.value);
        setLoadStatus("ready");
      }
      closeMenu(true);
    } catch {
      setSelectionError("cloud_unavailable");
    } finally {
      setSelecting(false);
    }
  };

  if (loadStatus === "loading") {
    return (
      <div className="workspace-switcher workspace-switcher-loading">
        <button
          type="button"
          className={`workspace-switcher-trigger ${compact ? "compact" : ""}`}
          aria-label="Loading spaces"
          title="Loading spaces"
          disabled
        >
          <Users size={compact ? 18 : 16} aria-hidden="true" />
          {!compact && (
            <span className="workspace-switcher-name">Loading spaces…</span>
          )}
        </button>
      </div>
    );
  }

  if (loadStatus === "error" || !workspaceState) {
    return (
      <div className="workspace-switcher workspace-switcher-error">
        <button
          type="button"
          className={`workspace-switcher-trigger ${compact ? "compact" : ""}`}
          aria-label="Spaces unavailable"
          title="Spaces unavailable"
        >
          <Alert size={compact ? 18 : 16} aria-hidden="true" />
          {!compact && (
            <span className="workspace-switcher-name">Spaces unavailable</span>
          )}
        </button>
      </div>
    );
  }

  const statusLabels = [
    currentRole ? ROLE_LABEL[currentRole] : null,
    offline ? "Offline" : null,
    stale ? "Stale" : null,
    ownerUnavailable ? "Owner unavailable" : null,
  ].filter((value): value is string => value !== null);
  const triggerLabel = ["Space switcher", currentName, ...statusLabels].join(
    ", ",
  );

  return (
    <div
      className={`workspace-switcher ${compact ? "compact" : ""}`}
      ref={rootRef}
    >
      {open && (
        <div
          className="workspace-switcher-menu"
          role="menu"
          aria-label="Spaces"
          ref={menuRef}
          onKeyDown={handleMenuKeyDown}
        >
          <div className="workspace-switcher-menu-heading">Run in</div>
          <button
            type="button"
            className="workspace-switcher-choice"
            role="menuitemradio"
            aria-checked={isPersonal}
            onClick={() => void handleSelect(null)}
            disabled={selecting}
          >
            <User size={16} aria-hidden="true" />
            <span className="workspace-switcher-choice-name">
              Personal space
            </span>
            <span className="workspace-switcher-badge">Personal</span>
          </button>
          {activeWorkspaces.map((workspace) => {
            const selected =
              workspaceState.selected.kind === "workspace" &&
              workspaceState.selected.workspaceId === workspace.id;
            return (
              <button
                type="button"
                key={workspace.id}
                className="workspace-switcher-choice"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => void handleSelect(workspace.id)}
                disabled={selecting}
              >
                <Users size={16} aria-hidden="true" />
                <span className="workspace-switcher-choice-name">
                  {workspace.displayName}
                </span>
                <span className="workspace-switcher-badge">
                  {ROLE_LABEL[workspace.role]}
                </span>
                {workspace.mutationState === "owner_unavailable" && (
                  <Alert
                    className="workspace-switcher-choice-warning"
                    size={14}
                    aria-label="Owner unavailable"
                  />
                )}
              </button>
            );
          })}
          <div className="workspace-switcher-menu-divider" />
          <button
            type="button"
            className="workspace-switcher-manage"
            role="menuitem"
            aria-label="Manage workspaces"
            onClick={() => {
              closeMenu(true);
              onManage?.();
            }}
          >
            <Settings size={15} aria-hidden="true" />
            <span>Manage workspaces</span>
            {archivedCount > 0 && <small>{archivedCount} archived</small>}
          </button>
          {selectionError && (
            <div className="workspace-switcher-selection-error" role="alert">
              Could not switch space ({selectionError.replaceAll("_", " ")}).
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        ref={triggerRef}
        className={`workspace-switcher-trigger ${compact ? "compact" : ""} ${
          open ? "open" : ""
        }`}
        aria-label={triggerLabel}
        title={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? closeMenu(false) : openMenu("selected"))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(event.key === "ArrowDown" ? "first" : "last");
          }
        }}
      >
        {isPersonal ? (
          <User size={compact ? 18 : 16} aria-hidden="true" />
        ) : (
          <Users size={compact ? 18 : 16} aria-hidden="true" />
        )}
        {!compact && (
          <>
            <span className="workspace-switcher-name">{currentName}</span>
            {currentRole && (
              <span className="workspace-switcher-badge">
                {ROLE_LABEL[currentRole]}
              </span>
            )}
            {offline && (
              <span className="workspace-switcher-status">Offline</span>
            )}
            {stale && <span className="workspace-switcher-status">Stale</span>}
            {ownerUnavailable && (
              <span className="workspace-switcher-warning">
                Owner unavailable
              </span>
            )}
            <ChevronDown
              size={14}
              className="workspace-switcher-chevron"
              aria-hidden="true"
            />
          </>
        )}
      </button>
    </div>
  );
}
