import { EventEmitter } from "node:events";

import { createElectronRuntimeDownloadUrlResolver } from "../src/main/agentera-runtime-distribution/electron-transport";

class FakeElectronRequest extends EventEmitter {
  aborted = false;
  ended = false;
  followed = 0;

  constructor(private readonly run: (request: FakeElectronRequest) => void) {
    super();
  }

  abort(): void {
    this.aborted = true;
  }

  end(): void {
    this.ended = true;
    queueMicrotask(() => this.run(this));
  }

  followRedirect(): void {
    this.followed += 1;
  }
}

const TIMEOUTS = {
  connectMs: 1_000,
  readMs: 1_000,
  overallMs: 2_000,
};

describe("Electron Runtime redirect resolver", () => {
  it("follows validated HTTPS redirects and returns the final URL", async () => {
    const request = new FakeElectronRequest((value) => {
      value.emit(
        "redirect",
        302,
        "GET",
        "https://release-assets.example/runtime",
        {},
      );
      value.emit("response", {});
    });
    const resolveUrl = createElectronRuntimeDownloadUrlResolver(
      () => request as never,
    );

    await expect(
      resolveUrl(
        new URL("https://github.com/example/runtime"),
        { Range: "bytes=0-31" },
        new AbortController().signal,
        TIMEOUTS,
        5,
      ),
    ).resolves.toEqual(new URL("https://release-assets.example/runtime"));
    expect(request.ended).toBe(true);
    expect(request.followed).toBe(1);
    expect(request.aborted).toBe(true);
  });

  it("rejects redirect loops at the configured bound", async () => {
    const request = new FakeElectronRequest((value) => {
      value.emit("redirect", 302, "GET", "https://example.com/one", {});
      value.emit("redirect", 302, "GET", "https://example.com/two", {});
    });
    const resolveUrl = createElectronRuntimeDownloadUrlResolver(
      () => request as never,
    );

    await expect(
      resolveUrl(
        new URL("https://github.com/example/runtime"),
        {},
        new AbortController().signal,
        TIMEOUTS,
        1,
      ),
    ).rejects.toThrow(/redirect limit/i);
    expect(request.followed).toBe(1);
    expect(request.aborted).toBe(true);
  });

  it("rejects an HTTPS-to-HTTP downgrade", async () => {
    const request = new FakeElectronRequest((value) => {
      value.emit("redirect", 302, "GET", "http://example.com/runtime", {});
    });
    const resolveUrl = createElectronRuntimeDownloadUrlResolver(
      () => request as never,
    );

    await expect(
      resolveUrl(
        new URL("https://github.com/example/runtime"),
        {},
        new AbortController().signal,
        TIMEOUTS,
        5,
      ),
    ).rejects.toThrow(/not allowed/i);
    expect(request.followed).toBe(0);
    expect(request.aborted).toBe(true);
  });
});
