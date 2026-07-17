import { randomUUID as nodeRandomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SecureStorageAdapter } from "./agentera-auth/store";
import { safeWriteFile } from "./utils";

const PROFILE_BINDING_SCHEMA = "agentera-runtime-profile-bindings" as const;
const PROFILE_BINDING_VERSION = 1 as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AgenteraRuntimeOwner {
  tenantId: string;
  ownerId: string;
  installationId: string;
}

export interface RuntimeOwnerBinding {
  tenantId: string;
  ownerScope: "USER";
  ownerId: string;
  installationId: string;
  runtimeProfileId: string;
  boundAt: string;
}

interface StoredProfileBinding {
  profilePath: string;
  binding: RuntimeOwnerBinding;
}

interface BindingEnvelope {
  schema: typeof PROFILE_BINDING_SCHEMA;
  version: typeof PROFILE_BINDING_VERSION;
  encryptedBindings: string;
}

export interface ProfileBindingStoreOptions {
  userDataPath: string;
  secureStorage: SecureStorageAdapter;
  writeFile?: (path: string, content: string) => void;
  now?: () => Date;
  randomUUID?: () => string;
}

export interface ProfileCreationResult {
  success: boolean;
  error?: string;
  id?: string;
}

export interface FreshProfileBindingRequest {
  name: string;
  owner: AgenteraRuntimeOwner;
  createProfile: (
    name: string,
    cloneFrom: string | null,
  ) => ProfileCreationResult;
  resolveProfilePath: (profileId: string) => string;
}

export type ProfileClaimInspection =
  | { status: "unbound"; meaningfulData: boolean }
  | {
      status: "owned";
      meaningfulData: boolean;
      isCurrentOwner: boolean;
      binding: RuntimeOwnerBinding;
    };

const PRIVATE_PROFILE_MARKERS = [
  ".env",
  "auth.json",
  "MEMORY.md",
  "USER.md",
  "sessions",
  "files",
  "skills",
  "curator",
  ".curator",
] as const;

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function assertOwner(owner: AgenteraRuntimeOwner): void {
  if (
    !validUuid(owner.tenantId) ||
    !validUuid(owner.ownerId) ||
    !validUuid(owner.installationId)
  ) {
    throw new Error("AgentEra Runtime owner identity is invalid.");
  }
}

function validBinding(value: unknown): value is RuntimeOwnerBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<RuntimeOwnerBinding>;
  const boundAt =
    typeof record.boundAt === "string" ? new Date(record.boundAt) : null;
  return (
    validUuid(record.tenantId) &&
    record.ownerScope === "USER" &&
    validUuid(record.ownerId) &&
    validUuid(record.installationId) &&
    validUuid(record.runtimeProfileId) &&
    boundAt !== null &&
    Number.isFinite(boundAt.getTime()) &&
    boundAt.toISOString() === record.boundAt
  );
}

function canonicalProfilePath(profilePath: string): string {
  if (typeof profilePath !== "string" || !isAbsolute(profilePath)) {
    throw new Error("AgentEra Runtime Profile path must be absolute.");
  }
  let canonical: string;
  try {
    canonical = resolve(realpathSync.native(profilePath));
  } catch {
    throw new Error("AgentEra Runtime Profile path does not exist.");
  }
  if (!statSync(canonical).isDirectory()) {
    throw new Error("AgentEra Runtime Profile path must be a directory.");
  }
  return canonical;
}

function markerHasData(markerPath: string): boolean {
  let stats;
  try {
    stats = lstatSync(markerPath);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) return true;
  if (stats.isFile()) return stats.size > 0;
  if (!stats.isDirectory()) return false;
  try {
    return readdirSync(markerPath).length > 0;
  } catch {
    return true;
  }
}

/**
 * Detect only approved local metadata markers. File contents are never opened,
 * parsed, hashed for upload, copied, or returned.
 */
export function hasMeaningfulHermesProfileData(profilePath: string): boolean {
  const canonical = canonicalProfilePath(profilePath);
  return PRIVATE_PROFILE_MARKERS.some((marker) =>
    markerHasData(join(canonical, marker)),
  );
}

function sameOwner(
  binding: RuntimeOwnerBinding,
  owner: AgenteraRuntimeOwner,
): boolean {
  return (
    binding.tenantId === owner.tenantId &&
    binding.ownerId === owner.ownerId &&
    binding.installationId === owner.installationId
  );
}

export class AgenteraProfileBindingStore {
  readonly filePath: string;
  private readonly secureStorage: SecureStorageAdapter;
  private readonly writeFile: (path: string, content: string) => void;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(options: ProfileBindingStoreOptions) {
    if (!isAbsolute(options.userDataPath)) {
      throw new Error("Electron userData path must be absolute.");
    }
    this.filePath = join(
      resolve(options.userDataPath),
      "agentera-auth",
      "profile-bindings.json",
    );
    this.secureStorage = options.secureStorage;
    this.writeFile = options.writeFile ?? safeWriteFile;
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  inspectProfile(
    profilePath: string,
    owner: AgenteraRuntimeOwner,
  ): ProfileClaimInspection {
    assertOwner(owner);
    const canonical = canonicalProfilePath(profilePath);
    const stored = this.readBindings().find(
      (entry) => entry.profilePath === canonical,
    );
    const meaningfulData = hasMeaningfulHermesProfileData(canonical);
    if (!stored) return { status: "unbound", meaningfulData };
    return {
      status: "owned",
      meaningfulData,
      isCurrentOwner: sameOwner(stored.binding, owner),
      binding: { ...stored.binding },
    };
  }

  bindExistingProfile(
    profilePath: string,
    owner: AgenteraRuntimeOwner,
  ): RuntimeOwnerBinding {
    assertOwner(owner);
    const canonical = canonicalProfilePath(profilePath);
    const bindings = this.readBindings();
    const existing = bindings.find((entry) => entry.profilePath === canonical);
    if (existing) {
      if (sameOwner(existing.binding, owner)) return { ...existing.binding };
      throw new Error(
        "This physical Runtime Profile cannot be reassigned to another AgentEra owner.",
      );
    }

    const runtimeProfileId = this.randomUUID();
    if (!validUuid(runtimeProfileId)) {
      throw new Error("AgentEra Runtime Profile ID generation failed.");
    }
    const binding: RuntimeOwnerBinding = {
      tenantId: owner.tenantId,
      ownerScope: "USER",
      ownerId: owner.ownerId,
      installationId: owner.installationId,
      runtimeProfileId,
      boundAt: this.now().toISOString(),
    };
    bindings.push({ profilePath: canonical, binding });
    this.persistBindings(bindings);
    return { ...binding };
  }

  createAndBindFreshProfile(request: FreshProfileBindingRequest): {
    profileId: string;
    binding: RuntimeOwnerBinding;
  } {
    assertOwner(request.owner);
    // This is deliberately the only call shape: no source Profile or private
    // path can enter the generic Hermes cloning argument.
    const created = request.createProfile(request.name, null);
    if (!created.success || !created.id) {
      throw new Error(
        created.error || "Fresh Runtime Profile creation failed.",
      );
    }
    const profilePath = request.resolveProfilePath(created.id);
    if (hasMeaningfulHermesProfileData(profilePath)) {
      throw new Error(
        "Fresh Runtime Profile creation unexpectedly produced private data.",
      );
    }
    return {
      profileId: created.id,
      binding: this.bindExistingProfile(profilePath, request.owner),
    };
  }

  listUnboundProfiles<T extends { path: string }>(profiles: T[]): T[] {
    const boundPaths = new Set(
      this.readBindings().map((entry) => entry.profilePath),
    );
    return profiles.filter((profile) => {
      try {
        return !boundPaths.has(canonicalProfilePath(profile.path));
      } catch {
        return false;
      }
    });
  }

  verifyProfileBinding(
    profilePath: string,
    owner: AgenteraRuntimeOwner,
  ): RuntimeOwnerBinding {
    assertOwner(owner);
    const canonical = canonicalProfilePath(profilePath);
    const stored = this.readBindings().find(
      (entry) => entry.profilePath === canonical,
    );
    if (!stored) {
      throw new Error("AgentEra Runtime Profile binding is required.");
    }
    if (!sameOwner(stored.binding, owner)) {
      throw new Error(
        "This Runtime Profile belongs to another AgentEra owner.",
      );
    }
    return { ...stored.binding };
  }

  private readBindings(): StoredProfileBinding[] {
    if (!existsSync(this.filePath)) return [];
    let envelope: unknown;
    try {
      envelope = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      throw new Error("AgentEra Runtime Profile binding store is corrupt.");
    }
    if (
      !envelope ||
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      (envelope as Partial<BindingEnvelope>).schema !==
        PROFILE_BINDING_SCHEMA ||
      (envelope as Partial<BindingEnvelope>).version !==
        PROFILE_BINDING_VERSION ||
      typeof (envelope as Partial<BindingEnvelope>).encryptedBindings !==
        "string"
    ) {
      throw new Error("AgentEra Runtime Profile binding store is corrupt.");
    }
    this.requireEncryption();
    let parsed: unknown;
    try {
      const plaintext = this.secureStorage.decryptString(
        Buffer.from((envelope as BindingEnvelope).encryptedBindings, "base64"),
      );
      parsed = JSON.parse(plaintext);
    } catch {
      throw new Error("AgentEra Runtime Profile binding store is corrupt.");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          typeof (entry as Partial<StoredProfileBinding>).profilePath !==
            "string" ||
          !isAbsolute(
            (entry as Partial<StoredProfileBinding>).profilePath as string,
          ) ||
          !validBinding((entry as Partial<StoredProfileBinding>).binding),
      )
    ) {
      throw new Error("AgentEra Runtime Profile binding store is corrupt.");
    }
    const bindings = parsed as StoredProfileBinding[];
    if (
      new Set(bindings.map((entry) => entry.profilePath)).size !==
      bindings.length
    ) {
      throw new Error("AgentEra Runtime Profile binding store is corrupt.");
    }
    return bindings.map((entry) => ({
      profilePath: entry.profilePath,
      binding: { ...entry.binding },
    }));
  }

  private persistBindings(bindings: StoredProfileBinding[]): void {
    this.requireEncryption();
    const encrypted = this.secureStorage.encryptString(
      JSON.stringify(bindings),
    );
    const envelope: BindingEnvelope = {
      schema: PROFILE_BINDING_SCHEMA,
      version: PROFILE_BINDING_VERSION,
      encryptedBindings: encrypted.toString("base64"),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.writeFile(this.filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  }

  private requireEncryption(): void {
    if (!this.secureStorage.isEncryptionAvailable()) {
      throw new Error(
        "AgentEra secure storage is unavailable for Runtime ownership metadata.",
      );
    }
  }
}
