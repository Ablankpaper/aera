import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DesktopControlJournal } from "./store";

describe("DesktopControlJournal", () => {
  // @lat: [[lat.md/agentera-desktop-control#Idempotent receipt journal]]
  it("persists bounded running and terminal receipts with owner-only permissions", async () => {
    const root = join(tmpdir(), `aera-desktop-control-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const journal = new DesktopControlJournal(root);
    const principal = { userId: "user-a", deviceId: "device-a" };
    await journal.markRunning(principal, "command-a");
    await journal.saveTerminal(principal, "command-a", {
      state: "failed",
      code: "RUNTIME_UNAVAILABLE",
      summary: {
        desktop_status: "healthy",
        runtime_status: "unhealthy",
        gateway_status: "unknown",
        code: "RUNTIME_UNAVAILABLE",
        duration_ms: 3,
      },
      completedAt: "2026-08-11T00:00:00.000Z",
    });

    const record = journal.get(principal, "command-a");
    expect(record?.state).toBe("terminal");
    expect(record?.result?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(
      (await stat(join(root, "agentera-desktop-control", "state.json"))).mode &
        0o777,
    ).toBe(0o600);
    expect(
      JSON.stringify(
        await readFile(
          join(root, "agentera-desktop-control", "state.json"),
          "utf8",
        ),
      ),
    ).not.toMatch(/path|log|secret/i);
  });

  it("fails closed for corrupt or oversized journals", async () => {
    const root = join(tmpdir(), `aera-desktop-control-${randomUUID()}`);
    const directory = join(root, "agentera-desktop-control");
    await mkdir(directory, { recursive: true });
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(join(directory, "state.json"), "x".repeat(300_000)),
    );
    const journal = new DesktopControlJournal(root);
    expect(
      journal.listPending({ userId: "user-a", deviceId: "device-a" }),
    ).toEqual([]);
  });
});
