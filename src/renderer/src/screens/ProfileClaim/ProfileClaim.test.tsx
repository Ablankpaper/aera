import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, type Mock, vi } from "vitest";
import ProfileClaim from "./ProfileClaim";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string): string => key,
  }),
}));

type TestAction = Mock<() => Promise<void>>;

function callbacks(): Record<
  | "onUseExisting"
  | "onCreateNew"
  | "onBindConnection"
  | "onUseDifferentAccount"
  | "onRetry",
  TestAction
> {
  return {
    onUseExisting: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onCreateNew: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onBindConnection: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onUseDifferentAccount: vi
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined),
    onRetry: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

describe("ProfileClaim", () => {
  it("does nothing with meaningful local data until one of two choices is explicit", () => {
    const actions = callbacks();
    render(
      <ProfileClaim
        mode="local"
        claim={{ status: "unbound", meaningfulData: true }}
        {...actions}
      />,
    );

    expect(actions.onUseExisting).not.toHaveBeenCalled();
    expect(actions.onCreateNew).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "auth.profile.useExisting" }),
    ).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "auth.profile.createNew" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByText("auth.profile.noUpload")).toBeInTheDocument();
  });

  it("binds an empty local Profile without showing a migration choice", async () => {
    const actions = callbacks();
    render(
      <ProfileClaim
        mode="local"
        claim={{ status: "unbound", meaningfulData: false }}
        {...actions}
      />,
    );

    await waitFor(() => expect(actions.onUseExisting).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("button", { name: "auth.profile.useExisting" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "auth.profile.createNew" }),
    ).toBeNull();
  });

  it("never offers another owner's local Profile as existing data", () => {
    const actions = callbacks();
    render(
      <ProfileClaim
        mode="local"
        claim={{
          status: "owned",
          meaningfulData: true,
          isCurrentOwner: false,
        }}
        {...actions}
      />,
    );

    expect(
      screen.getByText("auth.profile.otherOwnerTitle"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "auth.profile.useExisting" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "auth.profile.createNew" }),
    );
    expect(actions.onCreateNew).toHaveBeenCalledOnce();
  });

  it("binds an unowned remote context instead of inheriting another owner", async () => {
    const actions = callbacks();
    const { rerender } = render(
      <ProfileClaim mode="remote" claim={{ status: "unbound" }} {...actions} />,
    );

    await waitFor(() =>
      expect(actions.onBindConnection).toHaveBeenCalledOnce(),
    );

    rerender(
      <ProfileClaim
        mode="remote"
        claim={{ status: "owned", isCurrentOwner: false }}
        {...actions}
      />,
    );
    expect(
      screen.getByText("auth.profile.remoteOtherOwnerTitle"),
    ).toBeInTheDocument();
    expect(actions.onBindConnection).toHaveBeenCalledOnce();
  });
});
