import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify as verifySignature,
} from "node:crypto";
import type { components } from "../../shared/agentera-cloud-api.generated";
import {
  agenteraCloudUrl,
  parseAgenteraCloudOrigin,
} from "../agentera-auth/config";
import type { InstallationIdentity } from "../agentera-auth/store";

const DEFAULT_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const KEY_RESPONSE_LIMIT = 256 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type AgentDefinition = components["schemas"]["AgentDefinition"];
export type AgentVersion = components["schemas"]["AgentVersion"];
export type AgentPolicySnapshot = components["schemas"]["AgentPolicySnapshot"];
export type AgentInstallation = components["schemas"]["AgentInstallation"];
export type AgentPublication = components["schemas"]["AgentPublication"];
export type AgentInstallationCreation =
  components["schemas"]["AgentInstallationCreation"];
export type AgentVersionRevocation =
  components["schemas"]["AgentVersionRevocation"];
export type RuntimeBindingRecord =
  components["schemas"]["RuntimeBindingRecord"];
export type AgentSigningKeySet = components["schemas"]["SigningKeySet"];
export type PublishInitialAgentRequest =
  components["schemas"]["PublishInitialAgentRequest"];
export type PublishNextAgentVersionRequest =
  components["schemas"]["PublishNextAgentVersionRequest"];
export type RevokeAgentVersionRequest =
  components["schemas"]["RevokeAgentVersionRequest"];
export type CreateAgentInstallationRequest =
  components["schemas"]["CreateAgentInstallationRequest"];
export type CreateRuntimeBindingRecordRequest =
  components["schemas"]["CreateRuntimeBindingRecordRequest"];

type StableErrorCode = components["schemas"]["ErrorCode"];

const STABLE_ERROR_CODES: ReadonlySet<StableErrorCode> = new Set([
  "invalid_request",
  "verification_required",
  "identity_conflict",
  "invalid_credentials",
  "device_limit_reached",
  "authorization_expired",
  "authorization_replayed",
  "session_revoked",
  "account_pending_deletion",
  "account_disabled",
  "last_identity",
  "deletion_window_expired",
  "account_not_found",
  "device_not_found",
  "self_revoke_replayed",
  "invalid_agent_content",
  "runtime_incompatible",
  "invalid_device_proof",
  "not_found",
  "version_conflict",
  "idempotency_conflict",
  "definition_archived",
  "version_revoked",
  "activation_conflict",
  "installation_archived",
  "service_unavailable",
]);

export interface AgenteraAgentControlClientOptions {
  origin: string;
  getAccessToken: () => string | null;
  getInstallationIdentity: () => InstallationIdentity | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export class AgenteraAgentControlClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`AgentEra Agent control request failed: ${code}.`);
    this.name = "AgenteraAgentControlClientError";
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
  authenticated?: boolean;
  responseLimit?: number;
  expectedStatus: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    keys.every((field) => allowed.has(field))
  );
}

function isUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    Number.isFinite(new Date(value).getTime())
  );
}

function isBoundedString(
  value: unknown,
  minimum = 1,
  maximum = 4096,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 512 &&
    value.every((item) => isBoundedString(item, 1, 512))
  );
}

function isRuntimeCompatibility(value: unknown): boolean {
  return (
    hasExactFields(value, ["minimum_version"], ["maximum_version_exclusive"]) &&
    isBoundedString(value.minimum_version, 1, 64) &&
    (value.maximum_version_exclusive === undefined ||
      value.maximum_version_exclusive === null ||
      isBoundedString(value.maximum_version_exclusive, 1, 64))
  );
}

function isModelConstraints(value: unknown): boolean {
  return (
    hasExactFields(value, ["allowed_models", "allowed_providers"]) &&
    isStringArray(value.allowed_models) &&
    value.allowed_models.length > 0 &&
    isStringArray(value.allowed_providers) &&
    value.allowed_providers.length > 0
  );
}

function isToolPolicy(value: unknown): boolean {
  return (
    hasExactFields(value, ["allowed", "denied"]) &&
    isStringArray(value.allowed) &&
    isStringArray(value.denied)
  );
}

function isManifest(value: unknown): boolean {
  if (
    !hasExactFields(value, [
      "assets",
      "dependencies",
      "identity",
      "model_constraints",
      "runtime_compatibility",
      "schema_version",
      "tools",
    ]) ||
    value.schema_version !== 1 ||
    !hasExactFields(value.identity, ["system_prompt"]) ||
    !isBoundedString(value.identity.system_prompt, 1, 262_144) ||
    !isModelConstraints(value.model_constraints) ||
    !isRuntimeCompatibility(value.runtime_compatibility) ||
    !isToolPolicy(value.tools) ||
    !Array.isArray(value.assets) ||
    value.assets.length > 128 ||
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > 128
  ) {
    return false;
  }
  if (
    !value.assets.every(
      (asset) =>
        hasExactFields(asset, ["kind", "media_type", "path", "sha256"]) &&
        (asset.kind === "skill" ||
          asset.kind === "sop" ||
          asset.kind === "knowledge") &&
        (asset.media_type === "text/markdown" ||
          asset.media_type === "text/plain") &&
        isBoundedString(asset.path, 1, 512) &&
        isDigest(asset.sha256),
    )
  ) {
    return false;
  }
  return value.dependencies.every(
    (dependency) =>
      hasExactFields(dependency, ["agent_definition_id", "agent_version_id"]) &&
      isUUID(dependency.agent_definition_id) &&
      isUUID(dependency.agent_version_id),
  );
}

function isBundle(value: unknown): boolean {
  return (
    hasExactFields(value, ["assets"]) &&
    Array.isArray(value.assets) &&
    value.assets.length <= 128 &&
    value.assets.every(
      (asset) =>
        hasExactFields(asset, ["content", "path"]) &&
        typeof asset.content === "string" &&
        Buffer.byteLength(asset.content, "utf8") <= 262_144 &&
        isBoundedString(asset.path, 1, 512),
    )
  );
}

function isDefinition(value: unknown): value is AgentDefinition {
  if (
    !hasExactFields(
      value,
      ["created_at", "display_name", "id", "status", "updated_at"],
      ["icon_data", "icon_media_type", "latest_version_id"],
    ) ||
    !isUUID(value.id) ||
    !isBoundedString(value.display_name, 1, 100) ||
    (value.status !== "active" && value.status !== "archived") ||
    !isTimestamp(value.created_at) ||
    !isTimestamp(value.updated_at) ||
    (value.latest_version_id !== undefined && !isUUID(value.latest_version_id))
  ) {
    return false;
  }
  const hasIconType = value.icon_media_type !== undefined;
  const hasIconData = value.icon_data !== undefined;
  return (
    hasIconType === hasIconData &&
    (!hasIconType ||
      ((value.icon_media_type === "image/png" ||
        value.icon_media_type === "image/webp") &&
        isBoundedString(value.icon_data, 1, 699_051) &&
        /^[A-Za-z0-9_-]+$/.test(value.icon_data)))
  );
}

function isVersion(value: unknown): value is AgentVersion {
  return (
    hasExactFields(
      value,
      [
        "bundle",
        "content_digest",
        "definition_id",
        "id",
        "manifest",
        "published_at",
        "runtime_minimum_version",
        "signature",
        "signing_key_id",
        "version_number",
      ],
      ["runtime_maximum_version_exclusive"],
    ) &&
    isUUID(value.id) &&
    isUUID(value.definition_id) &&
    Number.isSafeInteger(value.version_number) &&
    Number(value.version_number) > 0 &&
    isManifest(value.manifest) &&
    isBundle(value.bundle) &&
    isDigest(value.content_digest) &&
    isBoundedString(value.signing_key_id, 1, 128) &&
    typeof value.signature === "string" &&
    BASE64URL_SIGNATURE_PATTERN.test(value.signature) &&
    isBoundedString(value.runtime_minimum_version, 1, 64) &&
    (value.runtime_maximum_version_exclusive === undefined ||
      isBoundedString(value.runtime_maximum_version_exclusive, 1, 64)) &&
    isTimestamp(value.published_at)
  );
}

function isPolicyDocument(value: unknown): boolean {
  return (
    hasExactFields(value, [
      "agent_definition_id",
      "agent_version_id",
      "deny_rules",
      "model_constraints",
      "publication_allowed",
      "runtime_compatibility",
      "schema_version",
      "tools",
      "version_digest",
    ]) &&
    value.schema_version === 1 &&
    isUUID(value.agent_definition_id) &&
    isUUID(value.agent_version_id) &&
    isDigest(value.version_digest) &&
    isModelConstraints(value.model_constraints) &&
    isToolPolicy(value.tools) &&
    isRuntimeCompatibility(value.runtime_compatibility) &&
    value.publication_allowed === false &&
    isStringArray(value.deny_rules)
  );
}

function isPolicy(value: unknown): value is AgentPolicySnapshot {
  return (
    hasExactFields(value, [
      "agent_version_id",
      "content_digest",
      "created_at",
      "document",
      "id",
      "installation_id",
      "issuer",
      "policy_version",
      "signature",
      "signing_key_id",
    ]) &&
    isUUID(value.id) &&
    isUUID(value.installation_id) &&
    isUUID(value.agent_version_id) &&
    Number.isSafeInteger(value.policy_version) &&
    Number(value.policy_version) > 0 &&
    isPolicyDocument(value.document) &&
    isDigest(value.content_digest) &&
    isBoundedString(value.issuer, 1, 2048) &&
    isBoundedString(value.signing_key_id, 1, 128) &&
    typeof value.signature === "string" &&
    BASE64URL_SIGNATURE_PATTERN.test(value.signature) &&
    isTimestamp(value.created_at)
  );
}

function isInstallation(value: unknown): value is AgentInstallation {
  return (
    hasExactFields(
      value,
      [
        "created_at",
        "definition_id",
        "id",
        "selected_version_id",
        "status",
        "update_policy",
        "updated_at",
      ],
      [
        "activated_at",
        "archived_at",
        "policy_snapshot_id",
        "runtime_profile_id",
      ],
    ) &&
    isUUID(value.id) &&
    isUUID(value.definition_id) &&
    isUUID(value.selected_version_id) &&
    (value.runtime_profile_id === undefined ||
      isUUID(value.runtime_profile_id)) &&
    (value.policy_snapshot_id === undefined ||
      isUUID(value.policy_snapshot_id)) &&
    value.update_policy === "manual" &&
    (value.status === "pending" ||
      value.status === "active" ||
      value.status === "archived") &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at) &&
    (value.activated_at === undefined || isTimestamp(value.activated_at)) &&
    (value.archived_at === undefined || isTimestamp(value.archived_at))
  );
}

function isPublication(value: unknown): value is AgentPublication {
  return (
    hasExactFields(value, ["definition", "replayed", "version"]) &&
    isDefinition(value.definition) &&
    isVersion(value.version) &&
    typeof value.replayed === "boolean"
  );
}

function isInstallationCreation(
  value: unknown,
): value is AgentInstallationCreation {
  return (
    hasExactFields(value, ["installation", "policy_snapshot", "replayed"]) &&
    isInstallation(value.installation) &&
    isPolicy(value.policy_snapshot) &&
    typeof value.replayed === "boolean"
  );
}

function isRevocation(value: unknown): value is AgentVersionRevocation {
  return (
    hasExactFields(
      value,
      [
        "created_at",
        "id",
        "policy_snapshot_id",
        "reason_code",
        "replayed",
        "version_id",
      ],
      ["superseding_version_id"],
    ) &&
    isUUID(value.id) &&
    isUUID(value.version_id) &&
    isUUID(value.policy_snapshot_id) &&
    isBoundedString(value.reason_code, 1, 64) &&
    (value.superseding_version_id === undefined ||
      isUUID(value.superseding_version_id)) &&
    isTimestamp(value.created_at) &&
    typeof value.replayed === "boolean"
  );
}

function isRuntimeBinding(value: unknown): value is RuntimeBindingRecord {
  return (
    hasExactFields(value, [
      "agent_installation_id",
      "agent_version_id",
      "created_at",
      "id",
      "policy_snapshot_id",
      "runtime_profile_id",
      "runtime_version",
      "tool_permission_digest",
    ]) &&
    isUUID(value.id) &&
    isUUID(value.agent_installation_id) &&
    isUUID(value.agent_version_id) &&
    isUUID(value.runtime_profile_id) &&
    isUUID(value.policy_snapshot_id) &&
    isBoundedString(value.runtime_version, 1, 64) &&
    isDigest(value.tool_permission_digest) &&
    isTimestamp(value.created_at)
  );
}

function isSigningKeySet(value: unknown): value is AgentSigningKeySet {
  return (
    hasExactFields(value, ["keys"]) &&
    Array.isArray(value.keys) &&
    value.keys.length > 0 &&
    value.keys.length <= 128 &&
    value.keys.every(
      (key) =>
        hasExactFields(key, [
          "alg",
          "crv",
          "kid",
          "kty",
          "purpose",
          "use",
          "x",
        ]) &&
        key.alg === "EdDSA" &&
        key.crv === "Ed25519" &&
        key.kty === "OKP" &&
        key.use === "sig" &&
        (key.purpose === "access" ||
          key.purpose === "offline_entitlement" ||
          key.purpose === "agent_version" ||
          key.purpose === "agent_policy") &&
        isBoundedString(key.kid, 1, 128) &&
        typeof key.x === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(key.x) &&
        Buffer.from(key.x, "base64url").toString("base64url") === key.x,
    )
  );
}

function requireUUID(value: string): void {
  if (!isUUID(value)) {
    throw new AgenteraAgentControlClientError(0, "invalid_request");
  }
}

function requireIdempotencyKey(value: string): void {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 256 ||
    /[\r\n\0]/.test(value)
  ) {
    throw new AgenteraAgentControlClientError(0, "invalid_request");
  }
}

function safeServerErrorCode(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      hasExactFields(parsed, ["error"]) &&
      isObject(parsed.error) &&
      typeof parsed.error.code === "string" &&
      STABLE_ERROR_CODES.has(parsed.error.code as StableErrorCode)
    ) {
      return parsed.error.code;
    }
  } catch {
    // A bounded generic error avoids exposing response bodies or parser detail.
  }
  return "request_failed";
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximumBytes)
  ) {
    throw new AgenteraAgentControlClientError(0, "response_too_large");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      received += part.value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        throw new AgenteraAgentControlClientError(0, "response_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AgenteraAgentControlClientError(0, "invalid_response");
  }
}

function signActivation(
  identity: InstallationIdentity,
  payload: Buffer,
): string {
  let privateKey;
  let publicKey;
  try {
    const privateBytes = Buffer.from(identity.devicePrivateKey, "base64");
    const publicBytes = Buffer.from(identity.devicePublicKey, "base64url");
    if (
      privateBytes.length === 0 ||
      privateBytes.toString("base64") !== identity.devicePrivateKey ||
      publicBytes.length !== 32 ||
      publicBytes.toString("base64url") !== identity.devicePublicKey
    ) {
      throw new Error("non-canonical device identity");
    }
    privateKey = createPrivateKey({
      key: privateBytes,
      format: "der",
      type: "pkcs8",
    });
    publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, publicBytes]),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new AgenteraAgentControlClientError(0, "invalid_device_identity");
  }
  const signature = sign(null, payload, privateKey);
  if (!verifySignature(null, payload, publicKey, signature)) {
    throw new AgenteraAgentControlClientError(0, "invalid_device_identity");
  }
  return signature.toString("base64url");
}

export class AgenteraAgentControlClient {
  readonly origin: string;
  private readonly getAccessToken: () => string | null;
  private readonly getInstallationIdentity: () => InstallationIdentity | null;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: AgenteraAgentControlClientOptions) {
    this.origin = parseAgenteraCloudOrigin(options.origin);
    this.getAccessToken = options.getAccessToken;
    this.getInstallationIdentity = options.getInstallationIdentity;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    if (
      typeof this.getAccessToken !== "function" ||
      typeof this.getInstallationIdentity !== "function" ||
      typeof this.fetcher !== "function" ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000
    ) {
      throw new Error(
        "AgentEra Agent control client configuration is invalid.",
      );
    }
  }

  async listDefinitions(): Promise<AgentDefinition[]> {
    const value = await this.requestJSON(
      "/api/v1/agent-definitions",
      { expectedStatus: 200 },
      (candidate): candidate is { definitions: readonly AgentDefinition[] } =>
        hasExactFields(candidate, ["definitions"]) &&
        Array.isArray(candidate.definitions) &&
        candidate.definitions.every(isDefinition),
    );
    return [...value.definitions];
  }

  getDefinition(definitionId: string): Promise<AgentDefinition> {
    requireUUID(definitionId);
    return this.requestJSON(
      `/api/v1/agent-definitions/${definitionId}`,
      { expectedStatus: 200 },
      isDefinition,
    );
  }

  async listVersions(definitionId: string): Promise<AgentVersion[]> {
    requireUUID(definitionId);
    const value = await this.requestJSON(
      `/api/v1/agent-definitions/${definitionId}/versions`,
      { expectedStatus: 200 },
      (candidate): candidate is { versions: readonly AgentVersion[] } =>
        hasExactFields(candidate, ["versions"]) &&
        Array.isArray(candidate.versions) &&
        candidate.versions.every(isVersion),
    );
    return [...value.versions];
  }

  getVersion(versionId: string): Promise<AgentVersion> {
    requireUUID(versionId);
    return this.requestJSON(
      `/api/v1/agent-versions/${versionId}`,
      { expectedStatus: 200 },
      isVersion,
    );
  }

  publishInitial(
    body: PublishInitialAgentRequest,
    idempotencyKey: string,
  ): Promise<AgentPublication> {
    requireIdempotencyKey(idempotencyKey);
    return this.requestJSON(
      "/api/v1/agent-definitions",
      { method: "POST", body, idempotencyKey, expectedStatus: 201 },
      isPublication,
    );
  }

  publishNext(
    definitionId: string,
    body: PublishNextAgentVersionRequest,
    idempotencyKey: string,
  ): Promise<AgentPublication> {
    requireUUID(definitionId);
    requireIdempotencyKey(idempotencyKey);
    return this.requestJSON(
      `/api/v1/agent-definitions/${definitionId}/versions`,
      { method: "POST", body, idempotencyKey, expectedStatus: 201 },
      isPublication,
    );
  }

  revokeVersion(
    versionId: string,
    body: RevokeAgentVersionRequest,
    idempotencyKey: string,
  ): Promise<AgentVersionRevocation> {
    requireUUID(versionId);
    requireIdempotencyKey(idempotencyKey);
    return this.requestJSON(
      `/api/v1/agent-versions/${versionId}/revocations`,
      { method: "POST", body, idempotencyKey, expectedStatus: 201 },
      isRevocation,
    );
  }

  createInstallation(
    body: CreateAgentInstallationRequest,
    idempotencyKey: string,
  ): Promise<AgentInstallationCreation> {
    requireIdempotencyKey(idempotencyKey);
    return this.requestJSON(
      "/api/v1/agent-installations",
      { method: "POST", body, idempotencyKey, expectedStatus: 201 },
      isInstallationCreation,
    );
  }

  activateInstallation(
    installationId: string,
    runtimeProfileId: string,
    versionDigest: string,
    idempotencyKey: string,
  ): Promise<AgentInstallation> {
    requireUUID(installationId);
    requireUUID(runtimeProfileId);
    requireIdempotencyKey(idempotencyKey);
    if (!DIGEST_PATTERN.test(versionDigest)) {
      throw new AgenteraAgentControlClientError(0, "invalid_request");
    }
    const identity = this.getInstallationIdentity();
    if (!identity) {
      throw new AgenteraAgentControlClientError(0, "invalid_device_identity");
    }
    const timestamp = Math.floor(this.now().getTime() / 1000);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new AgenteraAgentControlClientError(0, "invalid_request");
    }
    const signedPayload = Buffer.from(
      `agentera-agent-installation-activate-v1\0${installationId}\0${runtimeProfileId}\0${versionDigest}\0${timestamp}`,
      "utf8",
    );
    const body: components["schemas"]["ActivateAgentInstallationRequest"] = {
      runtime_profile_id: runtimeProfileId,
      version_digest: versionDigest,
      timestamp,
      device_proof: signActivation(identity, signedPayload),
    };
    return this.requestJSON(
      `/api/v1/agent-installations/${installationId}/activate`,
      { method: "POST", body, idempotencyKey, expectedStatus: 200 },
      isInstallation,
    );
  }

  selectInstallationVersion(
    installationId: string,
    versionId: string,
    idempotencyKey: string,
  ): Promise<AgentInstallation> {
    requireUUID(installationId);
    requireUUID(versionId);
    requireIdempotencyKey(idempotencyKey);
    const body: components["schemas"]["SelectAgentInstallationVersionRequest"] =
      {
        version_id: versionId,
      };
    return this.requestJSON(
      `/api/v1/agent-installations/${installationId}/select-version`,
      { method: "POST", body, idempotencyKey, expectedStatus: 200 },
      isInstallation,
    );
  }

  async archiveInstallation(
    installationId: string,
    idempotencyKey: string,
  ): Promise<AgentInstallation> {
    requireUUID(installationId);
    requireIdempotencyKey(idempotencyKey);
    return this.requestJSON(
      `/api/v1/agent-installations/${installationId}/archive`,
      { method: "POST", body: {}, idempotencyKey, expectedStatus: 200 },
      isInstallation,
    );
  }

  recordRuntimeBinding(
    body: CreateRuntimeBindingRecordRequest,
    idempotencyKey: string,
  ): Promise<RuntimeBindingRecord> {
    requireIdempotencyKey(idempotencyKey);
    return this.requestJSON(
      "/api/v1/runtime-binding-records",
      { method: "POST", body, idempotencyKey, expectedStatus: 201 },
      isRuntimeBinding,
    );
  }

  getSigningKeys(): Promise<AgentSigningKeySet> {
    return this.requestJSON(
      "/.well-known/agentera-signing-keys.json",
      {
        authenticated: false,
        expectedStatus: 200,
        responseLimit: KEY_RESPONSE_LIMIT,
      },
      isSigningKeySet,
    );
  }

  private async requestJSON<T>(
    path: string,
    options: RequestOptions,
    validate: (value: unknown) => value is T,
  ): Promise<T> {
    const response = await this.request(path, options);
    const raw = await readBoundedText(
      response,
      options.responseLimit ?? RESPONSE_LIMIT,
    );
    if (response.status !== options.expectedStatus) {
      throw new AgenteraAgentControlClientError(
        response.status,
        safeServerErrorCode(raw),
      );
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    if (!validate(parsed)) {
      throw new AgenteraAgentControlClientError(0, "invalid_response");
    }
    return parsed;
  }

  private async request(
    path: string,
    options: RequestOptions,
  ): Promise<Response> {
    const authenticated = options.authenticated !== false;
    const headers: Record<string, string> = { accept: "application/json" };
    if (authenticated) {
      const token = this.getAccessToken();
      if (
        typeof token !== "string" ||
        token.length === 0 ||
        token.length > 8192 ||
        token !== token.trim() ||
        /\s/.test(token)
      ) {
        throw new AgenteraAgentControlClientError(401, "session_revoked");
      }
      headers.authorization = `Bearer ${token}`;
    }
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timer.unref?.();
    try {
      return await this.fetcher(agenteraCloudUrl(this.origin, path), {
        method: options.method ?? "GET",
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof AgenteraAgentControlClientError) throw error;
      throw new AgenteraAgentControlClientError(
        0,
        timedOut ? "request_timeout" : "network_unavailable",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
