# Windows Process-Tree Diagnostic Design

**Status:** Approved in the primary development conversation on 2026-08-14.

## Purpose

Verify the Beta.28.1 Windows process-tree repair on a real GitHub-hosted Windows runner without repeating unrelated platforms or allowing partial evidence to satisfy the release gate.

## Constraints

The diagnostic must consume one Windows job only, preserve ordinary push and pull-request CI unchanged, avoid candidate or publication workflows, and produce evidence tied to the exact diagnostic commit.

The result is focused diagnostic evidence. It is not the complete three-platform exact-head CI required for a Desktop release.

## Considered Approaches

Three approaches were considered:

1. Add a distinct manual Windows diagnostic job to the existing CI workflow. This is selected because the workflow already exists on the default branch, can run a feature-branch revision, and can keep partial evidence visibly separate from release CI.
2. Run the complete Windows CI job only. This is closer to the final gate but spends substantially more runner time before the repaired boundary is proven.
3. Rerun the complete three-platform CI matrix. This produces release-shaped evidence but repeats unchanged macOS and Ubuntu work and is inappropriate while the Windows hypothesis remains unconfirmed.

## Workflow Design

`CI` gains one `workflow_dispatch` choice named `mode`. Its default is `full`, which retains the existing three-platform `check` matrix and every existing step.

The `windows-process-tree-diagnostic` mode skips the `check` matrix and runs a separately named `windows-process-tree-diagnostic` job on `windows-latest`. The job checks out the exact ref, installs the pinned Node 22 dependencies, runs the Node typecheck, and executes only these affected test files with one worker and the existing Windows case budget:

- `src/main/process-tree.test.ts`
- `tests/gateway-restart.test.ts`
- `src/main/tui-gateway-lifecycle.test.ts`
- `src/main/gateway-shutdown-lifecycle.test.ts`

The diagnostic job has a ten-minute workflow timeout and read-only repository permissions. It receives no production, signing, deployment, or environment secrets.

## Release-Gate Isolation

The diagnostic job name does not match `check (windows-latest)` and the run omits macOS and Ubuntu jobs. `scripts/verify-ci-checkpoint.mjs` therefore cannot accept it as the required Desktop CI checkpoint.

Push and pull-request events cannot select diagnostic mode. They always run the original full matrix. A branch push used to install this workflow revision carries a GitHub skip directive so it creates no automatic Actions run; the diagnostic is then started explicitly with the exact branch ref and mode.

### Full-CI candidate compatibility

GitHub reports a conditionally disabled top-level job as `skipped`, so a full-mode run contains the three successful `check` matrix jobs plus one skipped `windows-process-tree-diagnostic` job. Both Desktop candidate workflows allow only that exact skipped diagnostic while still requiring the exact Ubuntu, macOS, and Windows matrix names to succeed with executed steps.

A diagnostic-only run, a missing platform, a duplicate job, any other skipped job, or any unexpected executed job remains ineligible for candidate packaging.

## Acceptance

Local acceptance requires the CI workflow policy test, YAML parsing, formatting, `git diff --check`, and `lat check` to pass.

Remote acceptance requires exactly one executed Windows diagnostic job at the pushed commit. All four affected test files and Node typecheck must pass. A skipped, cancelled, runner-lost, or mismatched-SHA run is not accepted.

If the diagnostic fails, no workflow is rerun. Its exact logs are analyzed before any further code or Actions execution.

## Non-Claims

A successful diagnostic does not prove complete Desktop CI, packaging, Runtime Seed installation, signing, candidate assembly, physical Windows acceptance, promotion, deployment, or Beta.28.1 publication.
