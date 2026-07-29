import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("Aera composed application surfaces", () => {
  it("uses Aera-owned menu and support links", () => {
    const menu = read("src/main/app/menu.ts");
    expect(menu).toContain("Aera Runtime on GitHub");
    expect(menu).toContain("https://github.com/bignormal/aera/issues");
    expect(menu).not.toContain("fathah/hermes-desktop");
  });

  it("presents the bundled engine as Aera Runtime", () => {
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

    expect(sources.join("\n")).toContain("Aera Runtime");
    for (const source of sources) {
      expect(source).not.toContain("Hermes Agent");
      expect(source).not.toContain("Hermes Desktop");
    }
  });

  it("uses only Aera artwork in composed desktop views", () => {
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

  it("brands the office experience as Aera", () => {
    const showroom = read(
      "src/renderer/src/screens/Office/office3d/objects/CarShowroom.tsx",
    );
    const office = read(
      "src/renderer/src/screens/Office/office3d/objects/OfficeShell.tsx",
    );

    expect(showroom).toContain("AERA MOTORS");
    expect(showroom).not.toContain("AGENTERA MOTORS");
    expect(showroom).toContain("Aera S1");
    expect(showroom).toContain("Aera GT");
    expect(showroom).not.toContain("Hermes S1");
    expect(showroom).not.toContain("Hermes GT");
    expect(office).toContain("iconv2.png");
    expect(office).not.toContain("hermes-one-hq.webp");
  });

  it("keeps the empty-state Aera mark transparent", () => {
    const styles = read("src/renderer/src/assets/main.css");
    const emptyIconRule = styles.match(/\.chat-empty-icon\s*\{([^}]*)\}/)?.[1];

    expect(emptyIconRule).toBeDefined();
    expect(emptyIconRule).not.toMatch(/background\s*:\s*#000/i);
  });

  it("removes bare Hermes branding from user-facing copy", () => {
    const messaging = read("src/shared/messaging-platforms.ts");
    const dashboard = read("src/main/dashboard.ts");
    const registry = read("src/main/registry.ts");
    const sync = read("src/main/agent-sync.ts");
    const slashCommands = read(
      "src/renderer/src/screens/Chat/slashCommands.ts",
    );
    const desktopCommands = read(
      "src/renderer/src/screens/Chat/slash/desktopCommands.ts",
    );
    const transcript = read("src/renderer/src/screens/Chat/transcriptUtils.ts");
    const chatMessages = read("src/renderer/src/screens/Chat/chatMessages.ts");
    const dashboardTransport = read(
      "src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts",
    );

    expect(messaging).not.toMatch(/description:\s*["`][^"`]*Hermes/);
    expect(dashboard).not.toContain("Hermes repo not found");
    expect(registry).not.toContain('label: "Requires Hermes"');
    expect(sync).not.toContain("different Hermes account");
    expect(slashCommands).not.toMatch(/(Update|Show) Hermes/);
    expect(desktopCommands).not.toContain("Show Hermes version");
    expect(transcript).not.toMatch(/["`]Hermes[:"`]/);
    expect(chatMessages).not.toContain("Hermes reported an error");
    expect(dashboardTransport).not.toContain("Hermes reported an error");

    expect(
      [
        messaging,
        dashboard,
        registry,
        sync,
        slashCommands,
        desktopCommands,
        transcript,
        chatMessages,
        dashboardTransport,
      ].join("\n"),
    ).toContain("Aera");
  });
});
