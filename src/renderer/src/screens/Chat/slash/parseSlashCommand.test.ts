import { describe, expect, it } from "vitest";
import { isSlashCommandInput, parseSlashCommand } from "./parseSlashCommand";

describe("parseSlashCommand", () => {
  it("parses valid command with arguments", () => {
    const res = parseSlashCommand("  /model  gpt-4o  ");
    expect(res).toEqual({
      ok: true,
      command: {
        rawInput: "  /model  gpt-4o  ",
        name: "model",
        normalizedName: "model",
        args: "gpt-4o",
      },
    });
  });

  it("parses valid command without arguments", () => {
    const res = parseSlashCommand("/status");
    expect(res).toEqual({
      ok: true,
      command: {
        rawInput: "/status",
        name: "status",
        normalizedName: "status",
        args: "",
      },
    });
  });

  it("normalizes uppercase command name", () => {
    const res = parseSlashCommand("/COMPress here");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.command.name).toBe("COMPress");
      expect(res.command.normalizedName).toBe("compress");
      expect(res.command.args).toBe("here");
    }
  });

  it("preserves argument case and internal whitespace", () => {
    const res = parseSlashCommand(
      "/explain   Const Foo = 'BAR'  \n next line ",
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.command.args).toBe("Const Foo = 'BAR'  \n next line");
    }
  });

  it("rejects non-slash input", () => {
    const res = parseSlashCommand("hello world");
    expect(res.ok).toBe(false);
  });

  it("rejects empty slash", () => {
    expect(parseSlashCommand("/").ok).toBe(false);
    expect(parseSlashCommand("   /   ").ok).toBe(false);
  });
});

describe("isSlashCommandInput", () => {
  it("keeps commands and command typos on the slash route", () => {
    expect(isSlashCommandInput("/status")).toBe(true);
    expect(isSlashCommandInput("  /model gpt-5.6-sol")).toBe(true);
    expect(isSlashCommandInput("/unknown-command details")).toBe(true);
  });

  it("treats a pasted POSIX path as ordinary prompt text", () => {
    expect(
      isSlashCommandInput("/Volumes/obs/claw-mem 这里面是我训练的 agents 集群"),
    ).toBe(false);
    expect(isSlashCommandInput("  /Users/test/project 请分析")).toBe(false);
  });
});
