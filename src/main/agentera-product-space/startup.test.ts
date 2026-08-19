// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  closeAgenteraProductSpaceStartupResources,
  logAgenteraProductSpaceUnavailable,
  stableProductSpaceStartupCause,
} from "./startup";

describe("Product Space startup degradation", () => {
  it("closes a constructed manager once and does not close its database twice", () => {
    const manager = { close: vi.fn() };
    const database = { close: vi.fn() };

    closeAgenteraProductSpaceStartupResources({ manager, database });

    expect(manager.close).toHaveBeenCalledOnce();
    expect(database.close).not.toHaveBeenCalled();
  });

  it("closes a database when manager construction failed", () => {
    const database = { close: vi.fn() };

    closeAgenteraProductSpaceStartupResources({ manager: null, database });

    expect(database.close).toHaveBeenCalledOnce();
  });

  it("keeps cleanup failure from hiding the original startup degradation", () => {
    const manager = {
      close: vi.fn(() => {
        throw new Error("close failed");
      }),
    };
    const database = { close: vi.fn() };

    expect(() =>
      closeAgenteraProductSpaceStartupResources({ manager, database }),
    ).not.toThrow();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("logs only a stable stage and cause", () => {
    const log = vi.fn();
    const error = Object.assign(new Error("private path"), {
      code: "database_unavailable",
    });

    logAgenteraProductSpaceUnavailable("database", error, log);

    expect(stableProductSpaceStartupCause(error)).toBe("database_unavailable");
    expect(log).toHaveBeenCalledWith(
      "[AGENTERA_PRODUCT_SPACE] unavailable stage=database cause=database_unavailable",
    );
    expect(log.mock.calls[0][0]).not.toContain("private path");
  });
});
