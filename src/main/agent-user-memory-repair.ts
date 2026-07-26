import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isValidProfileName, safeWriteFile } from "./utils";

const REPAIR_SCHEMA = "aera-agent-user-memory-repair" as const;
const REPAIR_VERSION = 1 as const;

interface StoredRepairBackup {
  schema: typeof REPAIR_SCHEMA;
  version: typeof REPAIR_VERSION;
  operationId: string;
  profileId: string;
  createdAt: string;
  before: {
    existed: boolean;
    content: string;
    sha256: string;
  };
  afterSha256: string;
}

export interface AgentUserMemoryRepairPreview {
  profileId: string;
  exists: boolean;
  content: string;
  charCount: number;
  currentSha256: string;
}

export type AgentUserMemoryRepairPreviewResult =
  | { success: true; preview: AgentUserMemoryRepairPreview }
  | { success: false; error: string };

export interface ApplyAgentUserMemoryRepairInput {
  profileId: string;
  expectedSha256: string;
  replacementContent: string;
  confirmed: boolean;
}

export type AgentUserMemoryRepairMutationResult =
  | { success: true; operationId: string; profileId: string }
  | { success: false; error: string };

export type AgentUserMemoryRepairUndoResult =
  | { success: true; profileId: string }
  | { success: false; error: string };

export interface AgentUserMemoryRepairServiceOptions {
  resolveProfilePath: (profileId: string) => string;
  now?: () => Date;
  createOperationId?: () => string;
  writeFile?: (path: string, content: string, mode?: number) => void;
  removeFile?: (path: string) => void;
}

export class AgentUserMemoryRepairService {
  private readonly resolveProfilePath: (profileId: string) => string;
  private readonly now: () => Date;
  private readonly createOperationId: () => string;
  private readonly writeFile: (
    path: string,
    content: string,
    mode?: number,
  ) => void;
  private readonly removeFile: (path: string) => void;

  constructor(options: AgentUserMemoryRepairServiceOptions) {
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

  preview(profileId: string): AgentUserMemoryRepairPreviewResult {
    try {
      const path = this.userMemoryPath(profileId);
      const existed = existsSync(path);
      const content = existed ? readFileSync(path, "utf8") : "";
      return {
        success: true,
        preview: {
          profileId,
          exists: existed,
          content,
          charCount: content.length,
          currentSha256: contentDigest(existed, content),
        },
      };
    } catch (error) {
      return failure(error);
    }
  }

  apply(
    input: ApplyAgentUserMemoryRepairInput,
  ): AgentUserMemoryRepairMutationResult {
    try {
      if (!input?.confirmed) {
        throw new Error("User confirmation is required for USER.md repair.");
      }
      validateDigest(input.expectedSha256);
      if (typeof input.replacementContent !== "string") {
        throw new Error("USER.md replacement content is invalid.");
      }
      const root = this.profileRoot(input.profileId);
      const userPath = join(root, "memories", "USER.md");
      const existed = existsSync(userPath);
      const currentContent = existed ? readFileSync(userPath, "utf8") : "";
      const currentSha256 = contentDigest(existed, currentContent);
      if (currentSha256 !== input.expectedSha256) {
        throw new Error("USER.md changed after the preview. Review it again.");
      }
      if (input.replacementContent === currentContent) {
        throw new Error("USER.md repair does not contain any changes.");
      }
      if (input.replacementContent.length > currentContent.length) {
        throw new Error(
          "USER.md repair may only remove or shorten existing content.",
        );
      }
      if (input.replacementContent.includes("\u0000")) {
        throw new Error("USER.md replacement content is invalid.");
      }

      const operationId = validateOperationId(this.createOperationId());
      const backupPath = this.backupPath(root, operationId);
      if (existsSync(backupPath)) {
        throw new Error("USER.md repair operation already exists.");
      }
      const createdAt = this.validNow().toISOString();
      const backup: StoredRepairBackup = {
        schema: REPAIR_SCHEMA,
        version: REPAIR_VERSION,
        operationId,
        profileId: input.profileId,
        createdAt,
        before: {
          existed,
          content: currentContent,
          sha256: currentSha256,
        },
        afterSha256: contentDigest(true, input.replacementContent),
      };

      this.writeFile(backupPath, serializeJson(backup), 0o600);
      try {
        this.writeFile(userPath, input.replacementContent, 0o600);
      } catch (error) {
        try {
          this.removeFile(backupPath);
        } catch {
          // Preserve the original USER.md write error.
        }
        throw error;
      }
      return { success: true, operationId, profileId: input.profileId };
    } catch (error) {
      return failure(error);
    }
  }

  undo(
    profileId: string,
    rawOperationId: string,
  ): AgentUserMemoryRepairUndoResult {
    try {
      const root = this.profileRoot(profileId);
      const operationId = validateOperationId(rawOperationId);
      const backup = readBackup(this.backupPath(root, operationId));
      if (
        backup.profileId !== profileId ||
        backup.operationId !== operationId
      ) {
        throw new Error("USER.md repair backup does not match this profile.");
      }
      const userPath = join(root, "memories", "USER.md");
      const existed = existsSync(userPath);
      const currentContent = existed ? readFileSync(userPath, "utf8") : "";
      if (contentDigest(existed, currentContent) !== backup.afterSha256) {
        throw new Error(
          "USER.md changed after this repair. It cannot be safely undone.",
        );
      }
      if (backup.before.existed) {
        this.writeFile(userPath, backup.before.content, 0o600);
      } else {
        this.removeFile(userPath);
      }
      return { success: true, profileId };
    } catch (error) {
      return failure(error);
    }
  }

  private profileRoot(profileId: string): string {
    if (!isValidProfileName(profileId)) {
      throw new Error("Agent profile is invalid.");
    }
    const root = this.resolveProfilePath(profileId);
    if (!isAbsolute(root)) throw new Error("Agent profile path is invalid.");
    return resolve(root);
  }

  private userMemoryPath(profileId: string): string {
    return join(this.profileRoot(profileId), "memories", "USER.md");
  }

  private backupPath(root: string, operationId: string): string {
    return join(
      root,
      ".agentera",
      "user-memory-repairs",
      `${operationId}.json`,
    );
  }

  private validNow(): Date {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("USER.md repair clock is invalid.");
    }
    return value;
  }
}

function contentDigest(existed: boolean, content: string): string {
  return createHash("sha256")
    .update(existed ? "1\0" : "0\0")
    .update(content, "utf8")
    .digest("hex");
}

function validateDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("USER.md preview identity is invalid.");
  }
  return value;
}

function validateOperationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new Error("USER.md repair operation is invalid.");
  }
  return value;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readBackup(path: string): StoredRepairBackup {
  if (!existsSync(path))
    throw new Error("USER.md repair backup was not found.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("USER.md repair backup is corrupt.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("USER.md repair backup is corrupt.");
  }
  const value = parsed as Partial<StoredRepairBackup>;
  if (
    value.schema !== REPAIR_SCHEMA ||
    value.version !== REPAIR_VERSION ||
    typeof value.operationId !== "string" ||
    typeof value.profileId !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.afterSha256 !== "string" ||
    !value.before ||
    typeof value.before.existed !== "boolean" ||
    typeof value.before.content !== "string" ||
    typeof value.before.sha256 !== "string" ||
    contentDigest(value.before.existed, value.before.content) !==
      value.before.sha256 ||
    !/^[0-9a-f]{64}$/.test(value.afterSha256)
  ) {
    throw new Error("USER.md repair backup is corrupt.");
  }
  return value as StoredRepairBackup;
}

function failure(error: unknown): { success: false; error: string } {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
