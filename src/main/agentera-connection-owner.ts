import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SecureStorageAdapter } from "./agentera-auth/store";
import type { AgenteraRuntimeOwner } from "./agentera-profile-binding";
import { safeWriteFile } from "./utils";

const CONNECTION_OWNER_SCHEMA = "agentera-connection-owners" as const;
const CONNECTION_OWNER_VERSION = 1 as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ConnectionOwnerBinding extends AgenteraRuntimeOwner {
  connectionContextId: string;
  ownerScope: "USER";
  boundAt: string;
}

interface ConnectionOwnerEnvelope {
  schema: typeof CONNECTION_OWNER_SCHEMA;
  version: typeof CONNECTION_OWNER_VERSION;
  encryptedBindings: string;
}

export interface ConnectionOwnerStoreOptions {
  userDataPath: string;
  secureStorage: SecureStorageAdapter;
  writeFile?: (path: string, content: string) => void;
  now?: () => Date;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function assertOwner(owner: AgenteraRuntimeOwner): void {
  if (
    !validUuid(owner.tenantId) ||
    !validUuid(owner.ownerId) ||
    !validUuid(owner.installationId)
  ) {
    throw new Error("AgentEra connection owner identity is invalid.");
  }
}

function validBinding(value: unknown): value is ConnectionOwnerBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ConnectionOwnerBinding>;
  return (
    validUuid(record.connectionContextId) &&
    validUuid(record.tenantId) &&
    record.ownerScope === "USER" &&
    validUuid(record.ownerId) &&
    validUuid(record.installationId) &&
    validIsoDate(record.boundAt)
  );
}

function sameOwner(
  binding: ConnectionOwnerBinding,
  owner: AgenteraRuntimeOwner,
): boolean {
  return (
    binding.tenantId === owner.tenantId &&
    binding.ownerId === owner.ownerId &&
    binding.installationId === owner.installationId
  );
}

export class AgenteraConnectionOwnerStore {
  readonly filePath: string;
  private readonly secureStorage: SecureStorageAdapter;
  private readonly writeFile: (path: string, content: string) => void;
  private readonly now: () => Date;

  constructor(options: ConnectionOwnerStoreOptions) {
    if (!isAbsolute(options.userDataPath)) {
      throw new Error("Electron userData path must be absolute.");
    }
    this.filePath = join(
      resolve(options.userDataPath),
      "agentera-auth",
      "connection-owners.json",
    );
    this.secureStorage = options.secureStorage;
    this.writeFile = options.writeFile ?? safeWriteFile;
    this.now = options.now ?? (() => new Date());
  }

  inspectConnectionContext(
    connectionContextId: string,
    owner: AgenteraRuntimeOwner,
  ):
    | { status: "unbound" }
    | {
        status: "owned";
        isCurrentOwner: boolean;
        binding: ConnectionOwnerBinding;
      } {
    this.assertContext(connectionContextId);
    assertOwner(owner);
    const binding = this.readBindings().find(
      (candidate) => candidate.connectionContextId === connectionContextId,
    );
    if (!binding) return { status: "unbound" };
    return {
      status: "owned",
      isCurrentOwner: sameOwner(binding, owner),
      binding: { ...binding },
    };
  }

  bindConnectionContext(
    connectionContextId: string,
    owner: AgenteraRuntimeOwner,
  ): ConnectionOwnerBinding {
    this.assertContext(connectionContextId);
    assertOwner(owner);
    const bindings = this.readBindings();
    const existing = bindings.find(
      (candidate) => candidate.connectionContextId === connectionContextId,
    );
    if (existing) {
      if (sameOwner(existing, owner)) return { ...existing };
      throw new Error(
        "This connection context cannot be reassigned to another AgentEra owner.",
      );
    }
    const binding: ConnectionOwnerBinding = {
      connectionContextId,
      tenantId: owner.tenantId,
      ownerScope: "USER",
      ownerId: owner.ownerId,
      installationId: owner.installationId,
      boundAt: this.now().toISOString(),
    };
    bindings.push(binding);
    this.persistBindings(bindings);
    return { ...binding };
  }

  verifyConnectionContext(
    connectionContextId: string,
    owner: AgenteraRuntimeOwner,
  ): ConnectionOwnerBinding {
    this.assertContext(connectionContextId);
    assertOwner(owner);
    const binding = this.readBindings().find(
      (candidate) => candidate.connectionContextId === connectionContextId,
    );
    if (!binding) {
      throw new Error("AgentEra connection context binding is required.");
    }
    if (!sameOwner(binding, owner)) {
      throw new Error(
        "This connection context belongs to another AgentEra owner.",
      );
    }
    return { ...binding };
  }

  private assertContext(connectionContextId: string): void {
    if (!validUuid(connectionContextId)) {
      throw new Error("AgentEra connection context ID is invalid.");
    }
  }

  private readBindings(): ConnectionOwnerBinding[] {
    if (!existsSync(this.filePath)) return [];
    let envelope: unknown;
    try {
      envelope = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      throw new Error("AgentEra connection ownership store is corrupt.");
    }
    if (
      !envelope ||
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      (envelope as Partial<ConnectionOwnerEnvelope>).schema !==
        CONNECTION_OWNER_SCHEMA ||
      (envelope as Partial<ConnectionOwnerEnvelope>).version !==
        CONNECTION_OWNER_VERSION ||
      typeof (envelope as Partial<ConnectionOwnerEnvelope>)
        .encryptedBindings !== "string"
    ) {
      throw new Error("AgentEra connection ownership store is corrupt.");
    }
    this.requireEncryption();
    let parsed: unknown;
    try {
      const decrypted = this.secureStorage.decryptString(
        Buffer.from(
          (envelope as ConnectionOwnerEnvelope).encryptedBindings,
          "base64",
        ),
      );
      parsed = JSON.parse(decrypted);
    } catch {
      throw new Error("AgentEra connection ownership store is corrupt.");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((binding) => !validBinding(binding))
    ) {
      throw new Error("AgentEra connection ownership store is corrupt.");
    }
    const bindings = parsed as ConnectionOwnerBinding[];
    if (
      new Set(bindings.map((binding) => binding.connectionContextId)).size !==
      bindings.length
    ) {
      throw new Error("AgentEra connection ownership store is corrupt.");
    }
    return bindings.map((binding) => ({ ...binding }));
  }

  private persistBindings(bindings: ConnectionOwnerBinding[]): void {
    this.requireEncryption();
    const encrypted = this.secureStorage.encryptString(
      JSON.stringify(bindings),
    );
    const envelope: ConnectionOwnerEnvelope = {
      schema: CONNECTION_OWNER_SCHEMA,
      version: CONNECTION_OWNER_VERSION,
      encryptedBindings: encrypted.toString("base64"),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.writeFile(this.filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  }

  private requireEncryption(): void {
    if (!this.secureStorage.isEncryptionAvailable()) {
      throw new Error(
        "AgentEra secure storage is unavailable for connection ownership metadata.",
      );
    }
  }
}

export interface AgenteraOwnerSwitchCoordinator {
  transitionTo(ownerId: string | null): void;
}

export function createAgenteraOwnerSwitchCoordinator(options: {
  stopRuntimeContext: () => void;
}): AgenteraOwnerSwitchCoordinator {
  let activeOwnerId: string | null = null;
  return {
    transitionTo(ownerId: string | null): void {
      if (activeOwnerId !== null && activeOwnerId !== ownerId) {
        options.stopRuntimeContext();
      }
      activeOwnerId = ownerId;
    },
  };
}
