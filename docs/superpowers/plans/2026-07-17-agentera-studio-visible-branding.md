# AgentEra Studio Visible Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every user-visible first-party Hermes desktop brand surface with AgentEra Studio, AgentEra, or AgentEra Runtime while preserving application behavior and internal runtime compatibility.

**Architecture:** Introduce one shared TypeScript brand contract for runtime code, enforce non-code package metadata through focused repository tests, and restore the approved AgentEra binary assets from the preserved local backup commit. Keep user-data continuity and all `HERMES_*`, `.hermes`, `hermes_cli`, IPC, API, route, and database contracts stable.

**Tech Stack:** Electron 39, electron-vite 5, React 19, TypeScript 5.9, i18next 25, Vitest 4, electron-builder 26.

## Global Constraints

- Desktop product name is exactly `AgentEra Studio`.
- Parent brand, publisher, vendor, and ecosystem name is exactly `AgentEra`.
- Bundled engine name shown to users is exactly `AgentEra Runtime`.
- Package and artifact stem is exactly `agentera-studio`.
- Electron bundle/application id is exactly `com.bignormal.agentera.studio`.
- Windows executable name is exactly `agentera-studio`.
- Windows package identifier is exactly `Bignormal.AgentEraStudio`.
- Source, issue, release, and desktop-update repository is exactly `bignormal/aera`.
- Preserve `HERMES_*`, `.hermes`, `hermes-agent`, `hermes_cli`, IPC bridge names, API headers, routes, schemas, provider ids, model ids, and command syntax.
- Preserve existing application data, profiles, history, configuration, and update preferences without deleting or overwriting either the legacy or new data directory.
- Keep the splash timing, status messages, connection checks, local-mode escape hatch, layout, navigation, features, and color system unchanged.
- Keep MIT license text, copyright notices, source history, and required third-party attribution intact.
- Do not add analytics, cloud, community, social, or donation endpoints.
- Do not upgrade dependencies, run broad audit fixes, sign, notarize, publish, or push without separate authorization.

---

### Task 1: Pin the visible-brand contract

**Files:**

- Create: `tests/agentera-visible-branding.test.ts`
- Create: `lat.md/agentera-branding.md`
- Modify: `lat.md/lat.md`

**Interfaces:**

- Consumes: repository text files, locale modules under `src/shared/i18n/locales`, and the naming values in the approved design spec.
- Produces: a Vitest regression gate that later tasks make green and `lat.md` sections referenced by each brand test.

- [ ] **Step 1: Write the failing brand-contract test**

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");
const localeFiles = readdirSync("src/shared/i18n/locales", {
  withFileTypes: true,
}).flatMap((entry) => {
  if (!entry.isDirectory()) return [];
  const root = join("src/shared/i18n/locales", entry.name);
  return readdirSync(root)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(root, name));
});

describe("AgentEra Studio visible branding", () => {
  // @lat: [[agentera-branding#Naming contract#Desktop identity]]
  it("owns the desktop packaging identity", () => {
    expect(JSON.parse(read("package.json"))).toMatchObject({
      name: "agentera-studio",
      description: "AgentEra Studio — private AI agent desktop",
      author: "AgentEra",
      homepage: "https://github.com/bignormal/aera",
    });
    const builder = read("electron-builder.yml");
    expect(builder).toContain("appId: com.bignormal.agentera.studio");
    expect(builder).toContain("productName: AgentEra Studio");
    expect(builder).toContain("executableName: agentera-studio");
    expect(builder).toContain("owner: bignormal");
    expect(builder).toContain("repo: aera");
  });

  // @lat: [[agentera-branding#Naming contract#Visible application names]]
  it("uses the approved names on composed application surfaces", () => {
    expect(read("src/shared/branding.ts")).toContain(
      'DESKTOP_PRODUCT_NAME = "AgentEra Studio"',
    );
    expect(read("src/shared/branding.ts")).toContain(
      'RUNTIME_DISPLAY_NAME = "AgentEra Runtime"',
    );
    expect(read("src/renderer/index.html")).toContain(
      "<title>AgentEra Studio</title>",
    );
    expect(
      read("src/renderer/src/screens/SplashScreen/SplashScreen.tsx"),
    ).toContain("AgentEra Studio");
    expect(read("src/renderer/src/screens/Chat/Chat.tsx")).not.toContain(
      "FollowUsModal",
    );
    expect(
      read("src/renderer/src/components/settings/SettingsModal.tsx"),
    ).not.toContain("<CommunityPane");
  });

  // @lat: [[agentera-branding#Localization#All supported locales]]
  it("uses AgentEra names in locale product copy", () => {
    const commonFiles = localeFiles.filter((path) =>
      path.endsWith("/common.ts"),
    );
    expect(commonFiles).toHaveLength(12);
    for (const path of commonFiles) {
      expect(read(path), path).toContain('appName: "AgentEra Studio"');
    }
    const firstPartyLeaks = localeFiles.flatMap((path) =>
      read(path)
        .split("\n")
        .map((line, index) => ({ path, line: index + 1, text: line.trim() }))
        .filter(({ text }) => {
          if (
            !/(Hermes One|Hermes Desktop|Hermes Agent|Nous Research|fathah)/.test(
              text,
            )
          )
            return false;
          if (/^(\/\/|\*|\/\*)/.test(text)) return false;
          if (/Hermes One (Inference|account)/.test(text)) return false;
          if (
            /(constants|providers)\.ts$/.test(path) &&
            /(Hermes One|Nous Research)/.test(text)
          )
            return false;
          if (
            /(HERMES_|\.hermes|hermes_cli|<code>hermes\s|@hermes:)/.test(text)
          )
            return false;
          return true;
        }),
    );
    expect(firstPartyLeaks).toEqual([]);
  });

  // @lat: [[agentera-branding#Compatibility boundary#Stable runtime identifiers]]
  it("preserves runtime compatibility identifiers", () => {
    expect(read("src/main/installer.ts")).toContain("HERMES_HOME");
    expect(read("src/preload/index.ts")).toContain("hermesAPI");
    expect(read("src/renderer/src/constants.ts")).toContain(
      "Hermes One Inference",
    );
    expect(read("src/renderer/src/constants.ts")).toContain(
      "HERMESONE_API_KEY",
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run tests/agentera-visible-branding.test.ts`

Expected: FAIL because `package.json`, `electron-builder.yml`, `src/shared/branding.ts`, the splash, promotion composition, and locale names still carry the upstream identity.

- [ ] **Step 3: Add the lat.md brand specification**

Create `lat.md/agentera-branding.md` with these exact sections and leading paragraphs:

```md
# AgentEra branding

The desktop exposes one AgentEra product identity while retaining internal Hermes runtime compatibility.

## Naming contract

First-party product, publisher, package, and runtime display names are fixed so every release surface stays consistent.

### Desktop identity

The desktop product is AgentEra Studio, published by AgentEra from `bignormal/aera`, with package stem `agentera-studio`.

### Visible application names

Composed UI surfaces use AgentEra Studio for the desktop and AgentEra Runtime for the bundled engine.

## Localization

Every supported locale keeps the AgentEra names unchanged while translating the surrounding sentence normally.

### All supported locales

All twelve locale packs expose AgentEra Studio consistently and contain no inherited first-party promotion copy.

## Compatibility boundary

Branding changes never rename runtime protocols, data directories, commands, provider ids, or third-party services.

### Stable runtime identifiers

`HERMES_*`, `.hermes`, `hermes_cli`, `hermesAPI`, provider ids, and factual third-party names remain stable.
```

Add `[[agentera-branding]]` to the relevant index list in `lat.md/lat.md`.

- [ ] **Step 4: Run the repository knowledge check**

Run: `npx --yes lat.md check`

Expected: `All checks passed` with each `@lat:` reference resolving to the new sections.

- [ ] **Step 5: Commit the red contract**

```bash
git add tests/agentera-visible-branding.test.ts lat.md/agentera-branding.md lat.md/lat.md
git commit -m "test: define AgentEra Studio brand contract"
```

---

### Task 2: Restore the approved icon set and implement the splash wordmark

**Files:**

- Create: `tests/agentera-icon-assets.test.ts`
- Create: `src/renderer/src/screens/SplashScreen/SplashScreen.test.tsx`
- Restore: `assets/agentera-icon.png`
- Modify: `build/icon.icns`
- Modify: `build/icon.ico`
- Modify: `build/icon.png`
- Modify: `resources/icon.png`
- Modify: `src/renderer/src/assets/iconv2.png`
- Modify: `src/renderer/src/screens/SplashScreen/SplashScreen.tsx`
- Modify: `src/renderer/src/assets/main.css`

**Interfaces:**

- Consumes: approved binary assets from local backup commit `f8b7e67` in `/Users/zizimutou/Desktop/aera/aera-local-branding-backup-20260717-114119` and the existing `startvid.mp4` splash video.
- Produces: canonical cross-platform AgentEra icons and a CSS-rendered `AgentEra Studio` startup wordmark without changing splash behavior.

- [ ] **Step 1: Write the failing icon and splash tests**

```ts
// tests/agentera-icon-assets.test.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readAsset = (path: string): Buffer => readFileSync(path);
const pngSize = (path: string): { width: number; height: number } => {
  const data = readAsset(path);
  expect(data.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
};

describe("AgentEra icon assets", () => {
  it("uses the approved source and generated platform assets", () => {
    expect(
      createHash("sha256")
        .update(readAsset("assets/agentera-icon.png"))
        .digest("hex"),
    ).toBe("69c288f19128c275f5f574e995ae9544f18ff564e847339cf47d5345e231d882");
    expect(pngSize("build/icon.png")).toEqual({ width: 1024, height: 1024 });
    expect(pngSize("resources/icon.png")).toEqual({ width: 512, height: 512 });
    expect(pngSize("src/renderer/src/assets/iconv2.png")).toEqual({
      width: 512,
      height: 512,
    });
    expect(readAsset("build/icon.icns").subarray(0, 4).toString("ascii")).toBe(
      "icns",
    );
    expect([...readAsset("build/icon.ico").subarray(0, 4)]).toEqual([
      0, 0, 1, 0,
    ]);
  });
});
```

```tsx
// src/renderer/src/screens/SplashScreen/SplashScreen.test.tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SplashScreen from "./SplashScreen";

describe("SplashScreen", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("shows the AgentEra Studio wordmark without the Hermes image", () => {
    const onFinished = vi.fn();
    render(<SplashScreen onFinished={onFinished} />);
    expect(screen.getByText("AgentEra Studio")).toHaveClass("splash-wordmark");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(onFinished).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run both tests and verify RED**

Run: `npm test -- --run tests/agentera-icon-assets.test.ts src/renderer/src/screens/SplashScreen/SplashScreen.test.tsx`

Expected: FAIL because the master icon is missing and the splash still renders `hermes-one.svg`.

- [ ] **Step 3: Restore only the approved binary assets from the preserved commit**

```bash
git fetch /Users/zizimutou/Desktop/aera/aera-local-branding-backup-20260717-114119 f8b7e67
git restore --source=FETCH_HEAD -- assets/agentera-icon.png build/icon.icns build/icon.ico build/icon.png resources/icon.png src/renderer/src/assets/iconv2.png
```

Do not cherry-pick the old commit; restoring only these six assets avoids importing its obsolete `AgentEra`-only naming contract.

- [ ] **Step 4: Replace the splash image with the approved wordmark**

Change `SplashScreen.tsx` to keep the existing video and render:

```tsx
<div className="splash-wordmark">AgentEra Studio</div>
```

Remove only the `hermes-one.svg` import and the `<img className="splash-logo" ... />` element. Keep the effects, timer, status, and switch-to-local markup byte-for-byte otherwise.

Replace `.splash-logo` in `main.css` with:

```css
.splash-wordmark {
  position: relative;
  z-index: 1;
  max-width: 80%;
  padding: 0 24px;
  opacity: 0;
  color: #fff;
  font-family:
    "Manrope",
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  font-size: clamp(48px, 7.5vw, 104px);
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.055em;
  white-space: nowrap;
  user-select: none;
  background: linear-gradient(105deg, #fff 0%, #e8fbff 48%, #d7ccff 100%);
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 12px 36px rgba(0, 0, 0, 0.5));
  animation: splashFadeIn 1.1s ease-out forwards;
}
```

- [ ] **Step 5: Run the icon and splash tests and verify GREEN**

Run: `npm test -- --run tests/agentera-icon-assets.test.ts src/renderer/src/screens/SplashScreen/SplashScreen.test.tsx`

Expected: 2 test files PASS.

- [ ] **Step 6: Commit the visual identity**

```bash
git add assets/agentera-icon.png build/icon.icns build/icon.ico build/icon.png resources/icon.png src/renderer/src/assets/iconv2.png tests/agentera-icon-assets.test.ts src/renderer/src/screens/SplashScreen/SplashScreen.tsx src/renderer/src/screens/SplashScreen/SplashScreen.test.tsx src/renderer/src/assets/main.css
git commit -m "feat: add AgentEra Studio visual identity"
```

---

### Task 3: Centralize desktop identity and preserve user data

**Files:**

- Create: `src/shared/branding.ts`
- Create: `src/main/app/identity.ts`
- Create: `tests/desktop-identity.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/installer.ts`
- Modify: `src/main/app/start.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/renderer/src/main.tsx`
- Modify: `src/renderer/index.html`

**Interfaces:**

- Consumes: `HERMES_DESKTOP_APP_NAME`, `HERMES_DESKTOP_USER_DATA_DIR`, Electron `app.getPath()`/`app.setPath()`, and the existing legacy directory name `hermes-desktop`.
- Produces: `DESKTOP_PRODUCT_NAME`, `BRAND_NAME`, `RUNTIME_DISPLAY_NAME`, `DESKTOP_APP_ID`, `DESKTOP_REPOSITORY_URL`, `resolveDesktopUserDataPath()`, and `configureDesktopIdentity()`.

- [ ] **Step 1: Write failing identity-continuity tests**

```ts
import { afterEach, describe, expect, it } from "vitest";
import {
  configureDesktopIdentity,
  resolveDesktopUserDataPath,
} from "../src/main/app/identity";

afterEach(() => delete process.env.HERMES_DESKTOP_USER_DATA_DIR);

describe("desktop identity data continuity", () => {
  const fakeApp = (current: string) => {
    const calls: string[] = [];
    return {
      calls,
      getPath: (name: "appData" | "userData") =>
        name === "appData" ? "/app-data" : current,
      setPath: (_name: "userData", value: string) => calls.push(value),
    };
  };

  it("honors the explicit compatibility override", () => {
    process.env.HERMES_DESKTOP_USER_DATA_DIR = "/isolated";
    const app = fakeApp("/app-data/AgentEra Studio");
    configureDesktopIdentity(app, () => false);
    expect(app.calls).toEqual(["/isolated"]);
  });

  it("adopts legacy data only when the new directory is absent", () => {
    const app = fakeApp("/app-data/AgentEra Studio");
    const exists = (path: string) => path === "/app-data/hermes-desktop";
    expect(resolveDesktopUserDataPath(app, "", exists)).toBe(
      "/app-data/hermes-desktop",
    );
  });

  it("does not overwrite an existing new data directory", () => {
    const app = fakeApp("/app-data/AgentEra Studio");
    const exists = () => true;
    expect(resolveDesktopUserDataPath(app, "", exists)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the identity test and verify RED**

Run: `npm test -- --run tests/desktop-identity.test.ts`

Expected: FAIL because `src/main/app/identity.ts` does not exist.

- [ ] **Step 3: Add the shared brand constants**

```ts
// src/shared/branding.ts
export const BRAND_NAME = "AgentEra";
export const DESKTOP_PRODUCT_NAME = "AgentEra Studio";
export const RUNTIME_DISPLAY_NAME = "AgentEra Runtime";
export const DESKTOP_APP_ID = "com.bignormal.agentera.studio";
export const DESKTOP_REPOSITORY_URL = "https://github.com/bignormal/aera";
```

- [ ] **Step 4: Implement non-destructive user-data resolution**

```ts
// src/main/app/identity.ts
import { existsSync } from "node:fs";
import { join } from "node:path";

interface IdentityApp {
  getPath(name: "appData" | "userData"): string;
  setPath(name: "userData", path: string): void;
}

export function resolveDesktopUserDataPath(
  app: IdentityApp,
  override = process.env.HERMES_DESKTOP_USER_DATA_DIR?.trim() || "",
  pathExists: (path: string) => boolean = existsSync,
): string | null {
  if (override) return override;
  const current = app.getPath("userData");
  const legacy = join(app.getPath("appData"), "hermes-desktop");
  if (current !== legacy && pathExists(legacy) && !pathExists(current)) {
    return legacy;
  }
  return null;
}

export function configureDesktopIdentity(
  app: IdentityApp,
  pathExists: (path: string) => boolean = existsSync,
): void {
  const target = resolveDesktopUserDataPath(
    app,
    process.env.HERMES_DESKTOP_USER_DATA_DIR?.trim() || "",
    pathExists,
  );
  if (target) app.setPath("userData", target);
}
```

- [ ] **Step 5: Call identity configuration before GPU preference reads**

In `src/main/index.ts`, keep `.env` loading first, then call:

```ts
if (!app.isPackaged) loadDotEnvForDev();
configureDesktopIdentity(app);
applyGpuPreferences();
```

Remove the duplicate module-level `HERMES_DESKTOP_USER_DATA_DIR`/`app.setPath()` block from `src/main/installer.ts`; the new early bootstrap owns that responsibility.

- [ ] **Step 6: Use the shared identity in main and renderer defaults**

Use:

```ts
const APP_NAME =
  process.env.HERMES_DESKTOP_APP_NAME?.trim() || DESKTOP_PRODUCT_NAME;
```

in `src/main/app/start.ts` and `src/main/ipc/register.ts`, set Windows identity with:

```ts
electronApp.setAppUserModelId(DESKTOP_APP_ID);
```

and set both renderer title fallbacks to `AgentEra Studio` through `DESKTOP_PRODUCT_NAME` while preserving `VITE_HERMES_DESKTOP_APP_NAME`.

- [ ] **Step 7: Run identity, focused brand, and type checks**

Run: `npm test -- --run tests/desktop-identity.test.ts tests/agentera-visible-branding.test.ts`

Expected: identity tests PASS; packaging and locale assertions in the brand contract remain RED for later tasks.

Run: `npm run typecheck:node && npm run typecheck:web`

Expected: both TypeScript projects exit 0.

- [ ] **Step 8: Commit the stable desktop identity**

```bash
git add src/shared/branding.ts src/main/app/identity.ts tests/desktop-identity.test.ts src/main/index.ts src/main/installer.ts src/main/app/start.ts src/main/ipc/register.ts src/renderer/src/main.tsx src/renderer/index.html
git commit -m "feat: set AgentEra Studio desktop identity"
```

---

### Task 4: Rebrand package, installer, update, and release metadata

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `electron-builder.yml`
- Modify: `dev-app-update.yml`
- Modify: `build/linux-after-install.sh`
- Modify: `build/winget/Installer.template.yaml`
- Modify: `build/winget/Locale.en-US.template.yaml`
- Modify: `build/winget/Version.template.yaml`
- Modify: `scripts/generate-winget-manifests.mjs`
- Modify: `tests/winget-generator.test.ts`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/beta-release.yml`
- Test: `tests/agentera-visible-branding.test.ts`

**Interfaces:**

- Consumes: electron-builder substitutions `${name}`, `${productName}`, `${version}`, `${arch}`, `${os}`, `${ext}` and Winget generator inputs `{ rootDir, version, name, publishOwner }`.
- Produces: AgentEra Studio package metadata, filenames, installer identity, GitHub update source, and release artifact matching.

- [ ] **Step 1: Update Winget tests to the new package contract and verify RED**

Use `agentera-studio-9.9.9-setup.exe`, `publishOwner: "bignormal"`, output directory:

```ts
join(
  distDir,
  "winget",
  "manifests",
  "b",
  "Bignormal",
  "AgentEraStudio",
  "9.9.9",
);
```

and filenames:

```ts
"Bignormal.AgentEraStudio.installer.yaml";
"Bignormal.AgentEraStudio.locale.en-US.yaml";
"Bignormal.AgentEraStudio.yaml";
```

Expected URLs are:

```text
https://github.com/bignormal/aera/releases/download/v9.9.9/agentera-studio-9.9.9-setup.exe
https://github.com/bignormal/aera/releases/tag/v9.9.9
```

Run: `npm test -- --run tests/winget-generator.test.ts`

Expected: FAIL on the old NousResearch output path and `fathah/hermes-desktop` URLs.

- [ ] **Step 2: Update package metadata without changing dependency versions**

Set `package.json` to:

```json
{
  "name": "agentera-studio",
  "description": "AgentEra Studio — private AI agent desktop",
  "author": "AgentEra",
  "homepage": "https://github.com/bignormal/aera"
}
```

Change only the two `name` values at the root and `packages[""]` of `package-lock.json` from `hermes-desktop` to `agentera-studio`. Keep the existing version and dependency graph unchanged.

- [ ] **Step 3: Update electron-builder and updater metadata**

Use these exact values:

```yaml
appId: com.bignormal.agentera.studio
productName: AgentEra Studio
win:
  executableName: agentera-studio
linux:
  maintainer: AgentEra
  vendor: AgentEra
publish:
  provider: github
  owner: bignormal
  repo: aera
```

Set `dev-app-update.yml` to owner `bignormal`, repo `aera`, and cache directory `agentera-studio-updater`. Update Linux description copy to name `AgentEra Studio` and `AgentEra Runtime`, and set `build/linux-after-install.sh` to `/opt/AgentEra Studio/chrome-sandbox`.

- [ ] **Step 4: Update Winget templates and generator constants**

Use:

```js
const PUBLISH_REPO = "aera";
const WINGET_PACKAGE_IDENTIFIER = "Bignormal.AgentEraStudio";
const WINGET_PACKAGE_PATH = ["b", "Bignormal", "AgentEraStudio"];
```

The locale template uses publisher `AgentEra`, package name `AgentEra Studio`, repository/support/license links under `bignormal/aera`, and description text naming `AgentEra Runtime`. Preserve the MIT license field.

- [ ] **Step 5: Update workflow artifact selection and remove the upstream landing deploy**

Change both release workflows to match:

```js
name.startsWith(`agentera-studio-${version}-`);
```

Set `PUBLISH_OWNER: bignormal` and remove the `rebuild_landing_page` job that dispatches `fathah/hermes-landing-page`. Do not add a replacement deployment.

- [ ] **Step 6: Run packaging metadata tests**

Run: `npm test -- --run tests/winget-generator.test.ts tests/agentera-visible-branding.test.ts`

Expected: Winget and packaging assertions PASS; locale and promotion assertions remain RED until Tasks 5 and 6.

- [ ] **Step 7: Verify lockfile stability**

Run: `git diff -- package-lock.json`

Expected: exactly two value changes from `hermes-desktop` to `agentera-studio`, with no version, integrity, peer, optional, or dependency-entry drift.

- [ ] **Step 8: Commit package identity**

```bash
git add package.json package-lock.json electron-builder.yml dev-app-update.yml build/linux-after-install.sh build/winget/Installer.template.yaml build/winget/Locale.en-US.template.yaml build/winget/Version.template.yaml scripts/generate-winget-manifests.mjs tests/winget-generator.test.ts .github/workflows/release.yml .github/workflows/beta-release.yml
git commit -m "build: rebrand AgentEra Studio packages"
```

---

### Task 5: Rebrand composed desktop UI without changing behavior

**Files:**

- Modify: `src/main/app/menu.ts`
- Modify: `src/main/hermes.ts`
- Modify: `src/main/installer.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/main/dashboard.ts`
- Modify: `src/main/mcp-servers.ts`
- Modify: `src/main/config-health.ts`
- Modify: `src/main/hermes-agent-compat.ts`
- Modify: `src/main/claw3d.ts`
- Modify: `src/renderer/src/screens/Layout/Layout.tsx`
- Modify: `src/renderer/src/components/settings/AboutPane.tsx`
- Modify: `src/renderer/src/components/settings/SettingsModal.tsx`
- Modify: `src/renderer/src/screens/Chat/Chat.tsx`
- Modify: `src/renderer/src/screens/Chat/ChatInput.tsx`
- Modify: `src/renderer/src/screens/Chat/hooks/useChatActions.ts`
- Modify: `src/renderer/src/screens/Chat/hooks/useLocalCommands.ts`
- Modify: `src/renderer/src/screens/Chat/slash/commandCatalog.ts`
- Modify: `src/renderer/src/screens/Office/office3d/objects/CarShowroom.tsx`
- Modify: `src/renderer/src/screens/Office/office3d/objects/OfficeShell.tsx`
- Modify: `src/renderer/src/screens/Office/office3d/core/cityPlan.ts`
- Modify: `src/renderer/src/assets/main.css`
- Test: `tests/agentera-visible-branding.test.ts`

**Interfaces:**

- Consumes: shared brand constants, existing i18n keys, approved `iconv2.png`, existing menu and settings composition, and unchanged Hermes runtime calls.
- Produces: AgentEra-branded window/menu/messages/About/sidebar/Office surfaces with inherited promotion unmounted.

- [ ] **Step 1: Extend the focused test with exact composed-surface assertions**

```ts
expect(read("src/main/app/menu.ts")).toContain(
  "https://github.com/bignormal/aera/issues",
);
expect(read("src/renderer/src/screens/Layout/Layout.tsx")).toContain(
  'from "../../assets/iconv2.png"',
);
expect(read("src/renderer/src/components/settings/AboutPane.tsx")).toContain(
  'from "../../assets/iconv2.png"',
);
expect(
  read("src/renderer/src/screens/Chat/hooks/useLocalCommands.ts"),
).toContain("**AgentEra Runtime:**");
expect(
  read("src/renderer/src/screens/Chat/hooks/useLocalCommands.ts"),
).toContain("**AgentEra Studio:**");
expect(
  read("src/renderer/src/screens/Office/office3d/objects/CarShowroom.tsx"),
).toContain("AGENTERA MOTORS");
```

Run: `npm test -- --run tests/agentera-visible-branding.test.ts`

Expected: FAIL on the current menu, sidebar/About assets, local version output, promotion mounts, and 3D labels.

- [ ] **Step 2: Replace desktop-owned icons and titles**

Use `iconv2.png` for the sidebar application mark and desktop card in About. Keep provider-specific logos inside provider rows. Use `AgentEra Studio` for desktop titles and `AgentEra Runtime` for the bundled engine label.

- [ ] **Step 3: Replace user-visible runtime messages only**

Apply this exact display mapping in the listed main/renderer files:

```text
Hermes One (desktop product) -> AgentEra Studio
Hermes Desktop -> AgentEra Studio
Hermes Agent (bundled engine label) -> AgentEra Runtime
Hermes (pronoun for the bundled engine) -> AgentEra Runtime
```

Do not change command tokens, URLs for factual runtime sources, headers, routes, ids, or environment variables. For the Help menu, label the source link `AgentEra Runtime Source` while keeping the factual `NousResearch/hermes-agent` URL; point `Report an Issue` to `https://github.com/bignormal/aera/issues`.

- [ ] **Step 4: Unmount inherited promotion**

Remove the `FollowUsModal` import and rendered element from `Chat.tsx`. Remove the `community` section type, navigation row, `CommunityPane` import, and render branch from `SettingsModal.tsx`. Keep the unreferenced component source files for upstream merge compatibility.

- [ ] **Step 5: Rebrand the Office-owned labels**

Change showroom names from `Hermes S1`/`Hermes GT` to `AgentEra S1`/`AgentEra GT`, change the wall text to `AGENTERA MOTORS`, and use `iconv2.png` for the HQ decal instead of `hermes-one-hq.webp`. Rename only local variables/comments necessary to match the new imported asset; keep geometry and placement unchanged.

- [ ] **Step 6: Run focused and affected renderer tests**

Run: `npm test -- --run tests/agentera-visible-branding.test.ts src/renderer/src/screens/Layout/ProfileSwitcher.test.tsx src/renderer/src/components/settings/useSettingsData.test.tsx`

Expected: composed-surface assertions PASS; locale assertions remain RED until Task 6.

- [ ] **Step 7: Commit the composed UI branding**

```bash
git add src/main/app/menu.ts src/main/hermes.ts src/main/installer.ts src/main/ipc/register.ts src/main/dashboard.ts src/main/mcp-servers.ts src/main/config-health.ts src/main/hermes-agent-compat.ts src/main/claw3d.ts src/renderer/src/screens/Layout/Layout.tsx src/renderer/src/components/settings/AboutPane.tsx src/renderer/src/components/settings/SettingsModal.tsx src/renderer/src/screens/Chat/Chat.tsx src/renderer/src/screens/Chat/ChatInput.tsx src/renderer/src/screens/Chat/hooks/useChatActions.ts src/renderer/src/screens/Chat/hooks/useLocalCommands.ts src/renderer/src/screens/Chat/slash/commandCatalog.ts src/renderer/src/screens/Office/office3d/objects/CarShowroom.tsx src/renderer/src/screens/Office/office3d/objects/OfficeShell.tsx src/renderer/src/screens/Office/office3d/core/cityPlan.ts src/renderer/src/assets/main.css tests/agentera-visible-branding.test.ts
git commit -m "feat: rebrand AgentEra Studio application surfaces"
```

---

### Task 6: Close locale and public-document brand leaks

**Files:**

- Modify: `src/shared/i18n/locales/{ar,en,es,he,id,ja,pl,pt-BR,pt-PT,tr,zh-CN,zh-TW}/*.ts`
- Modify: `src/shared/i18n/index.test.ts`
- Modify: `src/renderer/src/components/I18nProvider.test.tsx`
- Modify: `src/renderer/src/screens/Layout/ProfileSwitcher.test.tsx`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.ja-JP.md`
- Modify: `README.es-LATAM.md`
- Modify: `CONTRIBUTING.md`
- Modify: `CONTRIBUTING.zh-CN.md`
- Modify: `CONTRIBUTING.ja-JP.md`
- Test: `tests/agentera-visible-branding.test.ts`

**Interfaces:**

- Consumes: the twelve existing locale packs and existing documentation structure.
- Produces: exact AgentEra brand tokens in all languages and public docs with no embedded upstream desktop promotions.

- [ ] **Step 1: Update locale test expectations and verify RED**

In `src/shared/i18n/index.test.ts`, use exact expectations:

```ts
expect(t("welcome.title")).toBe("Welcome to AgentEra Studio");
expect(t("welcome.title", "zh-CN")).toBe("欢迎使用 AgentEra Studio");
expect(t("welcome.title", "zh-TW")).toBe("歡迎使用 AgentEra Studio");
expect(t("welcome.title", "es")).toContain("AgentEra Studio");
expect(t("welcome.title", "id")).toContain("AgentEra Studio");
expect(t("welcome.title", "pl")).toContain("AgentEra Studio");
expect(t("welcome.title", "he")).toContain("AgentEra Studio");
```

Update renderer exact-name expectations from `Hermes One` to `AgentEra Studio`.

Run: `npm test -- --run src/shared/i18n/index.test.ts src/renderer/src/components/I18nProvider.test.tsx src/renderer/src/screens/Layout/ProfileSwitcher.test.tsx`

Expected: FAIL on the old translated product names.

- [ ] **Step 2: Apply the locale naming map across all twelve packs**

Use these exact brand tokens without translating them:

```text
desktop application -> AgentEra Studio
parent/project brand -> AgentEra
bundled/local/remote engine -> AgentEra Runtime
```

Replace first-party occurrences in `common.ts`, `welcome.ts`, `settings.ts`, `install.ts`, `chat.ts`, `gateway.ts`, `memory.ts`, `agents.ts`, `office.ts`, `kanban.ts`, `tools.ts`, `errors.ts`, `setup.ts`, and `diagnose.ts`. Preserve literal command/path examples such as `hermes mcp`, `~/.hermes`, `HERMES_*`, `@hermes:matrix.org`, and factual `Hermes One Inference`/`Hermes One account` integration labels.

- [ ] **Step 3: Replace public repository and product documentation branding**

Use `# AgentEra Studio` as the README heading, point source/issues/releases/license links to `bignormal/aera`, describe the visible engine as `AgentEra Runtime`, and keep literal CLI commands as `hermes ...` where compatibility requires them.

Remove README references that embed `assets/header.webp`, `previews/download.webp`, or the pre-rebrand `previews/*.png` screenshots. Replace the download image with a text link to `https://github.com/bignormal/aera/releases`. Do not delete the historical binary files in this task.

Update contribution issue links to `https://github.com/bignormal/aera/issues`. Keep the MIT license and factual upstream/runtime source acknowledgements.

- [ ] **Step 4: Run locale and visible-brand tests**

Run: `npm test -- --run tests/agentera-visible-branding.test.ts src/shared/i18n/index.test.ts src/renderer/src/components/I18nProvider.test.tsx src/renderer/src/screens/Layout/ProfileSwitcher.test.tsx`

Expected: all listed test files PASS with no first-party locale leaks.

- [ ] **Step 5: Run a source-backed residual brand audit**

Run:

```bash
rg -n -i --glob '!node_modules/**' --glob '!out/**' --glob '!dist/**' --glob '!changelogs/**' 'Hermes One|Hermes Desktop|Hermes Agent|Nous Research|fathah' src package.json electron-builder.yml dev-app-update.yml build scripts .github README*.md CONTRIBUTING*.md
```

Expected remaining matches are limited to internal compatibility comments/fixtures, factual third-party provider/account names, literal runtime commands/paths, and factual upstream source URLs. Every remaining executable string literal must match one of the allowlist cases enforced by `tests/agentera-visible-branding.test.ts`.

- [ ] **Step 6: Commit locale and documentation closure**

```bash
git add src/shared/i18n/locales src/shared/i18n/index.test.ts src/renderer/src/components/I18nProvider.test.tsx src/renderer/src/screens/Layout/ProfileSwitcher.test.tsx README.md README.zh-CN.md README.ja-JP.md README.es-LATAM.md CONTRIBUTING.md CONTRIBUTING.zh-CN.md CONTRIBUTING.ja-JP.md tests/agentera-visible-branding.test.ts
git commit -m "docs: close AgentEra visible brand surfaces"
```

---

### Task 7: Verify the complete change and launch the desktop

**Files:**

- Modify: `lat.md/agentera-branding.md` only if implementation names differ from its already approved exact contract.
- Verify: all changed files from Tasks 1-6.

**Interfaces:**

- Consumes: the complete AgentEra Studio branding implementation and existing bypass directory `/Users/zizimutou/Desktop/aera/.hermes-dev-bypass`.
- Produces: fresh evidence for type safety, tests, production code build, knowledge graph validity, clean Git scope, and the live desktop UI.

- [ ] **Step 1: Format changed text files**

Run:

```bash
npx prettier --write $(git diff --name-only --diff-filter=ACM origin/main...HEAD | rg '\.(ts|tsx|js|mjs|json|yaml|yml|md|css)$')
```

Expected: Prettier formats every changed text artifact while leaving binary icons untouched.

- [ ] **Step 2: Run focused gates**

Run: `npm test -- --run tests/agentera-visible-branding.test.ts tests/agentera-icon-assets.test.ts tests/desktop-identity.test.ts tests/winget-generator.test.ts src/renderer/src/screens/SplashScreen/SplashScreen.test.tsx src/shared/i18n/index.test.ts src/renderer/src/components/I18nProvider.test.tsx src/renderer/src/screens/Layout/ProfileSwitcher.test.tsx`

Expected: all focused test files PASS with zero failures.

- [ ] **Step 3: Run full static and test verification**

Run: `npm run typecheck && npm test -- --maxWorkers=1 && npm run build`

Expected: both TypeScript projects, the complete Vitest suite, and the unsigned electron-vite production code build exit 0. Do not run electron-builder, signing, or notarization.

- [ ] **Step 4: Validate repository knowledge and diff hygiene**

Run: `npx --yes lat.md check`

Expected: `All checks passed`.

Run: `git diff --check && git status --short && git diff --stat origin/main...HEAD`

Expected: no whitespace errors; only design/plan documents and intentional branding source/assets/tests are present. Generated logs, databases, `dist/`, `out/`, and local bypass data are absent.

- [ ] **Step 5: Restart the local desktop with isolated state**

Stop only the existing Electron/electron-vite processes whose command line points at `/Users/zizimutou/Desktop/aera/aera`, then run:

```bash
HERMES_HOME=/Users/zizimutou/Desktop/aera/.hermes-dev-bypass \
HERMES_DESKTOP_USER_DATA_DIR=/Users/zizimutou/Desktop/aera/.agentera-studio-brand-check \
npm run dev
```

Keep the new process running for user review.

- [ ] **Step 6: Perform live UI verification**

Using Computer Use, verify these exact visible results:

```text
Splash wordmark: AgentEra Studio
Window title: AgentEra Studio
Sidebar/profile product label: AgentEra Studio
About desktop label: AgentEra Studio
About engine label: AgentEra Runtime
Follow-on-X modal: absent
Upstream community/donation pane: absent
Application icon: approved blue-purple AgentEra icon
```

The local runtime backend may remain unavailable under the download bypass; that is acceptable only if the desktop shell loads and the failure text uses AgentEra Runtime.

- [ ] **Step 7: Report local completion without pushing**

Report the final commit list, focused/full verification counts, build result, live UI result, residual allowed Hermes compatibility categories, and current `git status`. Do not push until the user explicitly requests it.
