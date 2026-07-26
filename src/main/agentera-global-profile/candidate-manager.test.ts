import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { safeWriteFile } from "../utils";
import { AgenteraMemoryCandidateManager } from "./candidate-manager";

const USER_ONE = "11111111-1111-4111-8111-111111111111";
const USER_TWO = "22222222-2222-4222-8222-222222222222";
const BATCH_ID = "33333333-3333-4333-8333-333333333333";

describe("AgenteraMemoryCandidateManager", () => {
  it("stores only a structured one-click batch in the authenticated account partition", () => {
    const root = mkdtempSync(join(tmpdir(), "aera-memory-candidate-"));
    const writes: Array<{ path: string; content: string; mode?: number }> = [];
    const manager = new AgenteraMemoryCandidateManager({
      userDataPath: root,
      now: () => new Date("2026-07-26T01:00:00.000Z"),
      createBatchId: () => BATCH_ID,
      writeFile: (path, content, mode) => {
        writes.push({ path, content, mode });
        safeWriteFile(path, content, mode);
      },
    });
    const raw = "你的名字是星港，以后称呼我为领航员。";

    const result = manager.extract(USER_ONE, raw, "vertical-agent-one");

    expect(result.success).toBe(true);
    if (!result.success || !result.value) throw new Error("missing batch");
    expect(result.value).toMatchObject({
      id: BATCH_ID,
      decision: "pending",
      proposals: [
        { kind: "agent_identity", proposedDisplayName: "星港" },
        { kind: "global_profile", proposedValue: "领航员" },
      ],
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toContain(
      join(USER_ONE, "candidates", `${BATCH_ID}.json`),
    );
    expect(writes[0].mode).toBe(0o600);
    expect(writes[0].content).not.toContain(raw);
    expect(writes[0].content).not.toContain("rawText");
    expect(writes[0].content).not.toContain("transcript");
  });

  it("deduplicates an identical pending proposal and keeps account partitions isolated", () => {
    const root = mkdtempSync(join(tmpdir(), "aera-memory-candidate-"));
    const manager = new AgenteraMemoryCandidateManager({
      userDataPath: root,
      createBatchId: () => BATCH_ID,
    });
    const first = manager.extract(
      USER_ONE,
      "请称呼我为设计师。",
      "vertical-agent-one",
    );
    const second = manager.extract(
      USER_ONE,
      "请称呼我为设计师。",
      "vertical-agent-one",
    );

    expect(first.success && first.value?.id).toBe(BATCH_ID);
    expect(second.success && second.value?.id).toBe(BATCH_ID);
    const otherAccount = manager.prepareConfirmation(USER_TWO, BATCH_ID);
    expect(otherAccount).toEqual({
      success: false,
      error: "Memory candidate batch was not found.",
    });
  });

  it("rejects or confirms a pending batch exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "aera-memory-candidate-"));
    const ids = [BATCH_ID, "44444444-4444-4444-8444-444444444444"];
    const manager = new AgenteraMemoryCandidateManager({
      userDataPath: root,
      createBatchId: () => ids.shift()!,
    });
    const first = manager.extract(
      USER_ONE,
      "你的名字是远山。",
      "vertical-agent-one",
    );
    if (!first.success || !first.value) throw new Error("missing batch");

    expect(manager.prepareConfirmation(USER_ONE, first.value.id).success).toBe(
      true,
    );
    expect(
      manager.completeConfirmation(USER_ONE, first.value.id),
    ).toMatchObject({ success: true, value: { decision: "confirmed" } });
    expect(manager.prepareConfirmation(USER_ONE, first.value.id)).toEqual({
      success: false,
      error: "Memory candidate batch is no longer pending.",
    });

    const second = manager.extract(
      USER_ONE,
      "以后称呼我为策展人。",
      "vertical-agent-one",
    );
    if (!second.success || !second.value) throw new Error("missing batch");
    expect(manager.reject(USER_ONE, second.value.id)).toMatchObject({
      success: true,
      value: { decision: "rejected" },
    });
    expect(manager.reject(USER_ONE, second.value.id)).toEqual({
      success: false,
      error: "Memory candidate batch is no longer pending.",
    });
  });

  it("expires pending batches without returning their proposals", () => {
    const root = mkdtempSync(join(tmpdir(), "aera-memory-candidate-"));
    let now = new Date("2026-07-01T00:00:00.000Z");
    const manager = new AgenteraMemoryCandidateManager({
      userDataPath: root,
      now: () => now,
      createBatchId: () => BATCH_ID,
    });
    const created = manager.extract(
      USER_ONE,
      "以后称呼我为编审。",
      "vertical-agent-one",
    );
    if (!created.success || !created.value) throw new Error("missing batch");
    const path = join(
      root,
      "agentera-global-profile",
      USER_ONE,
      "candidates",
      `${BATCH_ID}.json`,
    );
    expect(existsSync(path)).toBe(true);

    now = new Date("2026-08-02T00:00:00.000Z");
    expect(manager.prepareConfirmation(USER_ONE, BATCH_ID)).toEqual({
      success: false,
      error: "Memory candidate batch has expired.",
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      decision: "expired",
    });
  });

  it("returns no batch and performs no write when chat has no explicit candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "aera-memory-candidate-"));
    const writeFile = vi.fn();
    const manager = new AgenteraMemoryCandidateManager({
      userDataPath: root,
      writeFile,
    });

    expect(
      manager.extract(USER_ONE, "请检查一下构建结果。", "vertical-agent-one"),
    ).toEqual({ success: true, value: null });
    expect(writeFile).not.toHaveBeenCalled();
  });
});
