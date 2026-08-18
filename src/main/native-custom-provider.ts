import { existsSync, readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import {
  customProviderRuntimeRoute,
  normalizeCustomProviderRuntimeName,
} from "../shared/custom-providers";
import { customProviderEnvKey } from "../shared/url-key-map";
import { profilePaths, safeWriteFile } from "./utils";
import { migrateModelConfigFormat } from "./config-model-migration";
import {
  writeManagedModelFile,
  type ModelConfigurationWritePermit,
} from "./model-configuration-managed-files";

export interface NativeCustomProviderInput {
  name: string;
  baseUrl: string;
  previousName?: string;
  model?: string;
  models?: readonly string[];
  apiMode?: string | null;
}

type UnknownRecord = Record<string, unknown>;

export interface NativeCustomProviderWritePlan<T> {
  readonly profileId: string;
  readonly target: string;
  readonly before: Buffer | null;
  readonly after: Buffer | null;
  readonly value: T;
}

function fileBytes(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null;
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

function nativeProviderPlan<T>(
  profile: string | undefined,
  target: string,
  before: Buffer | null,
  after: string | null,
  value: T,
): NativeCustomProviderWritePlan<T> {
  return Object.freeze({
    profileId: profile || "default",
    target,
    before,
    after: after === null ? null : Buffer.from(after),
    value,
  });
}

export function persistNativeCustomProviderPlan<T>(
  permit: ModelConfigurationWritePermit | null | undefined,
  plan: NativeCustomProviderWritePlan<T>,
): T {
  if (!sameBytes(fileBytes(plan.target), plan.before)) {
    throw new Error("Native custom provider write plan is stale.");
  }
  if (plan.after !== null) {
    writeManagedModelFile(permit, plan.target, plan.after);
  }
  return plan.value;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readConfig(profile?: string): {
  configFile: string;
  content: string;
} {
  const { configFile } = profilePaths(profile);
  return {
    configFile,
    content: existsSync(configFile) ? readFileSync(configFile, "utf8") : "",
  };
}

function configDocument(content: string): {
  document: ReturnType<typeof parseDocument>;
  root: UnknownRecord;
} {
  // Migrate legacy model: format before parsing to prevent duplicate key errors
  const migrated = migrateModelConfigFormat(content.trim() || "{}");

  const document = parseDocument(migrated.content);
  if (document.errors.length > 0) {
    throw new Error(
      `Cannot update Aera Runtime custom provider: ${document.errors[0].message}`,
    );
  }
  const root = asRecord(document.toJS()) ?? {};
  const providers = root.providers;
  if (
    providers !== undefined &&
    (providers === null ||
      typeof providers !== "object" ||
      Array.isArray(providers))
  ) {
    throw new Error(
      "Cannot update Aera Runtime custom provider: config.yaml providers must be a mapping.",
    );
  }
  // An empty profile is bootstrapped from `{}`. yaml preserves that root as a
  // flow-style map, so adding `providers` would otherwise serialize the whole
  // map on one line. The existing model-config writer intentionally performs
  // block-aware, comment-preserving edits and would then append `model:` after
  // the flow document, producing invalid YAML. Hermes config.yaml is a block
  // document; normalize only the root representation before the two writers
  // compose.
  if (document.contents && "flow" in document.contents) {
    document.contents.flow = false;
  }
  return { document, root };
}

/**
 * Upsert the named endpoint into Hermes Agent's native `providers:` schema.
 *
 * Secrets remain solely in the profile `.env`; `key_env` is the durable
 * reference. The returned `custom:<name>` value is the provider identity that
 * must be written to `model.provider` and carried on `session.create`.
 */
export function upsertNativeCustomProvider(
  profile: string | undefined,
  input: NativeCustomProviderInput,
): string {
  const plan = planNativeCustomProviderUpsert(profile, input);
  if (plan.after !== null) safeWriteFile(plan.target, plan.after);
  return plan.value;
}

export function planNativeCustomProviderUpsert(
  profile: string | undefined,
  input: NativeCustomProviderInput,
): NativeCustomProviderWritePlan<string> {
  const name = (input.name || "").trim();
  const baseUrl = (input.baseUrl || "").trim();
  if (!name || !baseUrl) {
    throw new Error("Custom provider name and base URL are required.");
  }

  const providerName = normalizeCustomProviderRuntimeName(name);
  const keyEnv = customProviderEnvKey(name);
  const { configFile, content } = readConfig(profile);
  const before = fileBytes(configFile);
  const { document, root } = configDocument(content);
  const providers = asRecord(root.providers) ?? {};

  // providers.json deduplicates names by their env-key anchor. Apply the same
  // rule to Hermes' native map so a cosmetic rename cannot leave two routable
  // entries pointing at one credential.
  const previousKeyEnv = input.previousName
    ? customProviderEnvKey(input.previousName)
    : "";
  for (const [key, value] of Object.entries(providers)) {
    const entry = asRecord(value);
    if (
      key !== providerName &&
      entry &&
      (String(entry.key_env || "").trim() === keyEnv ||
        (previousKeyEnv &&
          String(entry.key_env || "").trim() === previousKeyEnv))
    ) {
      document.deleteIn(["providers", key]);
    }
  }

  const path = ["providers", providerName];
  document.setIn([...path, "name"], name);
  document.setIn([...path, "api"], baseUrl);
  document.setIn([...path, "key_env"], keyEnv);

  const apiMode = (input.apiMode || "").trim();
  if (apiMode) {
    document.setIn([...path, "transport"], apiMode);
  } else if (input.apiMode === null) {
    document.deleteIn([...path, "transport"]);
  }

  const model = (input.model || "").trim();
  if (model) document.setIn([...path, "default_model"], model);

  if (input.models !== undefined) {
    const models = Array.from(
      new Set(input.models.map((value) => value.trim()).filter(Boolean)),
    );
    document.setIn(
      [...path, "models"],
      Object.fromEntries(models.map((value) => [value, {}])),
    );
  }

  return nativeProviderPlan(
    profile,
    configFile,
    before,
    document.toString({ lineWidth: 0 }),
    customProviderRuntimeRoute(name),
  );
}

/** Remove every native entry bound to this named provider's credential. */
export function removeNativeCustomProvider(
  profile: string | undefined,
  name: string,
): void {
  const plan = planNativeCustomProviderRemoval(profile, name);
  if (plan.after !== null) safeWriteFile(plan.target, plan.after);
}

export function planNativeCustomProviderRemoval(
  profile: string | undefined,
  name: string,
): NativeCustomProviderWritePlan<void> {
  const normalizedName = normalizeCustomProviderRuntimeName(name);
  const { configFile, content } = readConfig(profile);
  const before = fileBytes(configFile);
  if (!normalizedName) {
    return nativeProviderPlan(profile, configFile, before, null, undefined);
  }
  const keyEnv = customProviderEnvKey(name);
  if (!content.trim()) {
    return nativeProviderPlan(profile, configFile, before, null, undefined);
  }
  const { document, root } = configDocument(content);
  const providers = asRecord(root.providers);
  if (!providers) {
    return nativeProviderPlan(profile, configFile, before, null, undefined);
  }

  let changed = false;
  for (const [key, value] of Object.entries(providers)) {
    const entry = asRecord(value);
    const entryName = normalizeCustomProviderRuntimeName(
      String(entry?.name || key),
    );
    const entryKeyEnv = String(entry?.key_env || "").trim();
    if (
      normalizeCustomProviderRuntimeName(key) === normalizedName ||
      entryName === normalizedName ||
      entryKeyEnv === keyEnv
    ) {
      document.deleteIn(["providers", key]);
      changed = true;
    }
  }
  if (changed) {
    return nativeProviderPlan(
      profile,
      configFile,
      before,
      document.toString({ lineWidth: 0 }),
      undefined,
    );
  }
  return nativeProviderPlan(profile, configFile, before, null, undefined);
}
