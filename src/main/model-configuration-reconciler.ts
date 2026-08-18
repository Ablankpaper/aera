import { createHash } from "node:crypto";
import {
  canonicalModelEndpointV2,
  routeKeyV2,
  type ModelRouteIdentityV2,
} from "../shared/model-configuration";
import {
  customProviderRuntimeRoute,
  isCustomProviderRoute,
  namedCustomProviderRuntimeName,
} from "../shared/custom-providers";
import { customProviderEnvKey, isLocalBaseUrl } from "../shared/url-key-map";
import { parseDocument } from "yaml";
import type { ModelConfigurationFileRole } from "./model-configuration-operation-store";

export interface ModelRouteDirectorySnapshot {
  profileId: string;
  ownerHandle: string;
  expectedOwnerHandle: string;
  incompleteOperation: boolean;
  files: Record<ModelConfigurationFileRole, Buffer | null>;
}

export interface ManagedModelFilePatch {
  role: ModelConfigurationFileRole;
  before: Buffer | null;
  after: Buffer;
}

export type RouteRepairPlan =
  | { status: "unchanged"; activeRoute: ModelRouteIdentityV2 | null }
  | {
      status: "repair";
      patches: ManagedModelFilePatch[];
      activeRoute: ModelRouteIdentityV2 | null;
      absorbedRowIds: string[];
    }
  | {
      status: "repair_required";
      code: "route_catalog_repair_required";
      conflict: string;
    };

function repairRequired(conflict: string): RouteRepairPlan {
  return {
    status: "repair_required",
    code: "route_catalog_repair_required",
    conflict,
  };
}

type UnknownRecord = Record<string, unknown>;

interface StrictProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
}

interface StrictModelRecord {
  id: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiMode: string;
  providerLabel: string | null;
  providerId: string | null;
  createdAt: number;
  raw: UnknownRecord;
}

interface StrictModelDefinition {
  model: string;
  name: string;
  createdAt: number;
}

interface StrictActiveConfig {
  provider: string;
  model: string;
  endpoint: string;
  apiMode: string;
  credentialRef: string | null;
}

const API_MODES = new Set([
  "",
  "anthropic_messages",
  "chat_completions",
  "codex_responses",
  "responses",
]);

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function parseJson(bytes: Buffer | null): unknown {
  return bytes === null
    ? null
    : (JSON.parse(bytes.toString("utf8")) as unknown);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length > 0 && result.length <= 4096 && !/[\0\r\n]/u.test(result)
    ? result
    : null;
}

function normalizedApiMode(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const result = value.trim().toLocaleLowerCase();
  return API_MODES.has(result) ? result : null;
}

function parseProviders(bytes: Buffer | null): StrictProviderRecord[] | null {
  let value: unknown;
  try {
    value = parseJson(bytes);
  } catch {
    return null;
  }
  if (value === null) return [];
  const file = asRecord(value);
  if (file?.version !== 1 || !Array.isArray(file.providers)) return null;

  const result: StrictProviderRecord[] = [];
  for (const item of file.providers) {
    const provider = asRecord(item);
    const id = nonEmptyString(provider?.id);
    const name = nonEmptyString(provider?.name);
    const baseUrl = nonEmptyString(provider?.baseUrl);
    if (
      !provider ||
      !id ||
      !name ||
      !baseUrl ||
      !Number.isSafeInteger(provider.createdAt) ||
      (provider.createdAt as number) < 0
    ) {
      return null;
    }
    try {
      result.push({ id, name, baseUrl: canonicalModelEndpointV2(baseUrl) });
    } catch {
      return null;
    }
  }
  return result;
}

function parseModels(bytes: Buffer | null): StrictModelRecord[] | string {
  let value: unknown;
  try {
    value = parseJson(bytes);
  } catch {
    return "models_json_invalid";
  }
  if (value === null) return [];
  if (!Array.isArray(value)) return "models_json_invalid";

  const result: StrictModelRecord[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const row = asRecord(item);
    const id = nonEmptyString(row?.id);
    const provider = nonEmptyString(row?.provider);
    const model = nonEmptyString(row?.model);
    const apiMode = normalizedApiMode(row?.apiMode);
    if (
      !row ||
      !id ||
      !provider ||
      !model ||
      typeof row.baseUrl !== "string" ||
      apiMode === null ||
      !Number.isSafeInteger(row.createdAt) ||
      (row.createdAt as number) < 0 ||
      (row.providerLabel !== undefined &&
        typeof row.providerLabel !== "string") ||
      (row.providerId !== undefined && typeof row.providerId !== "string") ||
      ids.has(id)
    ) {
      return apiMode === null ? "api_mode_unknown" : "models_json_invalid";
    }
    ids.add(id);
    let baseUrl: string;
    try {
      baseUrl = canonicalModelEndpointV2(row.baseUrl);
    } catch {
      return "models_json_invalid";
    }
    const providerId =
      row.providerId === undefined ? null : nonEmptyString(row.providerId);
    if (row.providerId !== undefined && !providerId) {
      return "models_json_invalid";
    }
    result.push({
      id,
      provider,
      model,
      baseUrl,
      apiMode,
      providerLabel:
        typeof row.providerLabel === "string"
          ? row.providerLabel.trim() || null
          : null,
      providerId,
      createdAt: row.createdAt as number,
      raw: row,
    });
  }
  return result;
}

function parseModelDefinitions(
  bytes: Buffer | null,
): Map<string, StrictModelDefinition> | null {
  let value: unknown;
  try {
    value = parseJson(bytes);
  } catch {
    return null;
  }
  if (value === null) return new Map();
  const definitions = asRecord(value);
  if (!definitions) return null;
  const result = new Map<string, StrictModelDefinition>();
  for (const [model, item] of Object.entries(definitions)) {
    const definition = asRecord(item);
    const rawName = definition?.name;
    const name =
      rawName === undefined || rawName === "" ? model : nonEmptyString(rawName);
    if (
      !model.trim() ||
      !definition ||
      (definition.model !== undefined && definition.model !== model) ||
      !name ||
      !Number.isSafeInteger(definition.createdAt) ||
      (definition.createdAt as number) < 0 ||
      !Number.isSafeInteger(definition.updatedAt) ||
      (definition.updatedAt as number) < 0
    ) {
      return null;
    }
    result.set(model, {
      model,
      name,
      createdAt: definition.createdAt as number,
    });
  }
  return result;
}

function parseEnv(bytes: Buffer | null): Set<string> | null {
  const keys = new Set<string>();
  if (bytes === null) return keys;
  const text = bytes.toString("utf8");
  if (text.includes("\0")) return null;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) return null;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return null;
    keys.add(key);
  }
  return keys;
}

function parseConfig(bytes: Buffer | null): StrictActiveConfig | null | string {
  if (bytes === null) return null;
  let root: UnknownRecord;
  try {
    const document = parseDocument(bytes.toString("utf8"), {
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) return "config_yaml_invalid";
    const parsed = asRecord(document.toJS({ maxAliasCount: 0 }));
    if (!parsed) return "config_yaml_invalid";
    root = parsed;
  } catch {
    return "config_yaml_invalid";
  }

  if (root.model === undefined || root.model === null) return null;
  const modelBlock = asRecord(root.model);
  if (!modelBlock) return "config_yaml_invalid";
  const provider = nonEmptyString(modelBlock.provider);
  const model = nonEmptyString(modelBlock.default);
  const rawBaseUrl = nonEmptyString(modelBlock.base_url);
  const apiMode = normalizedApiMode(modelBlock.api_mode);
  if (apiMode === null) return "api_mode_unknown";
  if (!provider || !model || !rawBaseUrl) return "config_yaml_invalid";

  let endpoint: string;
  try {
    endpoint = canonicalModelEndpointV2(rawBaseUrl);
  } catch {
    return "config_yaml_invalid";
  }

  let credentialRef: string | null = null;
  const namedProvider = namedCustomProviderRuntimeName(provider);
  if (namedProvider !== null && !isLocalBaseUrl(endpoint)) {
    const providerBlocks = asRecord(root.providers);
    const matches = providerBlocks
      ? Object.entries(providerBlocks).filter(
          ([name]) =>
            customProviderRuntimeRoute(name) ===
            customProviderRuntimeRoute(namedProvider),
        )
      : [];
    if (matches.length !== 1) return "credential_reference_missing";
    const providerBlock = asRecord(matches[0][1]);
    credentialRef = nonEmptyString(providerBlock?.key_env);
    if (!credentialRef || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(credentialRef)) {
      return "credential_reference_missing";
    }
  }
  return { provider, model, endpoint, apiMode, credentialRef };
}

function providerConflict(
  providers: readonly StrictProviderRecord[],
): string | null {
  const ids = new Set<string>();
  const anchors = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.id)) return "provider_identity_ambiguous";
    ids.add(provider.id);
    const anchor = customProviderEnvKey(provider.name);
    if (anchors.has(anchor)) return "provider_anchor_ambiguous";
    anchors.add(anchor);
  }
  return null;
}

function activeIdentity(
  config: StrictActiveConfig | null,
  providers: readonly StrictProviderRecord[],
  models: readonly StrictModelRecord[],
): ModelRouteIdentityV2 | null | string {
  if (config === null) return null;
  const namedProvider = namedCustomProviderRuntimeName(config.provider);
  if (namedProvider === null) {
    const matches = models.filter(
      (row) =>
        row.provider.toLocaleLowerCase() ===
          config.provider.toLocaleLowerCase() &&
        row.model === config.model &&
        row.baseUrl === config.endpoint &&
        row.apiMode === config.apiMode,
    );
    if (matches.length !== 1) {
      return matches.length === 0
        ? "active_route_unresolved"
        : "active_route_ambiguous";
    }
    return {
      providerId: config.provider,
      modelId: config.model,
      endpoint: config.endpoint,
      apiMode: config.apiMode,
    };
  }

  const providerMatches = providers.filter(
    (provider) => customProviderRuntimeRoute(provider.name) === config.provider,
  );
  if (providerMatches.length !== 1) return "active_provider_unresolved";
  const provider = providerMatches[0];
  if (
    config.credentialRef !== customProviderEnvKey(provider.name) &&
    !isLocalBaseUrl(config.endpoint)
  ) {
    return "credential_reference_missing";
  }
  const matches = models.filter(
    (row) =>
      row.providerId === provider.id &&
      row.model === config.model &&
      row.baseUrl === config.endpoint &&
      row.apiMode === config.apiMode,
  );
  if (matches.length !== 1) {
    return matches.length === 0
      ? "active_route_unresolved"
      : "active_route_ambiguous";
  }
  return {
    providerId: provider.id,
    modelId: config.model,
    endpoint: config.endpoint,
    apiMode: config.apiMode,
  };
}

function providerForRow(
  row: StrictModelRecord,
  providers: readonly StrictProviderRecord[],
  config: StrictActiveConfig | null,
): StrictProviderRecord | null | string {
  if (row.providerId !== null) {
    const matches = providers.filter(
      (provider) => provider.id === row.providerId,
    );
    return matches.length === 1 ? matches[0] : "stable_provider_unresolved";
  }
  if (!isCustomProviderRoute(row.provider)) return null;

  const namedRoute = namedCustomProviderRuntimeName(row.provider);
  const matches = providers.filter((provider) => {
    if (
      namedRoute !== null &&
      customProviderRuntimeRoute(provider.name) !==
        customProviderRuntimeRoute(namedRoute)
    ) {
      return false;
    }
    if (
      row.providerLabel !== null &&
      customProviderEnvKey(row.providerLabel) !==
        customProviderEnvKey(provider.name)
    ) {
      return false;
    }
    if (row.baseUrl && row.baseUrl !== provider.baseUrl) return false;
    if (
      config !== null &&
      config.model === row.model &&
      config.provider === customProviderRuntimeRoute(provider.name) &&
      config.credentialRef !== null &&
      config.credentialRef !== customProviderEnvKey(provider.name)
    ) {
      return false;
    }
    return true;
  });
  if (matches.length === 1) return matches[0];
  return matches.length === 0
    ? "legacy_provider_unresolved"
    : "legacy_provider_ambiguous";
}

function plannedModelRows(
  models: readonly StrictModelRecord[],
  providers: readonly StrictProviderRecord[],
  config: StrictActiveConfig | null,
):
  | {
      rows: StrictModelRecord[];
      raw: UnknownRecord[];
      changed: boolean;
      absorbedRowIds: string[];
    }
  | string {
  type Resolved = {
    row: StrictModelRecord;
    provider: StrictProviderRecord;
  };
  const direct: Array<Resolved | null | string> = models.map((row) => {
    const provider = providerForRow(row, providers, config);
    if (provider === null || typeof provider === "string") return provider;
    return { row, provider };
  });

  // A stale legacy row may carry the same provider label and model as an
  // authoritative row, but its old endpoint is no longer in providers.json.
  // Resolve it from that already-proven peer instead of guessing from the
  // first provider in the file.
  for (let index = 0; index < models.length; index += 1) {
    if (typeof direct[index] !== "string") continue;
    if (direct[index] !== "legacy_provider_unresolved") {
      return direct[index] as string;
    }
    const row = models[index];
    const candidates = providers.filter((provider) =>
      direct.some((candidate, peerIndex) => {
        if (!candidate || typeof candidate === "string") return false;
        if (candidate.provider.id !== provider.id) return false;
        const peer = candidate.row;
        if (peer.model !== row.model || peer.apiMode !== row.apiMode) {
          return false;
        }
        if (
          row.providerLabel !== null &&
          customProviderEnvKey(row.providerLabel) !==
            customProviderEnvKey(provider.name)
        ) {
          return false;
        }
        if (
          namedCustomProviderRuntimeName(row.provider) !== null &&
          customProviderRuntimeRoute(
            namedCustomProviderRuntimeName(row.provider)!,
          ) !== customProviderRuntimeRoute(provider.name)
        ) {
          return false;
        }
        return peerIndex !== index;
      }),
    );
    if (candidates.length !== 1) {
      return candidates.length === 0
        ? "legacy_provider_unresolved"
        : "legacy_provider_ambiguous";
    }
    direct[index] = {
      row,
      provider: candidates[0],
    };
  }

  const resolvedGroups = new Map<string, number[]>();
  for (let index = 0; index < direct.length; index += 1) {
    const candidate = direct[index];
    if (!candidate || typeof candidate === "string") continue;
    const key = [
      candidate.provider.id,
      candidate.row.model,
      candidate.row.apiMode,
    ].join("\0");
    const group = resolvedGroups.get(key) ?? [];
    group.push(index);
    resolvedGroups.set(key, group);
  }

  const placement = new Map<number, StrictModelRecord>();
  const absorbedRowIds: string[] = [];
  let changed = false;

  for (const indexes of resolvedGroups.values()) {
    const first = direct[indexes[0]];
    if (!first || typeof first === "string") continue;
    const provider = first.provider;
    const group = indexes.map((index) => {
      const candidate = direct[index];
      if (!candidate || typeof candidate === "string") {
        throw new Error("Unresolved model row group.");
      }
      return candidate.row;
    });
    const activeProviderEndpoint =
      config !== null &&
      config.model === first.row.model &&
      config.apiMode === first.row.apiMode &&
      customProviderRuntimeRoute(provider.name) === config.provider
        ? config.endpoint
        : provider.baseUrl;
    const merged = mergeResolvedRows(group, provider, activeProviderEndpoint);
    if (typeof merged === "string") return merged;
    const primaryIndex =
      indexes.find((index) => models[index].providerId === provider.id) ??
      indexes[0];
    placement.set(primaryIndex, merged.row);
    if (merged.changed) changed = true;
    absorbedRowIds.push(...merged.absorbedRowIds);
  }

  // Built-in and otherwise unowned rows are intentionally untouched.
  for (let index = 0; index < models.length; index += 1) {
    if (!direct[index]) placement.set(index, models[index]);
  }

  const rows: StrictModelRecord[] = [];
  const raw: UnknownRecord[] = [];
  for (let index = 0; index < models.length; index += 1) {
    const row = placement.get(index);
    if (!row) continue;
    rows.push(row);
    raw.push(row.raw);
  }
  absorbedRowIds.sort(
    (left, right) =>
      models.findIndex((row) => row.id === left) -
      models.findIndex((row) => row.id === right),
  );
  return { rows, raw, changed, absorbedRowIds };
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as UnknownRecord)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableValue((value as UnknownRecord)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function emptyMetadata(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function mergeResolvedRows(
  group: readonly StrictModelRecord[],
  provider: StrictProviderRecord,
  targetEndpoint: string,
):
  | { row: StrictModelRecord; changed: boolean; absorbedRowIds: string[] }
  | string {
  const ordered = [...group].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  const stable = ordered.filter((row) => row.providerId === provider.id);
  const primary = stable[0] ?? ordered[0];
  const protectedKeys = new Set([
    "id",
    "createdAt",
    "provider",
    "model",
    "baseUrl",
    "apiMode",
    "providerLabel",
    "providerId",
    "name",
  ]);
  const mergedRaw: UnknownRecord = { ...primary.raw };
  const keys = new Set(group.flatMap((row) => Object.keys(row.raw)));
  for (const key of keys) {
    if (protectedKeys.has(key)) continue;
    const values = group
      .map((row) => row.raw[key])
      .filter((value) => !emptyMetadata(value));
    const unique = new Map(values.map((value) => [stableValue(value), value]));
    if (unique.size > 1) return "metadata_conflict";
    if (emptyMetadata(mergedRaw[key]) && values.length > 0) {
      mergedRaw[key] = values[0];
    }
  }
  const primaryName =
    typeof primary.raw.name === "string" && primary.raw.name.trim()
      ? primary.raw.name
      : ordered.find(
          (row) => typeof row.raw.name === "string" && row.raw.name.trim(),
        )?.raw.name;
  const nextRaw: UnknownRecord = {
    ...mergedRaw,
    ...(primaryName ? { name: primaryName } : {}),
    baseUrl: targetEndpoint,
    providerId: provider.id,
    providerLabel: provider.name,
    createdAt: ordered[0].createdAt,
  };
  const next: StrictModelRecord = {
    ...primary,
    baseUrl: targetEndpoint,
    providerId: provider.id,
    providerLabel: provider.name,
    createdAt: ordered[0].createdAt,
    raw: nextRaw,
  };
  const changed =
    group.length > 1 ||
    stableValue(primary.raw) !== stableValue(nextRaw) ||
    primary.baseUrl !== targetEndpoint ||
    primary.providerId !== provider.id ||
    primary.providerLabel !== provider.name;
  return {
    row: next,
    changed,
    absorbedRowIds: ordered.slice(1).map((row) => row.id),
  };
}

function activeProviderForConfig(
  config: StrictActiveConfig,
  providers: readonly StrictProviderRecord[],
): StrictProviderRecord | string {
  if (!isCustomProviderRoute(config.provider)) {
    return "active_provider_unresolved";
  }
  const namedProvider = namedCustomProviderRuntimeName(config.provider);
  const matches = providers.filter((provider) =>
    namedProvider === null
      ? provider.baseUrl === config.endpoint
      : customProviderRuntimeRoute(provider.name) === config.provider,
  );
  if (matches.length === 1) return matches[0];
  return matches.length === 0
    ? "active_provider_unresolved"
    : "active_provider_ambiguous";
}

function reconstructedModelId(identity: ModelRouteIdentityV2): string {
  const digest = createHash("sha256")
    .update(routeKeyV2(identity), "utf8")
    .digest("hex");
  return `recovered-${digest.slice(0, 32)}`;
}

function reconstructConfigOnlyRow(
  config: StrictActiveConfig,
  providers: readonly StrictProviderRecord[],
  models: readonly StrictModelRecord[],
  definitions: ReadonlyMap<string, StrictModelDefinition>,
): StrictModelRecord | string {
  const provider = activeProviderForConfig(config, providers);
  if (typeof provider === "string") return provider;
  if (!isLocalBaseUrl(config.endpoint) && config.credentialRef === null) {
    return "credential_reference_missing";
  }
  if (!config.apiMode) {
    const protocols = new Set(
      models
        .filter(
          (row) => row.providerId === provider.id && row.model === config.model,
        )
        .map((row) => row.apiMode)
        .filter(Boolean),
    );
    return protocols.size > 1
      ? "active_route_protocol_ambiguous"
      : "active_route_protocol_unresolved";
  }
  const definition = definitions.get(config.model);
  if (!definition) return "model_definition_unresolved";

  const identity: ModelRouteIdentityV2 = {
    providerId: provider.id,
    modelId: config.model,
    endpoint: config.endpoint,
    apiMode: config.apiMode,
  };
  const id = reconstructedModelId(identity);
  if (models.some((row) => row.id === id)) {
    return "reconstructed_model_identity_conflict";
  }
  const raw: UnknownRecord = {
    id,
    name: definition.name,
    provider: "custom",
    model: definition.model,
    baseUrl: config.endpoint,
    apiMode: config.apiMode,
    providerLabel: provider.name,
    providerId: provider.id,
    createdAt: definition.createdAt,
  };
  return {
    id,
    provider: "custom",
    model: definition.model,
    baseUrl: config.endpoint,
    apiMode: config.apiMode,
    providerLabel: provider.name,
    providerId: provider.id,
    createdAt: definition.createdAt,
    raw,
  };
}

/**
 * Pure, byte-preserving planner for cold-start model-route reconciliation.
 * It never reads disk, resolves a secret, writes a file, or opens a journal.
 */
export function planModelRouteDirectoryRepair(
  snapshot: ModelRouteDirectorySnapshot,
): RouteRepairPlan {
  if (snapshot.ownerHandle !== snapshot.expectedOwnerHandle) {
    return repairRequired("owner_mismatch");
  }
  if (snapshot.incompleteOperation) {
    return repairRequired("incomplete_operation");
  }
  if (parseEnv(snapshot.files.env) === null)
    return repairRequired("env_invalid");
  const providers = parseProviders(snapshot.files.providers);
  if (providers === null) return repairRequired("providers_json_invalid");
  const providerIssue = providerConflict(providers);
  if (providerIssue) return repairRequired(providerIssue);
  const models = parseModels(snapshot.files.models);
  if (typeof models === "string") return repairRequired(models);
  const definitions = parseModelDefinitions(snapshot.files.modelDefinitions);
  if (definitions === null) {
    return repairRequired("model_definitions_json_invalid");
  }
  const config = parseConfig(snapshot.files.config);
  if (typeof config === "string") return repairRequired(config);
  const plannedModels = plannedModelRows(models, providers, config);
  if (typeof plannedModels === "string") {
    return repairRequired(plannedModels);
  }
  let identity = activeIdentity(config, providers, plannedModels.rows);
  if (identity === "active_route_unresolved" && config !== null) {
    const reconstructed = reconstructConfigOnlyRow(
      config,
      providers,
      plannedModels.rows,
      definitions,
    );
    if (typeof reconstructed === "string") {
      return repairRequired(reconstructed);
    }
    plannedModels.rows.push(reconstructed);
    plannedModels.raw.push(reconstructed.raw);
    plannedModels.changed = true;
    identity = activeIdentity(config, providers, plannedModels.rows);
  }
  if (typeof identity === "string") return repairRequired(identity);
  if (!plannedModels.changed) {
    return { status: "unchanged", activeRoute: identity };
  }
  const before = snapshot.files.models;
  if (before === null) return repairRequired("models_json_invalid");
  return {
    status: "repair",
    patches: [
      {
        role: "models",
        before: Buffer.from(before),
        after: Buffer.from(
          `${JSON.stringify(plannedModels.raw, null, 2)}\n`,
          "utf8",
        ),
      },
    ],
    activeRoute: identity,
    absorbedRowIds: plannedModels.absorbedRowIds,
  };
}
