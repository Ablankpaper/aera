# Beta.31 macOS Packaged Updater ESM Interop Repair

This design repairs the macOS Internal Beta updater at the compiled application boundary and makes the exact packaged extractor path a fail-closed release gate.

## Scope

The change is owned by Aera Desktop and targets `0.7.4-internal-beta.31`. It fixes the `@electron-internal/extract-zip` ESM/CommonJS interop used by macOS Desktop updates, adds a packaged-app extraction probe against the final distributed ZIP, and records the one-time manual-install bridge required for affected Beta.29 and Beta.30 clients.

The repair does not alter update metadata signatures, artifact digest verification, the macOS swap helper, rollback semantics, Cloud routing, Runtime Seed contents, model-configuration recovery, or the Windows NSIS install path. It does not downgrade the hardened extractor or restore a legacy ZIP implementation.

## Confirmed evidence and root cause

The affected machine is still running `0.7.4-internal-beta.29`. Its updater log records the same terminal error repeatedly on 2026-08-14 and again on 2026-08-16:

```text
Desktop update download failed: extractor is not a function
```

The failure occurs after the signed Beta.30 ZIP has been downloaded and hash-verified but before a pending update or install journal is created. The staging directory remains empty. No current application replacement or user-data migration has started at this point.

The Beta.29 `app.asar` contains this compiled boundary:

```js
const extractZip = require("@electron-internal/extract-zip");

async function extractDesktopUpdateZip(
  archivePath,
  stagingDirectory,
  extractor = extractZip,
) {
  await extractor(archivePath, { dir: stagingDirectory });
}
```

The packaged dependency is `@electron-internal/extract-zip` 1.0.5 with `"type": "module"`. In the Electron/Node CommonJS boundary, `require()` returns a namespace object rather than the callable default value:

```text
typeof require(...)        = object
keys                       = __esModule, default, extract
typeof module.default      = function
typeof module.extract      = function
```

The source currently uses a default import:

```ts
import extractZip from "@electron-internal/extract-zip";
```

Electron Vite externalizes the production dependency and emits a direct CommonJS `require()`. The default parameter therefore receives the namespace object, and the first extraction call throws `extractor is not a function`.

Beta.30 was built from the same import and packaging boundary, so installing Beta.30 manually would deliver the model-recovery repair but would retain this updater defect.

## Why the previous verification passed

The existing Vitest coverage calls TypeScript source through the development transform. It also injects a fake extractor when checking `process.noAsar`. That proves ASAR interception is restored on success and failure, but it never calls the default extractor emitted in `app.asar`.

The earlier isolated upgrade replay used a TypeScript runtime loader. Its ESM interop resolved the default import to a function, unlike the CommonJS emitted in the packaged main process. Signing, notarization, archive hashes, native-module ABI checks, and source-level updater tests consequently remained green while the installed client failed.

This is a verification-boundary defect, not a download, signature, restart, permissions, or application-swap defect.

## Approaches considered

### Keep the default import and add another source unit test

Another source-level test would execute under the same transform that masked the defect. It would not constrain the generated CommonJS call shape and is rejected as insufficient.

### Downgrade or replace the hardened extractor

The hardened Electron extractor was selected to remove the vulnerable legacy ZIP path. Downgrading would reopen a reviewed security boundary and is rejected.

### Normalize every possible module shape at runtime

A wrapper that probes `module.extract`, `module.default`, and the namespace itself could tolerate multiple unpublished module shapes, but it would weaken a precise dependency contract and make future bundler drift harder to detect. The installed 1.0.5 package explicitly exports the named `extract` function, so broad fallback logic is rejected.

### Named import plus a packaged extraction gate

The selected approach imports the documented named export and verifies the exact compiled module inside `app.asar` by using it to extract the final macOS ZIP. This fixes the smallest production boundary and prevents the same source-versus-package blind spot from reaching another candidate.

## Production change

The updater will bind the documented named export:

```ts
import { extract as extractZip } from "@electron-internal/extract-zip";
```

`extractDesktopUpdateZip()` retains its injectable extractor parameter and its `process.noAsar` `try/finally` boundary. Metadata verification, staging cleanup, application identity validation, and installation remain unchanged.

The main Electron Vite build will also expose `src/main/app/internal-beta-updater.ts` as a named Rollup entry. The ordinary application continues to start from `out/main/index.js`; the additional entry has no IPC, command-line, network, or renderer surface. It exists so release verification can import the same compiled updater module and invoke the exported production function rather than a reimplemented test copy.

## Packaged updater extraction gate

A new fail-closed verifier will accept the packaged `.app` and the exact final macOS update ZIP. It will create an isolated temporary Electron harness and extraction directory, then:

1. Start the checked-in Electron 41.10.5 runtime without loading the normal Aera application lifecycle.
2. Load the updater entry directly from the candidate application's `Contents/Resources/app.asar`.
3. Require `extractDesktopUpdateZip` to be a callable export.
4. Invoke it without an injected extractor, forcing the compiled production binding to load the packaged `@electron-internal/extract-zip` module.
5. Extract the exact `Aera-Internal-Beta-0.7.4-internal-beta.31-macos-arm64.zip` that is about to be submitted and published.
6. Require exactly one `Aera.app`, the Beta.31 version, the production bundle identifier, an arm64 executable, a non-empty packaged `app.asar`, and a valid strict code signature.
7. Remove only the verifier-owned temporary directory on success or failure.

The candidate workflow will run this gate after the stapled application has produced the final DMG and ZIP and before the final container notarization submissions. A missing entry, non-callable default extractor, extraction error, missing staged `app.asar`, wrong identity, wrong architecture, or invalid signature stops the candidate before publication.

The existing final notarization, stapling, Gatekeeper, Runtime Seed, native ABI, hash, manifest, provenance, and signed-update verification remain required after this gate. The new probe supplements those controls; it does not replace them.

## Regression and workflow policy coverage

Implementation follows failure-first TDD.

1. A compiled-boundary regression must first reproduce the current namespace-object call and fail with `extractor is not a function`.
2. The named import must make that same compiled call extract a ZIP containing `Contents/Resources/app.asar` successfully.
3. Existing injected-extractor tests must continue to prove `process.noAsar` is restored after both success and failure.
4. Verifier tests must reject a missing compiled entry, a non-callable export, extraction failure, an archive without exactly one app, wrong version or bundle identity, non-arm64 output, missing `app.asar`, and invalid signing.
5. Workflow-policy tests must require the packaged extraction gate and require it to run before final container submission.
6. The macOS candidate job must invoke the gate against its exact `app` and `zip` outputs; a fixture or source tree is not an accepted substitute.
7. `lat.md/desktop-updates.md` must record both the packaged-boundary test contract and the Beta.29/Beta.30 manual bridge.

Focused updater, secure ZIP, verifier, and workflow-policy tests must pass, followed by type checks, the production build, the full Vitest suite, internal-Beta script tests, `git diff --check`, and `lat check`.

## Beta.31 release identity

The Desktop version and every fail-closed Internal Beta identity guard will advance together to `0.7.4-internal-beta.31`. This includes package metadata and lock data, manifest constants and fixtures, update publication tests, candidate and promotion workflow guards, policy assertions, artifact names, and release notes.

Beta.31 release notes will state that macOS packaged update extraction is repaired, that Beta.29 and Beta.30 require one manual Beta.31 installation, and that the Beta.30 model-configuration self-heal remains included. Runtime stays on the already locked signed Runtime candidate; this repair does not authorize a Runtime, Cloud, or Admin change.

## Manual bridge and physical-client acceptance

Beta.29 and Beta.30 cannot extract any later macOS update ZIP through their online updater because the faulty extractor is already installed in those clients. Publishing different metadata or a newer ZIP cannot repair code that fails before staging.

Therefore Beta.31 is a one-time manual bridge for those versions:

1. Build, sign, notarize, staple, and verify the immutable Beta.31 candidate.
2. Provide the reviewed DMG directly to the affected macOS user.
3. Quit Aera, drag Beta.31 over the existing `/Applications/Aera.app`, and preserve Electron user data.
4. Confirm the installed version, Developer ID signature, notarization ticket, Gatekeeper acceptance, login, and the previously blocked model-save flow.
5. Run the packaged extraction probe against the immutable candidate ZIP on the fault machine or an equivalent isolated macOS environment.

This acceptance proves the repaired extraction stage and the retained Beta.30 model fix. It does not prove a live Beta.31-to-Beta.32 online restart until a separately reviewed higher version exists. Normal online-update acceptance resumes with that next version.

Promotion may make Beta.31 visible to older clients, but their online attempt will still fail until they install the manual bridge. User communication must therefore link the DMG and explicitly instruct Beta.29/Beta.30 macOS users not to rely on the in-app retry for this transition.

## Failure semantics and safety

- The updater remains fail-closed on unsigned metadata, wrong digests, unsafe paths, invalid app identity, or extraction errors.
- The repair does not delete downloads, journals, application data, model configuration, credentials, or Profiles.
- The packaged probe operates only on a locally built, already verified candidate ZIP inside a unique temporary directory.
- No private signing key, authentication token, user path, archive body, or credential is added to logs or release evidence.
- Windows continues to skip the macOS ZIP preparation path. Beta.31 packaging still produces the existing Windows Internal Beta artifacts, but this macOS gate makes no new Windows end-to-end claim.

## Success criteria

- The exact Beta.29 failure is reproducible at the compiled boundary before the change.
- `app.asar` binds the extractor through the callable named `extract` export.
- The candidate's compiled updater entry successfully extracts the exact final Beta.31 ZIP without an injected extractor.
- The extracted candidate contains one correctly signed, arm64 Beta.31 Aera application with a non-empty `app.asar`.
- Existing signed-metadata, `noAsar`, staging, swap, rollback, native ABI, notarization, and publication tests do not regress.
- A manual Beta.31 install on the fault machine preserves user data and restores the affected model-save behavior.
- No release or live promotion is claimed until exact-head CI, candidate verification, physical-client evidence, and a separate promotion authorization are complete.

## Delivery boundary

Design and implementation use `aera/beta31-macos-updater-esm-interop`, based on `Ablankpaper/aera` `origin/main` commit `467b95e70a386a7f2b85ee542425b60d168f87fc`. The legacy `bignormal` remote is out of scope.

A passing branch is not a push, PR, merge, signed candidate, user-accepted DMG, or live update promotion. Each later state requires its own current evidence, and live Beta.31 promotion remains separately authorized.
