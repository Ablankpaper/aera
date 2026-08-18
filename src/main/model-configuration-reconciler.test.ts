// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as runtime from "./model-configuration-runtime";

type ManagedRole =
  | "env"
  | "providers"
  | "models"
  | "modelDefinitions"
  | "config";

interface PlannerSnapshot {
  profileId: string;
  ownerHandle: string;
  expectedOwnerHandle: string;
  incompleteOperation: boolean;
  files: Record<ManagedRole, Buffer | null>;
}

interface PlannedPatch {
  role: ManagedRole;
  before: Buffer | null;
  after: Buffer;
}

type Planner = (snapshot: PlannerSnapshot) =>
  | { status: "unchanged"; activeRoute: unknown }
  | {
      status: "repair";
      patches: PlannedPatch[];
      absorbedRowIds: string[];
      activeRoute: unknown;
    }
  | {
      status: "repair_required";
      code: "route_catalog_repair_required";
      conflict: string;
    };

const contract = runtime as typeof runtime & {
  planModelRouteDirectoryRepair?: Planner;
};

function requirePlanner(): Planner {
  expect(
    contract.planModelRouteDirectoryRepair,
    "planModelRouteDirectoryRepair must be exported",
  ).toBeTypeOf("function");
  return contract.planModelRouteDirectoryRepair as Planner;
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validSnapshot(): PlannerSnapshot {
  return {
    profileId: "fixture-profile",
    ownerHandle: "fixture-owner",
    expectedOwnerHandle: "fixture-owner",
    incompleteOperation: false,
    files: {
      env: Buffer.from("CUSTOM_PROVIDER_FIXTURE_KEY=<redacted>\n", "utf8"),
      providers: json({
        version: 1,
        providers: [
          {
            id: "fixture-provider-01",
            name: "Fixture",
            baseUrl: "https://current.fixture.invalid/v1",
            createdAt: 1,
          },
        ],
      }),
      models: json([
        {
          id: "fixture-row-01",
          name: "Fixture Model",
          provider: "custom",
          model: "fixture-model",
          baseUrl: "https://current.fixture.invalid/v1",
          apiMode: "chat_completions",
          providerLabel: "Fixture",
          providerId: "fixture-provider-01",
          createdAt: 1,
        },
      ]),
      modelDefinitions: json({
        "fixture-model": {
          model: "fixture-model",
          name: "Fixture Model",
          createdAt: 1,
          updatedAt: 1,
        },
      }),
      config: Buffer.from(
        [
          "model:",
          '  provider: "custom:fixture"',
          '  default: "fixture-model"',
          '  base_url: "https://current.fixture.invalid/v1"',
          '  api_mode: "chat_completions"',
          "providers:",
          "  fixture:",
          '    api: "https://current.fixture.invalid/v1"',
          '    key_env: "CUSTOM_PROVIDER_FIXTURE_KEY"',
          "",
        ].join("\n"),
        "utf8",
      ),
    },
  };
}

function digests(snapshot: PlannerSnapshot): Record<ManagedRole, string> {
  return Object.fromEntries(
    Object.entries(snapshot.files).map(([role, bytes]) => [
      role,
      createHash("sha256")
        .update(bytes ?? Buffer.from("<absent>", "utf8"))
        .digest("hex"),
    ]),
  ) as Record<ManagedRole, string>;
}

function expectRepairRequired(
  snapshot: PlannerSnapshot,
  conflict: string,
): void {
  const before = digests(snapshot);
  expect(requirePlanner()(snapshot)).toMatchObject({
    status: "repair_required",
    code: "route_catalog_repair_required",
    conflict,
  });
  expect(digests(snapshot)).toEqual(before);
}

function plannedModelBytes(result: ReturnType<Planner>): Buffer {
  expect(result.status).toBe("repair");
  if (result.status !== "repair") return Buffer.alloc(0);
  const patch = result.patches.find((candidate) => candidate.role === "models");
  expect(patch, "repair must include a models patch").toBeDefined();
  return patch!.after;
}

function plannedModels(
  result: ReturnType<Planner>,
): Array<Record<string, unknown>> {
  return JSON.parse(plannedModelBytes(result).toString("utf8")) as Array<
    Record<string, unknown>
  >;
}

// @lat: [[beta27-reliability-plan#Recoverable model configuration#Strict route repair planning]]
describe("planModelRouteDirectoryRepair", () => {
  it("fails closed on malformed managed JSON without mutating the snapshot", () => {
    const snapshot = validSnapshot();
    snapshot.files.models = Buffer.from("[{", "utf8");
    expectRepairRequired(snapshot, "models_json_invalid");
  });

  it.each([
    ["providers", "{", "providers_json_invalid"],
    ["modelDefinitions", "[]", "model_definitions_json_invalid"],
    ["config", "model: [", "config_yaml_invalid"],
    ["env", "not an assignment\n", "env_invalid"],
  ] as const)(
    "fails closed when %s cannot be parsed strictly",
    (role, bytes, conflict) => {
      const snapshot = validSnapshot();
      snapshot.files[role] = Buffer.from(bytes, "utf8");
      expectRepairRequired(snapshot, conflict);
    },
  );

  it("fails closed on duplicate provider ids and provider anchors", () => {
    const duplicateId = validSnapshot();
    duplicateId.files.providers = json({
      version: 1,
      providers: [
        {
          id: "fixture-provider-01",
          name: "Fixture",
          baseUrl: "https://current.fixture.invalid/v1",
          createdAt: 1,
        },
        {
          id: "fixture-provider-01",
          name: "Other",
          baseUrl: "https://other.fixture.invalid/v1",
          createdAt: 2,
        },
      ],
    });
    expectRepairRequired(duplicateId, "provider_identity_ambiguous");

    const duplicateAnchor = validSnapshot();
    duplicateAnchor.files.providers = json({
      version: 1,
      providers: [
        {
          id: "fixture-provider-01",
          name: "Fixture",
          baseUrl: "https://current.fixture.invalid/v1",
          createdAt: 1,
        },
        {
          id: "fixture-provider-02",
          name: "fixture",
          baseUrl: "https://other.fixture.invalid/v1",
          createdAt: 2,
        },
      ],
    });
    expectRepairRequired(duplicateAnchor, "provider_anchor_ambiguous");
  });

  it("fails closed when the active remote route has no credential reference", () => {
    const snapshot = validSnapshot();
    snapshot.files.config = Buffer.from(
      [
        "model:",
        '  provider: "custom:fixture"',
        '  default: "fixture-model"',
        '  base_url: "https://current.fixture.invalid/v1"',
        '  api_mode: "chat_completions"',
        "providers:",
        "  fixture:",
        '    api: "https://current.fixture.invalid/v1"',
        "",
      ].join("\n"),
      "utf8",
    );
    expectRepairRequired(snapshot, "credential_reference_missing");
  });

  it("fails closed on unknown API modes, owner drift, and incomplete recovery", () => {
    const unknownMode = validSnapshot();
    unknownMode.files.config = Buffer.from(
      unknownMode.files
        .config!.toString("utf8")
        .replace("chat_completions", "unknown_fixture_mode"),
      "utf8",
    );
    expectRepairRequired(unknownMode, "api_mode_unknown");

    const ownerDrift = validSnapshot();
    ownerDrift.expectedOwnerHandle = "other-owner";
    expectRepairRequired(ownerDrift, "owner_mismatch");

    const incomplete = validSnapshot();
    incomplete.incompleteOperation = true;
    expectRepairRequired(incomplete, "incomplete_operation");
  });

  it("returns the stable active route for a consistent snapshot", () => {
    const snapshot = validSnapshot();
    const before = digests(snapshot);

    expect(requirePlanner()(snapshot)).toEqual({
      status: "unchanged",
      activeRoute: {
        providerId: "fixture-provider-01",
        modelId: "fixture-model",
        endpoint: "https://current.fixture.invalid/v1",
        apiMode: "chat_completions",
      },
    });
    expect(digests(snapshot)).toEqual(before);
  });

  it("retargets a stable provider row without changing its identity", () => {
    const snapshot = validSnapshot();
    const rows = JSON.parse(snapshot.files.models!.toString("utf8")) as Array<
      Record<string, unknown>
    >;
    rows[0].baseUrl = "https://legacy.fixture.invalid/v1";
    snapshot.files.models = json(rows);
    const result = requirePlanner()(snapshot);

    expect(result).toMatchObject({
      status: "repair",
      activeRoute: {
        providerId: "fixture-provider-01",
        modelId: "fixture-model",
        endpoint: "https://current.fixture.invalid/v1",
        apiMode: "chat_completions",
      },
      absorbedRowIds: [],
    });
    expect(plannedModels(result)).toEqual([
      expect.objectContaining({
        id: "fixture-row-01",
        createdAt: 1,
        providerId: "fixture-provider-01",
        providerLabel: "Fixture",
        baseUrl: "https://current.fixture.invalid/v1",
      }),
    ]);
  });

  it("adopts a legacy row only when its non-secret anchors select one provider", () => {
    const snapshot = validSnapshot();
    const rows = JSON.parse(snapshot.files.models!.toString("utf8")) as Array<
      Record<string, unknown>
    >;
    delete rows[0].providerId;
    snapshot.files.models = json(rows);
    const result = requirePlanner()(snapshot);

    expect(result).toMatchObject({
      status: "repair",
      absorbedRowIds: [],
    });
    expect(plannedModels(result)[0]).toMatchObject({
      id: "fixture-row-01",
      providerId: "fixture-provider-01",
      providerLabel: "Fixture",
      baseUrl: "https://current.fixture.invalid/v1",
    });
  });

  it("preserves every byte when a legacy row has zero or multiple provider matches", () => {
    const noMatch = validSnapshot();
    const noMatchRows = JSON.parse(
      noMatch.files.models!.toString("utf8"),
    ) as Array<Record<string, unknown>>;
    delete noMatchRows[0].providerId;
    noMatchRows[0].providerLabel = "Unknown";
    noMatch.files.models = json(noMatchRows);
    expectRepairRequired(noMatch, "legacy_provider_unresolved");

    const multiple = validSnapshot();
    multiple.files.providers = json({
      version: 1,
      providers: [
        {
          id: "fixture-provider-01",
          name: "Fixture",
          baseUrl: "https://current.fixture.invalid/v1",
          createdAt: 1,
        },
        {
          id: "fixture-provider-02",
          name: "Other",
          baseUrl: "https://current.fixture.invalid/v1",
          createdAt: 2,
        },
      ],
    });
    const multipleRows = JSON.parse(
      multiple.files.models!.toString("utf8"),
    ) as Array<Record<string, unknown>>;
    multipleRows.push({
      id: "fixture-row-ambiguous",
      name: "Ambiguous Model",
      provider: "custom",
      model: "fixture-model-ambiguous",
      baseUrl: "https://current.fixture.invalid/v1",
      apiMode: "chat_completions",
      createdAt: 2,
    });
    multiple.files.models = json(multipleRows);
    expectRepairRequired(multiple, "legacy_provider_ambiguous");
  });

  it("converges duplicate endpoints, retains unique stale models, and preserves metadata", () => {
    const snapshot = validSnapshot();
    const rows = JSON.parse(snapshot.files.models!.toString("utf8")) as Array<
      Record<string, unknown>
    >;
    rows[0] = {
      ...rows[0],
      name: "Primary display name",
      createdAt: 10,
    };
    rows.push({
      ...rows[0],
      id: "fixture-row-02",
      name: "Secondary display name",
      baseUrl: "https://legacy.fixture.invalid/v1",
      createdAt: 20,
      description: "retained optional metadata",
    });
    rows.push({
      ...rows[0],
      id: "fixture-row-unique",
      model: "fixture-model-unique",
      baseUrl: "https://legacy.fixture.invalid/v1",
      createdAt: 30,
    });
    snapshot.files.models = json(rows);

    const result = requirePlanner()(snapshot);
    expect(result).toMatchObject({ status: "repair" });
    if (result.status !== "repair") return;
    expect(result.absorbedRowIds).toEqual(["fixture-row-02"]);
    const repaired = plannedModels(result);
    expect(repaired).toHaveLength(2);
    expect(repaired[0]).toMatchObject({
      id: "fixture-row-01",
      createdAt: 10,
      baseUrl: "https://current.fixture.invalid/v1",
      description: "retained optional metadata",
    });
    expect(repaired[1]).toMatchObject({
      id: "fixture-row-unique",
      baseUrl: "https://current.fixture.invalid/v1",
    });
  });

  it("selects the same survivor when duplicate rows arrive in reverse order", () => {
    const rows = [
      {
        id: "fixture-row-01",
        name: "Primary display name",
        provider: "custom",
        model: "fixture-model",
        baseUrl: "https://current.fixture.invalid/v1",
        apiMode: "chat_completions",
        providerLabel: "Fixture",
        providerId: "fixture-provider-01",
        createdAt: 10,
      },
      {
        id: "fixture-row-02",
        name: "Secondary display name",
        provider: "custom",
        model: "fixture-model",
        baseUrl: "https://legacy.fixture.invalid/v1",
        apiMode: "chat_completions",
        providerLabel: "Fixture",
        providerId: "fixture-provider-01",
        createdAt: 20,
        description: "retained optional metadata",
      },
    ];
    const forward = validSnapshot();
    forward.files.models = json(rows);
    const reverse = validSnapshot();
    reverse.files.models = json([...rows].reverse());

    const forwardResult = requirePlanner()(forward);
    const reverseResult = requirePlanner()(reverse);

    expect(plannedModelBytes(reverseResult)).toEqual(
      plannedModelBytes(forwardResult),
    );
    expect(reverseResult).toMatchObject({
      status: "repair",
      absorbedRowIds: ["fixture-row-02"],
    });
  });

  it("keeps same-name models belonging to different stable providers separate", () => {
    const snapshot = validSnapshot();
    snapshot.files.providers = json({
      version: 1,
      providers: [
        {
          id: "fixture-provider-01",
          name: "Fixture",
          baseUrl: "https://current.fixture.invalid/v1",
          createdAt: 1,
        },
        {
          id: "fixture-provider-02",
          name: "Other",
          baseUrl: "https://other.fixture.invalid/v1",
          createdAt: 2,
        },
      ],
    });
    const rows = JSON.parse(snapshot.files.models!.toString("utf8")) as Array<
      Record<string, unknown>
    >;
    rows.push({
      ...rows[0],
      id: "fixture-row-other",
      providerId: "fixture-provider-02",
      providerLabel: "Other",
      baseUrl: "https://old-other.fixture.invalid/v1",
    });
    snapshot.files.models = json(rows);

    const result = requirePlanner()(snapshot);
    expect(result).toMatchObject({ status: "repair" });
    const repaired = plannedModels(result);
    expect(repaired).toHaveLength(2);
    expect(repaired.map((row) => row.providerId).sort()).toEqual([
      "fixture-provider-01",
      "fixture-provider-02",
    ]);
  });

  it("refuses conflicting non-empty metadata instead of choosing one silently", () => {
    const snapshot = validSnapshot();
    const rows = JSON.parse(snapshot.files.models!.toString("utf8")) as Array<
      Record<string, unknown>
    >;
    rows.push({
      ...rows[0],
      id: "fixture-row-conflict",
      baseUrl: "https://legacy.fixture.invalid/v1",
      description: "different metadata",
      createdAt: 20,
    });
    rows[0].description = "original metadata";
    snapshot.files.models = json(rows);
    expectRepairRequired(snapshot, "metadata_conflict");
  });

  // @lat: [[beta27-reliability-plan#Recoverable model configuration#Config-only active route reconstruction]]
  describe("config-only route reconstruction", () => {
    function configOnlySnapshot(): PlannerSnapshot {
      const snapshot = validSnapshot();
      snapshot.files.models = json([]);
      snapshot.files.config = Buffer.from(
        snapshot.files
          .config!.toString("utf8")
          .replace(
            '  base_url: "https://current.fixture.invalid/v1"',
            '  base_url: "https://config-only.fixture.invalid/v1"',
          ),
        "utf8",
      );
      return snapshot;
    }

    it("reconstructs one deterministic row when every route input is unique", () => {
      const snapshot = configOnlySnapshot();

      const first = requirePlanner()(snapshot);
      const second = requirePlanner()(snapshot);

      expect(first).toMatchObject({
        status: "repair",
        activeRoute: {
          providerId: "fixture-provider-01",
          modelId: "fixture-model",
          endpoint: "https://config-only.fixture.invalid/v1",
          apiMode: "chat_completions",
        },
      });
      expect(plannedModelBytes(second)).toEqual(plannedModelBytes(first));
      expect(plannedModels(first)).toEqual([
        expect.objectContaining({
          id: expect.stringMatching(/^recovered-[a-f0-9]{32}$/u),
          name: "Fixture Model",
          provider: "custom",
          model: "fixture-model",
          baseUrl: "https://config-only.fixture.invalid/v1",
          apiMode: "chat_completions",
          providerLabel: "Fixture",
          providerId: "fixture-provider-01",
          createdAt: 1,
        }),
      ]);
    });

    it("retargets an existing valid row without replacing its id", () => {
      const snapshot = configOnlySnapshot();
      const existing = JSON.parse(
        validSnapshot().files.models!.toString("utf8"),
      ) as Array<Record<string, unknown>>;
      snapshot.files.models = json(existing);

      const result = requirePlanner()(snapshot);

      expect(result).toMatchObject({ status: "repair" });
      expect(plannedModels(result)).toEqual([
        expect.objectContaining({
          id: "fixture-row-01",
          baseUrl: "https://config-only.fixture.invalid/v1",
        }),
      ]);
    });

    it("fails closed when the config has no credential reference", () => {
      const snapshot = configOnlySnapshot();
      snapshot.files.config = Buffer.from(
        snapshot.files
          .config!.toString("utf8")
          .replace('    key_env: "CUSTOM_PROVIDER_FIXTURE_KEY"\n', ""),
        "utf8",
      );
      expectRepairRequired(snapshot, "credential_reference_missing");
    });

    it("fails closed when config omits a mode and two protocols remain", () => {
      const snapshot = configOnlySnapshot();
      snapshot.files.config = Buffer.from(
        snapshot.files
          .config!.toString("utf8")
          .replace('  api_mode: "chat_completions"\n', ""),
        "utf8",
      );
      snapshot.files.models = json([
        {
          id: "fixture-chat",
          name: "Fixture Model",
          provider: "custom",
          model: "fixture-model",
          baseUrl: "https://legacy.fixture.invalid/v1",
          apiMode: "chat_completions",
          providerLabel: "Fixture",
          providerId: "fixture-provider-01",
          createdAt: 1,
        },
        {
          id: "fixture-responses",
          name: "Fixture Model",
          provider: "custom",
          model: "fixture-model",
          baseUrl: "https://legacy.fixture.invalid/v1",
          apiMode: "responses",
          providerLabel: "Fixture",
          providerId: "fixture-provider-01",
          createdAt: 2,
        },
      ]);
      expectRepairRequired(snapshot, "active_route_protocol_ambiguous");
    });

    it("fails closed when a bare custom route matches two providers", () => {
      const snapshot = configOnlySnapshot();
      snapshot.files.config = Buffer.from(
        snapshot.files
          .config!.toString("utf8")
          .replace('  provider: "custom:fixture"', '  provider: "custom"'),
        "utf8",
      );
      snapshot.files.providers = json({
        version: 1,
        providers: [
          {
            id: "fixture-provider-01",
            name: "Fixture",
            baseUrl: "https://config-only.fixture.invalid/v1",
            createdAt: 1,
          },
          {
            id: "fixture-provider-02",
            name: "Other",
            baseUrl: "https://config-only.fixture.invalid/v1",
            createdAt: 2,
          },
        ],
      });
      expectRepairRequired(snapshot, "active_provider_ambiguous");
    });

    it("fails closed when the active model has no definition", () => {
      const snapshot = configOnlySnapshot();
      snapshot.files.modelDefinitions = json({});
      expectRepairRequired(snapshot, "model_definition_unresolved");
    });
  });
});
