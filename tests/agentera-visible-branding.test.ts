import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

describe("AgentEra Studio visible branding", () => {
  // @lat: [[agentera-branding#Naming contract#Desktop identity]]
  it("owns the desktop packaging identity", () => {
    expect(JSON.parse(read("package.json"))).toMatchObject({
      name: "agentera-studio",
      description: "AgentEra Studio — private AI agent desktop",
      author: "AgentEra",
      homepage: "https://github.com/bignormal/aera",
    });

    const builder = read("electron-builder.yml");
    expect(builder).toContain("appId: com.bignormal.agentera.studio");
    expect(builder).toContain("productName: AgentEra Studio");
    expect(builder).toContain("executableName: agentera-studio");
    expect(builder).toContain("owner: bignormal");
    expect(builder).toContain("repo: aera");
  });

  // @lat: [[agentera-branding#Naming contract#Visible application names]]
  it("uses the approved names on composed application surfaces", () => {
    expect(existsSync("src/shared/branding.ts")).toBe(true);
    if (existsSync("src/shared/branding.ts")) {
      expect(read("src/shared/branding.ts")).toContain(
        'DESKTOP_PRODUCT_NAME = "AgentEra Studio"',
      );
      expect(read("src/shared/branding.ts")).toContain(
        'RUNTIME_DISPLAY_NAME = "AgentEra Runtime"',
      );
    }

    expect(read("src/renderer/index.html")).toContain(
      "<title>AgentEra Studio</title>",
    );
    expect(
      read("src/renderer/src/screens/SplashScreen/SplashScreen.tsx"),
    ).toContain("AgentEra Studio");
    expect(read("src/renderer/src/screens/Chat/Chat.tsx")).not.toContain(
      "FollowUsModal",
    );
    expect(
      read("src/renderer/src/components/settings/SettingsModal.tsx"),
    ).not.toContain("<CommunityPane");
  });

  // @lat: [[agentera-branding#Localization#All supported locales]]
  it("uses AgentEra names in locale product copy", () => {
    const commonFiles = localeFiles.filter((path) =>
      path.endsWith("/common.ts"),
    );
    expect(commonFiles).toHaveLength(12);
    for (const path of commonFiles) {
      expect(read(path), path).toContain('appName: "AgentEra Studio"');
    }

    const firstPartyLeaks = localeFiles.flatMap((path) =>
      read(path)
        .split("\n")
        .map((line, index) => ({
          path,
          line: index + 1,
          text: line.trim(),
        }))
        .filter(({ text }) => {
          if (
            !/(Hermes One|Hermes Desktop|Hermes Agent|Nous Research|fathah)/.test(
              text,
            )
          ) {
            return false;
          }
          if (/^(\/\/|\*|\/\*)/.test(text)) return false;
          if (/Hermes One (Inference|account)/.test(text)) return false;
          if (
            /(constants|providers)\.ts$/.test(path) &&
            /(Hermes One|Nous Research)/.test(text)
          ) {
            return false;
          }
          if (
            /(HERMES_|\.hermes|hermes_cli|<code>hermes\s|@hermes:)/.test(text)
          ) {
            return false;
          }
          return true;
        }),
    );
    expect(firstPartyLeaks).toEqual([]);
  });

  it("publishes only AgentEra repository documentation", () => {
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
      expect(content, path).toContain("AgentEra Studio");
      expect(content, path).toContain("https://github.com/bignormal/aera");
      expect(content, path).not.toMatch(
        /Hermes One|Hermes Desktop|Hermes Agent|Nous Research|fathah/,
      );
    }

    for (const path of readmes) {
      expect(read(path), path).not.toMatch(/<img|!\[[^\]]*\]\([^)]*\)/);
    }
  });

  // @lat: [[agentera-branding#Compatibility boundary#Stable runtime identifiers]]
  it("preserves runtime compatibility identifiers", () => {
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
