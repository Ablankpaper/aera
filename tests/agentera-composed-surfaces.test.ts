import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("AgentEra composed application surfaces", () => {
  it("uses AgentEra-owned menu and support links", () => {
    const menu = read("src/main/app/menu.ts");
    expect(menu).toContain("AgentEra Runtime on GitHub");
    expect(menu).toContain("https://github.com/bignormal/aera/issues");
    expect(menu).not.toContain("fathah/hermes-desktop");
  });

  it("presents the bundled engine as AgentEra Runtime", () => {
    const sources = [
      "src/main/installer.ts",
      "src/main/ipc/register.ts",
      "src/main/mcp-servers.ts",
      "src/main/hermes.ts",
      "src/main/dashboard.ts",
      "src/main/remote-metadata.ts",
      "src/renderer/src/screens/Chat/ChatInput.tsx",
      "src/renderer/src/screens/Chat/hooks/useChatActions.ts",
      "src/renderer/src/screens/Chat/hooks/useLocalCommands.ts",
      "src/renderer/src/screens/Chat/slash/commandCatalog.ts",
    ].map(read);

    expect(sources.join("\n")).toContain("AgentEra Runtime");
    for (const source of sources) {
      expect(source).not.toContain("Hermes Agent");
      expect(source).not.toContain("Hermes Desktop");
    }
  });

  it("uses only AgentEra artwork in composed desktop views", () => {
    const layout = read("src/renderer/src/screens/Layout/Layout.tsx");
    const about = read("src/renderer/src/components/settings/AboutPane.tsx");
    const empty = read("src/renderer/src/screens/Chat/ChatEmptyState.tsx");
    const logo = read("src/renderer/src/components/common/HermesLogo.tsx");
    const office = read("src/renderer/src/screens/Office/Office.tsx");

    for (const source of [layout, about, empty, logo, office]) {
      expect(source).toContain("iconv2.png");
      expect(source).not.toMatch(
        /hermes-one\.svg|hermes-icon\.svg|title-line\.svg|one-chat\.svg/,
      );
      expect(source).not.toContain('alt="Hermes"');
      expect(source).not.toContain('aria-label="Hermes"');
    }
  });

  it("removes upstream promotional surfaces from the composed UI", () => {
    expect(read("src/renderer/src/screens/Chat/Chat.tsx")).not.toContain(
      "FollowUsModal",
    );
    expect(
      read("src/renderer/src/components/settings/SettingsModal.tsx"),
    ).not.toContain("CommunityPane");
  });

  it("brands the office experience as AgentEra", () => {
    const showroom = read(
      "src/renderer/src/screens/Office/office3d/objects/CarShowroom.tsx",
    );
    const office = read(
      "src/renderer/src/screens/Office/office3d/objects/OfficeShell.tsx",
    );

    expect(showroom).toContain("AGENTERA MOTORS");
    expect(showroom).toContain("AgentEra S1");
    expect(showroom).toContain("AgentEra GT");
    expect(showroom).not.toContain("Hermes S1");
    expect(showroom).not.toContain("Hermes GT");
    expect(office).toContain("iconv2.png");
    expect(office).not.toContain("hermes-one-hq.webp");
  });
});
