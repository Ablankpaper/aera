import { existsSync, readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import {
  customProviderRuntimeRoute,
  normalizeCustomProviderRuntimeName,
} from "../shared/custom-providers";
import { customProviderEnvKey } from "../shared/url-key-map";
import { profilePaths, safeWriteFile } from "./utils";

export interface NativeCustomProviderInput {
  name: string;
  baseUrl: string;
  model?: string;
  models?: readonly string[];
  apiMode?: string | null;
}

type UnknownRecord = Record<string, unknown>;

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
  const document = parseDocument(content.trim() ? content : "{}");
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
  const name = (input.name || "").trim();
  const baseUrl = (input.baseUrl || "").trim();
  if (!name || !baseUrl) {
    throw new Error("Custom provider name and base URL are required.");
  }

  const providerName = normalizeCustomProviderRuntimeName(name);
  const keyEnv = customProviderEnvKey(name);
  const { configFile, content } = readConfig(profile);
  const { document, root } = configDocument(content);
  const providers = asRecord(root.providers) ?? {};

  // providers.json deduplicates names by their env-key anchor. Apply the same
  // rule to Hermes' native map so a cosmetic rename cannot leave two routable
  // entries pointing at one credential.
  for (const [key, value] of Object.entries(providers)) {
    const entry = asRecord(value);
    if (
      key !== providerName &&
      entry &&
      String(entry.key_env || "").trim() === keyEnv
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

  safeWriteFile(configFile, document.toString({ lineWidth: 0 }));
  return customProviderRuntimeRoute(name);
}

/** Remove every native entry bound to this named provider's credential. */
export function removeNativeCustomProvider(
  profile: string | undefined,
  name: string,
): void {
  const normalizedName = normalizeCustomProviderRuntimeName(name);
  if (!normalizedName) return;
  const keyEnv = customProviderEnvKey(name);
  const { configFile, content } = readConfig(profile);
  if (!content.trim()) return;
  const { document, root } = configDocument(content);
  const providers = asRecord(root.providers);
  if (!providers) return;

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
    safeWriteFile(configFile, document.toString({ lineWidth: 0 }));
  }
}
