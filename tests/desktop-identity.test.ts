import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureDesktopIdentity,
  resolveDesktopUserDataPath,
} from "../src/main/app/identity";

const appData = resolve("app-data");
const currentUserData = join(appData, "Aera");
const legacyProductUserData = join(appData, "AgentEra Studio");
const legacyPackageUserData = join(appData, "agentera-studio");
const legacyHermesUserData = join(appData, "hermes-desktop");
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

  it.each([
    ["legacy product directory", legacyProductUserData],
    ["legacy package directory", legacyPackageUserData],
    ["legacy upstream directory", legacyHermesUserData],
  ])("adopts %s only when the Aera directory is absent", (_label, legacy) => {
    const app = fakeApp(currentUserData);
    const exists = (path: string): boolean => path === legacy;

    expect(resolveDesktopUserDataPath(app, "", exists)).toBe(legacy);
  });

  it("does not overwrite an existing new data directory", () => {
    const app = fakeApp(currentUserData);
    const exists = (): boolean => true;

    expect(resolveDesktopUserDataPath(app, "", exists)).toBeNull();
  });

  it("prefers the newest legacy product directory when several exist", () => {
    const app = fakeApp(currentUserData);
    const exists = (path: string): boolean =>
      path === legacyProductUserData || path === legacyHermesUserData;

    expect(resolveDesktopUserDataPath(app, "", exists)).toBe(
      legacyProductUserData,
    );
  });
});
