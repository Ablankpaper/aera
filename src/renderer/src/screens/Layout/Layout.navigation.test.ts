import { describe, expect, it } from "vitest";
import { PINNED_NAV_ITEMS } from "./Layout";

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
});
