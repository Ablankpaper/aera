// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testHome: string;

async function loadModels(): Promise<{
  models: typeof import("../src/main/models");
  write<T>(callback: () => T | Promise<T>): Promise<T>;
}> {
  vi.resetModules();
  vi.stubEnv("HERMES_HOME", testHome);
  const [models, managed, authority] = await Promise.all([
    import("../src/main/models"),
    import("../src/main/model-configuration-managed-files"),
    import("../src/main/model-configuration-write-authority"),
  ]);
  managed.registerManagedModelFileRoots({ globalRoot: testHome, profiles: {} });
  const writeAuthority = new authority.ModelConfigurationWriteAuthority();
  return {
    models,
    write: (callback) =>
      writeAuthority.run({ globalCatalog: true, profileIds: [] }, callback),
  };
}

function seedRows(rows: unknown[]): void {
  writeFileSync(
    join(testHome, "models.json"),
    `${JSON.stringify(rows, null, 2)}\n`,
    "utf8",
  );
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "aera-model-endpoint-replace-"));
});

afterEach(async () => {
  const { clearManagedModelFileRoots } =
    await import("../src/main/model-configuration-managed-files");
  clearManagedModelFileRoots();
  vi.unstubAllEnvs();
  rmSync(testHome, { recursive: true, force: true });
});

// @lat: [[beta27-reliability-plan#Recoverable model configuration#Stable provider endpoint updates]]
describe("stable provider endpoint replacement", () => {
  it("updates one provider/model/protocol attachment instead of appending", async () => {
    const { models, write } = await loadModels();
    const first = await write(() =>
      models.addModel(
        "Fixture",
        "custom",
        "fixture-model",
        "https://old.fixture.invalid/v1",
        undefined,
        "Fixture",
        "chat_completions",
        "fixture-provider-01",
      ),
    );
    const second = await write(() =>
      models.addModel(
        "Fixture",
        "custom",
        "fixture-model",
        "https://new.fixture.invalid/v1",
        undefined,
        "Fixture",
        "chat_completions",
        "fixture-provider-01",
      ),
    );

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(models.readModelsRaw()).toEqual([
      expect.objectContaining({
        id: first.id,
        providerId: "fixture-provider-01",
        baseUrl: "https://new.fixture.invalid/v1",
        apiMode: "chat_completions",
      }),
    ]);
  });

  it("collapses historical stable and uniquely anchored legacy duplicates", async () => {
    seedRows([
      {
        id: "stable-old",
        name: "Fixture",
        provider: "custom",
        model: "fixture-model",
        baseUrl: "https://old.fixture.invalid/v1",
        apiMode: "chat_completions",
        providerLabel: "Fixture",
        providerId: "fixture-provider-01",
        createdAt: 10,
      },
      {
        id: "stable-new",
        name: "Fixture",
        provider: "custom",
        model: "fixture-model",
        baseUrl: "https://new.fixture.invalid/v1",
        apiMode: "chat_completions",
        providerLabel: "Fixture",
        providerId: "fixture-provider-01",
        createdAt: 20,
      },
      {
        id: "legacy-third",
        name: "Fixture",
        provider: "custom",
        model: "fixture-model",
        baseUrl: "https://third.fixture.invalid/v1",
        apiMode: "chat_completions",
        providerLabel: "Fixture",
        createdAt: 30,
      },
    ]);
    const { models, write } = await loadModels();

    const saved = await write(() =>
      models.addModel(
        "Fixture",
        "custom",
        "fixture-model",
        "https://new.fixture.invalid/v1",
        undefined,
        "Fixture",
        "chat_completions",
        "fixture-provider-01",
      ),
    );

    expect(saved.id).toBe("stable-old");
    expect(models.readModelsRaw()).toEqual([
      expect.objectContaining({
        id: "stable-old",
        createdAt: 10,
        providerId: "fixture-provider-01",
        baseUrl: "https://new.fixture.invalid/v1",
      }),
    ]);
  });

  it("keeps other stable providers and other protocols separate", async () => {
    seedRows([
      {
        id: "provider-a-chat",
        name: "A",
        provider: "custom",
        model: "shared-model",
        baseUrl: "https://old-a.fixture.invalid/v1",
        apiMode: "chat_completions",
        providerLabel: "A",
        providerId: "provider-a",
        createdAt: 1,
      },
      {
        id: "provider-a-responses",
        name: "A",
        provider: "custom",
        model: "shared-model",
        baseUrl: "https://responses.fixture.invalid/v1",
        apiMode: "responses",
        providerLabel: "A",
        providerId: "provider-a",
        createdAt: 2,
      },
      {
        id: "provider-b-chat",
        name: "B",
        provider: "custom",
        model: "shared-model",
        baseUrl: "https://b.fixture.invalid/v1",
        apiMode: "chat_completions",
        providerLabel: "B",
        providerId: "provider-b",
        createdAt: 3,
      },
    ]);
    const { models, write } = await loadModels();
    await write(() =>
      models.addModel(
        "A",
        "custom",
        "shared-model",
        "https://new-a.fixture.invalid/v1",
        undefined,
        "A",
        "chat_completions",
        "provider-a",
      ),
    );

    expect(models.readModelsRaw()).toEqual([
      expect.objectContaining({
        id: "provider-a-chat",
        baseUrl: "https://new-a.fixture.invalid/v1",
      }),
      expect.objectContaining({
        id: "provider-a-responses",
        baseUrl: "https://responses.fixture.invalid/v1",
      }),
      expect.objectContaining({
        id: "provider-b-chat",
        baseUrl: "https://b.fixture.invalid/v1",
      }),
    ]);
  });

  it("retains upstream endpoint-distinct append semantics without a stable provider id", async () => {
    const { models, write } = await loadModels();
    await write(() =>
      models.addModel(
        "Legacy",
        "custom",
        "legacy-model",
        "https://one.fixture.invalid/v1",
        undefined,
        "Legacy",
        "chat_completions",
      ),
    );
    await write(() =>
      models.addModel(
        "Legacy",
        "custom",
        "legacy-model",
        "https://two.fixture.invalid/v1",
        undefined,
        "Legacy",
        "chat_completions",
      ),
    );

    expect(models.readModelsRaw()).toHaveLength(2);
  });

  it("does not lowercase legacy endpoint path or query identity", async () => {
    const { models, write } = await loadModels();
    await write(() =>
      models.addModel(
        "Legacy",
        "custom",
        "case-sensitive-model",
        "https://api.fixture.invalid/Case/Path?Key=Value",
        undefined,
        "Legacy",
        "chat_completions",
      ),
    );
    await write(() =>
      models.addModel(
        "Legacy",
        "custom",
        "case-sensitive-model",
        "https://api.fixture.invalid/case/path?key=value",
        undefined,
        "Legacy",
        "chat_completions",
      ),
    );

    expect(models.readModelsRaw()).toHaveLength(2);
  });
});
