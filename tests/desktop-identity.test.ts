import { afterEach, describe, expect, it } from "vitest";
import {
  configureDesktopIdentity,
  resolveDesktopUserDataPath,
} from "../src/main/app/identity";

afterEach(() => {
  delete process.env.HERMES_DESKTOP_USER_DATA_DIR;
});

function fakeApp(current: string): {
  calls: string[];
  getPath: (name: "appData" | "userData") => string;
  setPath: (name: "userData", value: string) => void;
} {
  const calls: string[] = [];
  return {
    calls,
    getPath: (name) => (name === "appData" ? "/app-data" : current),
    setPath: (_name, value) => calls.push(value),
  };
}

describe("desktop identity data continuity", () => {
  it("honors the explicit compatibility override", () => {
    process.env.HERMES_DESKTOP_USER_DATA_DIR = "/isolated";
    const app = fakeApp("/app-data/AgentEra Studio");

    configureDesktopIdentity(app, () => false);

    expect(app.calls).toEqual(["/isolated"]);
  });

  it("adopts legacy data only when the new directory is absent", () => {
    const app = fakeApp("/app-data/AgentEra Studio");
    const exists = (path: string): boolean =>
      path === "/app-data/hermes-desktop";

    expect(resolveDesktopUserDataPath(app, "", exists)).toBe(
      "/app-data/hermes-desktop",
    );
  });

  it("does not overwrite an existing new data directory", () => {
    const app = fakeApp("/app-data/AgentEra Studio");
    const exists = (): boolean => true;

    expect(resolveDesktopUserDataPath(app, "", exists)).toBeNull();
  });
});
