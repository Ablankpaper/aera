import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { HERMES_HOME } from "./installer";
import { profilePaths } from "./utils";
import { hostDerivedEnvKeyForUrl } from "./host-derived-env";
import { customProviderEnvKey } from "../shared/url-key-map";
import type { ModelConfigurationMutationResult } from "../shared/model-configuration";
import DEFAULT_MODELS from "./default-models";
import {
  planApiServerKeyMigration,
  planEnvValueWrite,
  persistConfigWritePlan,
  readEnv,
  recordApiServerKeyMigration,
  type ApiServerKeyMigrationPlan,
} from "./config";
import type { ManagedModelFileInitialization } from "./model-configuration-coordinator";
import {
  currentModelConfigurationWritePermit,
  writeManagedModelFile,
  type ManagedModelFileRole,
  type ModelConfigurationWritePermit,
} from "./model-configuration-managed-files";

const MODELS_FILE = join(HERMES_HOME, "models.json");
const MODEL_DEFS_FILE = join(HERMES_HOME, "model-definitions.json");

export interface ModelCatalogFilePatch {
  readonly role: Extract<ManagedModelFileRole, "models" | "modelDefinitions">;
  readonly target: string;
  readonly before: Buffer | null;
  readonly after: Buffer;
}

export interface ModelCatalogWritePlan<T> {
  readonly patches: readonly ModelCatalogFilePatch[];
  readonly value: T;
}

function modelCatalogPatch(
  role: ModelCatalogFilePatch["role"],
  target: string,
  value: unknown,
  basePlan?: ModelCatalogWritePlan<unknown>,
): ModelCatalogFilePatch {
  const basePatch = basePlan?.patches.find(
    (candidate) => candidate.role === role,
  );
  return Object.freeze({
    role,
    target,
    before: basePatch
      ? basePatch.before
      : existsSync(target)
        ? readFileSync(target)
        : null,
    after: Buffer.from(JSON.stringify(value, null, 2)),
  });
}

function modelCatalogPlan<T>(
  patches: readonly ModelCatalogFilePatch[],
  value: T,
  basePlan?: ModelCatalogWritePlan<unknown>,
): ModelCatalogWritePlan<T> {
  const merged = new Map<
    ModelCatalogFilePatch["role"],
    ModelCatalogFilePatch
  >();
  for (const patch of basePlan?.patches ?? []) merged.set(patch.role, patch);
  for (const patch of patches) merged.set(patch.role, patch);
  return Object.freeze({
    patches: Object.freeze([...merged.values()]),
    value,
  });
}

function plannedModels(
  basePlan?: ModelCatalogWritePlan<unknown>,
): SavedModelRow[] {
  const patch = basePlan?.patches.find(
    (candidate) => candidate.role === "models",
  );
  if (!patch) return readModelsRaw();
  const parsed = JSON.parse(patch.after.toString("utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Invalid planned model catalog.");
  return parsed as SavedModelRow[];
}

function plannedModelDefinitions(
  basePlan?: ModelCatalogWritePlan<unknown>,
): Record<string, ModelDefinition> {
  const patch = basePlan?.patches.find(
    (candidate) => candidate.role === "modelDefinitions",
  );
  if (!patch) return readModelDefinitions();
  const parsed = JSON.parse(patch.after.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid planned model definitions.");
  }
  return parsed as Record<string, ModelDefinition>;
}

function modelCatalogBytesEqual(
  left: Buffer | null,
  right: Buffer | null,
): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

export function persistModelCatalogWritePlan<T>(
  permit: ModelConfigurationWritePermit | null | undefined,
  plan: ModelCatalogWritePlan<T>,
): T {
  for (const patch of plan.patches) {
    const current = existsSync(patch.target)
      ? readFileSync(patch.target)
      : null;
    if (!modelCatalogBytesEqual(current, patch.before)) {
      throw new Error("Model catalog write plan is stale.");
    }
  }
  for (const patch of plan.patches) {
    writeManagedModelFile(permit, patch.target, patch.after);
  }
  return plan.value;
}

function persistLegacyModelCatalogWritePlan<T>(
  plan: ModelCatalogWritePlan<T>,
): T {
  return persistModelCatalogWritePlan(
    currentModelConfigurationWritePermit(),
    plan,
  );
}

/**
 * A persisted `models.json` row — a pure *attachment* of a model id to a
 * provider/endpoint. Shared metadata (display name default, context window,
 * capabilities) lives once in a {@link ModelDefinition} keyed by `model` id, so
 * the same model id attached to two providers shares one definition instead of
 * re-storing it per row. `name` is kept on the row because the runtime derives
 * a custom-provider env key from `providerLabel || name` ([[src/main/hermes.ts]]),
 * so it must remain resolvable from the raw store.
 */
export interface SavedModelRow {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiMode?: string | null;
  /** Display name of the custom provider this model belongs to (only set for
   *  user-added named custom providers). Groups a provider's models together in
   *  the UI and, crucially, keys its API key: the runtime resolves
   *  `customProviderEnvKey(providerLabel)` so every model under one provider
   *  shares that provider's key rather than the shared `CUSTOM_API_KEY`. */
  providerLabel?: string;
  /** Stable providers.json id for named custom-provider attachments. */
  providerId?: string;
  createdAt: number;
}

/**
 * The public, read-time model shape: a {@link SavedModelRow} with its matching
 * {@link ModelDefinition} merged on. Every consumer (`resolveLibraryModelEntry`,
 * the chat/Providers pickers, the runtime spawn) sees this flat superset, so the
 * definitions layer is transparent to them.
 */
export interface SavedModel extends SavedModelRow {
  /** Optional manual context-window override (tokens), sourced from the shared
   *  {@link ModelDefinition}. When set, it's mirrored into config.yaml's
   *  `model.context_length` on activation — fixing the context gauge for
   *  providers that don't advertise `context_length` over /models, and driving
   *  the agent's auto-compaction threshold. */
  contextLength?: number;
  /** Model capabilities (e.g. "vision", "tools"), from the shared definition. */
  capabilities?: string[];
  /** Input/output modalities, from the shared definition. */
  modalities?: { input?: string[]; output?: string[] };
}

/**
 * Shared, per-model-id metadata. Defined once and merged onto every attachment
 * of that model id, so context window / display name / capabilities are entered
 * a single time and reused across providers. Stored in `model-definitions.json`;
 * local-only (like the per-row context override it replaces — the remote/SSH
 * library paths never carried it).
 */
export interface ModelDefinition {
  /** Canonical model id — the key. */
  model: string;
  /** Preferred display name (used when an attachment row has none). */
  name?: string;
  /** Manual context-window override (tokens). */
  contextLength?: number;
  capabilities?: string[];
  modalities?: { input?: string[]; output?: string[] };
  createdAt: number;
  updatedAt: number;
}

export interface ModelCatalogDerivedCredential {
  profileId: string;
  key: string;
  value: string;
}

export interface ModelCatalogInitializationPlan {
  targetProfileId: string;
  profileIds: readonly string[];
  seedDefaultModels: boolean;
  migrateModelDefinitions: boolean;
  persistDerivedCredentials: readonly ModelCatalogDerivedCredential[];
}

export interface ModelCatalogInitializationCoordinator {
  initializeManagedModelFiles(
    input: ManagedModelFileInitialization,
  ): Promise<ModelConfigurationMutationResult>;
}

interface InternalModelCatalogInitializationPlan {
  before: {
    models: Buffer | null;
    modelDefinitions: Buffer | null;
    env: Buffer | null;
  };
  modelsAfter: SavedModelRow[] | null;
  definitionsAfter: Record<string, ModelDefinition> | null;
  apiServerKeyMigration: ApiServerKeyMigrationPlan | null;
}

const internalInitializationPlans = new WeakMap<
  ModelCatalogInitializationPlan,
  InternalModelCatalogInitializationPlan
>();

/** Coerce an arbitrary value to a positive integer token count, or undefined. */
function normalizeContextLength(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? parseInt(value.trim(), 10)
        : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Raw persisted attachment rows — a plain JSON read with no definition merge.
 * Writers (`addModel`/`updateModel`/`removeModel`/`seedDefaults`/migration) use
 * this so merged-only fields (`contextLength`, `capabilities`, …) are never
 * written back onto a row. Legacy rows may still carry `contextLength`; it's
 * hoisted out by {@link ensureModelDefinitionsMigrated} and otherwise ignored.
 */
export function readModelsRaw(): SavedModelRow[] {
  try {
    if (!existsSync(MODELS_FILE)) return [];
    return JSON.parse(readFileSync(MODELS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function readModelsRawStrict(): SavedModelRow[] {
  if (!existsSync(MODELS_FILE)) return [];
  const parsed = JSON.parse(readFileSync(MODELS_FILE, "utf-8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("The model catalog is not a JSON array.");
  }
  return parsed as SavedModelRow[];
}

/**
 * Public read: raw rows with their matching {@link ModelDefinition} merged on.
 * `contextLength` comes from the definition (source of truth); a row's own
 * `name` is never overwritten (`row.name ?? def.name ?? id`) so the runtime's
 * env-key derivation from `name` stays stable. Read-only — no writes here, so it
 * is safe on the per-spawn runtime hot path ([[src/main/hermes.ts]] uses the raw
 * store directly and doesn't need the merge, but callers via IPC do).
 */
export function readModels(): SavedModel[] {
  const rows = readModelsRaw();
  const defs = readModelDefinitions();
  return rows.map((row) => {
    const def = defs[row.model];
    const merged: SavedModel = {
      ...row,
      name: row.name || def?.name || row.model,
    };
    if (def?.contextLength !== undefined)
      merged.contextLength = def.contextLength;
    if (def?.capabilities) merged.capabilities = def.capabilities;
    if (def?.modalities) merged.modalities = def.modalities;
    return merged;
  });
}

function writeModels(
  permit: ModelConfigurationWritePermit | null,
  models: SavedModelRow[],
): void {
  writeManagedModelFile(permit, MODELS_FILE, JSON.stringify(models, null, 2));
}

/** Read the definitions map (`{ [modelId]: ModelDefinition }`), tolerant of a
 *  missing/corrupt file. */
export function readModelDefinitions(): Record<string, ModelDefinition> {
  try {
    if (!existsSync(MODEL_DEFS_FILE)) return {};
    const parsed = JSON.parse(readFileSync(MODEL_DEFS_FILE, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readModelDefinitionsStrict(): Record<string, ModelDefinition> {
  if (!existsSync(MODEL_DEFS_FILE)) return {};
  const parsed = JSON.parse(readFileSync(MODEL_DEFS_FILE, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The model definition catalog is not a JSON object.");
  }
  return parsed as Record<string, ModelDefinition>;
}

function writeModelDefinitions(
  permit: ModelConfigurationWritePermit | null,
  defs: Record<string, ModelDefinition>,
): void {
  writeManagedModelFile(
    permit,
    MODEL_DEFS_FILE,
    JSON.stringify(defs, null, 2),
  );
}

export function listModelDefinitions(): ModelDefinition[] {
  return Object.values(readModelDefinitions());
}

export function getModelDefinition(model: string): ModelDefinition | null {
  return readModelDefinitions()[model] ?? null;
}

/**
 * Upsert a model definition (keyed by model id). A `contextLength` of `null`/`0`
 * clears the override; other patch fields set when provided. Bumps `updatedAt`.
 * Returns the resulting definition.
 */
export function setModelDefinition(
  model: string,
  patch: {
    name?: string;
    contextLength?: number | null;
    capabilities?: string[];
    modalities?: { input?: string[]; output?: string[] };
  },
): ModelDefinition {
  return persistLegacyModelCatalogWritePlan(
    planSetModelDefinition(model, patch),
  );
}

type ModelDefinitionPatch = Parameters<typeof setModelDefinition>[1];

function applyModelDefinitionPatch(
  definitions: Record<string, ModelDefinition>,
  model: string,
  patch: ModelDefinitionPatch,
): ModelDefinition {
  const defs = definitions;
  const now = Date.now();
  const prev = defs[model];
  const next: ModelDefinition = prev
    ? { ...prev, updatedAt: now }
    : { model, createdAt: now, updatedAt: now };
  if (patch.name !== undefined) next.name = patch.name.trim() || undefined;
  if (patch.contextLength !== undefined) {
    const ctx = normalizeContextLength(patch.contextLength);
    if (ctx !== undefined) next.contextLength = ctx;
    else delete next.contextLength;
  }
  if (patch.capabilities !== undefined)
    next.capabilities = patch.capabilities.length
      ? patch.capabilities
      : undefined;
  if (patch.modalities !== undefined) next.modalities = patch.modalities;
  defs[model] = next;
  return next;
}

export function planSetModelDefinition(
  model: string,
  patch: ModelDefinitionPatch,
  basePlan?: ModelCatalogWritePlan<unknown>,
): ModelCatalogWritePlan<ModelDefinition> {
  const defs = plannedModelDefinitions(basePlan);
  const next = applyModelDefinitionPatch(defs, model, patch);
  return modelCatalogPlan(
    [modelCatalogPatch("modelDefinitions", MODEL_DEFS_FILE, defs, basePlan)],
    next,
    basePlan,
  );
}

export function removeModelDefinition(model: string): boolean {
  return persistLegacyModelCatalogWritePlan(planRemoveModelDefinition(model));
}

export function planRemoveModelDefinition(
  model: string,
  basePlan?: ModelCatalogWritePlan<unknown>,
): ModelCatalogWritePlan<boolean> {
  const defs = plannedModelDefinitions(basePlan);
  if (!(model in defs)) return modelCatalogPlan([], false, basePlan);
  delete defs[model];
  return modelCatalogPlan(
    [modelCatalogPatch("modelDefinitions", MODEL_DEFS_FILE, defs, basePlan)],
    true,
    basePlan,
  );
}

/**
 * One-time hoist of legacy per-row `contextLength` (and `name`) into shared
 * definitions. For each raw row carrying a positive `contextLength`, upsert
 * `defs[row.model]` keeping the larger context window (safer gauge/compaction
 * value) and a first-wins name, then strip `contextLength` off the row. Merges
 * into any existing definitions file and is idempotent — after it runs no row
 * has `contextLength`, so a re-run hoists nothing.
 */
function planModelDefinitionMigration(
  rows: readonly SavedModelRow[],
  existingDefinitions: Readonly<Record<string, ModelDefinition>>,
): {
  rows: SavedModelRow[];
  definitions: Record<string, ModelDefinition>;
} | null {
  const rawRows = rows as Array<SavedModelRow & { contextLength?: number }>;
  const legacy = rawRows.filter(
    (r) => normalizeContextLength(r.contextLength) !== undefined,
  );
  if (legacy.length === 0) return null;

  const defs = { ...existingDefinitions };
  const now = Date.now();
  for (const row of legacy) {
    const ctx = normalizeContextLength(row.contextLength)!;
    const prev = defs[row.model];
    defs[row.model] = {
      model: row.model,
      name:
        prev?.name ??
        (row.name && row.name !== row.model ? row.name : undefined),
      contextLength: Math.max(prev?.contextLength ?? 0, ctx),
      capabilities: prev?.capabilities,
      modalities: prev?.modalities,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
  }
  const stripped = rawRows.map((r) => {
    const { contextLength: _drop, ...rest } = r;
    void _drop;
    return rest as SavedModelRow;
  });
  return { rows: stripped, definitions: defs };
}

export function ensureModelDefinitionsMigrated(): void {
  const migration = planModelDefinitionMigration(
    readModelsRawStrict(),
    readModelDefinitionsStrict(),
  );
  if (!migration) return;
  const permit = currentModelConfigurationWritePermit();
  writeModelDefinitions(permit, migration.definitions);
  writeModels(permit, migration.rows);
}

interface CustomProviderEntry {
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  apiMode?: string;
}

function loadCustomProviders(profile?: string): CustomProviderEntry[] {
  const { configFile } = profilePaths(profile);
  if (!existsSync(configFile)) return [];
  const content = readFileSync(configFile, "utf-8");
  const result: CustomProviderEntry[] = [];
  const lines = content.split("\n");
  let inCustom = false;
  let current: CustomProviderEntry | null = null;
  for (const line of lines) {
    if (/^\s*custom_providers\s*:/.test(line)) {
      inCustom = true;
      continue;
    }
    if (inCustom) {
      if (/^\s*-\s*name\s*:/.test(line)) {
        if (current && current.model && current.baseUrl) result.push(current);
        const m = line.match(/name\s*:\s*["']?([^"'\n#]+)["']?/);
        current = {
          name: m ? m[1].trim() : "Custom",
          provider: "custom",
          model: "",
          baseUrl: "",
        };
      } else if (current) {
        const bm = line.match(/base_url\s*:\s*["']?([^"'\n#]+)["']?/);
        if (bm) current.baseUrl = bm[1].trim();
        const mm = line.match(/^\s*model\s*:\s*["']?([^"'\n#]+)["']?/);
        if (mm) current.model = mm[1].trim();
        const am = line.match(/api_key\s*:\s*["']?([^"'\n#]+)["']?/);
        if (am) current.apiKey = am[1].trim();
        const apim = line.match(/api_mode\s*:\s*["']?([^"'\n#]+)["']?/);
        if (apim) current.apiMode = apim[1].trim();
      }
      if (
        /^[a-z]/.test(line) &&
        !/^\s/.test(line) &&
        !/^\s*-\s*name/.test(line)
      ) {
        if (current && current.model && current.baseUrl) result.push(current);
        inCustom = false;
        current = null;
      }
    }
  }
  if (current && current.model && current.baseUrl) result.push(current);
  return result;
}

function credentialKeysForCustomProvider(
  provider: CustomProviderEntry,
): string[] {
  const customPrefixKey = customProviderEnvKey(provider.name);
  const keys = [customPrefixKey];
  const hostKey = hostDerivedEnvKeyForUrl(provider.baseUrl);
  if (
    hostKey &&
    hostKey !== "OPENAI_API_KEY" &&
    hostKey !== "ANTHROPIC_API_KEY" &&
    hostKey !== customPrefixKey
  ) {
    keys.push(hostKey);
  }
  return keys;
}

function buildDefaultModelSeed(profileIds: readonly string[]): {
  rows: SavedModelRow[];
  credentials: ModelCatalogDerivedCredential[];
} {
  const now = Date.now();
  const rows: SavedModelRow[] = DEFAULT_MODELS.map((model) => ({
    id: randomUUID(),
    name: model.name,
    provider: model.provider,
    model: model.model,
    baseUrl: model.baseUrl,
    createdAt: now,
  }));
  const credentials = new Map<string, ModelCatalogDerivedCredential>();

  for (const profileId of profileIds) {
    const existingEnv = readEnv(profileId);
    for (const provider of loadCustomProviders(profileId)) {
      rows.push({
        id: randomUUID(),
        name: provider.name,
        provider: provider.provider,
        model: provider.model,
        baseUrl: provider.baseUrl,
        apiMode: provider.apiMode || null,
        createdAt: now,
      });
      if (!provider.apiKey || provider.apiKey === "no-key-required") continue;
      for (const key of credentialKeysForCustomProvider(provider)) {
        if (existingEnv[key] || credentials.has(`${profileId}\0${key}`)) {
          continue;
        }
        credentials.set(`${profileId}\0${key}`, {
          profileId,
          key,
          value: provider.apiKey,
        });
      }
    }
  }

  return { rows, credentials: [...credentials.values()] };
}

function fileBytes(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null;
}

function bytesEqual(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

const PROFILE_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/;

function normalizedInitializationProfiles(
  profileIds: readonly string[],
): string[] {
  const normalized = [
    ...new Set(profileIds.map((profileId) => profileId.trim())),
  ]
    .filter(Boolean)
    .sort();
  if (
    normalized.length === 0 ||
    normalized.some((profileId) => !PROFILE_ID_PATTERN.test(profileId))
  ) {
    throw new Error("Invalid model catalog initialization Profile.");
  }
  return normalized;
}

export function planModelCatalogInitialization(
  profileIds: readonly string[],
): ModelCatalogInitializationPlan {
  const normalizedProfiles = normalizedInitializationProfiles(profileIds);
  const targetProfileId = normalizedProfiles.includes("default")
    ? "default"
    : normalizedProfiles[0];
  const seedDefaultModels = !existsSync(MODELS_FILE);
  const seed = seedDefaultModels
    ? buildDefaultModelSeed([targetProfileId])
    : { rows: readModelsRawStrict(), credentials: [] };
  const definitions = readModelDefinitionsStrict();
  const definitionMigration = planModelDefinitionMigration(
    seed.rows,
    definitions,
  );
  const apiServerKeyMigration = planApiServerKeyMigration(targetProfileId);
  const persistDerivedCredentials = [...seed.credentials];
  if (apiServerKeyMigration) {
    persistDerivedCredentials.push({
      profileId: apiServerKeyMigration.profileId,
      key: "API_SERVER_KEY",
      value: apiServerKeyMigration.value,
    });
  }

  const plan: ModelCatalogInitializationPlan = Object.freeze({
    targetProfileId,
    profileIds: Object.freeze(normalizedProfiles.slice()),
    seedDefaultModels,
    migrateModelDefinitions: definitionMigration !== null,
    persistDerivedCredentials: Object.freeze(
      persistDerivedCredentials.map((credential) =>
        Object.freeze({ ...credential }),
      ),
    ),
  });
  const { envFile } = profilePaths(targetProfileId);
  internalInitializationPlans.set(plan, {
    before: {
      models: fileBytes(MODELS_FILE),
      modelDefinitions: fileBytes(MODEL_DEFS_FILE),
      env: fileBytes(envFile),
    },
    modelsAfter:
      definitionMigration?.rows ?? (seedDefaultModels ? seed.rows : null),
    definitionsAfter: definitionMigration?.definitions ?? null,
    apiServerKeyMigration,
  });
  return plan;
}

function initializationInput(
  plan: ModelCatalogInitializationPlan,
  internal: InternalModelCatalogInitializationPlan,
): ManagedModelFileInitialization {
  const { envFile } = profilePaths(plan.targetProfileId);
  let checkedBefore = false;
  const verifyBefore = (): void => {
    if (checkedBefore) return;
    checkedBefore = true;
    if (
      !bytesEqual(fileBytes(MODELS_FILE), internal.before.models) ||
      !bytesEqual(
        fileBytes(MODEL_DEFS_FILE),
        internal.before.modelDefinitions,
      ) ||
      !bytesEqual(fileBytes(envFile), internal.before.env)
    ) {
      throw new Error("Model catalog initialization plan is stale.");
    }
  };
  const changesRequired =
    internal.modelsAfter !== null ||
    internal.definitionsAfter !== null ||
    plan.persistDerivedCredentials.length > 0;
  return {
    targetProfileId: plan.targetProfileId,
    changesRequired,
    applyStage: (stage, permit) => {
      verifyBefore();
      if (stage === "credential") {
        for (const credential of plan.persistDerivedCredentials) {
          persistConfigWritePlan(
            permit,
            planEnvValueWrite(
              credential.key,
              credential.value,
              credential.profileId,
            ),
          );
        }
      }
      if (stage === "model_library") {
        if (internal.definitionsAfter) {
          writeModelDefinitions(permit, internal.definitionsAfter);
        }
        if (internal.modelsAfter) writeModels(permit, internal.modelsAfter);
      }
    },
    verify: () => {
      const modelsMatch = internal.modelsAfter
        ? JSON.stringify(readModelsRawStrict()) ===
          JSON.stringify(internal.modelsAfter)
        : bytesEqual(fileBytes(MODELS_FILE), internal.before.models);
      if (!modelsMatch) {
        return false;
      }
      const definitionsMatch = internal.definitionsAfter
        ? JSON.stringify(readModelDefinitionsStrict()) ===
          JSON.stringify(internal.definitionsAfter)
        : bytesEqual(
            fileBytes(MODEL_DEFS_FILE),
            internal.before.modelDefinitions,
          );
      if (!definitionsMatch) {
        return false;
      }
      if (plan.persistDerivedCredentials.length === 0) {
        return bytesEqual(fileBytes(envFile), internal.before.env);
      }
      return plan.persistDerivedCredentials.every((credential) => {
        return (
          readEnv(credential.profileId)[credential.key] === credential.value
        );
      });
    },
  };
}

export async function initializeModelCatalog(
  coordinator: ModelCatalogInitializationCoordinator,
  plan: ModelCatalogInitializationPlan,
): Promise<ModelConfigurationMutationResult> {
  const internal = internalInitializationPlans.get(plan);
  if (!internal) {
    throw new Error("Model catalog initialization plan was not created here.");
  }
  const result = await coordinator.initializeManagedModelFiles(
    initializationInput(plan, internal),
  );
  if (
    internal.apiServerKeyMigration &&
    (result.status === "committed" ||
      result.status === "committed_refresh_warning")
  ) {
    recordApiServerKeyMigration(internal.apiServerKeyMigration);
  }
  return result;
}

export function listModels(): SavedModel[] {
  return readModels();
}

export function addModel(
  name: string,
  provider: string,
  model: string,
  baseUrl: string,
  contextLength?: number,
  providerLabel?: string,
  apiMode?: string | null,
  providerId?: string,
): SavedModel {
  return persistLegacyModelCatalogWritePlan(
    planAddModel(
      name,
      provider,
      model,
      baseUrl,
      contextLength,
      providerLabel,
      apiMode,
      providerId,
    ),
  );
}

export function planAddModel(
  name: string,
  provider: string,
  model: string,
  baseUrl: string,
  contextLength?: number,
  providerLabel?: string,
  apiMode?: string | null,
  providerId?: string,
  basePlan?: ModelCatalogWritePlan<unknown>,
): ModelCatalogWritePlan<SavedModel> {
  const models = plannedModels(basePlan);
  const patches: ModelCatalogFilePatch[] = [];

  // A context-window override is shared metadata keyed by model id — persist it
  // to the definition, not onto this attachment row, so every provider serving
  // this model id reuses it.
  const ctx = normalizeContextLength(contextLength);
  if (ctx !== undefined) {
    const definitions = plannedModelDefinitions(basePlan);
    applyModelDefinitionPatch(definitions, model, { contextLength: ctx });
    patches.push(
      modelCatalogPatch(
        "modelDefinitions",
        MODEL_DEFS_FILE,
        definitions,
        basePlan,
      ),
    );
  }

  // Stable named providers remain distinct even when they expose the same
  // model at the same endpoint. A stable request may absorb only its own row or
  // a legacy row whose name anchor clearly identifies that provider; ambiguous
  // legacy rows and rows owned by another stable id remain separate.
  const norm = (u: string): string =>
    (u || "").trim().replace(/\/+$/, "").toLowerCase();
  const providerAnchor = providerId
    ? customProviderEnvKey(providerLabel || name)
    : "";
  const existingIndex = models.findIndex(
    (m) =>
      m.model === model &&
      m.provider === provider &&
      norm(m.baseUrl) === norm(baseUrl) &&
      (providerId
        ? m.providerId === providerId ||
          (!m.providerId &&
            customProviderEnvKey(m.providerLabel || m.name) === providerAnchor)
        : !m.providerId),
  );
  if (existingIndex !== -1) {
    const existing = models[existingIndex];
    if (apiMode !== undefined) {
      const normalizedApiMode = (apiMode || "").trim() || null;
      models[existingIndex] = { ...existing, apiMode: normalizedApiMode };
      patches.push(modelCatalogPatch("models", MODELS_FILE, models, basePlan));
    }
    return modelCatalogPlan(
      patches,
      {
        ...models[existingIndex],
        ...(ctx !== undefined ? { contextLength: ctx } : {}),
      },
      basePlan,
    );
  }

  const entry: SavedModelRow = {
    id: randomUUID(),
    name,
    provider,
    model,
    baseUrl: baseUrl || "",
    ...(apiMode !== undefined
      ? { apiMode: (apiMode || "").trim() || null }
      : {}),
    ...(providerLabel ? { providerLabel } : {}),
    ...(providerId ? { providerId } : {}),
    createdAt: Date.now(),
  };
  models.push(entry);
  patches.push(modelCatalogPatch("models", MODELS_FILE, models, basePlan));
  return modelCatalogPlan(
    patches,
    {
      ...entry,
      ...(ctx !== undefined ? { contextLength: ctx } : {}),
    },
    basePlan,
  );
}

function normalizedModelEndpoint(value: string): string {
  return (value || "").trim().replace(/\/+$/, "").toLocaleLowerCase();
}

/**
 * Move legacy and stable-id attachments to an edited named custom provider.
 * Existing rows are updated before the new catalog is added, so addModel's
 * normal deduplication keeps one row per model/endpoint/API mode.
 */
export function migrateModelsForCustomProvider(input: {
  providerId: string;
  oldName: string;
  oldBaseUrl: string;
  newName: string;
  newBaseUrl: string;
  apiMode?: string | null;
}): number {
  return persistLegacyModelCatalogWritePlan(
    planMigrateModelsForCustomProvider(input),
  );
}

export function planMigrateModelsForCustomProvider(
  input: {
    providerId: string;
    oldName: string;
    oldBaseUrl: string;
    newName: string;
    newBaseUrl: string;
    apiMode?: string | null;
  },
  basePlan?: ModelCatalogWritePlan<unknown>,
): ModelCatalogWritePlan<number> {
  const rows = plannedModels(basePlan);
  const oldAnchor = customProviderEnvKey(input.oldName);
  const newAnchor = customProviderEnvKey(input.newName);
  const oldEndpoint = normalizedModelEndpoint(input.oldBaseUrl);
  const newEndpoint = normalizedModelEndpoint(input.newBaseUrl);
  const next = rows.map((row) => {
    if (!isCustomProviderAttachment(row)) return row;
    const stableMatch = row.providerId === input.providerId;
    const legacyMatch =
      !row.providerId &&
      customProviderEnvKey(row.providerLabel || row.name) === oldAnchor &&
      normalizedModelEndpoint(row.baseUrl) === oldEndpoint;
    const targetLegacyMatch =
      !row.providerId &&
      customProviderEnvKey(row.providerLabel || row.name) === newAnchor &&
      normalizedModelEndpoint(row.baseUrl) === newEndpoint;
    if (!stableMatch && !legacyMatch && !targetLegacyMatch) return row;
    return {
      ...row,
      provider: "custom",
      providerId: input.providerId,
      providerLabel: input.newName,
      baseUrl: input.newBaseUrl,
      ...(input.apiMode !== undefined ? { apiMode: input.apiMode } : {}),
    };
  });

  const deduped: SavedModelRow[] = [];
  const seen = new Set<string>();
  for (const row of next) {
    if (row.providerId !== input.providerId) {
      deduped.push(row);
      continue;
    }
    const key = [
      row.provider,
      row.model,
      normalizedModelEndpoint(row.baseUrl),
      (row.apiMode || "").trim().toLocaleLowerCase(),
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  const changed =
    JSON.stringify(rows) !== JSON.stringify(deduped) ||
    next.some(
      (row, index) => JSON.stringify(row) !== JSON.stringify(rows[index]),
    );
  // Report the number of retained attachments after a rename. Duplicate
  // legacy rows may have been absorbed into one stable-id row.
  return modelCatalogPlan(
    changed
      ? [modelCatalogPatch("models", MODELS_FILE, deduped, basePlan)]
      : [],
    deduped.filter((row) => row.providerId === input.providerId).length,
    basePlan,
  );
}

function isCustomProviderAttachment(row: SavedModelRow): boolean {
  const provider = row.provider.trim().toLocaleLowerCase();
  return provider === "custom" || provider.startsWith("custom:");
}

export function removeModel(id: string): boolean {
  return persistLegacyModelCatalogWritePlan(planRemoveModel(id));
}

export function planRemoveModel(
  id: string,
  basePlan?: ModelCatalogWritePlan<unknown>,
): ModelCatalogWritePlan<boolean> {
  const models = plannedModels(basePlan);
  const filtered = models.filter((m) => m.id !== id);
  if (filtered.length === models.length) {
    return modelCatalogPlan([], false, basePlan);
  }
  return modelCatalogPlan(
    [modelCatalogPatch("models", MODELS_FILE, filtered, basePlan)],
    true,
    basePlan,
  );
}

/**
 * Remove every model-library attachment owned by one named custom provider.
 *
 * Current rows are keyed by `providerLabel`. Older rows predate that field, so
 * the provider's exact normalized endpoint is the only safe identity available
 * for those attachments. Shared model definitions are intentionally retained:
 * another provider may expose the same model id and reuse that metadata.
 */
export function removeModelsForCustomProvider(
  name: string,
  baseUrl?: string,
  providerId?: string,
): number {
  return persistLegacyModelCatalogWritePlan(
    planRemoveModelsForCustomProvider(name, baseUrl, providerId),
  );
}

export function planRemoveModelsForCustomProvider(
  name: string,
  baseUrl?: string,
  providerId?: string,
  basePlan?: ModelCatalogWritePlan<unknown>,
): ModelCatalogWritePlan<number> {
  const rows = plannedModels(basePlan);
  const providerAnchor = customProviderEnvKey(name.trim());
  const endpoint = (baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .toLocaleLowerCase();
  const next = rows.filter((row) => {
    const provider = row.provider.trim().toLocaleLowerCase();
    const labelMatches =
      Boolean(row.providerLabel) &&
      customProviderEnvKey(row.providerLabel || "") === providerAnchor;
    const namedRouteMatches =
      provider.startsWith("custom:") &&
      customProviderEnvKey(provider.slice("custom:".length)) === providerAnchor;
    const legacyEndpointMatches =
      !row.providerLabel &&
      provider === "custom" &&
      Boolean(endpoint) &&
      row.baseUrl.trim().replace(/\/+$/, "").toLocaleLowerCase() === endpoint;
    const stableIdMatches =
      providerId !== undefined && row.providerId === providerId;
    return !(
      stableIdMatches ||
      labelMatches ||
      namedRouteMatches ||
      legacyEndpointMatches
    );
  });
  const removed = rows.length - next.length;
  return modelCatalogPlan(
    removed > 0
      ? [modelCatalogPatch("models", MODELS_FILE, next, basePlan)]
      : [],
    removed,
    basePlan,
  );
}

export function updateModel(
  id: string,
  fields: Partial<
    Pick<
      SavedModelRow,
      | "name"
      | "provider"
      | "model"
      | "baseUrl"
      | "apiMode"
      | "providerLabel"
      | "providerId"
    >
  > & { contextLength?: number | null },
): boolean {
  return persistLegacyModelCatalogWritePlan(planUpdateModel(id, fields));
}

export function planUpdateModel(
  id: string,
  fields: Partial<
    Pick<
      SavedModelRow,
      | "name"
      | "provider"
      | "model"
      | "baseUrl"
      | "apiMode"
      | "providerLabel"
      | "providerId"
    >
  > & { contextLength?: number | null },
  basePlan?: ModelCatalogWritePlan<unknown>,
): ModelCatalogWritePlan<boolean> {
  const models = plannedModels(basePlan);
  const idx = models.findIndex((m) => m.id === id);
  if (idx === -1) return modelCatalogPlan([], false, basePlan);

  const { contextLength, ...rest } = fields;
  const next: SavedModelRow = { ...models[idx], ...rest };
  models[idx] = next;
  const patches: ModelCatalogFilePatch[] = [
    modelCatalogPatch("models", MODELS_FILE, models, basePlan),
  ];

  // `contextLength` is shared metadata: route it to the definition keyed by the
  // (possibly updated) model id, not onto the row. A positive value sets the
  // override; anything else clears it.
  if (contextLength !== undefined) {
    const definitions = plannedModelDefinitions(basePlan);
    applyModelDefinitionPatch(definitions, next.model, { contextLength });
    patches.push(
      modelCatalogPatch(
        "modelDefinitions",
        MODEL_DEFS_FILE,
        definitions,
        basePlan,
      ),
    );
  }
  return modelCatalogPlan(patches, true, basePlan);
}
