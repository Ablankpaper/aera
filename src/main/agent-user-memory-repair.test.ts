import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentUserMemoryRepairService } from "./agent-user-memory-repair";

describe("AgentUserMemoryRepairService", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function profileRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "aera-user-memory-repair-"));
    roots.push(root);
    return root;
  }

  function writeUser(root: string, content: string): void {
    const path = join(root, "memories", "USER.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  // @lat: [[chat-commands#Central command router#Desktop commands]]
  it("previews the current Agent USER.md without changing it", () => {
    const root = profileRoot();
    const content = "User preference. Agent identity was mixed in here.";
    writeUser(root, content);
    const service = new AgentUserMemoryRepairService({
      resolveProfilePath: () => root,
    });

    const result = service.preview("agent-one");

    expect(result).toMatchObject({
      success: true,
      preview: {
        profileId: "agent-one",
        exists: true,
        content,
        charCount: content.length,
      },
    });
    if (!result.success) throw new Error(result.error);
    expect(result.preview.currentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(root, "memories", "USER.md"), "utf8")).toBe(
      content,
    );
    expect(existsSync(join(root, ".agentera", "user-memory-repairs"))).toBe(
      false,
    );
  });

  it("requires confirmation, checks the preview hash, and creates a private backup", () => {
    const root = profileRoot();
    const original = "Keep this user preference. Remove Agent identity.";
    const replacement = "Keep this user preference.";
    writeUser(root, original);
    const service = new AgentUserMemoryRepairService({
      resolveProfilePath: () => root,
      now: () => new Date("2026-07-26T08:00:00.000Z"),
      createOperationId: () => "repair-operation",
    });
    const preview = service.preview("agent-one");
    if (!preview.success) throw new Error(preview.error);

    expect(
      service.apply({
        profileId: "agent-one",
        expectedSha256: preview.preview.currentSha256,
        replacementContent: replacement,
        confirmed: false,
      }),
    ).toEqual({
      success: false,
      error: "User confirmation is required for USER.md repair.",
    });
    writeUser(root, `${original}\nconcurrent change`);
    expect(
      service.apply({
        profileId: "agent-one",
        expectedSha256: preview.preview.currentSha256,
        replacementContent: replacement,
        confirmed: true,
      }),
    ).toEqual({
      success: false,
      error: "USER.md changed after the preview. Review it again.",
    });

    writeUser(root, original);
    const applied = service.apply({
      profileId: "agent-one",
      expectedSha256: preview.preview.currentSha256,
      replacementContent: replacement,
      confirmed: true,
    });
    expect(applied).toMatchObject({
      success: true,
      operationId: "repair-operation",
      profileId: "agent-one",
    });
    expect(readFileSync(join(root, "memories", "USER.md"), "utf8")).toBe(
      replacement,
    );
    const backupPath = join(
      root,
      ".agentera",
      "user-memory-repairs",
      "repair-operation.json",
    );
    expect(existsSync(backupPath)).toBe(true);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
  });

  it("undoes only an unchanged repair and restores the exact original bytes", () => {
    const root = profileRoot();
    const original = "Original USER.md with trailing newline.\n";
    writeUser(root, original);
    const service = new AgentUserMemoryRepairService({
      resolveProfilePath: () => root,
      createOperationId: () => "repair-operation",
    });
    const preview = service.preview("agent-one");
    if (!preview.success) throw new Error(preview.error);
    const applied = service.apply({
      profileId: "agent-one",
      expectedSha256: preview.preview.currentSha256,
      replacementContent: "Original USER.md.",
      confirmed: true,
    });
    if (!applied.success) throw new Error(applied.error);

    expect(service.undo("agent-one", applied.operationId)).toEqual({
      success: true,
      profileId: "agent-one",
    });
    expect(readFileSync(join(root, "memories", "USER.md"), "utf8")).toBe(
      original,
    );
    expect(service.undo("agent-one", applied.operationId)).toEqual({
      success: false,
      error: "USER.md changed after this repair. It cannot be safely undone.",
    });
  });
});
