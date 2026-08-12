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

function leafEntries(value: unknown, prefix = ""): Array<[string, string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return typeof value === "string" && prefix ? [[prefix, value]] : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => leafEntries(child, prefix ? `${prefix}.${key}` : key),
  );
}

function interpolationTokens(value: string): string[] {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)]
    .map((match) => match[1])
    .sort();
}

const ALLOWED_SIMPLIFIED_CHINESE_TECHNICAL_KEYS = new Set([
  "common.appName",
  "setup.modelBaseUrlPlaceholder",
  "settings.sections.hermesAgent",
  "settings.nav.groups.hermes",
  "settings.desktopTitle",
  "settings.font.manrope",
  "settings.version",
  "settings.modelBaseUrlPlaceholder",
  "settings.linkDiscord",
  "settings.linkTelegram",
  "settings.sshUsernamePlaceholder",
  "tools.http",
  "tools.mcpUrl",
  "models.baseUrlPlaceholder",
  "office.ceo",
  "agents.control.asset.sop",
  "kanban.displayNamePlaceholder",
]);

function isAllowedTechnicalLiteral(key: string): boolean {
  return (
    ALLOWED_SIMPLIFIED_CHINESE_TECHNICAL_KEYS.has(key) ||
    key.startsWith("constants.") ||
    /^setup\.providerCards\.[^.]+\.name$/.test(key) ||
    key.startsWith("setup.localPresets.") ||
    /^settings\.language\.(english|spanish|turkish)$/.test(key) ||
    /^navigation\.organization\.(management|access)\.invitationLinkPlaceholder$/.test(
      key,
    ) ||
    /^schedules\.deliverTargets\.(telegram|discord|slack|whatsapp|signal|matrix|mattermost|webhook|homeassistant)$/.test(
      key,
    )
  );
}

describe("shared i18n", () => {
  it("returns English text by default", () => {
    expect(t("welcome.title")).toBe("Welcome to Aera");
  });

  it("falls back to the key when an English key is missing", () => {
    expect(t("common.missingKey")).toBe("common.missingKey");
  });

  it("returns zh-CN text when available", () => {
    expect(t("welcome.title", "zh-CN")).toBe("欢迎使用 Aera");
  });

  it("provides localized Agent model-switch states and marker copy", () => {
    expect(t("chat.modelSwitch.marker", "en")).toBe("Model changed");
    expect(t("chat.modelSwitch.fixedPolicy", "en")).toBe(
      "This Agent uses a fixed model policy.",
    );
    expect(t("chat.modelSwitch.marker", "zh-CN")).toBe("模型已切换");
    expect(t("chat.modelSwitch.fixedPolicy", "zh-CN")).toBe(
      "此智能体使用固定模型策略，无法切换模型。",
    );
  });

  it("provides complete Simplified Chinese copy for every source key", () => {
    const source = new Map(leafEntries(resources.en.translation));
    const simplifiedChinese = new Map(
      leafEntries(resources["zh-CN"].translation),
    );
    const missing = [...source].filter(([key]) => !simplifiedChinese.has(key));
    expect(missing).toEqual([]);
  });

  it("preserves every source interpolation token in Simplified Chinese", () => {
    const simplifiedChinese = new Map(
      leafEntries(resources["zh-CN"].translation),
    );
    const mismatches = leafEntries(resources.en.translation).flatMap(
      ([key, source]) => {
        const translated = simplifiedChinese.get(key);
        return translated !== undefined &&
          interpolationTokens(translated).join("\0") ===
            interpolationTokens(source).join("\0")
          ? []
          : [key];
      },
    );
    expect(mismatches).toEqual([]);
  });

  it("does not silently reuse English interface copy in Simplified Chinese", () => {
    const simplifiedChinese = new Map(
      leafEntries(resources["zh-CN"].translation),
    );
    const untranslated = leafEntries(resources.en.translation).filter(
      ([key, source]) =>
        /[A-Za-z]{2}/.test(source) &&
        simplifiedChinese.get(key) === source &&
        !isAllowedTechnicalLiteral(key),
    );
    expect(untranslated).toEqual([]);
  });

  it("returns zh-TW text when available", () => {
    expect(t("welcome.title", "zh-TW")).toBe("歡迎使用 Aera");
  });

  it("returns es text when available", () => {
    expect(t("welcome.title", "es")).toBe("Bienvenido a Aera");
  });

  it("returns id text when available", () => {
    expect(t("welcome.title", "id")).toBe("Selamat datang di Aera");
  });

  it("returns pl text when available", () => {
    expect(t("welcome.title", "pl")).toBe("Witamy w Aera");
  });

  it("returns he text when available", () => {
    expect(t("welcome.title", "he")).toBe("ברוכים הבאים ל-Aera");
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

  it("provides the complete Aera auth copy in every supported locale", () => {
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
        control.role?.auditor,
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

  it("provides the complete Organization Agent UI copy in every locale", () => {
    const expected = leafKeys(
      resources.en.translation.agents.control.organization,
    ).sort();
    expect(expected.length).toBeGreaterThan(30);

    for (const locale of APP_LOCALES) {
      const organization = (
        resources[locale].translation.agents.control as {
          organization?: unknown;
        }
      ).organization;
      expect(leafKeys(organization).sort()).toEqual(expected);
    }
  });

  it("provides the complete Official Agent UI copy in every locale", () => {
    const expected = leafKeys(
      resources.en.translation.agents.control.official,
    ).sort();
    expect(expected.length).toBeGreaterThan(20);

    for (const locale of APP_LOCALES) {
      const official = (
        resources[locale].translation.agents.control as {
          official?: unknown;
        }
      ).official;
      expect(leafKeys(official).sort()).toEqual(expected);
    }
  });

  it("keeps Arabic and Hebrew authentication screens right-to-left", () => {
    expect(getLocaleDirection("ar")).toBe("rtl");
    expect(getLocaleDirection("he")).toBe("rtl");
  });
});
