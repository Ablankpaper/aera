# AgentEra Runtime Bundled Distribution Implementation Plan

> **Execution rule:** Use `superpowers:executing-plans` in the primary/main Codex session to implement this plan task-by-task. Do not use subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a signed, platform-specific AgentEra Runtime inside AgentEra Studio so an authenticated user can prepare and run the local Hermes core without GitHub, Git, system Python, PyPI, or an online install script, then explicitly download a verified update and switch to it on restart with automatic rollback.

**Architecture:** `Ablankpaper/aera-runtime` becomes the artifact producer: it assembles a relocatable CPython 3.11.15 runtime, installs the locked Hermes wheel and `[all]` dependency profile, copies the bundled Skills and built frontend assets, produces deterministic native archives, signs canonical manifests with Ed25519, and publishes only after the existing Hermes compatibility gate and extracted-artifact smoke tests pass. `Ablankpaper/aera` becomes the artifact consumer: its main process verifies and packages an exact Seed, installs program files below Electron `userData/runtime`, resolves every local Runtime invocation through one live abstraction, keeps `HERMES_HOME` physically separate, checks updates without downloading, stages only after user confirmation, and activates a candidate during a clean restart before any Runtime-dependent module is imported.

**Tech Stack:** Python 3.11.15, uv and `uv.lock`, setuptools wheel builds, `cryptography` Ed25519, `zstandard==0.25.0`, deterministic TAR/Zstandard and ZIP archives, GitHub Actions and Releases, Electron 39 / Node 22.22, TypeScript 5.9, Node `crypto`/`fs`/`zlib`, `tar` 7, `extract-zip` 2, React 19, Vitest, Playwright, macOS ARM64, Windows x64.

## Global Constraints

Use these repository roots throughout the plan:

```bash
export DESKTOP=/Users/zizimutou/Desktop/aera/aera
export RUNTIME=/Users/zizimutou/Desktop/aera/aera-runtime
export RUNTIME_VERSION=0.18.2-agentera.1
export RUNTIME_TAG=runtime-v0.18.2-agentera.1
export RUNTIME_KEY_ID=agentera-runtime-2026-01
```

The following rules are release blockers:

1. Runtime program files live only below Electron `userData/runtime`. Hermes Profile data stays in the existing `HERMES_HOME`; Runtime installation, update, rollback, and cleanup code must not accept `HERMES_HOME` as a deletion or copy root.
2. Never overwrite, upload, merge, normalize, or silently reseed existing `MEMORY.md`, `USER.md`, sessions, files, agent-created Skills, `.usage.json`, Curator archives/state, credentials, Gateway state, Cron state, logs, or workspaces.
3. Runtime changes take effect only for a new process and new conversation boundary. Do not mutate an active conversation's prompt, tool schema, skill index, provider state, or Python process.
4. A packaged build may not fall back to NousResearch `main`, `curl | bash`, PowerShell `irm | iex`, Git clone, `hermes update`, system Python, or PyPI when its Seed is missing or invalid.
5. Runtime update checking is automatic, but downloading is never automatic. Only an explicit renderer action may start a download, and only an explicit restart action may request activation.
6. The production Ed25519 private key never enters either repository, a desktop build, a test fixture, a workflow artifact, a log, or this plan. Tests use a dedicated fixture key. Only the public key and key id ship in AgentEra Studio.
7. The first supported release matrix is macOS ARM64 and Windows x64. Stable/beta desktop workflows must not silently publish a Seed-less macOS x64 or Linux installer under the new Runtime contract.
8. Cloud sync, workspace, organization, enterprise policy, official Agent publishing, Chromium, speech models, and local model weights are outside this plan.
9. Do not stage `$DESKTOP/lat.md/.cache/vectors.db`, `.venv`, `node_modules`, `dist`, downloaded archives, signing material, partial downloads, local databases, or logs.
10. Publishing a branch, PR, workflow run, prerelease, stable Release, signing secret, or desktop installer is an external checkpoint. Prepare and verify locally first, then obtain explicit user authorization at the named checkpoint.
11. Execute this plan in the primary/main Codex session. Do not spawn or delegate to subagents unless the user explicitly changes this rule.

## Branch and Review Topology

- Runtime implementation branch: create `aera/runtime-seed-distribution` from the current `aera/hermes-compatibility-gate` branch. Keep PR #6 as the stacked base until it is merged; do not duplicate or bypass its compatibility checks.
- Desktop implementation branch: create `aera/runtime-bundled-distribution` from the current `aera/runtime-bundling-design` branch. That branch already contains the approved design and is stacked on `aera/app-authentication`.
- Runtime producer, desktop Seed install, and desktop updater remain separate review gates even if implemented in one main Codex session.
- Every task below ends with a focused test and a local commit. Do not push or merge merely because a task commit exists.

## File Structure Map

### Runtime producer repository

```text
/Users/zizimutou/Desktop/aera/aera-runtime/
├── scripts/agentera_runtime_dist/
│   ├── __init__.py                    # package marker
│   ├── protocol.py                    # manifest, canonical JSON, signatures, validation
│   ├── inventory.py                   # file inventory and prohibited-content rules
│   ├── archive.py                     # deterministic tar.zst / zip writer and safe reader
│   ├── builder.py                     # portable Python + locked wheel assembly
│   └── smoke.py                       # extracted artifact health and data-boundary checks
├── scripts/build_agentera_runtime_seed.py
├── scripts/verify_agentera_runtime_seed.py
├── scripts/generate_agentera_runtime_key.py
├── tests/scripts/test_agentera_runtime_protocol.py
├── tests/scripts/test_agentera_runtime_inventory.py
├── tests/scripts/test_agentera_runtime_archive.py
├── tests/scripts/test_agentera_runtime_builder.py
├── tests/scripts/test_agentera_runtime_smoke.py
├── .github/workflows/agentera-runtime-release.yml
├── docs/agentera-runtime-release.md
├── pyproject.toml
└── uv.lock
```

### Desktop consumer repository

```text
/Users/zizimutou/Desktop/aera/aera/
├── build/agentera-runtime-seed.lock.json          # exact Release/tag/commit/asset pin
├── resources/agentera-runtime-trust.json          # public Ed25519 trust set only
├── resources/agentera-runtime-seed/                # ignored build staging directory
├── scripts/lib/agentera-runtime-protocol.mjs       # independent build-time verifier
├── scripts/prepare-agentera-runtime-seed.mjs
├── scripts/verify-packaged-runtime-seed.mjs
├── src/shared/agentera-runtime-distribution.ts     # renderer-safe public state and parsers
├── src/main/agentera-runtime-distribution/
│   ├── manifest.ts                    # main-process manifest/signature/hash validation
│   ├── paths.ts                       # userData/resources paths and containment checks
│   ├── state-store.ts                 # current/previous/candidate atomic journal
│   ├── extractor.ts                   # safe tar.zst/zip extraction
│   ├── health.ts                      # isolated candidate/Seed smoke probes
│   ├── invocation.ts                  # managed vs external Runtime resolution
│   ├── seed-installer.ts              # packaged Seed install and repair
│   ├── downloader.ts                  # resumable/cancellable HTTP transport
│   ├── update-client.ts               # signed stable channel discovery
│   ├── manager.ts                     # public lifecycle state machine
│   └── bootstrap.ts                   # pre-import candidate activation/rollback
├── src/renderer/src/components/settings/RuntimeDistributionCard.tsx
├── src/renderer/src/components/settings/useRuntimeDistribution.ts
├── tests/runtime-*.test.ts
└── tests/e2e/agentera-runtime-seed.e2e.ts
```

---

## Milestone A — Runtime Artifact Producer

### Task 1: Establish the signed manifest protocol

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/scripts/agentera_runtime_dist/__init__.py`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/scripts/agentera_runtime_dist/protocol.py`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/scripts/generate_agentera_runtime_key.py`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/tests/scripts/test_agentera_runtime_protocol.py`

**Public seam:**

```python
@dataclass(frozen=True)
class RuntimeTarget:
    platform: Literal["darwin", "windows"]
    arch: Literal["arm64", "x64"]

@dataclass(frozen=True)
class ManifestValidationContext:
    repository: str
    target: RuntimeTarget
    desktop_version: str
    allowed_channels: frozenset[str]

def canonical_json_bytes(value: Mapping[str, object]) -> bytes: ...
def parse_manifest(raw: bytes) -> dict[str, object]: ...
def validate_manifest(manifest: Mapping[str, object], context: ManifestValidationContext) -> None: ...
def sign_bytes(raw: bytes, private_key_pem: bytes) -> bytes: ...
def verify_bytes(raw: bytes, signature: bytes, public_key_pem: bytes) -> None: ...
```

The schema must include `schema_version`, `key_id`, `runtime_version`, `source_repository`, full `source_commit`, `channel`, `platform`, `arch`, `archive_name`, `archive_size`, `archive_sha256`, `python_version`, `entrypoints`, `minimum_desktop_version`, `compatibility_gate_revision`, `created_at`, and a sorted `files` inventory. A `.sig` file is a canonical JSON envelope with exactly `schema_version`, `key_id`, `algorithm: "Ed25519"`, and `signature_base64`.

- [ ] Create the two implementation branches only after confirming both worktrees contain no source edits. Leave `$DESKTOP/lat.md/.cache/vectors.db` untracked.

```bash
cd "$RUNTIME"
git status --short --branch
git switch -c aera/runtime-seed-distribution

cd "$DESKTOP"
git status --short --branch
git switch -c aera/runtime-bundled-distribution
```

Expected: Runtime is based on `aera/hermes-compatibility-gate`; Desktop is based on `aera/runtime-bundling-design`; neither command stages or deletes user state.

- [ ] Write protocol tests first. Cover canonical key ordering, raw-byte signature verification, a tampered manifest, wrong key, unknown key id, unknown schema, wrong repository, wrong target, incompatible desktop version, non-40-character commit, invalid archive path, duplicate inventory paths, and key rotation with two trusted public keys.

- [ ] Run the focused test and confirm red.

```bash
cd "$RUNTIME"
scripts/run_tests.sh tests/scripts/test_agentera_runtime_protocol.py -q
```

Expected: FAIL because `scripts.agentera_runtime_dist.protocol` does not exist.

- [ ] Implement strict parsing and canonical serialization. Reject booleans where integers are expected, extra top-level fields, absolute paths, `..` segments, non-ASCII schema keys, malformed SHA-256 values, unknown channels, and a manifest whose input bytes are not already canonical.

- [ ] Implement key generation as an explicit file-output command. It must refuse to overwrite an existing private key, create it with mode `0600`, write only the public key to the requested public output, and never print private material.

```bash
uv run python scripts/generate_agentera_runtime_key.py \
  --key-id "$RUNTIME_KEY_ID" \
  --private-out "$HOME/.config/agentera/runtime-signing/$RUNTIME_KEY_ID.pem" \
  --public-out "$HOME/.config/agentera/runtime-signing/$RUNTIME_KEY_ID.public.pem"
```

Expected during later execution: both outputs stay outside Git, the private key is mode `0600`, and stdout prints only the key id, public fingerprint, and output paths. The reviewed public key is copied into the desktop trust file in Task 6; the private key is never copied into either repository.

- [ ] Re-run the test and verify green.

```bash
scripts/run_tests.sh tests/scripts/test_agentera_runtime_protocol.py -q
```

Expected: PASS with no credential/network access.

- [ ] Commit only the protocol and tests.

```bash
git add scripts/agentera_runtime_dist/__init__.py \
  scripts/agentera_runtime_dist/protocol.py \
  scripts/generate_agentera_runtime_key.py \
  tests/scripts/test_agentera_runtime_protocol.py
git commit -m "feat: define signed AgentEra Runtime manifests"
```

### Task 2: Build deterministic archives from an explicit allowlist

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/scripts/agentera_runtime_dist/inventory.py`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/scripts/agentera_runtime_dist/archive.py`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/tests/scripts/test_agentera_runtime_inventory.py`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/tests/scripts/test_agentera_runtime_archive.py`
- Modify: `/Users/zizimutou/Desktop/aera/aera-runtime/pyproject.toml`
- Modify: `/Users/zizimutou/Desktop/aera/aera-runtime/uv.lock`

**Public seam:**

```python
@dataclass(frozen=True)
class InventoryEntry:
    path: str
    kind: Literal["file", "directory", "symlink"]
    size: int
    sha256: str | None
    mode: int
    link_target: str | None = None

def build_inventory(root: Path) -> list[InventoryEntry]: ...
def assert_seed_allowlist(root: Path, entries: Sequence[InventoryEntry]) -> None: ...
def write_deterministic_tar_zst(root: Path, destination: Path) -> None: ...
def write_deterministic_zip(root: Path, destination: Path) -> None: ...
def inspect_archive(destination: Path) -> list[InventoryEntry]: ...
```

- [ ] Write failing tests using a miniature Seed tree. Prove repeated builds are byte-identical, entries are sorted, timestamps/uid/gid are normalized, executable bits survive, relative in-root symlinks are accepted, absolute/out-of-root symlinks are rejected, and Windows ZIP paths use `/`.

- [ ] Add prohibited-content cases for `.git`, `.env`, `auth.json`, `MEMORY.md`, `USER.md`, `state.db`, `sessions/`, `logs/`, `__pycache__`, `.pytest_cache`, `.venv`, tests, caches, browser binaries, model weights, private-key extensions, and unexpected files outside the declared root layout.

- [ ] Run focused tests and confirm red.

```bash
cd "$RUNTIME"
scripts/run_tests.sh \
  tests/scripts/test_agentera_runtime_inventory.py \
  tests/scripts/test_agentera_runtime_archive.py -q
```

Expected: FAIL because inventory/archive modules do not exist.

- [ ] Add `zstandard==0.25.0` to the `dev` extra, regenerate `uv.lock`, and implement deterministic TAR/Zstandard and ZIP writers. Use a single compression thread and fixed compression settings; never shell out to an unpinned system `tar` or `zip`.

```bash
cd "$RUNTIME"
uv lock
```

- [ ] Re-run the focused tests and lockfile check.

```bash
scripts/run_tests.sh \
  tests/scripts/test_agentera_runtime_inventory.py \
  tests/scripts/test_agentera_runtime_archive.py -q
uv lock --check
```

Expected: PASS; a second archive of the same tree has the same SHA-256.

- [ ] Commit the allowlist and archive layer.

```bash
git add pyproject.toml uv.lock \
  scripts/agentera_runtime_dist/inventory.py \
  scripts/agentera_runtime_dist/archive.py \
  tests/scripts/test_agentera_runtime_inventory.py \
  tests/scripts/test_agentera_runtime_archive.py
git commit -m "feat: build deterministic Runtime seed archives"
```

### Task 3: Assemble a relocatable Runtime Seed and execute extracted smoke tests

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/scripts/agentera_runtime_dist/builder.py`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/scripts/agentera_runtime_dist/smoke.py`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/scripts/build_agentera_runtime_seed.py`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/scripts/verify_agentera_runtime_seed.py`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/tests/scripts/test_agentera_runtime_builder.py`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/tests/scripts/test_agentera_runtime_smoke.py`

The extracted logical layout is fixed:

```text
agentera-runtime/
  python/                         # relocatable uv-managed CPython tree
  runtime/hermes                 # relative POSIX wrapper
  runtime/hermes.cmd             # relative Windows wrapper
  THIRD_PARTY_LICENSES/
  seed-info.json                 # non-secret copy of version/source metadata
```

The Hermes wheel and locked dependencies install into the copied interpreter's own site-packages. `skills/`, `optional-skills/`, and `optional-mcps/` are copied beside the installed Python packages so the existing `get_bundled_skills_dir()` and Skills sync logic keep working without editing Hermes core.

- [ ] Write failing builder tests with injected command execution and a fake Python root. Assert the builder refuses a dirty source tree, a source commit other than `HEAD`, a Python version other than `3.11.15`, mismatched host target, missing `hermes_cli/web_dist/index.html`, missing `hermes_cli/tui_dist/entry.js`, unlocked resolution, a wheel with no `hermes_cli.main`, and any prohibited file.

- [ ] Write failing smoke tests. The extracted probe must run the bundled interpreter, import `hermes_cli.main`, run `--version`, run `serve --help`, import base tool/Memory/Skills/Curator modules, and confirm a synthetic `HERMES_HOME` boundary fixture has identical hashes before and after. No model API or public network call is allowed.

- [ ] Run focused tests and confirm red.

```bash
cd "$RUNTIME"
scripts/run_tests.sh \
  tests/scripts/test_agentera_runtime_builder.py \
  tests/scripts/test_agentera_runtime_smoke.py -q
```

Expected: FAIL because builder/smoke entry points do not exist.

- [ ] Implement the builder using the following locked flow: copy the root reported by the exact uv-managed Python executable; build frontend assets; build the current repository wheel; export `[all]` requirements from `uv.lock` without the project; install dependencies and the wheel into the copied interpreter; copy bundled data trees; generate relative launchers; strip caches/tests; inventory; archive; then emit an unsigned metadata record for the signing job.

- [ ] Implement `verify_agentera_runtime_seed.py` so it verifies canonical manifest bytes, trusted key, archive hash/size, safe extraction, complete file inventory, target compatibility, then executes the isolated smoke test. It must accept public keys only.

- [ ] Re-run unit tests, then build and verify a real local macOS ARM64 unsigned artifact without signing or publishing it.

```bash
cd "$RUNTIME"
scripts/run_tests.sh \
  tests/scripts/test_agentera_runtime_builder.py \
  tests/scripts/test_agentera_runtime_smoke.py -q

uv python install 3.11.15
cd web && npm ci && npm run build
cd "$RUNTIME/ui-tui" && npm ci && npm run build
mkdir -p "$RUNTIME/hermes_cli/tui_dist"
cp "$RUNTIME/ui-tui/dist/entry.js" "$RUNTIME/hermes_cli/tui_dist/entry.js"
cd "$RUNTIME"
uv build --wheel
uv run python scripts/build_agentera_runtime_seed.py \
  --runtime-version "$RUNTIME_VERSION" \
  --source-commit "$(git rev-parse HEAD)" \
  --python "$(uv python find 3.11.15)" \
  --output-dir dist/agentera-runtime
```

Expected on this Mac: a `darwin-arm64.tar.zst` plus unsigned build metadata; the extracted smoke passes; no file is created under the real `~/.hermes`.

- [ ] Commit the builder and smoke layer, excluding `dist/` and built frontend output.

```bash
git add scripts/agentera_runtime_dist/builder.py \
  scripts/agentera_runtime_dist/smoke.py \
  scripts/build_agentera_runtime_seed.py \
  scripts/verify_agentera_runtime_seed.py \
  tests/scripts/test_agentera_runtime_builder.py \
  tests/scripts/test_agentera_runtime_smoke.py
git commit -m "feat: assemble relocatable AgentEra Runtime seeds"
```

### Task 4: Add the native release workflow and release-blocking gates

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/.github/workflows/agentera-runtime-release.yml`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/docs/agentera-runtime-release.md`
- Modify: `/Users/zizimutou/Desktop/aera/aera-runtime/scripts/run_agentera_compatibility.sh`
- Create: `/Users/zizimutou/Desktop/aera/aera-runtime/tests/scripts/test_agentera_runtime_release_workflow.py`

- [ ] Write a behavior-oriented workflow test that parses YAML and asserts relationships: release jobs depend on the compatibility job; macOS uses an ARM64 `macos-14` runner; Windows uses x64; both use Python 3.11.15 and Node 22; the signing job alone receives the signing secret; publication depends on both native smoke jobs and signing; every third-party action is pinned to a full commit SHA.

- [ ] Extend the compatibility gate with the narrow additional invariants required by distribution: system-prompt restore, Memory/Profile/Skills/Curator tests remain present, and the Seed smoke suite is invoked when release artifacts are built. Do not replace the existing gate with a smaller list.

- [ ] Run the workflow contract test and confirm red before creating the workflow.

```bash
cd "$RUNTIME"
scripts/run_tests.sh tests/scripts/test_agentera_runtime_release_workflow.py -q
```

Expected: FAIL because the release workflow does not exist.

- [ ] Implement `workflow_dispatch` inputs `agentera_revision` (integer, default `1`), `channel` (`candidate` or `stable`), `candidate_number` (integer, default `1`), and `publish` (boolean, default `false`). Compute the version from `pyproject.toml`; do not accept an arbitrary source SHA or version string from a caller.

- [ ] Structure jobs as `compatibility` -> native `build_macos_arm64` and `build_windows_x64` -> isolated Ubuntu `sign` -> `publish`. Native jobs create and smoke unsigned archives. The signing job downloads artifacts, reconstructs and signs manifests, creates a signed stable/candidate channel index, verifies every signed artifact with public keys, then uploads the signed bundle. `publish=false` must still exercise every step except creating a Git tag/Release.

- [ ] Document key rotation, candidate/stable channels, asset names, reproducibility, recovery from a failed run, and the rule that the signing private key exists only as the protected `AGENTERA_RUNTIME_SIGNING_KEY_PEM_B64` secret in the `runtime-production` GitHub Environment.

- [ ] Run the focused Runtime tests and compatibility gate locally.

```bash
cd "$RUNTIME"
scripts/run_tests.sh \
  tests/scripts/test_agentera_runtime_protocol.py \
  tests/scripts/test_agentera_runtime_inventory.py \
  tests/scripts/test_agentera_runtime_archive.py \
  tests/scripts/test_agentera_runtime_builder.py \
  tests/scripts/test_agentera_runtime_smoke.py \
  tests/scripts/test_agentera_runtime_release_workflow.py -q
scripts/run_agentera_compatibility.sh -j 4 -q
```

Expected: PASS; local execution does not require the production private key.

- [ ] Commit the workflow and runbook locally.

```bash
git add .github/workflows/agentera-runtime-release.yml \
  docs/agentera-runtime-release.md \
  scripts/run_agentera_compatibility.sh \
  tests/scripts/test_agentera_runtime_release_workflow.py
git commit -m "ci: build signed AgentEra Runtime releases"
```

### Task 5: External checkpoint — create and verify the first candidate Runtime Release

This task starts only after the user explicitly authorizes the push, signing-secret update, workflow dispatch, and candidate prerelease. Candidate publication is not implied by approval of this plan.

- [ ] Run the full Runtime verification from a clean worktree and record the commit.

```bash
cd "$RUNTIME"
git status --short
scripts/run_tests.sh -q
scripts/run_agentera_compatibility.sh -j 4 -q
git rev-parse HEAD
```

Expected: clean source worktree; full tests and compatibility gate pass.

- [ ] After explicit approval, set the protected signing secret from the private file without printing it, push the Runtime branch, and open a draft stacked PR against `aera/hermes-compatibility-gate` while PR #6 remains open.

```bash
cd "$RUNTIME"
base64 < "$HOME/.config/agentera/runtime-signing/$RUNTIME_KEY_ID.pem" | \
  gh secret set AGENTERA_RUNTIME_SIGNING_KEY_PEM_B64 \
    --repo Ablankpaper/aera-runtime \
    --env runtime-production
git push -u origin aera/runtime-seed-distribution
gh pr create \
  --repo Ablankpaper/aera-runtime \
  --base aera/hermes-compatibility-gate \
  --head aera/runtime-seed-distribution \
  --draft \
  --title "Build signed AgentEra Runtime seed releases" \
  --body-file docs/agentera-runtime-release.md
```

- [ ] Dispatch `publish=false`, wait for success, download its signed artifacts, and verify both target manifests locally with the public key.

```bash
gh workflow run agentera-runtime-release.yml \
  --repo Ablankpaper/aera-runtime \
  --ref aera/runtime-seed-distribution \
  -f agentera_revision=1 \
  -f channel=candidate \
  -f candidate_number=1 \
  -f publish=false
gh run list --repo Ablankpaper/aera-runtime --workflow agentera-runtime-release.yml --limit 1
```

Expected: native macOS ARM64 and Windows x64 jobs, compatibility, signing, and verification pass; publish is skipped.

- [ ] Download the verified dry-run artifact bundle into the untracked local integration directory `$RUNTIME/dist/agentera-runtime/signed`, preserving the manifest, signature, and archive names exactly. Re-run `scripts/verify_agentera_runtime_seed.py` from that directory for both targets. This exact directory is the only local override consumed by the desktop packaging rehearsal in Task 10; it is never committed or accepted by release CI.

- [ ] Only after reviewing the dry-run assets and obtaining a second explicit publication confirmation, dispatch the same inputs with `publish=true`. Verify that `runtime-v0.18.2-agentera.1-rc.1` is a prerelease, its source commit equals the PR head, and it contains exactly the two archives, two manifests, two signatures, signed channel index, license bundle, and checksums.

---

## Milestone B — Desktop Seed Consumer and Runtime Resolution

### Task 6: Implement independent desktop manifest verification and the exact Seed lock

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/shared/agentera-runtime-distribution.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-runtime-distribution/manifest.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-runtime-distribution/trust.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/resources/agentera-runtime-trust.json`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/lib/agentera-runtime-protocol.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/build/agentera-runtime-seed.lock.json`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-manifest.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-build-verifier.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/fixtures/runtime-distribution/README.md`

**Renderer-safe types:**

```ts
export type RuntimeDistributionPhase =
  | "missing"
  | "installing"
  | "current"
  | "checking"
  | "update-available"
  | "downloading"
  | "candidate-ready"
  | "rollback"
  | "repair-required"
  | "external";

export interface RuntimeDistributionPublicState {
  phase: RuntimeDistributionPhase;
  currentVersion: string | null;
  currentSourceCommit: string | null;
  packagedSeedVersion: string | null;
  availableVersion: string | null;
  downloadSize: number | null;
  downloadPercent: number | null;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
  canCheck: boolean;
  canDownload: boolean;
  canCancel: boolean;
  canRestart: boolean;
}
```

No URL, path, signature, public key, owner id, token, or full diagnostic object crosses this type.

- [ ] Generate deterministic test fixtures from a test-only Ed25519 key. Commit the public and private fixture keys only under `tests/fixtures/runtime-distribution/` with a README stating they are non-production and unusable by the production trust set.

- [ ] Write failing Vitest cases that consume the same canonical manifests as the Python producer tests. Cover canonical bytes, valid signature, tamper, unknown key/schema, wrong repository/target, minimum desktop version, full commit, archive size/hash, file inventory, and production trust rejecting the test key.

- [ ] Write a second failing test that executes the independent `.mjs` build-time verifier against the same fixtures. It must fail closed independently of the TypeScript main-process implementation.

- [ ] Run focused tests and confirm red.

```bash
cd "$DESKTOP"
npx vitest run tests/runtime-manifest.test.ts tests/runtime-build-verifier.test.ts
```

Expected: FAIL because the verifier and trust files do not exist.

- [ ] Implement raw-byte Ed25519 verification with Node `crypto.verify`, canonical JSON comparison, strict runtime-version parsing, trusted key lookup, archive hashing, and manifest context validation. Annotate the trust boundary with `// @lat: [[agentera-runtime-distribution#Release gate]]`.

- [ ] Populate `agentera-runtime-trust.json` with only `$RUNTIME_KEY_ID` and the reviewed public key produced in Task 1. Create the exact lock by reading the verified candidate manifest; the lock must contain repository, candidate tag, full source commit, runtime version, and exact asset names for `darwin-arm64` and `windows-x64`.

- [ ] Re-run tests and typecheck.

```bash
npx vitest run tests/runtime-manifest.test.ts tests/runtime-build-verifier.test.ts
npm run typecheck:node
```

Expected: PASS; the production trust set rejects all test signatures.

- [ ] Commit only public trust, lock, source, tests, and fixtures.

```bash
git add build/agentera-runtime-seed.lock.json \
  resources/agentera-runtime-trust.json \
  scripts/lib/agentera-runtime-protocol.mjs \
  src/shared/agentera-runtime-distribution.ts \
  src/main/agentera-runtime-distribution/manifest.ts \
  src/main/agentera-runtime-distribution/trust.ts \
  tests/runtime-manifest.test.ts \
  tests/runtime-build-verifier.test.ts \
  tests/fixtures/runtime-distribution
git commit -m "feat: verify signed AgentEra Runtime artifacts"
```

### Task 7: Add the versioned Runtime root and crash-safe state journal

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-runtime-distribution/paths.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-runtime-distribution/state-store.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-paths.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-state-store.test.ts`

**State seam:**

```ts
export interface RuntimePointer {
  schemaVersion: 1;
  runtimeVersion: string;
  sourceCommit: string;
  versionDirectory: string;
  manifestSha256: string;
  installedAt: string;
}

export interface CandidatePointer extends RuntimePointer {
  applyOnNextLaunch: boolean;
  stagedAt: string;
}

export interface RuntimeDistributionPaths {
  root: string;         // <userData>/runtime
  versions: string;     // <userData>/runtime/versions
  staging: string;      // <userData>/runtime/staging
  downloads: string;    // <userData>/runtime/downloads
  failures: string;     // <userData>/runtime/failures
  current: string;      // <userData>/runtime/current.json
  previous: string;     // <userData>/runtime/previous.json
  candidate: string;    // <userData>/runtime/candidate.json
  packagedSeed: string;
}
```

- [ ] Write failing path-containment and state tests. Cover traversal, absolute `versionDirectory`, symlink escape, malformed JSON, unknown schema, interrupted temp write, missing referenced directory, current/previous/candidate transitions, and cleanup retaining every referenced version.

- [ ] Prove by dependency construction that cleanup receives only `RuntimeDistributionPaths.root`; it must reject any target outside that root and must not import `HERMES_HOME` or `installer.ts`.

- [ ] Run focused tests and confirm red.

```bash
cd "$DESKTOP"
npx vitest run tests/runtime-paths.test.ts tests/runtime-state-store.test.ts
```

Expected: FAIL because paths/state store do not exist.

- [ ] Implement atomic pointer writes as write -> file `fsync` -> rename -> parent-directory `fsync` where supported. Recovery may delete only stale `.tmp` files and transaction directories proven to be children of Runtime `staging` or `downloads`.

- [ ] Re-run focused tests and node typecheck.

```bash
npx vitest run tests/runtime-paths.test.ts tests/runtime-state-store.test.ts
npm run typecheck:node
```

- [ ] Commit the state layer.

```bash
git add src/main/agentera-runtime-distribution/paths.ts \
  src/main/agentera-runtime-distribution/state-store.ts \
  tests/runtime-paths.test.ts tests/runtime-state-store.test.ts
git commit -m "feat: journal local Runtime versions safely"
```

### Task 8: Resolve every local Runtime call through one live invocation abstraction

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-runtime-distribution/invocation.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-invocation.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/installer.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/hermes.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/dashboard.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/skills.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/profiles.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/cronjobs.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/model-discovery.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/mcp-servers.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/hermes-auth.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/kanban.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/hermes-agent-compat.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-startup-preflight.ts`
- Modify matching mocks/tests that currently import `HERMES_PYTHON`, `HERMES_REPO`, `HERMES_SCRIPT`, or `hermesCliArgs`.

**Invocation seam:**

```ts
export interface RuntimeInvocation {
  source: "managed" | "external";
  version: string | null;
  sourceCommit: string | null;
  root: string;
  python: string;
  workingDirectory: string;
  bundledSkillsDirectory: string;
  webDistDirectory: string;
  cliArgs(args?: readonly string[]): string[];
  environment(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

export function getRuntimeInvocation(): RuntimeInvocation | null;
export function refreshRuntimeInvocation(): RuntimeInvocation | null;
export function selectExternalRuntime(hermesHome: string): void;
export function selectManagedRuntime(): void;
```

- [ ] Write failing resolver tests for managed current, explicit external mode, missing current, stale external selection, platform-specific Python paths, `PYTHONNOUSERSITE=1` in managed mode, unchanged `HERMES_HOME`, and live refresh after first Seed install.

- [ ] Add at least one behavior test for each execution family: chat/gateway, Dashboard, Skills, Profiles, Cron, model discovery, MCP, Hermes account auth, Kanban, compatibility probe, and startup preflight. Tests invoke injected spawners or real pure builders; do not assert by reading TypeScript source text.

- [ ] Run the focused tests and confirm the existing fixed-path behavior fails the managed cases.

```bash
cd "$DESKTOP"
npx vitest run \
  tests/runtime-invocation.test.ts \
  tests/installer-platform.test.ts \
  tests/agentera-startup-preflight.test.ts \
  tests/gateway-restart.test.ts \
  tests/cronjobs.test.ts
```

- [ ] Implement the resolver. Managed mode maps `workingDirectory` and bundled assets to the installed interpreter's site-packages; external mode maps to the existing `HERMES_HOME/hermes-agent` checkout. Use `python -m hermes_cli.main` for both modes so launch does not depend on a non-relocatable generated shebang.

- [ ] Replace every direct Runtime constant at time of use. A missing invocation must return a bounded “Runtime not prepared” error instead of spawning a fallback executable. Keep `HERMES_HOME`, profile helpers, `.env`, config, auth, and user data paths unchanged.

- [ ] Run a literal-reference audit; only compatibility re-exports in tests may remain, and production spawn paths must call `getRuntimeInvocation()`.

```bash
rg -n "HERMES_(PYTHON|REPO|SCRIPT|VENV)|hermesCliArgs" src/main tests
npm test -- --run tests/runtime-invocation.test.ts tests/installer-platform.test.ts tests/agentera-startup-preflight.test.ts
npm run typecheck
```

Expected: managed and external tests pass; no production module caches a Runtime path that cannot be refreshed.

- [ ] Commit the invocation sweep as one reviewable refactor.

```bash
git add src/main tests
git commit -m "refactor: resolve local Runtime invocations centrally"
```

### Task 9: Install and repair the packaged Seed without network access

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-runtime-distribution/extractor.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-runtime-distribution/health.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-runtime-distribution/seed-installer.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-extractor.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-seed-installer.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/package.json`
- Modify: `/Users/zizimutou/Desktop/aera/aera/package-lock.json`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/installer.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/register.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Install/Install.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/en/install.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/zh-CN/install.ts`

- [ ] Add `tar@^7.5.13` and `extract-zip@^2.0.1` as direct production dependencies. The app must not rely on transitive copies owned by `electron-builder` or Electron.

- [ ] Write failing extractor tests for TAR/Zstandard and ZIP, including path traversal, case-folded duplicate paths on Windows, absolute or escaping symlinks, decompression bomb budget, cancellation, unexpected files, missing inventory files, hash mismatch, and executable permissions.

- [ ] Write failing Seed installer tests for discovery, signature validation, disk budget, staging cleanup, isolated health, atomic promotion, live invocation refresh, repair from current corruption, and a spy proving zero HTTP/Git/shell installer calls on success and failure.

- [ ] Run focused tests and confirm red.

```bash
cd "$DESKTOP"
npx vitest run tests/runtime-extractor.test.ts tests/runtime-seed-installer.test.ts
```

- [ ] Implement extraction with Node `createZstdDecompress()` piped into `tar.x()` on macOS and `extract-zip` on Windows. Validate archive entries before promotion and re-hash the extracted inventory afterward. Never extract directly into `versions/`.

- [ ] Implement disk budget as archive bytes + manifest-declared extracted bytes + one rollback-version reserve + 10% safety margin. Permission/disk errors clean only the current transaction directory.

- [ ] Replace the local `start-install` path with `installPackagedSeed()`. Preserve existing progress IPC but change copy to “Preparing AgentEra Runtime.” A corrupt/missing Seed returns `repair-required` and a reinstall-desktop action; it never calls the old online installer.

- [ ] Re-run focused tests, install UI tests, and typecheck.

```bash
npx vitest run \
  tests/runtime-extractor.test.ts \
  tests/runtime-seed-installer.test.ts \
  tests/installer-target.test.ts \
  tests/ipc-handlers.test.ts
npm run typecheck
```

- [ ] Commit the offline Seed installer.

```bash
git add package.json package-lock.json \
  src/main/agentera-runtime-distribution \
  src/main/installer.ts src/main/ipc/register.ts \
  src/renderer/src/screens/Install/Install.tsx \
  src/shared/i18n/locales/en/install.ts \
  src/shared/i18n/locales/zh-CN/install.ts \
  tests/runtime-extractor.test.ts tests/runtime-seed-installer.test.ts \
  tests/installer-target.test.ts tests/ipc-handlers.test.ts
git commit -m "feat: prepare the packaged Runtime seed offline"
```

### Task 10: Fetch, verify, and embed an exact Seed during desktop packaging

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/prepare-agentera-runtime-seed.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/scripts/verify-packaged-runtime-seed.mjs`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-packaging-scripts.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/package.json`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.gitignore`
- Modify: `/Users/zizimutou/Desktop/aera/aera/electron-builder.yml`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.github/workflows/release.yml`
- Modify: `/Users/zizimutou/Desktop/aera/aera/.github/workflows/beta-release.yml`

- [ ] Write failing tests around a loopback HTTP fixture and local fixture directory. Assert the preparation script selects exactly one target, refuses `latest`, refuses commit/tag/manifest drift, verifies signature/hash/size before staging, and deletes stale target artifacts.

- [ ] Add an npm script:

```json
{
  "prepare:runtime-seed": "node scripts/prepare-agentera-runtime-seed.mjs",
  "verify:packaged-runtime-seed": "node scripts/verify-packaged-runtime-seed.mjs"
}
```

- [ ] Run the packaging-script test and confirm red.

```bash
cd "$DESKTOP"
npx vitest run tests/runtime-packaging-scripts.test.ts
```

- [ ] Implement preparation. Release builds read only `build/agentera-runtime-seed.lock.json`; development may use the explicit `AGENTERA_RUNTIME_SEED_DIR` local directory. CI must reject that override. Stage archive, manifest, and signature below `resources/agentera-runtime-seed/` only after the independent `.mjs` verifier passes.

- [ ] Add `extraResources` from `resources/agentera-runtime-seed` to `agentera-runtime-seed`. Ignore staged artifacts but keep the directory. Verify the unpacked app and final DMG/ZIP/NSIS/portable artifact contain the same three byte-identical files.

- [ ] Restrict beta/stable workflows to macOS ARM64 and Windows x64 for this release line. Remove Linux/macOS x64 from publish dependencies until their native Seed targets are implemented; do not publish a package that silently restores the online installer.

- [ ] On each native desktop job, prepare the matching Seed before `electron-builder`, verify it in the unpacked app, then verify the final artifact. Do not add a GitHub token to the shipped app; CI may use the workflow token only to avoid API throttling while fetching public assets.

- [ ] Run the local macOS ARM64 unpacked package proof.

```bash
cd "$DESKTOP"
AGENTERA_RUNTIME_SEED_DIR="$RUNTIME/dist/agentera-runtime/signed" \
  npm run prepare:runtime-seed -- --platform darwin --arch arm64
npm run build
npx electron-builder --dir --mac --arm64 --publish never
npm run verify:packaged-runtime-seed -- \
  "dist/mac-arm64/AgentEra Studio.app/Contents/Resources/agentera-runtime-seed"
```

Expected: verifier passes; staged archives remain untracked; no network access occurs when using the explicit local directory.

- [ ] Commit build wiring, not generated Seed files.

```bash
git add package.json .gitignore electron-builder.yml \
  scripts/prepare-agentera-runtime-seed.mjs \
  scripts/verify-packaged-runtime-seed.mjs \
  tests/runtime-packaging-scripts.test.ts \
  .github/workflows/release.yml .github/workflows/beta-release.yml
git commit -m "build: embed a pinned AgentEra Runtime seed"
```

---

## Milestone C — Update, Restart Activation, and Rollback

### Task 11: Check updates and download only after explicit confirmation

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-runtime-distribution/downloader.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-runtime-distribution/update-client.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-downloader.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-update-client.test.ts`

**Download seam:**

```ts
export interface RuntimeDownloadRequest {
  url: URL;
  destination: string;
  expectedSize: number;
  expectedSha256: string;
  signal: AbortSignal;
  onProgress: (received: number, total: number) => void;
}

export async function downloadWithResume(request: RuntimeDownloadRequest): Promise<void>;
export async function checkStableRuntimeUpdate(context: RuntimeUpdateContext): Promise<RuntimeUpdateOffer | null>;
```

- [ ] Build a loopback HTTP test server covering `206`, ignored Range -> `200`, mismatched `Content-Range`, redirect limit, timeout, connection drop, resume, cancel, retry, wrong size, wrong hash, and partial-file retention/expiry.

- [ ] Write update-client tests proving a check downloads only the signed index/manifest/signature metadata, never the archive; older/equal/incompatible versions return no offer; GitHub failure returns current state plus a non-fatal check error; only `https://github.com/Ablankpaper/aera-runtime/releases/download/` and the reviewed latest-channel redirect are accepted.

- [ ] Run tests and confirm red.

```bash
cd "$DESKTOP"
npx vitest run tests/runtime-downloader.test.ts tests/runtime-update-client.test.ts
```

- [ ] Implement the downloader with bounded redirects, connect/read/overall timeouts, Range validation, streaming SHA-256, `AbortSignal`, and `.part.json` metadata. A retry may resume only if URL, ETag/Last-Modified when present, expected size, and expected hash still match.

- [ ] Implement stable-channel checking. Verify the signed channel index, then the selected target manifest/signature. Never treat a transport hostname as trust; the manifest repository, signature, and archive hash remain authoritative.

- [ ] Re-run tests and typecheck.

```bash
npx vitest run tests/runtime-downloader.test.ts tests/runtime-update-client.test.ts
npm run typecheck:node
```

- [ ] Commit transport and metadata discovery.

```bash
git add src/main/agentera-runtime-distribution/downloader.ts \
  src/main/agentera-runtime-distribution/update-client.ts \
  tests/runtime-downloader.test.ts tests/runtime-update-client.test.ts
git commit -m "feat: check and download Runtime updates safely"
```

### Task 12: Stage a candidate and activate it before Runtime imports with rollback

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-runtime-distribution/manager.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/main/agentera-runtime-distribution/bootstrap.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-manager.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-bootstrap.test.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/index.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/app/start.ts`

- [ ] Write manager tests proving `check()` performs zero archive downloads, `downloadConfirmed()` is the only archive path, a valid download extracts to staging and writes `candidate.json`, cancel leaves `current` unchanged, and failures leave the current Runtime usable.

- [ ] Write bootstrap tests for candidate success, candidate health failure, process crash between previous/current writes, corrupt current with valid previous, corrupt both with packaged Seed repair state, failed-candidate loop suppression, and diagnostic redaction.

- [ ] Write restart-guard tests. If `activeRuns.size > 0`, return `runtime_tasks_active` and do not relaunch. When no active chat exists, stop local Runtime-owned processes using the existing `stopActiveRuntimeContext`, mark `applyOnNextLaunch`, then request relaunch. Candidate files are never swapped in the running process.

- [ ] Run focused tests and confirm red.

```bash
cd "$DESKTOP"
npx vitest run tests/runtime-manager.test.ts tests/runtime-bootstrap.test.ts
```

- [ ] Implement `bootstrapRuntimeDistribution()` before importing `./app/start`. Change `src/main/index.ts` to configure desktop identity and GPU first, await Runtime pointer recovery/candidate activation, then dynamically import `startMainProcess`. This ordering is mandatory so no module captures the previous Runtime path before activation.

- [ ] Candidate health uses a temporary empty home below `userData/runtime/health`, `PYTHONNOUSERSITE=1`, and no real Profile path. Success atomically moves old current -> previous and candidate -> current. Failure restores previous, records only error code/exit code/version/short SHA, and suppresses retry until a new candidate is staged.

- [ ] Re-run tests, typecheck, and a controlled local rollback test with a deliberately broken candidate fixture.

```bash
npx vitest run tests/runtime-manager.test.ts tests/runtime-bootstrap.test.ts
npm run typecheck
```

- [ ] Commit activation and rollback.

```bash
git add src/main/agentera-runtime-distribution/manager.ts \
  src/main/agentera-runtime-distribution/bootstrap.ts \
  src/main/index.ts src/main/app/start.ts \
  tests/runtime-manager.test.ts tests/runtime-bootstrap.test.ts
git commit -m "feat: activate Runtime candidates with rollback"
```

### Task 13: Expose a narrow IPC API and render the separate Runtime card

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/preload/index.d.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/register.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/ipc/auth-guard.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/components/settings/useRuntimeDistribution.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/components/settings/RuntimeDistributionCard.tsx`
- Create: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/components/settings/RuntimeDistributionCard.test.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/components/settings/AboutPane.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/components/settings/useSettingsData.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/en/settings.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/zh-CN/settings.ts`
- Modify: remaining locale `settings.ts` files with accurate fallback copy.
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/assets/main.css`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/preload-api-surface.test.ts`

**Preload namespace:**

```ts
export interface AgenteraRuntimeDistributionAPI {
  getState(): Promise<RuntimeDistributionPublicState>;
  checkForUpdate(): Promise<RuntimeDistributionPublicState>;
  downloadConfirmed(): Promise<RuntimeDistributionPublicState>;
  cancelDownload(): Promise<RuntimeDistributionPublicState>;
  restartToApply(): Promise<RuntimeDistributionPublicState>;
  retryRepair(): Promise<RuntimeDistributionPublicState>;
  onStateChanged(listener: (state: RuntimeDistributionPublicState) => void): () => void;
}
```

- [ ] Write renderer tests first for current, checking, available, downloading, cancellation, candidate-ready, active-task refusal, rollback, repair-required, and external states. Clicking download must first open an explicit confirmation dialog containing version/source/size; closing the dialog calls no IPC download method.

- [ ] Add behavior-level preload/IPC tests. Runtime lifecycle channels belong to the `authenticated` guard before Profile binding; the main screen naturally supplies bound access, but a signed-in first install must work before a Profile exists. Ensure IPC serializers discard extra internal fields.

- [ ] Run tests and confirm red.

```bash
cd "$DESKTOP"
npx vitest run \
  src/renderer/src/components/settings/RuntimeDistributionCard.test.tsx \
  tests/preload-api-surface.test.ts \
  tests/agentera-ipc-auth-guard.test.ts
```

- [ ] Implement a dedicated hook instead of adding more Runtime state to the existing monolithic `useSettingsData`. Keep the AgentEra Studio app updater card separate. Replace the old generic “Update Engine” action with managed Runtime status/actions; show the legacy command only in explicit external mode.

- [ ] Start update checking after the authenticated main UI is usable. A failed check updates only `lastErrorCode`; it must not block local chat, Setup, Profile binding, or offline mode.

- [ ] Re-run component, IPC, preload, i18n, and type tests.

```bash
npx vitest run \
  src/renderer/src/components/settings/RuntimeDistributionCard.test.tsx \
  tests/preload-api-surface.test.ts \
  tests/agentera-ipc-auth-guard.test.ts \
  src/shared/i18n/index.test.ts
npm run typecheck
```

- [ ] Commit the reviewed public surface and UI.

```bash
git add src/preload src/main/ipc \
  src/renderer/src/components/settings \
  src/renderer/src/assets/main.css \
  src/shared/i18n tests/preload-api-surface.test.ts \
  tests/agentera-ipc-auth-guard.test.ts
git commit -m "feat: manage Runtime updates from Settings"
```

### Task 14: Preserve explicit external Runtime compatibility and delete packaged online fallbacks

**Files:**

- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/installer.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/main/app/menu.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/renderer/src/screens/Install/Install.tsx`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/ar/install.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/ar/settings.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/en/install.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/en/settings.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/es/install.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/es/settings.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/he/install.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/he/settings.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/id/install.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/id/settings.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/ja/install.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/ja/settings.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pl/install.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pl/settings.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pt-BR/install.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pt-BR/settings.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pt-PT/install.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/pt-PT/settings.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/tr/install.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/tr/settings.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/zh-CN/install.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/zh-CN/settings.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/zh-TW/install.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/src/shared/i18n/locales/zh-TW/settings.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/tests/installer-target.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-external-compat.test.ts`

- [ ] Write tests for the migration matrix: no managed/current with an existing legacy checkout offers “Use existing external Runtime”; selecting it persists external mode and the Hermes-home override; managed install never deletes or changes the checkout; switching back to managed leaves it in place; external update is clearly labeled unmanaged and invokes only that checkout's local command.

- [ ] Add a packaged-code audit test or runtime behavior test proving first install and managed update never reach a remote install script. Do not add a source-regex test; inject network/process dependencies and assert zero calls.

- [ ] Remove the `raw.githubusercontent.com/NousResearch/.../install.sh` and `install.ps1` first-install branches from the shipped path. Remove any error message instructing the user to execute them. Keep backup/import/migration and explicit external Runtime support.

- [ ] Change the Runtime menu link to `https://github.com/Ablankpaper/aera-runtime`. Do not rename internal `hermes_cli`, `HERMES_HOME`, Profile files, or Hermes compatibility identifiers.

- [ ] Run focused tests and an online-fallback audit.

```bash
cd "$DESKTOP"
npx vitest run tests/installer-target.test.ts tests/runtime-external-compat.test.ts tests/runtime-seed-installer.test.ts
rg -n "raw\.githubusercontent\.com/(NousResearch|bignormal)/.*install\.(sh|ps1)|curl .*install\.sh|irm .*install\.ps1" src resources
```

Expected: tests pass; the audit prints no packaged first-install fallback. Documentation/history files may still name upstream for attribution and compatibility.

- [ ] Commit external compatibility and fallback removal.

```bash
git add src/main/installer.ts src/main/app/menu.ts \
  src/renderer/src/screens/Install/Install.tsx \
  src/shared/i18n tests/installer-target.test.ts \
  tests/runtime-external-compat.test.ts
git commit -m "refactor: retire online Runtime installation fallbacks"
```

---

## Milestone D — Cross-Repository Verification and Release Readiness

### Task 15: Prove Profile/self-learning data invariance and offline first preparation

**Files:**

- Create: `/Users/zizimutou/Desktop/aera/aera/tests/runtime-data-boundary.test.ts`
- Create: `/Users/zizimutou/Desktop/aera/aera/tests/e2e/agentera-runtime-seed.e2e.ts`
- Modify: `/Users/zizimutou/Desktop/aera/aera/package.json`
- Modify: `/Users/zizimutou/Desktop/aera/aera/lat.md/agentera-runtime-distribution.md` only if implementation differs from the approved architecture.

- [ ] Build a realistic synthetic `HERMES_HOME` fixture containing default and named Profiles, `.env`, `auth.json`, `MEMORY.md`, `USER.md`, SQLite/session files, attachments, agent-created and pinned Skills, `.usage.json`, Curator archives/backups, Gateway/Cron state, logs, and workspace files. Hash file content, modes, symlink targets, and relative paths.

- [ ] Write one integration test that runs packaged Seed install, update staging, candidate success, candidate failure rollback, old-version cleanup, managed/external switch, and repair. Assert the complete boundary snapshot is byte-for-byte and metadata-for-metadata identical after every operation.

- [ ] Add a Playwright Electron E2E that reuses the existing product-auth browser harness. Authenticate online, disconnect the Runtime artifact server and block public HTTP, prepare the packaged local Seed, bind/create the Profile, launch the bundled Runtime, restart Studio, and verify the same current version returns. Assert no request to GitHub, NousResearch, PyPI, or a remote install script.

- [ ] Run focused boundary and E2E tests.

```bash
cd "$DESKTOP"
npx vitest run tests/runtime-data-boundary.test.ts
npm run build
npx playwright test tests/e2e/agentera-runtime-seed.e2e.ts
```

Expected: PASS; only `userData/runtime` changes; all synthetic Hermes adaptive data remains identical.

- [ ] Run the complete desktop verification and LAT check.

```bash
npm test
npm run typecheck
npm run build
npx --yes --package lat.md lat check
git status --short
```

Expected: all tests/typechecks/build/LAT pass; only intentional source/docs edits are tracked; `lat.md/.cache/vectors.db` remains untracked.

- [ ] Run the complete Runtime verification again at the exact source commit pinned by the desktop lock.

```bash
cd "$RUNTIME"
test "$(git rev-parse HEAD)" = "$(node -e 'const l=require(process.env.DESKTOP+"/build/agentera-runtime-seed.lock.json"); process.stdout.write(l.source_commit)')"
scripts/run_tests.sh -q
scripts/run_agentera_compatibility.sh -j 4 -q
```

Expected: commit pin matches; full Runtime and compatibility suites pass.

- [ ] Commit the final automated gates.

```bash
cd "$DESKTOP"
git add tests/runtime-data-boundary.test.ts \
  tests/e2e/agentera-runtime-seed.e2e.ts package.json \
  lat.md/agentera-runtime-distribution.md
git commit -m "test: prove Runtime distribution preserves Hermes learning"
```

### Task 16: Review, candidate desktop build, physical platform proof, and stable promotion

This task has separate user approvals for branch push/PR, candidate desktop publication, and stable Runtime/Desktop publication.

- [ ] Run clean-worktree reviews in both repositories and ensure generated artifacts/secrets are absent.

```bash
cd "$RUNTIME"
git status --short
git log --oneline --decorate -12
git diff --check "$(git merge-base HEAD aera/hermes-compatibility-gate)"..HEAD

cd "$DESKTOP"
git status --short
git log --oneline --decorate -16
git diff --check "$(git merge-base HEAD aera/runtime-bundling-design)"..HEAD
```

- [ ] Use `superpowers:requesting-code-review` in the main session. Review Runtime producer and desktop consumer separately, with an explicit pass for signature trust, path containment, archive extraction, active-task handling, rollback, and `HERMES_HOME` invariance. Fix findings with new focused tests and commits.

- [ ] After explicit push/PR approval, push the desktop branch and open a draft stacked PR against `aera/app-authentication`. Keep Runtime PR stacked on the compatibility gate until PR #6 is merged.

- [ ] Build a candidate AgentEra Studio installer from the candidate Runtime Release. On a real Apple Silicon Mac, prove: signed/notarized app, online product login, network disconnected before Runtime preparation, zero GitHub/PyPI calls, Runtime start, chat with a configured model API, Memory/USER/Skills persistence, restart, candidate update, intentional candidate failure, and automatic rollback.

- [ ] On a real Windows x64 machine, prove: signed NSIS install, portable run, DPAPI auth remains available, long-path extraction, antivirus scan, online login then network-disconnected Runtime preparation, Runtime start, update resume, candidate restart, rollback, uninstall, and preservation of `HERMES_HOME` plus the separately retained legacy checkout.

- [ ] Record exact app version, Runtime version, full source commits, artifact SHA-256, OS build, machine architecture, signing/notarization status, test timestamps, and failure/rollback evidence in the two release runbooks. CI success does not replace these physical checks.

- [ ] Only after physical candidate proof and explicit stable-release approval, rerun the Runtime workflow with `channel=stable`, `publish=true`, promote the identical reviewed source commit to `$RUNTIME_TAG`, update the desktop lock from the stable manifest, rerun desktop packaging verification, and publish the matching AgentEra Studio release.

- [ ] Final completion criteria: macOS ARM64 and Windows x64 installers contain a valid signed Seed; first Runtime preparation does not access GitHub; automatic checks do not auto-download; user-confirmed download stages a candidate; restart switches or rolls back; current local use survives GitHub/control-plane failure; all Hermes Profile/self-learning boundary hashes remain unchanged.

## Final Verification Matrix

| Gate | Runtime repo | Desktop repo | Physical platform |
|---|---|---|---|
| Manifest/signature/hash | Python producer tests | independent MJS + TS verifier | inspect installed resource |
| Native artifact | macOS ARM64 + Windows x64 CI | exact lock + final package extraction | execute bundled Python |
| Offline first preparation | extracted Seed smoke | Playwright/no-network test | disconnect before preparation |
| Update consent | signed channel metadata | zero-download check + explicit confirm | observe traffic and UI |
| Restart/rollback | artifact smoke | bootstrap journal tests | intentionally break candidate |
| Hermes learning boundary | compatibility gate | full boundary hash regression | Memory/Skills survive update |
| Commercial release readiness | signed Release + provenance | signed/notarized installers | macOS and Windows evidence |

## Stop Conditions

Stop implementation and report the exact blocker instead of weakening the contract if any of these occurs:

- the Runtime cannot be made relocatable without writing into its build-machine path;
- a target cannot execute its artifact on a native runner;
- the compatibility gate or data-boundary hash changes;
- a packaged app needs a private GitHub/signing credential;
- the only recovery path is an unsigned online installer;
- a candidate can activate while a chat task is active;
- a cleanup path can resolve outside `userData/runtime`;
- the stable Release would contain only one of the two required target artifacts;
- physical macOS/Windows verification is unavailable at the stable-publication checkpoint.

Cloud sync and workspace implementation begin only after every completion criterion above is satisfied or the user explicitly reschedules the remaining Runtime release gates as a documented blocker.
