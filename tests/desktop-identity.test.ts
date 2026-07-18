import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureDesktopIdentity,
  resolveDesktopUserDataPath,
} from "../src/main/app/identity";

const appData = resolve("app-data");
const currentUserData = join(appData, "AgentEra Studio");
const legacyUserData = join(appData, "hermes-desktop");
const isolatedUserData = resolve("isolated");

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
    getPath: (name) => (name === "appData" ? appData : current),
    setPath: (_name, value) => calls.push(value),
  };
}

describe("desktop identity data continuity", () => {
  it("honors the explicit compatibility override", () => {
    process.env.HERMES_DESKTOP_USER_DATA_DIR = isolatedUserData;
    const app = fakeApp(currentUserData);

    configureDesktopIdentity(app, () => false);

    expect(app.calls).toEqual([isolatedUserData]);
  });

  it("adopts legacy data only when the new directory is absent", () => {
    const app = fakeApp(currentUserData);
    const exists = (path: string): boolean => path === legacyUserData;

    expect(resolveDesktopUserDataPath(app, "", exists)).toBe(legacyUserData);
  });

  it("does not overwrite an existing new data directory", () => {
    const app = fakeApp(currentUserData);
    const exists = (): boolean => true;

    expect(resolveDesktopUserDataPath(app, "", exists)).toBeNull();
  });
});
