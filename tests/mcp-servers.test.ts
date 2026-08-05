import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileSpy, stdinEndSpy } = vi.hoisted(() => {
  const stdinEndSpy = vi.fn();
  return {
    stdinEndSpy,
    execFileSpy: vi.fn(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(
          null,
          "Name Status Description\nlinear available Linear integration\n",
          "",
        );
        return { stdin: { end: stdinEndSpy } };
      },
    ),
  };
});

vi.mock("child_process", () => ({
  execFile: execFileSpy,
  default: { execFile: execFileSpy },
}));

vi.mock("../src/main/hermes", () => ({
  getApiUrl: () => "http://127.0.0.1:8642",
  getRemoteAuthHeader: () => ({}),
  isRemoteMode: () => false,
}));

vi.mock("../src/main/config", () => ({
  getApiServerKey: () => "",
}));

vi.mock("../src/main/utils", () => ({
  profilePaths: () => ({ configFile: "config.yaml", home: "/tmp/profile" }),
  safeWriteFile: vi.fn(),
}));

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: "/tmp/hermes-home",
  getEnhancedPath: () => process.env.PATH || "",
}));

vi.mock("../src/main/agentera-runtime-distribution/invocation", () => ({
  getRuntimeInvocation: () => ({
    source: "managed",
    version: "test",
    sourceCommit: "0".repeat(40),
    root: "/tmp/runtime/test",
    python: "/tmp/runtime/test/python/bin/python3",
    workingDirectory: "/tmp/runtime/test/python/lib/python3.11/site-packages",
    bundledSkillsDirectory: "/tmp/runtime/test/python/skills",
    webDistDirectory:
      "/tmp/runtime/test/python/lib/python3.11/site-packages/hermes_cli/web_dist",
    cliArgs: (args: string[] = []) => ["-m", "hermes_cli.main", ...args],
    environment: (base: Record<string, string> = {}) => ({ ...base }),
  }),
}));

import {
  parseCatalogOutput,
  parseMcpServersFromConfig,
  listMcpCatalog,
  removeMcpServerFromConfig,
  setMcpServerEnabledInConfig,
  testMcpServer,
  upsertMcpServerInConfig,
} from "../src/main/mcp-servers";

describe("MCP server config management", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the structured local Runtime endpoint for tool discovery", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            tools: [
              {
                name: "docs.read",
                description: "Read approved documents",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    execFileSpy.mockClear();

    const result = await testMcpServer("author-docs", "default");

    expect(result).toEqual({
      success: true,
      error: undefined,
      tools: [
        {
          name: "docs.read",
          description: "Read approved documents",
        },
      ],
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:8642/api/mcp/servers/author-docs/test",
      expect.objectContaining({ method: "POST" }),
    );
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it("falls back to the local Runtime CLI when its gateway is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("gateway unavailable");
      }),
    );
    execFileSpy.mockClear();
    execFileSpy.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(
          null,
          "Connected (12ms)\nTools discovered: 1\n\n    docs.read                            Read approved documents\n",
          "",
        );
        return { stdin: { end: stdinEndSpy } };
      },
    );

    const result = await testMcpServer("author-docs", "default");

    expect(result).toEqual({
      success: true,
      tools: [
        {
          name: "docs.read",
          description: "Read approved documents",
        },
      ],
    });
    expect(execFileSpy).toHaveBeenCalledWith(
      "/tmp/runtime/test/python/bin/python3",
      ["-m", "hermes_cli.main", "mcp", "test", "author-docs"],
      expect.objectContaining({
        cwd: "/tmp/runtime/test/python/lib/python3.11/site-packages",
      }),
      expect.any(Function),
    );
  });

  it("executes the local catalog through the live Runtime invocation", async () => {
    execFileSpy.mockClear();
    stdinEndSpy.mockClear();

    const result = await listMcpCatalog("work");

    expect(result.error).toBeUndefined();
    expect(execFileSpy).toHaveBeenCalledWith(
      "/tmp/runtime/test/python/bin/python3",
      ["-m", "hermes_cli.main", "mcp", "catalog"],
      expect.objectContaining({
        cwd: "/tmp/runtime/test/python/lib/python3.11/site-packages",
      }),
      expect.any(Function),
    );
    expect(stdinEndSpy).toHaveBeenCalledOnce();
  });

  it("parses the local hermes mcp catalog table output", () => {
    const entries = parseCatalogOutput(`
  MCP Catalog + configured servers:

  Name               Status                   Description
  ------------------ ------------------------ -----------
  linear             available                Find, create, and update Linear issues, projects, and comments.
  n8n                available                Manage and inspect n8n workflows from Hermes (stdio bridge, no public port).

  Install: hermes mcp install <name>    Picker: hermes mcp
`);

    expect(entries).toMatchObject([
      {
        name: "linear",
        description:
          "Find, create, and update Linear issues, projects, and comments.",
        installed: false,
      },
      {
        name: "n8n",
        description:
          "Manage and inspect n8n workflows from Hermes (stdio bridge, no public port).",
        installed: false,
      },
    ]);
  });

  it("parses HTTP and stdio MCP servers with args and env", () => {
    const servers = parseMcpServersFromConfig(`model:
  provider: openai

mcp_servers:
  notion:
    url: "https://mcp.notion.com/mcp"
    auth: "oauth"
  github:
    command: "npx"
    args:
      - "-y"
      - "@modelcontextprotocol/server-github"
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "redacted"
    enabled: false

memory:
  provider: honcho
`);

    expect(servers).toEqual([
      {
        name: "notion",
        type: "http",
        transport: "http",
        enabled: true,
        detail: "https://mcp.notion.com/mcp",
        url: "https://mcp.notion.com/mcp",
        command: undefined,
        args: [],
        env: {},
        auth: "oauth",
        tools: undefined,
      },
      {
        name: "github",
        type: "stdio",
        transport: "stdio",
        enabled: false,
        detail: "npx",
        url: undefined,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "redacted" },
        auth: undefined,
        tools: undefined,
      },
    ]);
  });

  it("adds a new mcp_servers block without disturbing neighboring config", () => {
    const next = upsertMcpServerInConfig(
      `model:
  provider: openai
`,
      {
        name: "linear",
        type: "http",
        url: "https://mcp.linear.app/mcp",
      },
    );

    expect(next).toContain(`model:
  provider: openai

mcp_servers:
  linear:
    url: "https://mcp.linear.app/mcp"
`);
  });

  it("appends a server to an existing block and preserves later sections", () => {
    const next = upsertMcpServerInConfig(
      `mcp_servers:
  github:
    command: "npx"

memory:
  provider: honcho
`,
      {
        name: "notion",
        type: "http",
        url: "https://mcp.notion.com/mcp",
        auth: "oauth",
      },
    );

    expect(next).toContain(`mcp_servers:
  github:
    command: "npx"
  notion:
    url: "https://mcp.notion.com/mcp"
    auth: "oauth"

memory:
  provider: honcho`);
  });

  it("removes only the requested server and keeps the mcp_servers block when others remain", () => {
    const next = removeMcpServerFromConfig(
      `mcp_servers:
  github:
    command: "npx"
  notion:
    url: "https://mcp.notion.com/mcp"

memory:
  provider: honcho
`,
      "github",
    );

    expect(next).not.toContain("github:");
    expect(next).toContain(`mcp_servers:
  notion:
    url: "https://mcp.notion.com/mcp"`);
    expect(next).toContain(`memory:
  provider: honcho`);
  });

  it("removes the mcp_servers block when the last server is removed", () => {
    const next = removeMcpServerFromConfig(
      `model:
  provider: openai

mcp_servers:
  github:
    command: "npx"

memory:
  provider: honcho
`,
      "github",
    );

    expect(next).not.toContain("mcp_servers:");
    expect(next).toContain(`model:
  provider: openai`);
    expect(next).toContain(`memory:
  provider: honcho`);
  });

  it("inserts and updates enabled flags inside the targeted server block", () => {
    const disabled = setMcpServerEnabledInConfig(
      `mcp_servers:
  github:
    command: "npx"
  notion:
    url: "https://mcp.notion.com/mcp"
    enabled: false
`,
      "github",
      false,
    );

    expect(disabled).toContain(`  github:
    command: "npx"
    enabled: false
  notion:`);

    const enabled = setMcpServerEnabledInConfig(disabled, "notion", true);
    expect(enabled).toContain(`  notion:
    url: "https://mcp.notion.com/mcp"
    enabled: true`);
  });

  it("updates the targeted server when manual blank lines separate server blocks", () => {
    const next = setMcpServerEnabledInConfig(
      `mcp_servers:
  github:
    command: "npx"

  notion:
    url: "https://mcp.notion.com/mcp"
`,
      "notion",
      false,
    );

    expect(next).toContain(`  github:
    command: "npx"

  notion:
    url: "https://mcp.notion.com/mcp"
    enabled: false`);
  });
});
