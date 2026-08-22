// @vitest-environment node

import { createServer, type Server } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  firstBindablePort,
  isLoopbackPortAccepting,
  isLoopbackPortReleased,
} from "./gateway-ports";

describe("gateway port availability", () => {
  it("skips ports occupied by another local Aera instance", async () => {
    const probe = vi.fn(async (port: number) => port === 8646);

    await expect(firstBindablePort([8644, 8645, 8646], probe)).resolves.toBe(
      8646,
    );
    expect(probe.mock.calls.map(([port]) => port)).toEqual([8644, 8645, 8646]);
  });

  it("returns null when the reserved range has no bindable port", async () => {
    await expect(
      firstBindablePort([8644, 8645], async () => false),
    ).resolves.toBeNull();
  });
});

describe("loopback port release detection", () => {
  const listenOnFreePort = async (): Promise<{
    server: Server;
    port: number;
  }> =>
    await new Promise((resolve) => {
      const server = createServer();
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve({ server, port });
      });
    });

  const close = async (server: Server): Promise<void> =>
    await new Promise((resolve) => server.close(() => resolve()));

  it("reports a listening port as not released even though SO_REUSEADDR allows a bind", async () => {
    const { server, port } = await listenOnFreePort();
    try {
      await expect(isLoopbackPortAccepting(port)).resolves.toBe(true);
      await expect(isLoopbackPortReleased(port)).resolves.toBe(false);
    } finally {
      await close(server);
    }
  });

  it("reports a closed port as released", async () => {
    const { server, port } = await listenOnFreePort();
    await close(server);

    await expect(isLoopbackPortAccepting(port)).resolves.toBe(false);
    await expect(isLoopbackPortReleased(port)).resolves.toBe(true);
  });
});
