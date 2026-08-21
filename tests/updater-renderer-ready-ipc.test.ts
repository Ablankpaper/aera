import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: { sender: unknown }, ...arguments_: unknown[]) => unknown
  >();
  return {
    handlers,
    app: {
      isPackaged: false,
      getPath: vi.fn(() => "/tmp/aera-updater-test"),
      getVersion: vi.fn(() => "0.7.4-internal-beta.37"),
      once: vi.fn(),
    },
    ipcMain: {
      handle: vi.fn(
        (
          channel: string,
          handler: (
            event: { sender: unknown },
            ...arguments_: unknown[]
          ) => unknown,
        ) => {
          handlers.set(channel, handler);
        },
      ),
    },
  };
});

vi.mock("electron", () => ({
  app: electronMock.app,
  ipcMain: electronMock.ipcMain,
}));
vi.mock("../src/main/updater-log", () => ({
  updaterLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { setupUpdater } from "../src/main/app/updater";

describe("desktop renderer health handshake IPC", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
  });

  it("accepts only the live main-window sender", async () => {
    const mainContents = { id: 41 };
    const otherContents = { id: 42 };
    let destroyed = false;
    let available = true;
    const mainWindow = {
      webContents: mainContents,
      isDestroyed: () => destroyed,
    };
    setupUpdater({
      getMainWindow: () => (available ? (mainWindow as never) : null),
    });
    const handler = electronMock.handlers.get("desktop-renderer-ready");
    expect(handler).toBeDefined();

    await expect(handler?.({ sender: mainContents })).resolves.toBe(true);
    await expect(handler?.({ sender: otherContents })).resolves.toBe(false);
    destroyed = true;
    await expect(handler?.({ sender: mainContents })).resolves.toBe(false);
    destroyed = false;
    available = false;
    await expect(handler?.({ sender: mainContents })).resolves.toBe(false);
  });
});
