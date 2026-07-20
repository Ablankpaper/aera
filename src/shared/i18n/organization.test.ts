import { describe, expect, it } from "vitest";
import navigationAr from "./locales/ar/navigation";
import navigationEn from "./locales/en/navigation";
import navigationEs from "./locales/es/navigation";
import navigationHe from "./locales/he/navigation";
import navigationId from "./locales/id/navigation";
import navigationJa from "./locales/ja/navigation";
import navigationPl from "./locales/pl/navigation";
import navigationPtBR from "./locales/pt-BR/navigation";
import navigationPtPT from "./locales/pt-PT/navigation";
import navigationTr from "./locales/tr/navigation";
import navigationZhCN from "./locales/zh-CN/navigation";
import navigationZhTW from "./locales/zh-TW/navigation";
import {
  organizationEn,
  organizationZhCN,
  organizationZhTW,
} from "./locales/organization";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("Organization translations", () => {
  it("provides the complete explicit fallback in every navigation locale", () => {
    const expected = leafKeys(organizationEn).sort();
    for (const navigation of [
      navigationEn,
      navigationAr,
      navigationEs,
      navigationHe,
      navigationId,
      navigationJa,
      navigationPl,
      navigationPtBR,
      navigationPtPT,
      navigationTr,
      navigationZhCN,
      navigationZhTW,
    ]) {
      expect(leafKeys(navigation.organization).sort()).toEqual(expected);
    }
  });

  it("uses deliberate English fallbacks and native Chinese product-space labels", () => {
    expect(navigationAr.organization).toBe(organizationEn);
    expect(navigationJa.organization).toBe(organizationEn);
    expect(navigationZhCN.organization).toBe(organizationZhCN);
    expect(navigationZhTW.organization).toBe(organizationZhTW);
    expect(organizationZhCN.switcher.organizationGroup).toBe("企业组织");
    expect(organizationZhTW.switcher.organizationGroup).toBe("企業組織");
  });
});
