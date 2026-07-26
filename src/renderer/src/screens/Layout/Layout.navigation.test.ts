import { describe, expect, it } from "vitest";
import { PINNED_NAV_ITEMS, SETTINGS_MANAGED_VIEWS } from "./Layout";

describe("pinned desktop navigation", () => {
  it("places Agents directly after Schedules", () => {
    expect(PINNED_NAV_ITEMS.map((item) => item.view)).toEqual([
      "discover",
      "office",
      "kanban",
      "schedules",
      "agents",
    ]);
  });

  it("delegates provider, gateway, tools, and memory navigation to Settings", () => {
    expect(SETTINGS_MANAGED_VIEWS).toEqual([
      "providers",
      "gateway",
      "tools",
      "memory",
    ]);
    expect(PINNED_NAV_ITEMS.map((item) => item.view)).not.toEqual(
      expect.arrayContaining([...SETTINGS_MANAGED_VIEWS]),
    );
  });
});
