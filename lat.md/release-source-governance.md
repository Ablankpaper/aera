---
lat:
  require-code-mention: true
---

# Release Source Governance

Release source verification closes F-24 checkout drift and F-25 retired-remote misuse before reviewed Desktop bytes can enter a candidate or promotion path.

The verifier fixes the authoritative repository at `Ablankpaper/aera`. It binds GitHub's main-branch workflow context to one expected SHA, inspects the actual checkout and every Git remote, and emits only canonical non-secret evidence.

## Accepted macOS and Linux Git fixtures

Clean detached fixtures accept the exact macOS SSH alias or Linux GitHub HTTPS transport only when both resolve to the authoritative repository identity.

The accepted raw forms are `git@github-ablankpaper:Ablankpaper/aera.git`, GitHub SSH, GitHub SSH URL, and GitHub HTTPS, with an optional `.git` suffix. Effective fetch and push URLs are checked after Git URL rewriting too.

## Retired remote rejection

Any raw or effective fetch or push URL containing the retired `bignormal` identity stops source verification, even when another valid `origin` exists.

Both `insteadOf` and `pushInsteadOf` rewrites are resolved before approval, so an allowed raw URL cannot hide a retired effective fetch or push destination.

## Non-authoritative remote rejection

Every configured remote must use an allowed GitHub transport for the exact `Ablankpaper/aera` path; another host, owner, repository, credential-bearing URL, port, query, or fragment is rejected without echoing the URL.

## Authoritative GitHub workflow context

`GITHUB_REPOSITORY`, `GITHUB_REF`, `GITHUB_SHA`, and `GITHUB_WORKFLOW_REF` must equal the expected `Ablankpaper/aera` main-branch workflow context.

The expected workflow reference names one safe `.yml` or `.yaml` file directly under `.github/workflows` at `refs/heads/main`. This prevents a branch workflow or stale dispatch SHA from authorizing release bytes.

## Exact source commit

The expected 40-character lowercase source SHA, GitHub SHA, and actual checkout `HEAD` must be byte-identical.

## Replacement object rejection

Git replacement objects cannot redefine the reviewed commit during verification.

Every Git subprocess uses `--no-replace-objects` and `GIT_NO_REPLACE_OBJECTS=1`, while any loose entry in the replace namespace or active packed `refs/replace` entry fails the gate before `HEAD` or checkout cleanliness is trusted.

## Detached release checkout

The release checkout must have a detached `HEAD`, so a mutable local branch cannot silently replace the reviewed source identity.

## Clean release checkout

Tracked, staged, ignored-submodule, and untracked status is inspected fail closed; any reported checkout change prevents source evidence from being emitted.

## Index trust flag rejection

Tracked paths marked `assume-unchanged` or `skip-worktree` fail the gate even when ordinary status would hide their changed bytes.

## Filesystem monitor isolation

Checkout status performs a full scan without trusting repository fsmonitor hooks or the built-in daemon.

The verifier overrides fsmonitor with a trusted hook that invalidates every path under both protocol versions. This avoids older Git interpreting Boolean `false` as a hook pathname; the same inspection also disables the untracked cache.

## Ignored input rejection

Ignored untracked files are unreviewed build inputs and fail the release source gate without an allowlist.

The audit uses standard excludes, including `.git/info/exclude`, repository ignore rules, and configured global excludes, but never emits ignored paths in evidence or errors.

## Required origin identity

An `origin` remote is mandatory, and any additional remote is subject to the same raw and effective fetch/push allowlist.

## Untrusted Git environment

Checkout inspection ignores inherited `GIT_*` redirection variables so they cannot substitute another worktree, index, object store, or configuration for the requested checkout.

## Canonical redacted evidence

Successful evidence uses schema version 1 with sorted JSON keys and normalized repository identities, while excluding checkout paths, raw URLs, credentials, command output, and arbitrary Git errors.

## Candidate workflow enforcement

The signed production candidate workflow runs the exact release source gate before either platform build can start.

`package.json` exposes the verifier as `verify:release-source`; the `validate` job records its canonical output under `RUNNER_TEMP`, and both macOS and Windows candidate jobs depend on that successful job.

## Internal Beta workflow enforcement

The internal-Beta candidate and promotion workflows run the same source gate before identity checks, artifact assembly, or publication, so an internal dispatch cannot bypass the authoritative checkout and retired-remote protections.

## Internal Beta collector artifact kinds

The internal-Beta workflow resolves collector target artifacts by `platform` and `kind`, so those literals must stay identical to the `INTERNAL_BETA_ARTIFACTS` table in `scripts/internal-beta/manifest.mjs`.

A kind name that the manifest never declares silently resolves to `undefined` and fails candidate assembly after macOS notarization and Windows smoke work has already succeeded, so the mismatch is caught by CI instead of by a dispatched candidate run.

### Collector artifact kinds match manifest

Every `platform`/`kind` pair queried by `internal-beta.yml` must appear in the manifest's canonical artifact table; a query for a non-existent kind such as `macos_zip` instead of `zip` is rejected with the declared kinds listed.

### Collector targets resolve to a single artifact

The macOS and Windows collector lookups must each be present and match exactly one canonical artifact, so `package-diagnostic-collectors.mjs` receives one unambiguous SHA-256 per platform.
