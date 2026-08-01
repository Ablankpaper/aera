import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const translate = (key: string): string => key;

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: translate,
  }),
}));

vi.mock("../../components/AgentMarkdown", () => ({
  AgentMarkdown: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import Discover from "./Discover";

describe("Discover progressive loading", () => {
  it("shows bundled skills without waiting forever for the community registry", async () => {
    const fetchRegistry = vi.fn(
      () =>
        new Promise<never>(() => {
          // Intentionally never resolves: this models a blocked public
          // registry request while local bundled content remains available.
        }),
    );
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        fetchRegistry,
        listBundledSkills: vi.fn().mockResolvedValue([
          {
            name: "offline-skill",
            description: "Available from the signed local Runtime",
            category: "local",
          },
        ]),
        listInstalledRegistry: vi.fn().mockResolvedValue({
          skills: [],
          mcps: [],
          workflows: [],
        }),
        listProfiles: vi.fn().mockResolvedValue([]),
        listInstalledSkills: vi.fn().mockResolvedValue([]),
      },
    });

    const view = render(<Discover visible />);

    expect(await screen.findByText("offline-skill")).toBeVisible();
    await waitFor(() => {
      expect(view.container.querySelector(".loading-spinner")).toBeNull();
    });
    expect(fetchRegistry).toHaveBeenCalledTimes(1);
  });
});
