import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Per-model context-window override round-trips through models.json:
 * `addModel`/`updateModel` persist a positive `contextLength`, and clearing it
 * (null / 0 / undefined-but-present) deletes the key so auto-detection resumes.
 */

let testHome: string;

async function loadModels(): Promise<{
  models: typeof import("../src/main/models");
  write<T>(callback: () => T | Promise<T>): Promise<T>;
}> {
  vi.resetModules();
  // This suite dynamically imports the real model catalog. Clear any
  // worker-level module mocks left by a preceding test file before resolving
  // HERMES_HOME and the managed-write boundary.
  vi.doUnmock("../src/main/installer");
  vi.doUnmock("../src/main/model-configuration-managed-files");
  vi.doUnmock("../src/main/model-configuration-write-authority");
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

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "hermes-models-ctx-"));
});

afterEach(async () => {
  const { clearManagedModelFileRoots } =
    await import("../src/main/model-configuration-managed-files");
  clearManagedModelFileRoots();
  vi.unstubAllEnvs();
  rmSync(testHome, { recursive: true, force: true });
});

describe("models.json — contextLength override", () => {
  it("addModel persists a positive contextLength", async () => {
    const { models, write } = await loadModels();
    const added = await write(() =>
      models.addModel("Qwen Max", "qwen", "qwen-max", "", 65536),
    );
    expect(added.contextLength).toBe(65536);
    expect(
      models.listModels().find((m) => m.id === added.id)?.contextLength,
    ).toBe(65536);
  });

  it("addModel omits contextLength when not given or non-positive", async () => {
    const { models, write } = await loadModels();
    const [first, second] = await write(() => [
      models.addModel("A", "qwen", "a", ""),
      models.addModel("B", "qwen", "b", "", 0),
    ]);
    expect(first.contextLength).toBeUndefined();
    expect(second.contextLength).toBeUndefined();
  });

  it("updateModel sets the override and clears it on null", async () => {
    const { models, write } = await loadModels();
    const m = await write(() =>
      models.addModel("Qwen", "qwen", "qwen-max", ""),
    );

    expect(
      await write(() => models.updateModel(m.id, { contextLength: 32768 })),
    ).toBe(true);
    expect(models.readModels().find((x) => x.id === m.id)?.contextLength).toBe(
      32768,
    );

    // Clearing removes the key entirely rather than storing 0/null.
    expect(
      await write(() => models.updateModel(m.id, { contextLength: null })),
    ).toBe(true);
    const cleared = models.readModels().find((x) => x.id === m.id)!;
    expect("contextLength" in cleared).toBe(false);
  });

  it("updateModel leaves contextLength untouched when the field is absent", async () => {
    const { models, write } = await loadModels();
    const m = await write(() =>
      models.addModel("Qwen", "qwen", "qwen-max", "", 65536),
    );
    // A name-only edit must not disturb the stored override.
    expect(
      await write(() => models.updateModel(m.id, { name: "Renamed" })),
    ).toBe(true);
    const after = models.readModels().find((x) => x.id === m.id)!;
    expect(after.name).toBe("Renamed");
    expect(after.contextLength).toBe(65536);
  });
});

describe("models.json — apiMode override", () => {
  it("persists and replaces the transport mode on an existing attachment", async () => {
    const { models, write } = await loadModels();
    const first = await write(() =>
      models.addModel(
        "Relay model",
        "custom",
        "relay-model",
        "https://relay.example.com/v1",
        undefined,
        "Relay",
        "anthropic_messages",
      ),
    );
    expect(first.apiMode).toBe("anthropic_messages");

    const updated = await write(() =>
      models.addModel(
        "Relay model",
        "custom",
        "relay-model",
        "https://relay.example.com/v1",
        undefined,
        "Relay",
        "chat_completions",
      ),
    );
    expect(updated.id).toBe(first.id);
    expect(
      models.readModels().find((model) => model.id === first.id)?.apiMode,
    ).toBe("chat_completions");
  });
});
