import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
  AgenteraMemoryCandidateBatch,
  AgenteraMemoryCandidateDecision,
  AgenteraMemoryCandidateProposal,
  AgenteraMemoryCandidateResult,
} from "../../shared/agentera-memory-candidate";
import { isValidProfileName, safeWriteFile } from "../utils";
import { extractExplicitMemoryCandidates } from "./classifier";

const BATCH_SCHEMA = "agentera-memory-candidate-batch" as const;
const BATCH_VERSION = 1 as const;
const CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const USER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StoredCandidateBatch extends AgenteraMemoryCandidateBatch {
  schema: typeof BATCH_SCHEMA;
  version: typeof BATCH_VERSION;
  fingerprint: string;
}

export interface AgenteraMemoryCandidateManagerOptions {
  userDataPath: string;
  now?: () => Date;
  createBatchId?: () => string;
  writeFile?: (path: string, content: string, mode?: number) => void;
}

export class AgenteraMemoryCandidateManager {
  readonly rootPath: string;
  private readonly now: () => Date;
  private readonly createBatchId: () => string;
  private readonly writeFile: (
    path: string,
    content: string,
    mode?: number,
  ) => void;

  constructor(options: AgenteraMemoryCandidateManagerOptions) {
    if (!isAbsolute(options.userDataPath)) {
      throw new Error("Aera candidate userData path must be absolute.");
    }
    this.rootPath = join(
      resolve(options.userDataPath),
      "agentera-global-profile",
    );
    this.now = options.now ?? (() => new Date());
    this.createBatchId = options.createBatchId ?? randomUUID;
    this.writeFile = options.writeFile ?? safeWriteFile;
  }

  extract(
    userId: string,
    rawText: unknown,
    profileId: unknown,
  ): AgenteraMemoryCandidateResult<AgenteraMemoryCandidateBatch | null> {
    try {
      const normalizedUserId = normalizeUserId(userId);
      const proposals = extractExplicitMemoryCandidates(rawText, profileId);
      if (proposals.length === 0) return { success: true, value: null };
      const fingerprint = proposalFingerprint(proposals);
      const existing = this.findPendingByFingerprint(
        normalizedUserId,
        fingerprint,
      );
      if (existing) return { success: true, value: publicBatch(existing) };

      const id = normalizeBatchId(this.createBatchId());
      const now = this.validNow();
      const stored: StoredCandidateBatch = {
        schema: BATCH_SCHEMA,
        version: BATCH_VERSION,
        id,
        fingerprint,
        decision: "pending",
        proposals: cloneProposals(proposals),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + CANDIDATE_TTL_MS).toISOString(),
      };
      this.writeFile(
        this.batchPath(normalizedUserId, id),
        serializeJson(stored),
        0o600,
      );
      return { success: true, value: publicBatch(stored) };
    } catch (error) {
      return failure(error);
    }
  }

  prepareConfirmation(
    userId: string,
    batchId: string,
  ): AgenteraMemoryCandidateResult<AgenteraMemoryCandidateBatch> {
    try {
      const normalizedUserId = normalizeUserId(userId);
      const stored = this.readBatch(normalizedUserId, batchId);
      const current = this.expireIfNeeded(normalizedUserId, stored);
      if (current.decision === "expired") {
        throw new Error("Memory candidate batch has expired.");
      }
      if (current.decision !== "pending") {
        throw new Error("Memory candidate batch is no longer pending.");
      }
      return { success: true, value: publicBatch(current) };
    } catch (error) {
      return failure(error);
    }
  }

  completeConfirmation(
    userId: string,
    batchId: string,
  ): AgenteraMemoryCandidateResult<AgenteraMemoryCandidateBatch> {
    return this.transition(userId, batchId, "confirmed");
  }

  reject(
    userId: string,
    batchId: string,
  ): AgenteraMemoryCandidateResult<AgenteraMemoryCandidateBatch> {
    return this.transition(userId, batchId, "rejected");
  }

  private transition(
    userId: string,
    batchId: string,
    decision: Extract<
      AgenteraMemoryCandidateDecision,
      "confirmed" | "rejected"
    >,
  ): AgenteraMemoryCandidateResult<AgenteraMemoryCandidateBatch> {
    const prepared = this.prepareConfirmation(userId, batchId);
    if (!prepared.success) return prepared;
    try {
      const normalizedUserId = normalizeUserId(userId);
      const stored = this.readBatch(normalizedUserId, batchId);
      const next: StoredCandidateBatch = { ...stored, decision };
      this.writeFile(
        this.batchPath(normalizedUserId, stored.id),
        serializeJson(next),
        0o600,
      );
      return { success: true, value: publicBatch(next) };
    } catch (error) {
      return failure(error);
    }
  }

  private findPendingByFingerprint(
    userId: string,
    fingerprint: string,
  ): StoredCandidateBatch | null {
    const directory = this.candidatesDirectory(userId);
    if (!existsSync(directory)) return null;
    for (const name of readdirSync(directory).sort()) {
      if (
        !UUID_RE.test(name.replace(/\.json$/u, "")) ||
        !name.endsWith(".json")
      ) {
        continue;
      }
      const stored = readStoredBatch(join(directory, name));
      const current = this.expireIfNeeded(userId, stored);
      if (
        current.decision === "pending" &&
        current.fingerprint === fingerprint
      ) {
        return current;
      }
    }
    return null;
  }

  private expireIfNeeded(
    userId: string,
    stored: StoredCandidateBatch,
  ): StoredCandidateBatch {
    if (
      stored.decision !== "pending" ||
      this.validNow().getTime() <= Date.parse(stored.expiresAt)
    ) {
      return stored;
    }
    const expired: StoredCandidateBatch = { ...stored, decision: "expired" };
    this.writeFile(
      this.batchPath(userId, stored.id),
      serializeJson(expired),
      0o600,
    );
    return expired;
  }

  private readBatch(userId: string, rawBatchId: string): StoredCandidateBatch {
    const batchId = normalizeBatchId(rawBatchId);
    const path = this.batchPath(userId, batchId);
    if (!existsSync(path)) {
      throw new Error("Memory candidate batch was not found.");
    }
    return readStoredBatch(path);
  }

  private candidatesDirectory(userId: string): string {
    return join(this.rootPath, userId, "candidates");
  }

  private batchPath(userId: string, batchId: string): string {
    return join(this.candidatesDirectory(userId), `${batchId}.json`);
  }

  private validNow(): Date {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("Aera candidate clock is invalid.");
    }
    return value;
  }
}

function readStoredBatch(path: string): StoredCandidateBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Memory candidate batch is corrupt.");
  }
  if (!isRecord(parsed)) throw new Error("Memory candidate batch is corrupt.");
  const allowedKeys = new Set([
    "schema",
    "version",
    "id",
    "fingerprint",
    "decision",
    "proposals",
    "createdAt",
    "expiresAt",
  ]);
  if (Object.keys(parsed).some((key) => !allowedKeys.has(key))) {
    throw new Error("Memory candidate batch is corrupt.");
  }
  const proposals = validateProposals(parsed.proposals);
  if (
    parsed.schema !== BATCH_SCHEMA ||
    parsed.version !== BATCH_VERSION ||
    typeof parsed.id !== "string" ||
    normalizeBatchId(parsed.id) !== parsed.id ||
    typeof parsed.fingerprint !== "string" ||
    parsed.fingerprint !== proposalFingerprint(proposals) ||
    !isDecision(parsed.decision) ||
    typeof parsed.createdAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.createdAt)) ||
    typeof parsed.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.expiresAt)) ||
    Date.parse(parsed.expiresAt) <= Date.parse(parsed.createdAt)
  ) {
    throw new Error("Memory candidate batch is corrupt.");
  }
  return {
    schema: BATCH_SCHEMA,
    version: BATCH_VERSION,
    id: parsed.id,
    fingerprint: parsed.fingerprint,
    decision: parsed.decision,
    proposals,
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
  };
}

function validateProposals(value: unknown): AgenteraMemoryCandidateProposal[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw new Error("Memory candidate batch is corrupt.");
  }
  return value.map((raw) => {
    if (!isRecord(raw) || !isValidProfileName(raw.profileId as string)) {
      throw new Error("Memory candidate batch is corrupt.");
    }
    if (
      typeof raw.summary !== "string" ||
      !raw.summary ||
      raw.summary.length > 240 ||
      raw.confidence !== 1
    ) {
      throw new Error("Memory candidate batch is corrupt.");
    }
    if (raw.kind === "agent_identity") {
      if (!isBoundedText(raw.proposedDisplayName)) {
        throw new Error("Memory candidate batch is corrupt.");
      }
      return {
        kind: "agent_identity",
        profileId: raw.profileId as string,
        proposedDisplayName: raw.proposedDisplayName as string,
        summary: raw.summary,
        confidence: 1,
      };
    }
    if (raw.kind === "global_profile" && isRecord(raw.entry)) {
      if (
        !isBoundedText(raw.proposedValue) ||
        raw.entry.id !== "communication_style.preferred_address" ||
        raw.entry.category !== "communication_style" ||
        typeof raw.entry.content !== "string" ||
        raw.entry.content.length > 400
      ) {
        throw new Error("Memory candidate batch is corrupt.");
      }
      return {
        kind: "global_profile",
        profileId: raw.profileId as string,
        proposedValue: raw.proposedValue as string,
        entry: {
          id: raw.entry.id,
          category: raw.entry.category,
          content: raw.entry.content,
        },
        summary: raw.summary,
        confidence: 1,
      };
    }
    throw new Error("Memory candidate batch is corrupt.");
  });
}

function publicBatch(
  stored: StoredCandidateBatch,
): AgenteraMemoryCandidateBatch {
  return {
    id: stored.id,
    decision: stored.decision,
    proposals: cloneProposals(stored.proposals),
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
  };
}

function cloneProposals(
  proposals: ReadonlyArray<AgenteraMemoryCandidateProposal>,
): AgenteraMemoryCandidateProposal[] {
  return proposals.map((proposal) =>
    proposal.kind === "global_profile"
      ? { ...proposal, entry: { ...proposal.entry } }
      : { ...proposal },
  );
}

function proposalFingerprint(
  proposals: ReadonlyArray<AgenteraMemoryCandidateProposal>,
): string {
  return createHash("sha256").update(JSON.stringify(proposals)).digest("hex");
}

function normalizeUserId(value: unknown): string {
  if (typeof value !== "string" || !USER_ID_RE.test(value)) {
    throw new Error("Aera memory candidate owner is invalid.");
  }
  return value.toLowerCase();
}

function normalizeBatchId(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error("Memory candidate batch id is invalid.");
  }
  return value.toLowerCase();
}

function isDecision(value: unknown): value is AgenteraMemoryCandidateDecision {
  return (
    value === "pending" ||
    value === "confirmed" ||
    value === "rejected" ||
    value === "expired"
  );
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    Array.from(value).length <= 40 &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function failure(error: unknown): { success: false; error: string } {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
