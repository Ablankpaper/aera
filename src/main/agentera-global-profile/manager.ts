import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { HermesConversationEnvelope } from "../hermes";
import { safeWriteFile } from "../utils";
import {
  AGENTERA_GLOBAL_PROFILE_CATEGORIES,
  type AgenteraGlobalProfile,
  type AgenteraGlobalProfileCategory,
  type AgenteraGlobalProfileConversationContext,
  type AgenteraGlobalProfileEntry,
  type AgenteraGlobalProfileHistoryItem,
  type AgenteraGlobalProfileResult,
  type SetAgenteraGlobalProfileEntryInput,
} from "../../shared/agentera-global-profile";

const PROFILE_SCHEMA_VERSION = 1 as const;
const SNAPSHOT_SCHEMA = "agentera-global-profile-conversation" as const;
const SNAPSHOT_VERSION = 1 as const;
const AUDIT_SCHEMA = "agentera-global-profile-audit" as const;
const AUDIT_VERSION = 1 as const;
const USER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENTRY_ID_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;
const MAX_ENTRIES = 50;
const MAX_ENTRY_CHARS = 400;
const MAX_RENDERED_CHARS = 8_000;

interface StoredConversationSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  version: typeof SNAPSHOT_VERSION;
  conversationKeySha256: string;
  globalProfileVersion: number;
  renderedSnapshot: string;
  snapshotSha256: string;
  createdAt: string;
}

export interface AgenteraGlobalProfileConversationSnapshot {
  globalProfileVersion: number;
  renderedSnapshot: string;
  snapshotSha256: string;
}

type AgenteraGlobalProfileSnapshotContext = Omit<
  AgenteraGlobalProfileConversationContext,
  "conversationBoundary"
>;

export interface AgenteraGlobalProfileSessionReference {
  profileId: string;
  sessionId: string;
}

interface AuditEvent {
  operationId: string;
  action: "set" | "remove" | "rollback";
  entryId: string | null;
  fromVersion: number;
  toVersion: number;
  createdAt: string;
}

interface StoredAudit {
  schema: typeof AUDIT_SCHEMA;
  version: typeof AUDIT_VERSION;
  events: AuditEvent[];
}

interface FileMutation {
  path: string;
  content: string | null;
}

interface FileSnapshot {
  path: string;
  existed: boolean;
  content: string;
}

interface PersistedProfileMutation {
  operationId: string;
  userId: string;
  before: FileSnapshot[];
  after: FileMutation[];
}

export type AgenteraGlobalProfileCandidateChangeResult =
  | {
      success: true;
      value: AgenteraGlobalProfile;
      rollbackToken: string;
    }
  | { success: false; error: string };

export interface AgenteraGlobalProfileManagerOptions {
  userDataPath: string;
  now?: () => Date;
  createOperationId?: () => string;
  writeFile?: (path: string, content: string, mode?: number) => void;
  removeFile?: (path: string) => void;
}

export class AgenteraGlobalProfileManager {
  readonly rootPath: string;
  private readonly now: () => Date;
  private readonly createOperationId: () => string;
  private readonly writeFile: (
    path: string,
    content: string,
    mode?: number,
  ) => void;
  private readonly removeFile: (path: string) => void;
  private readonly pendingCandidateMutations = new Map<
    string,
    PersistedProfileMutation
  >();

  constructor(options: AgenteraGlobalProfileManagerOptions) {
    if (!isAbsolute(options.userDataPath)) {
      throw new Error(
        "Aera global profile userData path must be absolute.",
      );
    }
    this.rootPath = join(
      resolve(options.userDataPath),
      "agentera-global-profile",
    );
    this.now = options.now ?? (() => new Date());
    this.createOperationId = options.createOperationId ?? randomUUID;
    this.writeFile = options.writeFile ?? safeWriteFile;
    this.removeFile =
      options.removeFile ??
      ((path) => {
        if (existsSync(path)) unlinkSync(path);
      });
  }

  get(userId: string): AgenteraGlobalProfileResult<AgenteraGlobalProfile> {
    try {
      return { success: true, value: cloneProfile(this.readProfile(userId)) };
    } catch (error) {
      return failure(error);
    }
  }

  setEntry(
    userId: string,
    input: SetAgenteraGlobalProfileEntryInput,
  ): AgenteraGlobalProfileResult<AgenteraGlobalProfile> {
    return this.setEntryWithSource(userId, input, "user_explicit", 1);
  }

  setConfirmedCandidateEntry(
    userId: string,
    input: SetAgenteraGlobalProfileEntryInput,
    confidence: number,
  ): AgenteraGlobalProfileResult<AgenteraGlobalProfile> {
    return this.applyConfirmedCandidateEntry(userId, input, confidence);
  }

  beginConfirmedCandidateEntry(
    userId: string,
    input: SetAgenteraGlobalProfileEntryInput,
    confidence: number,
  ): AgenteraGlobalProfileCandidateChangeResult {
    let mutation: PersistedProfileMutation | null = null;
    const result = this.applyConfirmedCandidateEntry(
      userId,
      input,
      confidence,
      (value) => {
        mutation = value;
      },
    );
    if (!result.success) return result;
    if (!mutation) {
      return {
        success: false,
        error: "Global behavior profile mutation receipt is missing.",
      };
    }
    const receipt = mutation as PersistedProfileMutation;
    if (this.pendingCandidateMutations.has(receipt.operationId)) {
      try {
        this.restorePersistedMutation(receipt);
      } catch (error) {
        return failure(error);
      }
      return {
        success: false,
        error: "Global behavior profile mutation is already pending.",
      };
    }
    this.pendingCandidateMutations.set(receipt.operationId, receipt);
    return {
      success: true,
      value: result.value,
      rollbackToken: receipt.operationId,
    };
  }

  rollbackUncommittedConfirmedCandidateEntry(
    userId: string,
    rawRollbackToken: string,
  ): AgenteraGlobalProfileResult<AgenteraGlobalProfile> {
    try {
      const normalizedUserId = normalizeUserId(userId);
      const rollbackToken = validateOperationId(rawRollbackToken);
      const mutation = this.pendingCandidateMutations.get(rollbackToken);
      if (!mutation || mutation.userId !== normalizedUserId) {
        throw new Error(
          "Global behavior profile rollback token was not found.",
        );
      }
      this.restorePersistedMutation(mutation);
      this.pendingCandidateMutations.delete(rollbackToken);
      return {
        success: true,
        value: cloneProfile(this.readProfile(normalizedUserId)),
      };
    } catch (error) {
      return failure(error);
    }
  }

  commitConfirmedCandidateEntry(rollbackToken: string): void {
    this.pendingCandidateMutations.delete(rollbackToken);
  }

  private applyConfirmedCandidateEntry(
    userId: string,
    input: SetAgenteraGlobalProfileEntryInput,
    confidence: number,
    onPersisted?: (mutation: PersistedProfileMutation) => void,
  ): AgenteraGlobalProfileResult<AgenteraGlobalProfile> {
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return {
        success: false,
        error: "Global behavior profile candidate confidence is invalid.",
      };
    }
    return this.setEntryWithSource(
      userId,
      input,
      "candidate_confirmed",
      confidence,
      onPersisted,
    );
  }

  private setEntryWithSource(
    userId: string,
    input: SetAgenteraGlobalProfileEntryInput,
    source: AgenteraGlobalProfileEntry["source"],
    confidence: number,
    onPersisted?: (mutation: PersistedProfileMutation) => void,
  ): AgenteraGlobalProfileResult<AgenteraGlobalProfile> {
    try {
      const normalizedUserId = normalizeUserId(userId);
      const normalized = normalizeEntryInput(input);
      const current = this.readProfile(normalizedUserId);
      const timestamp = this.validNow().toISOString();
      const existing = current.entries.find(
        (entry) => entry.id === normalized.id,
      );
      const entry: AgenteraGlobalProfileEntry = {
        id: normalized.id,
        category: normalized.category,
        content: normalized.content,
        source,
        confidence,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const entries = [
        ...current.entries.filter((candidate) => candidate.id !== entry.id),
        entry,
      ].sort((left, right) => left.id.localeCompare(right.id));
      if (entries.length > MAX_ENTRIES) {
        throw new Error("Global behavior profile has too many entries.");
      }
      const next: AgenteraGlobalProfile = {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profileVersion: current.profileVersion + 1,
        updatedAt: timestamp,
        entries,
      };
      assertRenderedSize(next);
      const mutation = this.persistMutation(normalizedUserId, current, next, {
        action: "set",
        entryId: entry.id,
        createdAt: timestamp,
      });
      onPersisted?.(mutation);
      return { success: true, value: cloneProfile(next) };
    } catch (error) {
      return failure(error);
    }
  }

  removeEntry(
    userId: string,
    rawEntryId: string,
  ): AgenteraGlobalProfileResult<AgenteraGlobalProfile> {
    try {
      const normalizedUserId = normalizeUserId(userId);
      const entryId = normalizeEntryId(rawEntryId);
      const current = this.readProfile(normalizedUserId);
      if (!current.entries.some((entry) => entry.id === entryId)) {
        throw new Error("Global behavior profile entry was not found.");
      }
      const timestamp = this.validNow().toISOString();
      const next: AgenteraGlobalProfile = {
        ...current,
        profileVersion: current.profileVersion + 1,
        updatedAt: timestamp,
        entries: current.entries.filter((entry) => entry.id !== entryId),
      };
      this.persistMutation(normalizedUserId, current, next, {
        action: "remove",
        entryId,
        createdAt: timestamp,
      });
      return { success: true, value: cloneProfile(next) };
    } catch (error) {
      return failure(error);
    }
  }

  listHistory(
    userId: string,
  ): AgenteraGlobalProfileResult<AgenteraGlobalProfileHistoryItem[]> {
    try {
      const normalizedUserId = normalizeUserId(userId);
      const directory = this.historyDirectory(normalizedUserId);
      if (!existsSync(directory)) return { success: true, value: [] };
      const value = readdirSync(directory)
        .filter((name) => /^\d{10}\.json$/.test(name))
        .map((name) =>
          this.readProfileFile(
            join(directory, name),
            "Aera global profile history",
          ),
        )
        .sort((left, right) => right.profileVersion - left.profileVersion)
        .map((profile) => ({
          profileVersion: profile.profileVersion,
          updatedAt: profile.updatedAt,
          entryCount: profile.entries.length,
        }));
      return { success: true, value };
    } catch (error) {
      return failure(error);
    }
  }

  rollback(
    userId: string,
    targetVersion: number,
  ): AgenteraGlobalProfileResult<AgenteraGlobalProfile> {
    try {
      const normalizedUserId = normalizeUserId(userId);
      if (!Number.isSafeInteger(targetVersion) || targetVersion < 0) {
        throw new Error("Global behavior profile history version is invalid.");
      }
      const target = this.readProfileFile(
        this.historyPath(normalizedUserId, targetVersion),
        "Aera global profile history",
      );
      if (target.profileVersion !== targetVersion) {
        throw new Error("Global behavior profile history is corrupt.");
      }
      const current = this.readProfile(normalizedUserId);
      const timestamp = this.validNow().toISOString();
      const next: AgenteraGlobalProfile = {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profileVersion: current.profileVersion + 1,
        updatedAt: timestamp,
        entries: target.entries.map((entry) => ({ ...entry })),
      };
      this.persistMutation(normalizedUserId, current, next, {
        action: "rollback",
        entryId: null,
        createdAt: timestamp,
      });
      return { success: true, value: cloneProfile(next) };
    } catch (error) {
      return failure(error);
    }
  }

  prepareConversationSnapshot(
    userId: string,
    conversationKey: string,
    options: {
      existingSession?: boolean;
      resumeSession?: AgenteraGlobalProfileSessionReference;
    } = {},
  ): AgenteraGlobalProfileResult<AgenteraGlobalProfileConversationSnapshot> {
    try {
      const normalizedUserId = normalizeUserId(userId);
      const keySha256 = sha256(normalizeConversationKey(conversationKey));
      const path = this.conversationSnapshotPath(normalizedUserId, keySha256);
      if (existsSync(path)) {
        const stored = readConversationSnapshot(path, keySha256);
        return { success: true, value: publicSnapshot(stored) };
      }
      if (options.resumeSession) {
        const sessionKeySha256 = sessionReferenceSha256(options.resumeSession);
        const sessionPath = this.sessionSnapshotPath(
          normalizedUserId,
          sessionKeySha256,
        );
        if (existsSync(sessionPath)) {
          const sessionSnapshot = readConversationSnapshot(
            sessionPath,
            sessionKeySha256,
          );
          const rebound: StoredConversationSnapshot = {
            ...sessionSnapshot,
            conversationKeySha256: keySha256,
          };
          this.writeFile(path, serializeJson(rebound), 0o600);
          return { success: true, value: publicSnapshot(rebound) };
        }
      }
      const profile = options.existingSession
        ? emptyProfile()
        : this.readProfile(normalizedUserId);
      const renderedSnapshot =
        profile.entries.length > 0 ? renderGlobalProfile(profile) : "";
      const timestamp = this.validNow().toISOString();
      const stored: StoredConversationSnapshot = {
        schema: SNAPSHOT_SCHEMA,
        version: SNAPSHOT_VERSION,
        conversationKeySha256: keySha256,
        globalProfileVersion: profile.profileVersion,
        renderedSnapshot,
        snapshotSha256: sha256(renderedSnapshot),
        createdAt: timestamp,
      };
      this.writeFile(path, serializeJson(stored), 0o600);
      return { success: true, value: publicSnapshot(stored) };
    } catch (error) {
      return failure(error);
    }
  }

  bindConversationSnapshotToSession(
    userId: string,
    conversationKey: string,
    profileId: string,
    sessionId: string,
  ): AgenteraGlobalProfileResult<AgenteraGlobalProfileConversationSnapshot> {
    try {
      const normalizedUserId = normalizeUserId(userId);
      const conversationKeySha256 = sha256(
        normalizeConversationKey(conversationKey),
      );
      const conversationPath = this.conversationSnapshotPath(
        normalizedUserId,
        conversationKeySha256,
      );
      if (!existsSync(conversationPath)) {
        throw new Error("Global profile conversation snapshot was not found.");
      }
      const source = readConversationSnapshot(
        conversationPath,
        conversationKeySha256,
      );
      const sessionKeySha256 = sessionReferenceSha256({ profileId, sessionId });
      const sessionPath = this.sessionSnapshotPath(
        normalizedUserId,
        sessionKeySha256,
      );
      if (existsSync(sessionPath)) {
        const existing = readConversationSnapshot(
          sessionPath,
          sessionKeySha256,
        );
        if (!sameSnapshotBytes(existing, source)) {
          throw new Error(
            "Aera Runtime session is already bound to another global profile snapshot.",
          );
        }
        return { success: true, value: publicSnapshot(existing) };
      }
      const bound: StoredConversationSnapshot = {
        ...source,
        conversationKeySha256: sessionKeySha256,
      };
      this.writeFile(sessionPath, serializeJson(bound), 0o600);
      return { success: true, value: publicSnapshot(bound) };
    } catch (error) {
      return failure(error);
    }
  }

  private readProfile(userId: string): AgenteraGlobalProfile {
    const normalizedUserId = normalizeUserId(userId);
    const path = this.profilePath(normalizedUserId);
    if (!existsSync(path)) return emptyProfile();
    return this.readProfileFile(path, "Aera global behavior profile");
  }

  private readProfileFile(path: string, label: string): AgenteraGlobalProfile {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`${label} is corrupt.`);
    }
    return validateStoredProfile(parsed, label);
  }

  private persistMutation(
    userId: string,
    current: AgenteraGlobalProfile,
    next: AgenteraGlobalProfile,
    event: Omit<AuditEvent, "operationId" | "fromVersion" | "toVersion">,
  ): PersistedProfileMutation {
    const operationId = validateOperationId(this.createOperationId());
    const historyPath = this.historyPath(userId, current.profileVersion);
    const profilePath = this.profilePath(userId);
    const auditPath = this.auditPath(userId);
    const audit = this.readAudit(auditPath);
    const nextAudit: StoredAudit = {
      ...audit,
      events: [
        ...audit.events,
        {
          operationId,
          ...event,
          fromVersion: current.profileVersion,
          toVersion: next.profileVersion,
        },
      ].slice(-1_000),
    };
    const mutations: FileMutation[] = [];
    if (!existsSync(historyPath)) {
      mutations.push({ path: historyPath, content: serializeJson(current) });
    } else {
      const stored = this.readProfileFile(
        historyPath,
        "Aera global profile history",
      );
      if (JSON.stringify(stored) !== JSON.stringify(current)) {
        throw new Error("Global behavior profile history is corrupt.");
      }
    }
    mutations.push(
      { path: profilePath, content: serializeJson(next) },
      { path: auditPath, content: serializeJson(nextAudit) },
    );
    const before = this.writeTransaction(mutations);
    return {
      operationId,
      userId,
      before,
      after: mutations.map((mutation) => ({ ...mutation })),
    };
  }

  private readAudit(path: string): StoredAudit {
    if (!existsSync(path)) {
      return { schema: AUDIT_SCHEMA, version: AUDIT_VERSION, events: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("Aera global profile audit is corrupt.");
    }
    if (!isRecord(parsed)) {
      throw new Error("Aera global profile audit is corrupt.");
    }
    if (
      parsed.schema !== AUDIT_SCHEMA ||
      parsed.version !== AUDIT_VERSION ||
      !Array.isArray(parsed.events)
    ) {
      throw new Error("Aera global profile audit is corrupt.");
    }
    return parsed as unknown as StoredAudit;
  }

  private restorePersistedMutation(mutation: PersistedProfileMutation): void {
    for (const expected of mutation.after) {
      if (
        expected.content === null ||
        !existsSync(expected.path) ||
        readFileSync(expected.path, "utf8") !== expected.content
      ) {
        throw new Error(
          "Only the latest uncommitted global profile change can be rolled back.",
        );
      }
    }
    this.writeTransaction(
      mutation.before.map((snapshot) => ({
        path: snapshot.path,
        content: snapshot.existed ? snapshot.content : null,
      })),
    );
  }

  private writeTransaction(files: FileMutation[]): FileSnapshot[] {
    const snapshots: FileSnapshot[] = files.map((file) => ({
      path: file.path,
      existed: existsSync(file.path),
      content: existsSync(file.path) ? readFileSync(file.path, "utf8") : "",
    }));
    try {
      for (const file of files) {
        if (file.content === null) this.removeFile(file.path);
        else this.writeFile(file.path, file.content, 0o600);
      }
    } catch (error) {
      for (const snapshot of [...snapshots].reverse()) {
        try {
          if (snapshot.existed) {
            this.writeFile(snapshot.path, snapshot.content, 0o600);
          } else {
            this.removeFile(snapshot.path);
          }
        } catch {
          // Preserve the original transaction error.
        }
      }
      throw error;
    }
    return snapshots;
  }

  private profilePath(userId: string): string {
    return join(this.rootPath, userId, "global-profile.json");
  }

  private historyDirectory(userId: string): string {
    return join(this.rootPath, userId, "history");
  }

  private historyPath(userId: string, version: number): string {
    return join(
      this.historyDirectory(userId),
      `${String(version).padStart(10, "0")}.json`,
    );
  }

  private auditPath(userId: string): string {
    return join(this.rootPath, userId, "audit", "events.json");
  }

  private conversationSnapshotPath(userId: string, keySha256: string): string {
    return join(this.rootPath, userId, "conversations", `${keySha256}.json`);
  }

  private sessionSnapshotPath(userId: string, keySha256: string): string {
    return join(this.rootPath, userId, "sessions", `${keySha256}.json`);
  }

  private validNow(): Date {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("Aera global profile clock is invalid.");
    }
    return value;
  }
}

export function composeGlobalProfileEnvelope(
  existing: HermesConversationEnvelope | null | undefined,
  renderedSnapshot: string | null | undefined,
): HermesConversationEnvelope | undefined {
  if (!renderedSnapshot) return existing ?? undefined;
  return {
    instructions: existing?.instructions
      ? `${existing.instructions}\n\n${renderedSnapshot}`
      : renderedSnapshot,
    requireBoundApiTransport: true,
  };
}

export function summarizeGlobalProfileConversationSnapshot(
  result: AgenteraGlobalProfileResult<AgenteraGlobalProfileConversationSnapshot>,
): AgenteraGlobalProfileSnapshotContext {
  if (!result.success) {
    return {
      globalProfileVersion: null,
      requiresBoundApiTransport: false,
      degraded: true,
    };
  }
  return {
    globalProfileVersion: result.value.globalProfileVersion,
    requiresBoundApiTransport: result.value.renderedSnapshot.length > 0,
    degraded: false,
  };
}

function emptyProfile(): AgenteraGlobalProfile {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileVersion: 0,
    updatedAt: null,
    entries: [],
  };
}

function normalizeUserId(value: unknown): string {
  if (typeof value !== "string" || !USER_ID_RE.test(value)) {
    throw new Error("Aera global profile owner is invalid.");
  }
  return value.toLowerCase();
}

function normalizeEntryInput(
  input: SetAgenteraGlobalProfileEntryInput,
): SetAgenteraGlobalProfileEntryInput {
  if (!isRecord(input)) {
    throw new Error("Global behavior profile entry is invalid.");
  }
  const category = normalizeCategory(input.category);
  const id = normalizeEntryId(input.id);
  if (!id.startsWith(`${category}.`)) {
    throw new Error(
      "Global profile entry id must start with its behavior category.",
    );
  }
  const content = normalizeEntryContent(input.content);
  return { id, category, content };
}

function normalizeCategory(value: unknown): AgenteraGlobalProfileCategory {
  if (
    typeof value !== "string" ||
    !AGENTERA_GLOBAL_PROFILE_CATEGORIES.includes(
      value as AgenteraGlobalProfileCategory,
    )
  ) {
    throw new Error("Global behavior profile category is invalid.");
  }
  return value as AgenteraGlobalProfileCategory;
}

function normalizeEntryId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Global behavior profile entry id is invalid.");
  }
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!ENTRY_ID_RE.test(normalized) || normalized.length > 96) {
    throw new Error("Global behavior profile entry id is invalid.");
  }
  return normalized;
}

function normalizeEntryContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Global behavior profile content is invalid.");
  }
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[\t\r\n ]+/g, " ");
  if (!normalized) {
    throw new Error("Global behavior profile content is required.");
  }
  if (Array.from(normalized).length > MAX_ENTRY_CHARS) {
    throw new Error("Global behavior profile content is too long.");
  }
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new Error("Global behavior profile content contains control text.");
  }
  if (
    /(?:ignore\s+(?:all|any|the|previous)\s+instructions?|system\s+prompt|developer\s+message|<\|(?:system|assistant|developer)\|>|\[\s*system\s*(?:note|message)?\s*\]|忽略.{0,12}(?:指令|提示)|系统提示|开发者消息)/iu.test(
      normalized,
    )
  ) {
    throw new Error("Global profile entry looks like prompt-control text.");
  }
  if (
    /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\b(?:api[ _-]?key|password|passwd|secret|bearer|access[ _-]?token|refresh[ _-]?token)\s*[:=]\s*\S{8,})/iu.test(
      normalized,
    )
  ) {
    throw new Error(
      "Global profile entries cannot contain credentials or secrets.",
    );
  }
  return normalized;
}

function validateStoredProfile(
  value: unknown,
  label: string,
): AgenteraGlobalProfile {
  if (!isRecord(value)) throw new Error(`${label} is corrupt.`);
  if (
    value.schemaVersion !== PROFILE_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.profileVersion) ||
    (value.profileVersion as number) < 0 ||
    !(
      value.updatedAt === null ||
      (typeof value.updatedAt === "string" &&
        Number.isFinite(Date.parse(value.updatedAt)))
    ) ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES
  ) {
    throw new Error(`${label} is corrupt.`);
  }
  const entries: AgenteraGlobalProfileEntry[] = [];
  const ids = new Set<string>();
  for (const raw of value.entries) {
    if (!isRecord(raw)) throw new Error(`${label} is corrupt.`);
    let normalized: SetAgenteraGlobalProfileEntryInput;
    try {
      normalized = normalizeEntryInput({
        id: raw.id as string,
        category: raw.category as AgenteraGlobalProfileCategory,
        content: raw.content as string,
      });
    } catch {
      throw new Error(`${label} is corrupt.`);
    }
    if (
      ids.has(normalized.id) ||
      (raw.source !== "user_explicit" &&
        raw.source !== "candidate_confirmed" &&
        raw.source !== "imported") ||
      typeof raw.confidence !== "number" ||
      raw.confidence < 0 ||
      raw.confidence > 1 ||
      typeof raw.createdAt !== "string" ||
      !Number.isFinite(Date.parse(raw.createdAt)) ||
      typeof raw.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(raw.updatedAt))
    ) {
      throw new Error(`${label} is corrupt.`);
    }
    ids.add(normalized.id);
    entries.push({
      ...normalized,
      source: raw.source,
      confidence: raw.confidence,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }
  const profile: AgenteraGlobalProfile = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileVersion: value.profileVersion as number,
    updatedAt: value.updatedAt as string | null,
    entries: entries.sort((left, right) => left.id.localeCompare(right.id)),
  };
  assertRenderedSize(profile);
  return profile;
}

function renderGlobalProfile(profile: AgenteraGlobalProfile): string {
  const lines = [
    "[System note: Aera global user behavior profile]",
    "This block is read-only context supplied by Aera.",
    "Do not edit it with the memory tool. Do not copy, summarize, sync, or persist",
    "any part of this block into MEMORY.md, USER.md, Skills, or Curator.",
    `Version: ${profile.profileVersion}`,
    ...profile.entries.map(
      (entry) => `- [${entry.category}] ${entry.id}: ${entry.content}`,
    ),
    "[/System note]",
  ];
  const rendered = lines.join("\n");
  if (rendered.length > MAX_RENDERED_CHARS) {
    throw new Error("Global behavior profile is too large to inject safely.");
  }
  return rendered;
}

function assertRenderedSize(profile: AgenteraGlobalProfile): void {
  if (profile.entries.length > 0) renderGlobalProfile(profile);
}

function readConversationSnapshot(
  path: string,
  expectedKeySha256: string,
): StoredConversationSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      "Aera global profile conversation snapshot is corrupt.",
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      "Aera global profile conversation snapshot is corrupt.",
    );
  }
  if (
    parsed.schema !== SNAPSHOT_SCHEMA ||
    parsed.version !== SNAPSHOT_VERSION ||
    parsed.conversationKeySha256 !== expectedKeySha256 ||
    !Number.isSafeInteger(parsed.globalProfileVersion) ||
    (parsed.globalProfileVersion as number) < 0 ||
    typeof parsed.renderedSnapshot !== "string" ||
    parsed.renderedSnapshot.length > MAX_RENDERED_CHARS ||
    typeof parsed.snapshotSha256 !== "string" ||
    sha256(parsed.renderedSnapshot) !== parsed.snapshotSha256 ||
    typeof parsed.createdAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.createdAt))
  ) {
    throw new Error(
      "Aera global profile conversation snapshot is corrupt.",
    );
  }
  return parsed as unknown as StoredConversationSnapshot;
}

function publicSnapshot(
  stored: StoredConversationSnapshot,
): AgenteraGlobalProfileConversationSnapshot {
  return {
    globalProfileVersion: stored.globalProfileVersion,
    renderedSnapshot: stored.renderedSnapshot,
    snapshotSha256: stored.snapshotSha256,
  };
}

function sameSnapshotBytes(
  left: StoredConversationSnapshot,
  right: StoredConversationSnapshot,
): boolean {
  return (
    left.globalProfileVersion === right.globalProfileVersion &&
    left.renderedSnapshot === right.renderedSnapshot &&
    left.snapshotSha256 === right.snapshotSha256
  );
}

function sessionReferenceSha256(
  reference: AgenteraGlobalProfileSessionReference,
): string {
  if (!isRecord(reference)) {
    throw new Error("Aera Runtime session snapshot reference is invalid.");
  }
  const profileId = normalizeAgentProfileId(reference.profileId);
  const sessionId = normalizeSessionId(reference.sessionId);
  return sha256(JSON.stringify([profileId, sessionId]));
}

function normalizeAgentProfileId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:default|[a-z0-9_][a-z0-9_-]{0,63})$/.test(value)
  ) {
    throw new Error("Agent Profile identity is invalid.");
  }
  return value;
}

function normalizeSessionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error("Aera Runtime session identity is invalid.");
  }
  return value;
}

function normalizeConversationKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error("Aera conversation identity is invalid.");
  }
  return value;
}

function normalizeOperationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new Error("Aera global profile operation is invalid.");
  }
  return value;
}

const validateOperationId = normalizeOperationId;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function cloneProfile(profile: AgenteraGlobalProfile): AgenteraGlobalProfile {
  return {
    ...profile,
    entries: profile.entries.map((entry) => ({ ...entry })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failure(error: unknown): { success: false; error: string } {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
