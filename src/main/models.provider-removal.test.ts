// @vitest-environment node

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({ hermesHome: "" }));

vi.mock("./installer", () => ({
  get HERMES_HOME() {
    return mockState.hermesHome;
  },
}));

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

    expect(
      models.removeModelsForCustomProvider("PETOI", "https://api.petoi.cn/v1"),
    ).toBe(2);
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
});
