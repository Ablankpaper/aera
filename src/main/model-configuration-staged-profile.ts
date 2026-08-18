import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  openSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  dirname,
  isAbsolute,
  isAbsolute as pathIsAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { TextDecoder } from "node:util";
import { parseDocument } from "yaml";
import {
  customProviderRuntimeRoute,
  isCustomProviderRoute,
} from "../shared/custom-providers";
import { canonicalProviderBaseUrl } from "./provider-registry";
import {
  defaultModelConfigurationWriteAuthority,
  registerManagedModelProfileRoot,
  runWithManagedModelProfileRoot,
  unregisterManagedModelProfileRoot,
  type ModelConfigurationWriteAuthority,
} from "./model-configuration-write-authority";

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_MANAGED_FILE_BYTES = 32 * 1024 * 1024;
const ACTIVATION_JOURNAL = ".aera-profile-activation-journal.jsonl";
const STAGED_GLOBAL_CATALOG_FILES = [
  "models.json",
  "model-definitions.json",
] as const;

export type StagedProfileSourceKind =
  | "clone"
  | "agent_projection"
  | "encrypted_backup"
  | "import";

export type StagedProfileFailureCode =
  | "staged_profile_invalid"
  | "staged_profile_destination_exists"
  | "staged_profile_owner_changed"
  | "staged_profile_activation_failed";

export class StagedProfileError extends Error {
  readonly code: StagedProfileFailureCode;

  constructor(code: StagedProfileFailureCode) {
    super(`Aera staged Profile failed: ${code}.`);
    this.name = "StagedProfileError";
    this.code = code;
  }
}

export interface StagedProfileMaterializationContext {
  stagingHome: string;
  stagingPath: string;
}

export interface StagedProfileCandidate {
  readonly stagingPath: string;
  readonly stagingHome: string;
  readonly destinationProfileId: string;
  readonly destinationPath: string;
  readonly sourceKind: StagedProfileSourceKind;
  materialize<T>(
    callback: (
      context: StagedProfileMaterializationContext,
    ) => T | Promise<T>,
  ): Promise<T>;
  activate(input?: {
    authorize?: () => boolean | Promise<boolean>;
  }): Promise<string>;
  cleanup(): Promise<void>;
}

export interface CreateStagedProfileCandidateInput {
  profilesRoot: string;
  destinationProfileId: string;
  sourceKind: StagedProfileSourceKind;
  materialize(
    context: StagedProfileMaterializationContext,
  ): void | Promise<void>;
  writeAuthority?: ModelConfigurationWriteAuthority;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function strictFile(path: string): Buffer {
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size > MAX_MANAGED_FILE_BYTES
  ) {
    throw new StagedProfileError("staged_profile_invalid");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength !== stats.size) {
    bytes.fill(0);
    throw new StagedProfileError("staged_profile_invalid");
  }
  return bytes;
}

function strictUtf8(path: string): string {
  const bytes = strictFile(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StagedProfileError("staged_profile_invalid");
  } finally {
    bytes.fill(0);
  }
}

type UnknownRecord = Record<string, unknown>;

interface StrictProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
}

interface StrictModelRecord {
  provider: string;
  providerLabel: string | null;
  model: string;
  baseUrl: string;
  apiMode: string | null;
}

function invalidStagedProfile(): never {
  throw new StagedProfileError("staged_profile_invalid");
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function parseJson(path: string): unknown {
  try {
    const parsed = JSON.parse(strictUtf8(path)) as unknown;
    if (parsed === null || typeof parsed !== "object") invalidStagedProfile();
    return parsed;
  } catch (error) {
    if (error instanceof StagedProfileError) throw error;
    return invalidStagedProfile();
  }
}

function parseYaml(path: string): UnknownRecord {
  const document = parseDocument(strictUtf8(path), {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new StagedProfileError("staged_profile_invalid");
  }
  const value = document.toJS() as unknown;
  if (value === null) return {};
  return asRecord(value) ?? invalidStagedProfile();
}

function validateEnv(path: string): void {
  const content = strictUtf8(path);
  if (content.includes("\0")) invalidStagedProfile();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ")
      ? line.slice("export ".length).trimStart()
      : line;
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(assignment)) {
      invalidStagedProfile();
    }
  }
}

function parseProviders(path: string): StrictProviderRecord[] {
  if (!existsSync(path)) return [];
  const root = asRecord(parseJson(path)) ?? invalidStagedProfile();
  if (root.version !== 1 || !Array.isArray(root.providers)) {
    return invalidStagedProfile();
  }
  const providers: StrictProviderRecord[] = [];
  const ids = new Set<string>();
  for (const value of root.providers) {
    const record = asRecord(value) ?? invalidStagedProfile();
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const baseUrl =
      typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
    if (
      !id ||
      ids.has(id) ||
      !name ||
      !baseUrl ||
      !Number.isSafeInteger(record.createdAt) ||
      (record.createdAt as number) < 0
    ) {
      invalidStagedProfile();
    }
    ids.add(id);
    providers.push({ id, name, baseUrl });
  }
  return providers;
}

function parseModels(path: string): StrictModelRecord[] {
  if (!existsSync(path)) return [];
  const value = parseJson(path);
  if (!Array.isArray(value)) return invalidStagedProfile();
  const rows: StrictModelRecord[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const record = asRecord(item) ?? invalidStagedProfile();
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const provider =
      typeof record.provider === "string" ? record.provider.trim() : "";
    const model =
      typeof record.model === "string" ? record.model.trim() : "";
    const baseUrl =
      typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
    const providerLabel =
      record.providerLabel === undefined
        ? null
        : typeof record.providerLabel === "string"
          ? record.providerLabel.trim()
          : invalidStagedProfile();
    const apiMode =
      record.apiMode === undefined || record.apiMode === null
        ? null
        : typeof record.apiMode === "string"
          ? record.apiMode.trim() || null
          : invalidStagedProfile();
    if (
      !id ||
      ids.has(id) ||
      !name ||
      !provider ||
      !model ||
      !Number.isSafeInteger(record.createdAt) ||
      (record.createdAt as number) < 0
    ) {
      invalidStagedProfile();
    }
    ids.add(id);
    rows.push({ provider, providerLabel, model, baseUrl, apiMode });
  }
  return rows;
}

function validateModelDefinitions(path: string): void {
  if (!existsSync(path)) return;
  const definitions = asRecord(parseJson(path)) ?? invalidStagedProfile();
  for (const [model, value] of Object.entries(definitions)) {
    const definition = asRecord(value) ?? invalidStagedProfile();
    if (!model.trim()) invalidStagedProfile();
    if (
      definition.model !== undefined &&
      (typeof definition.model !== "string" || definition.model !== model)
    ) {
      invalidStagedProfile();
    }
  }
}

function normalizedEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

function effectiveEndpoint(provider: string, baseUrl: string): string {
  return normalizedEndpoint(
    baseUrl || canonicalProviderBaseUrl(provider) || "",
  );
}

function rowProviderMatches(
  row: StrictModelRecord,
  configuredProvider: string,
): boolean {
  if (!isCustomProviderRoute(configuredProvider)) {
    return row.provider.toLowerCase() === configuredProvider.toLowerCase();
  }
  if (!isCustomProviderRoute(row.provider)) return false;
  if (configuredProvider.toLowerCase() === "custom") {
    return row.provider.toLowerCase() === "custom";
  }
  return (
    row.providerLabel !== null &&
    customProviderRuntimeRoute(row.providerLabel) === configuredProvider
  );
}

function validateActiveRoute(
  config: UnknownRecord,
  providers: readonly StrictProviderRecord[],
  models: readonly StrictModelRecord[],
): void {
  if (config.model === undefined || config.model === null) return;
  const modelBlock = asRecord(config.model) ?? invalidStagedProfile();
  const provider =
    typeof modelBlock.provider === "string" ? modelBlock.provider.trim() : "";
  const model =
    typeof modelBlock.default === "string" ? modelBlock.default.trim() : "";
  const baseUrl =
    modelBlock.base_url === undefined || modelBlock.base_url === null
      ? ""
      : typeof modelBlock.base_url === "string"
        ? modelBlock.base_url.trim()
        : invalidStagedProfile();
  const apiMode =
    modelBlock.api_mode === undefined || modelBlock.api_mode === null
      ? null
      : typeof modelBlock.api_mode === "string"
        ? modelBlock.api_mode.trim().toLowerCase() || null
        : invalidStagedProfile();
  if (!provider && !model && !baseUrl && apiMode === null) return;
  // Beta.32 and earlier legitimately persisted `model.default` without an
  // explicit provider. Runtime treats that shape as the legacy `auto` route,
  // so staging must preserve it rather than making an otherwise valid clone
  // impossible to activate. Once a provider (or provider-specific field) is
  // present, however, the route must be complete and uniquely represented by
  // the staged catalog below.
  if (!provider) {
    if (model && !baseUrl && apiMode === null) return;
    invalidStagedProfile();
  }
  if (!model) invalidStagedProfile();

  const configuredEndpoint = effectiveEndpoint(provider, baseUrl);
  if (isCustomProviderRoute(provider) && provider.toLowerCase() !== "custom") {
    const matchingProviders = providers.filter(
      (candidate) =>
        customProviderRuntimeRoute(candidate.name) === provider &&
        normalizedEndpoint(candidate.baseUrl) === configuredEndpoint,
    );
    if (matchingProviders.length !== 1) invalidStagedProfile();
  }

  const candidates = models.filter(
    (candidate) =>
      candidate.model === model &&
      rowProviderMatches(candidate, provider) &&
      effectiveEndpoint(candidate.provider, candidate.baseUrl) ===
        configuredEndpoint &&
      (apiMode === null ||
        (candidate.apiMode ?? "").toLowerCase() === apiMode),
  );
  if (candidates.length !== 1) invalidStagedProfile();
}

function validateTree(root: string, directory = root): void {
  const directoryStats = lstatSync(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new StagedProfileError("staged_profile_invalid");
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      const link = readlinkSync(path);
      if (pathIsAbsolute(link) || !inside(root, resolve(dirname(path), link))) {
        throw new StagedProfileError("staged_profile_invalid");
      }
      continue;
    }
    if (stats.isDirectory()) {
      validateTree(root, path);
      continue;
    }
    if (!stats.isFile()) {
      throw new StagedProfileError("staged_profile_invalid");
    }
  }
}

function validateManagedFiles(stagingHome: string, profilePath: string): void {
  validateTree(profilePath);
  const envPath = join(profilePath, ".env");
  // Beta.32 and fresh Runtime Profiles may legitimately have no credentials
  // yet. Absence is a valid managed-file state; when .env exists it still has
  // to pass the strict file and assignment parser below.
  if (existsSync(envPath)) validateEnv(envPath);
  const configPath = join(profilePath, "config.yaml");
  const config = existsSync(configPath) ? parseYaml(configPath) : {};
  const providersPath = join(profilePath, "providers.json");
  const providers = parseProviders(providersPath);
  const models = parseModels(join(stagingHome, "models.json"));
  validateModelDefinitions(join(stagingHome, "model-definitions.json"));
  validateActiveRoute(config, providers, models);
}

/**
 * Profile materialization may read a staged copy of the global catalog for
 * route validation, but it must never publish or silently discard a changed
 * global catalog. Global model mutations belong to the coordinator's own
 * transaction path. Requiring an exact snapshot here makes that boundary
 * explicit and lets activation hold the global lock while checking it again.
 */
function validateStagedGlobalCatalogSnapshot(
  liveHome: string,
  stagingHome: string,
): void {
  for (const filename of STAGED_GLOBAL_CATALOG_FILES) {
    const livePath = join(liveHome, filename);
    const stagedPath = join(stagingHome, filename);
    const liveExists = existsSync(livePath);
    const stagedExists = existsSync(stagedPath);
    if (liveExists !== stagedExists) invalidStagedProfile();
    if (!liveExists) continue;

    const liveBytes = strictFile(livePath);
    const stagedBytes = strictFile(stagedPath);
    try {
      if (!liveBytes.equals(stagedBytes)) invalidStagedProfile();
    } finally {
      liveBytes.fill(0);
      stagedBytes.fill(0);
    }
  }
}

function absoluteDirectory(path: string): string {
  if (!isAbsolute(path)) {
    throw new StagedProfileError("staged_profile_invalid");
  }
  const canonical = resolve(path);
  const stats = lstatSync(canonical);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new StagedProfileError("staged_profile_invalid");
  }
  return canonical;
}

function appendActivationRecord(
  journalPath: string,
  record: {
    transactionId: string;
    profileId: string;
    sourceKind: StagedProfileSourceKind;
    state: "staged" | "committed" | "rolled_back";
  },
): void {
  appendFileSync(
    journalPath,
    `${JSON.stringify({ version: 1, ...record })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(journalPath, 0o600);
  const descriptor = openSync(journalPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function createStagedProfileCandidate(
  input: CreateStagedProfileCandidateInput,
): Promise<StagedProfileCandidate> {
  if (
    !input ||
    typeof input !== "object" ||
    !PROFILE_ID_PATTERN.test(input.destinationProfileId) ||
    !["clone", "agent_projection", "encrypted_backup", "import"].includes(
      input.sourceKind,
    ) ||
    typeof input.materialize !== "function"
  ) {
    throw new StagedProfileError("staged_profile_invalid");
  }
  const profilesRoot = absoluteDirectory(input.profilesRoot);
  const destinationPath = resolve(profilesRoot, input.destinationProfileId);
  if (
    dirname(destinationPath) !== profilesRoot ||
    existsSync(destinationPath)
  ) {
    throw new StagedProfileError("staged_profile_destination_exists");
  }

  const stagingRoot = resolve(dirname(profilesRoot), ".aera-profile-staging");
  if (!existsSync(stagingRoot))
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const stagingStats = lstatSync(stagingRoot);
  if (stagingStats.isSymbolicLink() || !stagingStats.isDirectory()) {
    throw new StagedProfileError("staged_profile_invalid");
  }
  chmodSync(stagingRoot, 0o700);

  const transactionId = randomUUID();
  const transactionPath = join(stagingRoot, transactionId);
  mkdirSync(transactionPath, { mode: 0o700 });
  const journalPath = join(dirname(profilesRoot), ACTIVATION_JOURNAL);
  chmodSync(transactionPath, 0o700);
  const stagingHome = join(transactionPath, "home");
  const stagingProfilesRoot = join(stagingHome, "profiles");
  const stagingPath = join(stagingProfilesRoot, input.destinationProfileId);
  const liveHome = dirname(profilesRoot);
  mkdirSync(stagingProfilesRoot, { recursive: true, mode: 0o700 });

  let state: "staged" | "activated" | "cleaned" = "staged";
  let journalStarted = false;
  const cleanup = async (): Promise<void> => {
    if (state === "cleaned") return;
    if (state === "staged" && journalStarted) {
      try {
        appendActivationRecord(journalPath, {
          transactionId,
          profileId: input.destinationProfileId,
          sourceKind: input.sourceKind,
          state: "rolled_back",
        });
      } catch {
        // Preserve the original staging failure while cleanup remains bounded
        // to this transaction directory.
      }
    }
    rmSync(transactionPath, { recursive: true, force: true });
    if (state !== "activated") state = "cleaned";
  };

  try {
    await runWithManagedModelProfileRoot(
      input.destinationProfileId,
      stagingPath,
      () => input.materialize({ stagingHome, stagingPath }),
    );
    if (!existsSync(stagingPath)) {
      throw new StagedProfileError("staged_profile_invalid");
    }
    validateManagedFiles(stagingHome, stagingPath);
    validateStagedGlobalCatalogSnapshot(liveHome, stagingHome);
    appendActivationRecord(journalPath, {
      transactionId,
      profileId: input.destinationProfileId,
      sourceKind: input.sourceKind,
      state: "staged",
    });
    journalStarted = true;
  } catch (error) {
    await cleanup();
    throw error;
  }

  const writeAuthority =
    input.writeAuthority ?? defaultModelConfigurationWriteAuthority;
  return {
    stagingPath,
    stagingHome,
    destinationProfileId: input.destinationProfileId,
    destinationPath,
    sourceKind: input.sourceKind,
    async materialize<T>(
      callback: (
        context: StagedProfileMaterializationContext,
      ) => T | Promise<T>,
    ): Promise<T> {
      if (state !== "staged" || typeof callback !== "function") {
        throw new StagedProfileError("staged_profile_activation_failed");
      }
      return writeAuthority.run(
        {
          globalCatalog: false,
          profileIds: [input.destinationProfileId],
        },
        async () => {
          if (state !== "staged" || existsSync(destinationPath)) {
            throw new StagedProfileError(
              existsSync(destinationPath)
                ? "staged_profile_destination_exists"
                : "staged_profile_activation_failed",
            );
          }
          const value = await runWithManagedModelProfileRoot(
            input.destinationProfileId,
            stagingPath,
            () => callback({ stagingHome, stagingPath }),
          );
          validateManagedFiles(stagingHome, stagingPath);
          validateStagedGlobalCatalogSnapshot(liveHome, stagingHome);
          return value;
        },
      );
    },
    async activate(activation = {}): Promise<string> {
      if (state !== "staged") {
        throw new StagedProfileError("staged_profile_activation_failed");
      }
      try {
        return await writeAuthority.run(
          {
            globalCatalog: false,
            profileIds: [input.destinationProfileId],
          },
          async () => {
            if (activation.authorize && !(await activation.authorize())) {
              throw new StagedProfileError("staged_profile_owner_changed");
            }
            if (existsSync(destinationPath)) {
              throw new StagedProfileError("staged_profile_destination_exists");
            }
            validateStagedGlobalCatalogSnapshot(liveHome, stagingHome);
            validateManagedFiles(stagingHome, stagingPath);
            renameSync(stagingPath, destinationPath);
            let registered = false;
            try {
              registerManagedModelProfileRoot(
                input.destinationProfileId,
                destinationPath,
              );
              registered = true;
              appendActivationRecord(journalPath, {
                transactionId,
                profileId: input.destinationProfileId,
                sourceKind: input.sourceKind,
                state: "committed",
              });
            } catch (error) {
              if (registered) {
                unregisterManagedModelProfileRoot(
                  input.destinationProfileId,
                  destinationPath,
                );
              }
              renameSync(destinationPath, stagingPath);
              throw error;
            }
            state = "activated";
            rmSync(transactionPath, { recursive: true, force: true });
            return destinationPath;
          },
        );
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
    cleanup,
  };
}

const ACTIVATION_TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StagedActivationRecord {
  version: 1;
  transactionId: string;
  profileId: string;
  sourceKind: StagedProfileSourceKind;
  state: "staged" | "committed" | "rolled_back";
}

function parseActivationRecord(line: string): StagedActivationRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return invalidStagedProfile();
  }
  const record = asRecord(value) ?? invalidStagedProfile();
  if (
    record.version !== 1 ||
    typeof record.transactionId !== "string" ||
    !ACTIVATION_TRANSACTION_ID_PATTERN.test(record.transactionId) ||
    typeof record.profileId !== "string" ||
    !PROFILE_ID_PATTERN.test(record.profileId) ||
    !["clone", "agent_projection", "encrypted_backup", "import"].includes(
      String(record.sourceKind),
    ) ||
    !["staged", "committed", "rolled_back"].includes(String(record.state))
  ) {
    return invalidStagedProfile();
  }
  return record as unknown as StagedActivationRecord;
}

/**
 * Recover only transactions named by this feature's journal. A staged entry
 * with its candidate directory still present is never published after a
 * restart; a missing candidate plus a valid destination is the unique
 * post-rename window and is completed as committed. Other evidence directories
 * are not inspected or removed.
 */
export async function recoverStagedProfileActivations(input: {
  profilesRoot: string;
  writeAuthority?: ModelConfigurationWriteAuthority;
}): Promise<void> {
  if (!isAbsolute(input.profilesRoot)) {
    throw new StagedProfileError("staged_profile_invalid");
  }
  const requestedProfilesRoot = resolve(input.profilesRoot);
  const profilesRoot = existsSync(requestedProfilesRoot)
    ? absoluteDirectory(requestedProfilesRoot)
    : requestedProfilesRoot;
  const journalPath = join(dirname(profilesRoot), ACTIVATION_JOURNAL);
  if (!existsSync(journalPath)) return;
  const journalText = strictUtf8(journalPath);
  const latest = new Map<string, StagedActivationRecord>();
  for (const line of journalText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = parseActivationRecord(line);
    latest.set(record.transactionId, record);
  }
  const stagingRoot = resolve(dirname(profilesRoot), ".aera-profile-staging");
  if (!existsSync(stagingRoot)) return;
  const stagingStats = lstatSync(stagingRoot);
  if (stagingStats.isSymbolicLink() || !stagingStats.isDirectory()) {
    throw new StagedProfileError("staged_profile_invalid");
  }
  const writeAuthority =
    input.writeAuthority ?? defaultModelConfigurationWriteAuthority;

  for (const record of latest.values()) {
    const transactionPath = join(stagingRoot, record.transactionId);
    if (!inside(stagingRoot, transactionPath)) {
      throw new StagedProfileError("staged_profile_invalid");
    }
    const stagingHome = join(transactionPath, "home");
    const stagingPath = join(
      stagingHome,
      "profiles",
      record.profileId,
    );
    const destinationPath = resolve(profilesRoot, record.profileId);
    await writeAuthority.run(
      { globalCatalog: false, profileIds: [record.profileId] },
      async () => {
        if (record.state !== "staged") {
          if (existsSync(transactionPath)) {
            rmSync(transactionPath, { recursive: true, force: true });
          }
          return;
        }
        const hasCandidate = existsSync(stagingPath);
        const hasDestination = existsSync(destinationPath);
        if (hasCandidate) {
          // A destination collision cannot authorize publishing this candidate;
          // preserve the existing destination and roll back only this tx.
          appendActivationRecord(journalPath, {
            transactionId: record.transactionId,
            profileId: record.profileId,
            sourceKind: record.sourceKind,
            state: "rolled_back",
          });
          rmSync(transactionPath, { recursive: true, force: true });
          return;
        }
        if (hasDestination && existsSync(stagingHome)) {
          // The Profile was already renamed before the process stopped. The
          // old staging snapshot may now be stale, so validate the published
          // Profile against the currently locked live catalog before closing
          // the journal instead of guessing or deleting live bytes.
          validateManagedFiles(dirname(profilesRoot), destinationPath);
          registerManagedModelProfileRoot(record.profileId, destinationPath);
          appendActivationRecord(journalPath, {
            transactionId: record.transactionId,
            profileId: record.profileId,
            sourceKind: record.sourceKind,
            state: "committed",
          });
          rmSync(transactionPath, { recursive: true, force: true });
          return;
        }
        if (!hasDestination) {
          appendActivationRecord(journalPath, {
            transactionId: record.transactionId,
            profileId: record.profileId,
            sourceKind: record.sourceKind,
            state: "rolled_back",
          });
          if (existsSync(transactionPath)) {
            rmSync(transactionPath, { recursive: true, force: true });
          }
          return;
        }
        // A live destination without the transaction's staging home cannot be
        // attributed safely; never delete or overwrite it.
        throw new StagedProfileError("staged_profile_activation_failed");
      },
    );
  }
}
