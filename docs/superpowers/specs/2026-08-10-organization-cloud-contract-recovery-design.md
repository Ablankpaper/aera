# Organization Cloud Contract Recovery

This repair restores the internal-beta Organization Agent surface after Desktop Beta.25 shipped with a newer Cloud contract than the deployed internal-beta Cloud, and prevents a failed Organization subrequest from blanking or contaminating the catalog.

## Scope

The repair has two independent delivery layers that must both close. The operational layer restores the exact Cloud contract already pinned by Desktop Beta.25. The Desktop layer makes Organization catalog rendering fail independently and clears context-bound data before a new Organization is displayed.

The repair does not delete or rewrite Organization Agent definitions, versions, installations, drafts, submissions, ExperienceCandidates, Profiles, RuntimeBindings, Memory, credentials, or user data. It does not reuse or modify the unrelated `aera/beta26-five-optimizations` worktree.

## Evidence and root cause

The installed client is `0.7.4-internal-beta.25`. Its embedded Cloud OpenAPI contract has SHA-256 `d5de52af24f451653a1412a9a8d78b51239098a31130cbd87aefff2a440854d2`, identical to Cloud commit `aba165d256cd447abcd43ce4c397041c2bf802d1`.

The live internal-beta deployment state records Cloud commit `1d2fbc99662bdfc10d4ff3669c7eb47d63dc2034`, whose OpenAPI contract SHA-256 is `6ab97e4118b6806fae86b16202348ecc41a3a83e18011e22a01d5a53d1153245`. The live readiness endpoint returns HTTP 200, but the Organization ExperienceCandidate list route required by Beta.25 returns HTTP 404.

The deployed publication response also predates the required `published_version_id` field. Beta.25 rejects that response through its exact-field validator, normalizes `invalid_response` to `invalid_request`, and displays “智能体请求无效”. In `AgentControlPanel`, that failure returns before the new control state and definitions are committed, so the page can remain blank or retain cards and role state from the previous Organization.

## Considered approaches

### Restore Cloud only

Deploying the pinned Cloud contract restores Beta.25 immediately, but leaves the catalog vulnerable to a future partial Cloud failure and preserves cross-Organization stale rendering. This is necessary but incomplete.

### Add a Desktop compatibility shim only

Relaxing Beta.25 validators or hiding unsupported routes would require another client release while leaving Organization experience APIs absent. It would also weaken the strict Cloud boundary. This approach is rejected.

### Restore Cloud and isolate Desktop reads

The selected approach deploys the exact immutable Cloud candidate required by Beta.25, then lands a narrow Desktop resilience fix on a separate branch. It restores current users without weakening the wire contract and prevents a single optional subdomain from blanking the core Organization catalog.

## Cloud operational recovery

The Cloud source target is exactly `aba165d256cd447abcd43ce4c397041c2bf802d1`, which already passed the repository CI used by Desktop Beta.25. A new immutable `candidate.yml` workflow run must build, sign, attest, and publish one digest for that exact source.

Before deployment, the candidate manifest, Sigstore bundle, provenance, SBOM, source SHA, image digest, and workflow identity must pass the checked-in verifier. The internal-beta deployment script must verify the recorded current candidate, preserve PostgreSQL, Redis, and MinIO volumes, run forward migrations, test public HTTPS health and exposure, and retain the recorded previous digest as the rollback target.

The rollout order is `deploy` with features disabled, health and schema verification, then `enable` for the exact same candidate. Failure must use the checked-in automatic or recorded-candidate rollback path; no volume deletion, down migration, mutable image tag, or direct repository checkout is allowed on the host.

## Desktop catalog recovery

`AgentControlPanel` will treat the trusted control state as the context boundary. As soon as `getState` returns a different context key, it will invalidate context-bound dialogs and clear definitions, drafts, installations, submissions, official data, and selections before any Cloud-dependent result can be displayed.

Installation, submission, draft, definition, official-agent, and official-update reads will preserve epoch cancellation but will no longer abort the whole load because one peer read returned an error. Each failed read contributes one bounded localized error while successful reads still commit their own data. Publication submissions remain requested before drafts so existing draft/submission reconciliation semantics remain unchanged.

The existing explicit refresh control and trusted state-change subscription remain the retry mechanisms. This repair adds no unbounded background timer and does not retry mutations. A later retry always starts a new epoch and cannot commit results from an older Organization.

The strict Cloud response validators remain unchanged. The Desktop fix is resilience against partial failure, not compatibility with an obsolete Cloud contract.

## Error handling and privacy

Errors remain stable localized codes. The renderer receives no Cloud origin, authorization header, access token, Organization identity supplied by the renderer, raw response body, database path, Profile path, or Hermes content.

When multiple reads fail, the first failure in the existing load order is retained as the page-level error. Domain panels may continue to show their own error. Successful definitions remain visible, but no stale definitions from another context survive a context switch.

## Test design

Desktop tests will be written before production code and must demonstrate the current failure first:

1. An Owner Organization whose submission list fails while its definition list succeeds still renders the definition card and reports the submission error.
2. A product-space state change clears the previous Organization card and role immediately, even when the new Organization submission request fails or remains pending.
3. A superseded load epoch cannot reintroduce the previous Organization after the next context commits.
4. Existing submission-before-draft reconciliation and role gates remain green.

Focused component tests, the full Agent control test file, type checking, formatting checks, `lat check`, and an isolated Electron Organization journey must pass on the repair branch.

Cloud acceptance must verify the deployed state SHA and immutable digest, `/health/live`, `/health/ready`, Organization definitions, publication submissions, Organization ExperienceCandidate own/review lists, and one existing Beta.25 Owner Organization catalog. Public unauthenticated probes may verify route presence, but authenticated business acceptance must remain inside Electron so credentials are never read or printed.

## Success criteria

The repair is complete only when all of the following are true:

- Live internal-beta Cloud records the exact reviewed `aba165d` candidate and all health/exposure checks pass.
- Installed Beta.25 loads the existing Owner Organization catalog without “智能体请求无效” or “Aera Cloud 暂时不可用”.
- Organization experience and publication-review panels read their live routes successfully.
- Switching Organizations never displays the previous Organization's role, definitions, drafts, installations, or submissions.
- Desktop focused tests, type checks, knowledge-graph checks, and isolated Electron acceptance are green.
- No Organization Agent data, local Profile, Runtime state, credentials, or private Hermes state is reset or deleted.
