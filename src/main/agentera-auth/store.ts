import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { safeWriteFile } from "../utils";

const STORE_SCHEMA = "agentera-product-auth" as const;
const STORE_VERSION = 1 as const;

export interface SecureStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface InstallationRecord {
  installationId: string;
  devicePublicKey: string;
  encryptedDevicePrivateKey: string;
}

export interface ProductSessionRecord {
  userId: string;
  personalSpaceId: string;
  deviceId: string;
  encryptedRefreshToken: string;
  encryptedOfflineEntitlement: string;
  offlineExpiresAt: string;
  lastTrustedServerTime: string;
}

interface StoredAuthEnvelope {
  schema: typeof STORE_SCHEMA;
  version: typeof STORE_VERSION;
  installation: InstallationRecord | null;
  productSession: ProductSessionRecord | null;
  encryptedPendingRevocation: string | null;
}

export interface InstallationIdentity {
  installationId: string;
  devicePublicKey: string;
  devicePrivateKey: string;
}

export interface ProductSession {
  userId: string;
  personalSpaceId: string;
  deviceId: string;
  refreshToken: string;
  offlineEntitlement: string;
  offlineExpiresAt: string;
  lastTrustedServerTime: string;
}

export interface PendingSelfRevocation {
  deviceId: string;
  installationId: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export interface AgenteraAuthStoreOptions {
  userDataPath: string;
  secureStorage: SecureStorageAdapter;
  writeFile?: (path: string, content: string) => void;
}

export interface ElectronUserDataPathAdapter {
  getPath(name: "userData"): string;
}

export function createAgenteraAuthStoreForApp(
  app: ElectronUserDataPathAdapter,
  secureStorage: SecureStorageAdapter,
  writeFile?: (path: string, content: string) => void,
): AgenteraAuthStore {
  return new AgenteraAuthStore({
    userDataPath: app.getPath("userData"),
    secureStorage,
    writeFile,
  });
}

function emptyEnvelope(): StoredAuthEnvelope {
  return {
    schema: STORE_SCHEMA,
    version: STORE_VERSION,
    installation: null,
    productSession: null,
    encryptedPendingRevocation: null,
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function validInstallationRecord(value: unknown): value is InstallationRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<InstallationRecord>;
  return (
    nonEmpty(record.installationId) &&
    nonEmpty(record.devicePublicKey) &&
    nonEmpty(record.encryptedDevicePrivateKey)
  );
}

function validProductSessionRecord(
  value: unknown,
): value is ProductSessionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ProductSessionRecord>;
  return (
    nonEmpty(record.userId) &&
    nonEmpty(record.personalSpaceId) &&
    nonEmpty(record.deviceId) &&
    nonEmpty(record.encryptedRefreshToken) &&
    nonEmpty(record.encryptedOfflineEntitlement) &&
    nonEmpty(record.offlineExpiresAt) &&
    nonEmpty(record.lastTrustedServerTime)
  );
}

function validPendingSelfRevocation(
  value: unknown,
): value is PendingSelfRevocation {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PendingSelfRevocation>;
  return (
    nonEmpty(record.deviceId) &&
    nonEmpty(record.installationId) &&
    nonEmpty(record.timestamp) &&
    nonEmpty(record.nonce) &&
    nonEmpty(record.signature)
  );
}

export class AgenteraAuthStore {
  readonly filePath: string;
  private readonly secureStorage: SecureStorageAdapter;
  private readonly writeFile: (path: string, content: string) => void;

  constructor(options: AgenteraAuthStoreOptions) {
    if (!nonEmpty(options.userDataPath)) {
      throw new Error(
        "Electron userData path is required for AgentEra auth storage.",
      );
    }
    if (!isAbsolute(options.userDataPath)) {
      throw new Error("Electron userData path must be absolute.");
    }
    const userDataPath = resolve(options.userDataPath);
    this.filePath = join(userDataPath, "agentera-auth", "state.json");
    this.secureStorage = options.secureStorage;
    this.writeFile =
      options.writeFile ??
      ((path, content) => {
        safeWriteFile(path, content, 0o600);
      });
  }

  getInstallation(): InstallationIdentity | null {
    const record = this.readEnvelope().installation;
    if (!record) return null;
    return {
      installationId: record.installationId,
      devicePublicKey: record.devicePublicKey,
      devicePrivateKey: this.decrypt(record.encryptedDevicePrivateKey),
    };
  }

  saveInstallation(identity: InstallationIdentity): void {
    if (
      !nonEmpty(identity.installationId) ||
      !nonEmpty(identity.devicePublicKey) ||
      !nonEmpty(identity.devicePrivateKey)
    ) {
      throw new Error("AgentEra installation identity is incomplete.");
    }
    const envelope = this.readEnvelope();
    envelope.installation = {
      installationId: identity.installationId,
      devicePublicKey: identity.devicePublicKey,
      encryptedDevicePrivateKey: this.encrypt(identity.devicePrivateKey),
    };
    this.persist(envelope);
  }

  getProductSession(): ProductSession | null {
    const record = this.readEnvelope().productSession;
    if (!record) return null;
    return {
      userId: record.userId,
      personalSpaceId: record.personalSpaceId,
      deviceId: record.deviceId,
      refreshToken: this.decrypt(record.encryptedRefreshToken),
      offlineEntitlement: this.decrypt(record.encryptedOfflineEntitlement),
      offlineExpiresAt: record.offlineExpiresAt,
      lastTrustedServerTime: record.lastTrustedServerTime,
    };
  }

  getPendingRevocation(): PendingSelfRevocation | null {
    const encrypted = this.readEnvelope().encryptedPendingRevocation;
    if (!encrypted) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.decrypt(encrypted));
    } catch {
      throw new Error("AgentEra pending revocation record is corrupt.");
    }
    if (!validPendingSelfRevocation(parsed)) {
      throw new Error("AgentEra pending revocation record is corrupt.");
    }
    return {
      deviceId: parsed.deviceId,
      installationId: parsed.installationId,
      timestamp: parsed.timestamp,
      nonce: parsed.nonce,
      signature: parsed.signature,
    };
  }

  replaceProductSession(
    session: ProductSession | null,
    pendingRevocation: PendingSelfRevocation | null,
  ): void {
    const envelope = this.readEnvelope();
    envelope.productSession = session ? this.encryptSession(session) : null;
    envelope.encryptedPendingRevocation = pendingRevocation
      ? this.encryptPendingRevocation(pendingRevocation)
      : null;
    this.persist(envelope);
  }

  clearProductSession(
    pendingRevocation: PendingSelfRevocation | null = null,
  ): void {
    this.replaceProductSession(null, pendingRevocation);
  }

  clearPendingRevocation(): void {
    const envelope = this.readEnvelope();
    envelope.encryptedPendingRevocation = null;
    this.persist(envelope);
  }

  private encryptSession(session: ProductSession): ProductSessionRecord {
    if (
      !nonEmpty(session.userId) ||
      !nonEmpty(session.personalSpaceId) ||
      !nonEmpty(session.deviceId) ||
      !nonEmpty(session.refreshToken) ||
      !nonEmpty(session.offlineEntitlement) ||
      !nonEmpty(session.offlineExpiresAt) ||
      !nonEmpty(session.lastTrustedServerTime)
    ) {
      throw new Error("AgentEra product session is incomplete.");
    }
    return {
      userId: session.userId,
      personalSpaceId: session.personalSpaceId,
      deviceId: session.deviceId,
      encryptedRefreshToken: this.encrypt(session.refreshToken),
      encryptedOfflineEntitlement: this.encrypt(session.offlineEntitlement),
      offlineExpiresAt: session.offlineExpiresAt,
      lastTrustedServerTime: session.lastTrustedServerTime,
    };
  }

  private encryptPendingRevocation(
    pendingRevocation: PendingSelfRevocation,
  ): string {
    if (!validPendingSelfRevocation(pendingRevocation)) {
      throw new Error("AgentEra pending revocation record is incomplete.");
    }
    return this.encrypt(
      JSON.stringify({
        deviceId: pendingRevocation.deviceId,
        installationId: pendingRevocation.installationId,
        timestamp: pendingRevocation.timestamp,
        nonce: pendingRevocation.nonce,
        signature: pendingRevocation.signature,
      }),
    );
  }

  private encryptionAvailable(): boolean {
    try {
      return this.secureStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private encrypt(plaintext: string): string {
    if (!this.encryptionAvailable()) {
      throw new Error(
        "Secure storage is unavailable for AgentEra authentication.",
      );
    }
    let encrypted: Buffer;
    try {
      encrypted = this.secureStorage.encryptString(plaintext);
    } catch {
      throw new Error(
        "Secure storage could not protect AgentEra authentication.",
      );
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      throw new Error("Secure storage returned an invalid encrypted value.");
    }
    return encrypted.toString("base64");
  }

  private decrypt(encoded: string): string {
    if (!this.encryptionAvailable()) {
      throw new Error(
        "Secure storage is unavailable for AgentEra authentication.",
      );
    }
    const encrypted = Buffer.from(encoded, "base64");
    if (encrypted.length === 0 || encrypted.toString("base64") !== encoded) {
      throw new Error("AgentEra encrypted authentication value is corrupt.");
    }
    try {
      return this.secureStorage.decryptString(encrypted);
    } catch {
      throw new Error(
        "AgentEra encrypted authentication value could not be opened.",
      );
    }
  }

  private readEnvelope(): StoredAuthEnvelope {
    if (!existsSync(this.filePath)) return emptyEnvelope();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      throw new Error("AgentEra authentication store is corrupt.");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("AgentEra authentication store is corrupt.");
    }
    const envelope = parsed as Partial<StoredAuthEnvelope>;
    if (
      envelope.schema !== STORE_SCHEMA ||
      envelope.version !== STORE_VERSION ||
      (envelope.installation !== null &&
        !validInstallationRecord(envelope.installation)) ||
      (envelope.productSession !== null &&
        !validProductSessionRecord(envelope.productSession)) ||
      (envelope.encryptedPendingRevocation !== null &&
        !nonEmpty(envelope.encryptedPendingRevocation))
    ) {
      throw new Error("AgentEra authentication store is corrupt.");
    }
    return {
      schema: STORE_SCHEMA,
      version: STORE_VERSION,
      installation: envelope.installation ?? null,
      productSession: envelope.productSession ?? null,
      encryptedPendingRevocation: envelope.encryptedPendingRevocation ?? null,
    };
  }

  private persist(envelope: StoredAuthEnvelope): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.writeFile(this.filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  }
}
