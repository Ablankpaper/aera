import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FetchRuntimeDownloadTransport,
  RuntimeDownloadCancelledError,
  downloadWithResume,
  runtimePartialPaths,
} from "../src/main/agentera-runtime-distribution/downloader";

const BODY = Buffer.from("Aera Runtime resumable download fixture", "utf8");
const HASH = createHash("sha256").update(BODY).digest("hex");

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("loopback server did not bind a port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

interface ProgressDropController {
  capture: (response: ServerResponse) => void;
  onProgress: (received: number) => void;
}

function progressDropController(expectedBytes: number): ProgressDropController {
  let response: ServerResponse | null = null;
  return {
    capture: (value) => {
      response = value;
    },
    onProgress: (received) => {
      if (received < expectedBytes || response === null) return;
      const interrupted = response;
      response = null;
      interrupted.destroy();
    },
  };
}

interface DownloadFixture {
  root: string;
  destination: string;
  cleanup: () => void;
}

function createDownloadFixture(): DownloadFixture {
  const root = mkdtempSync(join(tmpdir(), "agentera-runtime-download-"));
  return {
    root,
    destination: join(root, "runtime.tar.zst"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function request(
  url: URL,
  fixture: DownloadFixture,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  return downloadWithResume({
    url,
    destination: fixture.destination,
    expectedSize: BODY.length,
    expectedSha256: HASH,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    ...overrides,
  });
}

describe("Runtime resumable downloader", () => {
  it("uses an injected Chromium-network fetcher through bounded redirects", async () => {
    const fixture = createDownloadFixture();
    const requests: Array<{
      url: string;
      redirect: string;
      range: string | undefined;
    }> = [];
    const transport = new FetchRuntimeDownloadTransport(
      async (url, init) => {
        requests.push({
          url,
          redirect: init.redirect,
          range: init.headers.Range,
        });
        return new Response(new Uint8Array(BODY), {
          status: 200,
          headers: {
            "Content-Length": String(BODY.length),
            ETag: '"fetch-v1"',
          },
        });
      },
      async (url) => new URL("/asset", url),
    );
    try {
      await request(new URL("https://updates.example/runtime"), fixture, {
        transport,
      });
      expect(readFileSync(fixture.destination)).toEqual(BODY);
      expect(requests).toEqual([
        {
          url: "https://updates.example/asset",
          redirect: "error",
          range: undefined,
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves the read timeout on the Chromium-network transport", async () => {
    const fixture = createDownloadFixture();
    const transport = new FetchRuntimeDownloadTransport(
      async () =>
        new Response(new ReadableStream<Uint8Array>(), {
          status: 200,
          headers: { "Content-Length": String(BODY.length) },
        }),
    );
    try {
      await expect(
        request(new URL("https://updates.example/runtime"), fixture, {
          transport,
          timeouts: { connectMs: 100, readMs: 20, overallMs: 200 },
        }),
      ).rejects.toThrow(/read timeout/i);
    } finally {
      fixture.cleanup();
    }
  });

  it("streams a complete verified file and removes partial metadata", async () => {
    const fixture = createDownloadFixture();
    const progress: number[] = [];
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Length": BODY.length,
        ETag: '"fixture-v1"',
      });
      response.end(BODY);
    });
    try {
      const port = await listen(server);
      await request(new URL(`http://127.0.0.1:${port}/runtime`), fixture, {
        onProgress: (received: number) => progress.push(received),
      });
      expect(readFileSync(fixture.destination)).toEqual(BODY);
      const partial = runtimePartialPaths(fixture.destination);
      expect(existsSync(partial.data)).toBe(false);
      expect(existsSync(partial.metadata)).toBe(false);
      expect(progress.at(-1)).toBe(BODY.length);
    } finally {
      await close(server);
      fixture.cleanup();
    }
  });

  it("retains a dropped partial and resumes it with a validated 206 response", async () => {
    const fixture = createDownloadFixture();
    const ranges: Array<string | undefined> = [];
    let attempt = 0;
    const split = 12;
    const drop = progressDropController(split);
    const server = createServer((incoming, response) => {
      attempt += 1;
      ranges.push(incoming.headers.range);
      if (attempt === 1) {
        response.writeHead(200, {
          "Content-Length": BODY.length,
          ETag: '"fixture-v1"',
        });
        drop.capture(response);
        response.write(BODY.subarray(0, split));
        return;
      }
      response.writeHead(206, {
        "Content-Length": BODY.length - split,
        "Content-Range": `bytes ${split}-${BODY.length - 1}/${BODY.length}`,
        ETag: '"fixture-v1"',
      });
      response.end(BODY.subarray(split));
    });
    try {
      const port = await listen(server);
      const url = new URL(`http://127.0.0.1:${port}/runtime`);
      await expect(
        request(url, fixture, { onProgress: drop.onProgress }),
      ).rejects.toThrow(/aborted|closed|socket/i);
      const partial = runtimePartialPaths(fixture.destination);
      expect(readFileSync(partial.data)).toEqual(BODY.subarray(0, split));
      expect(existsSync(partial.metadata)).toBe(true);

      await request(url, fixture);
      expect(ranges).toEqual([undefined, `bytes=${split}-`]);
      expect(readFileSync(fixture.destination)).toEqual(BODY);
    } finally {
      await close(server);
      fixture.cleanup();
    }
  });

  it("restarts safely when a server ignores Range and returns 200", async () => {
    const fixture = createDownloadFixture();
    const ranges: Array<string | undefined> = [];
    let attempt = 0;
    const split = 9;
    const drop = progressDropController(split);
    const server = createServer((incoming, response) => {
      attempt += 1;
      ranges.push(incoming.headers.range);
      if (attempt === 1) {
        response.writeHead(200, {
          "Content-Length": BODY.length,
          ETag: '"fixture-v1"',
        });
        drop.capture(response);
        response.write(BODY.subarray(0, split));
        return;
      }
      response.writeHead(200, {
        "Content-Length": BODY.length,
        ETag: '"fixture-v1"',
      });
      response.end(BODY);
    });
    try {
      const port = await listen(server);
      const url = new URL(`http://127.0.0.1:${port}/runtime`);
      await expect(
        request(url, fixture, { onProgress: drop.onProgress }),
      ).rejects.toThrow();
      await request(url, fixture);
      expect(ranges).toEqual([undefined, `bytes=${split}-`]);
      expect(readFileSync(fixture.destination)).toEqual(BODY);
    } finally {
      await close(server);
      fixture.cleanup();
    }
  });

  it("rejects a mismatched Content-Range without appending bytes", async () => {
    const fixture = createDownloadFixture();
    let attempt = 0;
    const split = 8;
    const drop = progressDropController(split);
    const server = createServer((_incoming, response) => {
      attempt += 1;
      if (attempt === 1) {
        response.writeHead(200, {
          "Content-Length": BODY.length,
          ETag: '"fixture-v1"',
        });
        drop.capture(response);
        response.write(BODY.subarray(0, split));
        return;
      }
      response.writeHead(206, {
        "Content-Range": `bytes ${split + 1}-${BODY.length - 1}/${BODY.length}`,
        ETag: '"fixture-v1"',
      });
      response.end(BODY.subarray(split));
    });
    try {
      const port = await listen(server);
      const url = new URL(`http://127.0.0.1:${port}/runtime`);
      await expect(
        request(url, fixture, { onProgress: drop.onProgress }),
      ).rejects.toThrow();
      await expect(request(url, fixture)).rejects.toThrow(/content-range/i);
      expect(
        readFileSync(runtimePartialPaths(fixture.destination).data),
      ).toEqual(BODY.subarray(0, split));
    } finally {
      await close(server);
      fixture.cleanup();
    }
  });

  it("restarts from zero when a resume validator changes", async () => {
    const fixture = createDownloadFixture();
    let attempt = 0;
    const ranges: Array<string | undefined> = [];
    const split = 10;
    const drop = progressDropController(split);
    const server = createServer((incoming, response) => {
      attempt += 1;
      ranges.push(incoming.headers.range);
      if (attempt === 1) {
        response.writeHead(200, {
          "Content-Length": BODY.length,
          ETag: '"fixture-v1"',
        });
        drop.capture(response);
        response.write(BODY.subarray(0, split));
        return;
      }
      if (attempt === 2) {
        response.writeHead(206, {
          "Content-Range": `bytes ${split}-${BODY.length - 1}/${BODY.length}`,
          ETag: '"fixture-v2"',
        });
        response.end(BODY.subarray(split));
        return;
      }
      response.writeHead(200, {
        "Content-Length": BODY.length,
        ETag: '"fixture-v2"',
      });
      response.end(BODY);
    });
    try {
      const port = await listen(server);
      const url = new URL(`http://127.0.0.1:${port}/runtime`);
      await expect(
        request(url, fixture, { onProgress: drop.onProgress }),
      ).rejects.toThrow();
      await request(url, fixture);
      expect(ranges).toEqual([undefined, `bytes=${split}-`, undefined]);
      expect(readFileSync(fixture.destination)).toEqual(BODY);
    } finally {
      await close(server);
      fixture.cleanup();
    }
  });

  it("bounds redirects and idle/overall timeouts", async () => {
    const fixture = createDownloadFixture();
    const redirectServer = createServer((incoming, response) => {
      const value = Number(incoming.url?.slice(1) || "0") + 1;
      response.writeHead(302, { Location: `/${value}` }).end();
    });
    const timeoutServer = createServer(() => undefined);
    let overallServer: Server | null = null;
    try {
      const redirectPort = await listen(redirectServer);
      await expect(
        request(new URL(`http://127.0.0.1:${redirectPort}/0`), fixture, {
          maxRedirects: 2,
        }),
      ).rejects.toThrow(/redirect/i);

      const timeoutPort = await listen(timeoutServer);
      await expect(
        request(new URL(`http://127.0.0.1:${timeoutPort}/runtime`), fixture, {
          timeouts: { connectMs: 100, readMs: 50, overallMs: 200 },
        }),
      ).rejects.toThrow(/timeout/i);

      let offset = 0;
      overallServer = createServer((_incoming, response) => {
        response.writeHead(200, { "Content-Length": BODY.length });
        const timer = setInterval(() => {
          if (offset >= BODY.length) {
            clearInterval(timer);
            response.end();
            return;
          }
          response.write(BODY.subarray(offset, offset + 1));
          offset += 1;
        }, 20);
        response.once("close", () => clearInterval(timer));
      });
      const overallPort = await listen(overallServer);
      await expect(
        request(new URL(`http://127.0.0.1:${overallPort}/runtime`), fixture, {
          timeouts: { connectMs: 100, readMs: 100, overallMs: 70 },
        }),
      ).rejects.toThrow(/overall timeout/i);
      await close(overallServer);
      overallServer = null;
    } finally {
      if (overallServer !== null) await close(overallServer);
      await close(redirectServer);
      await close(timeoutServer);
      fixture.cleanup();
    }
  });

  it("does not touch disk when cancellation was already requested", async () => {
    const fixture = createDownloadFixture();
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        request(new URL("http://127.0.0.1:9/runtime"), fixture, {
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(RuntimeDownloadCancelledError);
      const partial = runtimePartialPaths(fixture.destination);
      expect(existsSync(fixture.destination)).toBe(false);
      expect(existsSync(partial.data)).toBe(false);
      expect(existsSync(partial.metadata)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("retains a cancellable partial for a later retry", async () => {
    const fixture = createDownloadFixture();
    const controller = new AbortController();
    const server = createServer((_incoming, response) => {
      response.writeHead(200, {
        "Content-Length": BODY.length,
        ETag: '"fixture-v1"',
      });
      response.write(BODY.subarray(0, 7));
      setTimeout(() => response.end(BODY.subarray(7)), 500);
    });
    try {
      const port = await listen(server);
      const promise = request(
        new URL(`http://127.0.0.1:${port}/runtime`),
        fixture,
        {
          signal: controller.signal,
          onProgress: (received: number) => {
            if (received >= 7) controller.abort();
          },
        },
      );
      await expect(promise).rejects.toBeInstanceOf(
        RuntimeDownloadCancelledError,
      );
      const partial = runtimePartialPaths(fixture.destination);
      expect(existsSync(partial.data)).toBe(true);
      expect(existsSync(partial.metadata)).toBe(true);
    } finally {
      await close(server);
      fixture.cleanup();
    }
  });

  it.each([
    { name: "wrong size", expectedSize: BODY.length + 1, hash: HASH },
    { name: "wrong hash", expectedSize: BODY.length, hash: "0".repeat(64) },
  ])(
    "rejects $name and removes the poisoned complete partial",
    async ({ expectedSize, hash }) => {
      const fixture = createDownloadFixture();
      const server = createServer((_incoming, response) => {
        response.writeHead(200, { "Content-Length": BODY.length }).end(BODY);
      });
      try {
        const port = await listen(server);
        await expect(
          request(new URL(`http://127.0.0.1:${port}/runtime`), fixture, {
            expectedSize,
            expectedSha256: hash,
          }),
        ).rejects.toThrow(/size|hash|content-length/i);
        const partial = runtimePartialPaths(fixture.destination);
        expect(existsSync(fixture.destination)).toBe(false);
        expect(existsSync(partial.data)).toBe(false);
        expect(existsSync(partial.metadata)).toBe(false);
      } finally {
        await close(server);
        fixture.cleanup();
      }
    },
  );

  it("expires stale partial metadata and restarts without Range", async () => {
    const fixture = createDownloadFixture();
    let attempt = 0;
    const ranges: Array<string | undefined> = [];
    const drop = progressDropController(6);
    const server = createServer((incoming, response) => {
      attempt += 1;
      ranges.push(incoming.headers.range);
      if (attempt === 1) {
        response.writeHead(200, {
          "Content-Length": BODY.length,
          ETag: '"fixture-v1"',
        });
        drop.capture(response);
        response.write(BODY.subarray(0, 6));
        return;
      }
      response.writeHead(200, { "Content-Length": BODY.length }).end(BODY);
    });
    try {
      const port = await listen(server);
      const url = new URL(`http://127.0.0.1:${port}/runtime`);
      await expect(
        request(url, fixture, { onProgress: drop.onProgress }),
      ).rejects.toThrow();
      const partial = runtimePartialPaths(fixture.destination);
      const metadata = JSON.parse(readFileSync(partial.metadata, "utf8"));
      metadata.updatedAt = "2000-01-01T00:00:00.000Z";
      writeFileSync(partial.metadata, JSON.stringify(metadata));

      await request(url, fixture, {
        now: () => new Date("2026-07-18T12:00:00.000Z"),
        partialMaxAgeMs: 60_000,
      });
      expect(ranges).toEqual([undefined, undefined]);
      expect(readFileSync(fixture.destination)).toEqual(BODY);
    } finally {
      await close(server);
      fixture.cleanup();
    }
  });
});
