import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenteraAuthPublicState } from "../../../../shared/agentera-auth";
import type {
  OrganizationDepartment,
  OrganizationMember,
  OrganizationRole,
  OrganizationSummary,
} from "../../../../shared/agentera-organization";
import OrganizationManagementDialog from "./OrganizationManagementDialog";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>): string =>
      options?.version === undefined
        ? key
        : `${key}:${String(options.version)}`,
  }),
}));

const USER_ID = "10000000-0000-4000-8000-000000000001";
const TARGET_ID = "20000000-0000-4000-8000-000000000002";
const ORGANIZATION_A = "30000000-0000-4000-8000-000000000003";
const ORGANIZATION_B = "40000000-0000-4000-8000-000000000004";
const DEPARTMENT_ID = "50000000-0000-4000-8000-000000000005";
const INVITATION_ID = "60000000-0000-4000-8000-000000000006";
const INVITE_URL = `agentera://organization-invitation#${"A".repeat(43)}`;

const authState: Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
> = {
  status: "authenticated",
  userId: USER_ID,
  personalSpaceId: "70000000-0000-4000-8000-000000000007",
  deviceId: "80000000-0000-4000-8000-000000000008",
  offlineExpiresAt: "2026-07-28T00:00:00Z",
  cloudAvailable: true,
};

function organization(
  id: string,
  role: OrganizationRole,
  displayName = "Acme Enterprise",
  patch: Partial<OrganizationSummary> = {},
): OrganizationSummary {
  return {
    id,
    displayName,
    status: "active",
    revision: 7,
    role,
    memberCount: 2,
    departmentCount: 1,
    currentPolicyVersion: 1,
    currentPolicyDigest: `sha256:${"a".repeat(64)}`,
    mutationState: "writable",
    createdAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
    archivedAt: null,
    ...patch,
  };
}

function member(
  userId: string,
  role: OrganizationRole,
  nickname: string,
): OrganizationMember {
  return {
    userId,
    nickname,
    role,
    departmentId: role === "owner" ? null : DEPARTMENT_ID,
    revision: role === "owner" ? 3 : 4,
    joinedAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
  };
}

function department(): OrganizationDepartment {
  return {
    id: DEPARTMENT_ID,
    displayName: "Research",
    status: "active",
    memberCount: 1,
    revision: 2,
    createdAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
    archivedAt: null,
  };
}

type ProductListener = (state: {
  access: "online";
  stale: false;
  selected: {
    kind: "ORGANIZATION";
    organizationId: string;
    role: OrganizationRole;
  };
  options: never[];
}) => void;

function installAPIs(
  role: OrganizationRole = "owner",
  overrides: { offline?: boolean; organizations?: OrganizationSummary[] } = {},
): {
  organizationAPI: Record<string, ReturnType<typeof vi.fn>>;
  emitProduct: (organizationId: string, nextRole?: OrganizationRole) => void;
} {
  let productListener: ProductListener | undefined;
  const organizations = overrides.organizations ?? [
    organization(ORGANIZATION_A, role),
  ];
  const publicState = {
    access: overrides.offline ? ("offline" as const) : ("online" as const),
    cloudAvailable: !overrides.offline,
    stale: Boolean(overrides.offline),
    refreshedAt: "2026-07-21T00:00:00Z",
    organizations,
  };
  const success = <T,>(data: T): Promise<{ ok: true; data: T }> =>
    Promise.resolve({ ok: true, data });
  const organizationAPI = {
    getState: vi.fn(() => success(publicState)),
    refresh: vi.fn(() => success(publicState)),
    create: vi.fn(() => success(organizations[0])),
    rename: vi.fn(() => success(organizations[0])),
    archive: vi.fn(() => success(organizations[0])),
    restore: vi.fn(() => success(organizations[0])),
    transferOwner: vi.fn(() => success(organizations[0])),
    dissolve: vi.fn(() => success(organizations[0])),
    leave: vi.fn(() => success(true)),
    listMembers: vi.fn(() =>
      success({
        items: [
          member(USER_ID, "owner", "Current Owner"),
          member(TARGET_ID, "admin", "Target Admin"),
        ],
        stale: Boolean(overrides.offline),
        refreshedAt: "2026-07-21T00:00:00Z",
      }),
    ),
    patchMember: vi.fn((_input) =>
      success(member(TARGET_ID, "admin", "Target Member")),
    ),
    removeMember: vi.fn(() => success(true)),
    listDepartments: vi.fn(() =>
      success({
        items: [department()],
        stale: Boolean(overrides.offline),
        refreshedAt: "2026-07-21T00:00:00Z",
      }),
    ),
    createDepartment: vi.fn(() => success(department())),
    renameDepartment: vi.fn(() => success(department())),
    archiveDepartment: vi.fn(() => success(department())),
    restoreDepartment: vi.fn(() => success(department())),
    listInvitations: vi.fn(() =>
      success({
        items: [
          {
            id: INVITATION_ID,
            status: "pending" as const,
            createdByUserId: USER_ID,
            acceptedByUserId: null,
            createdAt: "2026-07-21T00:00:00Z",
            expiresAt: "2026-07-28T00:00:00Z",
            acceptedAt: null,
            revokedAt: null,
          },
        ],
        stale: false,
        refreshedAt: "2026-07-21T00:00:00Z",
      }),
    ),
    createInvitation: vi.fn(() =>
      success({
        invitation: { id: INVITATION_ID },
        token: "hidden-token",
        inviteUrl: INVITE_URL,
        secretReplayable: false as const,
      }),
    ),
    revokeInvitation: vi.fn(() => success(true)),
    submitInvitationLink: vi.fn(() => success(true)),
    getCurrentPolicy: vi.fn(() =>
      success({
        policy: {
          id: "policy-v1",
          policyVersion: 1,
          schemaVersion: 1 as const,
          contentDigest: `sha256:${"b".repeat(64)}`,
          issuer: "agentera-cloud",
          signingKeyId: "organization-policy-v1",
          createdAt: "2026-07-21T00:00:00Z",
          document:
            role === "member"
              ? null
              : {
                  schemaVersion: 1 as const,
                  models: { allowlist: null },
                  tools: { allowlist: null },
                  experienceCandidates: { mode: "manual_review" as const },
                  officialAgents: { installation: "allowed" as const },
                },
          signature: "signature",
        },
        stale: Boolean(overrides.offline),
        verifiedAt: "2026-07-21T00:00:00Z",
        errorCode: null,
      }),
    ),
    listPolicySnapshots: vi.fn(() =>
      success([
        {
          id: "policy-v1",
          policyVersion: 1,
          schemaVersion: 1 as const,
          contentDigest: `sha256:${"b".repeat(64)}`,
          issuer: "agentera-cloud",
          signingKeyId: "organization-policy-v1",
          createdAt: "2026-07-21T00:00:00Z",
        },
      ]),
    ),
    publishPolicy: vi.fn(() => success({ id: "policy-v2" })),
    listAuditEvents: vi.fn(() =>
      success({
        items: [
          {
            id: "audit-1",
            eventType: "organization.created",
            objectType: "organization",
            objectId: ORGANIZATION_A,
            outcome: "success",
            reasonCode: null,
            requestId: null,
            actorDisplay: "Current Owner",
            subjectDisplay: "Acme Enterprise",
            createdAt: "2026-07-21T00:00:00Z",
          },
        ],
        nextCursor: null,
      }),
    ),
    onStateChanged: vi.fn(() => vi.fn()),
  };
  Object.defineProperty(window, "agenteraOrganization", {
    configurable: true,
    value: organizationAPI,
  });
  Object.defineProperty(window, "agenteraProductSpace", {
    configurable: true,
    value: {
      getState: vi.fn(() =>
        success({
          access: "online" as const,
          stale: false,
          selected: {
            kind: "ORGANIZATION" as const,
            organizationId: organizations[0].id,
            role,
          },
          options: [],
        }),
      ),
      onStateChanged: vi.fn((listener: ProductListener) => {
        productListener = listener;
        return vi.fn();
      }),
    },
  });
  return {
    organizationAPI,
    emitProduct: (organizationId, nextRole = role) =>
      productListener?.({
        access: "online",
        stale: false,
        selected: { kind: "ORGANIZATION", organizationId, role: nextRole },
        options: [],
      }),
  };
}

function renderDialog(
  role: OrganizationRole = "owner",
  offline = false,
  copyInvitationLink = vi.fn().mockResolvedValue(undefined),
): ReturnType<typeof installAPIs> & {
  onClose: ReturnType<typeof vi.fn>;
  copyInvitationLink: ReturnType<typeof vi.fn>;
  unmount: () => void;
} {
  const api = installAPIs(role, { offline });
  const onClose = vi.fn();
  const rendered = render(
    <OrganizationManagementDialog
      open
      authState={
        offline
          ? { ...authState, status: "offline", cloudAvailable: false }
          : authState
      }
      onClose={onClose}
      copyInvitationLink={copyInvitationLink}
    />,
  );
  return { ...api, onClose, copyInvitationLink, unmount: rendered.unmount };
}

describe("OrganizationManagementDialog", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("gives Owner the complete management surface and keeps invitation secret display one-shot", async () => {
    const { organizationAPI, copyInvitationLink } = renderDialog("owner");
    await screen.findByText("Acme Enterprise");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "navigation.organization.management.overview",
      "navigation.organization.management.members",
      "navigation.organization.management.departments",
      "navigation.organization.management.invitations",
      "navigation.organization.management.policy",
      "navigation.organization.management.audit",
    ]);

    fireEvent.click(
      screen.getByRole("tab", {
        name: "navigation.organization.management.invitations",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "navigation.organization.management.createInvitation",
      }),
    );
    expect(await screen.findByText(INVITE_URL)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.organization.management.copyInvitation",
      }),
    );
    await waitFor(() =>
      expect(copyInvitationLink).toHaveBeenCalledWith(INVITE_URL),
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: "navigation.organization.management.invitationCopied",
      }),
    ).toBeInTheDocument();
    expect(organizationAPI.createInvitation).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_A,
    });
    expect(
      JSON.stringify(organizationAPI.createInvitation.mock.calls),
    ).not.toContain("owner");
  });

  it("reports clipboard failure instead of leaving a stale invitation silently copied", async () => {
    const copyToClipboard = vi.fn().mockRejectedValue(new Error("denied"));
    renderDialog("owner", false, copyToClipboard);
    await screen.findByText("Acme Enterprise");
    fireEvent.click(
      screen.getByRole("tab", {
        name: "navigation.organization.management.invitations",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "navigation.organization.management.createInvitation",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "navigation.organization.management.copyInvitation",
      }),
    );
    expect(
      await screen.findByRole("alert", {
        name: "navigation.organization.management.invitationCopyFailed",
      }),
    ).toBeInTheDocument();
    expect(copyToClipboard).toHaveBeenCalledWith(INVITE_URL);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("gives Admin management and invitation controls without Owner-only lifecycle actions", async () => {
    renderDialog("admin");
    await screen.findByText("Acme Enterprise");
    expect(
      screen.getByRole("tab", {
        name: "navigation.organization.management.invitations",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", {
        name: "navigation.organization.management.audit",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "navigation.organization.management.rename",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "navigation.organization.management.transferOwner",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "navigation.organization.management.dissolve",
      }),
    ).toBeNull();
  });

  it("separates the active policy from the editable draft, publish action, and signed history", async () => {
    const { organizationAPI } = renderDialog("owner");
    await screen.findByText("Acme Enterprise");
    fireEvent.click(
      screen.getByRole("tab", {
        name: "navigation.organization.management.policy",
      }),
    );

    const activePolicy = await screen.findByTestId(
      "organization-policy-overview",
    );
    expect(activePolicy).toHaveTextContent(
      "navigation.organization.management.policyVersion:1",
    );
    expect(activePolicy).toHaveTextContent(
      "navigation.organization.management.manualReview",
    );
    expect(
      screen.getByRole("heading", {
        name: "navigation.organization.management.policySettings",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("organization-policy-publish-bar"),
    ).toHaveTextContent(
      "navigation.organization.management.nextPolicyVersion:2",
    );
    expect(
      screen.getByTestId("organization-policy-history-list"),
    ).toHaveTextContent("navigation.organization.management.policyVersion:1");

    fireEvent.change(
      screen.getByLabelText(
        "navigation.organization.management.experienceMode",
      ),
      { target: { value: "disabled" } },
    );
    expect(activePolicy).toHaveTextContent(
      "navigation.organization.management.manualReview",
    );
    expect(activePolicy).not.toHaveTextContent(
      "navigation.organization.management.disabled",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.organization.management.publishPolicy",
      }),
    );
    await waitFor(() =>
      expect(organizationAPI.publishPolicy).toHaveBeenCalledWith({
        organizationId: ORGANIZATION_A,
        document: {
          schemaVersion: 1,
          models: { allowlist: null },
          tools: { allowlist: null },
          experienceCandidates: { mode: "disabled" },
          officialAgents: { installation: "allowed" },
        },
        expectedOrganizationRevision: 7,
        expectedPolicyVersion: 2,
      }),
    );
  });

  it("keeps Auditor access read-only and limited to policy history and audit", async () => {
    renderDialog("auditor");
    await screen.findByText("Acme Enterprise");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "navigation.organization.management.policy",
      "navigation.organization.management.audit",
    ]);
    expect(
      await screen.findByTestId("organization-policy-history-list"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: "navigation.organization.management.policySettings",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "navigation.organization.management.publishPolicy",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "navigation.organization.management.rename",
      }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("tab", {
        name: "navigation.organization.management.audit",
      }),
    );
    expect(await screen.findByText("organization.created")).toBeInTheDocument();
  });

  it("fails closed when a Member reaches the management dialog directly", async () => {
    renderDialog("member");
    expect(
      await screen.findByText("navigation.organization.management.empty"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Acme Enterprise")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(
      screen.queryByLabelText(
        "navigation.organization.management.invitationLink",
      ),
    ).toBeNull();
    expect(
      screen.queryByLabelText("navigation.organization.management.createName"),
    ).toBeNull();
  });

  it("requires both exact high-risk confirmations before owner transfer or dissolution", async () => {
    const first = renderDialog("owner");
    const { organizationAPI } = first;
    await screen.findByText("Acme Enterprise");
    const transferTarget = screen.getByLabelText(
      "navigation.organization.management.transferTarget",
    );
    await waitFor(() => expect(transferTarget).toBeEnabled());
    fireEvent.change(transferTarget, { target: { value: TARGET_ID } });
    fireEvent.change(
      screen.getByLabelText(
        "navigation.organization.management.transferConfirmation",
      ),
      { target: { value: "transfer-organization-owner" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.organization.management.transferOwner",
      }),
    );
    await waitFor(() =>
      expect(organizationAPI.transferOwner).toHaveBeenCalledWith({
        organizationId: ORGANIZATION_A,
        targetUserId: TARGET_ID,
        expectedOrganizationRevision: 7,
        expectedOwnerRevision: 3,
        expectedTargetRevision: 4,
        confirmation: "transfer-organization-owner",
      }),
    );

    first.unmount();
    const archived = organization(ORGANIZATION_A, "owner", "Acme Enterprise", {
      status: "archived",
      mutationState: "archived",
      archivedAt: "2026-07-21T01:00:00Z",
    });
    const archivedAPI = installAPIs("owner", { organizations: [archived] });
    render(
      <OrganizationManagementDialog
        open
        authState={authState}
        onClose={vi.fn()}
        copyInvitationLink={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await screen.findByText("Acme Enterprise");

    const dissolveName = screen.getByLabelText(
      "navigation.organization.management.dissolveName",
    );
    await waitFor(() => expect(dissolveName).toBeEnabled());
    fireEvent.change(dissolveName, {
      target: { value: "Acme Enterprise" },
    });
    fireEvent.change(
      screen.getByLabelText(
        "navigation.organization.management.dissolveConfirmation",
      ),
      { target: { value: "dissolve-organization" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "navigation.organization.management.dissolve",
      }),
    );
    await waitFor(() =>
      expect(archivedAPI.organizationAPI.dissolve).toHaveBeenCalledWith({
        organizationId: ORGANIZATION_A,
        displayName: "Acme Enterprise",
        expectedRevision: 7,
        confirmation: "dissolve-organization",
      }),
    );
  });

  it("makes every mutation read-only offline while retaining cached members, departments, and policy", async () => {
    renderDialog("owner", true);
    expect(
      await screen.findByText(
        "navigation.organization.management.offlineReadOnly",
      ),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByTestId("organization-mutation")
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("tab", {
        name: "navigation.organization.management.members",
      }),
    );
    expect(await screen.findByText("Current Owner")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("tab", {
        name: "navigation.organization.management.departments",
      }),
    );
    expect(await screen.findByText("Research")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("tab", {
        name: "navigation.organization.management.policy",
      }),
    );
    expect(
      await screen.findByText(
        "navigation.organization.management.currentPolicy",
      ),
    ).toBeInTheDocument();
  });

  it("invalidates late detail results when the selected Product Space changes", async () => {
    let resolveFirst:
      | ((value: {
          ok: true;
          data: {
            items: OrganizationMember[];
            stale: false;
            refreshedAt: string;
          };
        }) => void)
      | undefined;
    const pending = new Promise<{
      ok: true;
      data: { items: OrganizationMember[]; stale: false; refreshedAt: string };
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const orgA = organization(ORGANIZATION_A, "owner", "Alpha Enterprise");
    const orgB = organization(ORGANIZATION_B, "owner", "Beta Enterprise");
    const { organizationAPI, emitProduct } = installAPIs("owner", {
      organizations: [orgA, orgB],
    });
    organizationAPI.listMembers.mockReturnValueOnce(pending).mockResolvedValue({
      ok: true,
      data: {
        items: [member(USER_ID, "owner", "Beta Owner")],
        stale: false,
        refreshedAt: "now",
      },
    });
    render(
      <OrganizationManagementDialog
        open
        authState={authState}
        onClose={vi.fn()}
        copyInvitationLink={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await screen.findByText("Alpha Enterprise");
    await act(async () => {
      emitProduct(ORGANIZATION_B);
    });
    fireEvent.click(
      screen.getByRole("tab", {
        name: "navigation.organization.management.members",
      }),
    );
    expect(await screen.findByText("Beta Owner")).toBeInTheDocument();
    await act(async () => {
      resolveFirst?.({
        ok: true,
        data: {
          items: [member(USER_ID, "owner", "Late Alpha Owner")],
          stale: false,
          refreshedAt: "late",
        },
      });
      await pending;
    });
    await waitFor(() =>
      expect(screen.queryByText("Late Alpha Owner")).toBeNull(),
    );
  });
});
