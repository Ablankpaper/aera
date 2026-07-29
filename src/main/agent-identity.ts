import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isValidProfileName, safeWriteFile } from "./utils";

const IDENTITY_SCHEMA = "aera-agent-identity" as const;
const IDENTITY_VERSION = 1 as const;
const IDENTITY_BACKUP_SCHEMA = "aera-agent-identity-backup" as const;
const IDENTITY_BACKUP_VERSION = 1 as const;
const IDENTITY_START = "<!-- AERA:AGENT_IDENTITY:BEGIN -->";
const IDENTITY_END = "<!-- AERA:AGENT_IDENTITY:END -->";

interface StoredIdentityState {
  schema: typeof IDENTITY_SCHEMA;
  version: typeof IDENTITY_VERSION;
  revision: number;
  displayName: string;
  updatedAt: string;
  sessions: Record<string, { revision: number; updatedAt: string }>;
}

interface StoredFileSnapshot {
  existed: boolean;
  content: string;
}

interface StoredIdentityBackup {
  schema: typeof IDENTITY_BACKUP_SCHEMA;
  version: typeof IDENTITY_BACKUP_VERSION;
  operationId: string;
  profileId: string;
  createdAt: string;
  afterRevision: number;
  before: {
    profileMeta: StoredFileSnapshot;
    soul: StoredFileSnapshot;
    identityState: StoredFileSnapshot;
  };
}

export interface AgentIdentity {
  profileId: string;
  displayName: string;
  revision: number;
  updatedAt: string;
}

export type AgentIdentityChangeResult =
  | {
      success: true;
      operationId: string;
      identity: AgentIdentity;
    }
  | { success: false; error: string };

export type AgentIdentitySessionResult =
  | { success: true }
  | { success: false; error: string };

export interface AgentIdentityServiceOptions {
  resolveProfilePath: (profileId: string) => string;
  now?: () => Date;
  createOperationId?: () => string;
  writeFile?: (path: string, content: string, mode?: number) => void;
  removeFile?: (path: string) => void;
}

interface FileSnapshot {
  path: string;
  existed: boolean;
  content: string;
}

interface FileMutation {
  path: string;
  content: string | null;
}

export class AgentIdentityService {
  private readonly resolveProfilePath: (profileId: string) => string;
  private readonly now: () => Date;
  private readonly createOperationId: () => string;
  private readonly writeFile: (
    path: string,
    content: string,
    mode?: number,
  ) => void;
  private readonly removeFile: (path: string) => void;

  constructor(options: AgentIdentityServiceOptions) {
    this.resolveProfilePath = options.resolveProfilePath;
    this.now = options.now ?? (() => new Date());
    this.createOperationId = options.createOperationId ?? randomUUID;
    this.writeFile = options.writeFile ?? safeWriteFile;
    this.removeFile =
      options.removeFile ??
      ((path) => {
        if (existsSync(path)) unlinkSync(path);
      });
  }

  setDisplayName(
    profileId: string,
    rawDisplayName: string,
  ): AgentIdentityChangeResult {
    try {
      if (!isValidProfileName(profileId)) {
        throw new Error("Agent profile is invalid.");
      }
      const root = this.profileRoot(profileId);
      const displayName = normalizeDisplayName(rawDisplayName);
      const updatedAt = this.validNow().toISOString();
      const state = readIdentityState(root);
      const revision = state.revision + 1;
      const operationId = validateOperationId(this.createOperationId());

      const metaPath = join(root, "profile-meta.json");
      const soulPath = join(root, "SOUL.md");
      const meta = readJsonObject(metaPath, "Agent profile metadata");
      const soul = existsSync(soulPath) ? readFileSync(soulPath, "utf8") : "";
      const nextSoul = updateManagedIdentityBlock(soul, displayName, revision);
      const statePath = identityStatePath(root);
      const backupPath = identityBackupPath(root, operationId);
      if (existsSync(backupPath)) {
        throw new Error("Agent identity operation already exists.");
      }
      const backup = createStoredBackup({
        operationId,
        profileId,
        createdAt: updatedAt,
        afterRevision: revision,
        metaPath,
        soulPath,
        statePath,
      });

      this.writeTransaction([
        { path: backupPath, content: serializeJson(backup) },
        {
          path: metaPath,
          content: `${JSON.stringify({ ...meta, name: displayName }, null, 2)}\n`,
        },
        {
          path: soulPath,
          content: nextSoul,
        },
        {
          path: statePath,
          content: serializeIdentityState({
            ...state,
            revision,
            displayName,
            updatedAt,
          }),
        },
      ]);

      return {
        success: true,
        operationId,
        identity: { profileId, displayName, revision, updatedAt },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  undoDisplayName(
    profileId: string,
    rawOperationId: string,
  ): AgentIdentityChangeResult {
    try {
      if (!isValidProfileName(profileId)) {
        throw new Error("Agent profile is invalid.");
      }
      const root = this.profileRoot(profileId);
      const operationId = validateOperationId(rawOperationId);
      const backup = readIdentityBackup(identityBackupPath(root, operationId));
      if (
        backup.profileId !== profileId ||
        backup.operationId !== operationId
      ) {
        throw new Error("Agent identity backup does not match this profile.");
      }
      const current = readIdentityState(root);
      if (current.revision !== backup.afterRevision) {
        throw new Error("Only the latest Agent identity change can be undone.");
      }

      const updatedAt = this.validNow().toISOString();
      const revision = current.revision + 1;
      const displayName = displayNameFromBackup(backup);
      const metaPath = join(root, "profile-meta.json");
      const soulPath = join(root, "SOUL.md");
      const statePath = identityStatePath(root);
      const undoOperationId = validateOperationId(this.createOperationId());
      const undoBackupPath = identityBackupPath(root, undoOperationId);
      if (existsSync(undoBackupPath)) {
        throw new Error("Agent identity operation already exists.");
      }
      const restoredSoul = restoreSoulSnapshot(
        backup.before.soul,
        displayName,
        revision,
      );
      const undoBackup = createStoredBackup({
        operationId: undoOperationId,
        profileId,
        createdAt: updatedAt,
        afterRevision: revision,
        metaPath,
        soulPath,
        statePath,
      });

      this.writeTransaction([
        { path: undoBackupPath, content: serializeJson(undoBackup) },
        {
          path: metaPath,
          content: backup.before.profileMeta.existed
            ? backup.before.profileMeta.content
            : null,
        },
        { path: soulPath, content: restoredSoul },
        {
          path: statePath,
          content: serializeIdentityState({
            ...current,
            revision,
            displayName,
            updatedAt,
          }),
        },
      ]);

      return {
        success: true,
        operationId: undoOperationId,
        identity: { profileId, displayName, revision, updatedAt },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  rollbackUncommittedDisplayName(
    profileId: string,
    rawOperationId: string,
  ): AgentIdentitySessionResult {
    try {
      if (!isValidProfileName(profileId)) {
        throw new Error("Agent profile is invalid.");
      }
      const root = this.profileRoot(profileId);
      const operationId = validateOperationId(rawOperationId);
      const backupPath = identityBackupPath(root, operationId);
      const backup = readIdentityBackup(backupPath);
      if (
        backup.profileId !== profileId ||
        backup.operationId !== operationId
      ) {
        throw new Error("Agent identity backup does not match this profile.");
      }
      const current = readIdentityState(root);
      if (current.revision !== backup.afterRevision) {
        throw new Error(
          "Only the latest uncommitted Agent identity change can be rolled back.",
        );
      }

      this.writeTransaction([
        restoreFileMutation(
          join(root, "profile-meta.json"),
          backup.before.profileMeta,
        ),
        restoreFileMutation(join(root, "SOUL.md"), backup.before.soul),
        restoreFileMutation(
          identityStatePath(root),
          backup.before.identityState,
        ),
        { path: backupPath, content: null },
      ]);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  resolveResumeSessionId(
    profileId: string,
    rawSessionId?: string,
  ): string | undefined {
    if (!rawSessionId) return undefined;
    try {
      if (!isValidProfileName(profileId)) return undefined;
      const sessionId = validateSessionId(rawSessionId);
      const state = readIdentityState(this.profileRoot(profileId));
      const recorded = state.sessions[sessionId];
      if (!recorded) {
        // Revision zero predates identity management, so legacy Hermes sessions
        // remain resumable until the first explicit identity change.
        return state.revision === 0 ? sessionId : undefined;
      }
      return recorded.revision === state.revision ? sessionId : undefined;
    } catch {
      // Identity metadata must never block chat. A corrupt/unknown mapping is
      // treated as stale so Hermes starts a fresh underlying session.
      return undefined;
    }
  }

  scopeConversationKey(profileId: string, conversationKey: string): string {
    try {
      if (!isValidProfileName(profileId)) return conversationKey;
      const revision = readIdentityState(this.profileRoot(profileId)).revision;
      return revision === 0
        ? conversationKey
        : `${conversationKey}::aera-agent-identity:${revision}`;
    } catch {
      // Do not reuse a binding whose identity provenance cannot be verified.
      return `${conversationKey}::aera-agent-identity:unreadable`;
    }
  }

  recordSessionRevision(
    profileId: string,
    rawSessionId: string,
  ): AgentIdentitySessionResult {
    try {
      if (!isValidProfileName(profileId)) {
        throw new Error("Agent profile is invalid.");
      }
      const sessionId = validateSessionId(rawSessionId);
      const root = this.profileRoot(profileId);
      const state = readIdentityState(root);
      const updatedAt = this.validNow().toISOString();
      const sessions = pruneSessions({
        ...state.sessions,
        [sessionId]: { revision: state.revision, updatedAt },
      });
      this.writeFile(
        identityStatePath(root),
        serializeIdentityState({ ...state, sessions }),
        0o600,
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private profileRoot(profileId: string): string {
    const root = this.resolveProfilePath(profileId);
    if (!isAbsolute(root)) throw new Error("Agent profile path is invalid.");
    return resolve(root);
  }

  private validNow(): Date {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("Agent identity clock is invalid.");
    }
    return value;
  }

  private writeTransaction(files: FileMutation[]): void {
    const snapshots = files.map(captureFileSnapshot);
    try {
      for (const file of files) {
        if (file.content === null) this.removeFile(file.path);
        else this.writeFile(file.path, file.content, 0o600);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const snapshot of [...snapshots].reverse()) {
        try {
          if (snapshot.existed) {
            this.writeFile(snapshot.path, snapshot.content, 0o600);
          } else {
            this.removeFile(snapshot.path);
          }
        } catch (rollbackError) {
          rollbackErrors.push(
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError),
          );
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      if (rollbackErrors.length > 0) {
        throw new Error(
          `${message} Identity rollback failed: ${rollbackErrors.join("; ")}`,
        );
      }
      throw error;
    }
  }
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Agent name is invalid.");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Agent name is required.");
  if (Array.from(normalized).length > 80) {
    throw new Error("Agent name is too long.");
  }
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new Error("Agent name contains control text.");
  }
  if (normalized.includes("<!--") || normalized.includes("-->")) {
    throw new Error("Agent name contains reserved text.");
  }
  return normalized;
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} is corrupt.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is corrupt.`);
  }
  return parsed as Record<string, unknown>;
}

function emptyIdentityState(): StoredIdentityState {
  return {
    schema: IDENTITY_SCHEMA,
    version: IDENTITY_VERSION,
    revision: 0,
    displayName: "",
    updatedAt: "",
    sessions: {},
  };
}

function identityStatePath(root: string): string {
  return join(root, ".agentera", "identity-state.json");
}

function identityBackupPath(root: string, operationId: string): string {
  return join(root, ".agentera", "identity-backups", `${operationId}.json`);
}

function readIdentityState(root: string): StoredIdentityState {
  const path = identityStatePath(root);
  if (!existsSync(path)) return emptyIdentityState();
  const parsed = readJsonObject(path, "Agent identity state");
  return validateIdentityState(parsed, "Agent identity state");
}

function validateIdentityState(
  parsed: Record<string, unknown>,
  label: string,
): StoredIdentityState {
  if (
    parsed.schema !== IDENTITY_SCHEMA ||
    parsed.version !== IDENTITY_VERSION ||
    !Number.isSafeInteger(parsed.revision) ||
    (parsed.revision as number) < 0 ||
    typeof parsed.displayName !== "string" ||
    typeof parsed.updatedAt !== "string" ||
    !parsed.sessions ||
    typeof parsed.sessions !== "object" ||
    Array.isArray(parsed.sessions)
  ) {
    throw new Error(`${label} is corrupt.`);
  }
  for (const session of Object.values(
    parsed.sessions as Record<string, unknown>,
  )) {
    if (
      !session ||
      typeof session !== "object" ||
      Array.isArray(session) ||
      !Number.isSafeInteger((session as { revision?: unknown }).revision) ||
      ((session as { revision: number }).revision ?? -1) < 0 ||
      typeof (session as { updatedAt?: unknown }).updatedAt !== "string"
    ) {
      throw new Error(`${label} is corrupt.`);
    }
  }
  return parsed as unknown as StoredIdentityState;
}

function serializeIdentityState(state: StoredIdentityState): string {
  return serializeJson(state);
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function captureFileSnapshot(file: { path: string }): FileSnapshot {
  const existed = existsSync(file.path);
  return {
    path: file.path,
    existed,
    content: existed ? readFileSync(file.path, "utf8") : "",
  };
}

function storedFileSnapshot(path: string): StoredFileSnapshot {
  const snapshot = captureFileSnapshot({ path });
  return { existed: snapshot.existed, content: snapshot.content };
}

function restoreFileMutation(
  path: string,
  snapshot: StoredFileSnapshot,
): FileMutation {
  return {
    path,
    content: snapshot.existed ? snapshot.content : null,
  };
}

function createStoredBackup(input: {
  operationId: string;
  profileId: string;
  createdAt: string;
  afterRevision: number;
  metaPath: string;
  soulPath: string;
  statePath: string;
}): StoredIdentityBackup {
  return {
    schema: IDENTITY_BACKUP_SCHEMA,
    version: IDENTITY_BACKUP_VERSION,
    operationId: input.operationId,
    profileId: input.profileId,
    createdAt: input.createdAt,
    afterRevision: input.afterRevision,
    before: {
      profileMeta: storedFileSnapshot(input.metaPath),
      soul: storedFileSnapshot(input.soulPath),
      identityState: storedFileSnapshot(input.statePath),
    },
  };
}

function validateOperationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new Error("Agent identity operation is invalid.");
  }
  return value;
}

function validateSessionId(value: unknown): string {
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

function pruneSessions(
  sessions: StoredIdentityState["sessions"],
): StoredIdentityState["sessions"] {
  return Object.fromEntries(
    Object.entries(sessions)
      .sort(([, left], [, right]) =>
        left.updatedAt.localeCompare(right.updatedAt),
      )
      .slice(-500),
  );
}

function readIdentityBackup(path: string): StoredIdentityBackup {
  if (!existsSync(path))
    throw new Error("Agent identity backup was not found.");
  const parsed = readJsonObject(path, "Agent identity backup");
  if (
    parsed.schema !== IDENTITY_BACKUP_SCHEMA ||
    parsed.version !== IDENTITY_BACKUP_VERSION ||
    typeof parsed.operationId !== "string" ||
    typeof parsed.profileId !== "string" ||
    typeof parsed.createdAt !== "string" ||
    !Number.isSafeInteger(parsed.afterRevision) ||
    !isStoredBackupFiles(parsed.before)
  ) {
    throw new Error("Agent identity backup is corrupt.");
  }
  return parsed as unknown as StoredIdentityBackup;
}

function isStoredFileSnapshot(value: unknown): value is StoredFileSnapshot {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as StoredFileSnapshot).existed === "boolean" &&
    typeof (value as StoredFileSnapshot).content === "string"
  );
}

function isStoredBackupFiles(
  value: unknown,
): value is StoredIdentityBackup["before"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const files = value as StoredIdentityBackup["before"];
  return (
    isStoredFileSnapshot(files.profileMeta) &&
    isStoredFileSnapshot(files.soul) &&
    isStoredFileSnapshot(files.identityState)
  );
}

function displayNameFromBackup(backup: StoredIdentityBackup): string {
  if (backup.before.profileMeta.existed) {
    const meta = parseJsonObjectContent(
      backup.before.profileMeta.content,
      "Agent identity backup metadata",
    );
    if (typeof meta.name === "string" && meta.name.trim()) {
      return normalizeDisplayName(meta.name);
    }
  }
  if (backup.before.identityState.existed) {
    const state = parseIdentityStateContent(
      backup.before.identityState.content,
    );
    if (state.displayName) return normalizeDisplayName(state.displayName);
  }
  return "";
}

function restoreSoulSnapshot(
  snapshot: StoredFileSnapshot,
  displayName: string,
  revision: number,
): string | null {
  if (!snapshot.existed) return null;
  const starts = countOccurrences(snapshot.content, IDENTITY_START);
  const ends = countOccurrences(snapshot.content, IDENTITY_END);
  if (starts === 0 && ends === 0) return snapshot.content;
  if (!displayName) throw new Error("Agent identity backup is corrupt.");
  return updateManagedIdentityBlock(snapshot.content, displayName, revision);
}

function parseJsonObjectContent(
  content: string,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${label} is corrupt.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is corrupt.`);
  }
  return parsed as Record<string, unknown>;
}

function parseIdentityStateContent(content: string): StoredIdentityState {
  const parsed = parseJsonObjectContent(content, "Agent identity backup state");
  return validateIdentityState(parsed, "Agent identity backup state");
}

function identityBlock(displayName: string, revision: number): string {
  return [
    IDENTITY_START,
    "## Agent Identity",
    "",
    `Your name is \u201c${displayName}\u201d.`,
    "Use this name consistently when referring to yourself.",
    "This identity belongs only to the current Agent Profile.",
    `Identity revision: ${revision}.`,
    IDENTITY_END,
  ].join("\n");
}

function updateManagedIdentityBlock(
  soul: string,
  displayName: string,
  revision: number,
): string {
  const block = identityBlock(displayName, revision);
  const starts = countOccurrences(soul, IDENTITY_START);
  const ends = countOccurrences(soul, IDENTITY_END);
  if (starts === 0 && ends === 0) {
    return soul.trim()
      ? `${block}\n\n${soul.replace(/^\s+/, "")}`
      : `${block}\n`;
  }
  if (starts !== 1 || ends !== 1) {
    throw new Error("Agent identity block is corrupt.");
  }
  const start = soul.indexOf(IDENTITY_START);
  const end = soul.indexOf(IDENTITY_END);
  if (end < start) throw new Error("Agent identity block is corrupt.");
  const after = end + IDENTITY_END.length;
  return `${soul.slice(0, start)}${block}${soul.slice(after)}`;
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}
