import { describe, expect, it } from "vitest";
import { runtimeSnapshotAppliesToProfile } from "./runtime-snapshot";

describe("runtime snapshot notification scope", () => {
  it("keeps legacy and catalog-only notifications global", () => {
    expect(runtimeSnapshotAppliesToProfile(undefined, "work")).toBe(true);
    expect(
      runtimeSnapshotAppliesToProfile(
        { catalogRevision: "fixture-revision" },
        "work",
      ),
    ).toBe(true);
  });

  it("applies a Profile-scoped notification only to its matching chat", () => {
    const change = { profile: "work" };

    expect(runtimeSnapshotAppliesToProfile(change, "work")).toBe(true);
    expect(runtimeSnapshotAppliesToProfile(change, "personal")).toBe(false);
    expect(runtimeSnapshotAppliesToProfile({ profile: "default" })).toBe(true);
    expect(runtimeSnapshotAppliesToProfile(change)).toBe(false);
  });
});
