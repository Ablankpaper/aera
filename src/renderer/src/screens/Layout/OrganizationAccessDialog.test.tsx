import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import OrganizationAccessDialog from "./OrganizationAccessDialog";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string): string => key,
  }),
}));

const USER_ID = "10000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000002";
const INVITE_URL =
  "agentera://organization-invitation#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const authState: Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
> = {
  status: "authenticated",
  userId: USER_ID,
  personalSpaceId: "30000000-0000-4000-8000-000000000003",
  deviceId: "40000000-0000-4000-8000-000000000004",
  offlineExpiresAt: "2026-07-31T00:00:00.000Z",
  cloudAvailable: true,
};

function installAPIs(): {
  organization: {
    create: ReturnType<typeof vi.fn>;
    submitInvitationLink: ReturnType<typeof vi.fn>;
  };
  productSpace: {
    refresh: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
  };
} {
  const organization = {
    create: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        id: ORGANIZATION_ID,
        displayName: "Acme",
        role: "owner",
      },
    }),
    submitInvitationLink: vi.fn().mockResolvedValue({
      ok: true,
      data: true,
    }),
  };
  const productSpace = {
    refresh: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        access: "online",
        stale: false,
        selected: { kind: "PERSONAL" },
        options: [],
      },
    }),
    select: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        access: "online",
        stale: false,
        selected: {
          kind: "ORGANIZATION",
          organizationId: ORGANIZATION_ID,
          role: "owner",
        },
        options: [],
      },
    }),
  };
  Object.defineProperty(window, "agenteraOrganization", {
    configurable: true,
    value: organization,
  });
  Object.defineProperty(window, "agenteraProductSpace", {
    configurable: true,
    value: productSpace,
  });
  return { organization, productSpace };
}

describe("OrganizationAccessDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lets the same signed-in account submit a one-time invitation for review", async () => {
    const { organization } = installAPIs();
    const onClose = vi.fn();
    render(
      <OrganizationAccessDialog open authState={authState} onClose={onClose} />,
    );

    fireEvent.change(
      screen.getByLabelText("navigation.organization.access.invitationLink"),
      { target: { value: `  ${INVITE_URL}  ` } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.organization.access.reviewInvitation",
      }),
    );

    await waitFor(() =>
      expect(organization.submitInvitationLink).toHaveBeenCalledWith({
        inviteUrl: INVITE_URL,
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("creates an organization without changing account identity and selects the new context", async () => {
    const { organization, productSpace } = installAPIs();
    const onClose = vi.fn();
    render(
      <OrganizationAccessDialog open authState={authState} onClose={onClose} />,
    );

    fireEvent.change(
      screen.getByLabelText("navigation.organization.access.createName"),
      { target: { value: "  Acme Enterprise  " } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.organization.access.create",
      }),
    );

    await waitFor(() =>
      expect(organization.create).toHaveBeenCalledWith({
        displayName: "Acme Enterprise",
      }),
    );
    expect(productSpace.refresh).toHaveBeenCalledOnce();
    expect(productSpace.select).toHaveBeenCalledWith({
      kind: "ORGANIZATION",
      organizationId: ORGANIZATION_ID,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps organization creation unavailable offline without hiding invitation review", () => {
    installAPIs();
    render(
      <OrganizationAccessDialog
        open
        authState={{
          ...authState,
          status: "offline",
          cloudAvailable: false,
        }}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "navigation.organization.access.create",
      }),
    ).toBeDisabled();
    expect(
      screen.getByLabelText("navigation.organization.access.invitationLink"),
    ).toBeEnabled();
  });
});
