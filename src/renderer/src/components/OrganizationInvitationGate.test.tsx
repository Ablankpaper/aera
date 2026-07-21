import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../../shared/agentera-auth";
import type { OrganizationInvitationAcceptance } from "../../../shared/agentera-organization";
import OrganizationInvitationGate from "./OrganizationInvitationGate";

vi.mock("./useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));

const TOKEN = "O".repeat(43);
const USER_ID = "10000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000002";
const unauthenticated: AgenteraAuthPublicState = {
  status: "unauthenticated",
  reason: "sign_in_required",
};
const authenticated: AgenteraAuthPublicState = {
  status: "authenticated",
  userId: USER_ID,
  personalSpaceId: "30000000-0000-4000-8000-000000000003",
  deviceId: "40000000-0000-4000-8000-000000000004",
  offlineExpiresAt: "2026-07-28T00:00:00.000Z",
  cloudAvailable: true,
};
const acceptance: OrganizationInvitationAcceptance = {
  organization: {
    id: ORGANIZATION_ID,
    displayName: "Joined Enterprise",
    status: "active",
    revision: 1,
    role: "member",
    memberCount: 2,
    departmentCount: 0,
    currentPolicyVersion: 1,
    currentPolicyDigest: `sha256:${"a".repeat(64)}`,
    mutationState: "writable",
    createdAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
    archivedAt: null,
  },
  member: {
    userId: USER_ID,
    nickname: null,
    role: "member",
    departmentId: null,
    revision: 1,
    joinedAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
  },
};

type Listener = (value: { token: string }) => void;

function installAPIs(pending: string | null = TOKEN): {
  organization: Record<string, ReturnType<typeof vi.fn>>;
  productSelect: ReturnType<typeof vi.fn>;
  receive: (token: string) => void;
} {
  let listener: Listener | undefined;
  const organization = {
    getPendingInvitation: vi.fn().mockResolvedValue({
      ok: true,
      data: pending ? { token: pending } : null,
    }),
    acceptInvitation: vi.fn().mockResolvedValue({ ok: true, data: acceptance }),
    dismissPendingInvitation: vi
      .fn()
      .mockResolvedValue({ ok: true, data: true }),
    onInvitationReceived: vi.fn((callback: Listener) => {
      listener = callback;
      return vi.fn();
    }),
  };
  const productSelect = vi.fn().mockResolvedValue({ ok: true, data: {} });
  Object.defineProperty(window, "agenteraOrganization", {
    configurable: true,
    value: organization,
  });
  Object.defineProperty(window, "agenteraProductSpace", {
    configurable: true,
    value: { select: productSelect },
  });
  return {
    organization,
    productSelect,
    receive: (token: string) => listener?.({ token }),
  };
}

describe("OrganizationInvitationGate", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/");
    localStorage.clear();
    sessionStorage.clear();
  });

  it("retains a volatile invitation through sign-in and explicitly selects the accepted Organization", async () => {
    const api = installAPIs();
    const rendered = render(
      <OrganizationInvitationGate authState={unauthenticated} />,
    );
    expect(
      await screen.findByText(
        "navigation.organization.invitation.signInRequired",
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);

    rendered.rerender(<OrganizationInvitationGate authState={authenticated} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "navigation.organization.invitation.accept",
      }),
    );
    await waitFor(() =>
      expect(api.organization.acceptInvitation).toHaveBeenCalledWith({
        token: TOKEN,
      }),
    );
    expect(api.organization.dismissPendingInvitation).toHaveBeenCalledWith({
      token: TOKEN,
    });
    expect(api.productSelect).toHaveBeenCalledWith({
      kind: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
    });
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("pauses offline and supports exact dismissal without persistence", async () => {
    const api = installAPIs();
    const rendered = render(
      <OrganizationInvitationGate
        authState={{
          ...authenticated,
          status: "offline",
          cloudAvailable: false,
        }}
      />,
    );
    expect(
      await screen.findByText(
        "navigation.organization.invitation.offlinePaused",
      ),
    ).toBeInTheDocument();
    expect(api.organization.acceptInvitation).not.toHaveBeenCalled();
    rendered.rerender(<OrganizationInvitationGate authState={authenticated} />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.organization.invitation.dismiss",
      }),
    );
    expect(api.organization.dismissPendingInvitation).toHaveBeenCalledWith({
      token: TOKEN,
    });
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("handles unavailable invitations and strips renderer fragments", async () => {
    const api = installAPIs(null);
    history.replaceState(null, "", `/#${TOKEN}`);
    render(<OrganizationInvitationGate authState={authenticated} />);
    await waitFor(() => expect(location.hash).toBe(""));
    api.receive(TOKEN);
    api.organization.acceptInvitation.mockResolvedValueOnce({
      ok: false,
      errorCode: "invitation_unavailable",
      responseBody: TOKEN,
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "navigation.organization.invitation.accept",
      }),
    );
    expect(
      await screen.findByText("navigation.organization.invitation.unavailable"),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
