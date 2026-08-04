// @vitest-environment node
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { StreamIntegrityTracker } from "./streamIntegrity";

const STREAM_A = "019fcf5b-7cd2-7cc7-8f91-6f86d252b293";
const STREAM_B = "019fcf5b-a3f4-70cb-8984-29b2509770fc";

function digest(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

function start(tracker: StreamIntegrityTracker, streamId = STREAM_A): void {
  expect(tracker.begin({ stream_id: streamId, seq: 0 })).toEqual({
    mode: "sequenced",
    streamId,
  });
}

describe("StreamIntegrityTracker", () => {
  it("applies ordered chunks using their sequence instead of substring matching", () => {
    const tracker = new StreamIntegrityTracker();
    start(tracker);

    expect(
      tracker.delta({ stream_id: STREAM_A, seq: 1, text: "重复" }),
    ).toEqual({ kind: "apply", text: "重复" });
    expect(
      tracker.delta({ stream_id: STREAM_A, seq: 2, text: "重复" }),
    ).toEqual({ kind: "apply", text: "重复" });
  });

  it("ignores an exact duplicate sequence and text", () => {
    const tracker = new StreamIntegrityTracker();
    start(tracker);
    tracker.delta({ stream_id: STREAM_A, seq: 1, text: "企业" });

    expect(
      tracker.delta({ stream_id: STREAM_A, seq: 1, text: "企业" }),
    ).toEqual({ kind: "duplicate" });
  });

  it("degrades on a conflicting duplicate", () => {
    const tracker = new StreamIntegrityTracker();
    start(tracker);
    tracker.delta({ stream_id: STREAM_A, seq: 1, text: "企业" });

    expect(
      tracker.delta({ stream_id: STREAM_A, seq: 1, text: "企丢" }),
    ).toEqual({ kind: "degraded", code: "stream_conflict" });
  });

  it("degrades on a sequence gap and stops applying later deltas", () => {
    const tracker = new StreamIntegrityTracker();
    start(tracker);

    expect(
      tracker.delta({ stream_id: STREAM_A, seq: 2, text: "第二段" }),
    ).toEqual({ kind: "degraded", code: "stream_gap" });
    expect(
      tracker.delta({ stream_id: STREAM_A, seq: 3, text: "第三段" }),
    ).toEqual({ kind: "degraded", code: "stream_gap" });
  });

  it("rejects a stale stream without poisoning the current stream", () => {
    const tracker = new StreamIntegrityTracker();
    start(tracker, STREAM_A);
    start(tracker, STREAM_B);

    expect(
      tracker.delta({ stream_id: STREAM_A, seq: 1, text: "旧内容" }),
    ).toEqual({ kind: "degraded", code: "stream_stale" });
    expect(
      tracker.delta({ stream_id: STREAM_B, seq: 1, text: "新内容" }),
    ).toEqual({ kind: "apply", text: "新内容" });
  });

  it("rejects an invalid final sequence", () => {
    const tracker = new StreamIntegrityTracker();
    start(tracker);
    tracker.delta({ stream_id: STREAM_A, seq: 1, text: "完整" });

    expect(
      tracker.complete({
        stream_id: STREAM_A,
        final_seq: 0,
        text: "完整",
        text_sha256: digest("完整"),
      }),
    ).toEqual({ kind: "degraded", code: "stream_final_seq" });
  });

  it("rejects a final-text digest mismatch", () => {
    const tracker = new StreamIntegrityTracker();
    start(tracker);
    tracker.delta({ stream_id: STREAM_A, seq: 1, text: "完整" });

    expect(
      tracker.complete({
        stream_id: STREAM_A,
        final_seq: 1,
        text: "完整",
        text_sha256: digest("被篡改"),
      }),
    ).toEqual({ kind: "degraded", code: "stream_digest_mismatch" });
  });

  it("preserves Chinese, combining marks, and emoji across one-character chunks", () => {
    const tracker = new StreamIntegrityTracker();
    const text = "企业智能体会持续学习，e\u0301 不会缺字。👨‍👩‍👧‍👦";
    start(tracker);

    let rebuilt = "";
    Array.from(text).forEach((chunk, index) => {
      const decision = tracker.delta({
        stream_id: STREAM_A,
        seq: index + 1,
        text: chunk,
      });
      expect(decision).toEqual({ kind: "apply", text: chunk });
      if (decision.kind === "apply") rebuilt += decision.text;
    });

    expect(rebuilt).toBe(text);
  });

  it("repairs a live gap from an authoritative valid completion", () => {
    const tracker = new StreamIntegrityTracker();
    const finalText = "第一段第二段第三段。重复短语，重复短语。🙂";
    start(tracker);
    tracker.delta({ stream_id: STREAM_A, seq: 1, text: "第一段" });
    tracker.delta({ stream_id: STREAM_A, seq: 3, text: "第三段。" });

    expect(
      tracker.complete({
        stream_id: STREAM_A,
        final_seq: 3,
        text: finalText,
        text_sha256: digest(finalText),
      }),
    ).toEqual({ kind: "complete", text: finalText, repaired: true });
  });

  it("repairs a missing tail delta when final sequence advances past the highest seen sequence", () => {
    const tracker = new StreamIntegrityTracker();
    const finalText = "第一段第二段";
    start(tracker);
    tracker.delta({ stream_id: STREAM_A, seq: 1, text: "第一段" });

    expect(
      tracker.complete({
        stream_id: STREAM_A,
        final_seq: 2,
        text: finalText,
        text_sha256: digest(finalText),
      }),
    ).toEqual({ kind: "complete", text: finalText, repaired: true });
  });

  it("keeps a legacy Runtime turn on the legacy reconciliation path", () => {
    const tracker = new StreamIntegrityTracker();

    expect(tracker.begin({})).toEqual({ mode: "legacy" });
    expect(tracker.mode).toBe("legacy");
  });

  it("does not silently downgrade after sequenced mode begins", () => {
    const tracker = new StreamIntegrityTracker();
    start(tracker);

    expect(tracker.begin({})).toEqual({
      kind: "degraded",
      code: "stream_conflict",
    });
    expect(tracker.mode).toBe("sequenced");
    expect(
      tracker.delta({ stream_id: STREAM_A, seq: 1, text: "仍有序" }),
    ).toEqual({ kind: "apply", text: "仍有序" });
    expect(
      tracker.complete({
        final_seq: 1,
        text: "仍有序",
        text_sha256: digest("仍有序"),
      }),
    ).toEqual({ kind: "degraded", code: "stream_stale" });
  });

  it("treats a present but invalid stream id as a broken sequenced advertisement", () => {
    const tracker = new StreamIntegrityTracker();

    expect(tracker.begin({ stream_id: "", seq: 0 })).toEqual({
      kind: "degraded",
      code: "stream_conflict",
    });
    expect(tracker.mode).toBe("sequenced");
  });
});
