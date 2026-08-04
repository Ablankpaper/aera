import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type StreamIntegrityMode = "idle" | "legacy" | "sequenced";

export type StreamIntegrityDegradedCode =
  | "stream_gap"
  | "stream_conflict"
  | "stream_stale"
  | "stream_final_seq"
  | "stream_digest_mismatch"
  | "stream_missing_text";

export type StreamIntegrityDecision =
  | { kind: "apply"; text: string }
  | { kind: "duplicate" }
  | { kind: "degraded"; code: StreamIntegrityDegradedCode }
  | { kind: "complete"; text: string; repaired: boolean };

export type StreamIntegrityBeginDecision =
  | { mode: "legacy" }
  | { mode: "sequenced"; streamId: string }
  | { kind: "degraded"; code: "stream_conflict" };

interface StreamState {
  streamId: string;
  expectedSeq: number;
  chunks: Map<number, string>;
  degraded: boolean;
  degradedCode: "stream_gap" | "stream_conflict" | null;
  highestSeenSeq: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sequence(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function textSha256(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

/**
 * Tracks only the additive Runtime assistant-text envelope. Conversation text
 * remains owned by the existing dashboard adapter and is never logged here.
 */
export class StreamIntegrityTracker {
  private currentMode: StreamIntegrityMode = "idle";
  private state: StreamState | null = null;

  get mode(): StreamIntegrityMode {
    return this.currentMode;
  }

  reset(): void {
    this.currentMode = "idle";
    this.state = null;
  }

  begin(payload: unknown): StreamIntegrityBeginDecision {
    const row = asRecord(payload);
    const advertisesSequencing = Object.prototype.hasOwnProperty.call(
      row,
      "stream_id",
    );
    const streamId = nonEmptyString(row.stream_id);

    if (!advertisesSequencing) {
      if (this.currentMode === "sequenced") {
        return { kind: "degraded", code: "stream_conflict" };
      }
      this.currentMode = "legacy";
      this.state = null;
      return { mode: "legacy" };
    }
    if (!streamId) {
      this.currentMode = "sequenced";
      this.state = null;
      return { kind: "degraded", code: "stream_conflict" };
    }

    const startSeq = sequence(row.seq);
    this.currentMode = "sequenced";
    this.state = {
      streamId,
      expectedSeq: 1,
      chunks: new Map(),
      degraded: startSeq !== 0,
      degradedCode: startSeq === 0 ? null : "stream_conflict",
      highestSeenSeq: 0,
    };
    if (startSeq !== 0) {
      return { kind: "degraded", code: "stream_conflict" };
    }
    return { mode: "sequenced", streamId };
  }

  delta(payload: unknown): StreamIntegrityDecision {
    const state = this.state;
    if (this.currentMode !== "sequenced" || !state) {
      return { kind: "degraded", code: "stream_stale" };
    }

    const row = asRecord(payload);
    if (nonEmptyString(row.stream_id) !== state.streamId) {
      return { kind: "degraded", code: "stream_stale" };
    }

    const seq = sequence(row.seq);
    const text = typeof row.text === "string" ? row.text : null;
    if (seq === null || seq === 0 || text === null) {
      state.degraded = true;
      state.degradedCode = "stream_conflict";
      return { kind: "degraded", code: "stream_conflict" };
    }

    const existing = state.chunks.get(seq);
    if (existing !== undefined) {
      if (existing === text) return { kind: "duplicate" };
      state.degraded = true;
      state.degradedCode = "stream_conflict";
      return { kind: "degraded", code: "stream_conflict" };
    }

    state.chunks.set(seq, text);
    state.highestSeenSeq = Math.max(state.highestSeenSeq, seq);

    if (state.degraded) {
      return {
        kind: "degraded",
        code: state.degradedCode ?? "stream_gap",
      };
    }
    if (seq !== state.expectedSeq) {
      state.degraded = true;
      state.degradedCode = "stream_gap";
      return { kind: "degraded", code: "stream_gap" };
    }

    state.expectedSeq += 1;
    return { kind: "apply", text };
  }

  complete(payload: unknown): StreamIntegrityDecision {
    const state = this.state;
    if (this.currentMode !== "sequenced" || !state) {
      return { kind: "degraded", code: "stream_stale" };
    }

    const row = asRecord(payload);
    if (nonEmptyString(row.stream_id) !== state.streamId) {
      return { kind: "degraded", code: "stream_stale" };
    }

    const finalSeq = sequence(row.final_seq);
    if (finalSeq === null || finalSeq < state.highestSeenSeq) {
      return { kind: "degraded", code: "stream_final_seq" };
    }
    if (typeof row.text !== "string") {
      return { kind: "degraded", code: "stream_missing_text" };
    }

    const digest = nonEmptyString(row.text_sha256);
    if (!digest || digest !== textSha256(row.text)) {
      return { kind: "degraded", code: "stream_digest_mismatch" };
    }

    let streamedText = "";
    for (let seq = 1; seq < state.expectedSeq; seq += 1) {
      streamedText += state.chunks.get(seq) ?? "";
    }
    const repaired =
      state.degraded ||
      finalSeq !== state.expectedSeq - 1 ||
      streamedText !== row.text;
    const text = row.text;
    this.reset();
    return { kind: "complete", text, repaired };
  }
}
