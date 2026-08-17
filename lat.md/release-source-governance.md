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

## Non-authoritative remote rejection

Every configured remote must use an allowed GitHub transport for the exact `Ablankpaper/aera` path; another host, owner, repository, credential-bearing URL, port, query, or fragment is rejected without echoing the URL.

## Authoritative GitHub workflow context

`GITHUB_REPOSITORY`, `GITHUB_REF`, `GITHUB_SHA`, and `GITHUB_WORKFLOW_REF` must equal the expected `Ablankpaper/aera` main-branch workflow context.

The expected workflow reference names one safe `.yml` or `.yaml` file directly under `.github/workflows` at `refs/heads/main`. This prevents a branch workflow or stale dispatch SHA from authorizing release bytes.

## Exact source commit

The expected 40-character lowercase source SHA, GitHub SHA, and actual checkout `HEAD` must be byte-identical.

## Detached release checkout

The release checkout must have a detached `HEAD`, so a mutable local branch cannot silently replace the reviewed source identity.

## Clean release checkout

Tracked, staged, ignored-submodule, and untracked status is inspected fail closed; any reported checkout change prevents source evidence from being emitted.

## Required origin identity

An `origin` remote is mandatory, and any additional remote is subject to the same raw and effective fetch/push allowlist.

## Untrusted Git environment

Checkout inspection ignores inherited `GIT_*` redirection variables so they cannot substitute another worktree, index, object store, or configuration for the requested checkout.

## Canonical redacted evidence

Successful evidence uses schema version 1 with sorted JSON keys and normalized repository identities, while excluding checkout paths, raw URLs, credentials, command output, and arbitrary Git errors.
