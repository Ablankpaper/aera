import type { ModelRouteIdentityV2 } from "../shared/model-configuration";
import { canonicalModelEndpointV2 } from "../shared/model-configuration";
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

function parseModelDefinitions(bytes: Buffer | null): boolean {
  let value: unknown;
  try {
    value = parseJson(bytes);
  } catch {
    return false;
  }
  if (value === null) return true;
  const definitions = asRecord(value);
  if (!definitions) return false;
  for (const [model, item] of Object.entries(definitions)) {
    const definition = asRecord(item);
    if (
      !model.trim() ||
      !definition ||
      (definition.model !== undefined && definition.model !== model) ||
      !Number.isSafeInteger(definition.createdAt) ||
      (definition.createdAt as number) < 0 ||
      !Number.isSafeInteger(definition.updatedAt) ||
      (definition.updatedAt as number) < 0
    ) {
      return false;
    }
  }
  return true;
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
  const rows: StrictModelRecord[] = [];
  const raw: UnknownRecord[] = [];
  const absorbedRowIds: string[] = [];
  let changed = false;

  for (const row of models) {
    const provider = providerForRow(row, providers, config);
    if (typeof provider === "string") return provider;
    if (provider === null) {
      rows.push(row);
      raw.push(row.raw);
      continue;
    }

    const adopted = row.providerId === null;
    const rowChanged =
      adopted ||
      row.providerLabel !== provider.name ||
      row.baseUrl !== provider.baseUrl;
    if (!rowChanged) {
      rows.push(row);
      raw.push(row.raw);
      continue;
    }
    changed = true;
    if (adopted) absorbedRowIds.push(row.id);
    const nextRaw: UnknownRecord = {
      ...row.raw,
      baseUrl: provider.baseUrl,
      providerLabel: provider.name,
      providerId: provider.id,
    };
    rows.push({
      ...row,
      baseUrl: provider.baseUrl,
      providerLabel: provider.name,
      providerId: provider.id,
      raw: nextRaw,
    });
    raw.push(nextRaw);
  }
  return { rows, raw, changed, absorbedRowIds };
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
  if (parseEnv(snapshot.files.env) === null) {
    return repairRequired("env_invalid");
  }
  const providers = parseProviders(snapshot.files.providers);
  if (providers === null) return repairRequired("providers_json_invalid");
  const providerIssue = providerConflict(providers);
  if (providerIssue) return repairRequired(providerIssue);
  const models = parseModels(snapshot.files.models);
  if (typeof models === "string") return repairRequired(models);
  if (!parseModelDefinitions(snapshot.files.modelDefinitions)) {
    return repairRequired("model_definitions_json_invalid");
  }
  const config = parseConfig(snapshot.files.config);
  if (typeof config === "string") return repairRequired(config);
  const plannedModels = plannedModelRows(models, providers, config);
  if (typeof plannedModels === "string") {
    return repairRequired(plannedModels);
  }
  const identity = activeIdentity(config, providers, plannedModels.rows);
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
