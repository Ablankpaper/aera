import { describe, expect, it } from "vitest";
import {
  serializeDesktopControlPublicState,
  type DesktopControlPublicState,
} from "./agentera-desktop-control";

describe("Desktop control public state", () => {
  // @lat: [[lat.md/agentera-desktop-control#Renderer privacy boundary]]
  it("serializes only the renderer-safe connection and health fields", () => {
    const state: DesktopControlPublicState = {
      status: "online",
      lastHeartbeatAt: "2026-08-11T00:00:00.000Z",
      lastErrorCode: null,
      lastHealth: {
        state: "succeeded",
        code: "HEALTHY",
        completedAt: "2026-08-11T00:00:01.000Z",
      },
    };

    expect(
      serializeDesktopControlPublicState({
        ...state,
        accessToken: "must-not-cross-ipc",
        userId: "private-user-id",
      } as DesktopControlPublicState & Record<string, unknown>),
    ).toEqual(state);
  });

  it("rejects unknown state and health values", () => {
    expect(() =>
      serializeDesktopControlPublicState({
        status: "mystery",
        lastHeartbeatAt: null,
        lastErrorCode: null,
        lastHealth: null,
      } as never),
    ).toThrow(/invalid/i);
  });
});
