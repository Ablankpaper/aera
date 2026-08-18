// @lat: [[provider-setup#Provider setup#LLM-provider keys are configured-only, via modals#Named custom providers]]
import { existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import {
  type CustomProviderFile,
  type CustomProviderRecord,
} from "../shared/custom-providers";
import { customProviderEnvKey } from "../shared/url-key-map";
import { isValidProfileName, profileHome, safeWriteFile } from "./utils";
import {
  writeManagedModelFile,
  type ModelConfigurationWritePermit,
} from "./model-configuration-managed-files";

// Per-profile store of user-configured custom providers. Sits alongside the
// profile's `.env` (holds the key) and the global `models.json` (holds models);
// this file owns provider *identity* so a card renders as soon as it's saved,
// independent of whether any model has been added yet. Mirrors the shape and
// conventions of `wallet-store.ts` (versioned envelope, atomic writes), but is
// plaintext — it stores no secrets, only a name + base URL.
const PROVIDERS_FILE = "providers.json";

function providersPath(profile?: string): string {
  return join(profileHome(profile), PROVIDERS_FILE);
}

function normalizeProfile(profile?: string): string | undefined {
  const normalized =
    profile === "" || profile === "default" ? undefined : profile;
  if (normalized !== undefined && !isValidProfileName(normalized)) {
    throw new Error("Invalid profile name.");
  }
  return normalized;
}

function isRecord(value: unknown): value is CustomProviderRecord {
  const r = value as Partial<CustomProviderRecord>;
  return (
    !!r &&
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.baseUrl === "string" &&
    typeof r.createdAt === "number"
  );
}

function readProvidersFile(profile?: string): CustomProviderFile {
  const file = providersPath(profile);
  if (!existsSync(file)) return { version: 1, providers: [] };
  try {
    const parsed = JSON.parse(
      readFileSync(file, "utf-8"),
    ) as Partial<CustomProviderFile>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.providers)) {
      return { version: 1, providers: [] };
    }
    return { version: 1, providers: parsed.providers.filter(isRecord) };
  } catch {
    // A corrupt file shouldn't wipe the Providers screen — degrade to empty.
    return { version: 1, providers: [] };
  }
}

export interface CustomProviderWritePlan<T> {
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

function providerPlan<T>(
  profile: string | undefined,
  after: CustomProviderFile | null,
  value: T,
): CustomProviderWritePlan<T> {
  const profileId = profile ?? "default";
  const target = providersPath(profile);
  return Object.freeze({
    profileId,
    target,
    before: fileBytes(target),
    after: after === null ? null : Buffer.from(JSON.stringify(after, null, 2)),
    value,
  });
}

export function persistCustomProviderPlan<T>(
  permit: ModelConfigurationWritePermit | null | undefined,
  plan: CustomProviderWritePlan<T>,
): T {
  if (!sameBytes(fileBytes(plan.target), plan.before)) {
    throw new Error("Custom provider write plan is stale.");
  }
  if (plan.after !== null) {
    writeManagedModelFile(permit, plan.target, plan.after);
  }
  return plan.value;
}

/** All custom providers configured for `profile` (empty when none/no file). */
export function listCustomProviders(profile?: string): CustomProviderRecord[] {
  const normalized = normalizeProfile(profile);
  return readProvidersFile(normalized).providers;
}

/**
 * Create or update a custom provider by identity. Records are keyed by their
 * derived env-key name (`customProviderEnvKey(name)`) — the same anchor the
 * runtime uses to look the API key back up — so a re-save with the same name
 * updates the base URL in place instead of duplicating. Blank name or base URL
 * is a no-op (nothing durable to record yet).
 */
export function upsertCustomProvider(
  profile: string | undefined,
  input: { id?: string; name: string; baseUrl: string },
): CustomProviderRecord | null {
  const plan = planCustomProviderUpsert(profile, input);
  if (plan.after !== null) {
    safeWriteFile(plan.target, plan.after);
  }
  return plan.value;
}

export function planCustomProviderUpsert(
  profile: string | undefined,
  input: { id?: string; name: string; baseUrl: string },
): CustomProviderWritePlan<CustomProviderRecord | null> {
  const normalized = normalizeProfile(profile);
  const name = (input.name || "").trim();
  const baseUrl = (input.baseUrl || "").trim();
  if (!name || !baseUrl) return providerPlan(normalized, null, null);

  const anchor = customProviderEnvKey(name);
  const data = readProvidersFile(normalized);
  const existingById = input.id
    ? data.providers.find((provider) => provider.id === input.id)
    : undefined;
  if (input.id && !existingById) {
    throw new Error("Custom provider identity was not found.");
  }
  const existingByAnchor = data.providers.find(
    (p) => customProviderEnvKey(p.name) === anchor,
  );
  if (
    existingById &&
    existingByAnchor &&
    existingByAnchor.id !== existingById.id
  ) {
    throw new Error("Custom provider name is already in use.");
  }
  const existing = existingById || existingByAnchor;

  let record: CustomProviderRecord;
  if (existing) {
    // Preserve id/createdAt; refresh the display name + base URL.
    existing.name = name;
    existing.baseUrl = baseUrl;
    record = existing;
  } else {
    record = { id: randomUUID(), name, baseUrl, createdAt: Date.now() };
    data.providers.push(record);
  }
  return providerPlan(normalized, data, record);
}

/** Remove a custom provider by name (matched via its derived env-key anchor). */
export function removeCustomProvider(
  profile: string | undefined,
  name: string,
): void {
  const plan = planCustomProviderRemoval(profile, name);
  if (plan.after !== null) safeWriteFile(plan.target, plan.after);
}

export function planCustomProviderRemoval(
  profile: string | undefined,
  name: string,
): CustomProviderWritePlan<void> {
  const normalized = normalizeProfile(profile);
  const anchor = customProviderEnvKey((name || "").trim());
  const data = readProvidersFile(normalized);
  const next = data.providers.filter(
    (p) => customProviderEnvKey(p.name) !== anchor,
  );
  if (next.length !== data.providers.length) {
    return providerPlan(normalized, { version: 1, providers: next }, undefined);
  }
  return providerPlan(normalized, null, undefined);
}
