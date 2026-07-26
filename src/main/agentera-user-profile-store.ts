import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { safeWriteFile } from "./utils";
import {
  type AgenteraUserProfile,
  type AgenteraUserProfileInput,
} from "../shared/agentera-user-profile";

const STORE_SCHEMA = "agentera-local-user-profiles" as const;
const STORE_VERSION = 1 as const;
const USER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AVATAR_BYTES = 256 * 1024;
const AVATAR_RE = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/;

interface StoredUserProfile extends AgenteraUserProfile {
  updatedAt: string;
}

interface StoreEnvelope {
  schema: typeof STORE_SCHEMA;
  version: typeof STORE_VERSION;
  profiles: Record<string, StoredUserProfile>;
}

export interface AgenteraUserProfileStoreOptions {
  userDataPath: string;
  now?: () => Date;
  writeFile?: (path: string, content: string) => void;
}

function emptyEnvelope(): StoreEnvelope {
  return { schema: STORE_SCHEMA, version: STORE_VERSION, profiles: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(
  value: unknown,
  field: string,
  maximum: number,
  allowNewlines = false,
): string {
  if (typeof value !== "string") {
    throw new Error(`AgentEra user profile ${field} is invalid.`);
  }
  const normalized = value.trim().replace(/\r\n?/g, "\n");
  if (Array.from(normalized).length > maximum) {
    throw new Error(`AgentEra user profile ${field} is too long.`);
  }
  for (const character of normalized) {
    if (
      character < " " &&
      !(allowNewlines && (character === "\n" || character === "\t"))
    ) {
      throw new Error(`AgentEra user profile ${field} contains control text.`);
    }
  }
  return normalized;
}

function normalizeUserId(userId: unknown): string {
  if (typeof userId !== "string" || !USER_ID_RE.test(userId)) {
    throw new Error("AgentEra user profile owner is invalid.");
  }
  return userId.toLowerCase();
}

function normalizeAvatar(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error("AgentEra user profile avatar is invalid.");
  }
  const match = AVATAR_RE.exec(value);
  if (!match) {
    throw new Error("AgentEra user profile avatar is invalid.");
  }
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) {
    throw new Error("AgentEra user profile avatar is too large.");
  }
  return value;
}

function normalizeInput(input: unknown): AgenteraUserProfileInput {
  if (!isRecord(input)) {
    throw new Error("AgentEra user profile input is invalid.");
  }
  const displayName = normalizeText(input.displayName, "display name", 80);
  if (!displayName) {
    throw new Error("AgentEra user profile display name is required.");
  }
  return {
    displayName,
    occupation: normalizeText(input.occupation, "occupation", 80),
    bio: normalizeText(input.bio, "bio", 500, true),
    avatarDataUrl: normalizeAvatar(input.avatarDataUrl),
  };
}

function validStoredProfile(value: unknown): value is StoredUserProfile {
  if (!isRecord(value)) return false;
  try {
    const userId = normalizeUserId(value.userId);
    const input = normalizeInput({
      displayName: value.displayName,
      occupation: value.occupation,
      bio: value.bio,
      avatarDataUrl: value.avatarDataUrl,
    });
    return (
      userId === value.userId &&
      typeof value.updatedAt === "string" &&
      Number.isFinite(Date.parse(value.updatedAt)) &&
      value.updatedAt === new Date(value.updatedAt).toISOString() &&
      input.displayName === value.displayName &&
      input.occupation === value.occupation &&
      input.bio === value.bio &&
      input.avatarDataUrl === value.avatarDataUrl
    );
  } catch {
    return false;
  }
}

export class AgenteraUserProfileStore {
  readonly filePath: string;
  private readonly now: () => Date;
  private readonly writeFile: (path: string, content: string) => void;

  constructor(options: AgenteraUserProfileStoreOptions) {
    if (!isAbsolute(options.userDataPath)) {
      throw new Error("AgentEra user profile userData path must be absolute.");
    }
    const userDataPath = resolve(options.userDataPath);
    this.filePath = join(
      userDataPath,
      "agentera-account-profile",
      "profiles.json",
    );
    this.now = options.now ?? (() => new Date());
    this.writeFile =
      options.writeFile ??
      ((path, content) => safeWriteFile(path, content, 0o600));
  }

  get(userId: string): AgenteraUserProfile | null {
    const normalizedUserId = normalizeUserId(userId);
    const profile = this.readEnvelope().profiles[normalizedUserId];
    return profile ? { ...profile } : null;
  }

  getOrCreate(userId: string): AgenteraUserProfile {
    const normalizedUserId = normalizeUserId(userId);
    return (
      this.get(normalizedUserId) ?? {
        userId: normalizedUserId,
        displayName: "",
        occupation: "",
        bio: "",
        avatarDataUrl: null,
        updatedAt: null,
      }
    );
  }

  save(
    userId: string,
    rawInput: AgenteraUserProfileInput,
  ): AgenteraUserProfile {
    const normalizedUserId = normalizeUserId(userId);
    const input = normalizeInput(rawInput);
    const timestamp = this.now();
    if (!Number.isFinite(timestamp.getTime())) {
      throw new Error("AgentEra user profile clock is invalid.");
    }
    const profile: StoredUserProfile = {
      userId: normalizedUserId,
      ...input,
      updatedAt: timestamp.toISOString(),
    };
    const envelope = this.readEnvelope();
    envelope.profiles[normalizedUserId] = profile;
    this.persist(envelope);
    return { ...profile };
  }

  private readEnvelope(): StoreEnvelope {
    if (!existsSync(this.filePath)) return emptyEnvelope();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      throw new Error("AgentEra local user profile store is corrupt.");
    }
    if (!isRecord(parsed)) {
      throw new Error("AgentEra local user profile store is corrupt.");
    }
    if (
      parsed.schema !== STORE_SCHEMA ||
      parsed.version !== STORE_VERSION ||
      !isRecord(parsed.profiles)
    ) {
      throw new Error("AgentEra local user profile store is unsupported.");
    }
    const profiles: Record<string, StoredUserProfile> = {};
    for (const [userId, value] of Object.entries(parsed.profiles)) {
      if (!USER_ID_RE.test(userId) || !validStoredProfile(value)) {
        throw new Error("AgentEra local user profile store is corrupt.");
      }
      profiles[userId.toLowerCase()] = { ...value };
    }
    return { schema: STORE_SCHEMA, version: STORE_VERSION, profiles };
  }

  private persist(envelope: StoreEnvelope): void {
    this.writeFile(this.filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  }
}
