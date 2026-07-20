import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import type {
  ProductSpaceErrorCode,
  ProductSpaceOption,
  ProductSpacePublicState,
  StoredProductSpaceSelection,
} from "../../../../shared/agentera-product-space";
import {
  Alert,
  Building,
  ChevronDown,
  Settings,
  User,
  Users,
} from "../../assets/icons";
import { useI18n } from "../../components/useI18n";

type AuthorizedState = Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
>;

interface ProductSpaceSwitcherProps {
  authState: AuthorizedState;
  compact?: boolean;
  onManageWorkspaces?: () => void;
  onManageOrganizations?: () => void;
}

type LoadStatus = "loading" | "ready" | "error";
type FocusTarget = "selected" | "first" | "last";

function optionId(option: ProductSpaceOption): string {
  switch (option.kind) {
    case "PERSONAL":
      return "PERSONAL";
    case "WORKSPACE":
      return option.workspaceId;
    case "ORGANIZATION":
      return option.organizationId;
  }
}

function compareOptions(
  left: ProductSpaceOption,
  right: ProductSpaceOption,
): number {
  if (left.kind === "PERSONAL" || right.kind === "PERSONAL") return 0;
  const byName = left.displayName
    .toLocaleLowerCase()
    .localeCompare(right.displayName.toLocaleLowerCase());
  return byName || optionId(left).localeCompare(optionId(right));
}

function isSelected(
  state: ProductSpacePublicState,
  option: ProductSpaceOption,
): boolean {
  if (state.selected.kind !== option.kind) return false;
  if (option.kind === "PERSONAL") return true;
  if (option.kind === "WORKSPACE" && state.selected.kind === "WORKSPACE") {
    return option.workspaceId === state.selected.workspaceId;
  }
  return (
    option.kind === "ORGANIZATION" &&
    state.selected.kind === "ORGANIZATION" &&
    option.organizationId === state.selected.organizationId
  );
}

function selectionFor(option: ProductSpaceOption): StoredProductSpaceSelection {
  switch (option.kind) {
    case "PERSONAL":
      return { kind: "PERSONAL" };
    case "WORKSPACE":
      return { kind: "WORKSPACE", workspaceId: option.workspaceId };
    case "ORGANIZATION":
      return { kind: "ORGANIZATION", organizationId: option.organizationId };
  }
}

export default function ProductSpaceSwitcher({
  authState,
  compact = false,
  onManageWorkspaces,
  onManageOrganizations,
}: ProductSpaceSwitcherProps): React.JSX.Element {
  const { t } = useI18n();
  const [state, setState] = useState<ProductSpacePublicState | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [open, setOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] =
    useState<ProductSpaceErrorCode | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusTargetRef = useRef<FocusTarget>("selected");

  useEffect(() => {
    let current = true;
    let unsubscribe = (): void => {};
    setState(null);
    setStatus("loading");
    setOpen(false);
    setSelectionError(null);
    try {
      unsubscribe = window.agenteraProductSpace.onStateChanged((next) => {
        if (!current) return;
        setState(next);
        setStatus("ready");
        setSelectionError(null);
      });
    } catch {
      // The initial request below remains the renderer's safe fallback.
    }
    void window.agenteraProductSpace
      .getState()
      .then((result) => {
        if (!current) return;
        if (!result.ok) {
          setStatus("error");
          return;
        }
        setState(result.data);
        setStatus("ready");
      })
      .catch(() => {
        if (current) setStatus("error");
      });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [authState.personalSpaceId, authState.userId]);

  const groups = useMemo(() => {
    const options = state?.options ?? [];
    return {
      personal: options.filter((option) => option.kind === "PERSONAL"),
      workspaces: options
        .filter(
          (
            option,
          ): option is Extract<ProductSpaceOption, { kind: "WORKSPACE" }> =>
            option.kind === "WORKSPACE",
        )
        .slice()
        .sort(compareOptions),
      organizations: options
        .filter(
          (
            option,
          ): option is Extract<ProductSpaceOption, { kind: "ORGANIZATION" }> =>
            option.kind === "ORGANIZATION",
        )
        .slice()
        .sort(compareOptions),
    };
  }, [state]);

  const selectedOption = state?.options.find((option) =>
    state ? isSelected(state, option) : false,
  );
  const selectedName =
    selectedOption?.kind === "PERSONAL"
      ? t("navigation.organization.switcher.personal")
      : (selectedOption?.displayName ??
        t(
          state?.selected.kind === "ORGANIZATION"
            ? "navigation.organization.switcher.organizationFallback"
            : state?.selected.kind === "WORKSPACE"
              ? "navigation.organization.switcher.workspaceFallback"
              : "navigation.organization.switcher.personal",
        ));
  const selectedRole =
    selectedOption && selectedOption.kind !== "PERSONAL"
      ? selectedOption.role
      : state?.selected.kind !== "PERSONAL"
        ? state?.selected.role
        : null;
  const offline = state?.access === "offline" || authState.status === "offline";
  const stale = state?.stale === true;

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback((target: FocusTarget = "selected") => {
    focusTargetRef.current = target;
    setSelectionError(null);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const choices = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitemradio"]:not(:disabled)',
      ) ?? [],
    );
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
    const onMouseDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        closeMenu(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
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

  const handleSelect = async (option: ProductSpaceOption): Promise<void> => {
    if (!state || isSelected(state, option)) {
      closeMenu(true);
      return;
    }
    setSelecting(true);
    setSelectionError(null);
    try {
      const result = await window.agenteraProductSpace.select(
        selectionFor(option),
      );
      if (!result.ok) {
        setSelectionError(result.errorCode);
        return;
      }
      setState(result.data);
      closeMenu(true);
    } catch {
      setSelectionError("service_unavailable");
    } finally {
      setSelecting(false);
    }
  };

  if (status === "loading") {
    const label = t("navigation.organization.switcher.loading");
    return (
      <div className="workspace-switcher product-space-switcher workspace-switcher-loading">
        <button
          type="button"
          className={`workspace-switcher-trigger ${compact ? "compact" : ""}`}
          aria-label={label}
          title={label}
          disabled
        >
          <Users size={compact ? 18 : 16} aria-hidden="true" />
          {!compact && <span className="workspace-switcher-name">{label}</span>}
        </button>
      </div>
    );
  }

  if (status === "error" || !state) {
    const label = t("navigation.organization.switcher.unavailable");
    return (
      <div className="workspace-switcher product-space-switcher workspace-switcher-error">
        <button
          type="button"
          className={`workspace-switcher-trigger ${compact ? "compact" : ""}`}
          aria-label={label}
          title={label}
        >
          <Alert size={compact ? 18 : 16} aria-hidden="true" />
          {!compact && <span className="workspace-switcher-name">{label}</span>}
        </button>
      </div>
    );
  }

  const labels = [
    t("navigation.organization.switcher.label"),
    selectedName,
    selectedRole ? t(`navigation.organization.roles.${selectedRole}`) : null,
    offline ? t("navigation.organization.switcher.offline") : null,
    stale ? t("navigation.organization.switcher.stale") : null,
  ].filter((label): label is string => Boolean(label));
  const allOptions = [groups.personal, groups.workspaces, groups.organizations];
  const renderChoice = (option: ProductSpaceOption): React.JSX.Element => {
    const personal = option.kind === "PERSONAL";
    const name = personal
      ? t("navigation.organization.switcher.personal")
      : option.displayName;
    const Icon = personal
      ? User
      : option.kind === "WORKSPACE"
        ? Users
        : Building;
    return (
      <button
        type="button"
        key={`${option.kind}-${optionId(option)}`}
        className="workspace-switcher-choice product-space-switcher-choice"
        role="menuitemradio"
        aria-checked={isSelected(state, option)}
        onClick={() => void handleSelect(option)}
        disabled={selecting}
      >
        <Icon size={16} aria-hidden="true" />
        <span className="workspace-switcher-choice-name">{name}</span>
        <span className="workspace-switcher-badge">
          {personal
            ? t("navigation.organization.switcher.personalBadge")
            : t(`navigation.organization.roles.${option.role}`)}
        </span>
      </button>
    );
  };

  return (
    <div
      className={`workspace-switcher product-space-switcher ${compact ? "compact" : ""}`}
      ref={rootRef}
    >
      {open && (
        <div
          className="workspace-switcher-menu product-space-switcher-menu"
          role="menu"
          aria-label={t("navigation.organization.switcher.menu")}
          ref={menuRef}
          onKeyDown={handleMenuKeyDown}
        >
          <div className="workspace-switcher-menu-heading">
            {t("navigation.organization.switcher.runIn")}
          </div>
          {allOptions.map((options, index) => {
            const groupKey = [
              "personalGroup",
              "workspaceGroup",
              "organizationGroup",
            ][index];
            const groupLabel = t(
              `navigation.organization.switcher.${groupKey}`,
            );
            return (
              <div
                className="product-space-switcher-group"
                role="group"
                aria-label={groupLabel}
                key={groupKey}
              >
                <div className="product-space-switcher-group-label">
                  {groupLabel}
                </div>
                {options.map(renderChoice)}
              </div>
            );
          })}
          <div className="workspace-switcher-menu-divider" />
          <button
            type="button"
            className="workspace-switcher-manage"
            role="menuitem"
            aria-label={t("navigation.organization.switcher.manageWorkspaces")}
            onClick={() => {
              closeMenu(true);
              onManageWorkspaces?.();
            }}
          >
            <Settings size={15} aria-hidden="true" />
            <span>
              {t("navigation.organization.switcher.manageWorkspaces")}
            </span>
          </button>
          <button
            type="button"
            className="workspace-switcher-manage"
            role="menuitem"
            aria-label={t(
              "navigation.organization.switcher.manageOrganizations",
            )}
            onClick={() => {
              closeMenu(true);
              onManageOrganizations?.();
            }}
          >
            <Building size={15} aria-hidden="true" />
            <span>
              {t("navigation.organization.switcher.manageOrganizations")}
            </span>
          </button>
          {selectionError && (
            <div className="workspace-switcher-selection-error" role="alert">
              {t("navigation.organization.switcher.couldNotSwitch", {
                error: t(`navigation.organization.errors.${selectionError}`),
              })}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        ref={triggerRef}
        className={`workspace-switcher-trigger ${compact ? "compact" : ""} ${open ? "open" : ""}`}
        aria-label={labels.join(", ")}
        title={labels.join(", ")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(event.key === "ArrowDown" ? "first" : "last");
          }
        }}
      >
        {state.selected.kind === "PERSONAL" ? (
          <User size={compact ? 18 : 16} aria-hidden="true" />
        ) : state.selected.kind === "WORKSPACE" ? (
          <Users size={compact ? 18 : 16} aria-hidden="true" />
        ) : (
          <Building size={compact ? 18 : 16} aria-hidden="true" />
        )}
        {!compact && (
          <>
            <span className="workspace-switcher-name">{selectedName}</span>
            {selectedRole && (
              <span className="workspace-switcher-badge">
                {t(`navigation.organization.roles.${selectedRole}`)}
              </span>
            )}
            {offline && (
              <span className="workspace-switcher-status">
                {t("navigation.organization.switcher.offline")}
              </span>
            )}
            {stale && (
              <span className="workspace-switcher-status">
                {t("navigation.organization.switcher.stale")}
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
