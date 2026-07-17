# AgentEra Hermes Compatibility Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish Project 1's release-blocking Hermes compatibility baseline, stop the imported desktop from transferring `MEMORY.md`, and record the one-installation/one-Profile/one-`HERMES_HOME` contract without changing Hermes's native learning behavior.

**Architecture:** Keep Hermes Runtime behavior untouched and add an AgentEra-owned compatibility runner around existing upstream behavioral tests. In the desktop, narrow the legacy profile reconciler from four parts to three (`color`, `SOUL.md`, and model/provider), filter obsolete Memory hashes out of legacy state files, and remove the only whole-file Memory replacement helpers. A reusable CI workflow makes the Runtime compatibility runner a required repository check; future Runtime-seed packaging must invoke the same runner before producing artifacts.

**Tech Stack:** Electron 39, TypeScript 5.9, Vitest 4, Node.js 22, Hermes Agent Python 3.11, pytest 9 through `scripts/run_tests.sh`, Bash, GitHub Actions, uv, lat.md.

## Global Constraints

- This plan covers only Project 1 from `docs/superpowers/specs/2026-07-17-agentera-hermes-compatible-self-evolution-architecture-design.md`.
- Do not implement login, personal space, immutable Agent versions, RuntimeBinding persistence, candidate promotion, workspace, organization, backup, or cross-device Memory transfer in this plan.
- Do not modify Hermes Runtime production modules. Runtime changes are limited to an AgentEra compatibility runner, its documentation, and CI wiring.
- The Runtime gate must execute real behavioral tests; it must not inspect source text, freeze enumerations, or assert implementation shape.
- Preserve Hermes prompt byte stability, Memory snapshot semantics, background review isolation, Profile isolation, skill provenance, Curator pin/archive/recovery, and default offline local operation.
- `MEMORY.md`, `USER.md`, sessions, files, credentials, and unpromoted skills remain local. Existing local files must not be rewritten, migrated, renamed, uploaded, or deleted.
- The desktop may continue synchronizing color, `SOUL.md`, and model/provider during Project 1. Project 2 will replace that mutable profile reconciliation with immutable Agent version semantics.
- Keep `cloud-sync.json` at version `1`; filter its obsolete `base.memory` entry during a normal successful pass so existing links remain usable without a destructive migration.
- Keep the backend's `memory` response field compatible but ignore it in the desktop. Do not require a backend schema migration for Project 1.
- Work in the two real repositories only: `/Users/zizimutou/Desktop/aera/aera` and `/Users/zizimutou/Desktop/aera/aera-runtime`.
- Do not stage `/Users/zizimutou/Desktop/aera/aera/lat.md/.cache/vectors.db` or any generated local state.
- Keep desktop and Runtime commits separate. Do not push, publish, tag, package, or deploy during this plan.

---

### Task 1: Lock the private-Memory cloud boundary with failing desktop tests

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agent-sync.test.ts`

**Interfaces:**

- Consumes: `buildPushBody()`, `syncAgents()`, legacy `cloud-sync.json`, mocked `/api/agents` responses containing `memory`.
- Produces: a RED contract proving that local Memory is not uploaded, remote Memory is not applied, and obsolete `base.memory` hashes are removed without touching the Memory file.

- [ ] **Step 1: Create the desktop implementation branch without touching generated state**

Run:

```bash
cd /Users/zizimutou/Desktop/aera/aera
git switch -c aera/hermes-compatibility-foundation
git status --short --branch
npx --yes lat.md search "private Memory cloud sync Hermes compatibility"
npx --yes lat.md expand "Disable [[agent-sync]] Memory transfer while preserving [[agentera-self-evolution]]"
```

Expected: the new branch contains the approved specification commits, LAT resolves `agent-sync` and `agentera-self-evolution`, and the untracked paths are this implementation plan and the pre-existing `lat.md/.cache/vectors.db`. If semantic search lacks a configured key, run `npx --yes lat.md locate "Legacy sync containment"` and continue with the resolved sections.

- [ ] **Step 2: Narrow the pure push-body expectations**

Replace the `values` fixture and the two `buildPushBody` tests with:

```ts
describe("buildPushBody", () => {
  const values = {
    color: "#abcdef",
    soul: "persona",
    config: { model: "m1", provider: "openai" },
  };

  // @lat: [[agent-sync#Tests#Push bodies stay within limits]]
  it("maps supported parts to backend fields and nothing else", async () => {
    const { buildPushBody } = await engine();
    const { body, skipped } = buildPushBody(
      ["color", "soul", "config"],
      values,
    );
    expect(body).toEqual({
      color: "#abcdef",
      systemPrompt: "persona",
      model: "m1",
      provider: "openai",
    });
    expect(body).not.toHaveProperty("memory");
    expect(skipped).toEqual([]);
  });

  it("skips an oversize persona and unset model instead of truncating", async () => {
    const { buildPushBody } = await engine();
    const { body, skipped } = buildPushBody(["soul", "config"], {
      ...values,
      soul: "x".repeat(20001),
      config: { model: "", provider: "auto" },
    });
    expect(body).toEqual({});
    expect(skipped).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Make local-profile backup reject Memory payloads**

In `creates a cloud agent for a never-synced local profile`, retain the private local sentinel and replace the POST assertion with:

```ts
mockState.memories.set("alpha", "private-memory-must-stay-local");

const post = calls.find((call) => call.method === "POST");
expect(post?.body).toMatchObject({
  name: "alpha",
  systemPrompt: "soul-a",
  model: "m1",
  color: "#123456",
});
expect(post?.body).not.toHaveProperty("memory");
```

- [ ] **Step 4: Add a bidirectional Memory exclusion test**

Add this test inside `describe("syncAgents")`:

```ts
// @lat: [[agent-sync#Tests#Never syncs private Memory]]
it("never transfers MEMORY.md in either direction", async () => {
  mockState.profiles = [fakeProfile("alpha")];
  mockState.memories.set("alpha", "private-local-memory");
  mockState.models.set("alpha", {
    model: "m1",
    provider: "auto",
    baseUrl: "",
  });

  const memoryFile = join(
    mockState.home,
    "profiles",
    "alpha",
    "memories",
    "MEMORY.md",
  );
  mkdirSync(dirname(memoryFile), { recursive: true });
  writeFileSync(memoryFile, "private-local-memory", "utf-8");

  const calls = stubFetch([
    remoteAgent({
      id: "agent-1",
      name: "alpha",
      memory: "remote-memory-must-be-ignored",
      model: "m1",
      updatedAt: "1970-01-01T00:00:00.000Z",
    }),
  ]);

  const { syncAgents } = await engine();
  const result = await syncAgents();

  expect(result.status).toBe("ok");
  for (const call of calls.filter((entry) => entry.body !== undefined)) {
    expect(call.body).not.toHaveProperty("memory");
  }
  expect(mockState.writtenMemories).toEqual([]);
});
```

This is the primary RED test: the current implementation attempts to PATCH the newer local Memory value.

- [ ] **Step 5: Turn existing pull cases into Memory tripwires**

In `links an unmapped profile to its namesake and pulls newer cloud parts`, retain `memory: "cloud-mem"` in the mock response but replace the Memory-write expectation with:

```ts
expect(mockState.writtenMemories).toEqual([]);
```

In `creates a local profile for a cloud-only agent`, add `memory: "cloud-only-private-memory"` to the remote fixture and add:

```ts
expect(mockState.writtenMemories).toEqual([]);
```

- [ ] **Step 6: Add the backward-compatible state cleanup test**

Add this test inside `describe("syncAgents")`:

```ts
it("drops a legacy Memory base hash without touching Memory", async () => {
  mockState.profiles = [fakeProfile("beta")];
  mockState.models.set("beta", {
    model: "m1",
    provider: "auto",
    baseUrl: "",
  });
  const stateFile = join(mockState.home, "profiles", "beta", "cloud-sync.json");
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      agentId: "a1",
      accountId: "u1",
      remoteName: "beta",
      base: { memory: "legacy-memory-hash" },
    }),
    "utf-8",
  );
  stubFetch([
    remoteAgent({
      id: "a1",
      name: "beta",
      memory: "remote-private",
      model: "m1",
    }),
  ]);

  const { syncAgents } = await engine();
  const result = await syncAgents();

  expect(result.status).toBe("ok");
  const state = JSON.parse(readFileSync(stateFile, "utf-8"));
  expect(state.version).toBe(1);
  expect(state.base).not.toHaveProperty("memory");
  expect(mockState.writtenMemories).toEqual([]);
});
```

- [ ] **Step 7: Run the focused tests to verify RED**

Run:

```bash
npm test -- src/main/agent-sync.test.ts
```

Expected: failures show that the current implementation uploads local Memory, applies remote Memory, and retains `base.memory`. Unrelated agent-sync tests remain green.

- [ ] **Step 8: Commit the failing contract**

Run:

```bash
git add src/main/agent-sync.test.ts
git commit -m "test: keep Hermes adaptive Memory local"
```

Expected: one test-only commit; `lat.md/.cache/vectors.db` remains untracked.

### Task 2: Remove Memory from legacy profile reconciliation

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agent-sync.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/memory.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agent-sync.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-self-evolution.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/lat.md`

**Interfaces:**

- Consumes: legacy `/api/agents` data and version-1 `cloud-sync.json` files.
- Produces: three-part profile synchronization, ignored backend Memory fields, sanitized state hashes, and no main-process API capable of replacing `MEMORY.md` wholesale.

- [ ] **Step 1: Remove Memory from the sync type contract**

Delete the `./memory` import and replace the sync types/constants with:

```ts
const MAX_SOUL_CHARS = 20000;
const MAX_NAME_CHARS = 80;

export type SyncPart = "color" | "soul" | "config";
const PARTS: SyncPart[] = ["color", "soul", "config"];

const STATE_FILE = "cloud-sync.json";

interface SyncState {
  version: 1;
  agentId: string;
  accountId?: string;
  remoteName: string;
  base: Partial<Record<SyncPart, string>>;
}

interface RemoteAgent {
  id: string;
  name: string;
  color: string;
  systemPrompt: string | null;
  model: string;
  provider: string;
  updatedAt: string;
}

interface PartValues {
  color: string;
  soul: string;
  config: { model: string; provider: string };
}
```

Keep the existing explanatory comments on account ownership and stable IDs, but change references to “persona/memory” into “profile settings.”

- [ ] **Step 2: Restrict outbound bodies to the three supported parts**

Replace `buildPushBody()` with:

```ts
export function buildPushBody(
  parts: SyncPart[],
  values: PartValues,
): { body: Record<string, unknown>; skipped: string[] } {
  const body: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const part of parts) {
    switch (part) {
      case "color":
        body.color = values.color;
        break;
      case "soul":
        if (values.soul.length > MAX_SOUL_CHARS) {
          skipped.push(
            `persona (SOUL.md) is ${values.soul.length} chars — over the ${MAX_SOUL_CHARS} cloud limit, not pushed`,
          );
        } else {
          body.systemPrompt = values.soul || null;
        }
        break;
      case "config":
        if (values.config.model) {
          body.model = values.config.model;
          body.provider = values.config.provider || "auto";
        } else {
          skipped.push("model is not configured locally — config not pushed");
        }
        break;
    }
  }
  return { body, skipped };
}
```

Update its comment to say “three synced parts” and explicitly state that private Memory and `USER.md` are excluded.

- [ ] **Step 3: Sanitize legacy state without changing its version**

Add this helper immediately before `readSyncState()`:

```ts
function sanitizeBase(base: Record<string, unknown>): SyncState["base"] {
  const sanitized: SyncState["base"] = {};
  for (const part of PARTS) {
    const value = base[part];
    if (typeof value === "string") sanitized[part] = value;
  }
  return sanitized;
}
```

In `readSyncState()`, replace `base: parsed.base` with:

```ts
base: sanitizeBase(parsed.base as Record<string, unknown>),
```

Do not read or write `MEMORY.md` while cleaning the state. The next successful state write naturally drops `base.memory` and preserves version `1`, agent linkage, account ownership, and current-part hashes.

- [ ] **Step 4: Remove Memory from local/remote snapshots and hashes**

Replace the four snapshot helpers with:

```ts
function localPartValues(profile: ProfileInfo): PartValues {
  const cfg = getModelConfig(profile.id);
  return {
    color: profile.color,
    soul: readSoul(profile.id),
    config: { model: cfg.model, provider: cfg.provider || "auto" },
  };
}

function localPartMtimes(profile: ProfileInfo): Record<SyncPart, number> {
  const home = profile.path;
  return {
    color: mtimeMs(join(home, "profile-meta.json")),
    soul: mtimeMs(join(home, "SOUL.md")),
    config: mtimeMs(join(home, "config.yaml")),
  };
}

function remotePartValues(agent: RemoteAgent): PartValues {
  return {
    color: agent.color,
    soul: agent.systemPrompt ?? "",
    config: { model: agent.model, provider: agent.provider || "auto" },
  };
}

function partHashes(values: PartValues): Record<SyncPart, string> {
  return {
    color: hashPart(values.color),
    soul: hashPart(values.soul),
    config: hashPart(values.config),
  };
}
```

- [ ] **Step 5: Remove the whole-file pull route**

Replace `applyPull()` with:

```ts
function applyPull(
  profileName: string,
  part: SyncPart,
  remote: PartValues,
): void {
  switch (part) {
    case "color":
      void setProfileColor(profileName, remote.color);
      break;
    case "soul":
      writeSoul(remote.soul, profileName);
      break;
    case "config": {
      if (!remote.config.model) break;
      const current = getModelConfig(profileName);
      setModelConfig(
        remote.config.provider || "auto",
        remote.config.model,
        current.baseUrl,
        profileName,
      );
      break;
    }
  }
}
```

Replace `isPartSkipped()` with:

```ts
function isPartSkipped(part: SyncPart, values: PartValues): boolean {
  if (part === "soul") return values.soul.length > MAX_SOUL_CHARS;
  if (part === "config") return !values.config.model;
  return false;
}
```

All existing reconciliation loops continue iterating over `PARTS`, so PATCH, POST, linked pulls, and cloud-only profile creation automatically exclude Memory.

- [ ] **Step 6: Delete the two whole-file Memory helpers**

Delete this exact block from `src/main/memory.ts`:

```ts
/** Raw MEMORY.md content (empty string when missing) — for whole-file sync. */
export function readMemoryRaw(profile?: string): string {
  return readFileSafe(memoryPath(profile)).content;
}

/**
 * Replace MEMORY.md wholesale. Used by cloud agent sync when the remote copy
 * wins — the content is the user's own cloud copy, so no entry parsing or
 * char-limit gate applies (safeWriteFile creates `memories/` when missing).
 */
export function writeMemoryRaw(
  content: string,
  profile?: string,
): { success: boolean; error?: string } {
  try {
    safeWriteFile(memoryPath(profile), content);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
```

Keep all entry-level Memory UI operations unchanged.

- [ ] **Step 7: Run focused tests and node type checking to verify GREEN**

Run:

```bash
npm test -- src/main/agent-sync.test.ts
npm run typecheck:node
rg -n "readMemoryRaw|writeMemoryRaw|MAX_MEMORY_CHARS|body\.memory|case \"memory\"" src/main/agent-sync.ts src/main/memory.ts
```

Expected: the focused tests and type checking pass. The final `rg` command exits `1` with no matches; that exit code is expected because the prohibited sync route is gone.

- [ ] **Step 8: Update the lat.md behavior and test contract**

In `lat.md/agent-sync.md`:

- Change Phase 1 to `color`, persona (`SOUL.md`), and model/provider only.
- State that `MEMORY.md` and `USER.md` are private Runtime state and never enter push bodies, pull application, conflict hashes, or cloud-only profile materialization.
- Remove `readMemoryRaw` and `writeMemoryRaw` links.
- Change “four parts” to “three supported parts.”
- Add this test section:

```md
### Never syncs private Memory

Local `MEMORY.md` content never appears in POST or PATCH bodies, remote `memory` fields never write to disk, and legacy `base.memory` hashes are discarded without changing the Memory file.
```

In `lat.md/agentera-self-evolution.md`, replace the Legacy sync containment paragraph with:

```md
## Legacy sync containment

The imported profile reconciler excludes `MEMORY.md` from upload, download, conflict hashes, and cloud-only profile creation, and no longer exposes a whole-file Memory replacement helper.

Color, SOUL, and model/provider remain in the transitional reconciler until immutable Agent version installation replaces it in Project 2.
```

In `lat.md/lat.md`, change the `[[agent-sync]]` description to:

```md
- [[agent-sync]] — transitional bidirectional sync of desktop profiles with cloud agents for persona, color, and model/provider; private `MEMORY.md` and `USER.md` are excluded.
```

- [ ] **Step 9: Validate LAT and the full desktop repository**

Run:

```bash
npx --yes lat.md check
npm run typecheck
npm test -- --maxWorkers=1
npm run build
git diff --check
```

Expected: LAT links, both TypeScript projects, all Vitest tests, the production build, and whitespace checks pass.

- [ ] **Step 10: Commit desktop containment**

Run:

```bash
git add src/main/agent-sync.ts src/main/memory.ts src/main/agent-sync.test.ts lat.md/agent-sync.md lat.md/agentera-self-evolution.md lat.md/lat.md
git commit -m "fix: isolate Hermes adaptive Memory from cloud sync"
git status --short
```

Expected: this implementation plan and `lat.md/.cache/vectors.db` remain untracked.

### Task 3: Record the Runtime/Profile mapping contract

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/docs/agentera-runtime-profile-contract.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-self-evolution.md`
- Add to commit: `/Users/zizimutou/Desktop/aera/aera/docs/superpowers/plans/2026-07-17-agentera-hermes-compatibility-foundation.md`

**Interfaces:**

- Consumes: AgentEra owner/installation identities and Hermes's physical `HERMES_HOME` boundary.
- Produces: a normative handoff contract for Projects 2–5, without adding a speculative database schema or Runtime hook.

- [ ] **Step 1: Add the normative mapping document**

Create `docs/agentera-runtime-profile-contract.md` with this complete content:

````md
# AgentEra Runtime Profile Mapping Contract

Status: normative for every AgentEra desktop and bundled Runtime release.

## Core invariant

Every runnable Agent installation owns exactly one writable Hermes Profile, and that Profile resolves to exactly one physical `HERMES_HOME` directory.

Database ownership fields do not replace filesystem isolation. Two installations must never share writable Memory, USER data, skills, sessions, credentials, Curator state, gateway state, cron state, logs, caches, or local workspace files.

## Identity tuple

The minimum binding identity is:

```text
tenant_id / owner_scope / owner_id / installation_id / runtime_profile_id
```
````

`runtime_profile_id` is an AgentEra identifier for one physical Hermes Profile. The local mapping from that identifier to a path is device-scoped and is never inferred only from an editable display name.

## Ownership rules

1. One installation maps to one `runtime_profile_id` on a device.
2. One `runtime_profile_id` maps to one writable `HERMES_HOME` path.
3. A writable `HERMES_HOME` belongs to only one installation identity tuple.
4. A conversation or isolated job binds to one Runtime Profile at start and does not switch Profiles mid-run.
5. Published Agent versions and approved shared knowledge are read-only inputs; they do not become another writer to the Profile's private directories.
6. Generic Hermes Profile clone may be used only for deliberate same-owner duplication. Cross-owner publication must not clone credentials, Memory, USER data, sessions, files, local skills, or Curator state.

## Private writable state

The following paths are installation-private even if a cloud Agent definition is shared:

- `memories/MEMORY.md`
- `memories/USER.md`
- `skills/` and skill provenance state
- session databases and session exports
- credentials and provider configuration
- Curator state, archives, and backups
- gateway, cron, logs, caches, and local workspace state

AgentEra cloud does not reconcile these paths. Optional encrypted backup is a separate later product with explicit user control.

## Lifecycle rules

- Creation allocates a new empty or explicitly same-owner-cloned Profile before the installation becomes runnable.
- Conversation start resolves the installation to its fixed Runtime Profile and snapshots the allowed Agent version and policy.
- Agent version update stages read-only version assets outside private writable state and affects a new conversation only.
- Sign-out, offline expiry, failed cloud sync, or failed candidate upload never deletes or resets the Profile.
- Installation removal requires an explicit local-data retention or deletion decision; cloud deletion alone does not erase the Profile.

## Project 1 enforcement

Project 1 enforces the parts possible before Installation and RuntimeBinding exist:

- the desktop no longer transfers or replaces `MEMORY.md`;
- obsolete Memory sync hashes are removed without touching local adaptive state;
- the Runtime compatibility gate proves Hermes prompt, learning, review, skill, Curator, and Profile invariants;
- Projects 2 and 3 must implement the identity tuple and lifecycle without weakening this contract.

````

- [ ] **Step 2: Link the normative contract from LAT**

Append this sentence to the `Runtime isolation` section in `lat.md/agentera-self-evolution.md`:

```md
The normative lifecycle and path-ownership rules are recorded in `docs/agentera-runtime-profile-contract.md` for every later installation and binding implementation.
````

- [ ] **Step 3: Validate and commit the contract**

Run:

```bash
npx --yes lat.md check
git diff --check
git add docs/agentera-runtime-profile-contract.md lat.md/agentera-self-evolution.md docs/superpowers/plans/2026-07-17-agentera-hermes-compatibility-foundation.md
git commit -m "docs: fix the AgentEra Runtime Profile boundary"
```

Expected: LAT and whitespace checks pass; the commit contains documentation only.

### Task 4: Add the AgentEra Runtime compatibility runner

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/scripts/run_agentera_compatibility.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/docs/agentera-compatibility-gate.md`

**Interfaces:**

- Consumes: the canonical Hermes `scripts/run_tests.sh` and existing upstream behavioral tests.
- Produces: one stable command that validates the Hermes invariants AgentEra is forbidden to break, without modifying Runtime production code.

- [ ] **Step 1: Create the Runtime implementation branch**

Run:

```bash
cd /Users/zizimutou/Desktop/aera/aera-runtime
git switch -c aera/hermes-compatibility-gate
git status --short --branch
```

Expected: a clean branch based on `origin/main` at the current imported Hermes baseline.

- [ ] **Step 2: Add the compatibility runner**

Create `scripts/run_agentera_compatibility.sh` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

exec "$REPO_ROOT/scripts/run_tests.sh" \
  tests/agent/test_system_prompt_restore.py \
  tests/tools/test_memory_tool.py \
  tests/run_agent/test_background_review.py \
  tests/run_agent/test_background_review_cache_parity.py \
  tests/run_agent/test_background_review_toolset_restriction.py \
  tests/test_background_review_session_isolation.py \
  tests/test_profile_isolation_runtime.py \
  tests/agent/test_file_safety_cross_profile.py \
  tests/tools/test_skill_manager_tool.py \
  tests/agent/test_curator.py \
  tests/agent/test_curator_backup.py \
  "$@"
```

Make it executable:

```bash
chmod +x scripts/run_agentera_compatibility.sh
```

The runner intentionally selects whole behavioral files rather than fragile test-node names. Upstream may refactor implementations, but removal or failure of an invariant remains visible.

- [ ] **Step 3: Document the gate and its coverage**

Create `docs/agentera-compatibility-gate.md` with:

````md
# AgentEra Hermes Compatibility Gate

AgentEra Runtime releases must preserve Hermes's native self-learning and Profile behavior. This gate is required even when AgentEra-owned account, branding, cloud, or policy tests pass.

## Command

Run from the Runtime repository root:

```bash
scripts/run_agentera_compatibility.sh -j 4 -q
```
````

The script delegates to the repository's canonical hermetic `scripts/run_tests.sh`; it does not call pytest directly and does not expose local API credentials.

## Covered invariants

| Invariant                                                                                         | Behavioral test files                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored system prompts remain byte-stable across a conversation                                    | `tests/agent/test_system_prompt_restore.py`                                                                                                                                                                                 |
| Mid-session Memory writes stay out of the active prompt and are durable for a later load          | `tests/tools/test_memory_tool.py`                                                                                                                                                                                           |
| Background review keeps the parent prompt/tool contract and cannot pollute the foreground session | `tests/run_agent/test_background_review.py`, `tests/run_agent/test_background_review_cache_parity.py`, `tests/run_agent/test_background_review_toolset_restriction.py`, `tests/test_background_review_session_isolation.py` |
| Profile paths and worker context remain physically isolated                                       | `tests/test_profile_isolation_runtime.py`, `tests/agent/test_file_safety_cross_profile.py`                                                                                                                                  |
| Learned skills retain provenance and protected/external skills fail closed                        | `tests/tools/test_skill_manager_tool.py`                                                                                                                                                                                    |
| Curator preserves pinning, recoverable archive, backup, and rollback behavior                     | `tests/agent/test_curator.py`, `tests/agent/test_curator_backup.py`                                                                                                                                                         |

## Release rule

A failure blocks the AgentEra Runtime seed or update. The failing invariant must be fixed or the Runtime candidate rejected; the gate list must not be weakened to make a release pass.

Future AgentEra packaging workflows must call this command before constructing, signing, or uploading a Runtime seed. Projects that add version installation, offline entitlement, or migrations must add their behavioral coverage to this same gate.

## Scope

This Project 1 gate proves the current Hermes baseline and contains legacy desktop Memory sync. It does not claim that AgentEra Installation, RuntimeBinding, seven-day entitlement, version migration, or candidate promotion already exist.

````

- [ ] **Step 4: Prepare the local hermetic test environment if absent**

Run:

```bash
test -x .venv/bin/python || uv sync --locked --python 3.11 --extra dev
````

Expected: `.venv/bin/python` exists and imports pytest. This creates only ignored development-environment files.

- [ ] **Step 5: Execute the compatibility baseline**

Run:

```bash
scripts/run_agentera_compatibility.sh -j 4 -q
```

Expected: every selected behavioral file passes with no failed or errored tests. Any failure is a Project 1 blocker; do not remove the failing file from the runner.

- [ ] **Step 6: Prove Runtime production code is unchanged**

Run:

```bash
git diff --name-only -- . ':!scripts/run_agentera_compatibility.sh' ':!docs/agentera-compatibility-gate.md'
```

Expected: no output.

- [ ] **Step 7: Commit the runner and contract**

Run:

```bash
git add scripts/run_agentera_compatibility.sh docs/agentera-compatibility-gate.md
git commit -m "test: add AgentEra Hermes compatibility gate"
```

### Task 5: Make the compatibility gate a required Runtime CI result

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/.github/workflows/agentera-compatibility.yml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-runtime/.github/workflows/ci.yml`

**Interfaces:**

- Consumes: GitHub Actions `workflow_call`, uv's locked Python environment, and `scripts/run_agentera_compatibility.sh`.
- Produces: a named compatibility workflow whose failure propagates into `all-checks-pass`, preventing a green Runtime branch from bypassing Hermes invariants.

- [ ] **Step 1: Add the reusable workflow**

Create `.github/workflows/agentera-compatibility.yml` with:

```yaml
name: AgentEra Compatibility

on:
  workflow_call:

permissions:
  contents: read

jobs:
  compatibility:
    name: Hermes core invariants
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout code
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - name: Install uv
        uses: astral-sh/setup-uv@fac544c07dec837d0ccb6301d7b5580bf5edae39 # 8.2.0
        with:
          enable-cache: true
          cache-dependency-glob: |
            pyproject.toml
            uv.lock

      - name: Set up Python 3.11
        run: uv python install 3.11

      - name: Install locked dependencies
        uses: ./.github/actions/retry
        with:
          command: uv sync --locked --python 3.11 --extra all --extra dev

      - name: Run AgentEra compatibility gate
        run: scripts/run_agentera_compatibility.sh -j 4 -q
        env:
          OPENROUTER_API_KEY: ""
          OPENAI_API_KEY: ""
          NOUS_API_KEY: ""
```

- [ ] **Step 2: Call the workflow from the CI orchestrator**

Add this job after the existing Python test job in `.github/workflows/ci.yml`:

```yaml
agentera-compatibility:
  name: AgentEra compatibility
  needs: detect
  if: needs.detect.outputs.python == 'true' || needs.detect.outputs.ci_review == 'true'
  uses: ./.github/workflows/agentera-compatibility.yml
```

Add `agentera-compatibility` to the `all-checks-pass.needs` list:

```yaml
- agentera-compatibility
```

Keep skipped jobs accepted by the existing aggregator. Python changes, Runtime gate changes, and workflow-review changes run the gate; unrelated documentation-only changes may skip it.

- [ ] **Step 3: Parse both workflow files and verify change classification**

Run:

```bash
.venv/bin/python -c 'from pathlib import Path; import yaml; paths = [Path(".github/workflows/ci.yml"), Path(".github/workflows/agentera-compatibility.yml")]; [yaml.safe_load(path.read_text(encoding="utf-8")) for path in paths]; print("workflow YAML parsed")'
scripts/run_tests.sh tests/ci/test_classify_changes.py -q
git diff --check
```

Expected: `workflow YAML parsed`, the classifier tests pass, and the diff has no whitespace errors.

- [ ] **Step 4: Re-run the required compatibility command**

Run:

```bash
scripts/run_agentera_compatibility.sh -j 4 -q
```

Expected: all selected Hermes behavioral tests pass.

- [ ] **Step 5: Commit CI enforcement**

Run:

```bash
git add .github/workflows/agentera-compatibility.yml .github/workflows/ci.yml
git commit -m "ci: require Hermes compatibility for AgentEra Runtime"
```

### Task 6: Perform final cross-repository acceptance

**Files:**

- Verify: `/Users/zizimutou/Desktop/aera/aera`
- Verify: `/Users/zizimutou/Desktop/aera/aera-runtime`

**Interfaces:**

- Consumes: the desktop Memory-containment tests, LAT graph, Runtime compatibility runner, CI aggregator, and both Git worktrees.
- Produces: evidence that Project 1 is complete, scoped, reviewable, and ready for an explicit push decision.

- [ ] **Step 1: Verify the desktop repository from its root**

Run:

```bash
cd /Users/zizimutou/Desktop/aera/aera
npm test -- src/main/agent-sync.test.ts
npm run typecheck
npm test -- --maxWorkers=1
npm run build
npx --yes lat.md check
git diff --check
git log -5 --oneline --decorate
git status --short --branch
```

Expected: every command passes; the branch contains the RED test commit, containment commit, and mapping-contract commit. `lat.md/.cache/vectors.db` is the only untracked path.

- [ ] **Step 2: Verify the Runtime repository from its root**

Run:

```bash
cd /Users/zizimutou/Desktop/aera/aera-runtime
scripts/run_agentera_compatibility.sh -j 4 -q
scripts/run_tests.sh tests/ci/test_classify_changes.py -q
git diff --check
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- . ':!scripts/run_agentera_compatibility.sh' ':!docs/agentera-compatibility-gate.md' ':!.github/workflows/agentera-compatibility.yml' ':!.github/workflows/ci.yml'
git log -4 --oneline --decorate
git status --short --branch
```

Expected: tests pass, the excluded-path diff is empty, and the Runtime branch contains only runner, documentation, and CI changes.

- [ ] **Step 3: Review the immutable Project 1 acceptance checklist**

Confirm all statements are true:

- Desktop POST and PATCH bodies never contain `memory`.
- Remote `memory` values never call a local Memory writer.
- Cloud-only Agent materialization never writes Memory.
- Legacy `base.memory` is dropped while `cloud-sync.json` version and linkage remain intact.
- Existing `MEMORY.md` and `USER.md` files are byte-untouched by migration.
- No `readMemoryRaw` or `writeMemoryRaw` whole-file sync API remains.
- Runtime production Python code is unchanged.
- The Runtime compatibility runner covers prompt stability, Memory durability, background review, Profile isolation, skill provenance, and Curator recovery.
- The compatibility workflow is included in `all-checks-pass`.
- No login, tenant, immutable version, candidate, workspace, organization, backup, or deployment code entered Project 1.

- [ ] **Step 4: Stop before external side effects**

Report both branch names, commit SHAs, test evidence, and remaining untracked files. Ask for separate authorization before pushing either repository or beginning Project 2.
