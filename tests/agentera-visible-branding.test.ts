import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");
const localeFiles = readdirSync("src/shared/i18n/locales", {
  withFileTypes: true,
}).flatMap((entry) => {
  if (!entry.isDirectory()) return [];
  const root = join("src/shared/i18n/locales", entry.name);
  return readdirSync(root)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(root, name));
});

describe("Aera visible branding", () => {
  // @lat: [[agentera-branding#Naming contract#Desktop identity]]
  it("owns the desktop packaging identity", () => {
    expect(JSON.parse(read("package.json"))).toMatchObject({
      name: "agentera-studio",
      description: "Aera — private AI agent desktop",
      author: "Aera",
      homepage: "https://github.com/Ablankpaper/aera",
    });

    const builder = read("electron-builder.yml");
    expect(builder).toContain("appId: com.bignormal.agentera.studio");
    expect(builder).toContain("productName: Aera");
    expect(builder).toContain("executableName: Aera");
    expect(builder).toContain("artifactName: Aera-${version}");
    expect(builder).toContain("- aera");
    expect(builder).toContain("- agentera");
    expect(builder).toContain("owner: Ablankpaper");
    expect(builder).toContain("repo: aera");
  });

  // @lat: [[agentera-branding#Naming contract#Visible application names]]
  it("uses the approved names on composed application surfaces", () => {
    expect(existsSync("src/shared/branding.ts")).toBe(true);
    if (existsSync("src/shared/branding.ts")) {
      expect(read("src/shared/branding.ts")).toContain(
        'DESKTOP_PRODUCT_NAME = "Aera"',
      );
      expect(read("src/shared/branding.ts")).toContain(
        'RUNTIME_DISPLAY_NAME = "Aera Runtime"',
      );
    }

    expect(read("src/renderer/index.html")).toContain(
      "<title>Aera</title>",
    );
    expect(
      read("src/renderer/src/screens/SplashScreen/SplashScreen.tsx"),
    ).toContain("Aera");
    expect(read("src/renderer/src/screens/Chat/Chat.tsx")).not.toContain(
      "FollowUsModal",
    );
    expect(
      read("src/renderer/src/components/settings/SettingsModal.tsx"),
    ).not.toContain("<CommunityPane");
  });

  // @lat: [[agentera-branding#Localization#All supported locales]]
  it("uses Aera names in locale product copy", () => {
    const commonFiles = localeFiles.filter(
      (path) => basename(path) === "common.ts",
    );
    expect(commonFiles).toHaveLength(12);
    for (const path of commonFiles) {
      expect(read(path), path).toContain('appName: "Aera"');
    }

    const firstPartyLeaks = localeFiles.flatMap((path) => {
      const literals =
        read(path).match(/"(?:\\.|[^"\\])*"/g)?.map((text) => ({
          path,
          text,
        })) ?? [];
      return literals.filter(({ text }) => {
        if (/\b(?:AgentEra|WorkBuddy|AionUI)\b|Aera Studio/.test(text)) {
          return true;
        }
        if (!/\bHermes\b(?! One)/.test(text)) return false;
        return !/(HERMES_|\.hermes|hermes_cli|<code>hermes\s|@hermes:)/.test(
          text,
        );
      });
    });
    expect(firstPartyLeaks).toEqual([]);
  });

  it("publishes only Aera repository documentation", () => {
    const readmes = [
      "README.md",
      "README.zh-CN.md",
      "README.ja-JP.md",
      "README.es-LATAM.md",
    ];
    const contributorGuides = [
      "CONTRIBUTING.md",
      "CONTRIBUTING.zh-CN.md",
      "CONTRIBUTING.ja-JP.md",
    ];

    for (const path of [...readmes, ...contributorGuides]) {
      const content = read(path);
      expect(content, path).toContain("Aera");
      expect(content, path).toContain("https://github.com/Ablankpaper/aera");
      expect(content, path).not.toMatch(
        /\b(?:AgentEra|WorkBuddy|AionUI)\b|Aera Studio|Hermes One|Hermes Desktop|Hermes Agent|Nous Research|fathah/,
      );
    }

    for (const path of readmes) {
      expect(read(path), path).not.toMatch(/<img|!\[[^\]]*\]\([^)]*\)/);
    }
  });

  // @lat: [[agentera-branding#Compatibility boundary#Stable runtime identifiers]]
  it("preserves runtime compatibility identifiers", () => {
    expect(JSON.parse(read("package.json")).name).toBe("agentera-studio");
    expect(read("electron-builder.yml")).toContain(
      "appId: com.bignormal.agentera.studio",
    );
    expect(read("src/main/app/identity.ts")).toContain('"AgentEra Studio"');
    expect(read("src/main/index.ts")).toContain(
      'const schemes = ["aera", "agentera"]',
    );
    expect(read("build/winget/Version.template.yaml")).toContain(
      "PackageIdentifier: Bignormal.AgentEraStudio",
    );
    expect(read("src/main/installer.ts")).toContain("HERMES_HOME");
    expect(read("src/preload/index.ts")).toContain("hermesAPI");
    expect(read("src/renderer/src/constants.ts")).toContain(
      "Hermes One Inference",
    );
    expect(read("src/renderer/src/constants.ts")).toContain(
      "HERMESONE_API_KEY",
    );
  });
});
