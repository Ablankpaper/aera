import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentIdentityService } from "./agent-identity";
import { safeWriteFile } from "./utils";

describe("AgentIdentityService", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function profileRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "aera-agent-identity-"));
    roots.push(root);
    return root;
  }

  // @lat: [[chat-commands#Central command router#Desktop commands]]
  it("updates the display name and managed SOUL identity without replacing the persona", () => {
    const root = profileRoot();
    writeFileSync(
      join(root, "profile-meta.json"),
      JSON.stringify({ name: "Old Agent", color: "#123456" }, null, 2),
    );
    writeFileSync(join(root, "SOUL.md"), "Keep this existing persona.\n");
    const service = new AgentIdentityService({
      resolveProfilePath: () => root,
      now: () => new Date("2026-07-26T08:00:00.000Z"),
      createOperationId: () => "018f0000-0000-7000-8000-000000000001",
    });

    const result = service.setDisplayName("agent-one", " 林七夜 ");

    expect(result).toMatchObject({
      success: true,
      operationId: "018f0000-0000-7000-8000-000000000001",
      identity: {
        profileId: "agent-one",
        displayName: "林七夜",
        revision: 1,
        updatedAt: "2026-07-26T08:00:00.000Z",
      },
    });
    expect(
      JSON.parse(readFileSync(join(root, "profile-meta.json"), "utf8")),
    ).toEqual({ name: "林七夜", color: "#123456" });
    const soul = readFileSync(join(root, "SOUL.md"), "utf8");
    expect(soul).toContain("Your name is \u201c林七夜\u201d.");
    expect(soul).toContain("Keep this existing persona.");
  });

  it("replaces exactly one managed identity block on a later rename", () => {
    const root = profileRoot();
    writeFileSync(join(root, "SOUL.md"), "Keep this persona.\n");
    let operationNumber = 1;
    const service = new AgentIdentityService({
      resolveProfilePath: () => root,
      now: () => new Date("2026-07-26T08:00:00.000Z"),
      createOperationId: () => `rename-${operationNumber++}`,
    });

    expect(service.setDisplayName("agent-one", "小乌龟").success).toBe(true);
    expect(service.setDisplayName("agent-one", "小鱼儿")).toMatchObject({
      success: true,
      identity: { displayName: "小鱼儿", revision: 2 },
    });

    const soul = readFileSync(join(root, "SOUL.md"), "utf8");
    expect(soul.match(/AERA:AGENT_IDENTITY:BEGIN/g)).toHaveLength(1);
    expect(soul.match(/AERA:AGENT_IDENTITY:END/g)).toHaveLength(1);
    expect(soul).toContain("Your name is \u201c小鱼儿\u201d.");
    expect(soul).not.toContain("Your name is \u201c小乌龟\u201d.");
    expect(soul).toContain("Keep this persona.");
  });

  it("fails closed when SOUL contains duplicate managed identity markers", () => {
    const root = profileRoot();
    const corruptSoul = [
      "<!-- AERA:AGENT_IDENTITY:BEGIN -->",
      "first",
      "<!-- AERA:AGENT_IDENTITY:END -->",
      "<!-- AERA:AGENT_IDENTITY:BEGIN -->",
      "second",
      "<!-- AERA:AGENT_IDENTITY:END -->",
    ].join("\n");
    writeFileSync(join(root, "SOUL.md"), corruptSoul);
    const service = new AgentIdentityService({
      resolveProfilePath: () => root,
    });

    expect(service.setDisplayName("agent-one", "小乌龟")).toEqual({
      success: false,
      error: "Agent identity block is corrupt.",
    });
    expect(readFileSync(join(root, "SOUL.md"), "utf8")).toBe(corruptSoul);
  });

  it.each([
    ["", "Agent name is required."],
    ["x".repeat(81), "Agent name is too long."],
    ["bad\u0085name", "Agent name contains control text."],
    [
      "<!-- AERA:AGENT_IDENTITY:BEGIN -->",
      "Agent name contains reserved text.",
    ],
  ])("rejects an unsafe display name", (displayName, error) => {
    const root = profileRoot();
    writeFileSync(join(root, "SOUL.md"), "Original persona.\n");
    const service = new AgentIdentityService({
      resolveProfilePath: () => root,
    });

    expect(service.setDisplayName("agent-one", displayName)).toEqual({
      success: false,
      error,
    });
    expect(readFileSync(join(root, "SOUL.md"), "utf8")).toBe(
      "Original persona.\n",
    );
  });

  it("rolls back every identity file when one transactional write fails", () => {
    const root = profileRoot();
    const originalMeta = `${JSON.stringify({ name: "Old", color: "#123456" }, null, 2)}\n`;
    const originalSoul = "Original persona.\n";
    writeFileSync(join(root, "profile-meta.json"), originalMeta);
    writeFileSync(join(root, "SOUL.md"), originalSoul);
    let failSoulOnce = true;
    const service = new AgentIdentityService({
      resolveProfilePath: () => root,
      createOperationId: () => "018f0000-0000-7000-8000-000000000003",
      writeFile: (path, content, mode) => {
        if (path === join(root, "SOUL.md") && failSoulOnce) {
          failSoulOnce = false;
          throw new Error("simulated SOUL write failure");
        }
        safeWriteFile(path, content, mode);
      },
    });

    expect(service.setDisplayName("agent-one", "小乌龟")).toEqual({
      success: false,
      error: "simulated SOUL write failure",
    });
    expect(readFileSync(join(root, "profile-meta.json"), "utf8")).toBe(
      originalMeta,
    );
    expect(readFileSync(join(root, "SOUL.md"), "utf8")).toBe(originalSoul);
    expect(existsSync(join(root, ".agentera", "identity-state.json"))).toBe(
      false,
    );
  });

  it("creates a private backup and can undo the latest rename as a new revision", () => {
    const root = profileRoot();
    writeFileSync(
      join(root, "profile-meta.json"),
      `${JSON.stringify({ name: "Old Agent", color: "#123456" }, null, 2)}\n`,
    );
    writeFileSync(join(root, "SOUL.md"), "Original persona.\n");
    const operationIds = ["rename-operation", "undo-operation"];
    const service = new AgentIdentityService({
      resolveProfilePath: () => root,
      now: () => new Date("2026-07-26T08:00:00.000Z"),
      createOperationId: () => operationIds.shift()!,
    });

    expect(service.setDisplayName("agent-one", "小乌龟")).toMatchObject({
      success: true,
      operationId: "rename-operation",
      identity: { revision: 1 },
    });
    const backupPath = join(
      root,
      ".agentera",
      "identity-backups",
      "rename-operation.json",
    );
    expect(existsSync(backupPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    }

    expect(
      service.undoDisplayName("agent-one", "rename-operation"),
    ).toMatchObject({
      success: true,
      operationId: "undo-operation",
      identity: { displayName: "Old Agent", revision: 2 },
    });
    expect(
      JSON.parse(readFileSync(join(root, "profile-meta.json"), "utf8")),
    ).toEqual({ name: "Old Agent", color: "#123456" });
    const soul = readFileSync(join(root, "SOUL.md"), "utf8");
    expect(soul).toBe("Original persona.\n");
    expect(soul).not.toContain("小乌龟");
    expect(
      JSON.parse(
        readFileSync(join(root, ".agentera", "identity-state.json"), "utf8"),
      ),
    ).toMatchObject({ revision: 2, displayName: "Old Agent" });
  });

  it("invalidates stale Hermes sessions and records the revision of new ones", () => {
    const root = profileRoot();
    let operationNumber = 1;
    const service = new AgentIdentityService({
      resolveProfilePath: () => root,
      now: () => new Date("2026-07-26T08:00:00.000Z"),
      createOperationId: () => `session-rename-${operationNumber++}`,
    });

    expect(service.resolveResumeSessionId("agent-one", "legacy-session")).toBe(
      "legacy-session",
    );
    expect(service.scopeConversationKey("agent-one", "chat-run")).toBe(
      "chat-run",
    );
    expect(service.setDisplayName("agent-one", "小乌龟").success).toBe(true);
    expect(service.scopeConversationKey("agent-one", "chat-run")).toBe(
      "chat-run::aera-agent-identity:1",
    );
    expect(
      service.resolveResumeSessionId("agent-one", "legacy-session"),
    ).toBeUndefined();

    expect(service.recordSessionRevision("agent-one", "fresh-session")).toEqual(
      { success: true },
    );
    expect(service.resolveResumeSessionId("agent-one", "fresh-session")).toBe(
      "fresh-session",
    );

    expect(service.setDisplayName("agent-one", "小鱼儿").success).toBe(true);
    expect(service.scopeConversationKey("agent-one", "chat-run")).toBe(
      "chat-run::aera-agent-identity:2",
    );
    expect(
      service.resolveResumeSessionId("agent-one", "fresh-session"),
    ).toBeUndefined();
  });

  it("keeps identity, SOUL, and session revisions isolated by Profile", () => {
    const first = profileRoot();
    const second = profileRoot();
    const rootsByProfile = new Map([
      ["agent-one", first],
      ["agent-two", second],
    ]);
    let operationNumber = 1;
    const service = new AgentIdentityService({
      resolveProfilePath: (profileId) => rootsByProfile.get(profileId)!,
      createOperationId: () => `isolated-${operationNumber++}`,
    });

    expect(service.setDisplayName("agent-one", "小乌龟").success).toBe(true);
    expect(service.setDisplayName("agent-two", "小鱼儿").success).toBe(true);
    expect(service.recordSessionRevision("agent-one", "one-session")).toEqual({
      success: true,
    });

    expect(readFileSync(join(first, "SOUL.md"), "utf8")).toContain("小乌龟");
    expect(readFileSync(join(second, "SOUL.md"), "utf8")).toContain("小鱼儿");
    expect(service.resolveResumeSessionId("agent-one", "one-session")).toBe(
      "one-session",
    );
    expect(
      service.resolveResumeSessionId("agent-two", "one-session"),
    ).toBeUndefined();
  });
});
