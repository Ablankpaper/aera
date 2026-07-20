import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../../shared/agentera-auth";
import type { WorkspaceInvitationAcceptance } from "../../../shared/agentera-workspace";
import WorkspaceInvitationGate from "./WorkspaceInvitationGate";

vi.mock("./useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string): string => key,
  }),
}));

const TOKEN = "B".repeat(43);
const USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";
const unauthenticated: AgenteraAuthPublicState = {
  status: "unauthenticated",
  reason: "sign_in_required",
};
const authenticated: AgenteraAuthPublicState = {
  status: "authenticated",
  userId: USER_ID,
  personalSpaceId: "30000000-0000-4000-8000-000000000003",
  deviceId: "40000000-0000-4000-8000-000000000004",
  offlineExpiresAt: "2026-07-27T00:00:00.000Z",
  cloudAvailable: true,
};
const acceptance: WorkspaceInvitationAcceptance = {
  workspace: {
    id: WORKSPACE_ID,
    displayName: "Joined Team",
    status: "active",
    revision: 1,
    mutationState: "writable",
    role: "member",
    memberCount: 2,
    createdAt: "2026-07-20T10:00:00Z",
    updatedAt: "2026-07-20T10:00:00Z",
    archivedAt: null,
  },
  member: {
    userId: USER_ID,
    nickname: null,
    role: "member",
    revision: 1,
    joinedAt: "2026-07-20T10:00:00Z",
  },
};

type InvitationListener = (value: { token: string }) => void;

function installAPI(pending: string | null = TOKEN): {
  getPendingInvitation: ReturnType<typeof vi.fn>;
  acceptInvitation: ReturnType<typeof vi.fn>;
  dismissPendingInvitation: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  receive: (token: string) => void;
} {
  let listener: InvitationListener | undefined;
  const api = {
    getPendingInvitation: vi.fn().mockResolvedValue({
      ok: true,
      value: pending ? { token: pending } : null,
    }),
    acceptInvitation: vi
      .fn()
      .mockResolvedValue({ ok: true, value: acceptance }),
    dismissPendingInvitation: vi
      .fn()
      .mockResolvedValue({ ok: true, value: true }),
    select: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        access: "online",
        cloudAvailable: true,
        stale: false,
        selected: {
          kind: "workspace",
          userId: USER_ID,
          workspaceId: WORKSPACE_ID,
          role: "member",
        },
        workspaces: [acceptance.workspace],
      },
    }),
    onInvitationReceived: vi.fn((callback: InvitationListener) => {
      listener = callback;
      return vi.fn();
    }),
  };
  Object.defineProperty(window, "agenteraWorkspace", {
    configurable: true,
    value: api,
  });
  return { ...api, receive: (token: string) => listener?.({ token }) };
}

describe("WorkspaceInvitationGate", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/");
    localStorage.clear();
    sessionStorage.clear();
  });

  it("holds a pre-sign-in invitation, asks for explicit online confirmation, accepts, and selects the joined workspace", async () => {
    const api = installAPI();
    const rendered = render(
      <WorkspaceInvitationGate authState={unauthenticated} />,
    );
    expect(
      await screen.findByText("navigation.workspace.invitation.signInRequired"),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);

    rendered.rerender(<WorkspaceInvitationGate authState={authenticated} />);
    await screen.findByRole("dialog", {
      name: "navigation.workspace.invitation.title",
    });
    expect(api.acceptInvitation).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.workspace.invitation.accept",
      }),
    );

    await waitFor(() =>
      expect(api.acceptInvitation).toHaveBeenCalledWith({ token: TOKEN }),
    );
    expect(api.dismissPendingInvitation).toHaveBeenCalledWith({ token: TOKEN });
    expect(api.select).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID });
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("pauses acceptance while offline and resumes after an account switch becomes online", async () => {
    const api = installAPI();
    const offline: AgenteraAuthPublicState = {
      ...authenticated,
      status: "offline",
      cloudAvailable: false,
    };
    const rendered = render(<WorkspaceInvitationGate authState={offline} />);
    expect(
      await screen.findByText("navigation.workspace.invitation.offlinePaused"),
    ).toBeInTheDocument();
    expect(api.acceptInvitation).not.toHaveBeenCalled();

    rendered.rerender(
      <WorkspaceInvitationGate
        authState={{
          ...authenticated,
          userId: "50000000-0000-4000-8000-000000000005",
        }}
      />,
    );
    expect(
      await screen.findByRole("button", {
        name: "navigation.workspace.invitation.accept",
      }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("handles unavailable invitations safely and allows exact dismissal", async () => {
    const api = installAPI();
    api.acceptInvitation.mockResolvedValueOnce({
      ok: false,
      errorCode: "not_found",
      responseBody: `private ${TOKEN}`,
    });
    render(<WorkspaceInvitationGate authState={authenticated} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "navigation.workspace.invitation.accept",
      }),
    );
    expect(
      await screen.findByText("navigation.workspace.invitation.unavailable"),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.workspace.invitation.dismiss",
      }),
    );
    expect(api.dismissPendingInvitation).toHaveBeenCalledWith({ token: TOKEN });
  });

  it("accepts volatile protocol events and strips any renderer fragment", async () => {
    const api = installAPI(null);
    history.replaceState(null, "", `/#${TOKEN}`);
    render(<WorkspaceInvitationGate authState={authenticated} />);
    await waitFor(() => expect(location.hash).toBe(""));
    api.receive(TOKEN);
    expect(
      await screen.findByRole("dialog", {
        name: "navigation.workspace.invitation.title",
      }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
