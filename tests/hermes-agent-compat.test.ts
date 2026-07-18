import { describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const { TEST_HOME, runtimeRef } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  return {
    TEST_HOME: path.join(os.tmpdir(), `hermes-compat-home-${Date.now()}`),
    runtimeRef: { workingDirectory: "" },
  };
});

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: TEST_HOME,
}));

vi.mock("../src/main/agentera-runtime-distribution/invocation", () => ({
  getRuntimeInvocation: () => ({
    source: "managed",
    version: "test",
    sourceCommit: "0".repeat(40),
    root: runtimeRef.workingDirectory,
    python: `${runtimeRef.workingDirectory}/python3`,
    workingDirectory: runtimeRef.workingDirectory,
    bundledSkillsDirectory: `${runtimeRef.workingDirectory}/skills`,
    webDistDirectory: `${runtimeRef.workingDirectory}/hermes_cli/web_dist`,
    cliArgs: (args: string[] = []) => ["-m", "hermes_cli.main", ...args],
    environment: (base: Record<string, string> = {}) => ({ ...base }),
  }),
}));

import {
  ensureLocalDashboardCompatibility,
  patchDashboardCompatibilitySource,
  patchDashboardEmbeddedChatSource,
  patchDashboardModelLibrarySource,
  writeCompatFileAtomically,
} from "../src/main/hermes-agent-compat";

describe("Hermes Agent dashboard compatibility patcher", () => {
  it("patches the dashboard source selected by the live Runtime invocation", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-runtime-compat-"));
    runtimeRef.workingDirectory = dir;
    const moduleDir = join(dir, "hermes_cli");
    const target = join(moduleDir, "web_server.py");
    try {
      // The temp tree keeps this probe away from every real Hermes install.
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        target,
        `async def start_server(embedded_chat: bool = True):\n    pass\n\n@app.post("/api/model/set")\nasync def set_model_assignment(body):\n    return {"ok": True}\n\nmount_spa(app)\n`,
        "utf-8",
      );

      const result = ensureLocalDashboardCompatibility();

      expect(result.ok).toBe(true);
      expect(result.path).toBe(target);
      expect(readFileSync(target, "utf-8")).toContain(
        "HERMES_ONE_MODEL_LIBRARY_COMPAT_V1",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  it("leaves already-compatible embedded chat defaults unchanged", () => {
    const source = `
async def start_server(
    host: str = "127.0.0.1",
    embedded_chat: bool = True,
):
    pass
`;

    const result = patchDashboardEmbeddedChatSource(source);

    expect(result.compatible).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.source).toBe(source);
  });

  it("recognizes current upstream always-on dashboard chat as compatible", () => {
    const source = `
# In-browser Chat tab (/chat, /api/pty, /api/ws, ...). Always enabled.
_DASHBOARD_EMBEDDED_CHAT_ENABLED = True

def start_server(
    host: str = "127.0.0.1",
    port: int = 9119,
    open_browser: bool = True,
    allow_public: bool = False,
):
    pass
`;

    const result = patchDashboardEmbeddedChatSource(source);

    expect(result.compatible).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.source).toBe(source);
  });

  it("patches older embedded chat defaults", () => {
    const source = `
async def start_server(
    host: str = "127.0.0.1",
    embedded_chat: bool = False,
):
    pass
`;

    const result = patchDashboardEmbeddedChatSource(source);

    expect(result.compatible).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.source).toContain("embedded_chat: bool = True");
    expect(result.source).not.toContain("embedded_chat: bool = False");
  });

  it("reports incompatible source instead of making an unsafe edit", () => {
    const source = "async def start_server(): pass";

    const result = patchDashboardEmbeddedChatSource(source);

    expect(result.compatible).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.source).toBe(source);
  });

  it("installs the Hermes One configured model library endpoint when model REST exists", () => {
    const source = `
@app.post("/api/model/set")
async def set_model_assignment(body):
    return {"ok": True}

mount_spa(app)
`;

    const result = patchDashboardModelLibrarySource(source);

    expect(result.compatible).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.source).toContain("HERMES_ONE_MODEL_LIBRARY_COMPAT_V1");
    expect(result.source).toContain('@app.get("/api/model/library")');
    expect(result.source).toContain('@app.post("/api/model/library")');
    expect(result.source).toContain(
      '@app.patch("/api/model/library/{model_id:path}")',
    );
    expect(result.source).toContain(
      '@app.delete("/api/model/library/{model_id:path}")',
    );
    expect(
      result.source.indexOf('@app.get("/api/model/library")'),
    ).toBeLessThan(result.source.indexOf("mount_spa(app)"));
  });

  it("does not install the model library endpoint twice", () => {
    const source = `
@app.post("/api/model/set")
async def set_model_assignment(body):
    return {"ok": True}

mount_spa(app)
`;

    const installed = patchDashboardModelLibrarySource(source);
    const result = patchDashboardModelLibrarySource(installed.source);

    expect(result.compatible).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.source).toBe(installed.source);
  });

  it("moves a previously appended model library endpoint before the dashboard catch-all", () => {
    const source = `
@app.post("/api/model/set")
async def set_model_assignment(body):
    return {"ok": True}

mount_spa(app)

# --- HERMES_ONE_MODEL_LIBRARY_COMPAT_V1 -------------------------------------
@app.get("/api/model/library")
def hermes_one_get_model_library():
    return {"models": []}
# --- /HERMES_ONE_MODEL_LIBRARY_COMPAT_V1 ------------------------------------
`;

    const result = patchDashboardModelLibrarySource(source);

    expect(result.compatible).toBe(true);
    expect(result.changed).toBe(true);
    expect(
      result.source.indexOf('@app.get("/api/model/library")'),
    ).toBeLessThan(result.source.indexOf("mount_spa(app)"));
    expect(result.detail).toContain("Moved");
  });

  it("applies all safe dashboard compatibility patches together", () => {
    const source = `
async def start_server(
    host: str = "127.0.0.1",
    embedded_chat: bool = False,
):
    pass

@app.post("/api/model/set")
async def set_model_assignment(body):
    return {"ok": True}

mount_spa(app)
`;

    const result = patchDashboardCompatibilitySource(source);

    expect(result.compatible).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.source).toContain("embedded_chat: bool = True");
    expect(result.source).toContain("HERMES_ONE_MODEL_LIBRARY_COMPAT_V1");
  });

  it("writes patched local source through a temp file and keeps a first-run backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-compat-"));
    try {
      const target = join(dir, "web_server.py");
      writeFileSync(target, "original", "utf-8");

      writeCompatFileAtomically(target, "patched");

      expect(readFileSync(target, "utf-8")).toBe("patched");
      expect(readFileSync(`${target}.orig`, "utf-8")).toBe("original");
      expect(
        readdirSync(dir).filter((name) => name.includes(".hermes-one-")),
      ).toEqual([]);

      writeCompatFileAtomically(target, "patched-again");

      expect(readFileSync(target, "utf-8")).toBe("patched-again");
      expect(readFileSync(`${target}.orig`, "utf-8")).toBe("original");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
