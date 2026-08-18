import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { canonicalModelEndpointV2 } from "../src/shared/model-configuration";

const FIXTURE_ROOT = join(
  process.cwd(),
  "tests",
  "fixtures",
  "beta29-dirty-route",
);

const DATA_FILES = [
  ".env.redacted",
  "providers.json",
  "models.json",
  "model-definitions.json",
  "config.yaml",
  "journal-summary.json",
  "expected-relations.json",
] as const;

const MANAGED_ROLES = [
  "env",
  "providers",
  "models",
  "modelDefinitions",
  "config",
] as const;

interface FixtureManifest {
  schemaVersion: number;
  captureId: string;
  sourceArchiveSha256: string;
  sanitizerVersion: string;
  structuralCounts: {
    modelRows: number;
    routeEntries: number;
    duplicateEndpointGroups: number;
    managedFileRoles: number;
    committedOperations: number;
    rolledBackOperations: number;
  };
  files: Record<string, string>;
}

interface ModelRow {
  id: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiMode?: string | null;
  providerId?: string;
}

interface ExpectedRelations {
  managedFileRoles: string[];
  endpointDistribution: number[];
  configExactRoute: {
    provider: string;
    model: string;
    endpoint: string;
    apiMode: string;
  };
}

function readFixture(name: string): Buffer {
  const path = join(FIXTURE_ROOT, name);
  expect(existsSync(path), `missing fixture file: ${name}`).toBe(true);
  return readFileSync(path);
}

function readJson<T>(name: string): T {
  return JSON.parse(readFixture(name).toString("utf8")) as T;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function routeGroupKey(row: ModelRow): string {
  return [
    row.provider.trim().toLowerCase(),
    row.model.trim(),
    row.apiMode ?? "",
  ]
    .join("\0")
    .toLowerCase();
}

describe("Beta.29 dirty-route fixture", () => {
  // @lat: [[beta27-reliability-plan#Recoverable model configuration#Sanitized Beta.29 dirty-route fixture]]
  it("preserves the third capture topology without preserving user data", () => {
    const manifest = readJson<FixtureManifest>("fixture-manifest.json");
    const relations = readJson<ExpectedRelations>("expected-relations.json");
    const models = readJson<ModelRow[]>("models.json");
    const providers = readJson<{ providers: unknown[] }>("providers.json");
    const definitions = readJson<Record<string, unknown>>(
      "model-definitions.json",
    );
    const journal = readJson<{
      operations: Array<{ state: string; fileRoles: string[] }>;
    }>("journal-summary.json");

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      captureId: "5a60ac3b",
      sourceArchiveSha256:
        "dad414de6996b1cc8e1239983bbfac5cd89b655eafee66fb96d5102624dfc4f5",
      sanitizerVersion: "beta29-dirty-route-v1",
      structuralCounts: {
        modelRows: 26,
        routeEntries: 20,
        duplicateEndpointGroups: 8,
        managedFileRoles: 5,
        committedOperations: 4,
        rolledBackOperations: 1,
      },
    });
    expect(Object.keys(manifest.files).sort()).toEqual([...DATA_FILES].sort());
    for (const name of DATA_FILES) {
      expect(manifest.files[name]).toBe(sha256(readFixture(name)));
    }

    expect(models).toHaveLength(26);
    const routeRows = models.filter((row) => row.baseUrl.trim() !== "");
    expect(routeRows).toHaveLength(20);
    expect(routeRows.every((row) => !("providerId" in row))).toBe(true);

    const endpointsByGroup = new Map<string, Set<string>>();
    const endpointCounts = new Map<string, number>();
    for (const row of routeRows) {
      const endpoint = canonicalModelEndpointV2(row.baseUrl);
      const group = routeGroupKey(row);
      const endpoints = endpointsByGroup.get(group) ?? new Set<string>();
      endpoints.add(endpoint);
      endpointsByGroup.set(group, endpoints);
      endpointCounts.set(endpoint, (endpointCounts.get(endpoint) ?? 0) + 1);
    }

    expect(
      [...endpointsByGroup.values()].filter(
        (endpoints) => endpoints.size === 2,
      ),
    ).toHaveLength(8);
    expect(
      [...endpointCounts.values()].sort((left, right) => right - left),
    ).toEqual(relations.endpointDistribution);
    expect(relations.endpointDistribution).toEqual([11, 8, 1]);

    expect(relations.managedFileRoles).toEqual([...MANAGED_ROLES]);
    expect(providers.providers).toHaveLength(1);
    expect(Object.keys(definitions)).toHaveLength(2);
    expect(journal.operations).toHaveLength(5);
    expect(
      journal.operations.filter((row) => row.state === "committed"),
    ).toHaveLength(4);
    expect(
      journal.operations.filter((row) => row.state === "rolled_back"),
    ).toHaveLength(1);
    expect(
      journal.operations.every(
        (row) =>
          JSON.stringify(row.fileRoles) === JSON.stringify(MANAGED_ROLES),
      ),
    ).toBe(true);

    const parsedConfig = parseYaml(
      readFixture("config.yaml").toString("utf8"),
    ) as {
      model: {
        provider: string;
        default: string;
        base_url: string;
        api_mode?: string;
      };
    };
    expect(relations.configExactRoute).toEqual({
      provider: parsedConfig.model.provider,
      model: parsedConfig.model.default,
      endpoint: canonicalModelEndpointV2(parsedConfig.model.base_url),
      apiMode: parsedConfig.model.api_mode ?? "",
    });
    expect(
      routeRows.some(
        (row) =>
          row.provider === relations.configExactRoute.provider &&
          row.model === relations.configExactRoute.model &&
          canonicalModelEndpointV2(row.baseUrl) ===
            relations.configExactRoute.endpoint &&
          (row.apiMode ?? "") === relations.configExactRoute.apiMode,
      ),
    ).toBe(false);

    expect(readFixture(".env.redacted").toString("utf8")).toBe(
      "CUSTOM_PROVIDER_FIXTURE_KEY=<redacted>\n",
    );
    const allFixtureText = DATA_FILES.map((name) =>
      readFixture(name).toString("utf8"),
    ).join("\n");
    expect(allFixtureText).not.toMatch(
      /\/Users\/|Bearer\s|\bsk-|refresh_token|api[_-]?key[^<]*[=:][^<]/i,
    );
  });
});
