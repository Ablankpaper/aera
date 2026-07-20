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
  ProductSpacePublicState,
  ProductSpaceResult,
} from "../../../../shared/agentera-product-space";
import ProductSpaceSwitcher from "./ProductSpaceSwitcher";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string, options?: Record<string, unknown>): string => {
      const values: Record<string, string> = {
        "navigation.organization.switcher.label": "Product space switcher",
        "navigation.organization.switcher.menu": "Product spaces",
        "navigation.organization.switcher.loading": "Loading product spaces",
        "navigation.organization.switcher.unavailable":
          "Product spaces unavailable",
        "navigation.organization.switcher.runIn": "Run in",
        "navigation.organization.switcher.personalGroup": "Personal",
        "navigation.organization.switcher.workspaceGroup": "Workspaces",
        "navigation.organization.switcher.organizationGroup": "Organizations",
        "navigation.organization.switcher.personal": "Personal space",
        "navigation.organization.switcher.personalBadge": "Personal",
        "navigation.organization.switcher.workspaceFallback": "Workspace",
        "navigation.organization.switcher.organizationFallback": "Organization",
        "navigation.organization.switcher.offline": "Offline",
        "navigation.organization.switcher.stale": "Stale",
        "navigation.organization.switcher.manageWorkspaces":
          "Manage workspaces",
        "navigation.organization.switcher.manageOrganizations":
          "Manage organizations",
        "navigation.organization.roles.owner": "Owner",
        "navigation.organization.roles.admin": "Admin",
        "navigation.organization.roles.auditor": "Auditor",
        "navigation.organization.roles.member": "Member",
        "navigation.organization.errors.online_required": "online required",
      };
      if (key === "navigation.organization.switcher.couldNotSwitch") {
        return `Could not switch product space (${String(options?.error)}).`;
      }
      return values[key] ?? key;
    },
  }),
}));

const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ALPHA = "20000000-0000-4000-8000-000000000002";
const WORKSPACE_ZETA = "30000000-0000-4000-8000-000000000003";
const ORGANIZATION_ALPHA = "40000000-0000-4000-8000-000000000004";
const ORGANIZATION_ZETA = "50000000-0000-4000-8000-000000000005";

const authState: Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
> = {
  status: "authenticated",
  userId: USER_ID,
  personalSpaceId: "60000000-0000-4000-8000-000000000006",
  deviceId: "70000000-0000-4000-8000-000000000007",
  offlineExpiresAt: "2026-07-28T00:00:00.000Z",
  cloudAvailable: true,
};

function state(
  patch: Partial<ProductSpacePublicState> = {},
): ProductSpacePublicState {
  return {
    access: "online",
    stale: false,
    selected: { kind: "PERSONAL" },
    options: [
      { kind: "PERSONAL" },
      {
        kind: "WORKSPACE",
        workspaceId: WORKSPACE_ZETA,
        displayName: "Zeta Workspace",
        role: "member",
      },
      {
        kind: "ORGANIZATION",
        organizationId: ORGANIZATION_ZETA,
        displayName: "Zeta Organization",
        role: "auditor",
      },
      {
        kind: "ORGANIZATION",
        organizationId: ORGANIZATION_ALPHA,
        displayName: "Alpha Organization",
        role: "owner",
      },
      {
        kind: "WORKSPACE",
        workspaceId: WORKSPACE_ALPHA,
        displayName: "Alpha Workspace",
        role: "admin",
      },
    ],
    ...patch,
  };
}

type Listener = (next: ProductSpacePublicState) => void;

function installAPI(
  initial:
    | ProductSpaceResult<ProductSpacePublicState>
    | Promise<ProductSpaceResult<ProductSpacePublicState>> = {
    ok: true,
    data: state(),
  },
): {
  select: ReturnType<typeof vi.fn>;
  emit: (next: ProductSpacePublicState) => void;
} {
  let listener: Listener | undefined;
  const select = vi.fn(async (input: { kind: string }) => ({
    ok: true as const,
    data: state({
      selected:
        input.kind === "PERSONAL"
          ? { kind: "PERSONAL" as const }
          : input.kind === "WORKSPACE"
            ? {
                kind: "WORKSPACE" as const,
                workspaceId: WORKSPACE_ALPHA,
                role: "admin" as const,
              }
            : {
                kind: "ORGANIZATION" as const,
                organizationId: ORGANIZATION_ALPHA,
                role: "owner" as const,
              },
    }),
  }));
  Object.defineProperty(window, "agenteraProductSpace", {
    configurable: true,
    value: {
      getState: vi.fn().mockResolvedValue(initial),
      refresh: vi.fn(),
      select,
      onStateChanged: vi.fn((callback: Listener) => {
        listener = callback;
        return vi.fn();
      }),
    },
  });
  return { select, emit: (next) => listener?.(next) };
}

function openMenu(): HTMLElement {
  fireEvent.click(
    screen.getByRole("button", { name: /product space switcher/i }),
  );
  return screen.getByRole("menu", { name: "Product spaces" });
}

describe("ProductSpaceSwitcher", () => {
  beforeEach(() => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: { setActiveProfile: vi.fn() },
    });
  });

  it("groups Personal, Workspace, and Organization choices deterministically without Departments", async () => {
    installAPI();
    render(<ProductSpaceSwitcher authState={authState} />);
    await screen.findByText("Personal space");
    const menu = openMenu();

    expect(
      within(menu)
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual(["Personal", "Workspaces", "Organizations"]);
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent),
    ).toEqual([
      "Personal spacePersonal",
      "Alpha WorkspaceAdmin",
      "Zeta WorkspaceMember",
      "Alpha OrganizationOwner",
      "Zeta OrganizationAuditor",
    ]);
    expect(within(menu).queryByText(/department/i)).toBeNull();
  });

  it("selects only through the Product Space bridge and never switches Hermes Profile", async () => {
    const api = installAPI();
    render(<ProductSpaceSwitcher authState={authState} />);
    await screen.findByText("Personal space");
    openMenu();
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Alpha Organization.*Owner/i }),
    );

    await waitFor(() =>
      expect(api.select).toHaveBeenCalledWith({
        kind: "ORGANIZATION",
        organizationId: ORGANIZATION_ALPHA,
      }),
    );
    expect(window.hermesAPI.setActiveProfile).not.toHaveBeenCalled();
  });

  it("shows offline stale state, selection failures, and both management affordances", async () => {
    const api = installAPI({
      ok: true,
      data: state({
        access: "offline",
        stale: true,
        selected: {
          kind: "ORGANIZATION",
          organizationId: ORGANIZATION_ZETA,
          role: "auditor",
        },
      }),
    });
    api.select.mockResolvedValueOnce({
      ok: false,
      errorCode: "online_required",
    });
    const manageWorkspaces = vi.fn();
    const manageOrganizations = vi.fn();
    render(
      <ProductSpaceSwitcher
        authState={{ ...authState, status: "offline", cloudAvailable: false }}
        onManageWorkspaces={manageWorkspaces}
        onManageOrganizations={manageOrganizations}
      />,
    );
    const trigger = await screen.findByRole("button", {
      name: /Zeta Organization.*Auditor.*Offline.*Stale/i,
    });
    expect(trigger).toBeInTheDocument();

    const menu = openMenu();
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Manage workspaces" }),
    );
    expect(manageWorkspaces).toHaveBeenCalledOnce();
    openMenu();
    fireEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", {
        name: "Manage organizations",
      }),
    );
    expect(manageOrganizations).toHaveBeenCalledOnce();

    openMenu();
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /Alpha Workspace.*Admin/i }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "online required",
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("renders explicit loading and safe error states", async () => {
    let resolveState:
      | ((value: ProductSpaceResult<ProductSpacePublicState>) => void)
      | undefined;
    const pending = new Promise<ProductSpaceResult<ProductSpacePublicState>>(
      (resolve) => {
        resolveState = resolve;
      },
    );
    installAPI(pending);
    render(<ProductSpaceSwitcher authState={authState} />);
    expect(
      screen.getByRole("button", { name: "Loading product spaces" }),
    ).toBeDisabled();
    resolveState?.({ ok: false, errorCode: "service_unavailable" });
    expect(
      await screen.findByRole("button", { name: "Product spaces unavailable" }),
    ).toBeInTheDocument();
  });
});
