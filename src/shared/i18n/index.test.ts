import { describe, expect, it } from "vitest";
import { t, getLocaleDirection, resources, APP_LOCALES } from "./index";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("shared i18n", () => {
  it("returns English text by default", () => {
    expect(t("welcome.title")).toBe("Welcome to AgentEra Studio");
  });

  it("falls back to the key when an English key is missing", () => {
    expect(t("common.missingKey")).toBe("common.missingKey");
  });

  it("returns zh-CN text when available", () => {
    expect(t("welcome.title", "zh-CN")).toBe("欢迎使用 AgentEra Studio");
  });

  it("returns zh-TW text when available", () => {
    expect(t("welcome.title", "zh-TW")).toBe("歡迎使用 AgentEra Studio");
  });

  it("returns es text when available", () => {
    expect(t("welcome.title", "es")).toBe("Bienvenido a AgentEra Studio");
  });

  it("returns id text when available", () => {
    expect(t("welcome.title", "id")).toBe("Selamat datang di AgentEra Studio");
  });

  it("returns pl text when available", () => {
    expect(t("welcome.title", "pl")).toBe("Witamy w AgentEra Studio");
  });

  it("returns he text when available", () => {
    expect(t("welcome.title", "he")).toBe("ברוכים הבאים ל-AgentEra Studio");
  });

  it("reports he as a right-to-left locale", () => {
    expect(getLocaleDirection("he")).toBe("rtl");
    expect(getLocaleDirection("en")).toBe("ltr");
  });

  it("falls back to en when zh-CN key is missing", () => {
    expect(t("nonExistent.fallbackKey", "zh-CN")).toBe(
      "nonExistent.fallbackKey",
    );
  });

  it("preserves interpolation placeholders in es", () => {
    expect(t("common.updateAvailable", "es", { version: "1.2.3" })).toBe(
      "Actualizar a v1.2.3",
    );
  });

  it("preserves interpolation placeholders in pl", () => {
    expect(t("common.updateAvailable", "pl", { version: "1.2.3" })).toBe(
      "Aktualizacja v1.2.3",
    );
  });

  it("provides the complete AgentEra auth copy in every supported locale", () => {
    const expected = leafKeys(resources.en.translation.auth).sort();
    expect(expected.length).toBeGreaterThan(30);

    for (const locale of APP_LOCALES) {
      expect(leafKeys(resources[locale].translation.auth).sort()).toEqual(
        expected,
      );
    }
  });

  it("provides explicit role-aware Workspace Agent copy in every locale", () => {
    for (const locale of APP_LOCALES) {
      const control = resources[locale].translation.agents.control as {
        workspaceSpace?: string;
        workspaceSpaceTitle?: string;
        workspaceAuthorSubtitle?: string;
        workspaceMemberSubtitle?: string;
        workspaceOfflineNotice?: string;
        workspaceDraftReadOnly?: string;
        view?: string;
        role?: Record<string, string>;
        errors?: Record<string, string>;
      };
      for (const value of [
        control.workspaceSpace,
        control.workspaceSpaceTitle,
        control.workspaceAuthorSubtitle,
        control.workspaceMemberSubtitle,
        control.workspaceOfflineNotice,
        control.workspaceDraftReadOnly,
        control.view,
        control.role?.owner,
        control.role?.admin,
        control.role?.member,
        control.errors?.workspace_forbidden,
        control.errors?.workspace_archived,
        control.errors?.workspace_owner_unavailable,
      ]) {
        expect(value).toEqual(expect.any(String));
        expect(value?.length).toBeGreaterThan(0);
      }
    }
  });

  it("provides the complete ExperienceCandidate UI copy in every locale", () => {
    const expected = leafKeys(
      resources.en.translation.agents.control.experience,
    ).sort();
    expect(expected.length).toBeGreaterThan(40);

    for (const locale of APP_LOCALES) {
      const experience = (
        resources[locale].translation.agents.control as {
          experience?: unknown;
        }
      ).experience;
      expect(leafKeys(experience).sort()).toEqual(expected);
    }
  });

  it("keeps Arabic and Hebrew authentication screens right-to-left", () => {
    expect(getLocaleDirection("ar")).toBe("rtl");
    expect(getLocaleDirection("he")).toBe("rtl");
  });
});
