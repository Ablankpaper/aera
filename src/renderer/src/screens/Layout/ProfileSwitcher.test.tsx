import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string): string =>
      key === "common.appName" ? "Aera" : key,
  }),
}));

const profileModalMocks = vi.hoisted(() => ({
  openProfile: vi.fn(),
}));

vi.mock("../../components/profile/ProfileModalContext", () => ({
  useProfileModal: () => ({
    openProfile: profileModalMocks.openProfile,
  }),
}));

vi.mock("../../components/common/ProfileAvatar", () => ({
  default: ({ name }: { name: string }): React.JSX.Element => (
    <span data-testid={`avatar-${name}`} />
  ),
}));

import ProfileSwitcher from "./ProfileSwitcher";

interface ProfileInfo {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  model: string;
  skillCount: number;
  gatewayRunning: boolean;
}

function installHermesAPI(profiles: ProfileInfo[]): void {
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: {
      listProfiles: vi.fn().mockResolvedValue(profiles),
      setActiveProfile: vi.fn().mockResolvedValue(undefined),
    },
  });
}

function profile(id: string, name = id): ProfileInfo {
  return {
    id,
    name,
    isDefault: id === "default",
    isActive: id === "default",
    model: "",
    skillCount: 0,
    gatewayRunning: false,
  };
}

describe("ProfileSwitcher", () => {
  it("shows the app name for an unrenamed default profile", async () => {
    installHermesAPI([profile("default")]);

    render(
      <ProfileSwitcher
        activeProfile="default"
        onSwitch={() => {}}
        onManage={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Aera")).toBeInTheDocument();
    });
  });

  it("shows a custom default profile name when one is set", async () => {
    installHermesAPI([profile("default", "卢姐")]);

    render(
      <ProfileSwitcher
        activeProfile="default"
        onSwitch={() => {}}
        onManage={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("卢姐")).toBeInTheDocument();
    });
  });

  it("opens the active Agent through the product-level settings facade", async () => {
    installHermesAPI([profile("default")]);

    render(
      <ProfileSwitcher
        activeProfile="default"
        onSwitch={() => {}}
        onManage={() => {}}
      />,
    );

    const trigger = await screen.findByRole("button", {
      name: /Aera/,
    });
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu");
    await waitFor(() => {
      expect(window.hermesAPI.listProfiles).toHaveBeenCalledTimes(2);
    });
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: /Aera/ }),
    );

    expect(profileModalMocks.openProfile).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ onChanged: expect.any(Function) }),
    );
    expect(screen.queryByText(/Runtime Profile/i)).not.toBeInTheDocument();
  });
});
