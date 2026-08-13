import { describe, expect, it } from "vitest";
import {
  PINNED_NAV_CATALOG,
  PINNED_NAV_ITEMS,
  SETTINGS_MANAGED_VIEWS,
} from "./Layout";
import zhCNNavigation from "../../../../shared/i18n/locales/zh-CN/navigation";

describe("pinned desktop navigation", () => {
  it("uses the updated Chinese navigation labels", () => {
    expect(zhCNNavigation.discover).toBe("工具社区");
    expect(zhCNNavigation.kanban).toBe("任务看板");
  });

  it("hides Workspace from the visible menu while retaining its descriptor", () => {
    expect(PINNED_NAV_ITEMS.map((item) => item.view)).toEqual([
      "discover",
      "kanban",
      "schedules",
      "agents",
    ]);
    expect(PINNED_NAV_CATALOG).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ view: "office", hidden: true }),
      ]),
    );
    expect(zhCNNavigation.office).toBe("工作区");
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
