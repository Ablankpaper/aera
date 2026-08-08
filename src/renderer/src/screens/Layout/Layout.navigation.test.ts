import { describe, expect, it } from "vitest";
import { PINNED_NAV_ITEMS, SETTINGS_MANAGED_VIEWS } from "./Layout";
import zhCNNavigation from "../../../../shared/i18n/locales/zh-CN/navigation";

describe("pinned desktop navigation", () => {
  it("uses the updated Chinese navigation labels", () => {
    expect(zhCNNavigation.discover).toBe("工具社区");
    expect(zhCNNavigation.kanban).toBe("任务看板");
  });

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
