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
import { workspaceEn, workspaceZhCN, workspaceZhTW } from "./locales/workspace";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function leafValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(leafValues);
}

describe("Workspace translations", () => {
  it("provides a complete explicit Workspace fallback in every locale", () => {
    const expected = leafKeys(workspaceEn).sort();
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
      expect(leafKeys(navigation.workspace).sort()).toEqual(expected);
      expect(
        leafValues(navigation.workspace).every((value) => value.length > 0),
      ).toBe(true);
    }
  });

  it("uses English deliberately for fallback locales and complete native Chinese variants", () => {
    expect(navigationAr.workspace).toBe(workspaceEn);
    expect(navigationJa.workspace).toBe(workspaceEn);
    expect(navigationZhCN.workspace).toBe(workspaceZhCN);
    expect(navigationZhTW.workspace).toBe(workspaceZhTW);
    expect(workspaceZhCN.personal).toBe("我的");
    expect(workspaceZhTW.personal).toBe("我的");
  });
});
