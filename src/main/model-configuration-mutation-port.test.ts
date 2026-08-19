// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createManagedModelMutationPort } from "./model-configuration-mutation-port";
import type { ManagedModelMutationCoordinator } from "./model-configuration-mutation-port";

describe("managed model mutation Owner lease", () => {
  it("holds the lease until the coordinated write finishes", async () => {
    const guard = vi.fn();
    const finish = vi.fn();
    const runManagedWrite = vi.fn(
      async <T>(
        _request: unknown,
        _prepare: unknown,
        receivedGuard?: () => void,
      ) => {
        expect(finish).not.toHaveBeenCalled();
        receivedGuard?.();
        return {
          status: "executed" as const,
          value: "saved" as T,
          catalog: {
            revision: "a".repeat(64),
            targetProfileId: "default",
            routes: [],
          },
        };
      },
    );
    const port = createManagedModelMutationPort(
      { runManagedWrite } as unknown as ManagedModelMutationCoordinator,
      async () => ({ guard, finish }),
    );

    await expect(
      port.mutate({
        operation: "fixture",
        globalCatalog: false,
        profileIds: ["default"],
        stage: "provider",
        prepare: () => ({ write: () => "saved" }),
      }),
    ).resolves.toMatchObject({ status: "executed", value: "saved" });

    expect(guard).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  });

  it("releases the lease when admission throws", async () => {
    const finish = vi.fn();
    const port = createManagedModelMutationPort(
      {
        runManagedWrite: vi.fn(async () => {
          throw new Error("injected admission failure");
        }),
      },
      () => ({ guard: vi.fn(), finish }),
    );

    await expect(
      port.mutate({
        operation: "fixture",
        globalCatalog: false,
        profileIds: ["default"],
        stage: "provider",
        prepare: () => ({ write: () => "saved" }),
      }),
    ).rejects.toThrow("injected admission failure");
    expect(finish).toHaveBeenCalledOnce();
  });
});
