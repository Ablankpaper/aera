// @vitest-environment node

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withManagedModelTestWrite } from "../../tests/helpers/managed-model-test-writer";

const mockState = vi.hoisted(() => ({ hermesHome: "" }));

vi.mock("./installer", () => ({
  get HERMES_HOME() {
    return mockState.hermesHome;
  },
}));

async function writeGlobalCatalog<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  return await withManagedModelTestWrite(
    {
      roots: { globalRoot: mockState.hermesHome, profiles: {} },
      scope: { globalCatalog: true, profileIds: [] },
    },
    callback,
  );
}

describe("custom provider model removal", () => {
  beforeEach(() => {
    mockState.hermesHome = mkdtempSync(join(tmpdir(), "hermes-models-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(mockState.hermesHome, { recursive: true, force: true });
  });

  it("removes current and legacy attachments for only the deleted provider", async () => {
    const models = await import("./models");
    const removed = await writeGlobalCatalog(() => {
      models.addModel(
        "Petoi GPT",
        "custom",
        "gpt-5.6-sol",
        "https://api.petoi.cn/v1",
        undefined,
        "Petoi",
      );
      models.addModel(
        "Legacy Petoi",
        "custom",
        "claude-sonnet-4-6",
        "https://api.petoi.cn/v1/",
      );
      models.addModel(
        "Other provider",
        "custom",
        "gpt-5.6-sol",
        "https://api.other.example/v1",
        undefined,
        "Other",
      );
      models.setModelDefinition("gpt-5.6-sol", { contextLength: 64_000 });
      return models.removeModelsForCustomProvider(
        "PETOI",
        "https://api.petoi.cn/v1",
      );
    });

    expect(removed).toBe(2);
    expect(models.readModelsRaw()).toEqual([
      expect.objectContaining({
        providerLabel: "Other",
        baseUrl: "https://api.other.example/v1",
      }),
    ]);
    expect(models.getModelDefinition("gpt-5.6-sol")).toMatchObject({
      contextLength: 64_000,
    });
  });

  it("migrates a named provider's attachments without duplicating its catalog", async () => {
    const models = await import("./models");
    const migrated = await writeGlobalCatalog(() => {
      models.addModel(
        "GPT",
        "custom",
        "gpt-5.6-sol",
        "https://api.petoi.cn/v1",
        undefined,
        "petoi.cn",
        "chat_completions",
        "provider-old",
      );
      models.addModel(
        "GPT",
        "custom",
        "gpt-5.6-sol",
        "https://www.api-codex.cn",
        undefined,
        "123456",
        "chat_completions",
      );
      return models.migrateModelsForCustomProvider({
        providerId: "provider-old",
        oldName: "petoi.cn",
        oldBaseUrl: "https://api.petoi.cn/v1",
        newName: "123456",
        newBaseUrl: "https://www.api-codex.cn",
        apiMode: "chat_completions",
      });
    });

    expect(migrated).toBe(1);
    expect(models.readModelsRaw()).toEqual([
      expect.objectContaining({
        providerId: "provider-old",
        providerLabel: "123456",
        baseUrl: "https://www.api-codex.cn",
      }),
    ]);
  });

  it("keeps same-endpoint model attachments separate by stable provider id", async () => {
    const models = await import("./models");
    const endpoint = "https://shared.example/v1";
    await writeGlobalCatalog(() => {
      models.addModel(
        "Shared model",
        "custom",
        "shared-model",
        endpoint,
        undefined,
        "Provider B",
        "chat_completions",
        "provider-b",
      );
      models.addModel(
        "Shared model",
        "custom",
        "shared-model",
        endpoint,
        undefined,
        "Provider A",
        "chat_completions",
        "provider-a",
      );
    });

    expect(models.readModelsRaw()).toEqual([
      expect.objectContaining({
        providerId: "provider-b",
        providerLabel: "Provider B",
      }),
      expect.objectContaining({
        providerId: "provider-a",
        providerLabel: "Provider A",
      }),
    ]);

    const migrated = await writeGlobalCatalog(() =>
      models.migrateModelsForCustomProvider({
        providerId: "provider-a",
        oldName: "Provider A",
        oldBaseUrl: endpoint,
        newName: "123456",
        newBaseUrl: endpoint,
        apiMode: "chat_completions",
      }),
    );
    expect(migrated).toBe(1);
    expect(models.readModelsRaw()).toEqual([
      expect.objectContaining({
        providerId: "provider-b",
        providerLabel: "Provider B",
      }),
      expect.objectContaining({
        providerId: "provider-a",
        providerLabel: "123456",
      }),
    ]);
  });
});
