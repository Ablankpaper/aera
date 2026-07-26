// @vitest-environment node

import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  startAgenteraLoopbackListener,
  type AgenteraLoopbackServerFactory,
  type AgenteraLoopbackListener,
} from "../src/main/agentera-auth/loopback";
import { createAgenteraPkceAttempt } from "../src/main/agentera-auth/pkce";

const listeners: AgenteraLoopbackListener[] = [];

afterEach(() => {
  for (const listener of listeners.splice(0)) listener.close();
});

async function start(
  expectedState = Buffer.alloc(32, 1).toString("base64url"),
  timeoutMs = 2_000,
): Promise<AgenteraLoopbackListener> {
  const listener = await startAgenteraLoopbackListener({
    expectedState,
    timeoutMs,
  });
  listeners.push(listener);
  return listener;
}

describe("AgentEra OAuth loopback listener", () => {
  // @lat: [[agentera-app-authentication#Browser sign-in#Loopback callback]]
  it("binds an ephemeral IPv4 loopback port and consumes one exact callback", async () => {
    const state = Buffer.alloc(32, 2).toString("base64url");
    const code = Buffer.alloc(32, 3).toString("base64url");
    const listener = await start(state);

    expect(listener.redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/agentera\/oauth\/callback$/,
    );
    const response = await fetch(
      `${listener.redirectUri}?code=${code}&state=${state}`,
    );
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(page).toContain("AgentEra Studio");
    expect(page).not.toContain(code);
    expect(page).not.toContain(state);
    await expect(listener.callback).resolves.toEqual({
      authorizationCode: code,
    });

    await expect(
      fetch(`${listener.redirectUri}?code=${code}&state=${state}`),
    ).rejects.toThrow();
  });

  it("rejects wrong or missing state without consuming the valid callback", async () => {
    const state = Buffer.alloc(32, 4).toString("base64url");
    const code = Buffer.alloc(32, 5).toString("base64url");
    const listener = await start(state);

    expect(
      (await fetch(`${listener.redirectUri}?code=${code}&state=wrong`)).status,
    ).toBe(400);
    expect((await fetch(`${listener.redirectUri}?code=${code}`)).status).toBe(
      400,
    );
    expect(
      (
        await fetch(
          `${listener.redirectUri}?code=${code}&state=${state}&state=${state}`,
        )
      ).status,
    ).toBe(400);

    expect(
      (await fetch(`${listener.redirectUri}?code=${code}&state=${state}`))
        .status,
    ).toBe(200);
    await expect(listener.callback).resolves.toEqual({
      authorizationCode: code,
    });
  });

  it("rejects unrelated paths, methods, malformed codes, and oversized queries", async () => {
    const state = Buffer.alloc(32, 6).toString("base64url");
    const code = Buffer.alloc(32, 7).toString("base64url");
    const listener = await start(state);

    expect((await fetch(new URL("/other", listener.redirectUri))).status).toBe(
      404,
    );
    expect((await fetch(listener.redirectUri, { method: "POST" })).status).toBe(
      405,
    );
    expect(
      (await fetch(`${listener.redirectUri}?code=not-canonical&state=${state}`))
        .status,
    ).toBe(400);
    expect(
      (
        await fetch(
          `${listener.redirectUri}?code=${code}&state=${state}&padding=${"x".repeat(5_000)}`,
        )
      ).status,
    ).toBe(414);

    expect(
      (await fetch(`${listener.redirectUri}?code=${code}&state=${state}`))
        .status,
    ).toBe(200);
  });

  it("closes on timeout and explicit browser cancellation", async () => {
    const timedOut = await start(undefined, 10);
    await expect(timedOut.callback).rejects.toThrow(/timed out/i);

    const cancelled = await start();
    cancelled.cancel();
    await expect(cancelled.callback).rejects.toThrow(/cancelled/i);
  });

  it("refuses non-loopback binding and surfaces listener errors", async () => {
    await expect(
      startAgenteraLoopbackListener({
        expectedState: Buffer.alloc(32, 8).toString("base64url"),
        host: "0.0.0.0",
      }),
    ).rejects.toThrow(/127\.0\.0\.1|loopback/i);

    const failingFactory: AgenteraLoopbackServerFactory = (handler) => {
      const server = createServer(handler);
      server.listen = (() => {
        queueMicrotask(() => server.emit("error", new Error("bind failed")));
        return server;
      }) as typeof server.listen;
      return server;
    };
    await expect(
      startAgenteraLoopbackListener({
        expectedState: Buffer.alloc(32, 9).toString("base64url"),
        serverFactory: failingFactory,
      }),
    ).rejects.toThrow(/listener|bind/i);
  });
});

describe("AgentEra PKCE material", () => {
  it("creates independent 256-bit state and S256 verifier material", () => {
    let fill = 0;
    const first = createAgenteraPkceAttempt((size) =>
      Buffer.alloc(size, (fill += 1)),
    );
    const second = createAgenteraPkceAttempt((size) =>
      Buffer.alloc(size, (fill += 1)),
    );

    expect(Buffer.from(first.state, "base64url")).toHaveLength(32);
    expect(Buffer.from(first.verifier, "base64url")).toHaveLength(32);
    expect(Buffer.from(first.challenge, "base64url")).toHaveLength(32);
    expect(first.challenge).toHaveLength(43);
    expect(second.state).not.toBe(first.state);
    expect(second.verifier).not.toBe(first.verifier);
  });
});
