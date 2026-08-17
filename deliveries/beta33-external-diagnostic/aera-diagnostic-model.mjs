/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { collectModelJournal } from "./aera-diagnostic-sqlite.mjs";

export const REQUIRED_MODEL_FILE_ROLES = [
  "env",
  "providers",
  "models",
  "modelDefinitions",
  "config",
];

function hash(domain, value) {
  if (value == null || String(value).length === 0) return null;
  return createHash("sha256")
    .update(`${domain}\0${String(value)}`, "utf8")
    .digest("hex");
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizeProvider(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^custom:/, "");
}

function normalizeEndpoint(value) {
  const raw = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.toLowerCase();
  }
}

export function managedModelPaths(hermesHome, profile) {
  const profileRoot =
    profile === "default" ? hermesHome : join(hermesHome, "profiles", profile);
  return {
    env: join(profileRoot, ".env"),
    providers: join(profileRoot, "providers.json"),
    models: join(hermesHome, "models.json"),
    modelDefinitions: join(hermesHome, "model-definitions.json"),
    config: join(profileRoot, "config.yaml"),
  };
}

export function snapshotManagedModelFiles(paths, phase) {
  return REQUIRED_MODEL_FILE_ROLES.map((role) => {
    const path = paths[role];
    try {
      const info = statSync(path);
      return {
        phase,
        role,
        exists: true,
        size: info.size,
        mtime: info.mtime.toISOString(),
        sha256: fileHash(path),
      };
    } catch (error) {
      return {
        phase,
        role,
        exists: false,
        size: null,
        mtime: null,
        sha256: null,
        reason: error?.code === "ENOENT" ? "file_missing" : "file_unavailable",
      };
    }
  });
}

export function compareModelSnapshots(before, after) {
  const afterByRole = new Map(after.map((entry) => [entry.role, entry]));
  const changes = before.map((entry) => {
    const current = afterByRole.get(entry.role);
    const changed =
      !current ||
      entry.exists !== current.exists ||
      entry.size !== current.size ||
      entry.sha256 !== current.sha256;
    return {
      role: entry.role,
      changed,
      beforeSha256: entry.sha256,
      afterSha256: current?.sha256 ?? null,
      beforeExists: entry.exists,
      afterExists: current?.exists ?? false,
    };
  });
  return {
    changes,
    changedRoles: changes
      .filter((entry) => entry.changed)
      .map((entry) => entry.role),
    unchangedRoles: changes
      .filter((entry) => !entry.changed)
      .map((entry) => entry.role),
  };
}

function parseJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8").slice(0, 4 * 1024 * 1024));
  } catch {
    return fallback;
  }
}

function unquote(value) {
  const text = String(value || "").trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return text.replace(/\s+#.*$/, "").trim();
}

function readConfigRoute(path) {
  if (!existsSync(path)) return null;
  let content;
  try {
    content = readFileSync(path, "utf8").slice(0, 256 * 1024);
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => /^model:\s*(?:#.*)?$/.test(line));
  if (index < 0) return null;
  const fields = {};
  let indent = null;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const match = line.match(/^(\s+)([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!match) continue;
    indent ??= match[1].length;
    if (match[1].length !== indent) continue;
    fields[match[2]] = unquote(match[3]);
  }
  if (!fields.provider || !fields.default) return null;
  return {
    provider: normalizeProvider(fields.provider),
    model: String(fields.default).trim(),
    endpoint: normalizeEndpoint(fields.base_url),
    apiMode: String(fields.api_mode || "").trim(),
  };
}

function routeSummary(route, sources) {
  const provider = normalizeProvider(route.provider);
  const model = String(route.model || route.name || "").trim();
  const endpoint = normalizeEndpoint(route.endpoint ?? route.baseUrl);
  const apiMode = String(route.apiMode || "").trim();
  const canonical = `${provider}\0${model}\0${endpoint}\0${apiMode}`;
  return {
    routeSha256: hash("aera-diagnostic-route-v1", canonical),
    providerSha256: hash("aera-diagnostic-provider-v1", provider),
    modelSha256: hash("aera-diagnostic-model-v1", model),
    endpointSha256: hash("aera-diagnostic-endpoint-v1", endpoint),
    groupSha256: hash(
      "aera-diagnostic-route-group-v1",
      `${provider}\0${model}\0${apiMode}`,
    ),
    apiMode: /^[a-z][a-z0-9_]{0,63}$/i.test(apiMode) ? apiMode : "unknown",
    sources: [...new Set(sources)].sort(),
  };
}

function collectRouteCatalog(paths) {
  const providerDoc = parseJson(paths.providers, {});
  const providerRows = Array.isArray(providerDoc?.providers)
    ? providerDoc.providers
    : [];
  const authoritativeEndpoints = providerRows
    .map((row) => ({
      providerSha256: hash(
        "aera-diagnostic-provider-v1",
        normalizeProvider(row.id || row.name),
      ),
      endpointSha256: hash(
        "aera-diagnostic-endpoint-v1",
        normalizeEndpoint(row.baseUrl),
      ),
    }))
    .filter((row) => row.providerSha256 && row.endpointSha256);

  const modelRows = parseJson(paths.models, []);
  const routes = Array.isArray(modelRows)
    ? modelRows
        .map((row) => routeSummary(row, ["models"]))
        .filter((row) => row.routeSha256)
    : [];
  const configRoute = readConfigRoute(paths.config);
  const configSummary = configRoute
    ? routeSummary(configRoute, ["config_exact"])
    : null;

  const candidates = new Map();
  for (const route of [...routes, ...(configSummary ? [configSummary] : [])]) {
    const existing = candidates.get(route.routeSha256);
    candidates.set(
      route.routeSha256,
      existing
        ? {
            ...existing,
            sources: [
              ...new Set([...existing.sources, ...route.sources]),
            ].sort(),
          }
        : route,
    );
  }

  const groups = new Map();
  for (const route of routes) {
    const group = groups.get(route.groupSha256) || new Set();
    if (route.endpointSha256) group.add(route.endpointSha256);
    groups.set(route.groupSha256, group);
  }
  const duplicateEndpointGroups = [...groups.entries()]
    .filter(([, endpoints]) => endpoints.size > 1)
    .map(([groupSha256, endpoints]) => ({
      groupSha256,
      endpointCount: endpoints.size,
      endpointSha256s: [...endpoints].sort(),
    }))
    .sort((left, right) => left.groupSha256.localeCompare(right.groupSha256));

  return {
    providerCount: providerRows.length,
    modelRowCount: Array.isArray(modelRows) ? modelRows.length : 0,
    routeCount: routes.length,
    authoritativeEndpoints,
    currentCandidates: [...candidates.values()].sort((left, right) =>
      left.routeSha256.localeCompare(right.routeSha256),
    ),
    duplicateEndpointGroups,
  };
}

function collectOwner(userData) {
  const statePath = join(userData, "agentera-auth", "state.json");
  const doc = parseJson(statePath, null);
  const installation = doc?.installation?.installationId;
  const tenant = doc?.productSession?.personalSpaceId;
  const owner = doc?.productSession?.userId;
  if (!installation || !tenant || !owner)
    return {
      available: false,
      reason: existsSync(statePath)
        ? "owner_fields_unavailable"
        : "auth_state_missing",
    };
  return {
    available: true,
    reason: null,
    ownerSha256: hash(
      "aera-diagnostic-owner-v1",
      `${tenant}\0${owner}\0${installation}`,
    ),
    tenantSha256: hash("aera-diagnostic-tenant-v1", tenant),
    installationSha256: hash("aera-diagnostic-installation-v1", installation),
  };
}

function collectBackups(paths) {
  const backups = [];
  for (const role of REQUIRED_MODEL_FILE_ROLES) {
    const path = paths[role];
    const parent = dirname(path);
    if (!existsSync(parent)) continue;
    const prefix = `${basename(path)}.aera-model-config-backup.`;
    for (const name of readdirSync(parent)) {
      if (!name.startsWith(prefix)) continue;
      const operation = name.slice(prefix.length);
      const backupPath = join(parent, name);
      try {
        const info = statSync(backupPath);
        if (!info.isFile()) continue;
        backups.push({
          role,
          operationSha256: hash("aera-diagnostic-operation-v1", operation),
          size: info.size,
          mtime: info.mtime.toISOString(),
          sha256: fileHash(backupPath),
        });
      } catch {
        // A concurrently cleaned backup is represented by its absence.
      }
    }
  }
  return backups.sort((left, right) =>
    `${left.role}:${left.operationSha256}`.localeCompare(
      `${right.role}:${right.operationSha256}`,
    ),
  );
}

export function collectModelChain({ hermesHome, userData, profile }) {
  const paths = managedModelPaths(hermesHome, profile);
  const files = snapshotManagedModelFiles(paths, "current");
  const missingRoles = files
    .filter((entry) => !entry.exists)
    .map((entry) => entry.role);
  const journal = collectModelJournal(
    join(userData, "model-configuration", "model-configuration.db"),
  );
  return {
    status:
      missingRoles.length === REQUIRED_MODEL_FILE_ROLES.length
        ? "missing"
        : "collected",
    reason:
      missingRoles.length === REQUIRED_MODEL_FILE_ROLES.length
        ? "managed_files_unavailable"
        : null,
    requiredRoles: [...REQUIRED_MODEL_FILE_ROLES],
    missingRoles,
    profileSha256: hash("aera-diagnostic-profile-v1", profile),
    files,
    backups: collectBackups(paths),
    owner: collectOwner(userData),
    journal,
    routeCatalog: collectRouteCatalog(paths),
  };
}
