import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgenteraAccountPane from "./AgenteraAccountPane";

vi.mock("../useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string): string => key,
  }),
}));

describe("AgenteraAccountPane", () => {
  const state = {
    status: "authenticated" as const,
    userId: "11111111-1111-4111-8111-111111111111",
    personalSpaceId: "22222222-2222-4222-8222-222222222222",
    deviceId: "33333333-3333-4333-8333-333333333333",
    offlineExpiresAt: "2026-07-25T01:00:00.000Z",
    cloudAvailable: true,
  };
  const currentProfile = {
    userId: state.userId,
    displayName: "Alice",
    occupation: "Product designer",
    bio: "Building useful agents.",
    avatarDataUrl: null,
    updatedAt: "2026-07-25T02:00:00.000Z",
  };
  let updateUserProfile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateUserProfile = vi.fn().mockImplementation(async (input) => ({
      ...currentProfile,
      ...input,
      updatedAt: "2026-07-25T03:00:00.000Z",
    }));
    Object.defineProperty(window, "agenteraAuth", {
      configurable: true,
      value: {
        getState: vi.fn().mockResolvedValue(state),
        onStateChanged: vi.fn(() => vi.fn()),
        getUserProfile: vi.fn().mockResolvedValue(currentProfile),
        updateUserProfile,
        onUserProfileChanged: vi.fn(() => vi.fn()),
      },
    });
  });

  it("explains local-data retention and keeps recharge identity separate", async () => {
    const actions = {
      onManageAccount: vi.fn().mockResolvedValue(undefined),
      onManageDevices: vi.fn().mockResolvedValue(undefined),
      onRecharge: vi.fn().mockResolvedValue(undefined),
      onSwitchAccount: vi.fn().mockResolvedValue(undefined),
      onSignOut: vi.fn().mockResolvedValue(undefined),
    };
    render(<AgenteraAccountPane state={state} {...actions} />);

    expect(
      screen.getByText("auth.account.localDataWarning"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("auth.account.rechargeSeparateAccount"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("auth.account.pendingRevocationWarning"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "auth.account.manage" }),
    );
    await waitFor(() => expect(actions.onManageAccount).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("button", { name: "auth.account.devices" }),
    );
    await waitFor(() => expect(actions.onManageDevices).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole("button", { name: "auth.account.recharge" }),
    );
    await waitFor(() => expect(actions.onRecharge).toHaveBeenCalledOnce());
  });

  it("loads and saves editable personal information for the current account", async () => {
    render(<AgenteraAccountPane state={state} />);

    const profileCard = (
      await screen.findByText("auth.account.profile.title")
    ).closest("section");
    expect(profileCard).toHaveClass("settings-card");
    expect(profileCard).not.toHaveClass("agentera-profile-card");

    const name = await screen.findByLabelText(
      "auth.account.profile.displayName",
    );
    await waitFor(() => expect(name).toHaveValue("Alice"));
    await waitFor(() =>
      expect(
        screen.getByLabelText("auth.account.profile.occupation"),
      ).toHaveValue("Product designer"),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("auth.account.profile.bio")).toHaveValue(
        "Building useful agents.",
      ),
    );

    fireEvent.change(name, { target: { value: "  艾拉用户  " } });
    fireEvent.change(screen.getByLabelText("auth.account.profile.occupation"), {
      target: { value: "独立开发者" },
    });
    fireEvent.change(screen.getByLabelText("auth.account.profile.bio"), {
      target: { value: "喜欢把想法做成真正可用的产品。" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "auth.account.profile.save" }),
    );

    await waitFor(() =>
      expect(updateUserProfile).toHaveBeenCalledWith({
        displayName: "艾拉用户",
        occupation: "独立开发者",
        bio: "喜欢把想法做成真正可用的产品。",
        avatarDataUrl: null,
      }),
    );
    expect(
      await screen.findByText("auth.account.profile.saved"),
    ).toBeInTheDocument();
  });
});
