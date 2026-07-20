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
  WorkspaceInvitation,
  WorkspaceMember,
  WorkspacePublicState,
  WorkspaceSummary,
} from "../../../../shared/agentera-workspace";
import WorkspaceManagementDialog from "./WorkspaceManagementDialog";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string, options?: Record<string, unknown>): string =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OWNER_ID = USER_ID;
const ADMIN_ID = "20000000-0000-4000-8000-000000000002";
const MEMBER_ID = "30000000-0000-4000-8000-000000000003";
const WORKSPACE_ID = "40000000-0000-4000-8000-000000000004";
const INVITATION_ID = "50000000-0000-4000-8000-000000000005";
const TOKEN = "A".repeat(43);
const INVITE_URL = `agentera://workspace-invitation#${TOKEN}`;

const authState: Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
> = {
  status: "authenticated",
  userId: USER_ID,
  personalSpaceId: "60000000-0000-4000-8000-000000000006",
  deviceId: "70000000-0000-4000-8000-000000000007",
  offlineExpiresAt: "2026-07-27T00:00:00.000Z",
  cloudAvailable: true,
};

function workspace(patch: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: WORKSPACE_ID,
    displayName: "Design Team",
    status: "active",
    revision: 3,
    mutationState: "writable",
    role: "owner",
    memberCount: 3,
    createdAt: "2026-07-20T10:00:00Z",
    updatedAt: "2026-07-20T10:00:00Z",
    archivedAt: null,
    ...patch,
  };
}

function publicState(
  summary = workspace(),
  patch: Partial<WorkspacePublicState> = {},
): WorkspacePublicState {
  return {
    access: "online",
    cloudAvailable: true,
    stale: false,
    selected: {
      kind: "workspace",
      userId: USER_ID,
      workspaceId: summary.id,
      role: summary.role,
    },
    workspaces: [summary],
    ...patch,
  };
}

const members: WorkspaceMember[] = [
  {
    userId: OWNER_ID,
    nickname: "Owner Ada",
    role: "owner",
    revision: 2,
    joinedAt: "2026-07-20T10:00:00Z",
  },
  {
    userId: ADMIN_ID,
    nickname: "Admin Chen",
    role: "admin",
    revision: 4,
    joinedAt: "2026-07-20T10:00:00Z",
  },
  {
    userId: MEMBER_ID,
    nickname: "Member Lin",
    role: "member",
    revision: 5,
    joinedAt: "2026-07-20T10:00:00Z",
  },
];

const invitations: WorkspaceInvitation[] = [
  {
    id: INVITATION_ID,
    status: "pending",
    createdByUserId: OWNER_ID,
    acceptedByUserId: null,
    createdAt: "2026-07-20T10:00:00Z",
    expiresAt: "2026-07-27T10:00:00Z",
    acceptedAt: null,
    revokedAt: null,
  },
];

type MockAPI = Record<
  | "getState"
  | "refresh"
  | "create"
  | "rename"
  | "archive"
  | "restore"
  | "listMembers"
  | "changeMemberRole"
  | "removeMember"
  | "leave"
  | "listInvitations"
  | "createInvitation"
  | "revokeInvitation",
  ReturnType<typeof vi.fn>
>;

function installAPI(state = publicState()): MockAPI {
  const api: MockAPI = {
    getState: vi.fn().mockResolvedValue({ ok: true, value: state }),
    refresh: vi.fn().mockResolvedValue({ ok: true, value: state }),
    create: vi.fn().mockResolvedValue({ ok: true, value: workspace() }),
    rename: vi.fn().mockResolvedValue({ ok: true, value: workspace() }),
    archive: vi.fn().mockResolvedValue({
      ok: true,
      value: workspace({ status: "archived", mutationState: "archived" }),
    }),
    restore: vi.fn().mockResolvedValue({ ok: true, value: workspace() }),
    listMembers: vi.fn().mockResolvedValue({ ok: true, value: members }),
    changeMemberRole: vi.fn().mockResolvedValue({
      ok: true,
      value: { ...members[2], role: "admin", revision: 6 },
    }),
    removeMember: vi.fn().mockResolvedValue({ ok: true, value: true }),
    leave: vi.fn().mockResolvedValue({ ok: true, value: true }),
    listInvitations: vi
      .fn()
      .mockResolvedValue({ ok: true, value: invitations }),
    createInvitation: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        ...invitations[0],
        token: TOKEN,
        inviteUrl: INVITE_URL,
        secretReplayable: false,
      },
    }),
    revokeInvitation: vi.fn().mockResolvedValue({ ok: true, value: true }),
  };
  Object.defineProperty(window, "agenteraWorkspace", {
    configurable: true,
    value: api,
  });
  return api;
}

async function renderDialog(
  state = authState,
): Promise<ReturnType<typeof render>> {
  const rendered = render(
    <WorkspaceManagementDialog open authState={state} onClose={vi.fn()} />,
  );
  await screen.findByRole("dialog", {
    name: "navigation.workspace.management.title",
  });
  return rendered;
}

describe("WorkspaceManagementDialog", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("lets an Owner create, rename, archive, restore, and refresh authoritative state", async () => {
    const api = installAPI();
    await renderDialog();

    fireEvent.change(
      screen.getByLabelText("navigation.workspace.management.createName"),
      { target: { value: "Research" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.workspace.management.create",
      }),
    );
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({ displayName: "Research" }),
    );

    fireEvent.change(
      screen.getByLabelText("navigation.workspace.management.renameName"),
      { target: { value: "Product Team" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.workspace.management.rename",
      }),
    );
    await waitFor(() =>
      expect(api.rename).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        displayName: "Product Team",
        expectedRevision: 3,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.workspace.management.archive",
      }),
    );
    await waitFor(() => expect(api.archive).toHaveBeenCalledTimes(1));
    expect(window.confirm).toHaveBeenCalled();
    expect(api.refresh).toHaveBeenCalled();
  });

  it("renders the Owner/Admin/Member permission matrix for member actions", async () => {
    installAPI();
    await renderDialog();

    const memberRow = await screen.findByTestId(
      `workspace-member-${MEMBER_ID}`,
    );
    expect(
      within(memberRow).getByRole("button", {
        name: "navigation.workspace.management.promote",
      }),
    ).toBeInTheDocument();
    expect(
      within(memberRow).getByRole("button", {
        name: "navigation.workspace.management.removeMember",
      }),
    ).toBeInTheDocument();
    const adminRow = screen.getByTestId(`workspace-member-${ADMIN_ID}`);
    expect(
      within(adminRow).getByRole("button", {
        name: "navigation.workspace.management.demote",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "navigation.workspace.management.leave",
      }),
    ).toBeNull();
  });

  it("allows an Admin to remove only ordinary Members and lets non-Owners leave", async () => {
    const adminSummary = workspace({ role: "admin" });
    installAPI(
      publicState(adminSummary, {
        selected: {
          kind: "workspace",
          userId: ADMIN_ID,
          workspaceId: WORKSPACE_ID,
          role: "admin",
        },
      }),
    );
    await renderDialog({ ...authState, userId: ADMIN_ID });

    expect(
      within(
        await screen.findByTestId(`workspace-member-${MEMBER_ID}`),
      ).getByRole("button", {
        name: "navigation.workspace.management.removeMember",
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId(`workspace-member-${OWNER_ID}`)).queryByRole(
        "button",
      ),
    ).toBeNull();
    expect(
      within(screen.getByTestId(`workspace-member-${ADMIN_ID}`)).queryByRole(
        "button",
      ),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "navigation.workspace.management.leave",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "navigation.workspace.management.archive",
      }),
    ).toBeNull();
  });

  it("is read-only offline and never queues mutations", async () => {
    const offlineState = publicState(workspace(), {
      access: "offline",
      cloudAvailable: false,
      stale: true,
    });
    installAPI(offlineState);
    await renderDialog({
      ...authState,
      status: "offline",
      cloudAvailable: false,
    });

    expect(
      screen.getByText("navigation.workspace.management.offlineReadOnly"),
    ).toBeInTheDocument();
    for (const button of screen.getAllByTestId("workspace-mutation")) {
      expect(button).toBeDisabled();
    }
  });

  it("keeps archived workspaces read-only except for Owner restore", async () => {
    const archivedSummary = workspace({
      status: "archived",
      mutationState: "archived",
      archivedAt: "2026-07-20T12:00:00Z",
    });
    const api = installAPI(publicState(archivedSummary));
    await renderDialog();

    expect(
      screen.getByRole("button", {
        name: "navigation.workspace.management.rename",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "navigation.workspace.management.createInvitation",
      }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.workspace.management.restore",
      }),
    );
    await waitFor(() =>
      expect(api.restore).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        expectedRevision: 3,
      }),
    );
  });

  it("pauses workspace-specific mutations while the Owner is unavailable", async () => {
    installAPI(publicState(workspace({ mutationState: "owner_unavailable" })));
    await renderDialog();

    expect(
      screen.getByText("navigation.workspace.management.ownerUnavailable"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "navigation.workspace.management.rename",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "navigation.workspace.management.archive",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "navigation.workspace.management.createInvitation",
      }),
    ).toBeDisabled();
  });

  it("reveals a fresh invitation secret once, copies explicitly, and clears it on close", async () => {
    const api = installAPI();
    const rendered = await renderDialog();

    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.workspace.management.createInvitation",
      }),
    );
    expect(await screen.findByText(INVITE_URL)).toBeInTheDocument();
    expect(
      JSON.stringify(await api.listInvitations.mock.results[0]?.value),
    ).not.toContain(TOKEN);
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.workspace.management.copyInvitation",
      }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(INVITE_URL);

    rendered.rerender(
      <WorkspaceManagementDialog
        open={false}
        authState={authState}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(INVITE_URL)).toBeNull();
    rendered.rerender(
      <WorkspaceManagementDialog
        open
        authState={authState}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("dialog");
    expect(screen.queryByText(INVITE_URL)).toBeNull();
  });

  it("discards an invitation secret that arrives after the dialog closes", async () => {
    const api = installAPI();
    let resolveCreation:
      | ((value: {
          ok: true;
          value: {
            token: string;
            inviteUrl: string;
            secretReplayable: false;
          } & WorkspaceInvitation;
        }) => void)
      | undefined;
    api.createInvitation.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreation = resolve;
      }),
    );
    const rendered = await renderDialog();
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.workspace.management.createInvitation",
      }),
    );
    rendered.rerender(
      <WorkspaceManagementDialog
        open={false}
        authState={authState}
        onClose={vi.fn()}
      />,
    );
    resolveCreation?.({
      ok: true,
      value: {
        ...invitations[0],
        token: TOKEN,
        inviteUrl: INVITE_URL,
        secretReplayable: false,
      },
    });

    await Promise.resolve();
    rendered.rerender(
      <WorkspaceManagementDialog
        open
        authState={authState}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("dialog");
    expect(screen.queryByText(INVITE_URL)).toBeNull();
  });

  it("explains secret replay and maps quota/conflict/rate-limit errors without raw details", async () => {
    const api = installAPI();
    api.createInvitation.mockResolvedValueOnce({
      ok: true,
      value: { ...invitations[0], secretReplayable: false },
    });
    await renderDialog();
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.workspace.management.createInvitation",
      }),
    );
    expect(
      await screen.findByText(
        "navigation.workspace.management.invitationSecretUnavailable",
      ),
    ).toBeInTheDocument();

    for (const errorCode of [
      "limit_reached",
      "conflict",
      "rate_limited",
    ] as const) {
      api.create.mockResolvedValueOnce({
        ok: false,
        errorCode,
        body: "private cloud body",
      });
      fireEvent.change(
        screen.getByLabelText("navigation.workspace.management.createName"),
        { target: { value: `Failure ${errorCode}` } },
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "navigation.workspace.management.create",
        }),
      );
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          `navigation.workspace.errors.${errorCode}`,
        ),
      );
      expect(screen.getByRole("alert")).not.toHaveTextContent("private");
    }
  });
});
