import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import type {
  AgenteraWorkspaceResult,
  WorkspacePublicState,
  WorkspaceSummary,
} from "../../../../shared/agentera-workspace";
import WorkspaceSwitcher from "./WorkspaceSwitcher";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const PERSONAL_SPACE_ID = "20000000-0000-4000-8000-000000000002";
const ALPHA_A = "30000000-0000-4000-8000-000000000003";
const ALPHA_B = "40000000-0000-4000-8000-000000000004";
const ZETA = "50000000-0000-4000-8000-000000000005";
const ARCHIVED = "60000000-0000-4000-8000-000000000006";

const authState: Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
> = {
  status: "authenticated",
  userId: USER_ID,
  personalSpaceId: PERSONAL_SPACE_ID,
  deviceId: "70000000-0000-4000-8000-000000000007",
  offlineExpiresAt: "2026-07-27T00:00:00.000Z",
  cloudAvailable: true,
};

function workspace(
  id: string,
  displayName: string,
  patch: Partial<WorkspaceSummary> = {},
): WorkspaceSummary {
  return {
    id,
    displayName,
    status: "active",
    revision: 1,
    mutationState: "writable",
    role: "member",
    memberCount: 2,
    createdAt: "2026-07-20T10:00:00Z",
    updatedAt: "2026-07-20T10:00:00Z",
    archivedAt: null,
    ...patch,
  };
}

function state(
  patch: Partial<WorkspacePublicState> = {},
): WorkspacePublicState {
  return {
    access: "online",
    cloudAvailable: true,
    stale: false,
    selected: {
      kind: "personal",
      userId: USER_ID,
      personalSpaceId: PERSONAL_SPACE_ID,
    },
    workspaces: [
      workspace(ZETA, "Zeta", { role: "admin" }),
      workspace(ALPHA_B, "alpha", { role: "member" }),
      workspace(ALPHA_A, "Alpha", { role: "owner" }),
      workspace(ARCHIVED, "Archived Team", {
        status: "archived",
        mutationState: "archived",
        archivedAt: "2026-07-20T11:00:00Z",
      }),
    ],
    ...patch,
  };
}

type StateListener = (next: WorkspacePublicState) => void;

function installWorkspaceAPI(
  initial:
    | AgenteraWorkspaceResult<WorkspacePublicState>
    | Promise<AgenteraWorkspaceResult<WorkspacePublicState>> = {
    ok: true,
    value: state(),
  },
): {
  getState: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  emit: (next: WorkspacePublicState) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let listener: StateListener | undefined;
  const unsubscribe = vi.fn();
  const getState = vi.fn().mockResolvedValue(initial);
  const select = vi.fn(
    async ({ workspaceId }: { workspaceId: string | null }) => {
      const current = state();
      const selected =
        workspaceId === null
          ? current.selected
          : {
              kind: "workspace" as const,
              userId: USER_ID,
              workspaceId,
              role:
                current.workspaces.find((item) => item.id === workspaceId)
                  ?.role ?? "member",
            };
      return { ok: true as const, value: { ...current, selected } };
    },
  );

  Object.defineProperty(window, "agenteraWorkspace", {
    configurable: true,
    value: {
      getState,
      select,
      onStateChanged: vi.fn((callback: StateListener) => {
        listener = callback;
        return unsubscribe;
      }),
    },
  });

  return {
    getState,
    select,
    emit: (next) => listener?.(next),
    unsubscribe,
  };
}

function openMenu(): HTMLElement {
  const trigger = screen.getByRole("button", { name: /space switcher/i });
  fireEvent.click(trigger);
  return screen.getByRole("menu", { name: /spaces/i });
}

describe("WorkspaceSwitcher", () => {
  beforeEach(() => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: { setActiveProfile: vi.fn(), listProfiles: vi.fn() },
    });
    Object.defineProperty(window, "agenteraAuth", {
      configurable: true,
      value: { logout: vi.fn(), startLogin: vi.fn() },
    });
  });

  it("orders Personal first, sorts active workspaces deterministically, and hides archived choices", async () => {
    installWorkspaceAPI();
    render(<WorkspaceSwitcher authState={authState} />);

    await screen.findByText("Personal space");
    const menu = openMenu();
    const choices = within(menu).getAllByRole("menuitemradio");
    expect(choices.map((choice) => choice.textContent)).toEqual([
      "Personal spacePersonal",
      "AlphaOwner",
      "alphaMember",
      "ZetaAdmin",
    ]);
    expect(within(menu).queryByText("Archived Team")).toBeNull();
    expect(
      within(menu).getByRole("menuitem", { name: /manage workspaces/i }),
    ).toHaveTextContent("1 archived");
  });

  it("shows the selected workspace role, cached-offline state, and Owner-unavailable warning", async () => {
    installWorkspaceAPI({
      ok: true,
      value: state({
        access: "offline",
        cloudAvailable: false,
        stale: true,
        selected: {
          kind: "workspace",
          userId: USER_ID,
          workspaceId: ALPHA_A,
          role: "owner",
        },
        workspaces: state().workspaces.map((item) =>
          item.id === ALPHA_A
            ? { ...item, mutationState: "owner_unavailable" }
            : item,
        ),
      }),
    });
    render(
      <WorkspaceSwitcher authState={{ ...authState, status: "offline" }} />,
    );

    const trigger = await screen.findByRole("button", {
      name: /space switcher.*Alpha.*Owner.*Offline.*Stale.*Owner unavailable/i,
    });
    expect(within(trigger).getByText("Owner")).toBeInTheDocument();
    expect(within(trigger).getByText("Offline")).toBeInTheDocument();
    expect(within(trigger).getByText("Stale")).toBeInTheDocument();
    expect(within(trigger).getByText("Owner unavailable")).toBeInTheDocument();
  });

  it("renders explicit loading and safe error states", async () => {
    let resolveState:
      | ((result: AgenteraWorkspaceResult<WorkspacePublicState>) => void)
      | undefined;
    const pending = new Promise<AgenteraWorkspaceResult<WorkspacePublicState>>(
      (resolve) => {
        resolveState = resolve;
      },
    );
    installWorkspaceAPI(pending);
    const { rerender } = render(<WorkspaceSwitcher authState={authState} />);
    expect(
      screen.getByRole("button", { name: /loading spaces/i }),
    ).toBeDisabled();

    resolveState?.({ ok: false, errorCode: "cloud_unavailable" });
    await screen.findByRole("button", { name: /spaces unavailable/i });

    installWorkspaceAPI({
      ok: true,
      value: state({
        selected: {
          kind: "personal",
          userId: ZETA,
          personalSpaceId: PERSONAL_SPACE_ID,
        },
      }),
    });
    rerender(<WorkspaceSwitcher authState={{ ...authState, userId: ZETA }} />);
    await screen.findByRole("button", { name: /space switcher/i });
  });

  it("uses an icon-only trigger with a complete tooltip when collapsed", async () => {
    installWorkspaceAPI();
    render(<WorkspaceSwitcher authState={authState} compact />);

    const trigger = await screen.findByRole("button", {
      name: /space switcher.*Personal space/i,
    });
    expect(trigger).toHaveAttribute("title", expect.stringMatching(/Personal/));
    expect(trigger).toHaveClass("compact");
    expect(within(trigger).queryByText("Personal space")).toBeNull();
  });

  it("selects through only the Workspace namespace and preserves account, navigation, and Hermes Profile", async () => {
    const api = installWorkspaceAPI();
    const navigationSpy = vi.fn();
    window.addEventListener("navigation:goto", navigationSpy);
    render(<WorkspaceSwitcher authState={authState} />);

    await screen.findByText("Personal space");
    openMenu();
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Alpha.*Owner/i }),
    );
    await waitFor(() =>
      expect(api.select).toHaveBeenCalledWith({ workspaceId: ALPHA_A }),
    );
    expect(window.hermesAPI.setActiveProfile).not.toHaveBeenCalled();
    expect(window.agenteraAuth.logout).not.toHaveBeenCalled();
    expect(window.agenteraAuth.startLogin).not.toHaveBeenCalled();
    expect(navigationSpy).not.toHaveBeenCalled();

    openMenu();
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Personal space/i }),
    );
    await waitFor(() =>
      expect(api.select).toHaveBeenLastCalledWith({ workspaceId: null }),
    );
    window.removeEventListener("navigation:goto", navigationSpy);
  });

  it("keeps the menu open with a stable error when selection fails", async () => {
    const api = installWorkspaceAPI();
    api.select.mockResolvedValueOnce({
      ok: false,
      errorCode: "online_required",
    });
    render(<WorkspaceSwitcher authState={authState} />);

    await screen.findByText("Personal space");
    openMenu();
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Alpha.*Owner/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "online required",
    );
    expect(screen.getByRole("menu", { name: /spaces/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /space switcher.*Personal space/i }),
    ).toBeInTheDocument();
  });

  it("supports arrow keys and restores trigger focus after Escape", async () => {
    installWorkspaceAPI();
    render(<WorkspaceSwitcher authState={authState} />);
    const trigger = await screen.findByRole("button", {
      name: /space switcher/i,
    });

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const choices = screen.getAllByRole("menuitemradio");
    await waitFor(() => expect(choices[0]).toHaveFocus());
    fireEvent.keyDown(choices[0], { key: "ArrowDown" });
    expect(choices[1]).toHaveFocus();
    fireEvent.keyDown(choices[1], { key: "End" });
    expect(choices.at(-1)).toHaveFocus();
    fireEvent.keyDown(choices.at(-1)!, { key: "Home" });
    expect(choices[0]).toHaveFocus();
    fireEvent.keyDown(choices[0], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes on an outside press and follows state events for the same account", async () => {
    const api = installWorkspaceAPI();
    render(
      <div>
        <WorkspaceSwitcher authState={authState} />
        <button type="button">Outside</button>
      </div>,
    );

    await screen.findByText("Personal space");
    openMenu();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).toBeNull();

    api.emit(
      state({
        selected: {
          kind: "workspace",
          userId: USER_ID,
          workspaceId: ZETA,
          role: "admin",
        },
      }),
    );
    expect(await screen.findByText("Zeta")).toBeInTheDocument();
  });
});
