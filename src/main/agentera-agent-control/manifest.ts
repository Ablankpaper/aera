import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type {
  AgentDraftAssetInput,
  AgentDraftAssetKind,
  AgentDraftAssetMediaType,
  AgentDraftAssetMetadata,
  AgentDraftIconMediaType,
  AgentEditableManifest,
} from "../../shared/agentera-agent-control";

export const MAX_AGENT_ASSET_COUNT = 128;
export const MAX_AGENT_ASSET_BYTES = 256 * 1024;
export const MAX_AGENT_BUNDLE_BYTES = 2 * 1024 * 1024;
export const MAX_AGENT_MANIFEST_BYTES = 256 * 1024;
export const MAX_AGENT_ICON_BYTES = 512 * 1024;
export const MAX_AGENT_ICON_DIMENSION = 1024;

export type AgentManifestValidationErrorCode =
  | "invalid_agent_content"
  | "secret_detected"
  | "runtime_incompatible";

export class AgentManifestValidationError extends Error {
  readonly code: AgentManifestValidationErrorCode;

  constructor(code: AgentManifestValidationErrorCode) {
    super(`Aera Agent manifest validation failed: ${code}.`);
    this.name = "AgentManifestValidationError";
    this.code = code;
  }
}

export interface CanonicalEditableAgent {
  normalizedManifest: AgentEditableManifest;
  assets: AgentDraftAssetMetadata[];
  manifestBytes: Buffer;
  bundleBytes: Buffer;
  manifestDigest: string;
  bundleDigest: string;
  contentDigest: string;
}

export interface AgentAssetFileStat {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface AgentAssetFileIO {
  lstat(path: string): AgentAssetFileStat;
  realpath(path: string): string;
  readFile(path: string): Buffer;
}

interface ParsedSemanticVersion {
  normalized: string;
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: readonly string[];
}

type JsonObject = Record<string, unknown>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMANTIC_VERSION_PATTERN =
  /^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const FORBIDDEN_PROFILE_SEGMENTS = new Set([
  ".env",
  "auth.json",
  "memory.md",
  "user.md",
  "credentials",
  "sessions",
  "curator",
  ".curator",
  "archives",
]);
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SECRET_ASSIGNMENT =
  /^(?:export\s+)?[A-Z0-9_.-]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|AUTH[_-]?TOKEN|CLIENT[_-]?SECRET|PRIVATE[_-]?KEY|SECRET[_-]?KEY|PASSWORD)\s*[:=]\s*["']?[^\s"']{8,}/im;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:RSA |EC |OPENSSH |ED25519 )?PRIVATE KEY-----/;
const HIGH_CONFIDENCE_TOKEN =
  /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{24,})(?:$|[^A-Za-z0-9])/;
const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function invalidContent(): never {
  throw new AgentManifestValidationError("invalid_agent_content");
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function exactObject(
  value: unknown,
  fields: readonly string[],
): value is JsonObject {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function validString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    !hasUnpairedSurrogate(value) &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") >= minimum &&
    Buffer.byteLength(value, "utf8") <= maximum
  );
}

class StrictJsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) invalidContent();
    return value;
  }

  private parseValue(): unknown {
    const token = this.source[this.index];
    if (token === "{") return this.parseObject();
    if (token === "[") return this.parseArray();
    if (token === '"') return this.parseString();
    if (token === "t") return this.parseLiteral("true", true);
    if (token === "f") return this.parseLiteral("false", false);
    if (token === "n") return this.parseLiteral("null", null);
    if (token === "-" || (token >= "0" && token <= "9")) {
      return this.parseNumber();
    }
    return invalidContent();
  }

  private parseObject(): JsonObject {
    this.index += 1;
    const value: JsonObject = Object.create(null) as JsonObject;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.consume("}")) return value;
    while (true) {
      this.skipWhitespace();
      if (this.source[this.index] !== '"') invalidContent();
      const key = this.parseString();
      if (keys.has(key)) invalidContent();
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) invalidContent();
      this.skipWhitespace();
      value[key] = this.parseValue();
      this.skipWhitespace();
      if (this.consume("}")) return value;
      if (!this.consume(",")) invalidContent();
    }
  }

  private parseArray(): unknown[] {
    this.index += 1;
    const value: unknown[] = [];
    this.skipWhitespace();
    if (this.consume("]")) return value;
    while (true) {
      this.skipWhitespace();
      value.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume("]")) return value;
      if (!this.consume(",")) invalidContent();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.source.length) {
      const token = this.source[this.index];
      if (!escaped && token === '"') {
        this.index += 1;
        try {
          const parsed = JSON.parse(
            this.source.slice(start, this.index),
          ) as unknown;
          if (typeof parsed !== "string" || hasUnpairedSurrogate(parsed)) {
            return invalidContent();
          }
          return parsed;
        } catch {
          return invalidContent();
        }
      }
      if (!escaped && token === "\\") escaped = true;
      else escaped = false;
      this.index += 1;
    }
    return invalidContent();
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.index),
    );
    if (!match) return invalidContent();
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) return invalidContent();
    return value;
  }

  private parseLiteral<T>(token: string, value: T): T {
    if (!this.source.startsWith(token, this.index)) return invalidContent();
    this.index += token.length;
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) {
        break;
      }
      this.index += 1;
    }
  }

  private consume(token: string): boolean {
    if (this.source[this.index] !== token) return false;
    this.index += 1;
    return true;
  }
}

function copyEditableManifest(value: unknown): AgentEditableManifest {
  if (!isJsonObject(value)) return invalidContent();
  const schemaVersion = value.schemaVersion;
  const fields =
    schemaVersion === 1
      ? [
          "schemaVersion",
          "identity",
          "assets",
          "modelConstraints",
          "tools",
          "dependencies",
          "runtimeCompatibility",
        ]
      : schemaVersion === 2
        ? [
            "schemaVersion",
            "identity",
            "assets",
            "modelPolicy",
            "tools",
            "dependencies",
            "runtimeCompatibility",
          ]
        : [];
  if (
    fields.length === 0 ||
    !exactObject(value, fields) ||
    !exactObject(value.identity, ["systemPrompt"]) ||
    typeof value.identity.systemPrompt !== "string" ||
    !Array.isArray(value.assets) ||
    !exactObject(value.tools, ["allowed", "denied"]) ||
    !Array.isArray(value.tools.allowed) ||
    !Array.isArray(value.tools.denied) ||
    !Array.isArray(value.dependencies) ||
    !exactObject(value.runtimeCompatibility, [
      "minimumVersion",
      "maximumVersionExclusive",
    ]) ||
    typeof value.runtimeCompatibility.minimumVersion !== "string" ||
    (value.runtimeCompatibility.maximumVersionExclusive !== null &&
      typeof value.runtimeCompatibility.maximumVersionExclusive !== "string")
  ) {
    return invalidContent();
  }
  if (
    schemaVersion === 1 &&
    (!exactObject(value.modelConstraints, [
      "allowedProviders",
      "allowedModels",
    ]) ||
      !Array.isArray(value.modelConstraints.allowedProviders) ||
      !Array.isArray(value.modelConstraints.allowedModels))
  ) {
    return invalidContent();
  }
  if (
    schemaVersion === 2 &&
    (!exactObject(value.modelPolicy, [
      "mode",
      "allowedProviders",
      "allowedModels",
    ]) ||
      (value.modelPolicy.mode !== "user_select" &&
        value.modelPolicy.mode !== "allowlist" &&
        value.modelPolicy.mode !== "fixed") ||
      !Array.isArray(value.modelPolicy.allowedProviders) ||
      !Array.isArray(value.modelPolicy.allowedModels))
  ) {
    return invalidContent();
  }

  const assets: AgentEditableManifest["assets"] = value.assets.map(
    (asset): AgentEditableManifest["assets"][number] => {
      if (
        !exactObject(asset, ["path", "kind", "mediaType"]) ||
        typeof asset.path !== "string" ||
        (asset.kind !== "skill" &&
          asset.kind !== "sop" &&
          asset.kind !== "knowledge") ||
        (asset.mediaType !== "text/markdown" &&
          asset.mediaType !== "text/plain")
      ) {
        return invalidContent();
      }
      return {
        path: asset.path,
        kind: asset.kind,
        mediaType: asset.mediaType,
      };
    },
  );
  const dependencies = value.dependencies.map((dependency) => {
    if (
      !exactObject(dependency, ["agentDefinitionId", "agentVersionId"]) ||
      typeof dependency.agentDefinitionId !== "string" ||
      typeof dependency.agentVersionId !== "string"
    ) {
      return invalidContent();
    }
    return {
      agentDefinitionId: dependency.agentDefinitionId,
      agentVersionId: dependency.agentVersionId,
    };
  });
  const copyStringArray = (input: unknown): string[] => {
    if (
      !Array.isArray(input) ||
      !input.every((item) => typeof item === "string")
    ) {
      return invalidContent();
    }
    return [...(input as string[])];
  };
  const common = {
    identity: { systemPrompt: value.identity.systemPrompt },
    assets,
    tools: {
      allowed: copyStringArray(value.tools.allowed),
      denied: copyStringArray(value.tools.denied),
    },
    dependencies,
    runtimeCompatibility: {
      minimumVersion: value.runtimeCompatibility.minimumVersion,
      maximumVersionExclusive:
        value.runtimeCompatibility.maximumVersionExclusive,
    },
  };
  if (schemaVersion === 1) {
    const modelConstraints = value.modelConstraints as JsonObject;
    return {
      schemaVersion: 1,
      ...common,
      modelConstraints: {
        allowedProviders: copyStringArray(modelConstraints.allowedProviders),
        allowedModels: copyStringArray(modelConstraints.allowedModels),
      },
    };
  }
  const modelPolicy = value.modelPolicy as JsonObject;
  return {
    schemaVersion: 2,
    ...common,
    modelPolicy: {
      mode: modelPolicy.mode as "user_select" | "allowlist" | "fixed",
      allowedProviders: copyStringArray(modelPolicy.allowedProviders),
      allowedModels: copyStringArray(modelPolicy.allowedModels),
    },
  };
}

export function parseAgentControlJsonObject(
  raw: Buffer,
  maximumBytes: number,
): Record<string, unknown> {
  if (
    !Buffer.isBuffer(raw) ||
    raw.length === 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    raw.length > maximumBytes
  ) {
    return invalidContent();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return invalidContent();
  }
  const value = new StrictJsonParser(text).parse();
  if (!isJsonObject(value)) return invalidContent();
  return value;
}

export function decodeEditableAgentManifest(
  raw: Buffer,
): AgentEditableManifest {
  return copyEditableManifest(
    parseAgentControlJsonObject(raw, MAX_AGENT_MANIFEST_BYTES),
  );
}

export function normalizeAgentAssetPath(raw: string): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw !== raw.trim() ||
    hasUnpairedSurrogate(raw) ||
    raw.includes("\0") ||
    raw.includes("\\") ||
    raw.includes("://") ||
    raw.startsWith("/") ||
    (raw.length >= 2 && raw[1] === ":")
  ) {
    return invalidContent();
  }
  const normalized = raw.normalize("NFC");
  const segments = normalized.split("/");
  if (
    normalized === "." ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return invalidContent();
  }
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (
      FORBIDDEN_PROFILE_SEGMENTS.has(lower) ||
      WINDOWS_DEVICE_NAME.test(lower.split(".", 1)[0])
    ) {
      return invalidContent();
    }
  }
  return normalized;
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalStringSet(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 512) return invalidContent();
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (
      !validString(value, 1, 128) ||
      value !== value.trim() ||
      /[\r\n]/.test(value) ||
      value.includes("://") ||
      seen.has(value)
    ) {
      return invalidContent();
    }
    seen.add(value);
    result.push(value);
  }
  return result.sort(utf8Compare);
}

function parseSemanticVersion(raw: string): ParsedSemanticVersion {
  const match = SEMANTIC_VERSION_PATTERN.exec(raw);
  if (!match) {
    throw new AgentManifestValidationError("runtime_incompatible");
  }
  const numeric = match.slice(1, 4).map((part) => BigInt(part));
  if (numeric.some((part) => part > UINT64_MAX)) {
    throw new AgentManifestValidationError("runtime_incompatible");
  }
  const prerelease = match[4] ? match[4].split(".") : [];
  for (const [identifiers, rejectLeadingZero] of [
    [prerelease, true],
    [match[5] ? match[5].split(".") : [], false],
  ] as const) {
    for (const identifier of identifiers) {
      if (
        identifier.length === 0 ||
        !/^[0-9A-Za-z-]+$/.test(identifier) ||
        (rejectLeadingZero && /^0[0-9]+$/.test(identifier))
      ) {
        throw new AgentManifestValidationError("runtime_incompatible");
      }
    }
  }
  return {
    normalized: raw.startsWith("v") ? raw : `v${raw}`,
    major: numeric[0],
    minor: numeric[1],
    patch: numeric[2],
    prerelease,
  };
}

function compareSemanticVersion(
  left: ParsedSemanticVersion,
  right: ParsedSemanticVersion,
): number {
  for (const field of ["major", "minor", "patch"] as const) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const count = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === rightPart) continue;
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const leftValue = BigInt(leftPart);
      const rightValue = BigInt(rightPart);
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return left.prerelease.length - right.prerelease.length;
}

function containsHighConfidenceSecret(value: string): boolean {
  return (
    SECRET_ASSIGNMENT.test(value) ||
    PRIVATE_KEY_BLOCK.test(value) ||
    HIGH_CONFIDENCE_TOKEN.test(value)
  );
}

function canonicalJsonBytes(value: unknown): Buffer {
  const encoded = JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return Buffer.from(encoded, "utf8");
}

export function canonicalizeEditableAgent(
  manifestInput: AgentEditableManifest,
  assetInput: readonly AgentDraftAssetInput[],
): CanonicalEditableAgent {
  const manifest = copyEditableManifest(manifestInput);
  if (
    !validString(manifest.identity.systemPrompt, 1, MAX_AGENT_MANIFEST_BYTES) ||
    containsHighConfidenceSecret(manifest.identity.systemPrompt) ||
    manifest.assets.length > MAX_AGENT_ASSET_COUNT ||
    manifest.dependencies.length > 512 ||
    !Array.isArray(assetInput) ||
    assetInput.length > MAX_AGENT_ASSET_COUNT
  ) {
    if (containsHighConfidenceSecret(manifest.identity.systemPrompt)) {
      throw new AgentManifestValidationError("secret_detected");
    }
    return invalidContent();
  }

  const bundleByPath = new Map<string, string>();
  let totalBytes = 0;
  for (const candidate of assetInput) {
    if (
      !exactObject(candidate, ["path", "content"]) ||
      typeof candidate.path !== "string" ||
      !validString(candidate.content, 0, MAX_AGENT_ASSET_BYTES)
    ) {
      return invalidContent();
    }
    const path = normalizeAgentAssetPath(candidate.path);
    if (bundleByPath.has(path)) return invalidContent();
    if (containsHighConfidenceSecret(candidate.content)) {
      throw new AgentManifestValidationError("secret_detected");
    }
    totalBytes += Buffer.byteLength(candidate.content, "utf8");
    if (totalBytes > MAX_AGENT_BUNDLE_BYTES) return invalidContent();
    bundleByPath.set(path, candidate.content);
  }

  const manifestPaths = new Set<string>();
  const canonicalAssets: Array<{
    kind: AgentDraftAssetKind;
    media_type: AgentDraftAssetMediaType;
    path: string;
    sha256: string;
  }> = [];
  const assetMetadata: AgentDraftAssetMetadata[] = [];
  for (const candidate of manifest.assets) {
    const path = normalizeAgentAssetPath(candidate.path);
    if (manifestPaths.has(path)) return invalidContent();
    manifestPaths.add(path);
    const content = bundleByPath.get(path);
    if (content === undefined) return invalidContent();
    const bytes = Buffer.from(content, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    canonicalAssets.push({
      kind: candidate.kind,
      media_type: candidate.mediaType,
      path,
      sha256,
    });
    assetMetadata.push({
      path,
      kind: candidate.kind,
      mediaType: candidate.mediaType,
      sizeBytes: bytes.length,
      sha256,
    });
  }
  if (manifestPaths.size !== bundleByPath.size) return invalidContent();

  const modelPolicy =
    manifest.schemaVersion === 1
      ? {
          mode: "allowlist" as const,
          allowedProviders: manifest.modelConstraints.allowedProviders,
          allowedModels: manifest.modelConstraints.allowedModels,
        }
      : manifest.modelPolicy;
  const providers = canonicalStringSet(modelPolicy.allowedProviders);
  const models = canonicalStringSet(modelPolicy.allowedModels);
  const modelPolicyValid =
    (modelPolicy.mode === "user_select" &&
      providers.length === 0 &&
      models.length === 0) ||
    (modelPolicy.mode === "allowlist" &&
      providers.length > 0 &&
      models.length > 0) ||
    (modelPolicy.mode === "fixed" &&
      providers.length === 1 &&
      models.length === 1);
  if (!modelPolicyValid) return invalidContent();
  const allowedTools = canonicalStringSet(manifest.tools.allowed);
  const deniedTools = canonicalStringSet(manifest.tools.denied);
  if (deniedTools.some((tool) => allowedTools.includes(tool))) {
    return invalidContent();
  }

  const dependencyKeys = new Set<string>();
  const dependencies = manifest.dependencies.map((dependency) => {
    if (
      !UUID_PATTERN.test(dependency.agentDefinitionId) ||
      !UUID_PATTERN.test(dependency.agentVersionId) ||
      dependency.agentDefinitionId === "00000000-0000-0000-0000-000000000000" ||
      dependency.agentVersionId === "00000000-0000-0000-0000-000000000000"
    ) {
      return invalidContent();
    }
    const key = `${dependency.agentDefinitionId}\0${dependency.agentVersionId}`;
    if (dependencyKeys.has(key)) return invalidContent();
    dependencyKeys.add(key);
    return {
      agent_definition_id: dependency.agentDefinitionId.toLowerCase(),
      agent_version_id: dependency.agentVersionId.toLowerCase(),
    };
  });

  const minimum = parseSemanticVersion(
    manifest.runtimeCompatibility.minimumVersion,
  );
  let maximum: ParsedSemanticVersion | null = null;
  if (manifest.runtimeCompatibility.maximumVersionExclusive !== null) {
    maximum = parseSemanticVersion(
      manifest.runtimeCompatibility.maximumVersionExclusive,
    );
    if (compareSemanticVersion(maximum, minimum) <= 0) {
      throw new AgentManifestValidationError("runtime_incompatible");
    }
  }

  canonicalAssets.sort((left, right) => utf8Compare(left.path, right.path));
  assetMetadata.sort((left, right) => utf8Compare(left.path, right.path));
  dependencies.sort((left, right) => {
    const definitionOrder = utf8Compare(
      left.agent_definition_id,
      right.agent_definition_id,
    );
    return definitionOrder === 0
      ? utf8Compare(left.agent_version_id, right.agent_version_id)
      : definitionOrder;
  });
  const bundleAssets = [...bundleByPath.entries()]
    .sort(([left], [right]) => utf8Compare(left, right))
    .map(([path, content]) => ({ content, path }));

  const canonicalManifest =
    manifest.schemaVersion === 1
      ? {
          assets: canonicalAssets,
          dependencies,
          identity: { system_prompt: manifest.identity.systemPrompt },
          model_constraints: {
            allowed_models: models,
            allowed_providers: providers,
          },
          runtime_compatibility: {
            maximum_version_exclusive: maximum?.normalized ?? null,
            minimum_version: minimum.normalized,
          },
          schema_version: 1,
          tools: { allowed: allowedTools, denied: deniedTools },
        }
      : {
          assets: canonicalAssets,
          dependencies,
          identity: { system_prompt: manifest.identity.systemPrompt },
          model_policy: {
            allowed_models: models,
            allowed_providers: providers,
            mode: modelPolicy.mode,
          },
          runtime_compatibility: {
            maximum_version_exclusive: maximum?.normalized ?? null,
            minimum_version: minimum.normalized,
          },
          schema_version: 2,
          tools: { allowed: allowedTools, denied: deniedTools },
        };
  const manifestBytes = canonicalJsonBytes(canonicalManifest);
  if (manifestBytes.length > MAX_AGENT_MANIFEST_BYTES) return invalidContent();
  const bundleBytes = canonicalJsonBytes({ assets: bundleAssets });
  const manifestDigest = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  const bundleDigest = createHash("sha256").update(bundleBytes).digest("hex");
  const contentDigest = createHash("sha256")
    .update(manifestBytes)
    .update(Buffer.from([0]))
    .update(bundleBytes)
    .digest("hex");

  const normalizedCommon = {
    identity: { systemPrompt: manifest.identity.systemPrompt },
    assets: assetMetadata.map(({ path, kind, mediaType }) => ({
      path,
      kind,
      mediaType,
    })),
    tools: { allowed: allowedTools, denied: deniedTools },
    dependencies: dependencies.map((dependency) => ({
      agentDefinitionId: dependency.agent_definition_id,
      agentVersionId: dependency.agent_version_id,
    })),
    runtimeCompatibility: {
      minimumVersion: minimum.normalized,
      maximumVersionExclusive: maximum?.normalized ?? null,
    },
  };
  const normalizedManifest: AgentEditableManifest =
    manifest.schemaVersion === 1
      ? {
          schemaVersion: 1,
          ...normalizedCommon,
          modelConstraints: {
            allowedProviders: providers,
            allowedModels: models,
          },
        }
      : {
          schemaVersion: 2,
          ...normalizedCommon,
          modelPolicy: {
            mode: modelPolicy.mode,
            allowedProviders: providers,
            allowedModels: models,
          },
        };

  return {
    normalizedManifest,
    assets: assetMetadata,
    manifestBytes,
    bundleBytes,
    manifestDigest,
    bundleDigest,
    contentDigest,
  };
}

function isContained(root: string, child: string): boolean {
  const childRelative = relative(root, child);
  return (
    childRelative === "" ||
    (!childRelative.startsWith("..") && !isAbsolute(childRelative))
  );
}

const defaultAssetFileIO: AgentAssetFileIO = {
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync.native(path),
  readFile: (path) => readFileSync(path),
};

export function readValidatedAgentAssetFile(
  rootPath: string,
  relativePath: string,
  io: AgentAssetFileIO = defaultAssetFileIO,
): Buffer {
  if (!isAbsolute(rootPath)) return invalidContent();
  const normalizedPath = normalizeAgentAssetPath(relativePath);
  let canonicalRoot: string;
  let stats: AgentAssetFileStat;
  const candidate = join(resolve(rootPath), ...normalizedPath.split("/"));
  try {
    canonicalRoot = resolve(io.realpath(rootPath));
    stats = io.lstat(candidate);
  } catch {
    return invalidContent();
  }
  if (stats.isSymbolicLink() || !stats.isFile()) return invalidContent();
  let canonicalCandidate: string;
  let content: Buffer;
  try {
    canonicalCandidate = resolve(io.realpath(candidate));
    if (!isContained(canonicalRoot, canonicalCandidate))
      return invalidContent();
    content = io.readFile(canonicalCandidate);
  } catch {
    return invalidContent();
  }
  if (!Buffer.isBuffer(content) || content.length > MAX_AGENT_ASSET_BYTES) {
    return invalidContent();
  }
  return Buffer.from(content);
}

function inspectPng(data: Buffer): {
  width: number;
  height: number;
  animated: boolean;
} {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 33 || !data.subarray(0, 8).equals(signature)) {
    return invalidContent();
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let animated = false;
  let sawImageData = false;
  let sawEnd = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) return invalidContent();
    let checksum = 0xffffffff;
    for (const byte of data.subarray(offset + 4, offset + 8 + length)) {
      checksum = CRC32_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
    }
    if (
      (checksum ^ 0xffffffff) >>> 0 !==
      data.readUInt32BE(offset + 8 + length)
    ) {
      return invalidContent();
    }
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) return invalidContent();
      width = data.readUInt32BE(offset + 8);
      height = data.readUInt32BE(offset + 12);
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") animated = true;
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      if (length !== 0 || end !== data.length) return invalidContent();
      sawEnd = true;
      break;
    }
    offset = end;
  }
  if (!sawImageData || !sawEnd) return invalidContent();
  return { width, height, animated };
}

function inspectWebP(data: Buffer): {
  width: number;
  height: number;
  animated: boolean;
} {
  if (
    data.length < 30 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WEBP" ||
    data.readUInt32LE(4) + 8 !== data.length
  ) {
    return invalidContent();
  }
  let offset = 12;
  while (offset + 8 <= data.length) {
    const type = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > data.length) return invalidContent();
    if (type === "VP8X") {
      if (length !== 10) return invalidContent();
      return {
        width: data.readUIntLE(start + 4, 3) + 1,
        height: data.readUIntLE(start + 7, 3) + 1,
        animated: (data[start] & 0x02) !== 0,
      };
    }
    if (type === "ANIM" || type === "ANMF") {
      return { width: 1, height: 1, animated: true };
    }
    offset = end + (length % 2);
  }
  return invalidContent();
}

export function validateAgentIcon(
  mediaType: AgentDraftIconMediaType | string,
  data: Buffer,
): void {
  if (
    !Buffer.isBuffer(data) ||
    data.length === 0 ||
    data.length > MAX_AGENT_ICON_BYTES
  ) {
    return invalidContent();
  }
  const image =
    mediaType === "image/png"
      ? inspectPng(data)
      : mediaType === "image/webp"
        ? inspectWebP(data)
        : invalidContent();
  if (
    image.animated ||
    image.width <= 0 ||
    image.height <= 0 ||
    image.width > MAX_AGENT_ICON_DIMENSION ||
    image.height > MAX_AGENT_ICON_DIMENSION
  ) {
    return invalidContent();
  }
}
